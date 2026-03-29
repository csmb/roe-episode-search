/**
 * Clean Whisper transcription artifacts from segments.
 * Removes: zero-duration, consecutive duplicates, internal loops, hallucinations.
 */

export function cleanSegments(segments) {
  // Build hallucination frequency map from original segments before any dedup.
  // This catches short phrases that Whisper repeated many times consecutively.
  const origFreq = new Map();
  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/);
    if (words.length <= 3) {
      const key = seg.text.trim().toLowerCase();
      origFreq.set(key, (origFreq.get(key) || 0) + 1);
    }
  }
  const origThreshold = Math.max(10, Math.floor(segments.length * 0.02));
  const hallucinated = new Set();
  for (const [text, count] of origFreq) {
    if (count > origThreshold) hallucinated.add(text);
  }

  const cleaned = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Drop zero-duration segments
    if (seg.start_ms === seg.end_ms) continue;

    // Drop consecutive duplicates
    if (cleaned.length > 0 && seg.text === cleaned[cleaned.length - 1].text) continue;

    // Drop segments with internal phrase looping
    if (hasInternalLoop(seg.text)) continue;

    // Drop hallucinated short phrases
    if (hallucinated.has(seg.text.trim().toLowerCase())) continue;

    cleaned.push(seg);
  }

  // Fix common Whisper mishearings of host name "Early Bird"
  for (const seg of cleaned) {
    seg.text = seg.text.replace(
      /\b(nearly|yearly|really|eerily|dearly)\s+(bird|beard)\b/gi,
      'Early Bird'
    );
  }

  return cleaned;
}

/**
 * Detect internal looping: a phrase of 3-8 words repeating 4+ times consecutively.
 */
function hasInternalLoop(text) {
  const words = text.toLowerCase().split(/\s+/);
  if (words.length < 12) return false;

  for (let phraseLen = 3; phraseLen <= 8 && phraseLen <= words.length / 4; phraseLen++) {
    for (let start = 0; start <= words.length - phraseLen * 4; start++) {
      const phrase = words.slice(start, start + phraseLen).join(' ');
      let repeats = 1;
      let pos = start + phraseLen;
      while (pos + phraseLen <= words.length) {
        const next = words.slice(pos, pos + phraseLen).join(' ');
        if (next === phrase) {
          repeats++;
          pos += phraseLen;
        } else {
          break;
        }
      }
      if (repeats >= 4) return true;
    }
  }

  return false;
}
