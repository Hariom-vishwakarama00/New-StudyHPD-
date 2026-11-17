// Offline mode was removed. These tests keep it removed, check the /sw.js kill-switch that cleans phones
// which installed the old offline service worker, and keep the deep-link blank-page fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SITE = new URL("../site/", import.meta.url);
const read = f => fs.readFileSync(new URL(f, SITE), "utf8");
const O = "https://studyhpd.example";
const mod = await import("../site/_worker.js");

test("no offline UI or offline code is left in the app", () => {
  assert.ok(!fs.existsSync(new URL("offline.js", SITE)), "offline.js is gone");
  const a = read("app.js");
  for (const s of ["offline.js", "Aap offline hain", "Internet slow", "Offline me save karo", "Saved notes", "/saved", "Wapas online", "Naya update aaya", "serviceWorker.register("])
    assert.ok(!a.includes(s), "app.js still has: " + s);
  assert.match(a, /for \(const k of await caches\.keys\(\)\) await caches\.delete\(k\)/, "old offline caches are deleted by the page too");
  assert.match(a, /for \(const r of await navigator\.serviceWorker\.getRegistrations\(\)\) await r\.unregister\(\)/, "leftover registrations are removed");
  assert.match(a, /wipeOffline\(\); setTimeout\(wipeOffline, 6000\);/);
  const c = read("styles.css");
  for (const s of [".notice.offline", ".offbar", ".updbar", ".saved-link"]) assert.ok(!c.includes(s), "styles.css still has: " + s);
});

function runKillSwitch() {
  const handlers = {}, deleted = [], navigated = [], log = [];
  const ALL = ["shpd-shell-abc", "shpd-api-v1", "shpd-pdf-free", "shpd-pdf-prem"], cacheNames = [...ALL];
  const ctx = {
    self: {
      addEventListener: (t, f) => (handlers[t] = f),
      skipWaiting: async () => log.push("skipWaiting"),
      registration: { unregister: async () => { log.push("unregister"); return true; } },
      clients: {
        claim: async () => log.push("claim"),
        matchAll: async () => [{ url: O + "/document/d1", navigate: async u => navigated.push(u) }, { url: O + "/", navigate: async u => navigated.push(u) }],
      },
    },
    caches: { keys: async () => [...cacheNames], delete: async n => { deleted.push(n); cacheNames.splice(cacheNames.indexOf(n), 1); return true; } },
  };
  ctx.setTimeout = (f) => setTimeout(f, 0);
  vm.createContext(ctx);
  vm.runInContext(read("sw.js"), ctx);
  return { handlers, deleted, navigated, log, cacheNames, ALL };
}
test("kill-switch /sw.js: takes over at once, deletes ALL caches (saved PDFs too), unregisters, reloads pages once", async () => {
  const k = runKillSwitch();
  assert.equal(k.handlers.fetch, undefined, "it never answers requests");
  k.handlers.install({});
  assert.deepEqual(k.log, ["skipWaiting"]);
  let p; k.handlers.activate({ waitUntil: x => (p = x) }); await p;   // includes the 4 s second sweep
  assert.deepEqual([...k.deleted].sort(), [...k.ALL].sort()); assert.deepEqual(k.cacheNames, [], "no cache left");
  assert.ok(k.log.indexOf("unregister") > 0, "unregisters itself");
  assert.deepEqual(k.navigated, [O + "/document/d1", O + "/"], "each open page reloaded once");
});

test("/sw.js is served by the worker with no-cache (so old phones pick up the kill-switch)", async () => {
  const src = read("sw.js");
  const env = { ASSETS: { fetch: async r => new URL(r.url).pathname === "/sw.js" ? new Response(src, { headers: { "content-type": "application/javascript" } }) : new Response("nf", { status: 404 }) } };
  const res = await mod.default.fetch(new Request(O + "/sw.js"), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /no-cache/);
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.equal(await res.text(), src);
  assert.match(fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"), /run_worker_first = \[[^\]]*"\/sw\.js"/);
});

test("reopening a deep link never gets an empty page (a 304 for the shell is not turned into an empty 200)", async () => {
  const shell = "<!doctype html><title>StudyHPD</title><main id=main></main>";
  const env = { ASSETS: { fetch: async r => { const p = new URL(r.url).pathname;
    if (p !== "/") return new Response("nf", { status: 404 });
    if (r.headers.get("if-none-match")) return new Response(null, { status: 304, headers: { etag: '"abc"' } });
    return new Response(shell, { headers: { "content-type": "text/html", etag: '"abc"' } }); } } };
  const res = await mod.default.fetch(new Request(O + "/document/doc1", { headers: { "if-none-match": '"abc"', accept: "text/html" } }), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), shell);
  assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
});
