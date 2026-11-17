// Tests for Google sign-in (ID token check with a mocked Google JWKS) and the email-code (OTP) flows.
// Runs the real worker against an in-memory SQLite stand-in for D1. Needs Node 22+ (node:sqlite).
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, createSign } from "node:crypto";

// ---- minimal D1 stand-in ----
function makeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => { if (/^\s*(CREATE|ALTER|PRAGMA)/i.test(sql) && !args.length) db.exec(sql); else { const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; } return { success: true, meta: { changes: 0 } }; },
  });
  return { _db: db, prepare: sql => stmt(sql), batch: async list => { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}

// ---- fake Google signing key + JWKS ----
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid-1", alg: "RS256", use: "sig" };
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const b64u = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
function makeIdToken(claims = {}, { kid = "test-kid-1", key = privateKey, alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-sub-1", email: "riya@gmail.com", email_verified: true, name: "Riya", iat: now, exp: now + 3600, ...claims };
  const head = b64u({ alg, kid, typ: "JWT" }) + "." + b64u(payload);
  const sig = createSign("RSA-SHA256").update(head).sign(key).toString("base64url");
  return head + "." + sig;
}

// ---- fetch mock: Google JWKS + mail providers ----
const sent = [];
let jwksFetches = 0, mailFails = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === "https://www.googleapis.com/oauth2/v3/certs") { jwksFetches++; return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "public, max-age=3600" } }); }
  if (url === "https://api.brevo.com/v3/smtp/email" || url === "https://api.resend.com/emails") {
    if (mailFails) return new Response(JSON.stringify({ message: "Key not found" }), { status: 401 });
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ messageId: "x" }), { status: 201 });
  }
  return realFetch(url, init);
};

const W = await import("../site/_worker.js");
const worker = W.default;
const ORIGIN = "https://studyhpd.example";
let env, ip = 1;
const assets = { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) };
function call(path, { method = "GET", body, cookie, ipAddr } = {}) {
  const headers = { "cf-connecting-ip": ipAddr || "10.0.0." + ip };
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") headers.origin = ORIGIN;
  return worker.fetch(new Request(ORIGIN + "/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
}
const cookieFrom = r => (r.headers.get("set-cookie") || "").split(";")[0];
const lastCode = () => { const m = sent.at(-1); const txt = m.body.textContent || m.body.text; return txt.match(/Your code: (\d{6})/)[1]; };

function freshEnv(extra = {}) { return { DB: makeD1(), FILES: {}, ASSETS: assets, EMAIL_MX_CHECK: "off", ...extra }; } // test emails use example.com (no mail server); the MX check has its own tests
const MAIL_ENV = { BREVO_API_KEY: "test-brevo-key", MAIL_FROM: "StudyHPD <studyhpd.notes@gmail.com>" };

beforeEach(() => { sent.length = 0; mailFails = false; ip++; });

// NOTE: init() runs once per module load, so all tests share one database (separate emails keep them apart).
before(() => { env = freshEnv(MAIL_ENV); });

test("without a mail key, signup works as before (no verification)", async () => {
  const env2 = freshEnv();
  const mod = await import("../site/_worker.js?nomail");
  const r = await mod.default.fetch(new Request(ORIGIN + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ name: "A", email: "plain@x.com", password: "secret1" }) }), env2);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.me.email, "plain@x.com"); assert.equal(d.me.email_verified, true);
  assert.ok(cookieFrom(r).startsWith("sid="));
  const boot = await (await mod.default.fetch(new Request(ORIGIN + "/api/bootstrap"), env2)).json();
  assert.deepEqual(boot.auth, { google_client_id: "", email_codes: false });
  assert.equal(sent.length, 0);
});

test("bootstrap advertises email codes and the Google client id when configured", async () => {
  env.GOOGLE_CLIENT_ID = CLIENT_ID;
  const boot = await (await call("/bootstrap")).json();
  assert.deepEqual(boot.auth, { google_client_id: CLIENT_ID, email_codes: true });
  delete env.GOOGLE_CLIENT_ID;
});

test("signup sends a branded 6-digit code; account stays unverified until it is entered", async () => {
  const r = await call("/auth/register", { method: "POST", body: { name: "Aman", email: "Aman@Example.com", password: "secret1" } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.verify, true); assert.equal(d.email, "aman@example.com"); assert.equal(d.cooldown, 60);
  assert.equal(r.headers.get("set-cookie"), null, "no session before verification");
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(m.headers["api-key"], "test-brevo-key");
  assert.deepEqual(m.body.sender, { name: "StudyHPD", email: "studyhpd.notes@gmail.com" });
  assert.match(m.body.subject, /^StudyHPD verification code: \d{6}$/);
  assert.ok(m.body.textContent && m.body.textContent.includes("Your code: "), "plain-text part is sent");
  assert.doesNotMatch(m.body.htmlContent, /<a\s|href=|<img/i, "no links or remote images in the code email");
  assert.match(m.body.htmlContent, /StudyHPD/); assert.match(m.body.htmlContent, /10 minutes/);
  const code = lastCode();
  // stored hashed, never in plain text
  const row = env.DB._db.prepare("SELECT * FROM email_codes WHERE email='aman@example.com'").get();
  assert.ok(row.code_hash && row.code_hash.length === 64 && !row.code_hash.includes(code));
  // password login is blocked until verified (and does not resend inside the cooldown)
  const l = await call("/auth/login", { method: "POST", body: { email: "aman@example.com", password: "secret1" } });
  assert.equal(l.status, 403); const ld = await l.json(); assert.equal(ld.verify_required, true); assert.equal(sent.length, 1);
  // correct code → verified + session
  const v = await call("/auth/verify", { method: "POST", body: { email: "aman@example.com", purpose: "verify", code } });
  assert.equal(v.status, 200); const vd = await v.json(); assert.equal(vd.me.email_verified, true);
  assert.ok(cookieFrom(v).startsWith("sid="));
  // code is single-use
  const again = await call("/auth/verify", { method: "POST", body: { email: "aman@example.com", purpose: "verify", code } });
  assert.equal(again.status, 400);
  // now password login works
  const ok = await call("/auth/login", { method: "POST", body: { email: "aman@example.com", password: "secret1" } });
  assert.equal(ok.status, 200);
});

test("wrong codes: max 5 tries, then the code is burned", async () => {
  await call("/auth/register", { method: "POST", body: { name: "B", email: "b@example.com", password: "secret1" } });
  const code = lastCode(); const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 4; i >= 1; i--) {
    const r = await call("/auth/verify", { method: "POST", body: { email: "b@example.com", purpose: "verify", code: wrong } });
    assert.equal(r.status, 400); assert.equal((await r.json()).tries_left, i);
  }
  const fifth = await call("/auth/verify", { method: "POST", body: { email: "b@example.com", purpose: "verify", code: wrong } });
  assert.equal(fifth.status, 429);
  const late = await call("/auth/verify", { method: "POST", body: { email: "b@example.com", purpose: "verify", code } });
  assert.equal(late.status, 400, "even the right code fails after 5 wrong tries");
  assert.equal((await late.json()).expired, true);
});

test("codes expire after 10 minutes", async () => {
  await call("/auth/register", { method: "POST", body: { name: "C", email: "c@example.com", password: "secret1" } });
  const code = lastCode();
  env.DB._db.prepare("UPDATE email_codes SET expires=? WHERE email='c@example.com'").run(Date.now() - 1);
  const r = await call("/auth/verify", { method: "POST", body: { email: "c@example.com", purpose: "verify", code } });
  assert.equal(r.status, 400); assert.equal((await r.json()).expired, true);
});

test("resend has a 60 s cooldown and a per-email hourly cap", async () => {
  await call("/auth/register", { method: "POST", body: { name: "D", email: "d@example.com", password: "secret1" } });
  const r1 = await call("/auth/code", { method: "POST", body: { email: "d@example.com", purpose: "verify" } });
  assert.equal(r1.status, 429); const d1 = await r1.json(); assert.ok(d1.retry_after > 0 && d1.retry_after <= 60);
  for (let i = 0; i < 4; i++) {
    env.DB._db.prepare("UPDATE email_codes SET sent_at=0 WHERE email='d@example.com'").run();
    const r = await call("/auth/code", { method: "POST", body: { email: "d@example.com", purpose: "verify" } });
    assert.equal(r.status, 200, "resend " + (i + 1));
  }
  env.DB._db.prepare("UPDATE email_codes SET sent_at=0 WHERE email='d@example.com'").run();
  const capped = await call("/auth/code", { method: "POST", body: { email: "d@example.com", purpose: "verify" } });
  assert.equal(capped.status, 429); assert.match((await capped.json()).error, /hour/);
  assert.equal(sent.length, 5);
});

test("per-IP limit on code requests", async () => {
  const myIp = "203.0.113.9";
  for (let i = 0; i < 20; i++) await call("/auth/register", { method: "POST", body: { name: "x", email: `ip${i}@example.com`, password: "secret1" }, ipAddr: myIp });
  const r = await call("/auth/register", { method: "POST", body: { name: "x", email: "ip99@example.com", password: "secret1" }, ipAddr: myIp });
  assert.equal(r.status, 429);
});

test("passwordless login with an email code", async () => {
  await call("/auth/register", { method: "POST", body: { name: "E", email: "e@example.com", password: "secret1" } });
  await call("/auth/verify", { method: "POST", body: { email: "e@example.com", purpose: "verify", code: lastCode() } });
  const s = await call("/auth/code", { method: "POST", body: { email: "e@example.com", purpose: "login" } });
  assert.equal(s.status, 200); assert.match(sent.at(-1).body.subject, /login code/);
  const v = await call("/auth/verify", { method: "POST", body: { email: "e@example.com", purpose: "login", code: lastCode() } });
  assert.equal(v.status, 200); assert.ok(cookieFrom(v).startsWith("sid="));
  const none = await call("/auth/code", { method: "POST", body: { email: "nobody@example.com", purpose: "login" } });
  assert.equal(none.status, 404);
});

test("password reset with an email code", async () => {
  await call("/auth/register", { method: "POST", body: { name: "F", email: "f@example.com", password: "oldpass1" } });
  await call("/auth/verify", { method: "POST", body: { email: "f@example.com", purpose: "verify", code: lastCode() } });
  await call("/auth/code", { method: "POST", body: { email: "f@example.com", purpose: "reset" } });
  const v = await call("/auth/verify", { method: "POST", body: { email: "f@example.com", purpose: "reset", code: lastCode(), password: "newpass1" } });
  assert.equal(v.status, 200);
  assert.equal((await call("/auth/login", { method: "POST", body: { email: "f@example.com", password: "oldpass1" } })).status, 401);
  assert.equal((await call("/auth/login", { method: "POST", body: { email: "f@example.com", password: "newpass1" } })).status, 200);
});

test("a failing mail provider gives a clear error and leaves no live code", async () => {
  mailFails = true;
  const r = await call("/auth/register", { method: "POST", body: { name: "G", email: "g@example.com", password: "secret1" } });
  assert.equal(r.status, 502); assert.match((await r.json()).error, /could not be sent/);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM email_codes WHERE email='g@example.com'").get().n, 0);
});

test("Resend provider is used when RESEND_API_KEY is set", async () => {
  const cfg = W.authConfig({ RESEND_API_KEY: "re_x", MAIL_FROM: "StudyHPD <noreply@studyhpd.tech>" }, {});
  assert.equal(cfg.mail.provider, "resend");
  await W.sendMail(cfg.mail, { to: "t@example.com", subject: "s", html: "<b>h</b>", text: "h" });
  const m = sent.at(-1); assert.equal(m.url, "https://api.resend.com/emails"); assert.equal(m.headers.authorization, "Bearer re_x");
  assert.equal(m.body.from, "StudyHPD <noreply@studyhpd.tech>");
  assert.equal(W.authConfig({}, { mail_provider: "brevo", mail_api_key: "k", mail_from: "a@gmail.com" }).mail.provider, "brevo");
  assert.equal(W.authConfig({ BREVO_API_KEY: "k" }, {}).mail, null, "no MAIL_FROM → email codes stay off");
});

// ---- Google ID token verification ----
test("Google token: a valid token is accepted", async () => {
  W.resetGoogleKeyCache();
  const p = await W.verifyGoogleIdToken(makeIdToken(), CLIENT_ID);
  assert.equal(p.email, "riya@gmail.com"); assert.equal(p.sub, "g-sub-1");
  await W.verifyGoogleIdToken(makeIdToken({ iss: "accounts.google.com" }), CLIENT_ID);
});
test("Google token: JWKS is cached", async () => {
  W.resetGoogleKeyCache(); const before = jwksFetches;
  await W.verifyGoogleIdToken(makeIdToken(), CLIENT_ID); await W.verifyGoogleIdToken(makeIdToken(), CLIENT_ID);
  assert.equal(jwksFetches - before, 1);
});
test("Google token: bad signature, wrong aud, wrong iss, expired, unverified email, unknown kid, bad alg are rejected", async () => {
  const cases = [
    [makeIdToken({}, { key: otherKey }), /signature/],
    [makeIdToken({ aud: "someone-else.apps.googleusercontent.com" }), /different app/],
    [makeIdToken({ iss: "https://evil.example.com" }), /issuer/],
    [makeIdToken({ exp: Math.floor(Date.now() / 1000) - 3600 }), /expired/],
    [makeIdToken({ email_verified: false }), /not verified/],
    [makeIdToken({}, { kid: "nope" }), /unknown key/],
    [makeIdToken({}, { alg: "none" }), /Invalid/],
    ["not.a.token", /Invalid/],
  ];
  for (const [tok, re] of cases) await assert.rejects(W.verifyGoogleIdToken(tok, CLIENT_ID), re);
  // tampered payload with the original signature
  const t = makeIdToken().split("."); t[1] = b64u({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "hacker", email: "admin@x.com", email_verified: true, exp: 9999999999 });
  await assert.rejects(W.verifyGoogleIdToken(t.join("."), CLIENT_ID), /signature/);
  await assert.rejects(W.verifyGoogleIdToken(makeIdToken(), ""), /not set up/);
});

test("Google sign-in creates a verified account, then links by email to an existing one", async () => {
  env.GOOGLE_CLIENT_ID = CLIENT_ID;
  const r = await call("/auth/google", { method: "POST", body: { credential: makeIdToken({ sub: "g-new", email: "Neha@Gmail.com", name: "Neha" }) } });
  assert.equal(r.status, 200); const d = await r.json();
  assert.equal(d.created, true); assert.equal(d.me.email, "neha@gmail.com"); assert.equal(d.me.email_verified, true); assert.equal(d.me.google, true);
  assert.ok(cookieFrom(r).startsWith("sid="));
  // same Google account again → same user
  const r2 = await call("/auth/google", { method: "POST", body: { credential: makeIdToken({ sub: "g-new", email: "neha@gmail.com" }) } });
  assert.equal((await r2.json()).me.id, d.me.id);
  // Google-only account cannot password-login
  assert.equal((await call("/auth/login", { method: "POST", body: { email: "neha@gmail.com", password: "" } })).status, 401);
  // link to existing verified password account (aman from earlier test)
  const r3 = await call("/auth/google", { method: "POST", body: { credential: makeIdToken({ sub: "g-aman", email: "aman@example.com" }) } });
  const d3 = await r3.json(); assert.equal(d3.created, false); assert.equal(d3.me.google, true); assert.equal(d3.me.has_password, true);
  // unverified squatter signup gets its password dropped when the real owner signs in with Google
  await call("/auth/register", { method: "POST", body: { name: "Squat", email: "owner@gmail.com", password: "squatter1" } });
  const r4 = await call("/auth/google", { method: "POST", body: { credential: makeIdToken({ sub: "g-owner", email: "owner@gmail.com" }) } });
  assert.equal(r4.status, 200);
  assert.equal((await call("/auth/login", { method: "POST", body: { email: "owner@gmail.com", password: "squatter1" } })).status, 401);
  // a forged token is refused by the endpoint
  const bad = await call("/auth/google", { method: "POST", body: { credential: makeIdToken({ sub: "x" }, { key: otherKey }) } });
  assert.equal(bad.status, 401);
  delete env.GOOGLE_CLIENT_ID;
  assert.equal((await call("/auth/google", { method: "POST", body: { credential: makeIdToken() } })).status, 400, "no client id → Google sign-in is off");
});

test("existing data keeps working: old users table gets new columns additively", async () => {
  const env3 = freshEnv();
  env3.DB._db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE NOT NULL, phone TEXT, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', premium_until INTEGER DEFAULT 0, plan_name TEXT, created_at INTEGER)");
  env3.DB._db.exec("INSERT INTO users(id,name,email,pass_hash,salt,role,premium_until) VALUES('u_old','Old','old@x.com','h','s','student'," + (Date.now() + 1e9) + ")");
  const mod = await import("../site/_worker.js?migrate");
  const r = await mod.default.fetch(new Request(ORIGIN + "/api/bootstrap"), env3);
  assert.equal(r.status, 200);
  const u = env3.DB._db.prepare("SELECT * FROM users WHERE id='u_old'").get();
  assert.equal(u.email_verified, 1, "existing users count as verified"); assert.equal(u.google_sub, null); assert.ok(u.premium_until > Date.now(), "premium kept");
});

test("admin settings never return the mail API key", async () => {
  const id = "u_admin";
  env.DB._db.prepare("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at) VALUES(?,?,?,?,?,'admin',?)").run(id, "Admin", "admin@example.com", "x", "y", Date.now());
  const tok = "a".repeat(64);
  const { createHash } = await import("node:crypto");
  env.DB._db.prepare("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)").run(createHash("sha256").update(tok).digest("hex"), id, Date.now() + 1e7);
  const cookie = "sid=" + tok;
  const save = await call("/admin/settings", { method: "POST", cookie, body: { mail_provider: "resend", mail_api_key: "re_SECRET_VALUE", mail_from: "x@y.com", google_client_id: CLIENT_ID } });
  assert.equal(save.status, 200);
  const txt = await (await call("/admin/settings", { cookie })).text();
  assert.ok(!txt.includes("re_SECRET_VALUE")); assert.match(txt, /"mail_api_key_set":true/);
  const exp = await (await call("/admin/export", { cookie })).text();
  assert.ok(!exp.includes("re_SECRET_VALUE") && !exp.includes("_code_pepper"));
  // env values win over dashboard values
  const boot = await (await call("/bootstrap")).json(); assert.equal(boot.auth.google_client_id, CLIENT_ID);
  const bad = await call("/admin/settings", { method: "POST", cookie, body: { google_client_id: "not-a-client-id" } });
  assert.equal(bad.status, 400);
  await call("/admin/settings", { method: "POST", cookie, body: { mail_provider: "", google_client_id: "", clear_mail_key: "1" } });
});

test("legal pages: admin can save custom Privacy/Terms text and it shows in bootstrap; empty falls back", async () => {
  const id = "u_admin_legal";
  env.DB._db.prepare("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at) VALUES(?,?,?,?,?,'admin',?)").run(id, "Admin", "legal-admin@example.com", "x", "y", Date.now());
  const tok = "b".repeat(64);
  const { createHash } = await import("node:crypto");
  env.DB._db.prepare("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)").run(createHash("sha256").update(tok).digest("hex"), id, Date.now() + 1e7);
  const cookie = "sid=" + tok;
  const long = "## Section\n" + "x".repeat(12000);
  const save = await call("/admin/settings", { method: "POST", cookie, body: { privacy_text: long, terms_text: "## Terms\nCustom terms." } });
  assert.equal(save.status, 200);
  let boot = await (await call("/bootstrap")).json();
  assert.equal(boot.settings.privacy_text, long, "long policy text is kept whole");
  assert.equal(boot.settings.terms_text, "## Terms\nCustom terms.");
  await call("/admin/settings", { method: "POST", cookie, body: { privacy_text: "", terms_text: "" } });
  boot = await (await call("/bootstrap")).json();
  assert.equal(boot.settings.privacy_text, ""); assert.equal(boot.settings.terms_text, "");
  // a student cannot change them
  const sid = "u_student_legal";
  env.DB._db.prepare("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at) VALUES(?,?,?,?,?,'student',?)").run(sid, "S", "legal-student@example.com", "x", "y", Date.now());
  const stok = "c".repeat(64);
  env.DB._db.prepare("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)").run(createHash("sha256").update(stok).digest("hex"), sid, Date.now() + 1e7);
  const no = await call("/admin/settings", { method: "POST", cookie: "sid=" + stok, body: { terms_text: "hacked" } });
  assert.ok(no.status === 401 || no.status === 403);
});
