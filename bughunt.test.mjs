// Bug-hunt fixes (2026-10-31): months cap on approvals, versioned cover caching, upload limit for admins,
// stale-page guard in the app router, PDF zoom, private page titles, cache headers for big static files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { pageMeta } from "../site/seo.js";

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
const files = new Map([["thumbs/t.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])]]);
const FILES_KV = { getWithMetadata: async k => files.has(k) ? { value: files.get(k), metadata: { contentType: "image/png" } } : { value: null }, put: async (k, v) => files.set(k, v), delete: async k => files.delete(k) };
const env = { EMAIL_MX_CHECK: "off", DB: makeD1(), FILES_KV, ASSETS: { fetch: async () => new Response("ok") } };
const { default: worker } = await import("../site/_worker.js");
const O = "https://studyhpd.example";
const call = (p, { method = "GET", body, cookie } = {}) => worker.fetch(new Request(O + "/api" + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: O } : {}), "cf-connecting-ip": "10.9.9.9" }, body: body ? JSON.stringify(body) : undefined }), env);
let adm, stu, payId;
test("setup: student + admin + pending payment", async () => {
  await call("/bootstrap");
  const reg = await call("/auth/register", { method: "POST", body: { name: "Stu", email: "bh@example.com", password: "secret1" } });
  assert.equal(reg.status, 200); stu = reg.headers.get("set-cookie").split(";")[0];
  env.DB._db.prepare("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at) VALUES('u_adm','A','adm@example.com','x','y','admin',0)").run();
  const tok = "c".repeat(64); env.DB._db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(createHash("sha256").update(tok).digest("hex"), "u_adm", Date.now() + 1e7);
  adm = "sid=" + tok;
  const plan = env.DB._db.prepare("SELECT id FROM plans ORDER BY price LIMIT 1").get();
  const pay = await call("/payments", { method: "POST", cookie: stu, body: { plan_id: plan.id, utr: "556677889900" } });
  assert.equal(pay.status, 200); payId = (await pay.json()).id;
});
test("approving with a typo like 30000 months is refused, the payment stays pending", async () => {
  const r = await call("/admin/payments/" + payId + "/approve", { method: "POST", cookie: adm, body: { months: "30000" } });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /between 1 and 120/);
  assert.equal(env.DB._db.prepare("SELECT status FROM payments WHERE id=?").get(payId).status, "pending");
  assert.equal(env.DB._db.prepare("SELECT premium_until FROM users WHERE email='bh@example.com'").get().premium_until, 0);
  const ok = await call("/admin/payments/" + payId + "/approve", { method: "POST", cookie: adm, body: { months: "1" } });
  assert.equal(ok.status, 200);
  const until = (await ok.json()).premium_until; assert.ok(until > Date.now() && until < Date.now() + 32 * 864e5);
});
test("manual grant and plan duration are capped at 120 months too", async () => {
  const uid = env.DB._db.prepare("SELECT id FROM users WHERE email='bh@example.com'").get().id;
  assert.equal((await call("/admin/users/" + uid, { method: "POST", cookie: adm, body: { action: "grant", months: 500 } })).status, 400);
  assert.equal((await call("/admin/users/" + uid, { method: "POST", cookie: adm, body: { action: "grant", months: 2 } })).status, 200);
  assert.equal((await call("/admin/plans", { method: "POST", cookie: adm, body: { name: "Forever", price: 10, duration_months: 999 } })).status, 400);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM plans WHERE name='Forever'").get().n, 0);
});
test("covers: a versioned link (?v=) is cacheable for a day, a bare one for 5 minutes", async () => {
  env.DB._db.prepare("UPDATE documents SET thumb_key='thumbs/t.png', status='published' WHERE id=(SELECT id FROM documents LIMIT 1)").run();
  const id = env.DB._db.prepare("SELECT id FROM documents WHERE thumb_key='thumbs/t.png'").get().id;
  assert.equal((await call("/thumb/" + id + "?v=123")).headers.get("cache-control"), "public, max-age=86400");
  assert.equal((await call("/thumb/" + id)).headers.get("cache-control"), "public, max-age=300");
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  assert.ok(app.includes("/api/thumb/${d.id}?v=${d.updated_at || 0}"), "cards link versioned covers");
  assert.ok(/shrinkCover/.test(app) && app.includes('fd.set("thumb", await shrinkCover(cover))'), "covers are shrunk before upload");
});
test("admin stats tell the upload form the real file limit (25 MB on KV storage)", async () => {
  const st = await (await call("/admin/stats", { cookie: adm })).json();
  assert.equal(st.max_upload_mb, 25);
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  assert.ok(app.includes("`PDF up to ${maxMb} MB`") && app.includes("pdfFile.size > maxMb * 1048576"));
});
test("router: a page read that finishes after the user moved on is dropped (no wrong page after fast taps)", () => {
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  assert.ok(app.indexOf("let seq = 0") < app.indexOf("async function api("), "seq exists before api()");
  assert.ok(app.includes("if (read && page !== seq) return STALE;"));
  assert.ok(app.includes("const my = ++seq"), "every render bumps seq");
});
test("PDF viewer: zoom in really zooms (scrolls sideways) and a newer draw stops an older one", () => {
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../site/styles.css", import.meta.url), "utf8");
  assert.ok(app.includes('host.classList.toggle("zoomed", scale > 1)') && app.includes("my !== gen"));
  assert.ok(css.includes(".pdfpages.zoomed canvas{max-width:none}") && /\.pdfpages\{[^}]*overflow-x:auto/.test(css));
});
test("private pages get their own browser-tab title", () => {
  assert.equal(pageMeta("private", { label: "Log in" }).title, "Log in | StudyHPD");
  assert.equal(pageMeta("private", {}).robots, "noindex");
  assert.match(pageMeta("private", {}).title, /^StudyHPD – /, "server-side (no label) is unchanged");
  const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  assert.ok(app.includes('[/^\\/login$/, "Log in"]') && app.includes('[/^\\/register$/, "Create account"]'));
});
test("big static files are cached by the browser; app code and the sw.js kill-switch are not", () => {
  const h = fs.readFileSync(new URL("../site/_headers", import.meta.url), "utf8");
  assert.match(h, /\/vendor\/\*\n\s+Cache-Control: public, max-age=604800/);
  assert.match(h, /\/img\/\*\n\s+Cache-Control: public, max-age=86400/);
  assert.ok(!/\/app\.js|\/sw\.js|\/\*\.js/.test(h.split("/vendor/*")[1]), "no long cache for app.js / sw.js");
});
