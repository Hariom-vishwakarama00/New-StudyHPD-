// Phase 1b (StudyHPD, Nov 2026): a student sees only the notes of their own branch and semester (a subject with no branch
// is for every branch, its semester must still match); branch and semester are required; admins see everything; a direct
// link to another branch's notes gets a refusal, not the file.
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
  return { _db: db, prepare: sql => stmt(sql), batch: async list => { db.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
}
const store = new Map();
const env = { EMAIL_MX_CHECK: "off", DB: makeD1(),
  FILES: { get: async k => store.has(k) ? { body: store.get(k), httpMetadata: { contentType: "application/pdf" } } : null,
    put: async (k, v) => { store.set(k, Buffer.from(await new Response(v).arrayBuffer())); }, delete: async k => { store.delete(k); } },
  ASSETS: { fetch: async () => new Response("ok") } };
const W = await import("../site/_worker.js?studyfilter");
const worker = W.default;
const O = "https://studyhpd.example";
const call = (p, { method = "GET", body, cookie, raw, headers = {} } = {}) => worker.fetch(new Request(O + "/api" + p, { method,
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" && !raw ? { origin: O } : {}), "cf-connecting-ip": "10.8.8." + Math.floor(Math.random() * 250), ...headers },
  body: raw != null ? raw : body ? JSON.stringify(body) : undefined }), env);
const DB = env.DB._db;
let seq = 0;
async function register(email, name = "Student") {
  const r = await call("/auth/register", { method: "POST", body: { name, email, password: "secret1" } });
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get("set-cookie").split(";")[0];
}
const meOf = async cookie => (await (await call("/me", { cookie })).json()).me;
await call("/bootstrap"); // runs the schema and the seed once
await register("admin.sf@example.com", "Admin");
DB.prepare("UPDATE users SET role='admin' WHERE email=?").run("admin.sf@example.com");
const adminCookie = (await call("/auth/login", { method: "POST", body: { email: "admin.sf@example.com", password: "secret1", admin: true } })).headers.get("set-cookie").split(";")[0];

// test subjects and documents (ids start with t_ so the seeded ones never mix in)
const subj = (id, branch, semester) => DB.prepare("INSERT INTO subjects(id,name,semester,branch,visible,sort) VALUES(?,?,?,?,1,0)").run(id, id, semester, branch);
subj("t_cs3", "CS", "Semester 3"); subj("t_any3", null, "Semester 3"); subj("t_cs4", "CS", "Semester 4");
subj("t_aiml3", "AIML", "Semester 3"); subj("t_any4", null, "Semester 4"); subj("t_nosem", null, "");
const doc = (id, sid, access = "free") => {
  DB.prepare("INSERT INTO documents(id,title,subject_id,access_level,status,created_at,updated_at,file_key,file_name) VALUES(?,?,?,?,'published',?,?,?,?)")
    .run(id, id, sid, access, Date.now(), Date.now(), "k_" + id, id + ".pdf");
  store.set("k_" + id, Buffer.from("%PDF-1.4 test"));
};
doc("t_d_cs3", "t_cs3"); doc("t_d_any3", "t_any3"); doc("t_d_cs4", "t_cs4"); doc("t_d_aiml3", "t_aiml3", "premium");
doc("t_d_any4", "t_any4"); doc("t_d_nosem", "t_nosem"); DB.prepare("INSERT INTO documents(id,title,subject_id,access_level,status,created_at,updated_at) VALUES('t_d_nosubj','no subject',NULL,'free','published',1,1)").run();
const ids = docs => docs.map(d => d.id).filter(x => x.startsWith("t_")).sort();
const listFor = async cookie => ids((await (await call("/documents", { cookie })).json()).documents);

test("the required step: a new student has no branch and sees no notes until both are saved", async () => {
  const c = await register("new.student.sf@example.com");
  const u = await meOf(c);
  assert.equal(u.branch, null); assert.equal(u.semester, null);
  assert.deepEqual(await listFor(c), [], "no notes before the choice");
  const r = await (await call("/documents/t_d_cs3", { cookie: c })).json();
  assert.equal(r.access.can_view, false); assert.equal(r.access.reason, "study");
});

test("saving branch and semester: both are required, skip is refused for a student, theme-only saves keep the choice", async () => {
  const c = await register("required.student.sf@example.com");
  let r = await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "CS" } });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /dono/);
  r = await call("/me/prefs", { method: "POST", cookie: c, body: { semester: 3 } });
  assert.equal(r.status, 400);
  r = await call("/me/prefs", { method: "POST", cookie: c, body: { skip: true } });
  assert.equal(r.status, 400, "no 'Abhi nahi' for students");
  assert.equal((await meOf(c)).branch, null);
  r = await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "CS", semester: 3 } });
  assert.equal(r.status, 200, await r.clone().text());
  let u = await meOf(c); assert.equal(u.branch, "CS"); assert.equal(u.semester, 3);
  r = await call("/me/prefs", { method: "POST", cookie: c, body: { theme: "dark" } });
  assert.equal(r.status, 200); u = await meOf(c);
  assert.equal(u.branch, "CS"); assert.equal(u.semester, 3); assert.equal(u.theme, "dark");
  // a change of semester alone is allowed once both are on the account (the other one is kept)
  r = await call("/me/prefs", { method: "POST", cookie: c, body: { semester: 4 } });
  assert.equal(r.status, 200, await r.clone().text()); u = await meOf(c);
  assert.equal(u.branch, "CS"); assert.equal(u.semester, 4);
  r = await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "Nope", semester: 4 } });
  assert.equal(r.status, 400);
  r = await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "CS", semester: 3 } });
  assert.equal(r.status, 200);
});

test("the notes list: a student sees their own branch and semester, plus blank-branch subjects of that semester", async () => {
  const c = await register("cs3.student.sf@example.com");
  await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "CS", semester: 3 } });
  assert.deepEqual(await listFor(c), ["t_d_any3", "t_d_cs3"]);
});

test("changing branch or semester in Profile changes the list at once", async () => {
  const c = await register("switch.student.sf@example.com");
  await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "CS", semester: 3 } });
  assert.deepEqual(await listFor(c), ["t_d_any3", "t_d_cs3"]);
  await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "AIML", semester: 3 } });
  assert.deepEqual(await listFor(c), ["t_d_aiml3", "t_d_any3"]);
  await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "CS", semester: 4 } });
  assert.deepEqual(await listFor(c), ["t_d_any4", "t_d_cs4"]);
});

test("a subject with no semester fits no student's semester: hidden from students, still there for the admin", async () => {
  const c = await register("nosem.student.sf@example.com");
  await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "Civil", semester: 3 } });
  assert.ok(!(await listFor(c)).includes("t_d_nosem"));
  assert.ok(!(await listFor(c)).includes("t_d_nosubj"), "a document with no subject is not a student's");
  const a = await listFor(adminCookie);
  assert.ok(a.includes("t_d_nosem") && a.includes("t_d_nosubj"));
});

test("admins see everything, whatever their own branch; visitors not logged in see the list as before", async () => {
  const all = ["t_d_aiml3", "t_d_any3", "t_d_any4", "t_d_cs3", "t_d_cs4", "t_d_nosem", "t_d_nosubj"];
  assert.deepEqual(await listFor(adminCookie), all);
  await call("/me/prefs", { method: "POST", cookie: adminCookie, body: { branch: "CS", semester: 3 } });
  assert.deepEqual(await listFor(adminCookie), all, "admin is never filtered");
  assert.deepEqual(await listFor(undefined), all, "a visitor is not filtered here (reading still needs login)");
  const r = await call("/me/prefs", { method: "POST", cookie: adminCookie, body: { branch: null, semester: null } });
  assert.equal(r.status, 200, "admin is not held to the branch/semester rule");
});

test("direct links to another branch or semester: a refusal the app can explain, and no file", async () => {
  const c = await register("direct.student.sf@example.com");
  await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "CS", semester: 3 } });
  const r = await (await call("/documents/t_d_cs4", { cookie: c })).json();
  assert.equal(r.access.can_view, false); assert.equal(r.access.reason, "other_study");
  assert.deepEqual(r.parts, {});
  let f = await call("/file/t_d_cs4", { cookie: c });
  assert.equal(f.status, 403); assert.match((await f.json()).error, /branch\/semester/);
  f = await call("/part/t_d_cs4/short", { cookie: c });
  assert.equal(f.status, 403);
  f = await call("/part-text/t_d_cs4/short", { cookie: c });
  assert.equal(f.status, 403);
  f = await call("/reader-token", { method: "POST", cookie: c, body: { doc: "t_d_cs4", part: "detailed" } });
  assert.equal(f.status, 403); assert.match((await f.json()).error, /branch\/semester/);
  // the document that matches is still open
  const own = await (await call("/documents/t_d_cs3", { cookie: c })).json();
  assert.equal(own.access.reason, "ok"); assert.equal(own.access.can_view, true);
  const okFile = await call("/file/t_d_cs3", { cookie: c });
  assert.equal(okFile.status, 200);
  const tok = await call("/reader-token", { method: "POST", cookie: c, body: { doc: "t_d_cs3", part: "detailed" } });
  assert.equal(tok.status, 200, await tok.clone().text());
  // a not-yet-chosen student gets the "choose first" reason, never a file
  const n = await register("direct.new.sf@example.com");
  const nr = await (await call("/documents/t_d_cs3", { cookie: n })).json();
  assert.equal(nr.access.reason, "study"); assert.equal(nr.access.can_view, false);
  assert.equal((await call("/file/t_d_cs3", { cookie: n })).status, 403);
});

test("the list and the document gate keep the payment and login rules", async () => {
  // a premium document of the student's own branch still needs a plan: the study match does not open it
  const c = await register("premium.student.sf@example.com");
  await call("/me/prefs", { method: "POST", cookie: c, body: { branch: "AIML", semester: 3 } });
  const r = await (await call("/documents/t_d_aiml3", { cookie: c })).json();
  assert.equal(r.access.reason, "premium"); assert.equal(r.access.can_view, false);
  assert.equal((await call("/file/t_d_aiml3", { cookie: c })).status, 403);
  // and a visitor is still told to log in
  assert.equal((await (await call("/documents/t_d_cs3")).json()).access.reason, "login");
});

test("studyFits: the rule itself", async () => {
  const { studyFits, studyNeeded } = W;
  const st = { role: "student", branch: "CS", semester: 3 };
  assert.equal(studyFits(st, { branch: "CS", semester: "Semester 3" }), true);
  assert.equal(studyFits(st, { branch: null, semester: "Semester 3" }), true);
  assert.equal(studyFits(st, { branch: "AIML", semester: "Semester 3" }), false);
  assert.equal(studyFits(st, { branch: null, semester: "Semester 4" }), false);
  assert.equal(studyFits(st, { branch: "CS", semester: "3rd sem" }), true, "older typed semester values read the same way");
  assert.equal(studyFits(st, { branch: null, semester: "" }), false);
  assert.equal(studyFits(st, undefined), false);
  assert.equal(studyFits({ role: "student", branch: null, semester: null }, { branch: null, semester: "Semester 3" }), false);
  assert.equal(studyFits({ role: "admin", branch: null, semester: null }, { branch: "AIML", semester: "Semester 8" }), true);
  assert.equal(studyNeeded({ role: "student", branch: "CS", semester: null }), true);
  assert.equal(studyNeeded({ role: "student", branch: "CS", semester: 2 }), false);
  assert.equal(studyNeeded({ role: "admin", branch: null, semester: null }), false);
});
