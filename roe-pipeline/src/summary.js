/**
 * Generate episode title, summary, and guest list via GPT-4o-mini.
 * Updates D1 with results.
 */

/**
 * @param {D1Database} db
 * @param {string} episodeId
 * @param {Array<{text: string}>} segments
 * @param {string} openaiApiKey
 */
export async function generateSummary(db, episodeId, segments, openaiApiKey) {
  const transcriptText = segments.map(s => s.text).join('\n');

  // Extract date from episode ID
  const dateMatch = episodeId.match(/(\d{4}-\d{2}-\d{2})/);
  const dateStr = dateMatch ? dateMatch[1] : null;

  // Fetch sunrise/sunset for context
  let sunData = null;
  if (dateStr) {
    sunData = await fetchSunriseSunset(dateStr);
  }

  // Build system prompt (matches scripts/process-episode.js exactly)
  const systemLines = [
    'You summarize transcripts from "Roll Over Easy," a live morning radio show on BFF.fm broadcast from the Ferry Building in San Francisco.',
    '',
    'Respond with a JSON object containing three fields:',
    '',
    '1. "title": A short, catchy episode title (3-8 words). Highlight the main guest or topic. Use an exclamation point for energy. Examples: "Super Bowl Thursday!", "Jane Natoli\'s San Francisco!", "Tree Twins and Muni Diaries".',
    '',
    '2. "summary": A concise summary in this format:',
    '   Line 1: The weather/vibe that morning (if mentioned \u2014 fog, sun, rain, cold, etc.). If not mentioned, skip this line.',
    '   Line 2: Who joined the show \u2014 name any guests who came on for a segment and briefly note who they are. The show is live on location, so random passersby sometimes hop on the mic for a few seconds to a few minutes \u2014 mention these folks too if they say something memorable or funny.',
    '   Line 3-4: What stories and topics came up \u2014 San Francisco news, local culture, neighborhood happenings, food, music, etc.',
    '   Keep a warm, San Francisco tone. Use 2-5 sentences total. Do not use bullet points or labels like "Weather:" \u2014 just weave it naturally.',
    '',
    '3. "guests": An array of guest full names mentioned in the episode. Exclude the hosts Sequoia and The Early Bird. Return an empty array if there are no guests.',
  ];

  if (dateStr || sunData) {
    systemLines.push('');
    systemLines.push('Additional context for this episode:');
    if (dateStr) {
      const formatted = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      systemLines.push(`- Date: ${formatted}`);
    }
    if (sunData) {
      systemLines.push(`- Sunrise: ${sunData.sunrise} PT`);
      systemLines.push(`- Sunset: ${sunData.sunset} PT`);
    }
    systemLines.push('Include the weather and temperature explicitly in your summary (pull temperature from what the hosts mention in the transcript). Also mention what time sunrise and sunset were that day.');
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemLines.join('\n') },
        { role: 'user', content: `Summarize this Roll Over Easy episode transcript:\n\n${transcriptText}` },
      ],
      temperature: 0.5,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices[0].message.content.trim();

  let title, summary, guests = [];
  try {
    const parsed = JSON.parse(content);
    title = parsed.title?.trim();
    summary = parsed.summary?.trim();
    guests = Array.isArray(parsed.guests) ? parsed.guests : [];
  } catch {
    summary = content;
  }

  // Update D1
  if (title) {
    await db.prepare('UPDATE episodes SET title = ?, summary = ? WHERE id = ?')
      .bind(title, summary, episodeId).run();
  } else {
    await db.prepare('UPDATE episodes SET summary = ? WHERE id = ?')
      .bind(summary, episodeId).run();
  }

  // Insert guests
  if (guests.length > 0) {
    await db.prepare('DELETE FROM episode_guests WHERE episode_id = ?')
      .bind(episodeId).run();
    for (const guest of guests) {
      const name = guest.trim();
      if (name) {
        await db.prepare('INSERT OR IGNORE INTO episode_guests (episode_id, guest_name) VALUES (?, ?)')
          .bind(episodeId, name).run();
      }
    }
  }

  console.log(`  Title: ${title || '(none)'}`);
  console.log(`  Summary: ${(summary || '').slice(0, 100)}...`);
  if (guests.length > 0) console.log(`  Guests: ${guests.join(', ')}`);

  return { title, summary, guests };
}

function utcToPacific(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function fetchSunriseSunset(dateStr) {
  // Ferry Building coordinates
  const url = `https://api.sunrise-sunset.org/json?lat=37.7955&lng=-122.3937&date=${dateStr}&formatted=0`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') return null;
    return {
      sunrise: utcToPacific(data.results.sunrise),
      sunset: utcToPacific(data.results.sunset),
    };
  } catch {
    return null;
  }
}
