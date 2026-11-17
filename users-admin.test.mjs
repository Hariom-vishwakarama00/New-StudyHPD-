// Admin: Block / Unblock / Remove students (2026-11-01). Block refuses every login path, Remove deletes the
// account but keeps payment records with an email snapshot, admins (and yourself) can't be touched, all actions audited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync, createSign } from "node:crypto";

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

// fake Google key + mail provider
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const b64u = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
function idToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: "RS256", kid: "k1", typ: "JWT" }) + "." + b64u({ iss: "https://accounts.google.com", aud: CLIENT_ID, email_verified: true, iat: now, exp: now + 3600, ...claims });
  return head + "." + createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url");
}
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === "https://www.googleapis.com/oauth2/v3/certs") return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "public, max-age=3600" } });
  if (url === "https://api.brevo.com/v3/smtp/email") { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 201 }); }
  return realFetch(url, init);
};

const env = { EMAIL_MX_CHECK: "off", DB: makeD1(), FILES: {}, GOOGLE_CLIENT_ID: CLIENT_ID, BREVO_API_KEY: "k", MAIL_FROM: "StudyHPD <a@gmail.com>",
  ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) } };
const worker = (await import("../site/_worker.js?users-admin")).default;
const O = "https://studyhpd.example";
let ipN = 0;
const call = (p, { method = "GET", body, cookie, headers = {} } = {}) => worker.fetch(new Request(O + "/api" + p, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: O } : {}), "cf-connecting-ip": "10.7.0." + (++ipN % 250), ...headers },
}), env);
const sql = (q, ...a) => env.DB._db.prepare(q).run(...a);
const one = (q, ...a) => env.DB._db.prepare(q).get(...a);
const cookieFrom = r => (r.headers.get("set-cookie") || "").split(";")[0];
function session(id, role = "student", email = id + "@example.com") {
  if (!one("SELECT 1 FROM users WHERE id=?", id)) sql("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at,email_verified) VALUES(?,?,?,?,?,?,0,1)", id, id, email, "x", "y", role);
  const tok = createHash("sha256").update(id + Math.random()).digest("hex");
  sql("INSERT INTO sessions VALUES(?,?,?)", createHash("sha256").update(tok).digest("hex"), id, Date.now() + 1e7);
  return "sid=" + tok;
}
const BLOCK = "Aapka account block hai. Admin se contact karo.";
const act = (id, action, cookie) => call("/admin/users/" + id, { method: "POST", cookie, body: { action } });

let admin, admin2, student;
test("setup: schema has the blocked column and the audit table", async () => {
  await call("/bootstrap");
  admin = session("u_adm", "admin"); admin2 = session("u_adm2", "admin"); student = session("u_st");
  const cols = env.DB._db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  assert.ok(cols.includes("blocked") && cols.includes("blocked_at"));
  assert.ok(env.DB._db.prepare("PRAGMA table_info(payments)").all().some(c => c.name === "user_email"));
  assert.ok(env.DB._db.prepare("PRAGMA table_info(rzp_orders)").all().some(c => c.name === "user_email"));
  assert.ok(one("SELECT name FROM sqlite_master WHERE name='admin_audit'"));
});

test("block: every login path refused with the Hinglish message, sessions killed; unblock restores", async () => {
  // a real password account
  const reg = await call("/auth/register", { method: "POST", body: { name: "Blk", email: "blk@example.com", password: "secret1" } });
  const u = one("SELECT * FROM users WHERE email='blk@example.com'");
  assert.ok(u, "registered " + reg.status);
  sql("UPDATE users SET email_verified=1, google_sub='g-blk' WHERE id=?", u.id);
  const sess = session(u.id);
  assert.equal((await call("/me", { cookie: sess })).status, 200);

  assert.equal((await act(u.id, "block", admin)).status, 200);
  assert.equal(one("SELECT blocked FROM users WHERE id=?", u.id).blocked, 1);
  assert.equal(one("SELECT COUNT(*) n FROM sessions WHERE user_id=?", u.id).n, 0, "existing sessions are killed");
  assert.equal((await call("/me", { cookie: sess })).status, 401);
  // a session row that somehow survived is still refused
  const sneaky = session(u.id);
  assert.equal((await call("/me", { cookie: sneaky })).status, 401);
  sql("DELETE FROM sessions WHERE user_id=?", u.id);

  const pw = await call("/auth/login", { method: "POST", body: { email: "blk@example.com", password: "secret1" } });
  assert.equal(pw.status, 403); assert.equal((await pw.json()).error, BLOCK); assert.equal(pw.headers.get("set-cookie"), null);
  sent.length = 0;
  const code = await call("/auth/code", { method: "POST", body: { email: "blk@example.com", purpose: "login" } });
  assert.equal(code.status, 403); assert.equal((await code.json()).error, BLOCK); assert.equal(sent.length, 0, "no code is emailed");
  const ver = await call("/auth/verify", { method: "POST", body: { email: "blk@example.com", purpose: "login", code: "123456" } });
  assert.equal(ver.status, 403); assert.equal((await ver.json()).error, BLOCK);
  const g = await call("/auth/google", { method: "POST", body: { credential: idToken({ sub: "g-blk", email: "blk@example.com" }) } });
  assert.equal(g.status, 403); assert.equal((await g.json()).error, BLOCK); assert.equal(g.headers.get("set-cookie"), null);
  const re = await call("/auth/register", { method: "POST", body: { email: "blk@example.com", password: "secret1" } });
  assert.equal(re.status, 403);
  assert.equal(one("SELECT COUNT(*) n FROM sessions WHERE user_id=?", u.id).n, 0);

  assert.equal((await act(u.id, "unblock", admin)).status, 200);
  const ok = await call("/auth/login", { method: "POST", body: { email: "blk@example.com", password: "secret1" } });
  assert.equal(ok.status, 200); assert.ok(cookieFrom(ok).startsWith("sid="));
  const list = await (await call("/admin/users?q=blk", { cookie: admin })).json();
  assert.equal(list.users[0].blocked, 0);
  const audit = env.DB._db.prepare("SELECT * FROM admin_audit WHERE target_id=? ORDER BY created_at").all(u.id);
  assert.deepEqual(audit.map(a => a.action), ["user.block", "user.unblock"]);
  assert.equal(audit[0].actor_email, "u_adm@example.com"); assert.equal(audit[0].target_email, "blk@example.com"); assert.ok(audit[0].created_at > 0);
});

test("remove: account, sessions and reader tokens gone; payments kept with an email snapshot", async () => {
  const id = "u_rm";
  const sess = session(id, "student", "rm@example.com");
  sql("INSERT INTO reader_tokens(token_hash,doc_id,user_id,expires) VALUES('h1','d1',?,?)", id, Date.now() + 1e6);
  sql("INSERT INTO payments(id,user_id,plan_name,amount,months,status,created_at) VALUES('p_rm',?,'Pro',99,1,'approved',1)", id);
  sql("INSERT INTO rzp_orders(order_id,user_id,amount,amount_paise,months,created_at) VALUES('o_rm',?,99,9900,1,1)", id);
  const r = await act(id, "remove", admin);
  assert.equal(r.status, 200);
  assert.equal(one("SELECT COUNT(*) n FROM users WHERE id=?", id).n, 0);
  assert.equal(one("SELECT COUNT(*) n FROM sessions WHERE user_id=?", id).n, 0);
  assert.equal(one("SELECT COUNT(*) n FROM reader_tokens WHERE user_id=?", id).n, 0);
  assert.equal((await call("/me", { cookie: sess })).status, 401);
  const p = one("SELECT * FROM payments WHERE id='p_rm'");
  assert.equal(p.user_id, id); assert.equal(p.user_email, "rm@example.com");
  assert.equal(one("SELECT user_email FROM rzp_orders WHERE order_id='o_rm'").user_email, "rm@example.com");
  const pays = await (await call("/admin/payments", { cookie: admin })).json();
  const row = pays.payments.find(x => x.id === "p_rm");
  assert.equal(row.user_email, "rm@example.com"); assert.equal(row.user_removed, 1);
  const a = one("SELECT * FROM admin_audit WHERE target_id=?", id);
  assert.equal(a.action, "user.remove"); assert.equal(a.target_email, "rm@example.com");
  // the old "delete" action goes through the same guarded remove
  session("u_rm2");
  assert.equal((await act("u_rm2", "delete", admin)).status, 200);
  assert.equal(one("SELECT action FROM admin_audit WHERE target_id='u_rm2'").action, "user.remove");
});

test("guards: no blocking/removing yourself or another admin; students and cross-site requests refused", async () => {
  for (const a of ["block", "remove", "delete"]) {
    assert.equal((await act("u_adm", a, admin)).status, 400, a + " self");
    assert.equal((await act("u_adm2", a, admin)).status, 400, a + " other admin");
  }
  assert.equal(one("SELECT COUNT(*) n FROM users WHERE role='admin' AND COALESCE(blocked,0)=0").n, 2);
  const victim = session("u_v");
  assert.equal((await act("u_v", "remove", student)).status, 403, "students can't");
  assert.equal((await call("/admin/users/bulk", { method: "POST", cookie: student, body: { action: "remove", ids: ["u_v"] } })).status, 403);
  assert.equal((await call("/admin/audit", { cookie: student })).status, 403);
  const xs = await call("/admin/users/u_v", { method: "POST", cookie: admin, body: { action: "remove" }, headers: { origin: "https://evil.example" } });
  assert.equal(xs.status, 403, "cross-site refused");
  assert.equal((await act("u_v", "remove")).status, 401);
  assert.ok(one("SELECT 1 FROM users WHERE id='u_v'"), "still there");
  assert.equal((await act("u_v", "explode", admin)).status, 400);
  void victim;
});

test("bulk remove/block skips admins and yourself", async () => {
  session("u_b1"); session("u_b2");
  const r = await (await call("/admin/users/bulk", { method: "POST", cookie: admin, body: { action: "block", ids: ["u_b1", "u_adm", "u_adm2", "nope"] } })).json();
  assert.deepEqual([r.done, r.skipped], [1, 3]);
  assert.equal(one("SELECT blocked FROM users WHERE id='u_b1'").blocked, 1);
  const r2 = await (await call("/admin/users/bulk", { method: "POST", cookie: admin, body: { action: "remove", ids: ["u_b1", "u_b2", "u_adm"] } })).json();
  assert.deepEqual([r2.done, r2.skipped], [2, 1]);
  assert.equal(one("SELECT COUNT(*) n FROM users WHERE id IN ('u_b1','u_b2')").n, 0);
  assert.ok(one("SELECT 1 FROM users WHERE id='u_adm'"));
  const au = await (await call("/admin/audit", { cookie: admin })).json();
  assert.ok(au.audit.length >= 5 && au.audit.every(a => a.actor_email && a.action && a.created_at));
});
