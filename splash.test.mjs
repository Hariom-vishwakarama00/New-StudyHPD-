// Brand splash: the Android app's first paint is the purple StudyHPD screen (no white flash after the native
// splash), it never blocks, and it needs no service worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const S = path.join(ROOT, "site");
const read = f => fs.readFileSync(path.join(S, f), "utf8");

test("index.html paints the brand splash first: boot.js in <head>, splash right after <body>", () => {
  const h = read("index.html"), head = h.split("</head>")[0];
  assert.match(head, /<script src="\/boot\.js"><\/script>/);
  assert.doesNotMatch(head, /<script src="\/boot\.js"[^>]*(async|defer|type="module")/, "boot.js must run before first paint");
  assert.match(h, /<body>\n<div id="boot-splash" aria-hidden="true">/);
  for (const s of ["StudyHPD", "B.Tech Notes &amp; Study Material", "/img/splash-mark.png"]) assert.ok(h.includes(s), s);
  assert.ok(fs.existsSync(path.join(S, "img/splash-mark.png")));
  assert.doesNotMatch(h, /<script>(?!<\/script>)/, "no inline script (CSP script-src 'self')");
});
test("the splash never blocks: hidden by default, ignores taps, fades itself out", () => {
  const h = read("index.html");
  assert.match(h, /#boot-splash\{display:none\}/);
  assert.match(h, /\.app-boot #boot-splash\{[^}]*pointer-events:none/);
  assert.match(h, /\.app-boot #boot-splash\{[^}]*animation:bs-out [^}]*\d+s forwards/);
  assert.match(h, /\.app-boot\.booted #boot-splash\{opacity:0;visibility:hidden\}/);
  assert.match(h, /#4f46e5/);
});
function runBoot({ standalone = false, referrer = "", stored = null } = {}) {
  const store = new Map(stored ? [["shpd-app", stored]] : []), timers = [];
  const document = { documentElement: { className: "" }, referrer };
  const window = {
    matchMedia: q => ({ matches: standalone && /standalone/.test(q) }),
    navigator: {}, sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  vm.runInNewContext(read("boot.js"), { window, document, setTimeout: (f, ms) => timers.push([f, ms]) });
  return { cls: document.documentElement.className, store, timers, html: document.documentElement };
}
test("boot.js turns the splash on only inside the app (TWA referrer / standalone), with a safety timeout", () => {
  assert.equal(runBoot().cls, "", "plain browser visit: no splash");
  const twa = runBoot({ referrer: "android-app://com.studyhpd.app/" });
  assert.match(twa.cls, /app-boot/); assert.equal(twa.store.get("shpd-app"), "1");
  assert.ok(twa.timers.some(([, ms]) => ms <= 6000), "self-removal timer");
  twa.timers[0][0](); // safety net fires
  assert.match(twa.html.className, /app-boot booted/);
  assert.match(runBoot({ standalone: true }).cls, /app-boot/);
  assert.match(runBoot({ stored: "1" }).cls, /app-boot/, "reloads inside the app keep it");
});
test("app.js removes the splash as soon as the first page renders (and on a load error), max 2.5 s", () => {
  const a = read("app.js");
  assert.match(a, /function hideSplash\(\)/);
  assert.match(a, /render\(\)\.finally\(hideSplash\)/);
  assert.match(a, /setTimeout\(hideSplash, 2500\)/);
  assert.match(a, /Could not load\. Please refresh\.[\s\S]{0,120}hideSplash\(\); return;/);
});
test("splash works with no service worker: app.js registers none and the splash files are plain static files", () => {
  const a = read("app.js");
  assert.doesNotMatch(a, /serviceWorker\.register\(/);
  assert.doesNotMatch(a, /offline\.js/);
  for (const f of ["boot.js", "img/splash-mark.png"]) assert.ok(fs.existsSync(path.join(ROOT, "site", f)), f);
  assert.match(read("index.html"), /<script src="\/boot\.js"><\/script>/);
});
test("web manifest background matches the brand splash", () => {
  assert.equal(JSON.parse(read("manifest.json")).background_color, "#4f46e5");
});
test("Android project: brand splash on every Android version, version 1.0.1 (code 2)", () => {
  const A = path.join(ROOT, "android");
  if (!fs.existsSync(A)) return; // site-only checkout
  const g = fs.readFileSync(path.join(A, "app/build.gradle"), "utf8");
  assert.match(g, /versionCode 2\b/); assert.match(g, /versionName "1\.0\.1"/); assert.match(g, /backgroundColor: '#4F46E5'/);
  const m = fs.readFileSync(path.join(A, "app/src/main/AndroidManifest.xml"), "utf8");
  assert.match(m, /<activity android:name="LauncherActivity"\s+android:theme="@style\/Theme\.StudyHPD\.Splash"/);
  assert.match(m, /SPLASH_IMAGE_DRAWABLE"\s+android:resource="@drawable\/splash"/);
  const v31 = fs.readFileSync(path.join(A, "app/src/main/res/values-v31/styles.xml"), "utf8");
  for (const k of ["windowSplashScreenBackground", "windowSplashScreenAnimatedIcon", "windowBackground"]) assert.ok(v31.includes(k), k);
  for (const d of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
    assert.ok(fs.existsSync(path.join(A, `app/src/main/res/drawable-${d}/splash.png`)), d);
    assert.ok(fs.existsSync(path.join(A, `app/src/main/res/drawable-${d}/splash_icon.png`)), d);
  }
  assert.ok(!fs.readdirSync(A).some(f => /\.(keystore|jks)$/.test(f)), "no keystore in the project");
});
