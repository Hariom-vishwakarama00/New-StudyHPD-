// Android Secure Reader: one-time reader tokens (POST /api/reader-token) and the PDF stream for the native
// FLAG_SECURE reader (GET /api/reader-file). Same access rules as the viewer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function makeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => { if (/^\s*(CREATE|ALTER|PRAGMA)/i.test(sql) && !args.length) db.exec(sql); else { const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; } return { success: true, meta: { changes: 0 } }; },
  });
  return { _db: db, prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
const files = new Map([["docs/premium.pdf", "%PDF-1.4 premium"], ["docs/free.pdf", "%PDF-1.4 free"]]);
const FILES = { get: async k => files.has(k) ? { body: files.get(k), httpMetadata: { contentType: "application/pdf" }, size: files.get(k).length, writeHttpMetadata() {} } : null, put: async (k, v) => files.set(k, v) };
const env = { EMAIL_MX_CHECK: "off", DB: makeD1(), FILES, ASSETS: { fetch: async () => new Response("ok") } };
const { default: worker } = await import("../site/_worker.js");
const O = "https://studyhpd.example";
const call = (p, { method = "GET", body, cookie, headers = {} } = {}) => worker.fetch(new Request(O + "/api" + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: O } : {}), "cf-connecting-ip": "10.1.1.1", ...headers }, body: body ? JSON.stringify(body) : undefined }), env);


const sha = s => createHash("sha256").update(s).digest("hex");
let FREE, PREM, stu, prem;
async function setup() {
  if (FREE) return;
  await call("/bootstrap");
  const db = env.DB._db;
  FREE = db.prepare("SELECT id FROM documents WHERE access_level='free' LIMIT 1").get().id;
  PREM = db.prepare("SELECT id FROM documents WHERE access_level<>'free' LIMIT 1").get().id;
  db.prepare("UPDATE documents SET file_key='docs/free.pdf', status='published' WHERE id=?").run(FREE);
  db.prepare("UPDATE documents SET file_key='docs/premium.pdf', status='published' WHERE id=?").run(PREM);
  // the study rule: students read notes of their own branch and semester; the seeded subjects are blank-branch Semester 1
  db.prepare("UPDATE subjects SET branch=NULL, semester='Semester 1'").run();
  const mk = (id, tok, premUntil) => { db.prepare("INSERT INTO users(id,name,email,pass_hash,salt,role,premium_until,created_at,branch,semester) VALUES(?,?,?,?,?,'student',?,0,'CS',1)").run(id, id, id + "@example.com", "x", "y", premUntil); db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sha(tok), id, Date.now() + 1e7); return "sid=" + tok; };
  stu = mk("u_stu", "c".repeat(64), 0); prem = mk("u_prem", "d".repeat(64), Date.now() + 1e9);
}
const token = async (doc, cookie) => call("/reader-token", { method: "POST", cookie, body: { doc } });

test("reader token needs login and follows the free/premium rules", async () => {
  await setup();
  assert.equal((await token(FREE)).status, 401, "no session, no token");
  assert.equal((await token(PREM, stu)).status, 403, "premium doc refused for a non-premium user");
  assert.equal((await token("nope", stu)).status, 404);
  assert.equal((await token("../x", stu)).status, 400);
  const ok = await token(FREE, stu); assert.equal(ok.status, 200);
  const j = await ok.json(); assert.match(j.token, /^[0-9a-f]{64}$/); assert.equal(j.doc, FREE); assert.equal(j.expires_in, 300);
  assert.equal((await token(PREM, prem)).status, 200, "premium user gets a premium doc token");
  const row = env.DB._db.prepare("SELECT * FROM reader_tokens WHERE token_hash=?").get(sha(j.token));
  assert.ok(row, "only the hash is stored"); assert.equal(row.user_id, "u_stu"); assert.ok(row.expires - Date.now() <= 300000);
  assert.equal(env.DB._db.prepare("SELECT count(*) c FROM reader_tokens WHERE token_hash=?").get(j.token).c, 0, "raw token not stored");
});

test("reader file: valid token streams the PDF once; reuse, expiry, wrong doc and browser tabs are refused", async () => {
  await setup();
  const { token: t } = await (await token(FREE, stu)).json();
  const r = await call(`/reader-file?doc=${FREE}&t=${t}`);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("cache-control"), /no-store/); assert.equal(await r.text(), "%PDF-1.4 free");
  assert.equal((await call(`/reader-file?doc=${FREE}&t=${t}`)).status, 410, "single use");
  const { token: t2 } = await (await token(FREE, stu)).json();
  env.DB._db.prepare("UPDATE reader_tokens SET expires=? WHERE token_hash=?").run(Date.now() - 1, sha(t2));
  assert.equal((await call(`/reader-file?doc=${FREE}&t=${t2}`)).status, 410, "expired");
  const { token: t3 } = await (await token(FREE, stu)).json();
  assert.equal((await call(`/reader-file?doc=${PREM}&t=${t3}`)).status, 403, "token is bound to its document");
  const { token: t4 } = await (await token(FREE, stu)).json();
  assert.equal((await call(`/reader-file?doc=${FREE}&t=${t4}`, { headers: { "sec-fetch-dest": "document" } })).status, 403, "not for a browser tab");
  assert.equal((await call(`/reader-file?doc=${FREE}&t=${"0".repeat(64)}`)).status, 410, "unknown token");
  assert.equal((await call(`/reader-file?doc=${FREE}&t=xyz`)).status, 400);
});

test("reader file re-checks premium at download time", async () => {
  await setup();
  const { token: t } = await (await token(PREM, prem)).json();
  env.DB._db.prepare("UPDATE users SET premium_until=1 WHERE id='u_prem'").run();
  assert.equal((await call(`/reader-file?doc=${PREM}&t=${t}`)).status, 403, "plan lapsed after the token was minted");
  env.DB._db.prepare("UPDATE users SET premium_until=? WHERE id='u_prem'").run(Date.now() + 1e9);
  const { token: t2 } = await (await token(PREM, prem)).json();
  assert.equal((await call(`/reader-file?doc=${PREM}&t=${t2}`)).status, 200);
});

test("reader token POST must come from the site itself", async () => {
  await setup();
  const r = await worker.fetch(new Request(O + "/api/reader-token", { method: "POST", headers: { cookie: stu, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ doc: FREE }) }), env);
  assert.equal(r.status, 403);
});

test("the site hands notes to the app's Secure Reader only inside app v1.0.2+ (sr=1, per tab)", () => {
  const boot = readFileSync(new URL("../site/boot.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  assert.match(boot, /q\.get\("sr"\) === "1"/); assert.match(boot, /sessionStorage/); assert.match(boot, /setItem\("shpd-sr", "1"\)/);
  assert.match(app, /intent:\/\/reader\?doc=/); assert.match(app, /scheme=studyhpd;package=com\.studyhpd\.app;S\.browser_fallback_url=/);
  assert.match(app, /else if \(secureReaderApp\(\)\) box =/, "inside the app the PDF is never drawn in Chrome");
  assert.doesNotMatch(app, /has\("web"\)/, "no in-app bypass to the web viewer");
  assert.match(app, /\?tap=1/, "Chrome's fallback comes back to the tap-to-open page");
});
