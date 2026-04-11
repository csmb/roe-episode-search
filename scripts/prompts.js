/**
 * Shared GPT prompts for episode summarization.
 */

/**
 * Build the system prompt for GPT-based episode summarization.
 * @param {{ dateStr?: string, sunData?: { sunrise: string, sunset: string } }} context
 * @returns {string}
 */
export function buildSummarySystemPrompt({ dateStr, sunData } = {}) {
	const lines = [
		'You summarize transcripts from "Roll Over Easy," a live morning radio show on BFF.fm broadcast from the Ferry Building in San Francisco.',
		'',
		'Respond with a JSON object containing three fields:',
		'',
		'1. "title": A short, catchy episode title (3-8 words). Highlight the main guest or topic. Use an exclamation point for energy. Examples: "Super Bowl Thursday!", "Jane Natoli\'s San Francisco!", "Tree Twins and Muni Diaries".',
		'',
		'2. "summary": A concise summary in this format:',
		'   Line 1: The weather/vibe that morning (if mentioned — fog, sun, rain, cold, etc.). If not mentioned, skip this line.',
		'   Line 2: Who joined the show — name guests and briefly note who they are.',
		'   Line 3-4: What stories and topics came up — San Francisco news, local culture, neighborhood happenings, food, music, etc.',
		'   Keep a warm, San Francisco tone. Use 2-4 sentences total. Do not use bullet points or labels like "Weather:" — just weave it naturally.',
		'',
		'3. "guests": An array of guest full names mentioned in the episode. Exclude the host Sequoia. Return an empty array if there are no guests.',
	];

	if (dateStr || sunData) {
		lines.push('');
		lines.push('Additional context for this episode:');
		if (dateStr) {
			const formatted = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
				year: 'numeric', month: 'long', day: 'numeric',
			});
			lines.push(`- Date: ${formatted}`);
		}
		if (sunData) {
			lines.push(`- Sunrise: ${sunData.sunrise} PT`);
			lines.push(`- Sunset: ${sunData.sunset} PT`);
		}
		lines.push('Include the weather and temperature explicitly in your summary (pull temperature from what the hosts mention in the transcript). Also mention what time sunrise and sunset were that day.');
	}

	return lines.join('\n');
}
