# Handover: Laxmi India Finance HRMS

Updated 5 November 2026. Read this on the new laptop to set up the project and carry on with Claude Code, on the same GitHub account and the same repository.

## 1. What this is, and where everything lives

An HRMS for Laxmi India Finance Ltd. (NBFC, 200+ branches across India, head office in Jaipur): a web portal, an Android and iPhone app, and one API. Phone-only geofenced attendance, leave, payroll with Indian statutory rules, hiring to exit, performance, learning (LMS), branch budgets, self-service, the Laxmi assistant and insights. Plain Node.js, no framework, PostgreSQL.

| Thing | Where |
| --- | --- |
| Code | https://github.com/dsnai11/HRMS (branch `main`; the old address `dsnai11/hrms` redirects) |
| Live portal | https://hrms-hfsr.onrender.com (Render service **HRMS**, `srv-db940gu7bikc73djse2g`, Oregon, **free plan**, deploys every push to `main`) |
| Database | Neon project `square-frog-78622540` (Postgres 18, AWS us-east-2, free plan) |
| Tests on GitHub | Action **Validate HRMS** (`.github/workflows/ci.yml`) on every push and pull request |
| Phone builds | Action **Build mobile apps** (`build-mobile.yml`): unsigned Android APK and iPhone IPA as artifacts; runs when `mobile/` changes on `main` or a `claude/*` branch, or by hand |
| Daily backups | Action `backup.yml` (needs the secrets in section 5) |

## 2. Setting up the other laptop

1. **Install** (only these; nothing else is needed):
   - Git for Windows (includes Git Credential Manager), from git-scm.com.
   - Node.js 24 or newer, from nodejs.org.
   - Python 3 (only for the UI UX Pro Max design skill), from python.org.
   - The Claude desktop app, signed in with the **same Claude account**.
2. **Get the code:**
   ```bash
   git clone https://github.com/dsnai11/HRMS.git hrms
   cd hrms
   npm ci
   cd mobile && npm ci && cd ..
   ```
   The first `git push` opens a browser window to sign in to GitHub as **dsnai11** (Git Credential Manager). Never type the GitHub password in the terminal; GitHub refuses it.
3. **Run it locally** (an embedded database, no internet needed):
   ```bash
   cp .env.example .env        # set ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD (12+ characters)
   npm run bootstrap           # creates the first administrator, once
   npm start                   # http://localhost:3000
   npm test                    # 156 tests, about 2.5 minutes; push only when "fail 0"
   ```
   Without `DATABASE_URL` the data lives in `./data/pglite`. Do not point a local copy at the live Neon database unless you mean to change real data.
4. **Claude Code connections** to set up again on the new laptop (they are per machine): the **Neon** and **Render** connectors (used to check the live database and deploys), and the browser pane. Sign in to each when Claude asks.
5. **The design skill** used for the UI work:
   ```bash
   npm install -g ui-ux-pro-max-cli
   uipro init --ai claude --global
   ```
6. **Files that are not in git** (copy them yourself only if needed):
   - `.env` (local settings; never commit it).
   - `D:\project MY HRMS\hr-team-import.csv`: the HR team import sheet. It holds staff names and emails: keep it off shared drives.
   - `AddettoHR.apk`: the old vendor's app, kept for reference only. Never commit it.
   - Claude's own notes on this laptop (its "memory") do not travel. Everything it needs is in this file.

## 3. How the code is laid out

```
server/index.js           builds the app, lists every route module and static file, starts background jobs
server/router.js          small router: { public: true } (no login), { perm: "x.y" } (a role permission)
server/rbac.js            roles (super_admin, admin, hr, payroll, employee, custom) and permissions
server/routes/*.js        one file per area; each exports registerXxx(router, app)
server/migrations/*.sql   numbered, run once each at start-up (001 to 065 today)
server/payroll/           pay engine, statutory rules, tax slabs
server/brand.js           brand colour shades for the portal and the app
server/postgres.js        wrapper over pg (PGlite in tests uses the same code)
public/*.js               portal pages: plain scripts sharing ONE global scope, no build step
public/styles.css         all portal styles (Day and Night themes, phone layout at the end)
public/join.html, careers.html, agency.html, verify.html, letter.html, payslip.html   public pages
mobile/                   Expo app (SDK 57, React Native 0.86, Expo Router)
  src/screens/Attendance.tsx   app shell: sign-in, punch, top bar, menu, bottom bar
  src/screens/More.tsx         Home, Profile and most self-service screens
  src/screens/Daily.tsx        Att log, summary, regularization, OD, Multiple OD, leave, holidays
  src/screens/Exit.tsx         resignation flow
  src/theme.ts                 colours from Appearance & branding; themed() style sheets
  src/ui.tsx                   icons, motion (Reanimated), skeletons, haptics, avatar
test/*.test.js            node:test against PGlite with the real migrations
docs/                     OPERATIONS, PILOT, ROADMAP, COMPARISON, PROPOSAL-MATCH, LAUNCH-5000, this file
```

### Rules that will bite if forgotten

1. **Migrations** are append-only `NNN_name.sql` with `IF NOT EXISTS`. Never edit one that has been deployed. The next number is **066**.
2. **New row ids** come back automatically for any table with an `id` column (since 3 Nov the list is read from the database; it used to be a hand-kept list that had fallen behind).
3. **The page security policy forbids inline scripts and styles:** no `onclick=`, no `style=` attributes, no Google Fonts or outside files. Use classes in `styles.css`; setting `element.style` from JavaScript is fine.
4. **Portal scripts share one global scope.** A new top-level name must not clash with another file's (this broke the page once: `shrinkPhoto`). Each new script needs a `<script>` tag in `public/index.html` and an entry in the `STATIC` map in `server/index.js`.
5. **Route order matters:** register `/api/x/fixed` before `/api/x/:id`.
6. **Read a request body once** (`await body()`); large uploads pass a limit, `body(3_000_000)`.
7. **Public routes** must rate-limit and leak nothing (see `preboarding.js`).
8. **Sensitive data** (PAN, UAN, bank, bureau key) is encrypted with `DATA_ENCRYPTION_KEY` (`server/crypto-store.js`).
9. **Tests:** copy a helper from `test/od-batch-optional.test.js` or `test/resignation.test.js`. Employees sign in with a phone (`native: true` plus a `device`) and send the device headers on later calls.
10. **Phone app:** run `npx tsc --noEmit` and `npx eslint src` in `mobile/` before committing; add packages only with `npx expo install`; check `npx expo-doctor` (21/21 today). Colours come from `T` in `src/theme.ts`, never typed-in reds.

## 4. Environment variables (Render → HRMS → Environment)

| Variable | State | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | set | Neon connection string |
| `DATA_ENCRYPTION_KEY` | **set** | encrypts PAN and bank details. **Keep a copy in a password manager; if lost, that data cannot be recovered. Never rotate casually.** |
| `APP_URL` | **set** `https://hrms-hfsr.onrender.com` | links in emails and certificate checks |
| `COMPANY_NAME`, `REPORT_TIMEZONE` | set | defaults |
| `RESEND_API_KEY`, `MAIL_FROM` | **not set** | email. Until set, nothing is emailed (no "forgot password" emails, no notifications by email) |
| `FCM_SERVICE_ACCOUNT` | not set | Android push |
| `ANTHROPIC_API_KEY`, `BOT_MODEL` | optional, not set | free-text answers in Ask Laxmi (default model `claude-opus-5-5`) |
| `S3_*` | recommended | file storage for selfies, photos and documents (`docs/LAUNCH-5000.md`) |
| `WHATSAPP_*`, `SSO_*` | optional | resumes by WhatsApp; Google / Microsoft sign-in |

The phone app's server address is the GitHub Actions variable `EXPO_PUBLIC_API_URL`. A Google Maps key for Android goes in `mobile/app.config.js` at launch (iPhone uses Apple Maps without a key). Secrets are never committed.

## 5. Deploying

- **Pull request into `main`** → Render rebuilds the `Dockerfile` and restarts (about a minute); migrations run at start-up. Check https://hrms-hfsr.onrender.com/health.
- GitHub runs **Validate HRMS** on the branch push, the pull request and the merge: three runs of the same tests, which is normal.
- **Phone apps:** open the **Build mobile apps** run, download the APK and IPA under *Artifacts*. A new build is needed whenever `mobile/` changes. The IPA is unsigned (install with Sideloadly and an Apple ID).
- Backups: add the `DATABASE_URL` and `BACKUP_PASSPHRASE` repository secrets and run `backup.yml` once by hand to prove a restore.

## 6. What is built (all live on `main`)

- **Attendance:** geofenced phone punch with device binding, mock-location checks, optional selfie and fingerprint/face check, Apple Maps confirmation on iPhone, shift rules and rosters, regularization (Present, Outdoor duty, Work from home, **Short leave**), **Multiple OD** for a run of days, OD trips, overtime, biometric CSV import, muster, punch map.
- **Leave:** types, accrual, half days, holidays, **optional holidays** (chosen within a yearly limit, approved by the manager), comp-off, team calendar, delegation of approvals.
- **Payroll:** structure, runs, PF/ESI/PT/TDS/LWF, declarations and bills, loans, claims, bonus, gratuity, full and final, bank advice, payslips, **Form 16 bulk upload matched by PAN**.
- **Hiring to exit:** requisitions, careers page, RMS with sources (email inbox, WhatsApp, agencies), interviews, credit checks, offers, joining portal (now asks for a **passport photo**), onboarding, probation, **full resignation flow** (reason, early release, handover, manager and HR told, step tracker, exit interview by the employee, withdrawal request), clearance, settlement, letters.
- **LMS:** courses, department-wise assignment, catalogue, certificates with public verification, reports, live sessions.
- **Branch budgets:** yearly budget by branch and head, zones and regions, manpower plan, maker-checker approval, revisions, budget vs actual from payroll, claims and entered spending.
- **People:** employee master, org settings, custom roles limited by branch, **profile photos**, directory, org chart, 360° profile, **New temporary passwords** for people who have not signed in.
- **Engagement and help:** announcements, surveys, cases (grievance, POSH, whistleblower), helpdesk, gallery, chat, **Ask Laxmi**, the **HR Guide** (HR team only).
- **Look and feel:** enterprise design, Day and Night themes, works on phones, tablets and desktops; **Appearance & branding** (Administration) sets the brand colour and logo for the portal and the phone app. The phone app follows the old HR app's screen layout (bottom bar Home, Profile, OD, Att Log), with icons and motion.
- **Speed:** the app's start-up check and the punch read the database in parallel; the GPS starts the moment Punch is tapped.

`docs/PROPOSAL-MATCH.md` maps the proposal to what is built; `docs/COMPARISON.md` compares with Addetto.

## 7. State of the branches

- **`main`** at `5d1736d` (pull request #14): everything above, deployed, all 156 tests passing, live database at migration 065.
- **`claude/handover`**: this document.
- All other `claude/*` branches are merged and can be deleted.

## 8. The live system's people

- 21 accounts: the super administrator, three test accounts made during setup, and the **HR team of 17** (imported 3 November; 2 as **Admin**, 15 as **HR**, all reporting to the Vice President HR, code 8398).
- The HR team need their passwords handed out: Administration → Employees → **New temporary passwords** (shown once; download the CSV).
- 16 of them have **no workplace** yet, so they cannot punch from the phone until one is set (Employees → Manage → Attendance workplace). Indore and Ahmedabad need their own workplaces.
- Passwords are never recorded in this repository.

## 9. What is left

Needs the company:
1. **Hosting:** Render's free plan sleeps after 15 minutes (first open takes about a minute) and is in Oregon; the database is in Ohio. Move to at least Render Starter, ideally both in Singapore.
2. **Email:** a Resend account and verified domain, then `RESEND_API_KEY` and `MAIL_FROM`.
3. **New phone builds** for staff, then switch on *Selfie and fingerprint at punch* once everyone has them.
4. Google Maps key for Android; a chartered accountant's check of payroll before the first real run; the pilot (`docs/PILOT.md`).

Next work for Claude:
1. **Let saves run side by side:** the server handles every save (punch, leave request) one at a time across the company (`serializedStore` in `server/postgres.js`), so a 9:30 rush queues up. Needs careful work and tests.
2. Day / Night theme in the phone app.
3. Leave rules during the notice period; email relieving and experience letters to the leaver's personal email.
4. A warning when a job opening goes above a branch's sanctioned posts.
5. Optional: run the CI tests once per pull request instead of on every branch push.

## 10. Known limits

- Offer and policy acceptance is recorded consent, not a certified e-signature.
- Form 16 is the TRACES-signed PDF uploaded by payroll; the HRMS does not make its own.
- People count against the branch they are in today in cost and budget reports.
- Free-plan limits: Render sleeps; Neon 1 GB and 6-hour history.

## 11. Carrying on with Claude Code

Open the `hrms` folder in the Claude desktop app (Code tab) and start with:

> Read docs/HANDOVER.md. Then [the next task].

How we have worked, and what Claude should keep doing:
- **One branch per piece of work** (`claude/<topic>`), tests added with the code, `npm test` green, a browser check of each new screen, then a commit. **The owner pushes and merges** (Claude does not push unless asked).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Plain, short explanations for a non-developer (the owner is the IT auditor): what changed, what to click, what is still open.
- **Addetto** screens are a reference for layout and flow only: never copy their code, wording, images or logo. Laxmi's own logo and red-and-white branding stay.
- Claude never types passwords on the owner's behalf, never solves CAPTCHAs, and asks before changing the live database (it may read it to check things).
- Do not install software on the owner's machine unless asked; project packages are fine.
