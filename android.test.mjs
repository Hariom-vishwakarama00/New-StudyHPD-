// Android app (Trusted Web Activity) support: Digital Asset Links + installable web manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const env = { ASSETS: { fetch: async () => new Response("<!doctype html><title>x</title>", { headers: { "content-type": "text/html" } }) } };
const mod = await import("../site/_worker.js");
const O = "https://studyhpd.example";

test("/.well-known/assetlinks.json is served as JSON for com.studyhpd.app, with security headers kept", async () => {
  const r = await mod.default.fetch(new Request(O + "/.well-known/assetlinks.json"), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^application\/json/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("strict-transport-security") || "", /max-age=/);
  assert.equal(r.headers.get("location"), null); // no redirect: Android refuses redirected asset links
  const body = await r.json();
  assert.equal(body.length, 1);
  assert.deepEqual(body[0].relation, ["delegate_permission/common.handle_all_urls"]);
  assert.equal(body[0].target.namespace, "android_app");
  assert.equal(body[0].target.package_name, "com.studyhpd.app");
  assert.ok(body[0].target.sha256_cert_fingerprints.length >= 1);
  for (const fp of body[0].target.sha256_cert_fingerprints) assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test("web manifest has 512px + maskable icons, theme colour and standalone display", () => {
  const m = JSON.parse(readFileSync(new URL("../site/manifest.json", import.meta.url), "utf8"));
  assert.equal(m.name, "StudyHPD"); assert.equal(m.display, "standalone"); assert.equal(m.start_url, "/");
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.ok(m.icons.some(i => i.sizes === "512x512" && (i.purpose || "any").includes("any")));
  assert.ok(m.icons.some(i => i.sizes === "512x512" && i.purpose === "maskable"));
  for (const i of m.icons) {
    const png = readFileSync(new URL("../site" + i.src, import.meta.url));
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    assert.equal(`${w}x${h}`, i.sizes, i.src);
  }
});
