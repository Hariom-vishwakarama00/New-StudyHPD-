// Razorpay automatic payments: signature checks, webhook idempotency, amount tampering, and the
// manual UPI flow staying unchanged when no keys are saved. Razorpay's API is mocked (no real keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";

function makeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => { if (/^\s*(CREATE|ALTER|PRAGMA)/i.test(sql) && !args.length) db.exec(sql); else { const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; } return { success: true, meta: { changes: 0 } }; },
  });
  // D1 runs a batch as one transaction
  return { _db: db, prepare: sql => stmt(sql), batch: async list => { db.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
}

// ---- mock Razorpay API ----
const KEY_ID = "rzp_test_AbCdEf123456", KEY_SECRET = "test_key_secret_xyz", WH_SECRET = "my-webhook-secret";
const rz = { orders: new Map(), payments: new Map(), calls: [], n: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (!url.startsWith("https://api.razorpay.com/")) return realFetch(url, init);
  const auth = (init.headers || {}).authorization || "";
  rz.calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
  if (auth !== "Basic " + Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64")) return new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }), { status: 401 });
  const path = url.replace("https://api.razorpay.com/v1", "");
  if (path === "/orders" && init.method === "POST") {
    const b = JSON.parse(init.body); const o = { id: "order_T" + (++rz.n), entity: "order", amount: b.amount, currency: b.currency, receipt: b.receipt, status: "created", notes: b.notes };
    rz.orders.set(o.id, o); return Response.json(o);
  }
  if (path.startsWith("/orders?")) return Response.json({ entity: "collection", count: 0, items: [] });
  let mm;
  if ((mm = path.match(/^\/payments\/([\w]+)$/))) { const p = rz.payments.get(mm[1]); return p ? Response.json(p) : new Response(JSON.stringify({ error: { description: "not found" } }), { status: 400 }); }
  if ((mm = path.match(/^\/payments\/([\w]+)\/capture$/))) { const p = rz.payments.get(mm[1]); p.status = "captured"; return Response.json(p); }
  return new Response("{}", { status: 404 });
};
// what Razorpay Checkout does when the student pays
function payOrder(orderId, { amount, status = "captured" } = {}) {
  const o = rz.orders.get(orderId); const id = "pay_T" + (++rz.n);
  rz.payments.set(id, { id, entity: "payment", order_id: orderId, amount: amount ?? o.amount, currency: "INR", status, method: "upi" });
  return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: createHmac("sha256", KEY_SECRET).update(orderId + "|" + id).digest("hex") };
}

const files = new Map();
const env = { EMAIL_MX_CHECK: "off", DB: makeD1(), FILES: { get: async k => files.has(k) ? { body: files.get(k), httpMetadata: {} } : null, put: async (k, v) => files.set(k, v), delete: async k => files.delete(k) }, ASSETS: { fetch: async () => new Response("ok") } };
const W = await import("../site/_worker.js");
const worker = W.default;
const O = "https://studyhpd.example";
const call = (p, { method = "GET", body, cookie, raw, headers = {} } = {}) => worker.fetch(new Request(O + "/api" + p, { method,
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" && !raw ? { origin: O } : {}), "cf-connecting-ip": "10.2.2." + Math.floor(Math.random() * 200), ...headers },
  body: raw != null ? raw : body ? JSON.stringify(body) : undefined }), env);
const q = (sql, ...a) => env.DB._db.prepare(sql).get(...a);
const qa = (sql, ...a) => env.DB._db.prepare(sql).all(...a);

let stu, stu2, adm;
async function register(email) { const r = await call("/auth/register", { method: "POST", body: { name: "S " + email, email, password: "secret1" } }); assert.equal(r.status, 200, await r.clone().text()); return r.headers.get("set-cookie").split(";")[0]; }
function webhook(event, payment, { secret = WH_SECRET, order } = {}) {
  const raw = JSON.stringify({ entity: "event", event, payload: { payment: { entity: payment }, ...(order ? { order: { entity: order } } : {}) } });
  return call("/razorpay/webhook", { method: "POST", raw, headers: { "content-type": "application/json", "x-razorpay-signature": createHmac("sha256", secret).update(raw).digest("hex") } });
}
const premiumUntil = cookieEmail => q("SELECT premium_until FROM users WHERE email=?", cookieEmail).premium_until;

test("setup: users", async () => {
  await call("/bootstrap");
  stu = await register("stu@example.com"); stu2 = await register("stu2@example.com");
  env.DB._db.prepare("INSERT INTO users(id,name,email,pass_hash,salt,role,created_at) VALUES('u_a','A','a@example.com','x','y','admin',0)").run();
  const tok = "c".repeat(64); env.DB._db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(createHash("sha256").update(tok).digest("hex"), "u_a", Date.now() + 1e7);
  adm = "sid=" + tok;
});

test("signature helpers: valid passes, invalid fails", async () => {
  const good = createHmac("sha256", KEY_SECRET).update("order_1|pay_1").digest("hex");
  assert.equal(await W.verifyCheckoutSignature("order_1", "pay_1", good, KEY_SECRET), true);
  assert.equal(await W.verifyCheckoutSignature("order_1", "pay_2", good, KEY_SECRET), false, "other payment id");
  assert.equal(await W.verifyCheckoutSignature("order_1", "pay_1", good, "wrong-secret"), false, "other secret");
  assert.equal(await W.verifyCheckoutSignature("order_1", "pay_1", "", KEY_SECRET), false, "empty");
  assert.equal(await W.verifyCheckoutSignature("order_1", "pay_1", good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"), KEY_SECRET), false, "one char off");
  const body = '{"event":"payment.captured"}';
  assert.equal(await W.verifyWebhookSignature(body, createHmac("sha256", WH_SECRET).update(body).digest("hex"), WH_SECRET), true);
  assert.equal(await W.verifyWebhookSignature(body + " ", createHmac("sha256", WH_SECRET).update(body).digest("hex"), WH_SECRET), false, "body changed");
  assert.equal(await W.verifyWebhookSignature(body, "abc", WH_SECRET), false);
});

test("no keys: manual UPI flow unchanged, Razorpay off", async () => {
  const b = await (await call("/bootstrap", { cookie: stu })).json();
  assert.deepEqual(b.pay, { razorpay: false, key_id: "", mode: "", manual: true });
  const r = await call("/razorpay/order", { method: "POST", cookie: stu, body: { plan_id: "plan_basic" } });
  assert.equal(r.status, 400);
  assert.equal(rz.calls.length, 0, "no call to Razorpay without keys");
  assert.equal((await webhook("payment.captured", { id: "pay_x", order_id: "order_x", amount: 9900, status: "captured" })).status, 503, "webhook refuses without a secret");
  const pay = await call("/payments", { method: "POST", cookie: stu2, body: { plan_id: "plan_basic", utr: "998877665544" } });
  assert.equal(pay.status, 200); const { id, status } = await pay.json(); assert.equal(status, "pending");
  const row = q("SELECT * FROM payments WHERE id=?", id);
  assert.equal(row.utr, "998877665544"); assert.equal(row.amount, 99); assert.equal(row.method, null);
  assert.equal((await call("/admin/payments/" + id + "/approve", { method: "POST", cookie: adm, body: {} })).status, 200);
  assert.ok(premiumUntil("stu2@example.com") > Date.now(), "manual approval still activates");
});

test("admin saves keys: on instantly, secrets never returned or exported", async () => {
  assert.equal((await call("/admin/settings", { method: "POST", cookie: adm, body: { rzp_key_id: "bad_key" } })).status, 400, "key id format checked");
  const r = await call("/admin/settings", { method: "POST", cookie: adm, body: { rzp_key_id: KEY_ID, rzp_key_secret: KEY_SECRET, rzp_webhook_secret: WH_SECRET } });
  assert.equal(r.status, 200);
  const text = await (await call("/admin/settings", { cookie: adm })).text();
  assert.ok(!text.includes(KEY_SECRET) && !text.includes(WH_SECRET), "secrets not in settings response");
  const s = JSON.parse(text).settings;
  assert.equal(s.rzp_key_secret_set, true); assert.equal(s.rzp_webhook_secret_set, true);
  assert.deepEqual({ on: s.rzp_status.on, mode: s.rzp_status.mode, webhook: s.rzp_status.webhook_ready }, { on: true, mode: "test", webhook: true });
  const exp = await (await call("/admin/export", { cookie: adm })).text();
  assert.ok(!exp.includes(KEY_SECRET) && !exp.includes(WH_SECRET), "secrets not in backup");
  const b = await (await call("/bootstrap")).json();
  assert.deepEqual(b.pay, { razorpay: true, key_id: KEY_ID, mode: "test", manual: true });
  assert.ok(!JSON.stringify(b).includes(KEY_SECRET));
  // saving other settings with the secret boxes empty keeps the saved secrets
  await call("/admin/settings", { method: "POST", cookie: adm, body: { site_tagline: "x", rzp_key_secret: "", rzp_webhook_secret: "" } });
  assert.equal(q("SELECT value FROM settings WHERE key='rzp_key_secret'").value, KEY_SECRET);
  assert.equal((await call("/admin/razorpay/check", { method: "POST", cookie: adm, body: {} })).status, 200, "check keys works");
  // hide-manual toggle
  await call("/admin/settings", { method: "POST", cookie: adm, body: { rzp_hide_manual: "1" } });
  assert.equal((await (await call("/bootstrap")).json()).pay.manual, false);
  await call("/admin/settings", { method: "POST", cookie: adm, body: { rzp_hide_manual: "0" } });
  assert.equal((await (await call("/bootstrap")).json()).pay.manual, true);
});

test("amount tamper rejected: order amount always comes from the plan in D1", async () => {
  const before = rz.calls.length;
  const r = await call("/razorpay/order", { method: "POST", cookie: stu, body: { plan_id: "plan_pro", amount: 100, price: 1, amount_paise: 100 } });
  assert.equal(r.status, 200); const o = await r.json();
  assert.equal(o.amount, 19900); assert.equal(o.key_id, KEY_ID);
  const sent = rz.calls.slice(before).find(c => c.url.endsWith("/v1/orders"));
  assert.equal(sent.body.amount, 19900, "Razorpay was asked for the plan price, not the client's number");
  assert.equal(q("SELECT amount_paise FROM rzp_orders WHERE order_id=?", o.order_id).amount_paise, 19900);
  // a payment for less than the order (e.g. a tampered/partial amount) does not activate
  const pr = payOrder(o.order_id, { amount: 100 });
  const v = await call("/razorpay/verify", { method: "POST", cookie: stu, body: pr });
  assert.equal(v.status, 400);
  assert.ok(!(premiumUntil("stu@example.com") > Date.now()), "no premium");
  const w = await (await webhook("payment.captured", rz.payments.get(pr.razorpay_payment_id))).json();
  assert.equal(w.ok, false); assert.equal(w.reason, "amount_mismatch");
  assert.equal(q("SELECT COUNT(*) n FROM payments WHERE gateway_order_id=?", o.order_id).n, 0);
  assert.equal((await call("/razorpay/order", { method: "POST", cookie: stu, body: { plan_id: "nope" } })).status, 400);
});

test("checkout success: bad signature refused, good one activates instantly, repeat is a no-op", async () => {
  const o = await (await call("/razorpay/order", { method: "POST", cookie: stu, body: { plan_id: "plan_basic" } })).json();
  const pr = payOrder(o.order_id, { status: "authorized" });
  const bad = await call("/razorpay/verify", { method: "POST", cookie: stu, body: { ...pr, razorpay_signature: "0".repeat(64) } });
  assert.equal(bad.status, 400);
  assert.equal((await call("/razorpay/verify", { method: "POST", cookie: stu2, body: pr })).status, 404, "another student can't claim it");
  const t0 = Date.now();
  const ok = await call("/razorpay/verify", { method: "POST", cookie: stu, body: pr });
  assert.equal(ok.status, 200, await ok.clone().text());
  const d = await ok.json();
  assert.equal(d.me.premium, true); assert.equal(d.already, false);
  const exp = new Date(t0); exp.setUTCMonth(exp.getUTCMonth() + 1);
  assert.ok(Math.abs(d.premium_until - exp.getTime()) < 5000, "1 month from now");
  assert.equal(rz.payments.get(pr.razorpay_payment_id).status, "captured", "authorized payment was captured");
  const row = q("SELECT * FROM payments WHERE gateway_order_id=?", o.order_id);
  assert.deepEqual({ method: row.method, status: row.status, pid: row.gateway_payment_id, amount: row.amount, months: row.months }, { method: "razorpay", status: "approved", pid: pr.razorpay_payment_id, amount: 99, months: 1 });
  const again = await (await call("/razorpay/verify", { method: "POST", cookie: stu, body: pr })).json();
  assert.equal(again.already, true); assert.equal(again.premium_until, d.premium_until, "no double time");
  // the webhook arriving after the checkout callback changes nothing
  await webhook("payment.captured", rz.payments.get(pr.razorpay_payment_id));
  await webhook("order.paid", rz.payments.get(pr.razorpay_payment_id), { order: { id: o.order_id, amount: 9900, amount_paid: 9900, status: "paid" } });
  assert.equal(premiumUntil("stu@example.com"), d.premium_until);
  assert.equal(q("SELECT COUNT(*) n FROM payments WHERE gateway_order_id=?", o.order_id).n, 1);
  // student + admin lists show it
  const mine = (await (await call("/payments", { cookie: stu })).json()).payments.find(p => p.method === "razorpay");
  assert.equal(mine.gateway_payment_id, pr.razorpay_payment_id); assert.equal(mine.status, "approved");
  const al = (await (await call("/admin/payments?status=approved", { cookie: adm })).json()).payments.find(p => p.gateway_payment_id === pr.razorpay_payment_id);
  assert.ok(al && al.method === "razorpay");
});

test("webhook: tab closed before callback still activates; duplicates are idempotent; time added on top", async () => {
  const startUntil = premiumUntil("stu@example.com");
  const o = await (await call("/razorpay/order", { method: "POST", cookie: stu, body: { plan_id: "plan_premium" } })).json();
  const pr = payOrder(o.order_id);
  // forged webhook first
  assert.equal((await webhook("payment.captured", rz.payments.get(pr.razorpay_payment_id), { secret: "wrong" })).status, 400);
  assert.equal(premiumUntil("stu@example.com"), startUntil);
  // real ones: payment.captured and order.paid, each delivered twice, in parallel
  const p = rz.payments.get(pr.razorpay_payment_id), ord = { id: o.order_id, amount: 29900, amount_paid: 29900, status: "paid" };
  const res = await Promise.all([webhook("payment.captured", p), webhook("order.paid", p, { order: ord }), webhook("payment.captured", p), webhook("order.paid", p, { order: ord })]);
  for (const r of res) assert.equal(r.status, 200);
  const outs = await Promise.all(res.map(r => r.json()));
  assert.equal(outs.filter(x => x.activated).length, 1, "exactly one activation");
  assert.equal(q("SELECT COUNT(*) n FROM payments WHERE gateway_order_id=?", o.order_id).n, 1);
  const exp = new Date(startUntil); exp.setUTCMonth(exp.getUTCMonth() + 6);
  assert.ok(Math.abs(premiumUntil("stu@example.com") - exp.getTime()) < 2000, "6 months added on top of the time left");
  assert.equal(q("SELECT plan_name FROM users WHERE email='stu@example.com'").plan_name, "Premium");
  // the student's page polling the order sees it paid; the late checkout callback is a no-op
  assert.equal((await (await call("/razorpay/order/" + o.order_id, { cookie: stu })).json()).status, "paid");
  const late = await (await call("/razorpay/verify", { method: "POST", cookie: stu, body: pr })).json();
  assert.equal(late.already, true);
  assert.ok(Math.abs(premiumUntil("stu@example.com") - exp.getTime()) < 2000);
  // events we don't handle, and unknown orders, are acknowledged without changes
  assert.equal((await (await webhook("payment.failed", { id: "pay_f", order_id: o.order_id, status: "failed" })).json()).ignored, "payment.failed");
  assert.equal((await (await webhook("payment.captured", { id: "pay_u", order_id: "order_unknown", amount: 9900, status: "captured" })).json()).reason, "unknown_order");
});

test("removing keys returns to manual-only", async () => {
  await call("/admin/settings", { method: "POST", cookie: adm, body: { clear_rzp: "1" } });
  const b = await (await call("/bootstrap")).json();
  assert.equal(b.pay.razorpay, false); assert.equal(b.pay.manual, true);
  assert.equal((await call("/razorpay/order", { method: "POST", cookie: stu, body: { plan_id: "plan_basic" } })).status, 400);
});
