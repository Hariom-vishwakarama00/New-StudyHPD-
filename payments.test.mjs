// Regression: payments, admin approval and premium locks still work with the new auth code.
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
    run: async () => { if (/^\s*(CREATE|ALTER|PRAGMA)/i.test(sql) && !args.length) db.exec(sql); else { const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; } return { success: true, meta: { changes: 0 } }; },
  });
  return { _db: db, prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
const files = new Map([["docs/premium.pdf", "%PDF-1.4 premium"]]);
const FILES = { get: async k => files.has(k) ? { body: files.get(k), httpMetadata: { contentType: "application/pdf" }, size: files.get(k).length, writeHttpMetadata() {} } : null, put: async (k, v) => files.set(k, v) };
const env = { EMAIL_MX_CHECK: "off", DB: makeD1(), FILES, ASSETS: { fetch: async () => new Response("ok") } };
const { default: worker } = await import("../site/_worker.js");
const O = "https://studyhpd.example";
const call = (p, { method = "GET", body, cookie } = {}) => worker.fetch(new Request(O + "/api" + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: O } : {}), "cf-connecting-ip": "10.1.1.1" }, body: body ? JSON.stringify(body) : undefined }), env);

test("student pays by UTR, admin approves, premium unlocks", async () => {
  await call("/bootstrap");
  const doc = env.DB._db.prepare("SELECT id FROM documents WHERE access_level<>'free' LIMIT 1").get();
  assert.ok(doc, "seed has a premium document");
  env.DB._db.prepare("UPDATE documents SET file_key='docs/premium.pdf', status='published' WHERE id=?").run(doc.id);
  const reg = await call("/auth/register", { method: "POST", body: { name: "Stu", email: "stu@example.com", password: "secret1" } });
  assert.equal(reg.status, 200);
  const sc = reg.headers.get("set-cookie").split(";")[0];
  // the study rule: a student's notes are their own branch and semester (the seeded subjects are blank-branch Semester 1 here)
  env.DB._db.prepare("UPDATE subjects SET branch=NULL, semester='Semester 1'").run();
  env.DB._db.prepare("UPDATE users SET branch='CS', semester=1 WHERE email='stu@example.com'").run();
  assert.equal((await call("/file/" + doc.id, { cookie: sc })).status, 403, "premium is locked");
  const plan = env.DB._db.prepare("SELECT id FROM plans ORDER BY price LIMIT 1").get();
  const pay = await call("/payments", { method: "POST", cookie: sc, body: { plan_id: plan.id, utr: "123456789012" } });
  assert.equal(pay.status, 200); const { id } = await pay.json();
  // admin
  env.DB._db.prepare("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at) VALUES('u_a','A','a@example.com','x','y','admin',0)").run();
  const tok = "b".repeat(64); env.DB._db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(createHash("sha256").update(tok).digest("hex"), "u_a", Date.now() + 1e7);
  const ac = "sid=" + tok;
  assert.equal((await call("/admin/payments/" + id + "/approve", { method: "POST", cookie: sc })).status, 403, "students cannot approve");
  const ap = await call("/admin/payments/" + id + "/approve", { method: "POST", cookie: ac, body: {} });
  assert.equal(ap.status, 200);
  const me = await (await call("/me", { cookie: sc })).json();
  assert.equal(me.me.premium, true);
  assert.equal((await call("/file/" + doc.id, { cookie: sc })).status, 200, "premium unlocked after approval");
  assert.equal((await call("/file/" + doc.id)).status, 401, "still needs login");
});
