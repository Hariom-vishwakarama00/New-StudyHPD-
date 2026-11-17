import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const S = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "site");
const read = f => fs.readFileSync(path.join(S, f), "utf8");

test("index has title, viewport and local assets", () => {
  const h = read("index.html");
  assert.match(h, /<title>StudyHPD/);
  assert.match(h, /name="viewport" content="width=device-width/);
  for (const m of h.matchAll(/(?:src|href)="(\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(S, m[1])), "missing " + m[1]);
});
test("app covers every page of the original", () => {
  const a = read("app.js");
  for (const r of ["search", "subject", "document", "pricing", "my-subscription", "profile", "login", "register", "forgot-password", "about", "contact", "admin\\/login", "admin\\/setup"]) assert.ok(a.includes(r.replace("\\/", "/")), r);
  for (const s of ["Browse Categories", "Free Notes", "Premium Notes", "Unlock All Premium Content", "Subscription Plans", "Pay via UPI", "UTR"]) assert.ok(a.includes(s), s);
});
test("backend seeds the original catalogue and plans", () => {
  const w = read("_worker.js");
  for (const s of ["BT 101", "BT 103", "BT-104", "BEEE", "Chemistry", "English for Communication", "Question Banks", "Previous Year Papers", "Lab Manuals", "9424817696@fam"]) assert.ok(w.includes(s), s);
  assert.match(w, /"Basic",99,1/); assert.match(w, /"Pro",199,3/); assert.match(w, /"Premium",299,6/);
});
test("premium files are gated and no setup token is in the code", () => {
  const w = read("_worker.js");
  assert.match(w, /d\.access_level !== "free" && !isPremium\(user\)\) return err\(403/);
  assert.match(w, /SETUP_TOKEN_HASHES = \[("[0-9a-f]{64}",? ?)*\]/);
});
test("no placeholders left", () => {
  for (const f of ["index.html", "app.js", "styles.css"]) assert.doesNotMatch(read(f), /lorem ipsum|TODO|__SETUP_HASH__/i, f);
});

test("privacy and terms pages exist, are linked, and say what the app really does", () => {
  const a = read("app.js");
  assert.match(a, /route\(\/\^\\\/\(privacy\|privacy-policy\)\$\//);
  assert.match(a, /route\(\/\^\\\/\(terms\|terms-of-service/);
  assert.match(a, /class="legal-links"[^`]*href="\/privacy"[^`]*href="\/terms"/, "footer links");
  assert.match(a, /class="dev-by">Developed by <span>Hariom Vishwakarama<\/span>/, "footer credit");
  { const f = a.slice(a.indexOf('$("#footer").innerHTML'), a.indexOf("All rights reserved")); assert.ok(f.length > 0 && !/<nav>/.test(f) && !/NAV/.test(f), "footer nav links removed"); }
  assert.match(a, /agree to our"\} <a href="\/terms">Terms of Service<\/a> and <a href="\/privacy">Privacy Policy<\/a>/, "login/register links");
  for (const s of ["Google account ID", "UTR", "payment screenshot", "reviewed by hand", "\"sid\"", "card numbers", "laws of India", "contact us at {contact}", "Google's own privacy policy"]) assert.ok(a.includes(s), s);
  assert.doesNotMatch(a, /ISO 27001|SOC ?2|GDPR[- ]certified|PCI[- ]DSS/i, "no certification claims");
  assert.doesNotMatch(a.slice(a.indexOf("const LEGAL_DEFAULT"), a.indexOf("const legalContact")), /\d+\s*(days?|%)\s*(refund|money)|refund within/i, "no invented refund policy");
  assert.match(read("_worker.js"), /"privacy_text","terms_text"\]/, "editable from Admin → Settings");
});
