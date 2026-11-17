// StudyHPD: blocks temporary / disposable email addresses at signup.
// Three checks, cheapest first:
//   1. a bundled list of ~10k disposable domains (disposable-domains.js), parent domains included
//   2. name patterns of common temp-mail services (catches new domains of the same services)
//   3. a DNS MX lookup over Cloudflare DNS-over-HTTPS: a domain that doesn't exist, has no mail
//      server, or says "no mail here" (null MX) can't receive our code, so it's refused.
// If the DNS lookup itself fails or times out, the email is allowed (we never block real users
// because DNS was slow). Existing accounts are never checked.
import { DISPOSABLE_DOMAINS_TEXT } from "./disposable-domains.js";

export const TEMP_MAIL_MSG = "Temporary/fake email allowed nahi hai. Apna asli Gmail ya college email use karo.";
// for a domain that can't receive email at all (doesn't exist / no mail server), usually a typo or a made-up address
export const NO_MAIL_MSG = "Ye email asli nahi lag raha (is domain pe email nahi aa sakta). Spelling check karo, ya apna asli Gmail ya college email use karo.";

let LIST = null;
const list = () => LIST || (LIST = new Set(DISPOSABLE_DOMAINS_TEXT.split("\n").map(s => s.trim()).filter(Boolean)));

// Extra temp-mail domains not always in the public list.
const EXTRA_DOMAINS = ["mail.tm", "mail.gw", "1secmail.com", "1secmail.net", "1secmail.org", "temp-mail.io", "tempmail.com", "tempmail.net",
  "tempmail.dev", "tempmail.plus", "tmail.ws", "tmailor.com", "internxt.com", "emailnator.com", "smailpro.com", "fakemail.net", "mailtemp.net",
  "tempmailo.com", "tempm.com", "tmpmail.org", "tmpmail.net", "minuteinbox.com", "tempail.com", "emailtemporanea.net", "inboxes.com"];
// Substrings that only appear in temp-mail service names.
export const TEMP_PATTERNS = ["mailinator", "10minutemail", "10minmail", "20minutemail", "30minutemail", "minutemail", "minuteinbox",
  "temp-mail", "tempmail", "temp-email", "tempemail", "tmpmail", "tmp-mail", "tempinbox", "temp-inbox", "tempail", "tmpeml",
  "guerrillamail", "guerillamail", "sharklasers", "grr.la", "yopmail", "throwawaymail", "throwaway-mail", "trashmail", "trash-mail",
  "dispostable", "disposablemail", "disposable-mail", "fakeinbox", "fakemail", "fake-mail", "fakermail", "emailfake", "emailondeck",
  "getnada", "maildrop.cc", "mailnesia", "mohmal", "burnermail", "mintemail", "mailcatch", "spamgourmet", "spambox", "mailpoof",
  "harakirimail", "dropmail", "1secmail", "inboxkitten", "emailnator", "mytemp.email", "crazymailing", "mailtemp", "luxusmail", "byom.de"];

// Big providers: never on any list and always have MX, so skip the DNS lookup for them.
const KNOWN_GOOD = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "ymail.com", "rocketmail.com",
  "outlook.com", "outlook.in", "hotmail.com", "hotmail.co.in", "live.com", "live.in", "msn.com", "icloud.com", "me.com", "mac.com",
  "rediffmail.com", "protonmail.com", "proton.me", "pm.me", "zoho.com", "zohomail.in", "aol.com", "gmx.com", "yandex.com", "mail.com"]);

export function emailDomain(email) {
  const at = String(email || "").lastIndexOf("@");
  return at < 0 ? "" : String(email).slice(at + 1).trim().toLowerCase().replace(/\.+$/, "");
}

// -> null when fine, or "list" / "pattern"
export function disposableReason(domain) {
  domain = String(domain || "").toLowerCase().replace(/\.+$/, "");
  if (!domain) return null;
  if (KNOWN_GOOD.has(domain)) return null;
  const parts = domain.split(".");
  const set = list();
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join(".");
    if (set.has(d) || EXTRA_DOMAINS.includes(d)) return "list";
  }
  if (TEMP_PATTERNS.some(p => domain.includes(p))) return "pattern";
  return null;
}
export const isDisposableDomain = domain => !!disposableReason(domain);

const MX_CACHE = new Map(); // domain -> { r, t }
const MX_TTL = 60 * 60 * 1000;
const DOH_URL = "https://cloudflare-dns.com/dns-query";

// -> "ok" | "nxdomain" | "no_mx" | "null_mx" | "unknown" (lookup failed: treated as ok)
export async function mxStatus(domain, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const hit = MX_CACHE.get(domain);
  if (hit && Date.now() - hit.t < MX_TTL) return hit.r;
  let r = "unknown";
  try {
    const res = await fetchImpl(DOH_URL + "?name=" + encodeURIComponent(domain) + "&type=MX", {
      headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const j = await res.json();
      if (j.Status === 3) r = "nxdomain";
      else if (j.Status === 0) {
        const mx = (j.Answer || []).filter(a => a.type === 15).map(a => String(a.data || "").trim().split(/\s+/));
        if (!mx.length) r = "no_mx";
        else if (mx.every(([, host]) => !host || host === ".")) r = "null_mx"; // RFC 7505: "this domain takes no mail"
        else r = "ok";
      }
    }
  } catch { r = "unknown"; }
  if (r !== "unknown") { MX_CACHE.set(domain, { r, t: Date.now() }); if (MX_CACHE.size > 2000) MX_CACHE.clear(); }
  return r;
}

// Full signup check. env.EMAIL_MX_CHECK = "off" skips the DNS step (tests / emergencies).
export async function checkSignupEmail(email, env = {}, opts = {}) {
  const domain = emailDomain(email);
  const why = disposableReason(domain);
  if (why) return { ok: false, reason: why, domain, message: TEMP_MAIL_MSG };
  if (opts.mx === false || String(env.EMAIL_MX_CHECK || "").toLowerCase() === "off" || KNOWN_GOOD.has(domain)) return { ok: true, domain };
  const mx = await mxStatus(domain, opts);
  if (mx === "nxdomain" || mx === "no_mx" || mx === "null_mx") return { ok: false, reason: mx, domain, message: NO_MAIL_MSG };
  return { ok: true, domain, mx };
}
