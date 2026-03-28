/**
 * EpisodePipeline Durable Object.
 * Orchestrates the full episode processing pipeline.
 * Uses alarm-based execution to avoid blocking the queue consumer.
 */

import { parseEpisodeId } from './parse-episode-id.js';
import { transcribeFromR2 } from './transcribe.js';
import { seedDatabase } from './seed-db.js';
import { generateEmbeddings } from './embeddings.js';
import { generateSummary } from './summary.js';

const SEGMENTS_PER_KEY = 500;

export class EpisodePipeline {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Status check
    if (url.pathname === '/status') {
      const status = await this.state.storage.get('status') || 'idle';
      const step = await this.state.storage.get('step');
      const episodeId = await this.state.storage.get('episodeId');
      const error = await this.state.storage.get('error');
      return Response.json({ status, step, episodeId, error });
    }

    const { key } = await request.json();

    // Parse episode ID from R2 key
    const episodeId = parseEpisodeId(key);
    if (!episodeId) {
      return Response.json({ error: `Could not parse episode ID from: ${key}` }, { status: 400 });
    }

    // Check if already processing or completed
    const status = await this.state.storage.get('status');
    if (status === 'processing') {
      return Response.json({ status: 'already_processing', episodeId });
    }

    // Check D1 for existing episode (dedup)
    const existing = await this.env.DB.prepare('SELECT id FROM episodes WHERE id = ?')
      .bind(episodeId).first();
    if (existing) {
      return Response.json({ status: 'already_exists', episodeId });
    }

    // Save job and trigger alarm for async processing
    await this.state.storage.put('status', 'processing');
    await this.state.storage.put('step', 'transcribe');
    await this.state.storage.put('key', key);
    await this.state.storage.put('episodeId', episodeId);
    await this.state.storage.setAlarm(Date.now());

    console.log(`Pipeline started for ${episodeId} (key: ${key})`);
    return Response.json({ status: 'started', episodeId });
  }

  async alarm() {
    const key = await this.state.storage.get('key');
    const episodeId = await this.state.storage.get('episodeId');
    const step = await this.state.storage.get('step');

    if (!key || !episodeId || !step) return;

    console.log(`[${episodeId}] Running step: ${step}`);

    try {
      switch (step) {
        case 'transcribe': {
          const resume = await this.state.storage.get('transcribeResume');

          const { segments, durationMs, totalChunks } = await transcribeFromR2(
            this.env.AUDIO_BUCKET, key, this.env.OPENAI_API_KEY, resume
          );

          await this.storeSegments(segments);
          await this.state.storage.put('durationMs', durationMs);
          await this.state.storage.delete('transcribeResume');
          await this.advanceStep('seed-db');
          break;
        }

        case 'seed-db': {
          const segments = await this.loadSegments();
          const durationMs = await this.state.storage.get('durationMs');
          await seedDatabase(this.env.DB, episodeId, durationMs, segments);
          await this.advanceStep('embeddings');
          break;
        }

        case 'embeddings': {
          const segments = await this.loadSegments();
          const durationMs = await this.state.storage.get('durationMs');
          const vectorCount = await generateEmbeddings(
            this.env.AI, this.env.VECTORIZE, episodeId, segments, durationMs
          );
          console.log(`[${episodeId}] ${vectorCount} vectors upserted`);
          await this.advanceStep('summary');
          break;
        }

        case 'summary': {
          const segments = await this.loadSegments();
          await generateSummary(this.env.DB, episodeId, segments, this.env.OPENAI_API_KEY);
          await this.advanceStep('set-audio-url');
          break;
        }

        case 'set-audio-url': {
          const audioUrl = `${this.env.R2_PUBLIC_URL}/${encodeURIComponent(key)}`;
          await this.env.DB.prepare('UPDATE episodes SET audio_file = ? WHERE id = ?')
            .bind(audioUrl, episodeId).run();
          console.log(`[${episodeId}] audio_file set to ${audioUrl}`);

          // Pipeline complete — clean up DO storage
          await this.state.storage.deleteAll();
          await this.state.storage.put('status', 'completed');
          console.log(`[${episodeId}] Pipeline completed successfully`);
          break;
        }
      }
    } catch (err) {
      console.error(`[${episodeId}] Pipeline failed at step "${step}":`, err.message);
      await this.state.storage.put('status', 'failed');
      await this.state.storage.put('error', err.message);
      await this.state.storage.put('failedAt', new Date().toISOString());
    }
  }

  /** Store segments split across multiple keys to stay under DO's 128KB per-key limit. */
  async storeSegments(segments) {
    for (let i = 0; i < segments.length; i += SEGMENTS_PER_KEY) {
      const chunk = segments.slice(i, i + SEGMENTS_PER_KEY);
      await this.state.storage.put(`segments:${i / SEGMENTS_PER_KEY}`, chunk);
    }
    await this.state.storage.put('segmentChunks', Math.ceil(segments.length / SEGMENTS_PER_KEY));
  }

  /** Reassemble segments from split storage keys. */
  async loadSegments() {
    const count = await this.state.storage.get('segmentChunks') || 0;
    const segments = [];
    for (let i = 0; i < count; i++) {
      const chunk = await this.state.storage.get(`segments:${i}`);
      if (chunk) segments.push(...chunk);
    }
    return segments;
  }

  /** Advance to next step and set alarm for immediate execution. */
  async advanceStep(nextStep) {
    await this.state.storage.put('step', nextStep);
    await this.state.storage.setAlarm(Date.now());
  }
}
