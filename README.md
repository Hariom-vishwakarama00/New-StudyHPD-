# StudyHPD

**B.Tech Notes, Important Questions & Study Material** — Learn • Organize • Succeed

Ye StudyHPD ka apna, self-owned version hai: subject-wise aur unit-wise study material, student login (email/password, **Continue with Google**, aur **6-digit email code**), aur poora website admin panel. Payment, Pricing aur My Plan features removed; all study material is free for signed-in students.
(Your own copy of StudyHPD: notes by subject and unit, student login and an admin panel. Payment and subscription features are removed.)

Live preview: https://studyhpd.sites.tab.bot

## ✅ Ab live hai — aapke apne Cloudflare account pe

**URL: https://www.studyhpd.workers.dev**

(Purana link https://studyhpd.studyhpd.workers.dev ab apne aap 301 redirect se naye link pe le jata hai — usi path pe. Wo ek chhota redirect worker `studyhpd` hai; use delete mat karna jab tak purane links chal rahe hain.)

| Cheez | Aapke account me |
|---|---|
| Worker | `www` (workers.dev subdomain: `studyhpd`) → https://www.studyhpd.workers.dev |
| Redirect | Worker `studyhpd` (no bindings) → 301 to `www` |
| D1 database | `studyhpd` — id `55e29830-4a68-4033-bb83-18b679b0176e` (APAC region) |
| Files | KV namespace `studyhpd-files` — id `a27565094078496794b07fc4e81f2f85` (binding `FILES_KV`) |

Preview ka saara data (subjects, units, notes/PDFs, plans, categories, settings, admin account, students, payments, screenshots) yahan copy ho chuka hai. Admin login wahi purana email + password hai.

**R2 kyun nahi?** Cloudflare R2 enable karne ke liye dashboard me payment method (card) maangta hai. Isliye abhi files free **Workers KV** me hain (code same interface se R2 ya KV dono chala leta hai). Baad me R2 chahiye ho to:
1. Dashboard → R2 Object Storage → enable → bucket `studyhpd-files` banao
2. `wrangler.toml` me `[[r2_buckets]]` wala block uncomment karo, `FILES_KV` ko bhi rehne do
3. Deploy. Naye uploads R2 me jayenge, purani files KV se padhi jayengi — kuch shift nahi karna padega.

**GitHub push pe apne aap deploy (ek baar ka setup, 1 min):**
Dashboard → Workers & Pages → `www` → Settings → **Builds** → **Connect** → GitHub → repo `studyhpd`, branch `main` → Deploy command `npx wrangler deploy` → Save. Uske baad har push pe site update.

**Google login:** Google Cloud Console → Clients → aapka Web client → Authorized JavaScript origins me `https://www.studyhpd.workers.dev` add karo → Save.
Target domain: **studyhpd.tech**

---

## Kis cheez pe chalta hai (Stack)

| Part | Kya hai |
|---|---|
| Backend | Cloudflare **Workers** – ek file `site/_worker.js`, koi framework / build step nahi |
| Database | Cloudflare **D1** (SQLite) – subjects, units, documents, plans, students, payments, settings, logs |
| File storage | Cloudflare **R2** (default) – PDFs, cover images, payment screenshots, UPI QR. Free fallback: **Workers KV** (binding `FILES_KV`, max 25 MB per file) jab R2 enable na ho |
| Frontend | Plain HTML/CSS/JS in `site/` (PDFs open in-page with PDF.js from `site/vendor/`) |
| Login | Email + password, Google Identity Services ("Continue with Google"), 6-digit email codes via **Brevo** or **Resend** (dono optional) |

Premium PDFs sirf `/api/file/<id>` se milti hain, aur sirf logged-in students ko jinka plan active hai (ya admin ko). Koi public link nahi.

Cloudflare ka **free plan** kaafi hai: 100k requests/day, 5 GB database, 10 GB file storage.

## Folder structure

```
studyhpd/
├── README.md
├── wrangler.toml            # Worker config: D1 + R2 bindings (database_id paste karna hai)
├── package.json             # npm scripts: dev, deploy, db:migrate, test
├── .gitignore               # node_modules, .wrangler, .dev.vars
├── .dev.vars.example        # local testing ke liye example (real .dev.vars commit mat karna)
├── migrations/
│   └── 0001_init.sql        # database tables (Google + email-code tables included)
├── site/
│   ├── _worker.js           # backend (API, login, payments, admin)
│   ├── index.html, app.js, styles.css, icons.js, manifest.json
│   ├── img/, favicon.png, og.png
│   └── vendor/              # PDF.js + QR code library
└── test/
    ├── site.test.mjs        # pages, catalogue, premium lock
    ├── auth.test.mjs        # email codes (OTP) + Google token check (mock Google keys)
    └── payments.test.mjs    # UTR payment → admin approve → premium unlock
```

> **Secrets is repo me nahi hain.** `SETUP_TOKEN` aap khud Cloudflare me secret ki tarah daaloge. `database_id` me abhi placeholder `PASTE_YOUR_D1_ID` hai.

---

## Step 0 — Domain ko Cloudflare pe laana (zaroori, pehle ye karo)

Abhi **studyhpd.tech pe koi nameserver set nahi hai / domain resolve nahi ho raha.** Isliye pehle:

1. https://dash.cloudflare.com pe free account banao (ya login karo).
2. **Add a domain / Add a site** → `studyhpd.tech` likho → **Free** plan choose karo.
3. Cloudflare aapko **2 nameservers** dega (jaise `xxx.ns.cloudflare.com`, `yyy.ns.cloudflare.com`).
4. Jahan se domain kharida hai (registrar – get.tech, GoDaddy, Hostinger, Namecheap…) wahan login karo → domain → **Nameservers** → "Custom" → Cloudflare wale dono nameservers paste karke save karo.
5. 15 min se kuch ghante lag sakte hain. Jab Cloudflare me domain ka status **Active** dikhe, tab domain attach kar sakte ho (Step 5).

(English: add studyhpd.tech to Cloudflare on the Free plan, copy the two nameservers it shows into your registrar's nameserver settings, and wait until Cloudflare marks the domain Active.)

Tab tak aap baaki steps kar sakte ho — app `www.<your-subdomain>.workers.dev` pe chal jayega (worker ka naam `wrangler.toml` ke `name` se aata hai).

---

## Option A — Dashboard se (GitHub import, koi software install nahi)

Isme har `git push` pe Cloudflare khud deploy kar dega.

**A1. D1 database banao**
Dashboard → **Storage & Databases → D1 SQL Database → Create** → naam: `studyhpd` → Create.
Database ke page pe **Database ID** dikhega — copy karo.

**A2. R2 bucket banao**
Dashboard → **R2 Object Storage** → (pehli baar ho to R2 enable karo; free tier hai, card maang sakta hai) → **Create bucket** → naam: `studyhpd-files` → Create.

**A3. `wrangler.toml` me database ID daalo**
GitHub pe is repo me `wrangler.toml` kholo → ✏️ (Edit) → `PASTE_YOUR_D1_ID` ki jagah apni Database ID paste karo → **Commit changes**.

**A4. Tables banao (optional)**
App pehli request pe khud tables bana leta hai. Phir bhi manually karna ho to: D1 → `studyhpd` → **Console** → `migrations/0001_init.sql` ka content paste karke **Execute**.

**A5. Worker import karo**
Dashboard → **Workers & Pages → Create → Import a repository** → GitHub connect karo → `studyhpd` repo choose karo.
- Project name: `studyhpd`
- Build command: khaali chhod do
- Deploy command: `npx wrangler deploy` (default)
- **Save and Deploy**

**A6. SETUP_TOKEN secret daalo**
Workers & Pages → **www → Settings → Variables and Secrets → Add** → Type: **Secret**, Name: `SETUP_TOKEN`, Value: koi lamba random word (jaise 30+ characters, sirf aapko pata ho) → **Deploy**.
Ye aapki admin setup key hai. Kisi ko mat batana, chat me mat bhejna.

**A7.** Ab Step 5 (domain) aur Step 6 (admin setup) karo.

---

## Option B — Wrangler CLI se (computer pe)

Chahiye: Node.js 18+ aur Git.

```bash
git clone https://github.com/Hariom-vishwakarama00/studyhpd.git
cd studyhpd
npm install

npx wrangler login                              # browser me Cloudflare login
npx wrangler d1 create studyhpd              # jo database_id print ho, wrangler.toml me paste karo
npx wrangler r2 bucket create studyhpd-files
npm run db:migrate                              # = wrangler d1 migrations apply studyhpd --remote
npx wrangler secret put SETUP_TOKEN             # lamba random word type karo (ye aapki admin setup key hai)
npm run deploy                                  # = wrangler deploy
```

`wrangler.toml` me ID paste karne ke baad change commit + push kar do (ID secret nahi hai, repo private hai).

Local testing: `.dev.vars.example` ko `.dev.vars` naam se copy karo, phir `npm run db:migrate:local` aur `npm run dev`.

---

## Step 5 — studyhpd.tech attach karo (Custom Domain)

Domain Cloudflare me **Active** hone ke baad:

Workers & Pages → **www → Settings → Domains & Routes → Add → Custom domain** → `studyhpd.tech` → Add.
`www` bhi chahiye to dobara **Add → Custom domain** → `www.studyhpd.tech`.

Cloudflare DNS record aur SSL certificate khud bana deta hai (kuch minute). Phir https://studyhpd.tech khul jayega.

(CLI alternative: `wrangler.toml` me neeche wala `routes = [...]` block uncomment karke `npm run deploy` — sirf tab jab domain Active ho.)

## Step 6 — Admin account banao

Browser me kholo (apna token daal ke):

```
https://studyhpd.tech/admin/setup#t=YOUR_SETUP_TOKEN
```

Apna email + password (8+ characters) set karo. Har token sirf ek baar chalta hai. Phir login: `https://studyhpd.tech/admin/login`.

Admin me sabse pehle:
- **Settings:** UPI ID (`9424817696@fam` pehle se hai), payee name, apna UPI QR, contact / WhatsApp, about text.
- **Documents:** PDFs upload karo.

### Preview ka data shift karna

Preview (studyhpd.sites.tab.bot) ka data aapke Cloudflare me automatic nahi aata. Admin → Settings → **Download backup (JSON)** se saari tables export ho jaati hain; PDFs preview ki storage me hain. Switch karte waqt Tab ko bolo, data + PDFs copy karwa denge.

---

## Continue with Google (Google sign-in)

Login aur Register dono pages pe **"Continue with Google"** button aata hai — **sirf tab jab Google Client ID set ho**. Set nahi hai to button chhupa rehta hai, baaki sab normal chalta hai.

Server har Google login ko check karta hai: Google ki public keys (JWKS) se signature, `aud` = aapki Client ID, `iss` = accounts.google.com, aur `exp` (expire to nahi hua). Same email ka account pehle se hai to usi me jud jata hai; nahi to naya student account ban jata hai. Google wale accounts **already verified** maane jaate hain.

### Google Client ID kaise banaye (free, 5 min)

1. https://console.cloud.google.com kholo → apne Gmail se login.
2. Upar project dropdown → **New Project** → naam `StudyHPD` → **Create** → project select karo.
3. Menu (☰) → **APIs & Services → OAuth consent screen** (naye UI me naam **Google Auth Platform** hai) → **Get started**.
   - App name: `StudyHPD`, User support email: aapka Gmail → **Next**
   - Audience: **External** → **Next**
   - Contact email: aapka Gmail → **Next** → agree → **Create**
4. Left me **Clients** (ya **Credentials → Create credentials → OAuth client ID**) → **Create client**.
   - Application type: **Web application**
   - Name: `StudyHPD Web`
   - **Authorized JavaScript origins** → **Add URI** (har ek alag line, end me `/` nahi):
     - `https://studyhpd.sites.tab.bot`
     - `https://www.studyhpd.workers.dev`  ← Cloudflare deploy ke baad jo link mile
     - `https://studyhpd.tech`
     - `https://www.studyhpd.tech`
     - (local testing ke liye) `http://localhost:8787` aur `http://localhost`
   - **Authorized redirect URIs**: khaali chhod do (popup login use hota hai).
   - **Create** → jo **Client ID** dikhe (`…apps.googleusercontent.com`) use copy karo. *Client secret ki zaroorat nahi.*
5. **Audience** page → **Publish app** → "In production". Warna sirf "test users" hi Google se login kar payenge. (Sirf email/profile maangte hain, isliye Google verification nahi maangta.)
6. Client ID daalo — **koi ek tarika**:
   - **Aasaan:** apni site → Admin → **Settings → Login & email verification → Google Client ID** → Save. (Preview pe abhi bhi chalega.)
   - **Ya Cloudflare me:** Workers & Pages → www → Settings → **Variables and Secrets → Add** → Type **Text**, Name `GOOGLE_CLIENT_ID`, Value: Client ID → Deploy.

Naya domain/link jode to step 4 me us origin ko bhi add karna, warna Google "origin not allowed" error dega. Client ID secret nahi hai (browser me dikhti hi hai), isliye GitHub me jaana bhi problem nahi — par yahan repo me koi value nahi rakhi.

---

## Email verification code (6-digit OTP)

Mail key set ho to:
- **Signup:** email/password se account banate hi email pe 6-digit code jata hai. Code daalne tak account **unverified** rehta hai (login karne pe naya code bhejta hai).
- **Log in with email code:** login page pe button — bina password, sirf email + code.
- **Forgot password:** email pe code aata hai, usse naya password set hota hai.
- Code **10 minute** valid, **5 galat try** ke baad khatam, **Resend** 60 second baad. Ek email pe max 5 code/ghanta, ek IP se 20/ghanta. Database me code sirf hash (HMAC) me save hota hai.
- Google se login karne wale already verified hain, unhe code nahi jata.
- **Mail key nahi hai → verification skip**, signup pehle jaisa seedha ho jata hai. Kuch nahi tootega.

Admin → Settings me **Send test email** button hai — key daal ke ek baar zaroor try karo.

### Option 1: Brevo (abhi ke liye best — apna domain nahi chahiye)

Free: 300 emails/day.

1. https://www.brevo.com → **Sign up free** → email verify + profile/company details bharo (StudyHPD, India). Kabhi-kabhi Brevo naye account ko activate karne me thoda time/extra info leta hai.
2. **Sender verify karo:** upar right naam pe click → **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender** → From name `StudyHPD`, From email: aapka Gmail (jaise `studyhpd.notes@gmail.com`) → Save → Gmail me aaya code/link se verify.
3. **API key:** naam pe click → **SMTP & API** → **API Keys** tab → **Generate a new API key** → naam `studyhpd` → copy (`xkeysib-…` se shuru). Ye key **secret** hai, chat me mat bhejna.
4. Apni site → Admin → **Settings → Login & email verification**:
   - Mail provider: **Brevo**
   - Mail API key: `xkeysib-…`
   - From: `StudyHPD <studyhpd.notes@gmail.com>` (wahi verified Gmail)
   - **Save** → **Send test email**.

   (Ya Cloudflare me: Secret `BREVO_API_KEY` + Text variable `MAIL_FROM`.)

> Gmail address se bheja mail kabhi-kabhi **Spam/Promotions** me ja sakta hai. Domain lene ke baad Brevo me **Domains → Add domain** karke `noreply@studyhpd.tech` se bhejna best hai.

### Option 2: Resend (jab apna domain ho)

Free: 3,000 emails/month (100/day). Resend sirf **verified domain** se students ko mail bhejta hai, Gmail se nahi.

1. https://resend.com → sign up.
2. **Domains → Add Domain** → `studyhpd.tech` → jo DNS records (MX/TXT/DKIM) dikhaye, Cloudflare DNS me add karo → **Verify**.
3. **API Keys → Create API Key** → permission **Sending access** → copy (`re_…`).
4. Admin → Settings: provider **Resend**, key `re_…`, From `StudyHPD <noreply@studyhpd.tech>` → Save → test. (Ya Cloudflare: Secret `RESEND_API_KEY` + variable `MAIL_FROM`.)

### Settings kahan se padhi jaati hain

| Setting | Cloudflare (env) | Ya app me (Admin → Settings) |
|---|---|---|
| Google Client ID | `GOOGLE_CLIENT_ID` (Text) | Google Client ID |
| Mail key | `BREVO_API_KEY` ya `RESEND_API_KEY` (**Secret**) | Mail provider + Mail API key |
| Sender | `MAIL_FROM` (Text) | From (sender) |
| Optional | `MAIL_PROVIDER` (dono key ho to), `CODE_PEPPER` (Secret) | — |

Cloudflare wali value app wali se upar hai. App me save ki hui API key kabhi wapas screen ya backup me nahi dikhti. `wrangler.toml` me `keep_vars = true` hai, taaki dashboard me daale variables har deploy pe na hatein.

### Tests

```bash
npm test     # Node 22+ chahiye
```
OTP flow (code bhejna, galat code, expiry, resend cooldown, rate limits, passwordless login, reset), Google token check (nakli Google keys se: sahi token, galat signature/aud/iss/expired), aur payments → approve → premium unlock check hote hain.

---

## Razorpay — automatic payment (UPI / card, plan turant chalu)

Razorpay keys save karte hi student "Pay with UPI / Card (instant)" se pay karta hai aur plan **usi second** chalu ho jata hai — aapko approve nahi karna padta. Keys nahi hain to purana manual UPI (QR + UTR + screenshot → admin approve) bilkul waise hi chalta hai.

### Aapko kya karna hai (Hinglish steps)

1. **razorpay.com** pe Sign up karo. Individual / unregistered business bhi chalta hai — PAN card + bank account chahiye. Live (asli paise) ke liye KYC poora karna padega, usme kuch din lag sakte hain.
2. Dashboard me upar **Test Mode** on rakho → **Settings → API Keys → Generate Test Key**. *Key ID* (`rzp_test_…`) aur *Key Secret* milega. Secret sirf ek baar dikhta hai — turant copy karo, chat me kabhi mat bhejna.
3. **Settings → Webhooks → + Add New Webhook**
   - Webhook URL: `https://www.studyhpd.workers.dev/api/razorpay/webhook`
   - Secret: khud koi lamba password bana lo (jaise `StudyHpd-Webhook-2026-xyz`) aur yaad rakho
   - Active events: **payment.captured** aur **order.paid** tick karo → Create
4. StudyHPD **Admin → Settings → "Razorpay (auto payment)"** me Key ID, Key Secret aur Webhook Secret paste karo → **Save settings** → **Check keys**. Upar "Auto payment ON · TEST mode" dikhega.
5. Test karo: ek student account se Pricing → Buy Now → "Pay with UPI / Card (instant)". Razorpay ka test card / test UPI use karo (Razorpay docs me "test card details" / "test UPI" search karo, jaise UPI ID `success@razorpay`). Plan turant "Active" dikhna chahiye, aur Admin → Payments → Approved me "Razorpay" + payment ID.
6. KYC approve hone ke baad Razorpay me **Live Mode** pe jao → Live API keys generate karo → Live mode me bhi wahi webhook (same URL, same 2 events, secret) banao → Admin → Settings me Live Key ID / Secret / Webhook Secret daal ke Save. Indicator "LIVE mode · real money" ho jayega.
7. **Fees:** Razorpay har payment pe fee kaat-ta hai (lagbhag ~2% + GST, pakka rate Razorpay ki pricing page pe check karo).
8. Razorpay me *auto-capture* on rehne do (default on hota hai). Off bhi ho to app khud capture kar leta hai jab student ka page khula ho.

Manual UPI chhupana ho (sirf Razorpay dikhe): Settings me "Hide the manual UPI option" tick karo. Razorpay keys hata ke wapas sirf manual chahiye: "Remove Razorpay keys" tick → Save.

### Kaise kaam karta hai (technical)

- `POST /api/razorpay/order` — server plan ka price **D1 se** leta hai (browser ka bheja amount ignore), Razorpay Order banata hai, `rzp_orders` table me save karta hai.
- Checkout.js pricing page pe khulta hai. Success pe `POST /api/razorpay/verify` — `HMAC-SHA256(order_id|payment_id, key_secret)` check, Razorpay se payment ka order/amount confirm (authorized ho to capture), phir plan activate/extend (bachi hui time ke upar naye months — manual approve wala hi rule).
- `POST /api/razorpay/webhook` — `X-Razorpay-Signature` (`HMAC-SHA256(raw body, webhook_secret)`) check, events `payment.captured` / `order.paid`. Student ne tab band kar diya ho tab bhi plan chalu ho jata hai.
- **Idempotent:** `payments.gateway_order_id` pe UNIQUE index — ek order se sirf ek payment row aur ek hi baar time add hota hai, chahe callback + webhooks kitni baar aayen. Amount order se match na kare to activate nahi hota (Activity Log me `payment.amount_mismatch`).
- Payment `payments` table me `method = 'razorpay'`, `status = 'approved'`, `gateway_payment_id = pay_…` ke saath save hoti hai.
- Keys Admin → Settings se (D1 me) ya Cloudflare secrets `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` se (ye override karte hain). Key Secret aur Webhook Secret kabhi wapas nahi dikhte aur backup JSON me nahi jaate (Brevo key jaisa).
- Database badlav sirf additive hain (`migrations/0002_razorpay.sql`; worker pehli request pe khud laga deta hai).
- Tests: `test/razorpay.test.mjs` (Razorpay API mock) — signature valid/invalid, webhook idempotency, amount tamper, aur bina keys ke manual flow same.

## 📱 Android app (APK / Play Store)

`android/` folder me StudyHPD ka Android app hai — ek **Trusted Web Activity (TWA)**: app khulte hi live site https://www.studyhpd.workers.dev full-screen dikhti hai (koi URL bar nahi). Site pe jo bhi badlav karoge, app me **apne aap** aa jayega — naya APK banane ki zaroorat nahi.

| Cheez | Value |
|---|---|
| Package id | `com.studyhpd.app` |
| Naam / version | StudyHPD · 1.0.0 (versionCode 1) |
| Minimum Android | 7.0 (API 24) · Chrome (ya koi TWA-supporting browser) phone pe hona chahiye |
| Icon / colour | site ka logo (`site/img/icon-512.png` + `icon-maskable-512.png`), theme `#4f46e5`, white splash |
| Full-screen proof | `site/_worker.js` → `/.well-known/assetlinks.json` (signing key ka SHA-256) |

**Signing key (bahut zaroori):** release keystore aur uska password git me **nahi** hain. Har naye update ke liye **wahi** keystore chahiye — kho gaya to students ke phone pe update install nahi hoga. Iska backup apne paas (Google Drive/pen drive) rakho.

### Naya APK banana (sirf tab jab app ka naam/icon/version badalna ho)
1. JDK 17 + Android SDK install karo (ya Android Studio).
2. `android/keystore.properties` banao (git-ignored):
   ```
   storeFile=/full/path/studyhpd-release.keystore
   storePassword=...
   keyAlias=studyhpd
   keyPassword=...
   ```
3. `android/app/build.gradle` me `versionCode` +1 aur `versionName` badlo.
4. `cd android && ./gradlew assembleRelease bundleRelease`
   → APK: `app/build/outputs/apk/release/app-release.apk`, Play Store ke liye AAB: `app/build/outputs/bundle/release/app-release.aab`

### Play Store pe daalna ho to
Play Console me AAB upload karo. Agar "Play App Signing" on hai (default), to Play Console → *Test and release → Setup → App signing* se **App signing key certificate SHA-256** copy karke `site/_worker.js` me `ANDROID_CERT_SHA256` list me **add** karo (purana wala mat hatao) aur deploy karo — warna Play wale app me upar URL bar dikhega.

### Domain badla to (jaise studyhpd.tech)
App sirf `www.studyhpd.workers.dev` ke liye bana hai. Domain badalne pe `android/app/build.gradle` (`hostName`) + `twa-manifest.json` badal ke naya APK banana padega, aur naye domain pe bhi `/.well-known/assetlinks.json` chalna chahiye (worker wahi hai to apne aap chalega).

## 📴 Offline mode — hata diya gaya
Offline mode (service worker, saved notes) hata diya gaya hai. Jin phones me pehle wala service worker install ho chuka tha, unke liye `site/sw.js` ab ek **kill-switch** hai: wo phone ki saari offline cache (saved PDFs bhi) delete karta hai, khud ko unregister karta hai aur page ek baar reload karta hai. Ise delete mat karna (kuch hafte tak rehne do), warna purane phones pe purani offline cache reh jayegi. `app.js` bhi bacha-kucha registration hata deta hai.

## 🔍 Google Search (SEO)

Site ab Google ke liye ready hai (31 Oct 2026):
- Har page ka apna title, description, canonical link aur share preview (og) tags, server se seedha HTML me — subject, unit (`/subject/<id>/unit/<id>`) aur har document page ke liye D1 ke naam se. JavaScript ke bina bhi page me heading, text aur links hote hain.
- `/robots.txt` — public pages open; `/admin`, `/api`, login/register/profile band. Sitemap ka link bhi isme hai.
- `/sitemap.xml` — D1 se apne aap banta hai: home, pricing, about, contact, privacy, terms, saare subjects, units aur published documents (lastmod ke saath). Naya PDF daaloge to sitemap me apne aap aa jayega.
- JSON-LD: home pe Organization + WebSite, subject/unit/document pe BreadcrumbList.
- Premium PDF ka link kabhi HTML ya sitemap me nahi jaata — sirf naam/description.
- Login, admin, profile jaise pages `noindex`; galat/draft link 404 + `noindex`.
- Google ke visits document "views" me count nahi hote.
- Code: `site/seo.js` (titles — worker aur app.js dono yahi use karte hain), `_worker.js` me "Search engines" section. Tests: `test/seo.test.mjs`.

### Google Search Console (aapko ek baar karna hai)
1. https://search.google.com/search-console → **Add property** → **URL prefix** → `https://www.studyhpd.workers.dev/`
2. Verify method: **HTML tag** → `content="..."` wala code copy karo
3. Site pe **Admin → Settings → Google Search → Google verification code** me paste karo (poora `<meta ...>` tag bhi chalega) → **Save settings**
4. Search Console me **Verify** dabao
5. **Sitemaps** → `sitemap.xml` likho → **Submit**
6. **URL Inspection** → home page ka URL → **Request indexing**

Google me aane me kuch din se kuch hafte lagte hain. Apna domain (jaise studyhpd.tech) laga loge to `wrangler.toml` me `SITE_URL` badal dena, aur Search Console me naya property add karna.

## Privacy Policy & Terms pages

The app has two built-in pages, linked from the footer and the Login/Register screens:

- **Privacy Policy:** `/privacy` (also `/privacy-policy`)
- **Terms of Service:** `/terms` (also `/terms-of-service`)

Google OAuth **Branding** me yahi links daalo (apne domain pe), jaise `https://studyhpd.tech/privacy` aur `https://studyhpd.tech/terms`. Home page = `https://studyhpd.tech`.

**Text badalna:** Admin → Settings → **Legal pages**. Box khaali = built-in text. "Start from current text" dabao, edit karo, Save. `## ` = heading, `- ` = bullet, paragraphs ke beech blank line. `{contact}` apne aap Settings ke Contact email (ya WhatsApp) se bhar jaata hai, isliye **Contact email zaroor bharo**. Refunds ke liye text sirf "contact us" kehta hai, apni refund policy ho to khud likh do. Governing law: India.

> Ye pages general template hain, legal advice nahi. Business bada ho to ek baar kisi lawyer se check karwa lena.

## Admin guide

- **Payments:** student UPI se pay karke UTR (aur optional screenshot) submit karta hai → *Pending*. Apne UPI app me UTR + amount match karo → **Approve** (plan ke months add ho jaate hain) ya **Reject** (reason student ko dikhega).
- **Documents:** PDF + subject, unit, category, Free/Premium. Download allow, cover image, draft bhi.
- **Subjects & Units:** subject code se (BT-104…), units, semester.
- **Plans:** price, months, features, POPULAR tag.
- **Students:** search, premium manually do/hatao, password reset (temporary password dikhta hai), admin banao.
- **Settings:** UPI, QR, site name, tagline, announcement bar, about, contact/social, backup.
- **Activity Log:** har admin action, time ke saath.

Password bhool gaye? Email codes ON hain to student **Forgot password** pe email daal ke 6-digit code se khud naya password bana leta hai. OFF hain to Forgot-password page aapka WhatsApp/email dikhata hai, aur reset **Students** se karo.

### 🚫 Students ko Block / Remove karna (1 Nov 2026)
Admin → **Students** me har student ke aage:
- **Block / Unblock** — Block karte hi student login nahi kar sakta (password, email code aur Google, teeno) aur uske chalu sessions turant band. Login pe dikhta hai: "Aapka account block hai. Admin se contact karo." Unblock se wapas sab normal.
- **Remove** — confirm poochta hai ("Pakka remove karna hai? Ye wapas nahi hoga."), phir account, sessions aur Secure Reader tokens hamesha ke liye delete. **Payment / Razorpay order records hisaab ke liye bache rehte hain** (user_id wahi rehta hai + `user_email` me email ki copy), Payments list me "(removed)" dikhta hai.
- Search (naam / email / phone), checkbox se **bulk Block / Remove**.
- Admin khud ko ya kisi dusre admin ko block/remove nahi kar sakta (server bhi mana karta hai). Dusre admin ko hatana ho to pehle "Remove admin".
- Har action `admin_audit` table me likha jata hai (kisne, kab, kis email pe, kya kiya). API: `GET /api/admin/audit`.
- Removed student usi email se dobara signup kar sakta hai. Rokna ho to Remove ki jagah **Block** karo.
- Database change: `migrations/0003_user_block_audit.sql` (sirf naye columns/table, purana data waisa hi). Worker ye khud bhi apply kar deta hai.

## Security notes

- Kabhi bhi `SETUP_TOKEN`, Cloudflare API token, ya `.dev.vars` GitHub pe commit mat karna (`.gitignore` already block karta hai).
- Passwords salted hash me save hote hain; sessions HTTP-only cookie me.
- Email codes sirf hash me save hote hain, 10 min me expire; Google login server pe Google ki keys se verify hota hai.
- Mail API key kabhi GitHub me mat daalna — Cloudflare Secret ya Admin → Settings me hi.
- Premium files sirf active plan wale students ko.

### Security audit (31 Oct 2026) — kya pakka kiya gaya
- **Headers:** har page pe CSP, HSTS, `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `nosniff`, Referrer-Policy. Static files ke liye `site/_headers`, API ke liye worker khud lagata hai (dono same rehne chahiye — test check karta hai). Koi naya external script (jaise analytics) lagana ho to `CSP` (`site/_worker.js`) me uska domain add karo aur `site/_headers` dobara banao.
- **Login:** IP ke saath-saath har account pe limit (15 min me 10 galat password), OTP ka har try pehle count hota hai (parallel guessing band), password change pe bhi limit. Rate limiter ab atomic hai.
- **Uploads:** payment screenshot / QR / cover sirf asli PNG, JPG, WEBP, GIF, HEIC (file ke bytes check hote hain, naam/type nahi). SVG/HTML refuse. Documents sirf asli PDF. Saari files `nosniff` + `sandbox` CSP ke saath serve hoti hain, isliye koi file browser me script nahi chala sakti.
- **Payments:** ek UTR sirf ek baar (case-insensitive, database unique index se bhi). Ek payment do baar approve karne pe time sirf ek baar judta hai.
- **Draft documents** ki PDF sirf admin khol sakta hai.
- **CSRF:** dusri site se aaya POST/DELETE 403 (Razorpay webhook apne signature se protected hai).
- **Errors:** server error me andar ki details nahi dikhti (Cloudflare logs me jaati hain).
- **Backup (Admin → Export):** password hashes aur secret keys backup file me nahi aate.
- Tests: `npm test` (security tests: `test/security.test.mjs`).


## 🚫 Temporary / fake email block (1 Nov 2026)

Naya account banate waqt (email + password signup, aur uska 6-digit code wala verify) server ye check karta hai:
1. **~10,000 temp-mail domains ki list** (`site/disposable-domains.js`, source: disposable-email-domains project, CC0): mailinator, yopmail, 10minutemail, guerrillamail, temp-mail... aur unke sub-domains bhi.
2. **Naam ke patterns** (`site/email-guard.js`): "tempmail", "10minutemail", "yopmail" jaise words wale naye domains bhi.
3. **Mail server check (MX, Cloudflare DNS)**: domain exist hi nahi karta / uspe email aa hi nahi sakta → refuse. DNS slow ya fail ho to user ko roka nahi jaata.

Error (Hinglish): "Temporary/fake email allowed nahi hai. Apna asli Gmail ya college email use karo."
- Signup form pe turant dikhta hai (email likhte hi + `/api/auth/email-check`), aur server dobara check karta hai.
- **Purane users pe koi asar nahi** (login, payment sab waise). Google sign-in normal chalta hai; sirf naya Google account agar kisi temp-mail domain pe ho to wo bhi refuse.
- List update karni ho: `site/disposable-domains.js` me naya `disposable_email_blocklist.conf` paste karo. Emergency me MX check band: Worker variable `EMAIL_MX_CHECK = off` (list phir bhi chalegi).
- Tests: `test/email-guard.test.mjs`.

## 🔒 Notes viewer: screenshot / copy deterrents (1 Nov 2026)

Sach: **website pe screenshot ya screen recording 100% block karna possible nahi hai** (koi browser ye allow nahi karta; phone ka power+volume screenshot website ko pata bhi nahi chalta). Isliye viewer me ye lagaya hai:
- ~~Watermark~~ (email + date wala) **owner ke kehne pe hata diya (1 Nov 2026)**. PDF pages ab saaf dikhte hain.
- Right-click, text select, drag, Ctrl/Cmd+P (print), Ctrl/Cmd+S band. Print karne pe page khaali + "Printing is disabled".
- Window/tab chhodte hi (ya PrintScreen, Cmd+Shift, Win+Shift+S dabate hi) pages blur ho jaate hain, wapas aate hi normal.
- View-only PDF ka direct link (`/api/file/...`) browser me kholne pe ab seedha viewer page khulta hai (pehle Chrome ka apna PDF viewer download/print button ke saath khul jaata tha). "Download allowed" wale PDFs pehle jaise download hote hain.

### 📱 Android app me screenshot block (FLAG_SECURE) — test result (1 Nov 2026)
- **Abhi wala app (TWA, v1.0.1) me ye possible nahi hai.** App khulte hi page Chrome ki apni window me chalta hai, app ki window me nahi. Emulator pe test kiya: app ki window pe FLAG_SECURE lagaya, phir bhi `screencap` ne poora page capture kar liya (screen pe Chrome ki CustomTabActivity hi thi).
- **WebView wala app (test build) me kaam karta hai:** FLAG_SECURE ke saath `screencap` fail hua (0 byte, black). Par plain WebView me "Continue with Google" Google ke page pe chala jaata hai aur login wapas app tak nahi aata (Google WebView ke andar sign-in allow nahi karta). Razorpay UPI apps kholne ke liye bhi alag code chahiye.
- Isliye pehle WebView wala v1.0.2 nahi banaya (Google login tootna nahi chahiye). Uski jagah neeche wala "Secure Reader" bana.
- **Suggested agla step ("Secure reader"):** app TWA hi rahe (login + payment same), sirf notes kholne pe ek native WebView screen khule jisme FLAG_SECURE ho. Site ek one-time token deti hai jisse wo screen bina dobara login ke PDF dikhaye. Google login aur Razorpay ko haath nahi lagega. Effort ~2–3 ghante + real phone pe test.

### 🔐 Android app v1.0.2: "Secure Reader" (1 Nov 2026) — notes ka screenshot/recording kaala
App ab bhi TWA hai: login (Google + email), payment (Razorpay), saare pages pehle jaise Chrome me chalte hain. Sirf **notes/PDF kholne pe** app ki apni native screen (`ReaderActivity`) khulti hai jisme `FLAG_SECURE` laga hai: Android uska screenshot nahi lene deta, screen recording/casting me wo kaala aata hai, recents me bhi thumbnail nahi dikhta.

Kaise chalta hai:
1. App site ko `/?sr=1` se kholta hai (`LauncherActivity.getLaunchingUrl`). `site/boot.js` ye flag sirf us app-tab ke `sessionStorage` me rakhta hai aur URL se hata deta hai. Normal Chrome/desktop browser me ye flag kabhi nahi hota, wahan viewer pehle jaisa.
2. App ke andar notes page PDF ko Chrome me draw **nahi** karta. Wo `POST /api/reader-token` se ek token leta hai (login zaroori, wahi free/premium rule; premium doc + non-premium user → 403) aur `intent://reader?doc=<id>&t=<token>#Intent;scheme=studyhpd;package=com.studyhpd.app;...` kholta hai. Note card tap karte hi reader khul jaata hai; agar Chrome ne bina tap ke rok diya to page pe "Secure Reader me kholo" button hai.
3. Reader `GET /api/reader-file?doc=..&t=..` se PDF **ek baar** download karta hai (token: 5 minute, single-use, sirf usi doc ke liye; D1 table `reader_tokens` me sirf hash), Android `PdfRenderer` se dikhata hai (+/− aur pinch zoom), aur band hote hi file delete.
4. Purana app (v1.0.1) wale users ke liye kuch nahi badla (unke paas `sr=1` nahi hai, web viewer chalta hai).

Limits (sach): doosre phone/camera se photo kheenchna koi nahi rok sakta; rooted phone pe FLAG_SECURE bypass ho sakta hai; website (browser) me screenshot block possible nahi. Download-allowed PDFs download ho sakte hain (jaise pehle).

Code: `android/app/src/main/java/com/studyhpd/app/ReaderActivity.java`, `site/_worker.js` (`/api/reader-token`, `/api/reader-file`), `site/app.js` (Secure Reader section), `site/boot.js`, tests `test/reader.test.mjs`.
