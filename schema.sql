CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    audio_file TEXT,
    duration_ms INTEGER,
    published_at TEXT,
    summary TEXT
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
