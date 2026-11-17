// File storage: R2 (FILES) is the default; KV (FILES_KV) is the free fallback; both bound = R2 first, KV for old files.
import { test } from "node:test";
import assert from "node:assert/strict";
const { fileStore } = await import("../site/_worker.js");

const text = async body => new Response(body).text();
function mockKV() {
  const m = new Map();
  return { m,
    put: async (k, v, o) => m.set(k, { v: await text(v), meta: o && o.metadata }),
    getWithMetadata: async k => m.has(k) ? { value: new Blob([m.get(k).v]).stream(), metadata: m.get(k).meta } : { value: null, metadata: null },
    delete: async k => { m.delete(k); } };
}
function mockR2() {
  const m = new Map();
  return { m,
    put: async (k, v, o) => m.set(k, { v: await text(v), ct: o.httpMetadata.contentType }),
    get: async k => m.has(k) ? { body: m.get(k).v, httpMetadata: { contentType: m.get(k).ct } } : null,
    delete: async k => { m.delete(k); } };
}
const stream = s => new Blob([s]).stream();

test("KV only: put, get with content type, delete, 25 MB cap", async () => {
  const kv = mockKV(); const fs = fileStore({ FILES_KV: kv });
  assert.equal(fs.kind, "kv"); assert.equal(fs.maxBytes, 25 * 1024 * 1024);
  await fs.put("docs/a.pdf", stream("%PDF a"), "application/pdf");
  const o = await fs.get("docs/a.pdf");
  assert.equal(o.httpMetadata.contentType, "application/pdf");
  assert.equal(await text(o.body), "%PDF a");
  assert.equal(await fs.get("docs/missing.pdf"), null);
  await fs.delete("docs/a.pdf"); assert.equal(await fs.get("docs/a.pdf"), null);
});

test("R2 is preferred; old files still read from KV when both are bound", async () => {
  const kv = mockKV(), r2 = mockR2();
  await kv.put("docs/old.pdf", stream("old"), { metadata: { contentType: "application/pdf" } });
  const fs = fileStore({ FILES: r2, FILES_KV: kv });
  assert.equal(fs.kind, "r2");
  await fs.put("docs/new.pdf", stream("new"), "application/pdf");
  assert.ok(r2.m.has("docs/new.pdf")); assert.ok(!kv.m.has("docs/new.pdf"));
  assert.equal(await text((await fs.get("docs/old.pdf")).body), "old");
  await fs.delete("docs/old.pdf"); assert.ok(!kv.m.has("docs/old.pdf"));
});

test("no storage bound gives a clear error", async () => {
  assert.throws(() => fileStore({}), /File storage is not set up/);
});
