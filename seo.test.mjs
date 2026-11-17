// SEO (2026-10-31): per-page meta + crawlable text in the raw HTML, robots.txt, sitemap.xml, JSON-LD, Google verification.
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
const INDEX = fs.readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const assets = [];
const env = { DB: makeD1(), FILES: { get: async () => null, put: async () => {}, delete: async () => {} },
  ASSETS: { fetch: async r => { const p = new URL(r.url).pathname; assets.push(p); return p === "/" ? new Response(INDEX, { headers: { "content-type": "text/html", etag: '"x"' } }) : new Response("nf", { status: 404 }); } } };
const worker = (await import("../site/_worker.js")).default;
const O = "https://studyhpd.example";
const get = (p, headers = {}) => worker.fetch(new Request(O + p, { headers }), env);
const html = async p => { const r = await get(p); return { r, h: await r.text() }; };
const sql = (q, ...a) => env.DB._db.prepare(q).run(...a);
const one = (q, ...a) => env.DB._db.prepare(q).get(...a);
const title = h => (h.match(/<title>([^<]*)<\/title>/) || [])[1];
const canon = h => (h.match(/<link rel="canonical" href="([^"]+)">/) || [])[1];
const lds = h => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));

await worker.fetch(new Request(O + "/api/health"), env); // creates tables + seed
sql("UPDATE documents SET file_key='docs/SECRETKEY123.pdf' WHERE id='doc_eng_u5'");
sql("INSERT INTO subjects(id,name,code,course,year,semester,sort,visible) VALUES('s_hidden','Hidden Subject','HX 1','B.Tech','2nd Year','Semester 3',9,0)");
sql("INSERT INTO documents(id,title,description,subject_id,unit_id,category_id,access_level,file_key,status,views,created_at,updated_at) VALUES('d_draft','Draft notes','x','sub_chem','u_chem_2','cat_notes','free','docs/draft.pdf','draft',0,1,1)");
sql("INSERT INTO documents(id,title,description,subject_id,unit_id,category_id,access_level,file_key,status,views,created_at,updated_at) VALUES('d_xss','Evil </script><script>alert(1)</script> & co','desc \"q\"','sub_beee','u_beee_1','cat_qb','premium','docs/evil.pdf','published',0,1793372675329,1793372675329)");

test("home: unique title, canonical, absolute og:image, UTF-8, JSON-LD, crawlable links", async () => {
  const { r, h } = await html("/");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  assert.ok(r.headers.get("content-security-policy"), "CSP kept");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(title(h), "StudyHPD – B.Tech Notes, Important Questions &amp; Study Material");
  assert.equal(canon(h), O + "/");
  assert.match(h, /<meta property="og:image" content="https:\/\/studyhpd\.example\/og\.png">/);
  assert.match(h, /<meta property="og:url" content="https:\/\/studyhpd\.example\/">/);
  assert.match(h, /<meta name="robots" content="index, follow">/);
  assert.equal((h.match(/<title>/g) || []).length, 1, "one title");
  assert.equal((h.match(/rel="canonical"/g) || []).length, 1, "one canonical");
  const ld = lds(h);
  assert.deepEqual(ld.map(x => x["@type"]), ["Organization", "WebSite"]);
  assert.equal(ld[0].name, "StudyHPD"); assert.equal(ld[0].url, O + "/"); assert.match(ld[0].logo.url, /^https:\/\/studyhpd\.example\/img\/icon-512\.png$/);
  assert.match(h, /<div class="ssr"><h1>StudyHPD/);
  assert.match(h, /<a href="\/subject\/sub_beee">BEEE Notes<\/a>/);
  assert.match(h, /<a href="\/document\/doc_chem_u2">/);
  assert.doesNotMatch(h, /Hidden Subject|d_draft/, "hidden subject and drafts are not listed");
  assert.match(h, /<script type="module" src="\/app\.js"><\/script>/, "app still loads");
  assert.match(h, /id="boot-splash"/, "splash kept");
});

test("subject, unit and document pages each get their own title, canonical, breadcrumbs and text", async () => {
  const s = await html("/subject/sub_beee");
  assert.equal(s.r.status, 200);
  assert.equal(title(s.h), "BEEE Notes PDF (BT-104) – B.Tech 1st Year | StudyHPD");
  assert.equal(canon(s.h), O + "/subject/sub_beee");
  assert.match(s.h, /<h1>BEEE Notes \(BT-104\)<\/h1>/);
  assert.match(s.h, /<a href="\/subject\/sub_beee\/unit\/u_beee_1">BEEE Unit 1 notes<\/a>/);
  assert.match(s.h, /Basic Electrical &amp; Electronics Engineering/);
  const bc = lds(s.h).find(x => x["@type"] === "BreadcrumbList");
  assert.deepEqual(bc.itemListElement.map(i => [i.position, i.name, i.item]), [[1, "Home", O + "/"], [2, "BEEE", O + "/subject/sub_beee"]]);

  const u = await html("/subject/sub_beee/unit/u_beee_2");
  assert.equal(u.r.status, 200);
  assert.equal(title(u.h), "BEEE Unit 2 Notes (BT-104) – B.Tech 1st Year | StudyHPD");
  assert.equal(canon(u.h), O + "/subject/sub_beee/unit/u_beee_2");
  assert.equal(lds(u.h)[0].itemListElement.length, 3);

  const d = await html("/document/doc_chem_u2");
  assert.equal(d.r.status, 200);
  assert.equal(title(d.h), "Unit 2 – Chemistry Notes PDF (BT 101) | StudyHPD");
  assert.equal(canon(d.h), O + "/document/doc_chem_u2");
  assert.match(d.h, /<meta property="og:type" content="article">/);
  assert.match(d.h, /Engineering Chemistry/);
  assert.deepEqual(lds(d.h)[0].itemListElement.map(i => i.name), ["Home", "Chemistry", "Unit 2", "Unit 2"]);

  const titles = new Set([s.h, u.h, d.h, (await html("/")).h, (await html("/pricing")).h, (await html("/about")).h, (await html("/contact")).h, (await html("/privacy")).h, (await html("/terms")).h].map(title));
  assert.equal(titles.size, 9, "every public page has a unique title");
});

test("premium documents: title and description only, never a file key or file link", async () => {
  const { r, h } = await html("/document/doc_eng_u5");
  assert.equal(r.status, 200);
  assert.match(title(h), /^Unit 5 – English for Communication Notes PDF/);
  assert.match(h, /Premium PDF/);
  assert.doesNotMatch(h, /SECRETKEY123|docs\/|\/api\/file/);
  const sm = await (await get("/sitemap.xml")).text();
  assert.doesNotMatch(sm, /SECRETKEY123|docs\/|\/api\/file/);
});

test("titles from the database are escaped in HTML and JSON-LD", async () => {
  const { h } = await html("/document/d_xss");
  assert.doesNotMatch(h, /<script>alert/);
  assert.match(h, /Evil &lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
  const bc = lds(h)[0];
  assert.equal(bc.itemListElement.at(-1).name, "Evil </script><script>alert(1)</script> & co");
});

test("unknown, hidden and draft pages are 404 + noindex; private pages are noindex", async () => {
  for (const p of ["/document/nope", "/document/d_draft", "/subject/s_hidden", "/subject/sub_chem/unit/u_beee_1", "/no-such-page"]) {
    const { r, h } = await html(p);
    assert.equal(r.status, 404, p);
    assert.match(h, /<meta name="robots" content="noindex">/, p);
    assert.doesNotMatch(h, /rel="canonical"/, p);
    assert.match(h, /src="\/app\.js"/, p + " still the app (admin can open drafts)");
  }
  for (const p of ["/admin", "/admin/documents", "/login", "/register", "/profile", "/my-subscription"]) {
    const { r, h } = await html(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("x-robots-tag"), "noindex", p);
    assert.match(h, /<meta name="robots" content="noindex">/, p);
  }
  assert.equal((await get("/search?q=beee")).headers.get("x-robots-tag"), "noindex, follow");
  const t = await get("/subject/sub_beee/");
  assert.equal(t.status, 200, "trailing slash");
});

test("deep links never send a 304 to the page shell (blank-page fix kept)", async () => {
  const r = await get("/document/doc_chem_u2", { "if-none-match": '"x"' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("etag"), null);
  assert.match(await r.text(), /<!DOCTYPE html>/);
});

test("robots.txt allows public pages, blocks private ones, points to the sitemap", async () => {
  const r = await get("/robots.txt");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/plain; charset=utf-8/);
  const t = await r.text();
  assert.match(t, /^User-agent: \*$/m); assert.match(t, /^Allow: \/$/m);
  for (const p of ["/admin", "/api/", "/login", "/register", "/profile", "/my-subscription"]) assert.match(t, new RegExp("^Disallow: " + p.replace(/\//g, "\\/") + "$", "m"), p);
  for (const p of ["/api/bootstrap", "/api/documents"]) assert.match(t, new RegExp("^Allow: " + p.replace(/\//g, "\\/") + "$", "m"), p + " (Google needs it to render pages)");
  assert.match(t, /^Sitemap: https:\/\/studyhpd\.example\/sitemap\.xml$/m);
});

test("sitemap.xml lists public pages, subjects, units and published documents with lastmod", async () => {
  const r = await get("/sitemap.xml");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/xml/);
  const x = await r.text();
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...x.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>(\d{4}-\d\d-\d\d)<\/lastmod>/g)].map(m => m[1].replace(O, ""));
  assert.equal(locs.length, (x.match(/<url>/g) || []).length, "every url has a lastmod");
  for (const p of ["/", "/pricing", "/about", "/contact", "/privacy", "/terms", "/subject/sub_chem", "/subject/sub_beee/unit/u_beee_1", "/document/doc_chem_u2", "/document/doc_eng_u5"]) assert.ok(locs.includes(p), p);
  for (const p of ["/document/d_draft", "/subject/s_hidden"]) assert.ok(!locs.includes(p), p);
  assert.ok(!locs.some(p => /admin|login|api/.test(p)));
  assert.match(x, /<loc>https:\/\/studyhpd\.example\/document\/d_xss<\/loc><lastmod>2026-10-30<\/lastmod>/);
});

test("SITE_URL sets the canonical address", async () => {
  env.SITE_URL = "https://www.studyhpd.workers.dev";
  try {
    const { h } = await html("/subject/sub_chem");
    assert.equal(canon(h), "https://www.studyhpd.workers.dev/subject/sub_chem");
    assert.match(h, /og:image" content="https:\/\/www\.studyhpd\.workers\.dev\/og\.png"/);
    assert.match(await (await get("/robots.txt")).text(), /Sitemap: https:\/\/www\.studyhpd\.workers\.dev\/sitemap\.xml/);
  } finally { delete env.SITE_URL; }
});

function session(id, role) {
  sql("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at,email_verified) VALUES(?,?,?,?,?,?,0,1)", id, id, id + "@example.com", "x", "y", role);
  const tok = createHash("sha256").update(id).digest("hex");
  sql("INSERT INTO sessions VALUES(?,?,?)", createHash("sha256").update(tok).digest("hex"), id, Date.now() + 1e7);
  return "sid=" + tok;
}
const post = (p, body, cookie) => worker.fetch(new Request(O + "/api" + p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: O, cookie } }), env);

test("Admin → Settings: Google verification code becomes a meta tag on the site (no redeploy)", async () => {
  const admin = session("seo_admin", "admin"), student = session("seo_student", "student");
  assert.doesNotMatch((await html("/")).h, /google-site-verification/);
  assert.equal((await post("/admin/settings", { google_site_verification: "abc123abc123" }, student)).status, 403, "students cannot set it");
  let r = await post("/admin/settings", { google_site_verification: '<meta name="google-site-verification" content="Ab_C-d1234567890xyz" />' }, admin);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).settings.google_site_verification, "Ab_C-d1234567890xyz", "whole tag pasted: only the code is kept");
  assert.match((await html("/")).h, /<meta name="google-site-verification" content="Ab_C-d1234567890xyz">/);
  r = await post("/admin/settings", { google_site_verification: '"><script>alert(1)</script>' }, admin);
  assert.equal(r.status, 400, "junk is refused");
  assert.equal(one("SELECT value FROM settings WHERE key='google_site_verification'").value, "Ab_C-d1234567890xyz");
  r = await post("/admin/settings", { google_site_verification: "" }, admin);
  assert.equal(r.status, 200);
  assert.doesNotMatch((await html("/")).h, /google-site-verification/, "empty removes it");
});

test("search-engine visits do not inflate document views", async () => {
  const before = one("SELECT views FROM documents WHERE id='doc_chem_u2'").views;
  await worker.fetch(new Request(O + "/api/documents/doc_chem_u2", { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } }), env);
  assert.equal(one("SELECT views FROM documents WHERE id='doc_chem_u2'").views, before);
  await worker.fetch(new Request(O + "/api/documents/doc_chem_u2", { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile" } }), env);
  assert.equal(one("SELECT views FROM documents WHERE id='doc_chem_u2'").views, before + 1);
});

test("app.js uses the same titles as the server, and the unit page exists in the app", () => {
  const a = fs.readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
  assert.match(a, /import \{ pageMeta \} from "\/seo\.js";/);
  assert.match(a, /route\(\/\^\\\/subject\\\/\(\[\\w-\]\+\)\(\?:\\\/unit\\\/\(\[\\w-\]\+\)\)\?\$\//);
  for (const k of ['setMeta("document"', 'setMeta("pricing")', 'setMeta("about")', 'setMeta("contact")', "setMeta(kind)"]) assert.ok(a.includes(k), k);
  assert.match(a, /name="\$\{k\}"|google_site_verification", "Google verification code"/);
  const m = pageMeta("home", { settings: { site_name: "StudyHPD", site_tagline: "B.Tech Notes" } });
  assert.equal(m.title, "StudyHPD – B.Tech Notes"); assert.equal(m.path, "/");
  assert.ok(pageMeta("document", { doc: { id: "d", title: "x".repeat(300), access_level: "free" } }).title.length <= 110);
});

test("index.html: absolute share image, canonical and markers the worker fills", () => {
  assert.match(INDEX, /<!--seo-->[\s\S]*<title>[\s\S]*<!--\/seo-->/);
  assert.match(INDEX, /<!--ssr-->[\s\S]*<!--\/ssr-->/);
  assert.match(INDEX, /og:image" content="https:\/\/www\.studyhpd\.workers\.dev\/og\.png"/);
  assert.match(INDEX, /rel="canonical" href="https:\/\/www\.studyhpd\.workers\.dev\/"/);
  assert.match(INDEX, /<meta charset="utf-8">/);
  const png = fs.readFileSync(new URL("../site/og.png", import.meta.url));
  assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
});
