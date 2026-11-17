-- Phase 1 (StudyHPD): themes, branch + semester, Premium free trial, Short / Important Topics + PYQs parts, Read Aloud.
-- Additive only: existing rows are untouched. The worker applies the same columns and tables on its first request
-- (init() in _worker.js), so running this by hand is optional. A "duplicate column" error on a re-run is safe to ignore.
-- Run it on D1 after a backup: node/wrangler d1 export studyhpd --remote --output <file>.

ALTER TABLE users ADD COLUMN theme TEXT;                 -- professional | dark | colorful (also kept in the browser)
ALTER TABLE users ADD COLUMN branch TEXT;                -- CS | AIML | DS | IoT | Mechanical | Civil (NULL = not chosen)
ALTER TABLE users ADD COLUMN semester INTEGER;           -- 1..8
ALTER TABLE users ADD COLUMN study_set_at INTEGER;       -- when branch/semester was chosen or skipped (onboarding done)
ALTER TABLE users ADD COLUMN trial_started_at INTEGER;   -- one free Premium trial per person (NULL = not claimed)
ALTER TABLE users ADD COLUMN trial_until INTEGER;        -- trial ends at this time (ms)
ALTER TABLE subjects ADD COLUMN branch TEXT;             -- which branch a subject belongs to (NULL = all branches)
ALTER TABLE reader_tokens ADD COLUMN part TEXT;          -- which part a Secure Reader token opens (NULL/detailed = the main PDF)

CREATE TABLE IF NOT EXISTS document_parts (doc_id TEXT NOT NULL, part TEXT NOT NULL, file_key TEXT, file_name TEXT, file_size INTEGER, text_content TEXT, updated_at INTEGER, PRIMARY KEY (doc_id, part));
CREATE TABLE IF NOT EXISTS trial_claims (email_key TEXT PRIMARY KEY, user_id TEXT, claimed_at INTEGER NOT NULL);
