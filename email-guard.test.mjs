// Temp-mail block at signup (2026-11-01) + the view-only PDF link guard.
// Runs the real worker against an in-memory SQLite stand-in for D1. Needs Node 22+ (node:sqlite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { disposableReason, isDisposableDomain, mxStatus, checkSignupEmail, emailDomain, TEMP_MAIL_MSG } from "../site/email-guard.js";

function makeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => { if (/^\s*(CREATE|ALTER|PRAGMA)/i.test(sql) && !args.length) { db.exec(sql); return { success: true, meta: { changes: 0 } }; } const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
  });
  return { _db: db, prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}

// ---- DNS-over-HTTPS mock: answers by domain; anything else -> real fetch is never reached ----
const DNS = {
  "gmail.com": { Status: 0, Answer: [{ type: 15, data: "5 gmail-smtp-in.l.google.com." }] },
  "ietdavv.edu.in": { Status: 0, Answer: [{ type: 15, data: "1 aspmx.l.google.com." }] },
  "no-such-domain-xyz123.com": { Status: 3 },
  "nomx.example.org": { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] },
  "nullmx.example.org": { Status: 0, Answer: [{ type: 15, data: "0 ." }] },
  "cname.example.org": { Status: 0, Answer: [{ type: 5, data: "mail.other.org." }, { type: 15, data: "10 mx.other.org." }] },
};
let dohCalls = 0, dohDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
    dohCalls++;
    if (dohDown) throw new TypeError("network down");
    const name = new URL(url).searchParams.get("name");
    assert.equal(new URL(url).searchParams.get("type"), "MX");
    return new Response(JSON.stringify(DNS[name] || { Status: 2 }), { headers: { "content-type": "application/dns-json" } });
  }
  if (url === "https://api.brevo.com/v3/smtp/email") return new Response(JSON.stringify({ messageId: "x" }), { status: 201 });
  return realFetch(url, init);
};

test("the bundled list blocks well-known temp-mail services (and their subdomains)", () => {
  for (const d of ["mailinator.com", "yopmail.com", "10minutemail.com", "guerrillamail.com", "temp-mail.org", "sharklasers.com", "dispostable.com", "trashmail.com", "inbox.mailinator.com"])
    assert.equal(disposableReason(d), "list", d);
  assert.equal(emailDomain("Test@Mailinator.COM"), "mailinator.com");
});
test("name patterns catch new domains of the same services", () => {
  for (const d of ["my-tempmail.xyz", "best10minutemail.net", "yopmail.example", "guerrillamail.biz", "temp-mail.io"]) assert.ok(isDisposableDomain(d), d);
});
test("real providers and college domains are never on the list", () => {
  for (const d of ["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "outlook.com", "hotmail.com", "icloud.com", "rediffmail.com", "proton.me", "protonmail.com", "zoho.com", "ietdavv.edu.in", "iitb.ac.in", "studyhpd.tech"])
    assert.equal(disposableReason(d), null, d);
});

test("MX lookup: missing domain, no MX, null MX are refused; a real mail server passes; DNS errors fail open", async () => {
  assert.equal(await mxStatus("no-such-domain-xyz123.com"), "nxdomain");
  assert.equal(await mxStatus("nomx.example.org"), "no_mx");
  assert.equal(await mxStatus("nullmx.example.org"), "null_mx");
  assert.equal(await mxStatus("cname.example.org"), "ok");
  assert.equal(await mxStatus("ietdavv.edu.in"), "ok");
  assert.equal(await mxStatus("servfail.example.org"), "unknown", "SERVFAIL is not a reason to block");
  dohDown = true;
  try { assert.equal(await mxStatus("down-" + Date.now() + ".example.org"), "unknown"); } finally { dohDown = false; }
  const before = dohCalls; await mxStatus("ietdavv.edu.in"); assert.equal(dohCalls, before, "answers are cached");
});

test("checkSignupEmail: list first, then MX; big providers skip the DNS lookup; the switch turns MX off", async () => {
  let r = await checkSignupEmail("test@mailinator.com", {});
  assert.equal(r.ok, false); assert.equal(r.reason, "list"); assert.equal(r.message, TEMP_MAIL_MSG);
  const before = dohCalls;
  assert.equal((await checkSignupEmail("riya@gmail.com", {})).ok, true);
  assert.equal(dohCalls, before, "gmail.com never needs a DNS lookup");
  r = await checkSignupEmail("a@no-such-domain-xyz123.com", {}); assert.equal(r.ok, false); assert.equal(r.reason, "nxdomain"); assert.match(r.message, /asli Gmail ya college email/);
  assert.equal((await checkSignupEmail("a@no-such-domain-xyz123.com", { EMAIL_MX_CHECK: "off" })).ok, true);
  assert.equal((await checkSignupEmail("a@mailinator.com", { EMAIL_MX_CHECK: "off" })).ok, false, "the list still applies with MX off");
});

// ---- through the real worker ----
const files = new Map();
const FILES = { get: async k => files.has(k) ? { body: files.get(k), httpMetadata: { contentType: "application/pdf" } } : null, put: async () => {}, delete: async () => {} };
const env = { DB: makeD1(), FILES, ASSETS: { fetch: async () => new Response("<!doctype html><title>x</title>", { headers: { "content-type": "text/html" } }) } };
const worker = (await import("../site/_worker.js")).default;
const O = "https://studyhpd.example";
let ipN = 0;
const call = (p, { method = "GET", body, cookie, headers = {} } = {}) => worker.fetch(new Request(O + "/api" + p, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: O } : {}), "cf-connecting-ip": "10.7.0." + (++ipN % 250), ...headers },
}), env);
const sql = (q, ...a) => env.DB._db.prepare(q).run(...a);
const one = (q, ...a) => env.DB._db.prepare(q).get(...a);
function session(id, role = "student", email = id + "@gmail.com") {
  sql("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at,email_verified) VALUES(?,?,?,?,?,?,0,1)", id, id, email, "x", "y", role);
  const tok = createHash("sha256").update(id).digest("hex");
  sql("INSERT INTO sessions VALUES(?,?,?)", createHash("sha256").update(tok).digest("hex"), id, Date.now() + 1e7);
  return "sid=" + tok;
}

test("register refuses temp-mail with the Hinglish message and creates nothing", async () => {
  await call("/bootstrap");
  for (const email of ["test@mailinator.com", "abc@yopmail.com", "x@10minutemail.com", "y@guerrillamail.com", "z@temp-mail.org", "q@sub.mailinator.com"]) {
    const r = await call("/auth/register", { method: "POST", body: { name: "T", email, password: "secret123" } });
    assert.equal(r.status, 400, email);
    const j = await r.json(); assert.equal(j.error, TEMP_MAIL_MSG); assert.ok(j.email_blocked);
    assert.equal(one("SELECT COUNT(*) n FROM users WHERE email=?", email).n, 0);
  }
});
test("register refuses a domain that doesn't exist or takes no mail", async () => {
  for (const email of ["a@no-such-domain-xyz123.com", "b@nomx.example.org", "c@nullmx.example.org"]) {
    const r = await call("/auth/register", { method: "POST", body: { name: "T", email, password: "secret123" } });
    assert.equal(r.status, 400, email); assert.ok((await r.json()).email_blocked);
  }
});
test("a real Gmail / college address still registers", async () => {
  let r = await call("/auth/register", { method: "POST", body: { name: "Riya", email: "riya.k@gmail.com", password: "secret123" } });
  assert.equal(r.status, 200); assert.equal((await r.json()).me.email, "riya.k@gmail.com");
  r = await call("/auth/register", { method: "POST", body: { name: "Aman", email: "aman@ietdavv.edu.in", password: "secret123" } });
  assert.equal(r.status, 200);
});
test("existing accounts on a temp-mail domain are untouched and can still log in", async () => {
  const salt = "s".repeat(32);
  const { webcrypto } = await import("node:crypto");
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode("oldpass1"), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  const ph = Buffer.from(bits).toString("hex");
  sql("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at,email_verified) VALUES('u_old','Old','old@mailinator.com',?,?,'student',1,1)", ph, salt);
  const r = await call("/auth/login", { method: "POST", body: { email: "old@mailinator.com", password: "oldpass1" } });
  assert.equal(r.status, 200);
  const again = await call("/auth/register", { method: "POST", body: { name: "Old", email: "old@mailinator.com", password: "whatever1" } });
  assert.equal(again.status, 409, "an existing account still hears 'already exists, log in'");
});
test("/auth/email-check gives the same answer for instant form feedback", async () => {
  let j = await (await call("/auth/email-check", { method: "POST", body: { email: "test@mailinator.com" } })).json();
  assert.equal(j.ok, false); assert.equal(j.error, TEMP_MAIL_MSG);
  j = await (await call("/auth/email-check", { method: "POST", body: { email: "someone@gmail.com" } })).json();
  assert.equal(j.ok, true);
  j = await (await call("/auth/email-check", { method: "POST", body: { email: "nope" } })).json();
  assert.equal(j.ok, false);
  assert.equal(one("SELECT COUNT(*) n FROM users WHERE email='someone@gmail.com'").n, 0, "the check creates no account");
});

test("view-only PDF: opening the file link directly goes to the viewer page; the viewer's own fetch still works", async () => {
  sql("INSERT INTO documents(id,title,subject_id,access_level,download_allowed,file_key,file_name,status,created_at) VALUES('d_view','View only','sub_chem','free',0,'docs/v.pdf','v.pdf','published',1)");
  sql("INSERT INTO documents(id,title,subject_id,access_level,download_allowed,file_key,file_name,status,created_at) VALUES('d_dl','Downloadable','sub_chem','free',1,'docs/d.pdf','d.pdf','published',1)");
  files.set("docs/v.pdf", new TextEncoder().encode("%PDF-1.4 view")); files.set("docs/d.pdf", new TextEncoder().encode("%PDF-1.4 dl"));
  const s = session("u_reader"), adm = session("u_admin2", "admin");
  sql("UPDATE users SET branch='CS', semester=1 WHERE id='u_reader'"); // the study rule: a student reads notes of their own branch and semester
  let r = await call("/file/d_view", { cookie: s, headers: { "sec-fetch-dest": "document" } });
  assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/document/d_view");
  for (const dest of ["iframe", "embed", "object"]) assert.equal((await call("/file/d_view", { cookie: s, headers: { "sec-fetch-dest": dest } })).status, 302, dest);
  r = await call("/file/d_view", { cookie: s, headers: { "sec-fetch-dest": "empty" } });
  assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition"), /^inline/);
  assert.equal((await call("/file/d_view?dl=1", { cookie: s, headers: { "sec-fetch-dest": "document" } })).status, 302, "dl=1 doesn't bypass it");
  assert.equal((await call("/file/d_dl?dl=1", { cookie: s, headers: { "sec-fetch-dest": "document" } })).status, 200, "download-allowed docs download as before");
  assert.equal((await call("/file/d_view", { cookie: adm, headers: { "sec-fetch-dest": "document" } })).status, 200, "admin can open any file");
  assert.equal((await call("/file/d_view", { headers: { "sec-fetch-dest": "document" } })).status, 401, "still needs login");
});

test("the viewer ships its deterrents (no watermark): blur shield, no print", async () => {
  const fs = await import("node:fs");
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../site/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(app, /stampCanvas|wmText|wm-note|Licensed to/, "the visible watermark is removed (owner request 1 Nov 2026)");
  assert.doesNotMatch(css, /wm-note/);
  for (const ev of ["contextmenu", "dragstart", "selectstart", "visibilitychange", "beforeprint", "printscreen"]) assert.ok(app.toLowerCase().includes(ev), ev);
  assert.match(css, /body\.shielded \.pdfpages canvas\{filter:blur/);
  assert.match(css, /@media print\{[^}]*\.pdfpages/);
  assert.match(app, /TEMP_MAIL_MSG = "Temporary\/fake email allowed nahi hai/);
});
