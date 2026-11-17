// Fix-all pass (2026-10-31): one semester label everywhere + admin dropdown, and cleaner OTP emails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
const env = { DB: makeD1(), FILES_KV: { getWithMetadata: async () => ({ value: null }), put: async () => {}, delete: async () => {} }, ASSETS: { fetch: async () => new Response("ok") } };
const mod = await import("../site/_worker.js");
const { default: worker, normalizeSemester, codeEmail } = mod;
const O = "https://studyhpd.example";
const call = (p, { method = "GET", body, cookie } = {}) => worker.fetch(new Request(O + "/api" + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: O } : {}), "cf-connecting-ip": "10.7.7.7" }, body: body ? JSON.stringify(body) : undefined }), env);
let adm;

test("normalizeSemester reads the typed variants as one label", () => {
  const cases = { "Semester 1": "Semester 1", "1 sem": "Semester 1", "1st sem": "Semester 1", "sem-2": "Semester 2", "SEM 2": "Semester 2",
    "3rd semester": "Semester 3", "II": "Semester 2", "Sem VIII": "Semester 8", " semester 4 ": "Semester 4", "8": "Semester 8", "": "", "  ": "" };
  for (const [k, v] of Object.entries(cases)) assert.equal(normalizeSemester(k), v, k);
  for (const bad of ["9", "10", "Semester 12", "abc", "first"]) assert.equal(normalizeSemester(bad), null, bad);
  assert.equal(normalizeSemester(null), ""); assert.equal(normalizeSemester(undefined), "");
});

test("admin subject save stores 'Semester N' and refuses an unreadable semester", async () => {
  await call("/bootstrap");
  env.DB._db.prepare("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at) VALUES('u_adm2','A','adm2@example.com','x','y','admin',0)").run();
  const tok = "d".repeat(64); env.DB._db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(createHash("sha256").update(tok).digest("hex"), "u_adm2", Date.now() + 1e7);
  adm = "sid=" + tok;
  let r = await call("/admin/subjects", { method: "POST", cookie: adm, body: { name: "Physics T", code: "BT 201", semester: "1 sem" } });
  assert.equal(r.status, 200);
  let row = env.DB._db.prepare("SELECT id, semester FROM subjects WHERE name='Physics T'").get();
  assert.equal(row.semester, "Semester 1");
  r = await call("/admin/subjects/" + row.id, { method: "POST", cookie: adm, body: { name: "Physics T", semester: "Semester 3" } });
  assert.equal(r.status, 200);
  assert.equal(env.DB._db.prepare("SELECT semester FROM subjects WHERE id=?").get(row.id).semester, "Semester 3");
  r = await call("/admin/subjects/" + row.id, { method: "POST", cookie: adm, body: { name: "Physics T", semester: "Semester 12" } });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /Semester 1 to Semester 8/);
  assert.equal(env.DB._db.prepare("SELECT semester FROM subjects WHERE id=?").get(row.id).semester, "Semester 3", "unchanged after a refused save");
  r = await call("/admin/subjects/" + row.id, { method: "POST", cookie: adm, body: { name: "Physics T", semester: "" } });
  assert.equal(r.status, 200); assert.equal(env.DB._db.prepare("SELECT semester FROM subjects WHERE id=?").get(row.id).semester, "");
});

const app = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
test("admin subject form picks the semester from a Semester 1–8 dropdown", () => {
  assert.match(app, /const SEMESTERS = \[1, 2, 3, 4, 5, 6, 7, 8\]\.map\(n => "Semester " \+ n\)/);
  assert.match(app, /\["semester", "Semester", "select", \[\["", "— Select semester —"\], \.\.\.SEMESTERS\.map\(s => \[s, s\]\)\]\]/);
  assert.doesNotMatch(app, /Semester \(e\.g\. Semester 2\)/, "old free-text semester field is gone");
});

test("home semester filter groups old and new labels under one chip, in order", () => {
  // run the app's own semLabel + chip/filter logic on mixed data
  const src = app.slice(app.indexOf("const SEMESTERS"), app.indexOf("const routes = [];"));
  const semLabel = new Function(src + "; return semLabel;")();
  const subs = [{ name: "Chem", semester: "Semester 1" }, { name: "Eng", semester: "Semester 2" }, { name: "Phy", semester: "1 sem" }, { name: "X", semester: "" }];
  const chipsLine = app.match(/const sems = (\[\.\.\.new Set\(subs\.map\(s => semLabel\(s\.semester\)\).*?\);)\n/)[1];
  const sems = new Function("subs", "semLabel", "return " + chipsLine)(subs, semLabel);
  assert.deepEqual(sems, ["Semester 1", "Semester 2"]);
  assert.match(app, /subs\.filter\(s => !semPick \|\| semLabel\(s\.semester\) === semPick\)/, "the chip filter (now drawn by drawSubs, with the study choice first)");
  assert.deepEqual(subs.filter(s => semLabel(s.semester) === "Semester 1").map(s => s.name), ["Chem", "Phy"]);
});

test("OTP email: clean subject, plain-text part, no links or images", () => {
  for (const [purpose, kind] of [["login", "login code"], ["verify", "verification code"], ["reset", "password reset code"]]) {
    const m = codeEmail({ code: "123456", purpose, siteName: "StudyHPD", origin: "https://www.studyhpd.workers.dev", name: "Aman" });
    assert.equal(m.subject, `StudyHPD ${kind}: 123456`);
    assert.match(m.text, /Your code: 123456/); assert.match(m.text, /^StudyHPD /);
    assert.doesNotMatch(m.text, /https?:\/\//); assert.doesNotMatch(m.html, /<a\s|href=|<img|https?:\/\//i);
    assert.match(m.html, /123456/); assert.match(m.html, /<meta charset="utf-8">/);
    assert.doesNotMatch(m.subject + m.text, /free|urgent|click|winner|!!/i);
  }
});

test("sender name is StudyHPD when the From setting has no name", async () => {
  const { parseFrom } = mod;
  assert.deepEqual(parseFrom("StudyHPD<solotechm@gmail.com>", "StudyHPD"), { name: "StudyHPD", email: "solotechm@gmail.com" });
  assert.deepEqual(parseFrom("solotechm@gmail.com", undefined), { name: "StudyHPD", email: "solotechm@gmail.com" });
});
