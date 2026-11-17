-- StudyHPD database tables (D1 / SQLite).
-- The app also creates these automatically on its first request, so running this is optional but safe.

CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE NOT NULL, phone TEXT, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', premium_until INTEGER DEFAULT 0, plan_name TEXT, created_at INTEGER, email_verified INTEGER DEFAULT 1, google_sub TEXT);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT, icon TEXT, description TEXT, sort INTEGER DEFAULT 0, visible INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, description TEXT, course TEXT, year TEXT, semester TEXT, icon TEXT, color TEXT, sort INTEGER DEFAULT 0, visible INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS units (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, subject_id TEXT, unit_id TEXT, category_id TEXT, access_level TEXT DEFAULT 'free', download_allowed INTEGER DEFAULT 0, file_key TEXT, file_name TEXT, file_size INTEGER, thumb_key TEXT, tags TEXT, status TEXT DEFAULT 'published', views INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, duration_months INTEGER NOT NULL, features TEXT, popular INTEGER DEFAULT 0, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT, plan_name TEXT, amount INTEGER, months INTEGER, utr TEXT, proof_key TEXT, status TEXT DEFAULT 'pending', note TEXT, created_at INTEGER, decided_at INTEGER, decided_by TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, actor TEXT, action TEXT, detail TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS used_tokens (hash TEXT PRIMARY KEY, used_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_docs_subject ON documents(subject_id);
CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id);

-- Google sign-in + email verification codes
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub);
CREATE TABLE IF NOT EXISTS email_codes (email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, PRIMARY KEY (email, purpose));
CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL);
