#!/usr/bin/env bash
# Prep hallucinated/failed episodes for retry, then run process-all with remaining time.
# Usage: bash scripts/retry-hallucinated.sh <deadline-epoch-seconds> <audio-dir>

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROGRESS="$SCRIPT_DIR/batch-progress.json"
TRANSCRIPTS="$PROJECT_ROOT/transcripts"

DEADLINE="${1:?Usage: $0 <deadline-epoch-seconds> <audio-dir>}"
AUDIO_DIR="${2:?Usage: $0 <deadline-epoch-seconds> <audio-dir>}"

echo "=== Retry prep starting at $(date) ==="

# Clear hallucinated and failed episodes from batch-progress.json, delete their transcripts
node - "$PROGRESS" "$TRANSCRIPTS" <<'EOF'
const fs = require('fs');
const path = require('path');
const progressPath = process.argv[2];
const transcriptsDir = process.argv[3];

const d = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));

let cleared = 0;

// Clear all hallucination-skipped episodes
for (const [id, info] of Object.entries(d.skipped)) {
  if (typeof info === 'object' && info.reason && info.reason.includes('Hallucination')) {
    delete d.skipped[id];
    const transcriptPath = path.join(transcriptsDir, `${id}.json`);
    if (fs.existsSync(transcriptPath)) fs.unlinkSync(transcriptPath);
    console.log(`  Cleared hallucinated: ${id}`);
    cleared++;
  }
}

// Clear 2015-01-01 (bad VAD — 1 bogus segment)
const badVad = 'roll-over-easy_2015-01-01_07-30-00';
if (d.skipped[badVad]) {
  delete d.skipped[badVad];
  const tp = path.join(transcriptsDir, `${badVad}.json`);
  if (fs.existsSync(tp)) fs.unlinkSync(tp);
  console.log(`  Cleared bad-VAD: ${badVad}`);
  cleared++;
}

// Clear failed episodes
for (const id of Object.keys(d.failed)) {
  delete d.failed[id];
  console.log(`  Cleared failed: ${id}`);
  cleared++;
}

fs.writeFileSync(progressPath, JSON.stringify(d, null, 2));
console.log(`  Total cleared: ${cleared}`);
EOF

# Calculate remaining hours
NOW=$(date +%s)
REMAINING_SEC=$(( DEADLINE - NOW ))
if [ "$REMAINING_SEC" -le 0 ]; then
  echo "No time remaining before deadline. Exiting."
  exit 0
fi
REMAINING_HOURS=$(echo "scale=4; $REMAINING_SEC / 3600" | bc)
echo "  Remaining time: ${REMAINING_HOURS}h (until $(date -r "$DEADLINE"))"

# Source env and run
set -a
source "$PROJECT_ROOT/.env"
set +a

echo "=== Starting retry run at $(date) ==="
node "$SCRIPT_DIR/process-all.js" "$AUDIO_DIR" --cooldown 30 --force --time-limit "$REMAINING_HOURS"
