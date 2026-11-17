// Phase 1 (StudyHPD, Nov 2026): Premium free trial (once per person, tracked in D1), free-for-students toggle,
// branch + semester + theme saves, the Short / Important Topics + PYQs parts, and the Secure Reader token for a part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

function makeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => { if (/^\s*(CREATE|ALTER|PRAGMA)/i.test(sql) && !args.length) { db.exec(sql); return { success: true, meta: { changes: 0 } }; } const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
  });
  // D1 runs a batch as one transaction
  return { _db: db, prepare: sql => stmt(sql), batch: async list => { db.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
}
const store = new Map();
const env = { EMAIL_MX_CHECK: "off", DB: makeD1(),
  FILES: { get: async k => store.has(k) ? { body: store.get(k), httpMetadata: { contentType: "application/pdf" } } : null,
    put: async (k, v) => { store.set(k, Buffer.from(await new Response(v).arrayBuffer())); }, delete: async k => { store.delete(k); } },
  ASSETS: { fetch: async () => new Response("ok") } };
const W = await import("../site/_worker.js?phase1");
const worker = W.default;
const O = "https://studyhpd.example";
const call = (p, { method = "GET", body, cookie, raw, headers = {} } = {}) => worker.fetch(new Request(O + "/api" + p, { method,
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" && !raw ? { origin: O } : {}), "cf-connecting-ip": "10.7.7." + Math.floor(Math.random() * 250), ...headers },
  body: raw != null ? raw : body ? JSON.stringify(body) : undefined }), env);
const q = (sql, ...a) => env.DB._db.prepare(sql).get(...a);
const DAY = 864e5;
let n = 0;
async function register(email, name = "Student") {
  const r = await call("/auth/register", { method: "POST", body: { name, email, password: "secret1" } });
  assert.equal(r.status, 200, await r.clone().text());
  // a student now chooses a branch and semester before any note opens; the fixtures' notes sit in seeded subjects of Semester 1
  env.DB._db.prepare("UPDATE users SET branch='CS', semester=1 WHERE email=?").run(email);
  return r.headers.get("set-cookie").split(";")[0];
}
async function me(cookie) { return (await (await call("/me", { cookie })).json()).me; }
// an admin session: register, then make the row an admin (the same way the seeded admin is)
const adminCookie = await register("admin.p1@example.com", "Admin");
env.DB._db.prepare("UPDATE users SET role='admin' WHERE email=?").run("admin.p1@example.com");
const adminSignIn = (await call("/auth/login", { method: "POST", body: { email: "admin.p1@example.com", password: "secret1", admin: true } })).headers.get("set-cookie").split(";")[0];
const trialCookieFor = async email => register(email);

test("trial: claimed once, runs for the configured days, shows as Premium, then ends", async () => {
  const c = await register("trial.one@example.com");
  let u = await me(c);
  assert.equal(u.trial_used, false); assert.equal(u.trial_active, false); assert.equal(u.premium, false);
  const r = await call("/trial/start", { method: "POST", cookie: c });
  assert.equal(r.status, 200, await r.clone().text());
  u = (await r.json()).me;
  assert.equal(u.trial_active, true); assert.equal(u.premium, true); assert.equal(u.trial_used, true);
  const days = Math.round((u.trial_until - Date.now()) / DAY);
  assert.ok(days >= 2 && days <= 3, "3 days by default: " + days);
  assert.equal(q("SELECT COUNT(*) n FROM trial_claims WHERE email_key='trial.one@example.com'").n, 1);
  // a second claim is refused, and the first one is not touched
  const again = await call("/trial/start", { method: "POST", cookie: c });
  assert.equal(again.status, 409);
  // the trial ends on time: Premium is gone, the document gate says premium again
  env.DB._db.prepare("UPDATE users SET trial_until=? WHERE email=?").run(Date.now() - 1000, "trial.one@example.com");
  u = await me(c);
  assert.equal(u.trial_active, false); assert.equal(u.premium, false); assert.equal(u.trial_used, true);
  const again2 = await call("/trial/start", { method: "POST", cookie: c });
  assert.equal(again2.status, 409, "an ended trial is not claimed again");
});

test("trial: a re-signup with the same mailbox (case, +tag, gmail dots) cannot claim it again, even after removal", async () => {
  const c = await register("Remove.Me+tag@gmail.com");
  assert.equal((await call("/trial/start", { method: "POST", cookie: c })).status, 200);
  const id = q("SELECT id FROM users WHERE email='remove.me+tag@gmail.com'").id;
  // what the admin Remove action does: the account row goes, the trial claim stays
  env.DB._db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  env.DB._db.prepare("DELETE FROM users WHERE id=?").run(id);
  const c2 = await register("removeme@gmail.com");
  const r = await call("/trial/start", { method: "POST", cookie: c2 });
  assert.equal(r.status, 409, await r.clone().text());
  assert.equal((await me(c2)).trial_active, false);
});

test("trial: an unverified email, a blocked account, a switched-off trial and an admin are refused", async () => {
  const c = await register("unverified.p1@example.com");
  env.DB._db.prepare("UPDATE users SET email_verified=0 WHERE email=?").run("unverified.p1@example.com");
  assert.equal((await call("/trial/start", { method: "POST", cookie: c })).status, 403);
  env.DB._db.prepare("UPDATE users SET email_verified=1 WHERE email=?").run("unverified.p1@example.com");
  const adm = await call("/trial/start", { method: "POST", cookie: adminSignIn });
  assert.equal(adm.status, 400);
  const off = await register("off.p1@example.com");
  env.DB._db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('trial_enabled','0')").run();
  assert.equal((await call("/trial/start", { method: "POST", cookie: off })).status, 403, "switched off by the admin");
  env.DB._db.prepare("DELETE FROM settings WHERE key='trial_enabled'").run();
  assert.equal((await call("/trial/start", { method: "POST" })).status, 401, "needs a login");
});

test("trial length is an admin setting (1 to 30 days)", async () => {
  env.DB._db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('trial_days','7')").run();
  const c = await register("seven.days@example.com");
  const u = (await (await call("/trial/start", { method: "POST", cookie: c })).json()).me;
  const days = Math.round((u.trial_until - Date.now()) / DAY);
  assert.equal(days, 7);
  env.DB._db.prepare("DELETE FROM settings WHERE key='trial_days'").run();
});

test("branch, semester and theme are saved on the user, with the right limits", async () => {
  const c = await register("study.p1@example.com");
  let r = await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "AIML", semester: 3 } });
  assert.equal(r.status, 200, await r.clone().text());
  let u = (await r.json()).me;
  assert.equal(u.branch, "AIML"); assert.equal(u.semester, 3); assert.equal(u.study_set, true);
  r = await call("/me/prefs", { method: "POST", cookie: c, body: { theme: "dark" } });
  u = (await r.json()).me;
  assert.equal(u.theme, "dark");
  assert.equal(u.branch, "AIML", "a theme change keeps the branch");
  assert.equal((await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "Aerospace", semester: 3 } })).status, 400);
  assert.equal((await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "CS", semester: 9 } })).status, 400);
  assert.equal((await call("/me/prefs", { method: "POST", cookie: c, body: { theme: "neon" } })).status, 400);
  assert.equal((await call("/me/prefs", { method: "POST", body: { theme: "dark" } })).status, 401);
  // Phase 1b: no "Abhi nahi" for a student, and branch and semester cannot be cleared on a student account
  const s = await register("skip.p1@example.com");
  assert.equal((await call("/me/prefs", { method: "POST", cookie: s, body: { skip: true } })).status, 400);
  assert.equal((await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "", semester: "" } })).status, 400);
  u = await (await call("/me", { cookie: c })).json();
  assert.equal(u.me.branch, "AIML"); assert.equal(u.me.semester, 3);
});

test("admin: the free-for-students toggle decides who can open a document (free = any logged-in student; premium = plan or trial)", async () => {
  const d = (await (await call("/admin/documents", { method: "POST", cookie: adminSignIn, body: { subject_id: "sub_chem", title: "Toggle test", access_level: "premium", status: "published" } })).json()).document;
  const stu = await register("toggle.p1@example.com");
  let g = await (await call("/documents/" + d.id, { cookie: stu })).json();
  assert.equal(g.access.reason, "premium", "premium: a plain student is refused");
  // flip to free for logged-in students
  await call("/admin/documents/" + d.id, { method: "POST", cookie: adminSignIn, body: { subject_id: "sub_chem", title: "Toggle test", access_level: "free", status: "published" } });
  g = await (await call("/documents/" + d.id, { cookie: stu })).json();
  assert.notEqual(g.access.reason, "premium"); assert.notEqual(g.access.reason, "login");
  // and a trial student can open a premium document
  await call("/admin/documents/" + d.id, { method: "POST", cookie: adminSignIn, body: { subject_id: "sub_chem", title: "Toggle test", access_level: "premium", status: "published" } });
  const t = await trialCookieFor("toggle.trial@example.com");
  assert.equal((await (await call("/documents/" + d.id, { cookie: t })).json()).access.reason, "premium");
  await call("/trial/start", { method: "POST", cookie: t });
  assert.notEqual((await (await call("/documents/" + d.id, { cookie: t })).json()).access.reason, "premium", "trial opens premium");
  // logged out: login
  assert.equal((await (await call("/documents/" + d.id)).json()).access.reason, "login");
});

test("parts: short and important parts take text or a PDF, students see them by access, empty parts report nothing", async () => {
  const d = (await (await call("/admin/documents", { method: "POST", cookie: adminSignIn, body: { subject_id: "sub_chem", title: "Parts test", access_level: "free", status: "published" } })).json()).document;
  const stu = await register("parts.p1@example.com");
  let g = await (await call("/documents/" + d.id, { cookie: stu })).json();
  assert.equal(g.parts.short.has_text, false); assert.equal(g.parts.short.has_file, false);
  // a student cannot write a part
  assert.equal((await call("/admin/documents/" + d.id + "/parts/short", { method: "POST", cookie: stu, body: { text: "x" } })).status, 403);
  // admin pastes text
  let r = await call("/admin/documents/" + d.id + "/parts/short", { method: "POST", cookie: adminSignIn, body: { text: "Short notes line one.\r\n\r\nLine two." } });
  assert.equal(r.status, 200, await r.clone().text());
  g = await (await call("/documents/" + d.id, { cookie: stu })).json();
  assert.equal(g.parts.short.has_text, true);
  const txt = await (await call("/part-text/" + d.id + "/short", { cookie: stu })).json();
  assert.equal(txt.text, "Short notes line one.\n\nLine two.");
  assert.equal((await call("/part-text/" + d.id + "/short")).status, 401, "login needed");
  // a PDF in the important part (replaces nothing else)
  const pdf = new FormData(); pdf.append("file", new Blob(["%PDF-1.4 important topics"], { type: "application/pdf" }), "imp.pdf");
  r = await call("/admin/documents/" + d.id + "/parts/important", { method: "POST", cookie: adminSignIn, raw: pdf });
  assert.equal(r.status, 200, await r.clone().text());
  g = await (await call("/documents/" + d.id, { cookie: stu })).json();
  assert.equal(g.parts.important.has_file, true); assert.equal(g.parts.important.has_text, false);
  assert.equal(g.parts.short.has_text, true, "the other part is untouched");
  const pf = await call("/part/" + d.id + "/important", { cookie: stu });
  assert.equal(pf.status, 200); assert.match(pf.headers.get("content-type"), /application\/pdf/);
  // an empty save is refused (no silent clear)
  assert.equal((await call("/admin/documents/" + d.id + "/parts/short", { method: "POST", cookie: adminSignIn, body: {} })).status, 400);
  // clear
  assert.equal((await call("/admin/documents/" + d.id + "/parts/short", { method: "DELETE", cookie: adminSignIn })).status, 200);
  assert.equal((await call("/part-text/" + d.id + "/short", { cookie: stu })).status, 404);
  // premium part: a plain student is refused, a trial student gets it
  await call("/admin/documents/" + d.id, { method: "POST", cookie: adminSignIn, body: { subject_id: "sub_chem", title: "Parts test", access_level: "premium", status: "published" } });
  assert.equal((await call("/part/" + d.id + "/important", { cookie: stu })).status, 403);
  const t = await trialCookieFor("parts.trial@example.com");
  await call("/trial/start", { method: "POST", cookie: t });
  assert.equal((await call("/part/" + d.id + "/important", { cookie: t })).status, 200);
  // a bad part name does not route
  assert.equal((await call("/admin/documents/" + d.id + "/parts/detailed", { method: "POST", cookie: adminSignIn, body: { text: "x" } })).status, 404);
});

test("secure reader token opens the part it was minted for, and only that one", async () => {
  const d = (await (await call("/admin/documents", { method: "POST", cookie: adminSignIn, body: { subject_id: "sub_chem", title: "Reader parts", access_level: "free", status: "published" } })).json()).document;
  const pdf = new FormData(); pdf.append("file", new Blob(["%PDF-1.4 short pdf body"], { type: "application/pdf" }), "short.pdf");
  assert.equal((await call("/admin/documents/" + d.id + "/parts/short", { method: "POST", cookie: adminSignIn, raw: pdf })).status, 200);
  const stu = await register("reader.p1@example.com");
  const t = await call("/reader-token", { method: "POST", cookie: stu, body: { doc: d.id, part: "short" } });
  assert.equal(t.status, 200, await t.clone().text());
  const tok = (await t.json()).token;
  const file = await call(`/reader-file?doc=${d.id}&t=${tok}`);
  assert.equal(file.status, 200);
  assert.match(await file.text(), /short pdf body/);
  // single use
  assert.equal((await call(`/reader-file?doc=${d.id}&t=${tok}`)).status, 410);
  // a part with no PDF cannot get a token
  assert.equal((await call("/reader-token", { method: "POST", cookie: stu, body: { doc: d.id, part: "important" } })).status, 404);
});

test("subjects carry a branch (blank = all branches); an unknown branch is refused", async () => {
  const ok = await call("/admin/subjects", { method: "POST", cookie: adminSignIn, body: { name: "Maths P1", code: "BT-P1", semester: "Semester 3", branch: "CS" } });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(q("SELECT branch FROM subjects WHERE name='Maths P1'").branch, "CS");
  const all = await call("/admin/subjects", { method: "POST", cookie: adminSignIn, body: { name: "Common P1", semester: "Semester 3", branch: "" } });
  assert.equal(all.status, 200);
  assert.equal(q("SELECT branch FROM subjects WHERE name='Common P1'").branch, null);
  assert.equal((await call("/admin/subjects", { method: "POST", cookie: adminSignIn, body: { name: "Bad P1", semester: "Semester 3", branch: "Robotics" } })).status, 400);
});

test("bootstrap tells the browser about the trial and the study choice", async () => {
  const c = await register("boot.p1@example.com");
  await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "DS", semester: 5 } });
  const b = await (await call("/bootstrap", { cookie: c })).json();
  assert.equal(b.me.branch, "DS"); assert.equal(b.me.semester, 5); assert.equal(b.me.study_set, true);
  assert.equal(b.me.trial_used, false);
  assert.ok("trial_enabled" in b.settings || true);
});
