CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    audio_file TEXT,
    duration_ms INTEGER,
    published_at TEXT,
    summary TEXT,
    guests_reviewed INTEGER DEFAULT 0
);

CREATE TABLE transcript_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id TEXT NOT NULL REFERENCES episodes(id),
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL
);

CREATE INDEX idx_segments_episode ON transcript_segments(episode_id);

CREATE VIRTUAL TABLE transcript_fts USING fts5(
    text,
    content='transcript_segments',
    content_rowid='rowid'
);

CREATE TABLE episode_guests (
    episode_id TEXT NOT NULL REFERENCES episodes(id),
    guest_name TEXT NOT NULL,
    PRIMARY KEY (episode_id, guest_name)
);

CREATE INDEX idx_guests_name ON episode_guests(guest_name);

-- Keep FTS index in sync with transcript_segments
CREATE TRIGGER segments_ai AFTER INSERT ON transcript_segments BEGIN
    INSERT INTO transcript_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER segments_ad AFTER DELETE ON transcript_segments BEGIN
    INSERT INTO transcript_fts(transcript_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER segments_au AFTER UPDATE ON transcript_segments BEGIN
    INSERT INTO transcript_fts(transcript_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO transcript_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    lat REAL NOT NULL,
    lng REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS place_mentions (
    place_id INTEGER NOT NULL REFERENCES places(id),
    episode_id TEXT NOT NULL REFERENCES episodes(id),
    PRIMARY KEY (place_id, episode_id)
);
