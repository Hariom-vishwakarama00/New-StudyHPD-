// Security regression tests (audit 2026-10-31). Each block pins one fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

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
const files = new Map();
const FILES = {
  get: async k => files.has(k) ? { body: files.get(k).body, httpMetadata: { contentType: files.get(k).type } } : null,
  put: async (k, v, o) => { files.set(k, { body: await new Response(v).arrayBuffer(), type: o && o.httpMetadata && o.httpMetadata.contentType }); },
  delete: async k => files.delete(k),
};
const env = { EMAIL_MX_CHECK: "off", DB: makeD1(), FILES, ASSETS: { fetch: async () => new Response("<!doctype html><title>x</title>", { headers: { "content-type": "text/html" } }) } };
const mod = await import("../site/_worker.js");
const worker = mod.default;
const O = "https://studyhpd.example";
let ipN = 0;
const call = (p, { method = "GET", body, cookie, headers = {}, form, ip } = {}) => worker.fetch(new Request(O + "/api" + p, {
  method, body: form || (body ? JSON.stringify(body) : undefined),
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: O } : {}), "cf-connecting-ip": ip || "10.9.0." + (++ipN % 250), ...headers },
}), env);
const sql = (q, ...a) => env.DB._db.prepare(q).run(...a);
const one = (q, ...a) => env.DB._db.prepare(q).get(...a);
function session(id, role = "student", email = id + "@example.com") {
  sql("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at,email_verified) VALUES(?,?,?,?,?,?,0,1)", id, id, email, "x", "y", role);
  const tok = createHash("sha256").update(id).digest("hex");
  sql("INSERT INTO sessions VALUES(?,?,?)", createHash("sha256").update(tok).digest("hex"), id, Date.now() + 1e7);
  return "sid=" + tok;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"></svg>');
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

let student, student2, admin;
test("setup", async () => {
  await call("/bootstrap");
  student = session("u_s1"); student2 = session("u_s2"); admin = session("u_adm", "admin");
});

test("security headers on pages and API (CSP, frame-ancestors, nosniff, HSTS, Referrer-Policy)", async () => {
  const page = await worker.fetch(new Request(O + "/subject/x"), env);
  const csp = page.headers.get("content-security-policy") || "";
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /accounts\.google\.com\/gsi\/client/); assert.match(csp, /checkout\.razorpay\.com/);
  for (const r of [page, await call("/bootstrap")]) {
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("strict-transport-security") || "", /max-age=\d{7,}/);
    assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
  }
});

test("CSRF guard: foreign, 'null' and cross-site requests are refused with 403 (not a 500); the signed webhook is exempt", async () => {
  for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "not a url" }]) {
    const r = await call("/me", { method: "POST", cookie: student, body: { name: "x" }, headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  const r = await worker.fetch(new Request(O + "/api/me", { method: "POST", headers: { cookie: student, "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" }), env);
  assert.equal(r.status, 403);
  const wh = await worker.fetch(new Request(O + "/api/razorpay/webhook", { method: "POST", headers: { "sec-fetch-site": "cross-site", origin: "https://api.razorpay.com" }, body: "{}" }), env);
  assert.notEqual(wh.status, 403, "Razorpay can still reach the webhook (it is protected by its signature)");
});

test("unexpected errors don't leak internals", async () => {
  const bad = { ...env, DB: { prepare() { throw new Error("D1_ERROR: no such table: secret_internal_table"); }, batch() { throw new Error("x"); } } };
  const fresh = await import("../site/_worker.js?boom");
  const r = await fresh.default.fetch(new Request(O + "/api/bootstrap"), bad);
  assert.equal(r.status, 500);
  const t = await r.text();
  assert.doesNotMatch(t, /secret_internal_table|D1_ERROR|at \w+ \(/);
});

test("login: per-account brute-force limit, even across many IPs", async () => {
  const ok = { email: "victim@example.com", password: "right-password" };
  await call("/auth/register", { method: "POST", body: { name: "V", ...ok } });
  for (let i = 0; i < mod.LOGIN_MAX_PER_EMAIL - 1; i++) {
    const r = await call("/auth/login", { method: "POST", body: { email: ok.email, password: "guess" + i } });
    assert.equal(r.status, 401);
  }
  assert.equal((await call("/auth/login", { method: "POST", body: ok })).status, 200, "the real owner still gets in under the limit");
  const r = await call("/auth/login", { method: "POST", body: { email: ok.email, password: "guess-x" } });
  assert.equal(r.status, 429);
  assert.equal((await call("/auth/login", { method: "POST", body: { email: "other@example.com", password: "nope" } })).status, 401, "other accounts unaffected");
});

test("rate limiter is atomic: a parallel burst can't exceed the limit", async () => {
  const res = await Promise.all(Array.from({ length: 40 }, () => mod.rateHit(env, "burst:test", 5, 60000)));
  assert.equal(res.filter(Boolean).length, 5);
});

test("OTP: a try is counted before the compare, so 5 parallel wrong guesses burn the code", async () => {
  const req = new Request(O + "/x", { headers: { "cf-connecting-ip": "10.77.0.1" } });
  // plant a known code
  const pepper = (one("SELECT value FROM settings WHERE key='_code_pepper'") || {}).value;
  const crypto = await import("node:crypto");
  let pep = pepper; if (!pep) { pep = "p".repeat(64); sql("INSERT OR REPLACE INTO settings(key,value) VALUES('_code_pepper',?)", pep); }
  const h = crypto.createHmac("sha256", pep).update("login:otp@example.com:123456").digest("hex");
  sql("INSERT OR REPLACE INTO email_codes(email,purpose,code_hash,expires,tries,sent_at) VALUES(?,?,?,?,0,?)", "otp@example.com", "login", h, Date.now() + 6e5, Date.now());
  const guesses = await Promise.allSettled(["000001", "000002", "000003", "000004", "000005"].map(c => mod.checkCode(env, req, "otp@example.com", "login", c)));
  assert.ok(guesses.every(g => g.status === "rejected"));
  await assert.rejects(mod.checkCode(env, req, "otp@example.com", "login", "123456"), "the right code no longer works after 5 wrong tries");
});

test("payment screenshot: SVG/HTML disguised as images are refused; real images are stored by their bytes and served inert", async () => {
  const plan = one("SELECT id FROM plans ORDER BY price LIMIT 1");
  const send = (bytes, name, type, utr, cookie = student) => { const f = new FormData(); f.set("plan_id", plan.id); f.set("utr", utr); f.set("screenshot", new File([bytes], name, { type })); return call("/payments", { method: "POST", cookie, form: f }); };
  assert.equal((await send(SVG, "shot.png", "image/png", "SVGTEST000001")).status, 400);
  assert.equal((await send(SVG, "shot.svg", "image/svg+xml", "SVGTEST000002")).status, 400);
  assert.equal((await send(HTML, "shot.jpg", "image/jpeg", "SVGTEST000003")).status, 400);
  const ok = await send(PNG, "<img src=x onerror=alert(1)>.svg", "image/svg+xml", "PNGTEST000001");
  assert.equal(ok.status, 200);
  const { id } = await ok.json();
  const p = one("SELECT proof_key FROM payments WHERE id=?", id);
  assert.match(p.proof_key, /^proofs\/[0-9a-f]+\.png$/, "key uses the sniffed type, not the user's file name");
  const r = await call("/admin/payments/" + id + "/proof", { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.equal((await call("/admin/payments/" + id + "/proof", { cookie: student })).status, 403, "students can't see proofs");
});

test("stored files with an unsafe type are served as a download, never as a page", async () => {
  const r = mod.fileResponse("<script>alert(1)</script>", "text/html", { image: true, cache: "no-store" });
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.equal(r.headers.get("content-disposition"), "attachment");
  const s = mod.fileResponse("<svg/>", "image/svg+xml", { image: true, cache: "no-store" });
  assert.equal(s.headers.get("content-type"), "application/octet-stream");
});

test("documents: only real PDFs can be uploaded; draft files are hidden from students", async () => {
  const f = new FormData(); f.set("title", "Fake"); f.set("access_level", "free"); f.set("file", new File([HTML], "notes.pdf", { type: "application/pdf" }));
  assert.equal((await call("/admin/documents", { method: "POST", cookie: admin, form: f })).status, 400);
  const g = new FormData(); g.set("title", "Draft notes"); g.set("access_level", "free"); g.set("status", "draft"); g.set("file", new File(["%PDF-1.4 draft"], "d.pdf", { type: "application/pdf" }));
  const up = await call("/admin/documents", { method: "POST", cookie: admin, form: g });
  assert.equal(up.status, 200);
  const { document } = await up.json();
  assert.equal((await call("/file/" + document.id, { cookie: student })).status, 404, "draft is not readable by students");
  const a = await call("/file/" + document.id, { cookie: admin });
  assert.equal(a.status, 200); assert.equal(a.headers.get("content-type"), "application/pdf");
});

test("premium PDFs: locked for free and logged-out users, open for premium", async () => {
  const g = new FormData(); g.set("title", "Prem"); g.set("subject_id", "sub_chem"); g.set("access_level", "premium"); g.set("file", new File(["%PDF-1.4 prem"], "p.pdf", { type: "application/pdf" }));
  const { document } = await (await call("/admin/documents", { method: "POST", cookie: admin, form: g })).json();
  assert.equal((await call("/file/" + document.id)).status, 401);
  assert.equal((await call("/file/" + document.id, { cookie: student2 })).status, 403);
  assert.equal((await call("/file/" + document.id + "?dl=1", { cookie: student2 })).status, 403);
  sql("UPDATE users SET premium_until=? WHERE id='u_s2'", Date.now() + 864e5);
  sql("UPDATE users SET branch='CS', semester=1 WHERE id='u_s2'"); // the study rule: the seeded sub_chem is blank-branch Semester 1
  assert.equal((await call("/file/" + document.id, { cookie: student2 })).status, 200);
  sql("UPDATE users SET premium_until=0 WHERE id='u_s2'");
});

test("manual UTR can't be reused by another account (case-insensitive); a rejected UTR can be resubmitted", async () => {
  const plan = one("SELECT id FROM plans ORDER BY price LIMIT 1");
  const a = await call("/payments", { method: "POST", cookie: student, body: { plan_id: plan.id, utr: "abcd12345678" } });
  assert.equal(a.status, 200);
  assert.equal((await call("/payments", { method: "POST", cookie: student2, body: { plan_id: plan.id, utr: "ABCD12345678" } })).status, 409);
  // even if the pre-check is raced, the database index refuses a second live row
  assert.throws(() => sql("INSERT INTO payments(id,user_id,utr,status) VALUES('p_race','u_s2','abcd12345678','pending')"), /UNIQUE/);
  const { id } = await a.json();
  assert.equal((await call("/admin/payments/" + id + "/reject", { method: "POST", cookie: admin, body: {} })).status, 200);
  assert.equal((await call("/payments", { method: "POST", cookie: student2, body: { plan_id: plan.id, utr: "ABCD12345678" } })).status, 200);
});

test("approving the same payment twice adds the time only once", async () => {
  sql("UPDATE payments SET status='rejected' WHERE status='pending'");
  const plan = one("SELECT id FROM plans ORDER BY price LIMIT 1");
  const s3 = session("u_s3");
  const { id } = await (await call("/payments", { method: "POST", cookie: s3, body: { plan_id: plan.id, utr: "DOUBLE000001" } })).json();
  const [r1, r2] = await Promise.all([1, 2].map(() => call("/admin/payments/" + id + "/approve", { method: "POST", cookie: admin, body: {} })));
  assert.deepEqual([r1.status, r2.status].sort(), [200, 400]);
  const u = one("SELECT premium_until FROM users WHERE id='u_s3'");
  const months = one("SELECT months FROM payments WHERE id=?", id).months;
  const expect = new Date(); expect.setUTCMonth(expect.getUTCMonth() + months);
  assert.ok(Math.abs(u.premium_until - expect.getTime()) < 60000, "extended by one plan, not two");
});

test("students can't reach admin routes, promote themselves, or change other users", async () => {
  for (const [p, method] of [["/admin/stats", "GET"], ["/admin/users", "GET"], ["/admin/export", "GET"], ["/admin/settings", "GET"], ["/admin/payments", "GET"], ["/admin/logs", "GET"], ["/admin/users/u_s2", "POST"], ["/admin/settings", "POST"], ["/admin/documents", "POST"], ["/admin/plans", "POST"]]) {
    const r = await call(p, { method, cookie: student, body: method === "POST" ? { action: "role", role: "admin", name: "x" } : undefined });
    assert.equal(r.status, 403, p);
  }
  await call("/me", { method: "POST", cookie: student, body: { name: "S", role: "admin", premium_until: 9e12, email: "hijack@example.com", id: "u_adm" } });
  const me = one("SELECT role, premium_until, email FROM users WHERE id='u_s1'");
  assert.equal(me.role, "student"); assert.equal(me.premium_until || 0, 0); assert.equal(me.email, "u_s1@example.com");
  assert.equal((await call("/admin/setup", { method: "POST", body: { token: "", email: "x@example.com", password: "12345678" } })).status, 403, "setup is closed without a SETUP_TOKEN");
});

test("admin export carries no password hashes and no secrets", async () => {
  sql("INSERT OR REPLACE INTO settings(key,value) VALUES('rzp_key_secret','SECRET_RZP'),('mail_api_key','SECRET_MAIL'),('rzp_webhook_secret','SECRET_WH')");
  const r = await call("/admin/export", { cookie: admin });
  const t = await r.text();
  assert.doesNotMatch(t, /pass_hash|"salt"|SECRET_RZP|SECRET_MAIL|SECRET_WH|_code_pepper/);
  const s = await (await call("/admin/settings", { cookie: admin })).text();
  assert.doesNotMatch(s, /SECRET_RZP|SECRET_MAIL|SECRET_WH|_code_pepper/);
  const b = await (await call("/bootstrap")).text();
  assert.doesNotMatch(b, /SECRET_|_code_pepper|pass_hash/);
});

test("change password: current-password guessing is rate limited", async () => {
  const s4 = session("u_s4");
  let last;
  for (let i = 0; i < 11; i++) last = await call("/me/password", { method: "POST", cookie: s4, body: { current: "wrong" + i, password: "newpassword" } });
  assert.equal(last.status, 429);
});

test("static files get the same headers (site/_headers stays in sync with the worker)", async () => {
  const fs = await import("node:fs");
  const h = fs.readFileSync(new URL("../site/_headers", import.meta.url), "utf8");
  assert.ok(h.includes("Content-Security-Policy: " + mod.CSP));
  for (const v of Object.values(mod.SECURITY_HEADERS)) assert.ok(h.includes(": " + v), v);
});
