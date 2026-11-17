import { pageMeta, subjectPath, unitPath, docPath } from "./seo.js";
import { checkSignupEmail, disposableReason, TEMP_MAIL_MSG } from "./email-guard.js";
// StudyHPD — Cloudflare Worker backend (D1 database + R2 file storage + static assets)
// Bindings: DB (D1), FILES (R2), ASSETS (static files in this folder)

const SETUP_TOKEN_HASHES = []; // leave empty: your admin setup key is the SETUP_TOKEN secret (wrangler secret put SETUP_TOKEN, or the dashboard)

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE NOT NULL, phone TEXT, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', premium_until INTEGER DEFAULT 0, plan_name TEXT, created_at INTEGER, email_verified INTEGER DEFAULT 1, google_sub TEXT)`,
`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT, icon TEXT, description TEXT, sort INTEGER DEFAULT 0, visible INTEGER DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, description TEXT, course TEXT, year TEXT, semester TEXT, icon TEXT, color TEXT, sort INTEGER DEFAULT 0, visible INTEGER DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS units (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, subject_id TEXT, unit_id TEXT, category_id TEXT, access_level TEXT DEFAULT 'free', download_allowed INTEGER DEFAULT 0, file_key TEXT, file_name TEXT, file_size INTEGER, thumb_key TEXT, tags TEXT, status TEXT DEFAULT 'published', views INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)`,
`CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, duration_months INTEGER NOT NULL, features TEXT, popular INTEGER DEFAULT 0, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT, plan_name TEXT, amount INTEGER, months INTEGER, utr TEXT, proof_key TEXT, status TEXT DEFAULT 'pending', note TEXT, created_at INTEGER, decided_at INTEGER, decided_by TEXT)`,
`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
`CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, actor TEXT, action TEXT, detail TEXT, created_at INTEGER)`,
`CREATE TABLE IF NOT EXISTS used_tokens (hash TEXT PRIMARY KEY, used_at INTEGER)`,
`CREATE INDEX IF NOT EXISTS idx_docs_subject ON documents(subject_id)`,
`CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id)`,
`CREATE TABLE IF NOT EXISTS email_codes (email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, PRIMARY KEY (email, purpose))`,
`CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS rzp_orders (order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT, plan_name TEXT, amount INTEGER NOT NULL, amount_paise INTEGER NOT NULL, months INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created', payment_id TEXT, created_at INTEGER, paid_at INTEGER)`,
`CREATE INDEX IF NOT EXISTS idx_rzp_orders_user ON rzp_orders(user_id)`,
// Android Secure Reader: one-time, 5-minute tokens that let the app's FLAG_SECURE reader fetch one PDF (no second login)
`CREATE TABLE IF NOT EXISTS reader_tokens (token_hash TEXT PRIMARY KEY, doc_id TEXT NOT NULL, user_id TEXT NOT NULL, expires INTEGER NOT NULL, used_at INTEGER)`,
// admin Block / Remove student: every action is recorded here (who, when, target email, action)
`CREATE TABLE IF NOT EXISTS admin_audit (id TEXT PRIMARY KEY, actor_id TEXT, actor_email TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, target_email TEXT, detail TEXT, created_at INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit(created_at)`,
// Phase 1: each document can have a Short part and an Important Topics + PYQs part (a PDF, or pasted text for Read Aloud)
`CREATE TABLE IF NOT EXISTS document_parts (doc_id TEXT NOT NULL, part TEXT NOT NULL, file_key TEXT, file_name TEXT, file_size INTEGER, text_content TEXT, updated_at INTEGER, PRIMARY KEY (doc_id, part))`,
// Premium free trial: one claim per email address (normalised), kept after an account is removed, so re-signup cannot claim it again
`CREATE TABLE IF NOT EXISTS trial_claims (email_key TEXT PRIMARY KEY, user_id TEXT, claimed_at INTEGER NOT NULL)`,
];

const SEED = {
  settings: {
    site_name: "StudyHPD",
    site_tagline: "B.Tech Notes, Important Questions & Study Material",
    upi_id: "9424817696@fam",
    upi_payee_name: "StudyHPD",
    upi_qr_key: "",
    announcement: "",
    about_text: "A student education platform providing quality notes, important questions, and study material for B.Tech students.",
    about_long: "StudyHPD is a student-focused digital library built to make B.Tech study material easier to discover, read and use. It brings together curated notes, important questions, previous year papers and lab manuals, organised by course, year, semester, subject and unit — so you can find exactly what you need without scrolling through scattered PDFs.\n\nFree notes can be read by any logged-in student. Premium notes, question banks and solved papers unlock with a simple plan paid via UPI — your plan activates as soon as the admin verifies your payment.\n\nOur goal is to keep high-quality academic resources affordable, searchable and free of friction, so students spend less time hunting for notes and more time actually studying.",
    contact_email: "", contact_phone: "", contact_whatsapp: "",
    social_instagram: "", social_youtube: "", social_telegram: "", social_facebook: "",
  },
  categories: [
    ["cat_premium","Premium","premium","crown","Premium notes and study material",0],
    ["cat_notes","Notes","notes","notebook-pen","Chapter-wise handwritten and typed notes",1],
    ["cat_qb","Question Banks","question-banks","circle-help","Collections of important questions by topic",2],
    ["cat_pyq","Previous Year Papers","previous-year-papers","file-text","Past exam papers for practice and revision",3],
    ["cat_lab","Lab Manuals","lab-manuals","flask-conical","Practical lab records and experiment guides",4],
  ],
  subjects: [
    ["sub_chem","Chemistry","BT 101","","B.Tech","1st Year","Semester 1","📘","#6366f1",0],
    ["sub_eng","English for Communication","BT 103","","B.Tech","1st Year","Semester 2","📘","#ef4444",1],
    ["sub_beee","BEEE","BT-104","Unit 2 short and Smart notes","B.Tech","1st Year","Semester 2","📘","#6366f1",2],
  ],
  units: [
    ["u_chem_2","sub_chem","Unit 2",2],
    ["u_eng_5","sub_eng","Unit 5",5],
    ["u_beee_1","sub_beee","Unit 1",1],
    ["u_beee_2","sub_beee","Unit 2",2],
  ],
  documents: [
    ["doc_chem_u2","Unit 2","Phase equilibrium","sub_chem","u_chem_2","cat_notes","free",1],
    ["doc_eng_u5","Unit 5","Unit 5 business correspondence","sub_eng","u_eng_5","cat_premium","premium",0],
    ["doc_beee_u1","Unit 1","Handwritten notes smart and simple","sub_beee","u_beee_1","cat_notes","free",0],
    ["doc_beee_u2","Unit 2","Short and Smart notes","sub_beee","u_beee_2","cat_notes","free",0],
  ],
  plans: [
    ["plan_basic","Basic",99,1,["Access to all premium notes","1 month validity","UPI payment"],0,0],
    ["plan_pro","Pro",199,3,["All Basic features","Question banks & solved papers","3 months validity"],1,1],
    ["plan_premium","Premium",299,6,["All Pro features","Priority support","6 months validity","Early access to new content"],0,2],
  ],
};

let ready = null;
async function init(env) {
  if (!ready) ready = (async () => {
    await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
    // additive migration for databases created before Google sign-in / email codes existed
    const cols = ((await env.DB.prepare("PRAGMA table_info(users)").all()).results || []).map(c => c.name);
    const alter = [];
    if (!cols.includes("email_verified")) alter.push(env.DB.prepare("ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 1"));
    if (!cols.includes("google_sub")) alter.push(env.DB.prepare("ALTER TABLE users ADD COLUMN google_sub TEXT"));
    // additive: admin can block a student (login refused, sessions ended); see migrations/0003_user_block_audit.sql
    if (!cols.includes("blocked")) alter.push(env.DB.prepare("ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0"));
    if (!cols.includes("blocked_at")) alter.push(env.DB.prepare("ALTER TABLE users ADD COLUMN blocked_at INTEGER"));
    // additive: Razorpay (auto payment) columns on the existing payments table
    const pcols = ((await env.DB.prepare("PRAGMA table_info(payments)").all()).results || []).map(c => c.name);
    if (!pcols.includes("method")) alter.push(env.DB.prepare("ALTER TABLE payments ADD COLUMN method TEXT"));
    if (!pcols.includes("gateway_order_id")) alter.push(env.DB.prepare("ALTER TABLE payments ADD COLUMN gateway_order_id TEXT"));
    if (!pcols.includes("gateway_payment_id")) alter.push(env.DB.prepare("ALTER TABLE payments ADD COLUMN gateway_payment_id TEXT"));
    // additive: email snapshot so payment records stay readable after a student is removed
    if (!pcols.includes("user_email")) alter.push(env.DB.prepare("ALTER TABLE payments ADD COLUMN user_email TEXT"));
    const ocols = ((await env.DB.prepare("PRAGMA table_info(rzp_orders)").all()).results || []).map(c => c.name);
    if (!ocols.includes("user_email")) alter.push(env.DB.prepare("ALTER TABLE rzp_orders ADD COLUMN user_email TEXT"));
    // Phase 1 (migrations/0004_phase1.sql): theme, branch + semester, Premium free trial, subject branch, part on reader tokens
    for (const [c, t] of [["theme", "TEXT"], ["branch", "TEXT"], ["semester", "INTEGER"], ["study_set_at", "INTEGER"], ["trial_started_at", "INTEGER"], ["trial_until", "INTEGER"]])
      if (!cols.includes(c)) alter.push(env.DB.prepare(`ALTER TABLE users ADD COLUMN ${c} ${t}`));
    const scols = ((await env.DB.prepare("PRAGMA table_info(subjects)").all()).results || []).map(c => c.name);
    if (!scols.includes("branch")) alter.push(env.DB.prepare("ALTER TABLE subjects ADD COLUMN branch TEXT"));
    const rcols = ((await env.DB.prepare("PRAGMA table_info(reader_tokens)").all()).results || []).map(c => c.name);
    if (!rcols.includes("part")) alter.push(env.DB.prepare("ALTER TABLE reader_tokens ADD COLUMN part TEXT"));
    if (alter.length) await env.DB.batch(alter);
    await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub)").run();
    // one payments row per Razorpay order: this unique index is what makes activation idempotent
    await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_gw_order ON payments(gateway_order_id)").run();
    // one live (pending/approved) payment per UTR, enforced by the database even for simultaneous submits
    try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_utr_live ON payments(upper(utr)) WHERE utr IS NOT NULL AND status<>'rejected'").run(); } catch (e) { console.error("idx_pay_utr_live not created", e && e.message); }
    const seeded = await env.DB.prepare("SELECT value FROM settings WHERE key='_seeded'").first();
    if (!seeded) {
      const st = [];
      for (const [k, v] of Object.entries(SEED.settings)) st.push(env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").bind(k, v));
      for (const c of SEED.categories) st.push(env.DB.prepare("INSERT OR IGNORE INTO categories(id,name,slug,icon,description,sort) VALUES(?,?,?,?,?,?)").bind(...c));
      for (const s of SEED.subjects) st.push(env.DB.prepare("INSERT OR IGNORE INTO subjects(id,name,code,description,course,year,semester,icon,color,sort) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(...s));
      for (const u of SEED.units) st.push(env.DB.prepare("INSERT OR IGNORE INTO units(id,subject_id,name,sort) VALUES(?,?,?,?)").bind(...u));
      const now = Date.now();
      SEED.documents.forEach((d, i) => st.push(env.DB.prepare("INSERT OR IGNORE INTO documents(id,title,description,subject_id,unit_id,category_id,access_level,download_allowed,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(...d, "[]", now - i * 1000, now)));
      for (const p of SEED.plans) st.push(env.DB.prepare("INSERT OR IGNORE INTO plans(id,name,price,duration_months,features,popular,sort) VALUES(?,?,?,?,?,?,?)").bind(p[0], p[1], p[2], p[3], JSON.stringify(p[4]), p[5], p[6]));
      st.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('_seeded','1')"));
      await env.DB.batch(st);
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// ---------- helpers ----------
const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (status, message) => json({ error: message }, status);
const uid = (p = "") => p + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const cookieOf = (req, name) => { const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)")); return m ? m[1] : null; };
const sessionCookie = (token, maxAge) => `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const clean = (s, n = 500) => (s == null ? "" : String(s)).trim().slice(0, n);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function currentUser(req, env) {
  const t = cookieOf(req, "sid"); if (!t) return null;
  const row = await env.DB.prepare("SELECT u.* , s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?").bind(await sha256(t)).first();
  if (!row || row.expires < Date.now() || row.blocked) return null;
  return row;
}
const READER_TOKEN_TTL_MS = 5 * 60 * 1000;
// Premium = admin, a paid plan, or the one-time free trial (trial_until) that is still running
const isPremium = u => !!u; // subscriptions removed: every signed-in student has full study-material access
// Phase 1 choices. Branch and semester are stored on the user (D1) and on the subject (branch); theme is also kept in the browser.
const BRANCHES = ["CS", "AIML", "DS", "IoT", "Mechanical", "Civil"];
const THEMES = ["professional", "dark", "colorful"];
const PARTS = ["short", "important"];
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DEFAULT_DAYS = 3;
const trialCfg = s => ({ enabled: s.trial_enabled !== "0", days: Math.min(30, Math.max(1, parseInt(s.trial_days, 10) || TRIAL_DEFAULT_DAYS)) });
// one key per person's email: case, "+tag" and (gmail) dots do not make a new trial. Remaining gap: a genuinely new address.
function emailKey(e) {
  let [local, dom] = String(e || "").toLowerCase().trim().split("@");
  if (!dom) return String(e || "").toLowerCase();
  if (dom === "googlemail.com") dom = "gmail.com";
  local = local.split("+")[0];
  if (dom === "gmail.com") local = local.replace(/\./g, "");
  return local + "@" + dom;
}
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, email_verified: u.email_verified !== 0, google: !!u.google_sub, has_password: !!u.pass_hash, premium_until: u.premium_until || 0, plan_name: u.plan_name, premium: isPremium(u), created_at: u.created_at,
  theme: u.theme || null, branch: u.branch || null, semester: u.semester || null, study_set: !!u.study_set_at,
  trial_active: (u.trial_until || 0) > Date.now(), trial_until: u.trial_until || 0, trial_used: !!u.trial_started_at });
async function startSession(env, userId) {
  const token = randHex(32);
  const maxAge = 60 * 60 * 24 * 30;
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)").bind(await sha256(token), userId, Date.now() + maxAge * 1000).run();
  if (Math.random() < 0.1) await env.DB.prepare("DELETE FROM sessions WHERE expires<?").bind(Date.now()).run();
  return sessionCookie(token, maxAge);
}
const BLOCKED_MSG = "Aapka account block hai. Admin se contact karo.";
const blockedErr = () => json({ error: BLOCKED_MSG, blocked: true }, 403);
async function audit(env, actor, action, target, detail) {
  await env.DB.prepare("INSERT INTO admin_audit(id,actor_id,actor_email,action,target_id,target_email,detail,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(uid("a_"), actor.id, actor.email, action, target ? target.id : null, target ? target.email : null, detail ? clean(detail, 300) : null, Date.now()).run();
}
// Block / Unblock / Remove one student. Admins (including yourself) can't be blocked or removed.
// Remove deletes the account, its sessions, reader tokens and email codes; payment/order rows are kept for accounting,
// with user_id kept and the email copied into user_email so the record still says whose it was.
async function adminUserAction(env, actor, u, action) {
  if (u.id === actor.id) throw new HttpError(400, "Aap khud ko block/remove nahi kar sakte");
  if (u.role === "admin") throw new HttpError(400, "Admin account ko block/remove nahi kar sakte. Pehle uska admin access hatao.");
  if (action === "block") {
    await env.DB.batch([env.DB.prepare("UPDATE users SET blocked=1, blocked_at=? WHERE id=?").bind(Date.now(), u.id), env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id), env.DB.prepare("DELETE FROM reader_tokens WHERE user_id=?").bind(u.id)]);
  } else if (action === "unblock") {
    await env.DB.prepare("UPDATE users SET blocked=0, blocked_at=NULL WHERE id=?").bind(u.id).run();
  } else if (action === "remove") {
    await env.DB.batch([
      env.DB.prepare("UPDATE payments SET user_email=COALESCE(user_email, ?) WHERE user_id=?").bind(u.email, u.id),
      env.DB.prepare("UPDATE rzp_orders SET user_email=COALESCE(user_email, ?) WHERE user_id=?").bind(u.email, u.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id),
      env.DB.prepare("DELETE FROM reader_tokens WHERE user_id=?").bind(u.id),
      env.DB.prepare("DELETE FROM email_codes WHERE email=?").bind(u.email),
      env.DB.prepare("DELETE FROM users WHERE id=?").bind(u.id),
    ]);
  } else throw new HttpError(400, "Unknown action");
  await audit(env, actor, "user." + action, u, `${u.name || ""}`.trim());
  await log(env, actor.email, "user." + action, u.email);
}
async function log(env, actor, action, detail) {
  await env.DB.prepare("INSERT INTO logs(id,actor,action,detail,created_at) VALUES(?,?,?,?,?)").bind(uid("l_"), actor, action, clean(detail, 1000), Date.now()).run();
}
async function settingsMap(env) {
  const { results } = await env.DB.prepare("SELECT key,value FROM settings").all();
  const m = {}; for (const r of results) m[r.key] = r.value; return m;
}
// ---------- Google sign-in + email codes ----------
// Config comes from Cloudflare env vars/secrets first, then from Admin → Settings (stored in D1).
//   GOOGLE_CLIENT_ID          — OAuth Web client ID (public, not a secret)
//   RESEND_API_KEY or BREVO_API_KEY (secret) + MAIL_FROM, e.g. "StudyHPD <noreply@studyhpd.tech>"
//   MAIL_PROVIDER (optional)  — "resend" or "brevo" when both keys are set
//   CODE_PEPPER (optional secret) — extra secret mixed into stored code hashes
// No Google client ID → the Google button is hidden. No mail key → signup works without verification.
const LOGIN_MAX_PER_EMAIL = 10;
const CODE_TTL_MS = 10 * 60 * 1000, CODE_MAX_TRIES = 5, CODE_COOLDOWN_MS = 60 * 1000;
const CODE_PURPOSES = ["verify", "login", "reset"];
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const dec = new TextDecoder();

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

function authConfig(env, s) {
  const e = k => (env && env[k] != null ? String(env[k]).trim() : "");
  const g = k => (s && s[k] != null ? String(s[k]).trim() : "");
  const googleClientId = e("GOOGLE_CLIENT_ID") || g("google_client_id");
  let provider = "", key = "", mailSource = "";
  const pref = e("MAIL_PROVIDER").toLowerCase();
  if (e("RESEND_API_KEY") && (pref !== "brevo" || !e("BREVO_API_KEY"))) { provider = "resend"; key = e("RESEND_API_KEY"); mailSource = "env"; }
  else if (e("BREVO_API_KEY")) { provider = "brevo"; key = e("BREVO_API_KEY"); mailSource = "env"; }
  else if (g("mail_api_key") && ["resend", "brevo"].includes(g("mail_provider"))) { provider = g("mail_provider"); key = g("mail_api_key"); mailSource = "settings"; }
  const from = e("MAIL_FROM") || g("mail_from");
  return {
    googleClientId, googleSource: e("GOOGLE_CLIENT_ID") ? "env" : googleClientId ? "settings" : "",
    mail: provider && key && from ? { provider, key, from, siteName: g("site_name") || "StudyHPD" } : null,
    mailSource, mailFromSource: e("MAIL_FROM") ? "env" : from ? "settings" : "",
  };
}
async function loadAuthConfig(env) { return authConfig(env, await settingsMap(env)); }

const b64uBytes = s => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
let JWKS_CACHE = null;
function resetGoogleKeyCache() { JWKS_CACHE = null; }
async function googleKeys(force) {
  if (!force && JWKS_CACHE && JWKS_CACHE.exp > Date.now()) return JWKS_CACHE.keys;
  const r = await fetch(GOOGLE_JWKS_URL);
  if (!r.ok) throw new HttpError(502, "Could not reach Google to check the sign-in. Please try again.");
  const maxAge = +((r.headers.get("cache-control") || "").match(/max-age=(\d+)/) || [])[1] || 3600;
  const j = await r.json();
  JWKS_CACHE = { keys: Array.isArray(j.keys) ? j.keys : [], exp: Date.now() + Math.min(maxAge, 86400) * 1000 };
  return JWKS_CACHE.keys;
}
// Verifies a Google Identity Services ID token: RS256 signature against Google's JWKS, then iss, aud, exp.
async function verifyGoogleIdToken(token, clientId, nowMs = Date.now()) {
  if (!clientId) throw new HttpError(400, "Google sign-in is not set up on this site yet");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "Invalid Google sign-in token");
  let header, payload;
  try { header = JSON.parse(dec.decode(b64uBytes(parts[0]))); payload = JSON.parse(dec.decode(b64uBytes(parts[1]))); }
  catch { throw new HttpError(401, "Invalid Google sign-in token"); }
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "Invalid Google sign-in token");
  let jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, "Google sign-in token was signed by an unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) throw new HttpError(401, "Google sign-in token signature is not valid");
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new HttpError(401, "Google sign-in token has the wrong issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new HttpError(401, "Google sign-in token was issued for a different app");
  const now = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 60) throw new HttpError(401, "Google sign-in expired, please try again");
  if (typeof payload.iat === "number" && payload.iat > now + 300) throw new HttpError(401, "Google sign-in token is not valid yet");
  if (!payload.sub || !payload.email) throw new HttpError(401, "Google did not share an email address");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new HttpError(401, "This Google email is not verified");
  return payload;
}

const clientIp = req => req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown";
// Atomic counter (one UPSERT ... RETURNING), so a burst of parallel requests can't all slip under the limit.
async function rateHit(env, k, limit, windowMs) {
  const now = Date.now();
  const r = await env.DB.prepare("INSERT INTO rate_limits(k,n,reset) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN rate_limits.reset<? THEN 1 ELSE rate_limits.n+1 END, reset=CASE WHEN rate_limits.reset<? THEN excluded.reset ELSE rate_limits.reset END RETURNING n")
    .bind(k, now + windowMs, now, now).first();
  return !r || r.n <= limit;
}
async function codePepper(env) {
  if (env.CODE_PEPPER) return String(env.CODE_PEPPER);
  await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('_code_pepper',?)").bind(randHex(32)).run();
  return (await env.DB.prepare("SELECT value FROM settings WHERE key='_code_pepper'").first()).value;
}
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function sixDigits() { const b = new Uint32Array(1); let n; do { crypto.getRandomValues(b); n = b[0]; } while (n >= 4294000000); return String(n % 1000000).padStart(6, "0"); }

function parseFrom(from, fallbackName) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || fallbackName || "StudyHPD", email: m[2].trim() } : { name: fallbackName || "StudyHPD", email: String(from).trim() };
}
async function sendMail(mail, { to, subject, html, text }) {
  const from = parseFrom(mail.from, mail.siteName);
  let r;
  if (mail.provider === "resend") {
    r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + mail.key, "content-type": "application/json" },
      body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [to], subject, html, text }) });
  } else if (mail.provider === "brevo") {
    r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": mail.key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: from.name, email: from.email }, to: [{ email: to }], subject, htmlContent: html, textContent: text }) });
  } else throw new HttpError(500, "Unknown mail provider");
  if (!r.ok) {
    let msg = ""; try { const j = await r.json(); msg = j.message || j.error || j.code || ""; if (typeof msg !== "string") msg = JSON.stringify(msg); } catch {}
    throw new HttpError(502, `The email could not be sent (${mail.provider} said: ${msg || r.status}).`);
  }
  return true;
}

const CODE_COPY = {
  verify: { subject: "verify your email", title: "Verify your email", line: "Use this code to finish creating your account." },
  login: { subject: "your login code", title: "Your login code", line: "Use this code to log in to your account." },
  reset: { subject: "reset your password", title: "Reset your password", line: "Use this code to set a new password." },
};
// Code emails are kept plain on purpose so they land in Inbox: a clean subject ("StudyHPD login code: 123456"),
// a plain-text part beside a simple HTML part, no links, no remote images, no tracking-style wording.
// (The real fix for spam is sending from his own domain with Brevo domain authentication: SPF/DKIM/DMARC.)
const CODE_KIND = { verify: "verification code", login: "login code", reset: "password reset code" };
function codeEmail({ code, purpose, siteName, name }) {
  const c = CODE_COPY[purpose] || CODE_COPY.verify, kind = CODE_KIND[purpose] || CODE_KIND.verify;
  const plainSite = String(siteName || "StudyHPD").replace(/[\r\n]+/g, " ").trim() || "StudyHPD";
  const site = esc(plainSite), hi = name ? `Hi ${esc(name)},` : "Hi,";
  const subject = `${plainSite} ${kind}: ${code}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4fb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:12px">
<tr><td style="background-color:#4f46e5;padding:18px 24px;text-align:center;border-radius:12px 12px 0 0;color:#ffffff;font-size:20px;font-weight:700">${site}</td></tr>
<tr><td style="padding:24px 24px 8px">
<p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#111827">${c.title}</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#4b5563">${hi}<br>${c.line}</p>
<p style="margin:0 0 20px;text-align:center"><span style="display:inline-block;background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:12px 20px;font-size:32px;font-weight:700;letter-spacing:8px;color:#4338ca;font-family:Menlo,Consolas,monospace">${code}</span></p>
<p style="margin:0 0 6px;font-size:14px;color:#4b5563;text-align:center">This code expires in 10 minutes.</p>
<p style="margin:0 0 20px;font-size:13px;color:#6b7280;text-align:center">Do not share this code with anyone.</p>
</td></tr>
<tr><td style="padding:14px 24px 20px;border-top:1px solid #eef0f4;font-size:12px;color:#9ca3af;line-height:1.5;text-align:center">If you did not request this code, you can ignore this email.<br>${site}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${plainSite} ${kind}: ${code}\n\n${name ? `Hi ${name},` : "Hi,"}\n${c.line}\n\nYour code: ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.\nIf you did not request this code, you can ignore this email.\n\n${plainSite}\n`;
  return { subject, html, text };
}
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Sends a fresh 6-digit code. Codes are stored only as an HMAC; one live code per email+purpose.
async function sendCode(env, req, cfg, email, purpose, name) {
  if (!cfg.mail) fail(400, "Email codes are not enabled on this site yet");
  const now = Date.now();
  const row = await env.DB.prepare("SELECT sent_at FROM email_codes WHERE email=? AND purpose=?").bind(email, purpose).first();
  if (row && row.sent_at > now - CODE_COOLDOWN_MS) { const wait = Math.ceil((row.sent_at + CODE_COOLDOWN_MS - now) / 1000); fail(429, `Please wait ${wait}s before asking for a new code`, { retry_after: wait, cooldown: wait }); }
  if (!(await rateHit(env, "send:e:" + email, 5, 60 * 60 * 1000))) fail(429, "Too many codes for this email. Please try again in an hour.");
  if (!(await rateHit(env, "send:ip:" + clientIp(req), 20, 60 * 60 * 1000))) fail(429, "Too many code requests from your network. Please try again later.");
  const code = sixDigits();
  const hash = await hmacHex(await codePepper(env), `${purpose}:${email}:${code}`);
  await env.DB.prepare("INSERT OR REPLACE INTO email_codes(email,purpose,code_hash,expires,tries,sent_at) VALUES(?,?,?,?,0,?)").bind(email, purpose, hash, now + CODE_TTL_MS, now).run();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM rate_limits WHERE reset<?").bind(now).run();
  const origin = new URL(req.url).origin;
  try { await sendMail(cfg.mail, { to: email, ...codeEmail({ code, purpose, siteName: cfg.mail.siteName, origin, name }) }); }
  catch (e) { await env.DB.prepare("DELETE FROM email_codes WHERE email=? AND purpose=?").bind(email, purpose).run(); throw e; }
  return { sent: true, email, cooldown: CODE_COOLDOWN_MS / 1000, expires_in: CODE_TTL_MS / 1000 };
}
// Checks a code: max 5 tries, 10 minute life, single use.
async function checkCode(env, req, email, purpose, code) {
  if (!(await rateHit(env, "verify:ip:" + clientIp(req), 60, 60 * 60 * 1000))) fail(429, "Too many attempts. Please try again later.");
  code = String(code || "").replace(/\D/g, "");
  if (code.length !== 6) fail(400, "Enter the 6-digit code from the email");
  const del = () => env.DB.prepare("DELETE FROM email_codes WHERE email=? AND purpose=?").bind(email, purpose).run();
  // Count the try BEFORE comparing, in one atomic statement: parallel guesses can't share one "try".
  const row = await env.DB.prepare("UPDATE email_codes SET tries=tries+1 WHERE email=? AND purpose=? RETURNING code_hash, expires, tries").bind(email, purpose).first();
  if (!row) fail(400, "This code has expired. Tap “Resend code” for a new one.", { expired: true });
  if (row.expires < Date.now()) { await del(); fail(400, "This code has expired. Tap “Resend code” for a new one.", { expired: true }); }
  if (row.tries > CODE_MAX_TRIES) { await del(); fail(429, "Too many wrong tries. Tap “Resend code” for a new one.", { expired: true }); }
  const hash = await hmacHex(await codePepper(env), `${purpose}:${email}:${code}`);
  if (!safeEq(hash, row.code_hash)) {
    const left = CODE_MAX_TRIES - row.tries;
    if (left <= 0) { await del(); fail(429, "Too many wrong tries. Tap “Resend code” for a new one.", { expired: true }); }
    fail(400, `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left.`, { tries_left: left });
  }
  await del();
  return true;
}

const ADMIN_AUTH_SETTINGS = ["google_client_id", "mail_provider", "mail_from", "rzp_key_id", "rzp_hide_manual"];
function adminSettingsOut(env, s) {
  const ac = authConfig(env, s), out = { ...s };
  for (const k of HIDDEN_SETTINGS) delete out[k];
  out.mail_api_key_set = !!s.mail_api_key;
  out.rzp_key_secret_set = !!s.rzp_key_secret; out.rzp_webhook_secret_set = !!s.rzp_webhook_secret;
  const rc = rzpConfig(env, s);
  out.rzp_status = { on: rc.on, mode: rc.mode, source: rc.source, key_id: rc.keyId, webhook_ready: !!rc.webhookSecret, hide_manual: rc.hideManual };
  out.auth_status = { google_ready: !!ac.googleClientId, google_source: ac.googleSource, mail_ready: !!ac.mail, mail_source: ac.mailSource, mail_provider: ac.mail ? ac.mail.provider : "", mail_from_source: ac.mailFromSource };
  return out;
}
const PUBLIC_SETTINGS = ["site_name","site_tagline","upi_id","upi_payee_name","upi_qr_key","announcement","about_text","about_long","contact_email","contact_phone","contact_whatsapp","social_instagram","social_youtube","social_telegram","social_facebook","trial_enabled","trial_days","privacy_text","terms_text"];
// per-part summary for the viewer tabs: detailed = the document's own PDF; short / important = document_parts rows
async function partsMeta(env, docId, d) {
  const { results } = await env.DB.prepare("SELECT part, file_key, file_name, file_size, (text_content IS NOT NULL AND length(text_content)>0) AS has_text FROM document_parts WHERE doc_id=?").bind(docId).all();
  const out = { detailed: { has_file: !!(d && d.file_key), has_text: false }, short: { has_file: false, has_text: false }, important: { has_file: false, has_text: false } };
  for (const r of results) if (out[r.part]) out[r.part] = { has_file: !!r.file_key, has_text: !!r.has_text, file_name: r.file_name || "", file_size: r.file_size || 0 };
  return out;
}
const docOut = d => ({ id: d.id, title: d.title, description: d.description, subject_id: d.subject_id, unit_id: d.unit_id, category_id: d.category_id, access_level: "free", download_allowed: !!d.download_allowed, has_file: !!d.file_key, file_name: d.file_name, file_size: d.file_size, has_thumb: !!d.thumb_key, tags: JSON.parse(d.tags || "[]"), status: d.status, views: d.views, created_at: d.created_at, updated_at: d.updated_at });
async function readBody(req) {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) return { form: await req.formData() };
  try { return { data: await req.json() }; } catch { return { data: {} }; }
}
// A typo like 30000 in the "how many months?" box used to give a plan until the year 4526; 10 years is the most one approval can add.
const MAX_PLAN_MONTHS = 120;
// Subjects use one semester label, "Semester 1" … "Semester 8" (admin picks it from a dropdown).
// Older free-typed values like "1 sem", "sem-2", "II", "3rd semester" are read the same way.
// Returns "" for empty, "Semester N" for a readable value, null when it can't be read.
const ROMAN_SEM = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
const normalizeSemester = x => {
  const s = String(x == null ? "" : x).trim().toLowerCase();
  if (!s) return "";
  let m = s.match(/(?:^|[^0-9])([1-8])(?:st|nd|rd|th)?(?![0-9])/);
  let n = m ? +m[1] : 0;
  if (!n && (m = s.replace(/sem(ester)?/g, " ").match(/(?:^|[^a-z])(viii|vii|vi|iv|v|iii|ii|i)(?![a-z])/))) n = ROMAN_SEM[m[1]];
  return n ? "Semester " + n : null;
};
// Phase 1b: a student sees only the notes of their own branch and semester. A subject with no branch is for every branch;
// its semester must still match. Admins are never filtered; a visitor who is not logged in is not filtered here either (reading still needs a login).
const STUDY_MSG = { study: "Pehle apna branch aur semester chuno.", other_study: "Ye notes aapke branch/semester ke nahi hain. Profile me jaake badlo." };
const studyNeeded = user => !!user && user.role !== "admin" && (!user.branch || !user.semester);
const studyFits = (user, subj) => {
  if (!user || user.role === "admin") return true;
  if (!user.branch || !user.semester || !subj) return false;
  if (subj.branch && subj.branch !== user.branch) return false;
  return normalizeSemester(subj.semester) === "Semester " + user.semester;
};
// null when the user may see this subject's notes, else "study" (not chosen yet) or "other_study" (not their branch/semester)
async function studyReason(env, user, subjectId) {
  if (!user || user.role === "admin") return null;
  if (studyNeeded(user)) return "study";
  const sj = subjectId ? await env.DB.prepare("SELECT id, branch, semester FROM subjects WHERE id=?").bind(subjectId).first() : null;
  return studyFits(user, sj) ? null : "other_study";
}
async function visibleDocs(env, user, docs) {
  const subs = new Map((await env.DB.prepare("SELECT id, branch, semester FROM subjects").all()).results.map(s => [s.id, s]));
  return docs.filter(d => studyFits(user, subs.get(d.subject_id)));
}
const addMonths = (base, months) => { const d = new Date(base); d.setUTCMonth(d.getUTCMonth() + months); return d.getTime(); };

// ---------- Razorpay (automatic payments) ----------
// Keys come from Cloudflare env first (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET),
// then from Admin → Settings (stored in D1, never shown again, never in backups).
// No Key ID + Key Secret → Razorpay is OFF and the manual UPI (UTR + screenshot) flow is used exactly as before.
const RZP_SECRET_SETTINGS = ["rzp_key_secret", "rzp_webhook_secret"];
const HIDDEN_SETTINGS = ["mail_api_key", "_code_pepper", ...RZP_SECRET_SETTINGS];
const RZP_KEY_RE = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;
function rzpConfig(env, s) {
  const e = k => (env && env[k] != null ? String(env[k]).trim() : "");
  const g = k => (s && s[k] != null ? String(s[k]).trim() : "");
  const keyId = e("RAZORPAY_KEY_ID") || g("rzp_key_id");
  const keySecret = e("RAZORPAY_KEY_SECRET") || g("rzp_key_secret");
  const webhookSecret = e("RAZORPAY_WEBHOOK_SECRET") || g("rzp_webhook_secret");
  const on = !!(keyId && keySecret);
  return {
    on, keyId, keySecret, webhookSecret,
    mode: /^rzp_live_/.test(keyId) ? "live" : /^rzp_test_/.test(keyId) ? "test" : "",
    hideManual: on && g("rzp_hide_manual") === "1",
    source: e("RAZORPAY_KEY_ID") ? "env" : keyId ? "settings" : "",
    apiBase: e("RAZORPAY_API_BASE") || "https://api.razorpay.com",
  };
}
// Checkout success: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
async function verifyCheckoutSignature(orderId, paymentId, signature, keySecret) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  return safeEq(await hmacHex(keySecret, orderId + "|" + paymentId), String(signature).toLowerCase());
}
// Webhook: X-Razorpay-Signature = HMAC_SHA256(raw request body, webhook_secret)
async function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!signature || !webhookSecret) return false;
  return safeEq(await hmacHex(webhookSecret, rawBody), String(signature).toLowerCase());
}
async function rzpApi(cfg, method, path, body) {
  const auth = "Basic " + btoa(cfg.keyId + ":" + cfg.keySecret);
  const r = await fetch(cfg.apiBase + "/v1" + path, { method, headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) {
    const msg = (d && d.error && d.error.description) || ("Razorpay error " + r.status);
    throw new HttpError(502, r.status === 401 ? "Razorpay keys were not accepted. Check Key ID and Key Secret in Admin → Settings." : "Payment gateway: " + msg);
  }
  return d;
}
// Activates (or extends) the plan for a paid Razorpay order. Safe to call many times for the same order
// (checkout callback, webhook payment.captured, webhook order.paid): the unique index on
// payments.gateway_order_id lets exactly one call insert the payment row, and the premium update only
// runs when that row was inserted by this call. Both run in one D1 batch (a transaction).
// Time is added on top of any time left, same rule as a manual approval (addMonths(max(now, premium_until), months)).
async function activateRazorpayOrder(env, orderId, paymentId, { paidAmountPaise, source } = {}) {
  const o = await env.DB.prepare("SELECT * FROM rzp_orders WHERE order_id=?").bind(String(orderId || "")).first();
  if (!o) return { ok: false, reason: "unknown_order" };
  if (paidAmountPaise != null && Number(paidAmountPaise) !== Number(o.amount_paise)) {
    await log(env, "razorpay", "payment.amount_mismatch", `${orderId} · ${paymentId} · paid ${paidAmountPaise} paise, order ${o.amount_paise} paise · not activated`);
    return { ok: false, reason: "amount_mismatch" };
  }
  const now = Date.now(), payId = uid("p_");
  const months = Math.max(1, parseInt(o.months, 10) || 1);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO payments(id,user_id,plan_id,plan_name,amount,months,utr,proof_key,status,note,created_at,decided_at,decided_by,method,gateway_order_id,gateway_payment_id,user_email) VALUES(?,?,?,?,?,?,NULL,NULL,'approved',?,?,?,?,'razorpay',?,?,?)")
      .bind(payId, o.user_id, o.plan_id, o.plan_name, o.amount, months, "Paid online (Razorpay)", now, now, "razorpay:" + (source || "auto"), o.order_id, String(paymentId), o.user_email || null),
    // premium_until is in ms. Same as addMonths(max(now, premium_until), months), done in SQL so it is atomic.
    env.DB.prepare(`UPDATE users SET plan_name=?, premium_until=CAST(ROUND((julianday(MAX(?, COALESCE(premium_until,0)) / 1000.0, 'unixepoch', '+${months} months') - 2440587.5) * 86400000) AS INTEGER) WHERE id=? AND EXISTS (SELECT 1 FROM payments WHERE id=?)`)
      .bind(o.plan_name, now, o.user_id, payId),
    env.DB.prepare("UPDATE rzp_orders SET status='paid', payment_id=COALESCE(payment_id, ?), paid_at=COALESCE(paid_at, ?) WHERE order_id=?").bind(String(paymentId), now, o.order_id),
  ]);
  const row = await env.DB.prepare("SELECT id, gateway_payment_id FROM payments WHERE gateway_order_id=?").bind(o.order_id).first();
  const u = await env.DB.prepare("SELECT email, premium_until, plan_name FROM users WHERE id=?").bind(o.user_id).first();
  const fresh = !!row && row.id === payId;
  if (fresh) await log(env, "razorpay", "payment.auto_approve", `${u && u.email} · ${o.plan_name} ₹${o.amount} · ${paymentId} · ${source || ""} · premium until ${u ? new Date(u.premium_until).toISOString().slice(0, 10) : "?"}`);
  return { ok: true, activated: fresh, already: !fresh, premium_until: u ? u.premium_until : 0, plan_name: o.plan_name };
}
// ---- file storage ----
// Default: R2 bucket bound as FILES. Free fallback: a KV namespace bound as FILES_KV
// (for accounts where R2 isn't enabled; KV values max 25 MB each).
// If BOTH are bound, new uploads go to R2 and a key missing in R2 is read from KV,
// so you can enable R2 later without moving old files by hand.
const KV_MAX_BYTES = 25 * 1024 * 1024;
function fileStore(env) {
  const r2 = env.FILES || null, kv = env.FILES_KV || null;
  if (!r2 && !kv) throw new HttpError(500, "File storage is not set up (bind an R2 bucket as FILES or a KV namespace as FILES_KV)");
  const kvGet = async key => {
    const r = await kv.getWithMetadata(key, { type: "stream" });
    return r && r.value ? { body: r.value, httpMetadata: { contentType: (r.metadata && r.metadata.contentType) || undefined } } : null;
  };
  return {
    kind: r2 ? "r2" : "kv",
    maxBytes: r2 ? 95e6 : KV_MAX_BYTES,
    async get(key) {
      if (r2) { const o = await r2.get(key); if (o || !kv) return o; }
      return kvGet(key);
    },
    async put(key, stream, contentType) {
      if (r2) return r2.put(key, stream, { httpMetadata: { contentType } });
      return kv.put(key, stream, { metadata: { contentType } });
    },
    async delete(key) {
      if (r2) await r2.delete(key);
      if (kv) await kv.delete(key);
    },
  };
}
// `type` is the content type we checked from the file's own bytes (never the browser's claim).
async function putFile(env, prefix, file, type) {
  const fs = fileStore(env);
  if (file.size > fs.maxBytes) throw new HttpError(400, `File too large (max ${Math.floor(fs.maxBytes / 1048576)} MB)`);
  const ext = SAFE_EXT[type] || "bin";
  const key = `${prefix}/${uid()}.${ext}`;
  await fs.put(key, file.stream(), type || "application/octet-stream");
  return key;
}
// ---- upload checks: look at the first bytes of the file, not at its name or the browser's type ----
const SAFE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"];
const SAFE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };
async function headBytes(file, n) { return new Uint8Array(await file.slice(0, n).arrayBuffer()); }
async function sniffImage(file) {
  const b = await headBytes(file, 16), s = (i, j) => String.fromCharCode(...b.slice(i, j));
  if (b[0] === 0x89 && s(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (s(0, 4) === "GIF8") return "image/gif";
  if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "image/webp";
  if (s(4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(s(8, 12))) return "image/heic";
  return null; // SVG, HTML and everything else is refused
}
async function isPdf(file) { const b = await headBytes(file, 1024); return dec.decode(b).includes("%PDF-"); }
// Serves a stored file so a browser can never run it as a page (stops stored XSS via uploads).
function fileResponse(body, storedType, { image, cache }) {
  const t = String(storedType || "").toLowerCase().split(";")[0].trim();
  const safe = image ? SAFE_IMAGE_TYPES.includes(t) : false;
  return new Response(body, { headers: {
    "content-type": safe ? t : "application/octet-stream",
    ...(safe ? {} : { "content-disposition": "attachment" }),
    "cache-control": cache, "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  } });
}

// ---------- API ----------
async function api(req, env, url) {
  const path = url.pathname.replace(/^\/api/, "");
  const m = req.method;
  // Payments and subscription endpoints are retired in the website-only free version.
  if (/^(\/payments(?:\/|$)|\/razorpay(?:\/|$)|\/admin\/(?:payments|razorpay|plans)(?:\/|$)|\/plans(?:\/|$))/.test(path))
    return err(410, "Payments and subscriptions have been removed. Study material is free.");
  const user = await currentUser(req, env);
  const admin = user && user.role === "admin";
  let mm;

  if (path === "/health") return json({ ok: true });

  if (path === "/bootstrap" && m === "GET") {
    const s = await settingsMap(env);
    const pub = {}; for (const k of PUBLIC_SETTINGS) pub[k] = s[k] || "";
    const [cats, subs, units, plans, counts] = await Promise.all([
      env.DB.prepare("SELECT * FROM categories WHERE visible=1 ORDER BY sort").all(),
      env.DB.prepare("SELECT * FROM subjects WHERE visible=1 ORDER BY sort, name").all(),
      env.DB.prepare("SELECT * FROM units ORDER BY sort, name").all(),
      env.DB.prepare("SELECT * FROM plans WHERE active=1 ORDER BY sort, price").all(),
      env.DB.prepare("SELECT subject_id, COUNT(*) n FROM documents WHERE status='published' GROUP BY subject_id").all(),
    ]);
    const cnt = {}; for (const r of counts.results) cnt[r.subject_id] = r.n;
    const ac = authConfig(env, s);
    const rc = rzpConfig(env, s);
    return json({ settings: pub, auth: { google_client_id: ac.googleClientId, email_codes: !!ac.mail },
      pay: { razorpay: rc.on, key_id: rc.on ? rc.keyId : "", mode: rc.on ? rc.mode : "", manual: !rc.hideManual }, needs_setup: !(await env.DB.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").first()),
      categories: cats.results, subjects: subs.results.map(x => ({ ...x, doc_count: cnt[x.id] || 0 })), units: units.results,
      plans: plans.results.map(p => ({ ...p, features: JSON.parse(p.features || "[]") })), me: publicUser(user) });
  }

  if (path === "/documents" && m === "GET") {
    const q = clean(url.searchParams.get("q"), 100).toLowerCase();
    const where = ["d.status='published'"], args = [];
    for (const [p, col] of [["category", "d.category_id"], ["subject", "d.subject_id"], ["unit", "d.unit_id"], ["access", "d.access_level"]]) {
      const v = url.searchParams.get(p); if (v) { where.push(col + "=?"); args.push(v); }
    }
    if (q) { where.push("(lower(d.title) LIKE ? OR lower(d.description) LIKE ? OR lower(s.name) LIKE ? OR lower(replace(replace(s.code,' ',''),'-','')) LIKE ? OR lower(s.code) LIKE ? OR lower(c.name) LIKE ? OR lower(d.tags) LIKE ?)");
      const like = "%" + q + "%"; const codeLike = "%" + q.replace(/[\s-]/g, "") + "%"; args.push(like, like, like, codeLike, like, like, like); }
    const { results } = await env.DB.prepare(`SELECT d.* FROM documents d LEFT JOIN subjects s ON s.id=d.subject_id LEFT JOIN categories c ON c.id=d.category_id WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT 300`).bind(...args).all();
    // a student's list is their own branch and semester only (studyFits); admins and visitors see it all, as before
    const shown = user && user.role !== "admin" ? await visibleDocs(env, user, results) : results;
    return json({ documents: shown.map(docOut) });
  }

  if ((mm = path.match(/^\/documents\/([\w-]+)$/)) && m === "GET") {
    const d = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(mm[1]).first();
    if (!d || (d.status !== "published" && !admin)) return err(404, "Document not found");
    const sr = await studyReason(env, user, d.subject_id);
    if (sr) return json({ document: docOut(d), parts: {}, access: { can_view: false, reason: sr, can_download: false } });
    const can = !!user && (d.access_level === "free" || isPremium(user));
    if (!ISBOT.test(req.headers.get("user-agent") || "")) await env.DB.prepare("UPDATE documents SET views=views+1 WHERE id=?").bind(d.id).run(); // search-engine visits are not counted as views
    return json({ document: docOut(d), parts: await partsMeta(env, d.id, d), access: { can_view: can && !!d.file_key, reason: !user ? "login" : !can ? "premium" : !d.file_key ? "no_file" : "ok", can_download: can && !!d.download_allowed } });
  }

  if ((mm = path.match(/^\/file\/([\w-]+)$/)) && m === "GET") {
    const d = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(mm[1]).first();
    if (!d || !d.file_key || (d.status !== "published" && !admin)) return err(404, "File not found");
    if (!user) return err(401, "Login required");
    { const sr = await studyReason(env, user, d.subject_id); if (sr) return err(403, STUDY_MSG[sr]); }
    if (d.access_level !== "free" && !isPremium(user)) return err(403, "Premium plan required");
    // a view-only PDF is read inside the site's viewer (protected: no print/save, blur on focus loss); opening the file link directly in a tab
    // would hand over the browser's own PDF viewer with its download/print buttons, so that goes to the viewer page
    const dest = (req.headers.get("sec-fetch-dest") || "").toLowerCase();
    if (!d.download_allowed && !admin && ["document", "iframe", "frame", "embed", "object"].includes(dest))
      return new Response(null, { status: 302, headers: { location: "/document/" + d.id, "cache-control": "no-store" } });
    const obj = await fileStore(env).get(d.file_key);
    if (!obj) return err(404, "File not found");
    const name = (d.file_name || (d.title + ".pdf")).replace(/[^\w.\- ]/g, "_");
    // only real PDFs are shown inline; any other stored type is sent as a plain download, never as a web page
    const isPdf = /^application\/pdf\b/i.test(obj.httpMetadata?.contentType || "application/pdf") || /\.pdf$/i.test(name);
    const dl = !isPdf || (url.searchParams.get("dl") === "1" && (d.download_allowed || admin));
    return new Response(obj.body, { headers: { "content-type": isPdf ? "application/pdf" : "application/octet-stream", "content-disposition": `${dl ? "attachment" : "inline"}; filename="${name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }

  // ---- Phase 1 parts: Short and Important Topics + PYQs (a PDF, or pasted text) ----
  if ((mm = path.match(/^\/part\/([\w-]+)\/(short|important)$/)) && m === "GET") {
    const d = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(mm[1]).first();
    if (!d || (d.status !== "published" && !admin)) return err(404, "File not found");
    if (!user) return err(401, "Login required");
    { const sr = await studyReason(env, user, d.subject_id); if (sr) return err(403, STUDY_MSG[sr]); }
    if (d.access_level !== "free" && !isPremium(user)) return err(403, "Premium plan required");
    const p = await env.DB.prepare("SELECT file_key, file_name FROM document_parts WHERE doc_id=? AND part=?").bind(d.id, mm[2]).first();
    if (!p || !p.file_key) return err(404, "File not found");
    const dest = (req.headers.get("sec-fetch-dest") || "").toLowerCase();
    if (!d.download_allowed && !admin && ["document", "iframe", "frame", "embed", "object"].includes(dest))
      return new Response(null, { status: 302, headers: { location: "/document/" + d.id, "cache-control": "no-store" } });
    const obj = await fileStore(env).get(p.file_key);
    if (!obj) return err(404, "File not found");
    const name = (p.file_name || (d.title + " - " + mm[2] + ".pdf")).replace(/[^\w.\- ]/g, "_");
    const dl = url.searchParams.get("dl") === "1" && (d.download_allowed || admin);
    return new Response(obj.body, { headers: { "content-type": "application/pdf", "content-disposition": `${dl ? "attachment" : "inline"}; filename="${name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  if ((mm = path.match(/^\/part-text\/([\w-]+)\/(short|important)$/)) && m === "GET") {
    const d = await env.DB.prepare("SELECT id, subject_id, access_level, status FROM documents WHERE id=?").bind(mm[1]).first();
    if (!d || (d.status !== "published" && !admin)) return err(404, "Not found");
    if (!user) return err(401, "Login required");
    { const sr = await studyReason(env, user, d.subject_id); if (sr) return err(403, STUDY_MSG[sr]); }
    if (d.access_level !== "free" && !isPremium(user)) return err(403, "Premium plan required");
    const p = await env.DB.prepare("SELECT text_content FROM document_parts WHERE doc_id=? AND part=?").bind(d.id, mm[2]).first();
    if (!p || !p.text_content) return err(404, "Not found");
    return json({ part: mm[2], text: p.text_content });
  }

  // ---- Premium free trial and study choices (Phase 1) ----
  if (path === "/me/prefs" && m === "POST") {
    if (!user) return err(401, "Login required");
    const { data } = await readBody(req);
    const sets = [], args = [];
    if (data.theme !== undefined) { const t = String(data.theme); if (!THEMES.includes(t)) return err(400, "Theme not recognised"); sets.push("theme=?"); args.push(t); }
    if (data.skip && user.role === "admin") { sets.push("study_set_at=COALESCE(study_set_at,?)"); args.push(Date.now()); }
    else if (data.skip) return err(400, "Branch aur semester dono chuno");
    else if (data.branch !== undefined || data.semester !== undefined) {
      const b = data.branch === undefined ? undefined : data.branch === null || data.branch === "" ? null : String(data.branch);
      if (b != null && !BRANCHES.includes(b)) return err(400, "Branch not recognised");
      const sem = data.semester === null || data.semester === undefined || data.semester === "" ? null : parseInt(data.semester, 10);
      if (sem !== null && !(sem >= 1 && sem <= 8)) return err(400, "Semester must be 1 to 8");
      // a student must have both (the required step on first login); the admin account is not held to it
      const fb = data.branch !== undefined ? b : user.branch, fsem = data.semester !== undefined ? sem : user.semester;
      if (user.role !== "admin" && (!fb || !fsem)) return err(400, "Branch aur semester dono chuno");
      sets.push("branch=?", "semester=?", "study_set_at=?"); args.push(fb, fsem, Date.now());
    }
    if (!sets.length) return err(400, "Nothing to save");
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).bind(...args, user.id).run();
    return json({ me: publicUser(await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first()) });
  }
  if (path === "/trial/start" && m === "POST") {
    if (!user) return err(401, "Login required");
    if (user.blocked) return blockedErr();
    const tc = trialCfg(await settingsMap(env));
    if (!tc.enabled) return err(403, "Free trial abhi band hai");
    if (user.role === "admin") return err(400, "Admin account ko trial ki zaroorat nahi");
    if (user.trial_started_at) return err(409, "Aapka free Premium trial pehle hi use ho chuka hai");
    if (user.email_verified === 0) return err(403, "Pehle email verify karo, phir trial shuru hoga");
    const now = Date.now(), until = now + tc.days * DAY_MS;
    if (await env.DB.prepare("SELECT 1 FROM trial_claims WHERE email_key=?").bind(emailKey(user.email)).first()) return err(409, "Is email par free trial pehle hi use ho chuka hai");
    try {
      // one batch = one transaction: the claim row (unique per email) and the user's trial start land together or not at all
      await env.DB.batch([
        env.DB.prepare("INSERT INTO trial_claims(email_key,user_id,claimed_at) VALUES(?,?,?)").bind(emailKey(user.email), user.id, now),
        env.DB.prepare("UPDATE users SET trial_started_at=?, trial_until=? WHERE id=? AND trial_started_at IS NULL").bind(now, until, user.id),
      ]);
    } catch (e) { return err(409, "Is email par free trial pehle hi use ho chuka hai"); }
    await log(env, user.email, "trial.start", `${tc.days} days`);
    return json({ me: publicUser(await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first()) });
  }

  // ---- Android "Secure Reader" (app v1.0.2+) ----
  // Inside the app the viewer page does not draw the PDF in Chrome (Chrome's window can be screenshotted). It asks for
  // a one-time token here and hands it to the app's native reader (FLAG_SECURE: screenshots/recordings come out black),
  // which downloads the PDF once with /api/reader-file. Same access rules as the viewer: login, and premium for premium docs.
  if (path === "/reader-token" && m === "POST") {
    if (!user) return err(401, "Login required");
    const body = await req.json().catch(() => ({}));
    const docId = clean(body.doc, 64), part = ["short", "important"].includes(body.part) ? body.part : "detailed";
    if (!/^[\w-]{1,64}$/.test(docId)) return err(400, "Bad document id");
    const d = await env.DB.prepare("SELECT id, subject_id, access_level, file_key, status FROM documents WHERE id=?").bind(docId).first();
    if (d) { const sr = await studyReason(env, user, d.subject_id); if (sr) return err(403, STUDY_MSG[sr]); }
    if (!d || (d.status !== "published" && !admin)) return err(404, "File not found");
    if (d.access_level !== "free" && !isPremium(user)) return err(403, "Premium plan required");
    if (part === "detailed" ? !d.file_key : !(await env.DB.prepare("SELECT 1 FROM document_parts WHERE doc_id=? AND part=? AND file_key IS NOT NULL").bind(d.id, part).first())) return err(404, "File not found");
    const token = randHex(32), now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM reader_tokens WHERE expires<?").bind(now - READER_TOKEN_TTL_MS),
      env.DB.prepare("INSERT INTO reader_tokens(token_hash,doc_id,user_id,expires,part) VALUES(?,?,?,?,?)").bind(await sha256(token), d.id, user.id, now + READER_TOKEN_TTL_MS, part),
    ]);
    return json({ token, doc: d.id, part, expires_in: READER_TOKEN_TTL_MS / 1000 });
  }
  if (path === "/reader-file" && m === "GET") {
    const docId = url.searchParams.get("doc") || "", t = url.searchParams.get("t") || "";
    if (!/^[\w-]{1,64}$/.test(docId) || !/^[0-9a-f]{64}$/.test(t)) return err(400, "Bad reader link");
    // the native reader fetches this; a browser tab/frame opening it is not the reader
    const dest = (req.headers.get("sec-fetch-dest") || "").toLowerCase();
    if (["document", "iframe", "frame", "embed", "object"].includes(dest)) return err(403, "Ye link sirf StudyHPD app ke Secure Reader me khulta hai");
    const now = Date.now();
    // single use: the UPDATE only succeeds once, and only before expiry
    const row = await env.DB.prepare("UPDATE reader_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires>? RETURNING doc_id, user_id, part").bind(now, await sha256(t), now).first();
    if (!row) return err(410, "Reader link expire ho gaya ya pehle use ho chuka hai. App me wapas jaake notes dobara kholo.");
    if (row.doc_id !== docId) return err(403, "Reader link is document ke liye nahi hai");
    const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(row.user_id).first();
    const d = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(docId).first();
    const part = row.part && row.part !== "detailed" ? row.part : "detailed";
    const pf = part === "detailed" ? null : await env.DB.prepare("SELECT file_key FROM document_parts WHERE doc_id=? AND part=?").bind(docId, part).first();
    const fileKey = part === "detailed" ? (d && d.file_key) : (pf && pf.file_key);
    if (!u || u.blocked || !d || !fileKey || (d.status !== "published" && u.role !== "admin")) return err(404, "File not found");
    { const sr = await studyReason(env, u, d.subject_id); if (sr) return err(403, STUDY_MSG[sr]); }
    if (d.access_level !== "free" && !isPremium(u)) return err(403, "Premium plan required");
    const obj = await fileStore(env).get(fileKey);
    if (!obj) return err(404, "File not found");
    return new Response(obj.body, { headers: { "content-type": "application/pdf", "content-disposition": "inline", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }

  if ((mm = path.match(/^\/media\/(.+)$/)) && m === "GET") {
    const key = decodeURIComponent(mm[1]);
    if (!key.startsWith("public/")) return err(404, "Not found");
    const obj = await fileStore(env).get(key); if (!obj) return err(404, "Not found");
    return fileResponse(obj.body, obj.httpMetadata?.contentType, { image: true, cache: "public, max-age=300" });
  }
  if ((mm = path.match(/^\/thumb\/([\w-]+)$/)) && m === "GET") {
    const d = await env.DB.prepare("SELECT thumb_key, status FROM documents WHERE id=?").bind(mm[1]).first();
    if (!d || !d.thumb_key || (d.status !== "published" && !admin)) return err(404, "Not found");
    const obj = await fileStore(env).get(d.thumb_key); if (!obj) return err(404, "Not found");
    // the app links covers as /api/thumb/<id>?v=<updated_at>, so a versioned link can be kept for a day
    return fileResponse(obj.body, obj.httpMetadata?.contentType, { image: true, cache: url.searchParams.get("v") ? "public, max-age=86400" : "public, max-age=300" });
  }

  // ---- auth ----
  if (path === "/auth/email-check" && m === "POST") {
    // instant feedback on the signup form; /auth/register runs the same check again
    const { data } = await readBody(req);
    const email = clean(data.email, 200).toLowerCase();
    if (!emailOk(email)) return json({ ok: false, error: "Please enter a valid email" });
    if (!(await rateHit(env, "echeck:ip:" + clientIp(req), 60, 10 * 60 * 1000))) return json({ ok: true, skipped: true });
    const ec = await checkSignupEmail(email, env);
    return json(ec.ok ? { ok: true } : { ok: false, error: ec.message, email_blocked: ec.reason });
  }
  if (path === "/auth/register" && m === "POST") {
    const { data } = await readBody(req);
    const email = clean(data.email, 200).toLowerCase(), name = clean(data.name, 100), phone = clean(data.phone, 20), password = String(data.password || "");
    if (!emailOk(email)) return err(400, "Please enter a valid email");
    if (password.length < 6) return err(400, "Password must be at least 6 characters");
    const cfg = await loadAuthConfig(env);
    const ex = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (ex && ex.blocked) return blockedErr();
    if (ex && (ex.email_verified !== 0 || !cfg.mail)) return err(409, ex.pass_hash ? "An account with this email already exists. Please log in." : "This email signs in with Google. Use “Continue with Google”.");
    // temporary / disposable / non-existent email domains can't sign up (existing accounts are never checked)
    const ec = await checkSignupEmail(email, env);
    if (!ec.ok) return json({ error: ec.message, email_blocked: ec.reason }, 400);
    const salt = randHex(16), ph = await hashPassword(password, salt);
    if (cfg.mail) {
      // account stays unverified until the emailed code is entered (an unverified signup can be redone)
      if (ex) await env.DB.prepare("UPDATE users SET name=?, phone=?, pass_hash=?, salt=? WHERE id=?").bind(name || ex.name, phone, ph, salt, ex.id).run();
      else await env.DB.prepare("INSERT INTO users(id,name,email,phone,pass_hash,salt,role,created_at,email_verified) VALUES(?,?,?,?,?,?,'student',?,0)").bind(uid("u_"), name || email.split("@")[0], email, phone, ph, salt, Date.now()).run();
      try { return json({ verify: true, ...(await sendCode(env, req, cfg, email, "verify", name)) }); }
      catch (e) { if (e.status === 429 && e.extra.cooldown) return json({ verify: true, sent: false, email, cooldown: e.extra.cooldown }); throw e; }
    }
    const id = uid("u_");
    await env.DB.prepare("INSERT INTO users(id,name,email,phone,pass_hash,salt,role,created_at,email_verified) VALUES(?,?,?,?,?,?,'student',?,1)").bind(id, name || email.split("@")[0], email, phone, ph, salt, Date.now()).run();
    const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    return json({ me: publicUser(u) }, 200, { "set-cookie": await startSession(env, id) });
  }
  if (path === "/auth/login" && m === "POST") {
    const { data } = await readBody(req);
    const email = clean(data.email, 200).toLowerCase(), password = String(data.password || "");
    if (!(await rateHit(env, "login:ip:" + clientIp(req), 30, 10 * 60 * 1000))) return err(429, "Too many login attempts. Please wait a few minutes.");
    // per-account limit too, so a password can't be guessed from many different IPs
    if (!(await rateHit(env, "login:e:" + email, LOGIN_MAX_PER_EMAIL, 15 * 60 * 1000))) return err(429, "Too many login attempts for this account. Please wait 15 minutes, or log in with an email code.");
    const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (u && !u.pass_hash) return err(401, "This account signs in with Google. Use “Continue with Google” (or log in with an email code).");
    // hash even when the email is unknown, so response time doesn't reveal which emails have accounts
    const okPass = safeEq(await hashPassword(password, u ? u.salt : "x".repeat(32)), u ? u.pass_hash : "-");
    if (!u || !okPass) return err(401, "Wrong email or password");
    if (u.blocked) return blockedErr();
    if (data.admin && u.role !== "admin") return err(403, "This account is not an admin");
    if (u.email_verified === 0 && u.role !== "admin") {
      const cfg = await loadAuthConfig(env);
      if (cfg.mail) {
        let info = { sent: false };
        try { info = await sendCode(env, req, cfg, email, "verify", u.name); } catch (e) { if (!(e.status === 429 && e.extra.cooldown)) throw e; info = { sent: false, cooldown: e.extra.cooldown }; }
        return json({ error: "Please verify your email first. We've sent a 6-digit code to " + email + ".", verify_required: true, email, ...info }, 403);
      }
    }
    if (u.role === "admin") await log(env, u.email, "login", "Admin signed in");
    return json({ me: publicUser(u) }, 200, { "set-cookie": await startSession(env, u.id) });
  }
  if (path === "/auth/code" && m === "POST") {
    const { data } = await readBody(req);
    const email = clean(data.email, 200).toLowerCase(), purpose = String(data.purpose || "");
    if (!CODE_PURPOSES.includes(purpose)) return err(400, "Unknown code type");
    if (!emailOk(email)) return err(400, "Please enter a valid email");
    const cfg = await loadAuthConfig(env);
    if (!cfg.mail) return err(400, "Email codes are not enabled on this site yet");
    const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (!u) return err(404, purpose === "verify" ? "No signup found for this email. Please register again." : "No account with this email. Please create one first.");
    if (u.blocked) return blockedErr();
    if (purpose === "verify" && u.email_verified !== 0) return json({ sent: false, already_verified: true, email });
    return json(await sendCode(env, req, cfg, email, purpose, u.name));
  }
  if (path === "/auth/verify" && m === "POST") {
    const { data } = await readBody(req);
    const email = clean(data.email, 200).toLowerCase(), purpose = String(data.purpose || "verify");
    if (!CODE_PURPOSES.includes(purpose)) return err(400, "Unknown code type");
    const u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (!u) return err(404, "No account with this email");
    if (u.blocked) return blockedErr();
    let np = "";
    if (purpose === "reset") { np = String(data.password || ""); if (np.length < (u.role === "admin" ? 8 : 6)) return err(400, `New password must be at least ${u.role === "admin" ? 8 : 6} characters`); }
    await checkCode(env, req, email, purpose, data.code);
    if (purpose === "reset") {
      const salt = randHex(16);
      await env.DB.batch([env.DB.prepare("UPDATE users SET pass_hash=?, salt=?, email_verified=1 WHERE id=?").bind(await hashPassword(np, salt), salt, u.id), env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id)]);
      await log(env, u.email, "password.reset", "Password reset with email code");
    } else if (u.email_verified === 0) await env.DB.prepare("UPDATE users SET email_verified=1 WHERE id=?").bind(u.id).run();
    if (u.role === "admin") await log(env, u.email, "login", purpose === "login" ? "Admin signed in with email code" : "Admin verified email");
    const fresh = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u.id).first();
    return json({ me: publicUser(fresh) }, 200, { "set-cookie": await startSession(env, u.id) });
  }
  if (path === "/auth/google" && m === "POST") {
    const { data } = await readBody(req);
    if (!(await rateHit(env, "google:ip:" + clientIp(req), 30, 10 * 60 * 1000))) return err(429, "Too many attempts. Please wait a few minutes.");
    const cfg = await loadAuthConfig(env);
    const p = await verifyGoogleIdToken(data.credential, cfg.googleClientId);
    const email = String(p.email).toLowerCase();
    let u = await env.DB.prepare("SELECT * FROM users WHERE google_sub=?").bind(p.sub).first();
    let created = false;
    if (!u) {
      u = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
      if (u && u.blocked) return blockedErr();
      if (u) {
        // link Google to the existing account; an unverified password signup could have been made by someone else, so its password is dropped
        const st = [env.DB.prepare("UPDATE users SET google_sub=?, email_verified=1, name=COALESCE(NULLIF(name,''),?) WHERE id=?").bind(p.sub, clean(p.name, 100) || email.split("@")[0], u.id)];
        if (u.email_verified === 0) st.push(env.DB.prepare("UPDATE users SET pass_hash='', salt='' WHERE id=?").bind(u.id), env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id));
        await env.DB.batch(st);
      } else {
        // a NEW Google account made on a known temp-mail address is refused too (list only; real Gmail/Workspace always passes)
        if (disposableReason(email.split("@")[1])) return json({ error: TEMP_MAIL_MSG, email_blocked: "list" }, 400);
        const id = uid("u_");
        await env.DB.prepare("INSERT INTO users(id,name,email,phone,pass_hash,salt,role,created_at,email_verified,google_sub) VALUES(?,?,?,'','','','student',?,1,?)").bind(id, clean(p.name, 100) || email.split("@")[0], email, Date.now(), p.sub).run();
        created = true;
        u = { id };
      }
    }
    const fresh = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u.id).first();
    if (fresh.blocked) return blockedErr();
    if (data.admin && fresh.role !== "admin") return err(403, "This account is not an admin");
    if (fresh.role === "admin") await log(env, fresh.email, "login", "Admin signed in with Google");
    return json({ me: publicUser(fresh), created }, 200, { "set-cookie": await startSession(env, fresh.id) });
  }
  if (path === "/auth/logout" && m === "POST") {
    const t = cookieOf(req, "sid"); if (t) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(t)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }
  if (path === "/admin/setup" && m === "POST") {
    const { data } = await readBody(req);
    const th = await sha256(String(data.token || ""));
    const allowed = [...SETUP_TOKEN_HASHES]; if (env.SETUP_TOKEN) allowed.push(await sha256(String(env.SETUP_TOKEN)));
    if (!allowed.some(h => safeEq(th, h))) return err(403, "This setup link is not valid");
    if (await env.DB.prepare("SELECT 1 FROM used_tokens WHERE hash=?").bind(th).first()) return err(410, "This setup link was already used. Log in at /admin/login");
    const email = clean(data.email, 200).toLowerCase(), password = String(data.password || ""), name = clean(data.name, 100) || "Admin";
    if (!emailOk(email)) return err(400, "Please enter a valid email");
    if (password.length < 8) return err(400, "Admin password must be at least 8 characters");
    const salt = randHex(16), ph = await hashPassword(password, salt);
    const ex = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    let id = ex && ex.id;
    if (ex) await env.DB.prepare("UPDATE users SET role='admin', pass_hash=?, salt=?, name=? WHERE id=?").bind(ph, salt, name, id).run();
    else { id = uid("u_"); await env.DB.prepare("INSERT INTO users(id,name,email,phone,pass_hash,salt,role,created_at) VALUES(?,?,?,?,?,?,'admin',?)").bind(id, name, email, "", ph, salt, Date.now()).run(); }
    await env.DB.prepare("INSERT INTO used_tokens(hash,used_at) VALUES(?,?)").bind(th, Date.now()).run();
    await log(env, email, "setup", "Admin account created via one-time setup link");
    const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    return json({ me: publicUser(u) }, 200, { "set-cookie": await startSession(env, id) });
  }

  // ---- Razorpay webhook (no login; Razorpay calls this) ----
  if (path === "/razorpay/webhook" && m === "POST") {
    const raw = await req.text();
    const rc = rzpConfig(env, await settingsMap(env));
    if (!rc.webhookSecret) return err(503, "Razorpay webhook secret is not set");
    if (!(await verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"), rc.webhookSecret))) {
      await log(env, "razorpay", "webhook.bad_signature", (req.headers.get("cf-connecting-ip") || "") + " · " + raw.length + " bytes");
      return err(400, "Invalid signature");
    }
    let ev; try { ev = JSON.parse(raw); } catch { return err(400, "Bad JSON"); }
    const event = String(ev.event || "");
    if (!["payment.captured", "order.paid"].includes(event)) return json({ ok: true, ignored: event });
    const pay = (ev.payload && ev.payload.payment && ev.payload.payment.entity) || {};
    const ord = (ev.payload && ev.payload.order && ev.payload.order.entity) || {};
    const orderId = pay.order_id || ord.id, paymentId = pay.id;
    if (!orderId || !paymentId) return json({ ok: true, ignored: "no order/payment id" });
    if (pay.status && pay.status !== "captured") return json({ ok: true, ignored: "payment " + pay.status });
    const r = await activateRazorpayOrder(env, orderId, paymentId, { paidAmountPaise: pay.amount != null ? pay.amount : ord.amount_paid, source: "webhook:" + event });
    return json({ ok: true, ...r });
  }

  // ---- logged-in student ----
  if (!user) return err(401, "Please log in");

  if (path === "/me" && m === "GET") return json({ me: publicUser(user) });
  if (path === "/me" && m === "POST") {
    const { data } = await readBody(req);
    await env.DB.prepare("UPDATE users SET name=?, phone=? WHERE id=?").bind(clean(data.name, 100) || user.name, clean(data.phone, 20), user.id).run();
    return json({ me: publicUser(await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first()) });
  }
  if (path === "/me/password" && m === "POST") {
    const { data } = await readBody(req);
    if (!(await rateHit(env, "pw:u:" + user.id, 10, 15 * 60 * 1000))) return err(429, "Too many attempts. Please wait 15 minutes.");
    if (user.pass_hash && !safeEq(await hashPassword(String(data.current || ""), user.salt), user.pass_hash)) return err(401, "Current password is wrong");
    const np = String(data.password || ""); if (np.length < (user.role === "admin" ? 8 : 6)) return err(400, `New password must be at least ${user.role === "admin" ? 8 : 6} characters`);
    const salt = randHex(16);
    await env.DB.prepare("UPDATE users SET pass_hash=?, salt=? WHERE id=?").bind(await hashPassword(np, salt), salt, user.id).run();
    const t = cookieOf(req, "sid");
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(user.id, await sha256(t)).run();
    if (user.role === "admin") await log(env, user.email, "password", "Changed own password");
    return json({ ok: true });
  }
  // ---- Razorpay checkout (student) ----
  if (path === "/razorpay/order" && m === "POST") {
    const s = await settingsMap(env); const rc = rzpConfig(env, s);
    if (!rc.on) return err(400, "Online payment is not set up. Please pay by UPI and submit the UTR.");
    const { data } = await readBody(req);
    // the amount ALWAYS comes from the plan in the database; anything the browser sends is ignored
    const plan = await env.DB.prepare("SELECT * FROM plans WHERE id=? AND active=1").bind(String(data.plan_id || "")).first();
    if (!plan) return err(400, "Please choose a plan");
    const price = parseInt(plan.price, 10);
    if (!(price >= 1)) return err(400, "This plan has no price");
    if (!(await rateHit(env, "rzporder:" + user.id, 20, 60 * 60 * 1000))) return err(429, "Too many attempts. Please try again later.");
    const amountPaise = price * 100;
    const months = Math.max(1, parseInt(plan.duration_months, 10) || 1);
    const order = await rzpApi(rc, "POST", "/orders", { amount: amountPaise, currency: "INR", receipt: uid("r_"), notes: { user_id: user.id, plan_id: plan.id, plan: plan.name } });
    if (!order || !order.id || Number(order.amount) !== amountPaise) return err(502, "Payment gateway returned an unexpected order");
    await env.DB.prepare("INSERT INTO rzp_orders(order_id,user_id,plan_id,plan_name,amount,amount_paise,months,status,created_at) VALUES(?,?,?,?,?,?,?,'created',?)")
      .bind(order.id, user.id, plan.id, plan.name, price, amountPaise, months, Date.now()).run();
    return json({ key_id: rc.keyId, order_id: order.id, amount: amountPaise, currency: "INR", mode: rc.mode,
      name: s.site_name || "StudyHPD", description: `${plan.name} plan · ${months} month${months > 1 ? "s" : ""}`,
      prefill: { name: user.name || "", email: user.email || "", contact: user.phone || "" } });
  }
  if (path === "/razorpay/verify" && m === "POST") {
    const rc = rzpConfig(env, await settingsMap(env));
    if (!rc.on) return err(400, "Online payment is not set up");
    const { data } = await readBody(req);
    const orderId = clean(data.razorpay_order_id, 60), paymentId = clean(data.razorpay_payment_id, 60), sig = clean(data.razorpay_signature, 200);
    const o = await env.DB.prepare("SELECT * FROM rzp_orders WHERE order_id=?").bind(orderId).first();
    if (!o || o.user_id !== user.id) return err(404, "Order not found");
    if (!(await verifyCheckoutSignature(orderId, paymentId, sig, rc.keySecret))) {
      await log(env, user.email, "payment.bad_signature", `${orderId} · ${paymentId}`);
      return err(400, "Payment could not be verified. If money was deducted, it will activate automatically within a few minutes, or contact us.");
    }
    // Signature is valid. Double-check the payment with Razorpay (order, amount) and capture it if the
    // account is not on auto-capture. If Razorpay can't be reached, the valid signature is enough.
    let paid = null;
    try {
      let p = await rzpApi(rc, "GET", "/payments/" + encodeURIComponent(paymentId));
      if (p.order_id && p.order_id !== orderId) return err(400, "Payment does not belong to this order");
      if (p.amount != null && Number(p.amount) !== Number(o.amount_paise)) { await log(env, user.email, "payment.amount_mismatch", `${orderId} · ${paymentId} · ${p.amount}`); return err(400, "Paid amount does not match the plan price"); }
      if (p.status === "failed") return err(400, "Payment failed. Please try again.");
      if (p.status === "authorized") p = await rzpApi(rc, "POST", "/payments/" + encodeURIComponent(paymentId) + "/capture", { amount: o.amount_paise, currency: "INR" });
      paid = p.amount;
    } catch (e) { /* gateway unreachable: rely on the verified signature */ }
    const r = await activateRazorpayOrder(env, orderId, paymentId, { paidAmountPaise: paid, source: "checkout" });
    if (!r.ok) return err(400, r.reason === "amount_mismatch" ? "Paid amount does not match the plan price" : "Order not found");
    return json({ ok: true, premium_until: r.premium_until, plan_name: r.plan_name, already: r.already, me: publicUser(await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first()) });
  }
  if ((mm = path.match(/^\/razorpay\/order\/([\w-]+)$/)) && m === "GET") {
    const o = await env.DB.prepare("SELECT order_id,status,plan_name,amount,paid_at FROM rzp_orders WHERE order_id=? AND user_id=?").bind(mm[1], user.id).first();
    if (!o) return err(404, "Order not found");
    return json({ ...o, me: publicUser(user) });
  }
  if (path === "/payments" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT id,plan_name,amount,months,utr,status,note,created_at,decided_at,method,gateway_payment_id FROM payments WHERE user_id=? ORDER BY created_at DESC").bind(user.id).all();
    return json({ payments: results });
  }
  if (path === "/payments" && m === "POST") {
    const { form, data } = await readBody(req);
    const get = k => form ? form.get(k) : data[k];
    const plan = await env.DB.prepare("SELECT * FROM plans WHERE id=? AND active=1").bind(String(get("plan_id") || "")).first();
    if (!plan) return err(400, "Please choose a plan");
    const utr = clean(get("utr"), 40).replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z0-9]{10,30}$/.test(utr)) return err(400, "Enter the 12-digit UTR / UPI transaction ID from your payment app");
    if (!(await rateHit(env, "pay:u:" + user.id, 10, 60 * 60 * 1000))) return err(429, "Too many payment submissions. Please try again later.");
    // case-insensitive, so "abc123…" and "ABC123…" count as the same UTR
    if (await env.DB.prepare("SELECT 1 FROM payments WHERE upper(utr)=? AND status<>'rejected'").bind(utr).first()) return err(409, "This UTR has already been submitted");
    const pend = await env.DB.prepare("SELECT COUNT(*) n FROM payments WHERE user_id=? AND status='pending'").bind(user.id).first();
    if (pend.n >= 3) return err(429, "You already have pending requests. Please wait for the admin to verify them.");
    let proof = null; const f = form && form.get("screenshot");
    if (f && typeof f === "object" && f.size) { if (f.size > 8e6) return err(400, "Screenshot is too large (max 8 MB)"); const t = await sniffImage(f); if (!t) return err(400, "Screenshot must be a PNG, JPG, WEBP, GIF or HEIC image"); proof = await putFile(env, "proofs", f, t); }
    const id = uid("p_");
    try { await env.DB.prepare("INSERT INTO payments(id,user_id,plan_id,plan_name,amount,months,utr,proof_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)").bind(id, user.id, plan.id, plan.name, plan.price, plan.duration_months, utr, proof, Date.now()).run(); }
    catch (e) { if (proof) await fileStore(env).delete(proof); if (/UNIQUE/i.test(String(e && e.message))) return err(409, "This UTR has already been submitted"); throw e; }
    return json({ ok: true, id, status: "pending" });
  }

  // ---- admin ----
  if (!path.startsWith("/admin/")) return err(404, "Not found");
  if (!admin) return err(403, "Admin only");
  const A = path.replace(/^\/admin/, "");

  if (A === "/stats" && m === "GET") {
    const one = q => env.DB.prepare(q).first();
    const [docs, subs, users, prem, pend, rev] = await Promise.all([
      one("SELECT COUNT(*) n FROM documents"), one("SELECT COUNT(*) n FROM subjects"), one("SELECT COUNT(*) n FROM users WHERE role<>'admin'"),
      env.DB.prepare("SELECT COUNT(*) n FROM users WHERE premium_until>?").bind(Date.now()).first(), one("SELECT COUNT(*) n FROM payments WHERE status='pending'"),
      one("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='approved'")]);
    const missing = await one("SELECT COUNT(*) n FROM documents WHERE file_key IS NULL OR file_key=''");
    return json({ documents: docs.n, subjects: subs.n, students: users.n, premium: prem.n, pending: pend.n, revenue: rev.n, missing_files: missing.n, max_upload_mb: (() => { try { return Math.floor(fileStore(env).maxBytes / 1048576); } catch { return 0; } })() });
  }

  // documents
  if (A === "/documents" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM documents ORDER BY created_at DESC").all();
    const pr = (await env.DB.prepare("SELECT doc_id, part, file_name, file_key, (text_content IS NOT NULL AND length(text_content)>0) AS has_text FROM document_parts").all()).results || [];
    const byDoc = {}; for (const r of pr) (byDoc[r.doc_id] = byDoc[r.doc_id] || {})[r.part] = { has_file: !!r.file_key, has_text: !!r.has_text, file_name: r.file_name || "" };
    return json({ documents: results.map(d => ({ ...docOut(d), parts: byDoc[d.id] || {} })) });
  }
  // Phase 1: a document's Short / Important Topics + PYQs part gets one PDF or one block of text (never both)
  if ((mm = A.match(/^\/documents\/([\w-]+)\/parts\/(short|important)$/))) {
    const d = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(mm[1]).first(); if (!d) return err(404, "Document not found");
    const cur = await env.DB.prepare("SELECT * FROM document_parts WHERE doc_id=? AND part=?").bind(d.id, mm[2]).first();
    if (m === "DELETE" || m === "POST") {
      if (m === "DELETE") {
        if (cur && cur.file_key) await fileStore(env).delete(cur.file_key);
        await env.DB.prepare("DELETE FROM document_parts WHERE doc_id=? AND part=?").bind(d.id, mm[2]).run();
        await log(env, user.email, "part.clear", `${d.title} · ${mm[2]}`); return json({ ok: true, parts: await partsMeta(env, d.id, d) });
      }
      const { form, data } = await readBody(req);
      const get = k => form ? form.get(k) : data[k];
      const f = form && form.get("file");
      const now = Date.now();
      if (f && typeof f === "object" && f.size) {
        if (f.size > 95e6) return err(400, "File too large (max 95 MB)");
        if (!(await isPdf(f))) return err(400, "Only PDF files can be uploaded here");
        const key = await putFile(env, "parts", f, "application/pdf");
        if (cur && cur.file_key) await fileStore(env).delete(cur.file_key);
        await env.DB.prepare("INSERT OR REPLACE INTO document_parts(doc_id,part,file_key,file_name,file_size,text_content,updated_at) VALUES(?,?,?,?,?,NULL,?)").bind(d.id, mm[2], key, f.name, f.size, now).run();
        await log(env, user.email, "part.update", `${d.title} · ${mm[2]} · PDF ${f.name}`);
      } else if (get("text") !== undefined && get("text") !== null) {
        const text = String(get("text")).replace(/\r/g, "").trim().slice(0, 200000);
        if (cur && cur.file_key) await fileStore(env).delete(cur.file_key);
        if (!text) { await env.DB.prepare("DELETE FROM document_parts WHERE doc_id=? AND part=?").bind(d.id, mm[2]).run(); await log(env, user.email, "part.clear", `${d.title} · ${mm[2]}`); }
        else { await env.DB.prepare("INSERT OR REPLACE INTO document_parts(doc_id,part,file_key,file_name,file_size,text_content,updated_at) VALUES(?,?,NULL,NULL,NULL,?,?)").bind(d.id, mm[2], text, now).run(); await log(env, user.email, "part.update", `${d.title} · ${mm[2]} · text ${text.length} chars`); }
      } else return err(400, "Choose a PDF or paste text");
      return json({ ok: true, parts: await partsMeta(env, d.id, d) });
    }
  }
  if ((A === "/documents" && m === "POST") || ((mm = A.match(/^\/documents\/([\w-]+)$/)) && m === "POST")) {
    const { form, data } = await readBody(req);
    const get = k => form ? form.get(k) : data[k];
    const id = mm ? mm[1] : uid("d_");
    const ex = mm ? await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(id).first() : null;
    if (mm && !ex) return err(404, "Document not found");
    const title = clean(get("title"), 200); if (!title) return err(400, "Title is required");
    let file_key = ex ? ex.file_key : null, file_name = ex ? ex.file_name : null, file_size = ex ? ex.file_size : null, thumb_key = ex ? ex.thumb_key : null;
    const f = form && form.get("file");
    if (f && typeof f === "object" && f.size) { if (f.size > 95e6) return err(400, "File too large (max 95 MB)"); if (!(await isPdf(f))) return err(400, "Only PDF files can be uploaded as documents"); const oldKey = file_key; file_key = await putFile(env, "docs", f, "application/pdf"); if (oldKey) await fileStore(env).delete(oldKey); file_name = f.name; file_size = f.size; }
    const t = form && form.get("thumb");
    if (t && typeof t === "object" && t.size) { const tt = await sniffImage(t); if (!tt) return err(400, "Cover image must be a PNG, JPG, WEBP or GIF"); if (t.size > 8e6) return err(400, "Cover image is too large (max 8 MB)"); const oldThumb = thumb_key; thumb_key = await putFile(env, "thumbs", t, tt); if (oldThumb) await fileStore(env).delete(oldThumb); }
    let unit_id = clean(get("unit_id"), 60) || null;
    const subject_id = clean(get("subject_id"), 60) || null;
    const newUnit = clean(get("new_unit"), 80);
    if (newUnit && subject_id) { unit_id = uid("un_"); const mx = await env.DB.prepare("SELECT COALESCE(MAX(sort),0)+1 n FROM units WHERE subject_id=?").bind(subject_id).first(); await env.DB.prepare("INSERT INTO units(id,subject_id,name,sort) VALUES(?,?,?,?)").bind(unit_id, subject_id, newUnit, mx.n).run(); }
    const tags = clean(get("tags"), 300).split(",").map(s => s.trim()).filter(Boolean);
    const vals = [title, clean(get("description"), 1000), subject_id, unit_id, clean(get("category_id"), 60) || null, get("access_level") === "premium" ? "premium" : "free", (get("download_allowed") === "1" || get("download_allowed") === true || get("download_allowed") === "on") ? 1 : 0, file_key, file_name, file_size, thumb_key, JSON.stringify(tags), get("status") === "draft" ? "draft" : "published", Date.now()];
    if (ex) await env.DB.prepare("UPDATE documents SET title=?,description=?,subject_id=?,unit_id=?,category_id=?,access_level=?,download_allowed=?,file_key=?,file_name=?,file_size=?,thumb_key=?,tags=?,status=?,updated_at=? WHERE id=?").bind(...vals, id).run();
    else await env.DB.prepare("INSERT INTO documents(title,description,subject_id,unit_id,category_id,access_level,download_allowed,file_key,file_name,file_size,thumb_key,tags,status,updated_at,id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...vals, id, Date.now()).run();
    await log(env, user.email, ex ? "document.update" : "document.create", `${title} (${vals[5]})${f && f.size ? " + file " + f.name : ""}`);
    return json({ document: docOut(await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(id).first()) });
  }
  if ((mm = A.match(/^\/documents\/([\w-]+)$/)) && m === "DELETE") {
    const d = await env.DB.prepare("SELECT * FROM documents WHERE id=?").bind(mm[1]).first(); if (!d) return err(404, "Not found");
    if (d.file_key) await fileStore(env).delete(d.file_key); if (d.thumb_key) await fileStore(env).delete(d.thumb_key);
    for (const pr of (await env.DB.prepare("SELECT file_key FROM document_parts WHERE doc_id=?").bind(d.id).all()).results || []) if (pr.file_key) await fileStore(env).delete(pr.file_key);
    await env.DB.prepare("DELETE FROM document_parts WHERE doc_id=?").bind(d.id).run();
    await env.DB.prepare("DELETE FROM documents WHERE id=?").bind(d.id).run();
    await log(env, user.email, "document.delete", d.title); return json({ ok: true });
  }

  // simple tables: subjects, units, categories, plans
  const TABLES = {
    subjects: { cols: ["name","code","description","course","year","semester","icon","color","sort","visible","branch"], req: "name", prefix: "s_" },
    units: { cols: ["subject_id","name","sort"], req: "name", prefix: "un_" },
    categories: { cols: ["name","slug","icon","description","sort","visible"], req: "name", prefix: "c_" },
    plans: { cols: ["name","price","duration_months","features","popular","active","sort"], req: "name", prefix: "pl_" },
  };
  if ((mm = A.match(/^\/(subjects|units|categories|plans)(?:\/([\w-]+))?$/))) {
    const T = TABLES[mm[1]], table = mm[1], id = mm[2];
    if (m === "GET" && !id) { const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY sort`).all(); return json({ items: results }); }
    if (m === "DELETE" && id) {
      if (table === "subjects") { const n = await env.DB.prepare("SELECT COUNT(*) n FROM documents WHERE subject_id=?").bind(id).first(); if (n.n) return err(400, `Move or delete its ${n.n} document(s) first`); await env.DB.prepare("DELETE FROM units WHERE subject_id=?").bind(id).run(); }
      if (table === "units") await env.DB.prepare("UPDATE documents SET unit_id=NULL WHERE unit_id=?").bind(id).run();
      if (table === "categories") await env.DB.prepare("UPDATE documents SET category_id=NULL WHERE category_id=?").bind(id).run();
      await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run(); await log(env, user.email, table + ".delete", id); return json({ ok: true });
    }
    if (m === "POST") {
      const { data } = await readBody(req);
      if (!clean(data[T.req])) return err(400, T.req + " is required");
      const v = T.cols.map(c => {
        let x = data[c];
        if (c === "features") return JSON.stringify(Array.isArray(x) ? x : String(x || "").split("\n").map(s => s.trim()).filter(Boolean));
        if (["sort","price","duration_months"].includes(c)) return Math.max(0, parseInt(x, 10) || 0);
        if (["visible","active","popular"].includes(c)) return (x === undefined ? (c === "popular" ? 0 : 1) : (x === true || x === 1 || x === "1" || x === "on") ? 1 : 0);
        return clean(x, 1000);
      });
      if (table === "subjects") { const i = T.cols.indexOf("semester"), sem = normalizeSemester(v[i]); if (sem === null) return err(400, "Semester must be Semester 1 to Semester 8"); v[i] = sem;
        const bi = T.cols.indexOf("branch"); if (v[bi] && !BRANCHES.includes(v[bi])) return err(400, "Branch must be CS, AIML, DS, IoT, Mechanical or Civil"); v[bi] = v[bi] || null; }
      if (table === "plans" && (v[2] < 1 || v[1] < 1)) return err(400, "Price and months must be at least 1");
      if (table === "plans" && v[2] > MAX_PLAN_MONTHS) return err(400, `Duration can be at most ${MAX_PLAN_MONTHS} months`);
      if (id) await env.DB.prepare(`UPDATE ${table} SET ${T.cols.map(c => c + "=?").join(",")} WHERE id=?`).bind(...v, id).run();
      else await env.DB.prepare(`INSERT INTO ${table}(id,${T.cols.join(",")}) VALUES(?,${T.cols.map(() => "?").join(",")})`).bind(uid(T.prefix), ...v).run();
      await log(env, user.email, table + (id ? ".update" : ".create"), clean(data[T.req])); return json({ ok: true });
    }
  }

  // payments
  if (A === "/payments" && m === "GET") {
    const st = url.searchParams.get("status");
    const { results } = await env.DB.prepare(`SELECT p.*, COALESCE(u.name, '(removed)') user_name, COALESCE(u.email, p.user_email) user_email, u.phone user_phone, u.premium_until, (u.id IS NULL) user_removed FROM payments p LEFT JOIN users u ON u.id=p.user_id ${st ? "WHERE p.status=?" : ""} ORDER BY (p.status='pending') DESC, p.created_at DESC LIMIT 300`).bind(...(st ? [st] : [])).all();
    return json({ payments: results.map(r => ({ ...r, has_proof: !!r.proof_key, proof_key: undefined })) });
  }
  if ((mm = A.match(/^\/payments\/([\w-]+)\/proof$/)) && m === "GET") {
    const p = await env.DB.prepare("SELECT proof_key FROM payments WHERE id=?").bind(mm[1]).first();
    if (!p || !p.proof_key) return err(404, "No screenshot");
    const obj = await fileStore(env).get(p.proof_key); if (!obj) return err(404, "No screenshot");
    return fileResponse(obj.body, obj.httpMetadata?.contentType, { image: true, cache: "private, no-store" });
  }
  if ((mm = A.match(/^\/payments\/([\w-]+)\/(approve|reject)$/)) && m === "POST") {
    const { data } = await readBody(req);
    const p = await env.DB.prepare("SELECT * FROM payments WHERE id=?").bind(mm[1]).first(); if (!p) return err(404, "Not found");
    if (p.status !== "pending") return err(400, "Already " + p.status);
    if (mm[2] === "approve") {
      const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(p.user_id).first();
      const months = Math.max(1, parseInt(data.months, 10) || p.months || 1);
      if (months > MAX_PLAN_MONTHS) return err(400, `Months must be between 1 and ${MAX_PLAN_MONTHS}`);
      if (!u) return err(404, "This student no longer exists");
      // claim the payment first (only one approve can flip pending → approved), then add the time
      const claim = await env.DB.prepare("UPDATE payments SET status='approved', months=?, note=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'").bind(months, clean(data.note, 300), Date.now(), user.email, p.id).run();
      if (!claim.meta || claim.meta.changes !== 1) return err(400, "Already decided");
      const until = addMonths(Math.max(Date.now(), u.premium_until || 0), months);
      await env.DB.prepare("UPDATE users SET premium_until=?, plan_name=? WHERE id=?").bind(until, p.plan_name, u.id).run();
      await log(env, user.email, "payment.approve", `${u.email} · ${p.plan_name} ₹${p.amount} · UTR ${p.utr} · premium until ${new Date(until).toISOString().slice(0, 10)}`);
      return json({ ok: true, premium_until: until });
    }
    await env.DB.prepare("UPDATE payments SET status='rejected', note=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'").bind(clean(data.note, 300) || "Payment not found", Date.now(), user.email, p.id).run();
    await log(env, user.email, "payment.reject", `UTR ${p.utr}`); return json({ ok: true });
  }

  // users
  if (A === "/users" && m === "GET") {
    const q = clean(url.searchParams.get("q"), 100).toLowerCase();
    const { results } = await env.DB.prepare(`SELECT id,name,email,phone,role,premium_until,plan_name,created_at,email_verified,(google_sub IS NOT NULL) AS google,COALESCE(blocked,0) AS blocked,blocked_at FROM users ${q ? "WHERE lower(email) LIKE ? OR lower(name) LIKE ? OR phone LIKE ?" : ""} ORDER BY created_at DESC LIMIT 300`).bind(...(q ? ["%" + q + "%", "%" + q + "%", "%" + q + "%"] : [])).all();
    return json({ users: results });
  }
  if (A === "/users/bulk" && m === "POST") {
    // bulk Block / Unblock / Remove: admins and yourself are skipped, never touched
    const { data } = await readBody(req);
    const action = String(data.action || "");
    if (!["block", "unblock", "remove"].includes(action)) return err(400, "Unknown action");
    const ids = [...new Set((Array.isArray(data.ids) ? data.ids : []).map(String).filter(x => /^[\w-]{1,64}$/.test(x)))].slice(0, 200);
    if (!ids.length) return err(400, "Koi student select nahi kiya");
    let done = 0, skipped = 0;
    for (const id of ids) {
      const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
      if (!u || u.id === user.id || u.role === "admin") { skipped++; continue; }
      await adminUserAction(env, user, u, action); done++;
    }
    return json({ ok: true, done, skipped });
  }
  if (A === "/audit" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT actor_email,action,target_email,detail,created_at FROM admin_audit ORDER BY created_at DESC LIMIT 200").all();
    return json({ audit: results });
  }
  if ((mm = A.match(/^\/users\/([\w-]+)$/)) && m === "POST") {
    const { data } = await readBody(req);
    const u = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(mm[1]).first(); if (!u) return err(404, "Not found");
    let out = {};
    if (data.action === "grant") { const months = Math.max(1, parseInt(data.months, 10) || 1); if (months > MAX_PLAN_MONTHS) return err(400, `Months must be between 1 and ${MAX_PLAN_MONTHS}`); const until = addMonths(Math.max(Date.now(), u.premium_until || 0), months); await env.DB.prepare("UPDATE users SET premium_until=?, plan_name=? WHERE id=?").bind(until, clean(data.plan_name, 60) || "Manual", u.id).run(); out.premium_until = until; await log(env, user.email, "user.grant", `${u.email} +${months} month(s)`); }
    else if (data.action === "revoke") { await env.DB.prepare("UPDATE users SET premium_until=0 WHERE id=?").bind(u.id).run(); await log(env, user.email, "user.revoke", u.email); }
    else if (data.action === "reset_password") { const temp = randHex(4); const salt = randHex(16); await env.DB.prepare("UPDATE users SET pass_hash=?, salt=? WHERE id=?").bind(await hashPassword(temp, salt), salt, u.id).run(); await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id).run(); out.temp_password = temp; await log(env, user.email, "user.reset_password", u.email); }
    else if (data.action === "role") { if (u.id === user.id) return err(400, "You cannot change your own role"); const r = data.role === "admin" ? "admin" : "student"; await env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(r, u.id).run(); await log(env, user.email, "user.role", `${u.email} → ${r}`); }
    else if (["block", "unblock", "remove", "delete"].includes(data.action)) await adminUserAction(env, user, u, data.action === "delete" ? "remove" : data.action);
    else return err(400, "Unknown action");
    return json({ ok: true, ...out });
  }

  // settings
  if (A === "/razorpay/check" && m === "POST") {
    const rc = rzpConfig(env, await settingsMap(env));
    if (!rc.on) return err(400, "Add the Razorpay Key ID and Key Secret first, then Save");
    await rzpApi(rc, "GET", "/orders?count=1");
    return json({ ok: true, mode: rc.mode, webhook_ready: !!rc.webhookSecret });
  }
  if (A === "/settings" && m === "GET") return json({ settings: adminSettingsOut(env, await settingsMap(env)) });
  if (A === "/test-email" && m === "POST") {
    const { data } = await readBody(req);
    const cfg = await loadAuthConfig(env);
    if (!cfg.mail) return err(400, "Add a mail provider, API key and From address first, then save");
    const to = clean(data.to, 200).toLowerCase() || user.email;
    if (!emailOk(to)) return err(400, "Enter a valid email");
    if (!(await rateHit(env, "testmail:" + user.id, 10, 60 * 60 * 1000))) return err(429, "Too many test emails. Try again later.");
    await sendMail(cfg.mail, { to, ...codeEmail({ code: "123456", purpose: "verify", siteName: cfg.mail.siteName, origin: url.origin, name: user.name }), subject: `Test email from ${cfg.mail.siteName} — it works` });
    await log(env, user.email, "settings.test_email", to);
    return json({ ok: true, to });
  }
  if (A === "/settings" && m === "POST") {
    const { form, data } = await readBody(req);
    const st = [];
    const entries = form ? [...form.entries()] : Object.entries(data);
    for (const [k, v] of entries) {
      if (k === "upi_qr" && typeof v === "object") { if (v.size) { const qt = await sniffImage(v); if (!qt) return err(400, "QR must be a PNG, JPG, WEBP or GIF image"); if (v.size > 8e6) return err(400, "QR image is too large (max 8 MB)"); const key = await putFile(env, "public/qr", v, qt); st.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('upi_qr_key',?)").bind(key)); } continue; }
      if (k === "clear_qr" && v) { st.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('upi_qr_key','')")); continue; }
      if (k === "clear_mail_key" && v) { st.push(env.DB.prepare("DELETE FROM settings WHERE key='mail_api_key'")); continue; }
      if (k === "mail_api_key") { if (clean(v, 500)) st.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('mail_api_key',?)").bind(clean(v, 500))); continue; }
      if (k === "mail_provider" && !["", "resend", "brevo"].includes(String(v))) return err(400, "Mail provider must be Resend or Brevo");
      if (RZP_SECRET_SETTINGS.includes(k)) { const val = clean(v, 200); if (val) st.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").bind(k, val)); continue; }
      if (k === "clear_rzp" && v) { st.push(env.DB.prepare("DELETE FROM settings WHERE key IN ('rzp_key_id','rzp_key_secret','rzp_webhook_secret')")); continue; }
      if (k === "rzp_key_id" && clean(v, 100) && !RZP_KEY_RE.test(clean(v, 100))) return err(400, "Razorpay Key ID should look like rzp_test_XXXXXXXX or rzp_live_XXXXXXXX");
      if (k === "rzp_hide_manual") { st.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('rzp_hide_manual',?)").bind(v === "1" ? "1" : "0")); continue; }
      if (k === "google_site_verification") { const raw = clean(v, 500), code = googleVerifyCode(raw); if (raw && !code) return err(400, "Google verification code not recognised. Paste the content=\"...\" code from Search Console (HTML tag method)."); st.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('google_site_verification',?)").bind(code)); continue; }
      if (k === "google_client_id" && clean(v, 300) && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clean(v, 300))) return err(400, "Google Client ID should end with .apps.googleusercontent.com");
      if (!PUBLIC_SETTINGS.includes(k) && !ADMIN_AUTH_SETTINGS.includes(k) || k === "upi_qr_key") continue;
      st.push(env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").bind(k, clean(v, k === "privacy_text" || k === "terms_text" ? 40000 : 5000)));
    }
    if (st.length) await env.DB.batch(st);
    await log(env, user.email, "settings.update", entries.map(e => e[0]).join(", "));
    return json({ settings: adminSettingsOut(env, await settingsMap(env)) });
  }
  if (A === "/export" && m === "GET") {
    const out = { exported_at: new Date().toISOString() };
    for (const t of ["settings","categories","subjects","units","documents","plans","users","payments","logs","admin_audit"]) out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
    out.settings = out.settings.filter(r => !HIDDEN_SETTINGS.includes(r.key));
    out.users = out.users.map(({ pass_hash, salt, ...u }) => u); // password hashes never leave the database
    return json(out, 200, { "content-disposition": `attachment; filename="studyhpd-backup-${out.exported_at.slice(0, 10)}.json"` });
  }
  if (A === "/logs" && m === "GET") { const { results } = await env.DB.prepare("SELECT * FROM logs ORDER BY created_at DESC LIMIT 200").all(); return json({ logs: results }); }

  return err(404, "Not found");
}

export { studyFits, studyNeeded, normalizeSemester, rateHit, checkCode, sniffImage, isPdf, fileResponse, CSP, SECURITY_HEADERS, LOGIN_MAX_PER_EMAIL, rzpConfig, verifyCheckoutSignature, verifyWebhookSignature, activateRazorpayOrder, HIDDEN_SETTINGS, fileStore, verifyGoogleIdToken, resetGoogleKeyCache, authConfig, codeEmail, sendMail, parseFrom, HttpError, GOOGLE_JWKS_URL, seoPage, injectSeo, robotsTxt, sitemapXml, googleVerifyCode, ASSET_LINKS, ANDROID_PACKAGE, ANDROID_CERT_SHA256, serviceWorker };
// ---- Search engines (Google): per-page titles, canonical links, crawlable text, robots.txt, sitemap.xml ----
// Every public page gets its own <title>, description, canonical URL, share tags and JSON-LD in the raw HTML,
// plus a plain-HTML version of the page inside <main> (headings, text, links) that app.js replaces when it renders.
// Only names, titles and descriptions are used here: never a file key or a PDF link.
const SEO_STATIC_LASTMOD = "2026-10-31";
const GOOGLE_VERIFY_RE = /^[\w-]{10,100}$/;
// Admins may paste the code itself or the whole <meta ...> tag Google shows; keep only the code.
function googleVerifyCode(v) {
  let s = String(v == null ? "" : v).trim();
  const m = s.match(/content\s*=\s*["']?([\w-]+)/i); if (m) s = m[1];
  return GOOGLE_VERIFY_RE.test(s) ? s : "";
}
const xesc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ldJson = o => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const siteOrigin = (env, url) => { const s = String(env.SITE_URL || "").trim().replace(/\/+$/, ""); return /^https:\/\/[\w.-]+$/.test(s) ? s : url.origin; };
const PRIVATE_PAGES = /^\/(login(\/code)?|register|forgot-password|profile|admin(\/[\w-]+)?(\/[\w-]+)?)$/;
const ISBOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|lighthouse/i;

async function seoData(env) {
  await init(env);
  const [s, subs, units, docs, cats, plans] = await Promise.all([
    settingsMap(env),
    env.DB.prepare("SELECT id,name,code,description,course,year,semester FROM subjects WHERE visible=1 ORDER BY sort, name").all(),
    env.DB.prepare("SELECT id,subject_id,name,sort FROM units ORDER BY sort, name").all(),
    env.DB.prepare("SELECT id,title,description,subject_id,unit_id,category_id,access_level,created_at,updated_at FROM documents WHERE status='published' ORDER BY created_at DESC LIMIT 5000").all(),
    env.DB.prepare("SELECT id,name,slug FROM categories").all(),
    env.DB.prepare("SELECT name,price,duration_months,features FROM plans WHERE active=1 ORDER BY sort, price").all(),
  ]);
  const subjects = subs.results, sid = new Set(subjects.map(x => x.id));
  return { settings: s, subjects, units: units.results.filter(u => sid.has(u.subject_id)),
    docs: docs.results.filter(d => !d.subject_id || sid.has(d.subject_id)), categories: cats.results, plans: plans.results };
}
const docTime = d => Number(d.updated_at || d.created_at || 0);
const isoDay = t => t ? new Date(t).toISOString().slice(0, 10) : SEO_STATIC_LASTMOD;

// Works out which page a path is and builds everything search engines need for it.
function seoPage(p, data, origin) {
  const { settings, subjects, units, docs, categories, plans } = data;
  const brand = settings.site_name || "StudyHPD";
  const subj = id => subjects.find(x => x.id === id), unitOf = id => units.find(x => x.id === id), catOf = id => categories.find(x => x.id === id);
  const a = (href, text) => `<a href="${xesc(href)}">${xesc(text)}</a>`;
  const docLi = d => { const s = subj(d.subject_id), u = unitOf(d.unit_id);
    return `<li>${a(docPath(d), d.title)}${s ? " – " + xesc(s.name) : ""}${u ? " · " + xesc(u.name) : ""} <small>(${d.access_level === "free" ? "Free" : "Premium"})</small></li>`; };
  const subjLi = s => `<li>${a(subjectPath(s), s.name + " Notes")}${s.code ? " – " + xesc(s.code) : ""}${s.year ? " · " + xesc([s.course || "B.Tech", s.year].join(" ")) : ""}</li>`;
  const ul = items => items.length ? `<ul class="ssr-list">${items.join("")}</ul>` : "";
  let kind, m, ctx = { settings }, body = "", status = 200;
  if (p === "/") {
    kind = "home"; ctx.subjects = subjects;
    body = `<h1>${xesc(brand)} – ${xesc(settings.site_tagline || "B.Tech Notes, Important Questions & Study Material")}</h1>
<p>${xesc(settings.about_text || "")}</p>
<h2>B.Tech subjects</h2>${ul(subjects.map(subjLi))}
<h2>Latest notes</h2>${ul(docs.slice(0, 30).map(docLi))}
<p>${a("/about", "About " + brand)} · ${a("/contact", "Contact")}</p>`;
  } else if ((m = p.match(/^\/subject\/([\w-]+)$/)) && subj(m[1])) {
    const s = subj(m[1]), us = units.filter(u => u.subject_id === s.id), ds = docs.filter(d => d.subject_id === s.id);
    kind = "subject"; Object.assign(ctx, { subject: s, units: us, docs: ds });
    body = `<h1>${xesc(s.name)} Notes${s.code ? " (" + xesc(s.code) + ")" : ""}</h1>
<p>${xesc([s.course || "B.Tech", s.year, s.semester].filter(Boolean).join(" · "))}</p>${s.description ? `<p>${xesc(s.description)}</p>` : ""}
${us.length ? `<h2>Units</h2>${ul(us.map(u => `<li>${a(unitPath(u), s.name + " " + u.name + " notes")}</li>`))}` : ""}
<h2>${xesc(s.name)} notes and PDFs</h2>${ul(ds.map(docLi)) || "<p>No documents yet for this subject.</p>"}`;
  } else if ((m = p.match(/^\/subject\/([\w-]+)\/unit\/([\w-]+)$/)) && subj(m[1]) && unitOf(m[2]) && unitOf(m[2]).subject_id === m[1]) {
    const s = subj(m[1]), u = unitOf(m[2]), ds = docs.filter(d => d.unit_id === u.id);
    kind = "unit"; Object.assign(ctx, { subject: s, unit: u, docs: ds });
    body = `<h1>${xesc(s.name)} ${xesc(u.name)} Notes</h1>
<p>${xesc([s.code, s.course || "B.Tech", s.year, s.semester].filter(Boolean).join(" · "))}</p>
<h2>Notes and PDFs</h2>${ul(ds.map(docLi)) || "<p>No documents yet for this unit.</p>"}
<p>${a(subjectPath(s), "All " + s.name + " notes")}</p>`;
  } else if ((m = p.match(/^\/document\/([\w-]+)$/)) && docs.find(d => d.id === m[1])) {
    const d = docs.find(x => x.id === m[1]), s = subj(d.subject_id), u = unitOf(d.unit_id), c = catOf(d.category_id);
    kind = "document"; Object.assign(ctx, { doc: d, subject: s, unit: u && s && u.subject_id === s.id ? u : null, category: c });
    const more = docs.filter(x => x.id !== d.id && s && x.subject_id === s.id).slice(0, 10);
    body = `<h1>${xesc(d.title)}</h1>${d.description ? `<p>${xesc(d.description)}</p>` : ""}
<p>${[s && a(subjectPath(s), s.name), ctx.unit && a(unitPath(ctx.unit), ctx.unit.name), c && xesc(c.name), d.access_level === "free" ? "Free PDF" : "Premium PDF"].filter(Boolean).join(" · ")}</p>
<p>Log in with a free account to read this PDF.</p>
${more.length ? `<h2>More ${xesc(s.name)} notes</h2>${ul(more.map(docLi))}` : ""}`;
  } else if (p === "/about") {
    kind = "about";
    body = `<h1>About ${xesc(brand)}</h1><p>${xesc(settings.about_text || "")}</p>${String(settings.about_long || "").split(/\n\s*\n/).filter(x => x.trim()).map(x => `<p>${xesc(x)}</p>`).join("")}`;
  } else if (p === "/contact") {
    kind = "contact";
    body = `<h1>Contact Us</h1><p>Questions about a document or study material? Reach the ${xesc(brand)} team.</p>${settings.contact_email ? `<p>Email: ${xesc(settings.contact_email)}</p>` : ""}`;
  } else if ((m = p.match(/^\/(privacy|privacy-policy|terms|terms-of-service|terms-and-conditions)$/))) {
    kind = m[1].startsWith("privacy") ? "privacy" : "terms";
    body = `<h1>${kind === "privacy" ? "Privacy Policy" : "Terms of Service"}</h1><p>${xesc(brand)} – B.Tech notes and study material.</p>`;
  } else if (p === "/search") kind = "search";
  else if (PRIVATE_PAGES.test(p)) kind = "private";
  else if (/^\/(subject|document)\/[\w-]+(\/unit\/[\w-]+)?$/.test(p)) { kind = "notfound"; status = 404; } // unknown, hidden or draft item
  else { kind = "notfound"; status = 404; }

  const meta = pageMeta(kind, ctx);
  const canon = meta.path ? origin + meta.path : "";
  const img = origin + "/og.png";
  const gv = googleVerifyCode(settings.google_site_verification);
  const head = [
    `<title>${xesc(meta.title)}</title>`,
    `<meta name="description" content="${xesc(meta.description)}">`,
    `<meta name="robots" content="${meta.robots}">`,
    canon && `<link rel="canonical" href="${xesc(canon)}">`,
    `<meta property="og:type" content="${kind === "document" ? "article" : "website"}">`,
    `<meta property="og:site_name" content="${xesc(brand)}">`,
    `<meta property="og:title" content="${xesc(meta.title)}">`,
    `<meta property="og:description" content="${xesc(meta.description)}">`,
    canon && `<meta property="og:url" content="${xesc(canon)}">`,
    `<meta property="og:image" content="${xesc(img)}">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${xesc(brand)} – B.Tech Notes &amp; Study Material">`, `<meta property="og:locale" content="en_IN">`,
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:title" content="${xesc(meta.title)}">`,
    `<meta name="twitter:description" content="${xesc(meta.description)}">`, `<meta name="twitter:image" content="${xesc(img)}">`,
    gv && `<meta name="google-site-verification" content="${xesc(gv)}">`,
  ];
  const ld = [];
  if (kind === "home") {
    ld.push({ "@context": "https://schema.org", "@type": "Organization", "@id": origin + "/#organization", name: brand, url: origin + "/",
      logo: { "@type": "ImageObject", url: origin + "/img/icon-512.png", width: 512, height: 512 }, description: settings.about_text || undefined,
      ...(settings.contact_email ? { email: settings.contact_email } : {}) });
    ld.push({ "@context": "https://schema.org", "@type": "WebSite", "@id": origin + "/#website", name: brand, url: origin + "/",
      description: meta.description, inLanguage: "en-IN", publisher: { "@id": origin + "/#organization" } });
  }
  if (["subject", "unit", "document"].includes(kind) && meta.crumbs.length > 1)
    ld.push({ "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: meta.crumbs.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: origin + path })) });
  for (const o of ld) head.push(`<script type="application/ld+json">${ldJson(o)}</script>`);
  let main = "";
  if (body) {
    const crumbs = meta.crumbs.length > 1 ? `<nav class="crumb" aria-label="Breadcrumb">${meta.crumbs.map(([n, h], i) => i === meta.crumbs.length - 1 ? xesc(n) : a(h, n)).join(" › ")}</nav>` : "";
    main = `<div class="ssr">${crumbs}${body}</div>`;
  }
  return { kind, status, meta, head: head.filter(Boolean).join("\n"), main };
}
function injectSeo(html, page) {
  let out = html.replace(/<!--seo-->[\s\S]*?<!--\/seo-->/, () => "<!--seo-->\n" + page.head + "\n<!--/seo-->");
  if (page.main) out = out.replace(/<!--ssr-->[\s\S]*?<!--\/ssr-->/, () => "<!--ssr-->" + page.main + "<!--/ssr-->");
  return out;
}
async function shellHtml(req, env, url) {
  const h = new Headers(req.headers); h.delete("if-none-match"); h.delete("if-modified-since");
  return env.ASSETS.fetch(new Request(new URL("/", url), { headers: h }));
}
// HTML for an app page, with this page's meta and text in it. If anything goes wrong it falls back to the plain app shell.
async function htmlPage(req, env, url) {
  const res = await shellHtml(req, env, url);
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=utf-8"); headers.set("cache-control", "no-cache"); headers.delete("etag"); headers.delete("content-length");
  let html = await res.text(), status = 200;
  try {
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const page = seoPage(p, await seoData(env), siteOrigin(env, url));
    html = injectSeo(html, page); status = page.status;
    if (page.meta.robots !== "index, follow") headers.set("x-robots-tag", page.meta.robots);
  } catch (e) { console.error("seo page", url.pathname, e && e.stack || e); }
  return new Response(req.method === "HEAD" ? null : html, { status, headers });
}
function robotsTxt(origin) {
  return `# StudyHPD – public notes pages are open to search engines; accounts, admin and the API are not.
User-agent: *
Allow: /
Allow: /api/bootstrap
Allow: /api/documents
Allow: /api/thumb/
Allow: /api/media/public/
Disallow: /api/
Disallow: /admin
Disallow: /login
Disallow: /register
Disallow: /forgot-password
Disallow: /profile
Disallow: /my-subscription
Disallow: /purchases
Disallow: /search

Sitemap: ${origin}/sitemap.xml
`;
}
function sitemapXml(data, origin) {
  const { subjects, units, docs } = data;
  const latest = list => list.reduce((t, d) => Math.max(t, docTime(d)), 0);
  const all = latest(docs);
  const rows = [["/", isoDay(all), "daily", "1.0"]];
  for (const p of ["/about", "/contact", "/privacy", "/terms"]) rows.push([p, SEO_STATIC_LASTMOD, "monthly", "0.5"]);
  for (const s of subjects) {
    rows.push([subjectPath(s), isoDay(latest(docs.filter(d => d.subject_id === s.id)) || all), "weekly", "0.9"]);
    for (const u of units.filter(u => u.subject_id === s.id)) rows.push([unitPath(u), isoDay(latest(docs.filter(d => d.unit_id === u.id)) || all), "weekly", "0.8"]);
  }
  for (const d of docs) rows.push([docPath(d), isoDay(docTime(d)), "monthly", "0.7"]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map(([p, lm, cf, pr]) => `<url><loc>${xesc(origin + p)}</loc><lastmod>${lm}</lastmod><changefreq>${cf}</changefreq><priority>${pr}</priority></url>`).join("\n")}
</urlset>
`;
}
// ---- Android app (Trusted Web Activity) ----
// Digital Asset Links: lets the StudyHPD Android app (android/ folder) open this site full-screen with no URL bar.
// The fingerprint is the SHA-256 of the app's release signing key. If the app is ever uploaded to Google Play with
// "Play App Signing", ALSO add the "App signing key certificate" SHA-256 from Play Console -> Setup -> App signing.
const ANDROID_PACKAGE = "com.studyhpd.app";
const ANDROID_CERT_SHA256 = [
  "B3:3A:78:C8:42:81:0A:80:DC:B8:30:64:9F:95:82:3E:09:A8:A6:D8:8C:E0:E6:82:7B:23:3D:0F:E7:53:5F:B9",
];
const ASSET_LINKS = JSON.stringify([{
  relation: ["delegate_permission/common.handle_all_urls"],
  target: { namespace: "android_app", package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ANDROID_CERT_SHA256 },
}]);
// ---- security headers + request guard ----
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client https://checkout.razorpay.com https://*.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com/gsi/ https://*.razorpay.com",
  "frame-src https://accounts.google.com/gsi/ https://*.razorpay.com",
  "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(self \"https://checkout.razorpay.com\" \"https://api.razorpay.com\")",
  "cross-origin-opener-policy": "same-origin-allow-popups",
};
function secure(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v);
  if (/text\/html/i.test(h.get("content-type") || "") && !h.has("content-security-policy")) h.set("content-security-policy", CSP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
// The offline mode (service worker) was removed. Phones that installed it still ask for /sw.js; it is now a
// kill-switch that deletes every cache, unregisters itself and reloads open pages once. Never cached by the browser.
async function serviceWorker(req, env) {
  const r = await env.ASSETS.fetch(new Request(new URL("/sw.js", req.url)));
  if (!r.ok) return new Response("Not found", { status: 404 });
  return new Response(await r.text(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache, no-store, must-revalidate", "service-worker-allowed": "/" } });
}
// State-changing API calls must come from this site (the Razorpay webhook is server-to-server and signed).
function crossSite(req, url) {
  if (req.method === "GET" || req.method === "HEAD" || url.pathname === "/api/razorpay/webhook") return false;
  const origin = req.headers.get("origin");
  if (origin) { try { return new URL(origin).host !== url.host; } catch { return true; } } // "null" or junk → refuse
  return req.headers.get("sec-fetch-site") === "cross-site";
}
async function handle(req, env) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    try {
      if (crossSite(req, url)) return err(403, "Bad origin");
      await init(env);
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error("API error", req.method, url.pathname, e && e.stack || e); // details go to the Cloudflare logs only
      return err(500, "Something went wrong on our side. Please try again.");
    }
  }
  if (url.pathname === "/_worker.js" || url.pathname === "/tab-site.json") return new Response("Not found", { status: 404 });
  if (url.pathname === "/sw.js") return serviceWorker(req, env);
  if (url.pathname === "/.well-known/assetlinks.json") {
    return new Response(ASSET_LINKS, { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
  }
  if (url.pathname === "/robots.txt") return new Response(robotsTxt(siteOrigin(env, url)), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
  if (url.pathname === "/sitemap.xml") {
    try { return new Response(sitemapXml(await seoData(env), siteOrigin(env, url)), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=900" } }); }
    catch (e) { console.error("sitemap", e && e.stack || e); return new Response("Sitemap unavailable", { status: 503, headers: { "retry-after": "60" } }); }
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (url.pathname === "/index.html") return Response.redirect(new URL("/" + url.search, url).toString(), 301);
    return htmlPage(req, env, url);
  }
  const res = await env.ASSETS.fetch(req);
  // app pages (/document/…, /subject/…) are the SPA shell, with that page's title, description and text for search
  // engines. Conditional headers are dropped so a 304 for "/" can never become an empty 200 (a blank deep-link page).
  if (res.status === 404 && !/\.[a-z0-9]{2,5}$/i.test(url.pathname) && (req.method === "GET" || req.method === "HEAD")) return htmlPage(req, env, url);
  return res;
}
export default {
  async fetch(req, env) { return secure(await handle(req, env)); },
};
