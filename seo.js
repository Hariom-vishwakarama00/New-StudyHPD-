// StudyHPD — page titles, descriptions and links for search engines.
// Shared by the worker (_worker.js puts them into the HTML for Google) and app.js (keeps the tab title in step while browsing),
// so both always say the same thing. Pure functions only: no secrets, no file links.

const sp = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
export const clip = (s, n) => { s = sp(s); return s.length <= n ? s : s.slice(0, n - 1).replace(/[\s,;:–-]+\S*$/, "") + "…"; };
const has = (a, b) => !!b && sp(a).toLowerCase().includes(sp(b).toLowerCase());

export const subjectPath = s => "/subject/" + s.id;
export const unitPath = u => "/subject/" + u.subject_id + "/unit/" + u.id;
export const docPath = d => "/document/" + d.id;

// How students actually search for some subjects (used in descriptions only; the subject keeps the admin's name).
const ALIAS = { chemistry: "Engineering Chemistry", physics: "Engineering Physics", mathematics: "Engineering Mathematics", maths: "Engineering Mathematics",
  beee: "BEEE (Basic Electrical & Electronics Engineering)", "english for communication": "English for Communication (Communication Skills)" };
const alias = s => ALIAS[sp(s.name).toLowerCase()] || sp(s.name);
const course = s => { const c = sp(s.course) || "B.Tech", y = sp(s.year).replace(/\byear\b/i, "Year"); return y ? c + " " + y : c; };
const codeP = s => sp(s.code) ? " (" + sp(s.code) + ")" : "";
const kindOf = c => !c || c.slug === "premium" ? "Notes" : sp(c.name);

// kind: home | pricing | about | contact | privacy | terms | subject | unit | document | search | private | notfound
// ctx: { settings, subject, unit, doc, category, subjects, units, docs, plans }
export function pageMeta(kind, ctx = {}) {
  const st = ctx.settings || {}, brand = sp(st.site_name) || "StudyHPD";
  const tagline = sp(st.site_tagline) || "B.Tech Notes, Important Questions & Study Material";
  const s = ctx.subject, u = ctx.unit, d = ctx.doc;
  const crumbs = [["Home", "/"]];
  let title, description, path, robots = "index, follow";
  if (kind === "home") {
    const names = (ctx.subjects || []).slice(0, 4).map(x => sp(x.name)).filter(Boolean);
    title = brand + " – " + tagline;
    description = brand + ": B.Tech notes PDF, important questions, previous year papers and lab manuals – subject-wise and unit-wise" +
      (names.length ? " (" + names.join(", ") + ")" : "") + ". Free notes plus premium plans via UPI.";
    path = "/";
  } else if (kind === "subject") {
    const units = (ctx.units || []).map(x => sp(x.name)).filter(Boolean);
    title = sp(s.name) + " Notes PDF" + codeP(s) + " – " + course(s) + " | " + brand;
    description = alias(s) + " notes PDF" + codeP(s) + " for " + course(s) + (sp(s.semester) ? ", " + sp(s.semester) : "") +
      ": unit-wise notes, important questions and previous year papers" + (units.length ? " – " + units.join(", ") : "") + ".";
    for (const extra of [sp(s.description) && sp(s.description).replace(/[.!]+$/, "") + ".", "Free and premium notes on " + brand + "."])
      if (extra && description.length + extra.length + 1 <= 230) description += " " + extra;
    path = subjectPath(s); crumbs.push([sp(s.name), path]);
  } else if (kind === "unit") {
    const titles = (ctx.docs || []).slice(0, 4).map(x => has(x.title, u.name) && sp(x.description) ? sp(x.description) : sp(x.title)).filter(Boolean);
    title = sp(s.name) + " " + sp(u.name) + " Notes" + codeP(s) + " – " + course(s) + " | " + brand;
    description = alias(s) + " " + sp(u.name) + " notes PDF" + codeP(s) + " for " + course(s) + (sp(s.semester) ? ", " + sp(s.semester) : "") +
      (titles.length ? ": " + titles.join(", ") : "") + ". Read unit-wise notes and important questions on " + brand + ".";
    path = unitPath(u); crumbs.push([sp(s.name), subjectPath(s)], [sp(u.name), path]);
  } else if (kind === "document") {
    const kd = kindOf(ctx.category), t = sp(d.title), prem = d.access_level !== "free";
    let lead = t;
    if (s && !has(t, s.name)) lead += " – " + sp(s.name);
    if (u && !has(lead, u.name)) lead += " " + sp(u.name);
    title = lead + (has(lead, kd) ? "" : " " + kd) + " PDF" + (s ? codeP(s) : "") + " | " + brand;
    description = (sp(d.description) ? sp(d.description).replace(/[.!]+$/, "") + ". " : "") +
      [s && alias(s), u && sp(u.name), kd.toLowerCase()].filter(Boolean).join(" ") + (s ? " for " + course(s) : "") + ". " +
      (prem ? "Premium PDF – unlock with a " + brand + " plan." : "Free PDF – read online on " + brand + ".");
    path = docPath(d);
    if (s) crumbs.push([sp(s.name), subjectPath(s)]);
    if (s && u) crumbs.push([sp(u.name), unitPath(u)]);
    crumbs.push([t, path]);
  } else if (kind === "pricing") {
    const plans = (ctx.plans || []).map(p => sp(p.name) + " ₹" + p.price + (p.duration_months ? "/" + p.duration_months + (p.duration_months == 1 ? " month" : " months") : ""));
    title = "Premium Plans & Pricing | " + brand;
    description = "Unlock all premium B.Tech notes, question banks and solved papers on " + brand + (plans.length ? ": " + plans.join(", ") : "") + ". Pay via UPI.";
    path = "/pricing"; crumbs.push(["Pricing", path]);
  } else if (kind === "about") {
    title = "About " + brand + " – B.Tech Notes & Study Material";
    description = sp(st.about_text) || brand + " is a student education platform for B.Tech notes, important questions and study material.";
    path = "/about"; crumbs.push(["About", path]);
  } else if (kind === "contact") {
    title = "Contact Us | " + brand;
    description = "Questions about a document, a payment, or a subscription? Contact the " + brand + " team.";
    path = "/contact"; crumbs.push(["Contact", path]);
  } else if (kind === "privacy" || kind === "terms") {
    const n = kind === "privacy" ? "Privacy Policy" : "Terms of Service";
    title = n + " – " + brand;
    description = n + " of " + brand + ", the B.Tech notes and study material website.";
    path = "/" + kind; crumbs.push([n, path]);
  } else {
    title = ctx.label ? sp(ctx.label) + " | " + brand : (kind === "search" ? "Search Notes | " : kind === "notfound" ? "Page not found | " : "") + brand + " – " + tagline;
    description = brand + ": B.Tech notes, important questions, previous year papers and lab manuals.";
    path = null; robots = kind === "search" ? "noindex, follow" : "noindex";
  }
  return { title: clip(title, 110), description: clip(description, 230), path, robots, crumbs };
}
