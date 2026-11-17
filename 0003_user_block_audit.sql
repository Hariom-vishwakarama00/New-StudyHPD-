-- Admin: Block / Remove students. Additive only: existing rows are untouched.
-- The worker also applies this automatically on its first request, so running it by hand is optional.
-- (If you run it by hand and a column already exists, SQLite reports "duplicate column"; that is safe to ignore.)

ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;   -- 1 = login refused, sessions ended (reversible)
ALTER TABLE users ADD COLUMN blocked_at INTEGER;
ALTER TABLE payments ADD COLUMN user_email TEXT;                   -- email snapshot, kept after the student is removed
ALTER TABLE rzp_orders ADD COLUMN user_email TEXT;

-- who did what, to whom, when
CREATE TABLE IF NOT EXISTS admin_audit (id TEXT PRIMARY KEY, actor_id TEXT, actor_email TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, target_email TEXT, detail TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit(created_at);
