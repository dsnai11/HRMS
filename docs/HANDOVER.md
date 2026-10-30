# Handover: Laxmi India Finance HRMS

Written 20 October 2026, at the end of a long build session with Claude Code. Everything you need to move this project to your own machine and carry on.

## 1. What this is

An HRMS for Laxmi India Finance Ltd. (1,000+ employees, several companies and branches): web portal, Android and iPhone app, and one API. Phone-only geofenced attendance with anti-spoofing, leave, payroll with Indian statutory rules, recruitment to exit, performance, learning, self-service, insights. Plain Node, no framework, PostgreSQL.

| Thing | Where |
| --- | --- |
| Code | https://github.com/dsnai11/hrms (branch `main`) |
| Live portal | https://hrms-hfsr.onrender.com (Render service **HRMS**, `srv-db940gu7bikc73djse2g`, free plan, auto-deploys every push to `main`) |
| Database | Neon project `square-frog-78622540` (Postgres 18, AWS us-east-2, free plan: 1 GB cap, 6-hour point-in-time history) |
| Daily backups | GitHub Action `backup.yml` (needs secrets, see section 5) |
| Phone builds | GitHub Action `build-mobile.yml` (unsigned APK and IPA; IPA installed with Sideloadly and a free Apple ID) |

## 2. Run it on your machine

Needs Node 24 or newer.

```bash
git clone https://github.com/dsnai11/hrms.git
cd hrms
npm ci
cp .env.example .env        # set ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD (12+ characters)
npm run bootstrap           # creates the first administrator, once
npm start                   # http://localhost:3000
npm test                    # about 90 tests, about 2 minutes
```

With no `DATABASE_URL`, an embedded PostgreSQL (PGlite) keeps data in `./data/pglite`. To use the live database locally, set `DATABASE_URL` to the Neon connection string (do not do this casually: it is the real data).

To work on the phone app: `cd mobile && npm ci`, then see `docs/OPERATIONS.md` and `.github/workflows/build-mobile.yml`.

## 3. How the code is laid out

```
server/index.js          builds the app, lists every route module, serves public/, starts background jobs
server/router.js         tiny router: { public: true } (no login), { perm: "x.y" } (role permission)
server/rbac.js           roles (super_admin, admin, hr, payroll, employee) and permission lists
server/routes/*.js       one file per area, each exports registerXxx(router, app)
server/migrations/*.sql  numbered, run in order at start-up (001 to 027 on main)
server/payroll/          calculation engine, statutory rules, tax slabs
server/postgres.js       wrapper over `pg` (see "gotchas")
public/*.js              portal pages (plain scripts sharing one global scope, no build step)
public/join.html,        public pages for candidates: joining portal and careers page
  careers.html
mobile/                  Expo app (React Native)
test/*.test.js           node:test, run against PGlite with the real migrations
docs/                    OPERATIONS, PILOT, ROADMAP, COMPARISON, PROPOSAL-MATCH, this file
scripts/smoke/           browser smoke scripts (see its README)
```

### Conventions and gotchas (these will bite you)

1. **New table with an `id`?** Add its name to the `INSERT … RETURNING id` regular expression in `server/postgres.js`, or `lastInsertRowid` is undefined on the live database (the embedded one hides this). A script check: every `id SERIAL PRIMARY KEY` table in the migrations must appear in that regex. All 88 do today.
2. **Migrations** are append-only files `NNN_name.sql` using `IF NOT EXISTS`. Never edit one that has been deployed.
3. **Content-Security-Policy forbids inline scripts and styles.** No `onclick=`, no `style=`; use classes in `public/styles.css`. SVG charts use attributes.
4. **Portal scripts share one scope** and load in the order of `public/index.html`. A later file may call a function from an earlier one at run time. Each new script also needs an entry in the `STATIC` map in `server/index.js`.
5. **Route order matters:** a static path like `/api/payslips/ytd` must be registered before `/api/payslips/:runId` (see the comment in `server/index.js`).
6. **Read a request body once** (`await body()` twice hangs or fails).
7. **Public routes** (`public: true`) must rate-limit and must not leak anything; follow `preboarding.js` and `careers` in `recruitment-plus.js`.
8. **Sensitive data** (PAN, UAN, bank, credit API key, bureau report) is AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY` via `server/crypto-store.js`; never stored in clear text.
9. **Tests:** copy the `world()` helper at the top of `test/onboarding.test.js` (or `test/payroll.test.js` for payroll) to get a server with users per role, a fixed clock and a `setNow()`.
10. **Always run `npm test` before pushing to `main`** and only push on `# fail 0`.

## 4. Environment variables (Render → HRMS → Environment)

| Variable | State | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | set | Neon connection string |
| `NODE_ENV`, `PORT`, `RENDER` | set by Render | production behaviour |
| `DATA_ENCRYPTION_KEY` | **set** (32 bytes, base64) | encrypts PAN, bank, bureau key. **Back it up in a password manager. If lost, encrypted data cannot be recovered. Do not rotate casually.** |
| `APP_URL` | **set** `https://hrms-hfsr.onrender.com` | builds links in emails (joining link, careers page, password reset) |
| `COMPANY_NAME`, `REPORT_TIMEZONE` | set | defaults |
| `SETUP_TOKEN` | remove once the first admin exists | one-time admin setup |
| `RESEND_API_KEY`, `MAIL_FROM` | **not set** | turns on email. Needs a Resend account and a verified sending domain. Until then nothing is emailed; HR copies links |
| `FCM_SERVICE_ACCOUNT` | **not set** | Android push (Firebase). iPhone push is not possible with a free Apple ID |
| `ANTHROPIC_API_KEY`, `BOT_MODEL` | optional, **not set** | turns on Laxmi's free-text answers by Claude (default model `claude-opus-5-5`). Without it Laxmi answers from rules, the knowledge base and policies only |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | recommended | file storage for selfies and documents; see `docs/LAUNCH-5000.md` |
| `MAIL_PER_SECOND` | optional | mail provider sending rate (default 2) |
| `PHOTO_RETENTION_DAYS`, `DB_POOL_MAX`, `LOGIN_IP_LIMIT`, `DB_SIZE_LIMIT_BYTES`, `TRUST_PROXY_HOPS`, `CREDIT_ALLOW_PRIVATE` | optional | see `docs/OPERATIONS.md`; `CREDIT_ALLOW_PRIVATE=1` is for tests only, never in production |

Secrets are never committed. GitHub repository secrets for the Actions: `DATABASE_URL` and `BACKUP_PASSPHRASE` (backups), `GOOGLE_SERVICES_JSON` (Android push build, optional).

## 5. Deploying

- Push to `main` and Render builds the `Dockerfile` and restarts. Migrations run at start-up.
- **Use a paid Render instance for real use.** The free one sleeps after idle time (first request takes about a minute) and has no uptime guarantee.
- Neon free plan keeps only 6 hours of history, so the daily encrypted dump (`backup.yml`) matters. Add the two secrets above and run it once by hand to prove a restore works (`docs/OPERATIONS.md`).
- Phone apps: run the **build-mobile** workflow from GitHub Actions and download the APK and IPA artifacts. Needs a new build whenever app code changes (the mobile Directory and Learning changes since the last build are not in your installed app).

## 6. What is built

Every module below is real, tested and in production code, not mock-up.

- **Attendance:** geofenced phone punching, device binding, mock-location and emulator flags, risk rules, optional selfie (kept 90 days), shift rules (company, branch, department, person, day-by-day roster), shift templates, regularisation, on-duty and work-from-home, CSV biometric import, muster.
- **Leave:** types, accrual, carry-forward, half days, holidays, comp-off with expiry, team calendar.
- **Payroll:** structure, runs from attendance and leave, PF + ECR, ESI, professional tax, TDS (old and new regime), investment declarations, LWF, loans, claims, bonus, gratuity, arrears, full and final, bank advice, challans, payslips and year-to-date, cost report against budget.
- **Hiring to exit:** requisitions, careers page and applicant tracker, skill match, pipeline board, interviews with panels, question bank and calendar invites, credit (CIBIL) check with consent, offers with e-acceptance, joining portal (documents, NDA and policy sign-off), welcome email, task owners, probation and confirmation, buddy, exit clearance and settlement.
- **People:** employee master, grades and bands, cost centres, business units, custom fields, renamed terms, org chart, 360° profile, career changes and letters, directory with private contact details.
- **Performance and learning:** goals, KRAs, reviews, feedback; courses with lessons, quizzes and certificates.
- **Self-service:** payslips, letters, helpdesk with response times, policies and acknowledgements, bank changes with approval, documents, notifications (bell, email, Android push).
- **Security:** roles, TOTP two-factor on the web, session controls, activity log, encrypted sensitive fields, rate limits, daily encrypted backups.

`docs/PROPOSAL-MATCH.md` maps every user story in the Unthinkable proposal to its status. `docs/COMPARISON.md` compares against Addetto. `docs/PILOT.md` is the pilot plan.

## 7. State of the branches (important)

- **`main`** (commit `d033ccf` at the time of writing): everything above, 90 tests passing, deployed.
- **`claude/stage7-bot`**: internal chat and the Laxmi assistant, finished and tested (`test/chat-bot.test.js`), **not merged yet**. Portal pages *Messages* and *Ask Laxmi* (`public/chat.js`). Migration `028_chat_bot.sql` runs on the next deploy after the merge (it has not been applied to Neon). The phone app does not have these pages yet.
- Older `claude/*` branches are all merged into `main` and can be deleted.

The Render deploy of `main` after the last merge may still have been building when this was written. Check https://hrms-hfsr.onrender.com/health returns `{"ok":true}`.

## 8. What is left

From the proposal (`docs/PROPOSAL-MATCH.md`), in the order I would do them:

1. ~~Laxmi assistant and internal chat~~ (Module 11): built on `claude/stage7-bot` (see section 7). Left: the same two pages in the phone app, and HR filling the knowledge base and setting the pay day (*Ask Laxmi* page).
2. **HR command centre** (RPT-01): one page with headcount by department, monthly attrition, open positions, joiners and leavers, demographics. Most numbers exist under Insights.
3. **Multi-level approvals and escalation:** manager then HR for long leave, reminders when a request waits too long.
4. **Anonymous 360° feedback rounds** (PER-05).
5. Custom roles (today the five roles are fixed).

Things only the company can supply:

- **Email:** a Resend account, a verified domain, then set `RESEND_API_KEY` and `MAIL_FROM`.
- **CIBIL:** the bureau or integration partner's API address, key and request format (set under Hiring → Credit checks → Settings). Until then HR enters scores by hand.
- **Biometric devices:** the device make and model and its SDK or push protocol.
- **LinkedIn, Naukri, Indeed auto-posting:** their paid APIs. The careers page and copy-paste adverts work now.
- **Android push:** a Firebase project (`GOOGLE_SERVICES_JSON` secret for the build, `FCM_SERVICE_ACCOUNT` on Render).
- **A chartered accountant's review of payroll** (PF, ESI, PT, TDS, gratuity, bonus) before the first real run. I verified many computations by hand but I am not a substitute for one. Tax slabs live in `server/payroll/statutory.js` and need updating after each Budget.
- **The pilot** (`docs/PILOT.md`): one branch, 10 to 30 people, two weeks, one trial payroll.

## 9. Known limits (be honest with the client)

- Click-to-accept offers and policy sign-offs are recorded consent (typed name, time, address), not certified e-signatures.
- Calendar invites are `.ics` files by email, not a live Google Calendar integration.
- Year-end tax is a statement and filing data, not an official Form 16 file.
- Declarations apply to the current tax year only; ask employees to declare again each April.
- Videos in learning courses are links, not hosted.
- The cost report groups people by where they are assigned today, not where they were in an older month.
- The directory hides email and phone from ordinary employees (shown to HR, the person, their manager and reports).
- Free-plan limits: Render sleeps, Neon 1 GB and 6-hour history.

## 10. People and accounts in the live system

The live database has the super administrator and two employee accounts created during setup (no real payroll data yet). The super administrator has no personal pages (no Payslips, Learning and so on) by design: give your own employee login the **admin** role for daily use and keep the super administrator for creating companies. Passwords are not recorded anywhere in this repository.

## 11. Carrying on with Claude Code locally

```bash
cd hrms
claude
```

Good first prompts:

- "Read docs/HANDOVER.md and docs/PROPOSAL-MATCH.md, then check `claude/stage7-bot` and finish the internal chat with tests and a portal page."
- "Build the Laxmi assistant described in section 8 of docs/HANDOVER.md."

Working pattern that worked well: one branch per chunk, tests added with the code, `npm test` green before each push to `main`, a browser check of each new screen, and a short report after each chunk. The repo's `.github/workflows/ci.yml` runs the tests on every push.
