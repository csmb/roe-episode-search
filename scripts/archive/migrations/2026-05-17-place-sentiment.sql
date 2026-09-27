-- One-time migration. SQLite ADD COLUMN errors if the column already exists;
-- run this exactly once against the remote DB.
ALTER TABLE place_mentions ADD COLUMN sentiment REAL;
ALTER TABLE place_mentions ADD COLUMN sentiment_label TEXT;
ALTER TABLE place_mentions ADD COLUMN snippet TEXT;
ALTER TABLE place_mentions ADD COLUMN snippet_start_ms INTEGER;
ALTER TABLE place_mentions ADD COLUMN analyzed_at TEXT;

CREATE TABLE IF NOT EXISTS place_narratives (
    place_id INTEGER PRIMARY KEY REFERENCES places(id),
    early_text TEXT,
    recent_text TEXT,
    arc_text TEXT,
    episode_count INTEGER,
    year_min INTEGER,
    year_max INTEGER,
    generated_at TEXT
);
