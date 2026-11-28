# Handover: Laxmi India Finance HRMS

Updated **28 November 2026**. This is the one document a new owner or developer needs to take over the project: what it is, where everything lives, which accounts to hand over, how to run and deploy it, what is built, and what is still open. It replaces the older copies (20 October and 5 November).

---

## 1. What this is, and where everything lives

An HRMS for Laxmi India Finance Ltd. (NBFC, head office Jaipur, 180+ branches): a **web portal**, an **Android and iPhone app**, and one API behind both. Geofenced phone attendance, leave, payroll with Indian statutory rules, hiring to exit, performance, learning (LMS), branch budgets, self-service, the "Ask Laxmi" assistant and an in-portal HR guide. Plain Node.js (no framework), PostgreSQL, no build step for the portal.

| Thing | Where |
| --- | --- |
| Code | GitHub **dsnai11/HRMS** (private), branch `main` |
| Live portal | https://hrms-hfsr.onrender.com (Render service **HRMS**, id `srv-db940gu7bikc73djse2g`, Oregon, **free instance**; every merge to `main` deploys) |
| Health check | https://hrms-hfsr.onrender.com/health → `{"ok":true}` |
| Database | Neon project `square-frog-78622540` (Postgres, AWS us-east-2, free plan: 1 GB, 6-hour history) |
| Tests on GitHub | Action **Validate HRMS** (`.github/workflows/ci.yml`) on every push and pull request |
| Phone builds | Action **Build mobile apps** (`build-mobile.yml`): unsigned Android APK and iPhone IPA as downloadable artifacts |
| Nightly backups | Action **backup.yml**: encrypted database dump kept 14 days as an artifact (working since 26 Nov) |
| HR's how-to guide | Inside the portal: menu **HR guide** (51+ topics, kept in `server/hr-guide.js`) |

---

## 2. Accounts to hand over (do this first)

Nothing here is stored in the repository. Hand each one over deliberately.

| Account | What to do |
| --- | --- |
| **GitHub** `dsnai11/HRMS` | Add the new person as a collaborator (Settings → Collaborators), or transfer the repository to the company's GitHub organisation. Repository **secrets** (`DATABASE_URL`, `BACKUP_PASSPHRASE`) stay with the repo. Actions billing must stay valid or tests, phone builds and backups stop (this happened 15–26 Nov). |
| **Render** (workspace "My Workspace") | Invite the new person to the workspace, or move the HRMS service to a company workspace. Environment variables live here (section 5). |
| **Neon** project `square-frog-78622540` | Invite the new person, or transfer the project to a company Neon account. |
| **`DATA_ENCRYPTION_KEY`** (on Render) | Copy it into the company password manager. It encrypts PAN, UAN, ESI number, bank details and two-factor secrets. **If lost, that data cannot be recovered. Never change it casually.** |
| **Backup passphrase** | Was generated into `MY HRMS/backup-passphrase-KEEP-SAFE.txt` (outside the repo). Move it into the password manager, then delete the file. Without it the nightly backups cannot be opened. |
| **Company mailbox** used for email | Whoever owns `hrms@…` (or the mailbox in `SMTP_USER`) keeps the password; it is typed only into Render. |
| **Claude account** | The new person uses their own Claude account; this project needs no shared Claude login. |

---

## 3. Setting up a laptop

1. **Install:** Git, **Node.js 24 or newer**, and (for Claude Code) the Claude desktop app. On Windows use Git for Windows (it includes the credential manager).
2. **Get the code:**
   ```bash
   git clone https://github.com/dsnai11/HRMS.git hrms
   cd hrms
   npm ci
   cd mobile && npm ci && cd ..
   ```
   The first `git push` opens a browser to sign in to GitHub. Never type a GitHub password in the terminal.
3. **Run it locally** (an embedded database; no internet needed):
   ```bash
   cp .env.example .env        # set ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD (12+ characters)
   npm run bootstrap           # creates the first administrator, once
   npm start                   # http://localhost:3000
   npm test                    # about 200 tests in 65 files, about 3 minutes; only push on "fail 0"
   ```
   Without `DATABASE_URL` the data lives in `./data/pglite`. **Never point a local copy at the live Neon database** unless you mean to change real data.
4. **Phone app** (`mobile/`): before committing run `npx tsc --noEmit` and `npx eslint src`; add packages only with `npx expo install`. The app cannot run in a plain browser (maps); test it through the APK/IPA builds or Expo Go with the iOS simulator.
5. **Files that are not in git** (copy only if needed, keep them private):
   - `.env` (local settings; never commit).
   - The owner's working files in `MY HRMS/` (staff import sheets, the designation sheet `Book3-fixed.xlsx`, the branch salary sheet, the proposal PDF). They contain staff data: keep them off shared drives.
   - `AddettoHR.apk` (the old vendor's app, for layout reference only; never commit).

---

## 4. How the code is laid out

```
server/index.js            builds the app, lists every route module and static file, starts background jobs
server/router.js           small router: { public: true } (no login), { perm: "x.y" } (a role permission)
server/rbac.js             roles (super_admin, admin, hr, payroll, employee, custom) and permissions
server/routes/*.js         one file per area; each exports registerXxx(router, app)
server/migrations/*.sql    numbered, run once each at start-up (001 to 081 today)
server/payroll/            pay engine, statutory rules, tax slabs (update after each Budget)
server/notify.js           bell + email + Android push; email via SMTP (server/smtp.js) or Resend
server/smtp.js             built-in SMTP sender (STARTTLS/TLS, login, attachments), no extra packages
server/ats.js              ATS score of a candidate against a job description
server/field-force/        Field Force module (separate; off unless switched on)
server/hr-guide.js         the HR guide topics shown in the portal and used by Ask Laxmi
server/postgres.js         wrapper over pg; createGate lets punches and leave saves run side by side
public/*.js                portal pages: plain scripts sharing ONE global scope, no build step
public/styles.css          all portal styles (Day and Night themes, phone layout)
public/careers.html, join.html, alumni.html, verify.html, letter.html, payslip.html   public pages
mobile/                    Expo app (React Native, Expo Router); src/screens/*.tsx
test/*.test.js             node:test against PGlite with the real migrations
docs/                      OPERATIONS, PILOT, ROADMAP, COMPARISON, PROPOSAL-MATCH, LAUNCH-5000, this file
```

### Rules that will bite if forgotten

1. **Migrations** are append-only `NNN_name.sql` with `IF NOT EXISTS`. Never edit one that has been deployed. **The next number is 082.**
2. **The page security policy forbids inline scripts and styles:** no `onclick=`, no `style="…"` in HTML strings, no Google Fonts or outside files. Use classes in `styles.css`; setting `element.style.x` from JavaScript is fine. (Colours per department in the org chart are classes `dc0…dc11` for this reason.)
3. **Portal scripts share one global scope.** A new top-level name must not clash with another file's. A new script needs a `<script>` tag in `public/index.html` and an entry in the `STATIC` map in `server/index.js`.
4. **Route order matters:** register `/api/x/fixed` before `/api/x/:id`.
5. **Read a request body once** (`await body()`); uploads pass a limit, `body(3_000_000)`. Files are capped at 2 MB.
6. **Public routes** must rate-limit and reveal nothing (see `preboarding.js`, the careers routes in `recruitment-plus.js`, `alumni.js`).
7. **Sensitive data** (PAN, UAN, ESI number, bank, bureau key) is encrypted with `DATA_ENCRYPTION_KEY` (`server/crypto-store.js`), read through `readPrivate()`.
8. **The first admin is a `super_admin`.** It is deliberately left out of the org chart and out of HR alert lists (`staffWith`). Real HR people need the **admin** or **hr** role to get hiring alerts.
9. **Tests:** copy the `world()` helper from `test/hr-requests.test.js`. Employees sign in with a phone (`native: true` plus a `device`).
10. **Phone app colours** come from `T` in `src/theme.ts`, never typed-in reds.

---

## 5. Environment variables (Render → HRMS → Environment)

| Variable | State on 28 Nov | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | set | Neon connection string |
| `DATA_ENCRYPTION_KEY` | set | encrypts sensitive fields. **Back it up (section 2).** |
| `APP_URL` | set (`https://hrms-hfsr.onrender.com`) | links in emails, password reset, careers and apply links |
| `COMPANY_NAME`, `REPORT_TIMEZONE`, `NODE_ENV`, `REQUIRE_POSTGRES` | set | defaults |
| `SETUP_TOKEN` | **still set** | only for creating the first admin. **Delete it now.** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | **added 28 Nov, but blocked** | email through the company mailbox. **Render's free instance blocks SMTP ports 25/465/587**, so every email fails with "The mail server did not answer in time". Fix: move the service to a paid instance (Starter), or use Resend below. |
| `RESEND_API_KEY` | not set | alternative email route over HTTPS (works on the free instance; needs a verified domain in Resend). If set, it is used instead of SMTP. |
| `FCM_SERVICE_ACCOUNT` | not set | Android push (Firebase) |
| `ANTHROPIC_API_KEY`, `BOT_MODEL` | not set (optional) | free-text answers in Ask Laxmi |
| `S3_*` | recommended before full launch | file storage for selfies, photos, documents (`docs/LAUNCH-5000.md`) |
| `AUM_FEED_URL`, `AUM_FEED_TOKEN` | not set | branch AUM from the loan system for salary-by-branch |
| `FIELD_FORCE`, `WHATSAPP_*`, `SSO_*`, `FF_CALL_*` | optional | see `docs/OPERATIONS.md` and `server/field-force/README.md` |

The phone app's server address is the GitHub Actions variable `EXPO_PUBLIC_API_URL`. `.env.example` lists every variable with comments. Secrets are never committed.

---

## 6. Deploying, builds and backups

- **Work → pull request → merge to `main`** → Render rebuilds the `Dockerfile` and restarts (a few minutes); migrations run at start-up. Then check `/health`.
- **Validate HRMS** runs the tests on the branch push, the PR and the merge (three runs is normal).
- **Phone apps:** open the latest **Build mobile apps** run and download the APK and IPA under *Artifacts*. A new build is needed whenever `mobile/` changes. The IPA is unsigned (install with Sideloadly and an Apple ID).
- **Backups:** `backup.yml` runs nightly. A green run can still be a skip: open the log and look for `Wrote out/hrms-…`, or check that the artifact is about 0.7 MB or more. Prove a restore once (`docs/OPERATIONS.md`).

---

## 7. What is built (all live on `main`)

- **Attendance:** geofenced phone punch with device binding and anti-spoofing, optional selfie and fingerprint/face check, shift rules and rosters, regularization (with clock picker), OD and Multiple OD, overtime, biometric CSV import, muster, punch map, daily team attendance mail to supervisors, **mail after 3 working days with no punch**.
- **Leave:** company types (PL 1, CL 1, SL ½ a month; PL carries forward to 30), half days, holidays and optional holidays, comp-off, notice-period rules, team calendar, delegation.
- **Payroll:** structure, runs, PF/ESI/PT/TDS/LWF, declarations, loans, claims, bonus, gratuity, full and final, bank advice, payslips, Form 16 bulk upload by PAN, **salary shared across branches by AUM**.
- **Hiring:** requisitions, **one public apply link per opening** (careers page), resume upload and screening questions, **ATS score against the job description** (skills, experience, JD key words, qualification level, screening) with reasons, **hiring manager and department head see applicants** and send HR Shortlist / Hold / Not suitable, interviews, credit checks, offers (letter emailed as PDF), **ex-employee check with hold/accept/reject**, joining portal, onboarding, probation.
- **Exit:** resignation flow, clearance, settlement, letters emailed to personal email, **move a leaving manager's team**, **final settlement mail after N days (default 45)**, **private ex-employee documents link** with HR-chosen documents.
- **People:** employee master, designations with allowed grades (import from sheet), custom roles, profile photos, directory, **org chart as a tree** (colour by department, zoom, drag, HOD view, team CSV), 360° profile, career changes with **letters auto-mailed**, **transfer acknowledgement popup** (two skips, then must acknowledge), activity log by employee code, new temporary passwords for many people.
- **Documents:** per-employee documents, **ESI card and HR documents** shown in the app, **bulk upload of HR documents matched to employees by employee code, PAN or ESI number**, private to each employee.
- **LMS:** courses, assignment, certificates (designer, five ornate designs, public verification), overdue escalation.
- **Branch budgets:** yearly budgets, manpower plan, approvals, budget vs actual.
- **Help and engagement:** helpdesk with **ticket escalation L1/L2**, announcements, surveys, cases, chat, Ask Laxmi, HR guide.
- **Field Force** (separate module, off by default): morning activation, escalation, WhatsApp/IVR hooks, tracking while punched in.
- **Email:** forgot-password reset links and all other emails through the company mailbox (SMTP) or Resend, once the hosting allows it (section 5).
- **Look and feel:** Day and Night themes on portal and app, Appearance & branding, phone app modelled on the old HR app's layout (own code and branding).

`docs/PROPOSAL-MATCH.md` maps the proposal to what is built.

---

## 8. The live system today (28 Nov 2026)

- **21 active accounts:** the super administrator, a few test accounts, and the HR team. Real staff have **not** been loaded yet.
- **16 people have no attendance workplace**, so they cannot punch from the phone (Employees → Manage → Attendance workplace).
- 182 branches (from the salary sheet), 3 departments (**only 1 has a head set**: heads are needed for the HOD org view, applicant visibility and escalations), 5 leave types, 2 trial payroll runs, 3 job openings, 3 approved phones.
- Database at migration **081**, about 20 MB.
- Email is **not** going out yet (section 5). Until it does, HR resets passwords (Employees → New temporary passwords) and copies links by hand.

---

## 9. What is left

### Needs the company (not code)

1. **Hosting:** move the Render service to a paid instance (Starter or above). This alone makes email work and stops the 1-minute "waking up" delay. Ideally put the server and database in the same region (Singapore).
2. **Secrets housekeeping:** back up `DATA_ENCRYPTION_KEY` and the backup passphrase; delete `SETUP_TOKEN` on Render.
3. **Load real staff:** employee codes, branch, manager, department, designation, grade, salary; set workplaces and department heads.
4. **Designations:** HR makes the agreed renames in the portal, then imports `Book3-fixed.xlsx` (Organization → Designations → Import from sheet).
5. **Payroll:** a chartered accountant's review before the first real run; tax slabs after each Budget.
6. **Phone builds:** install the latest APK/IPA for staff and test on real phones (the ESI/HR document tiles, transfer popup, Night mode and Field Force tracking were checked in code and simulator only).
7. **Integrations to supply:** AUM feed (loan system) for salary-by-branch; Firebase for Android push; CIBIL partner API; Google Maps key for Android; LMS certificate signatory, signature and seal.
8. **Pilot:** one branch, 10–30 people, two weeks, one trial payroll (`docs/PILOT.md`).

### Code work ready or half-done

1. **ESI number matching for bulk documents:** branch `claude/esi-match-handover` (this document is on the same branch). Ready to merge.
2. **Reset password button** (Manage employee shows a generated password instead of a typed one; avoids Chrome autofill mistakes): built and tested, then parked at the owner's request. It is in a **git stash** on this Mac (`git stash list` → "reset-password-button"); it does not travel with the repository. Rebuild it if wanted.
3. **Old branches:** every `claude/*` branch is merged except two tiny leftovers (`claude/app-motion`: a test date pin; `claude/handover-items`: an LMS menu tweak that was merged another way). Check and delete them, and delete merged branches on GitHub.
4. **Open questions to settle with HR:** meaning of the "HO" day status in the supervisor mail and whether the SLM also gets it; whether the branch salary sheet amounts are per person or team totals.
5. **Ideas raised but not built:** SMS password reset; HR approval step for self-service password reset.

---

## 10. Known limits

- Offer and policy acceptance is recorded consent, not a certified e-signature.
- Form 16 is the TRACES-signed PDF uploaded by payroll; the HRMS does not generate it.
- The ATS score is a guide built from text matching (skills, key words, degree level, experience), not a judgement; HR decides.
- People count against the branch they are in today in cost and budget reports.
- Free-plan limits: Render sleeps and blocks SMTP; Neon has 1 GB and 6-hour history (hence the nightly backup).

---

## 11. Carrying on with Claude Code

Open the `hrms` folder in the Claude desktop app (Code tab) and start with:

> Read docs/HANDOVER.md. Then [the next task].

How the work has been done, and should continue:
- **One branch per piece of work** (`claude/<topic>`), tests added with the code, `npm test` green, a browser check of each new screen, then a commit, a pull request, and the owner merges.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR descriptions end with the Claude Code line.
- Plain, short explanations for a non-developer owner: what changed, what to click, what is still open.
- Claude never types passwords or keys into services on the owner's behalf, never solves CAPTCHAs, and asks before changing the live database (reading it to check things is fine).
- **Addetto** (the old vendor) screens are a reference for layout only: never copy their code, wording, images or logo.
- Do not install software on the owner's machine unless asked; project packages are fine.

---

## 12. Change log since the last handover (5 Nov → 28 Nov)

| PR | Merged | What |
| --- | --- | --- |
| 15 | 5 Nov | Saves run side by side (punch rush no longer queues) |
| 16 | 5 Nov | Designations and their grades from the company sheet |
| 17 | 6 Nov | Field Force module (off by default) |
| 18 | 7 Nov | Notice-period leave rules, letters by email, sanctioned-posts warning, app Day/Night |
| 19–20 | 7 Nov | LMS menu for course builders; employee code series and grade at hire |
| 21 | 8 Nov | Salary shared across branches by AUM |
| 22–23 | 9 Nov | LMS certificate designer, overdue escalation, ornate designs |
| 24–31 | 9–15 Nov | Interface polish, supervisor team mail, phone app redesign (bulk approvals, menu, punch card, clock picker, motion), automatic iPhone build |
| 32 | 15 Nov | Leave policy 1 PL + 1 CL + ½ SL a month |
| 33 | 26 Nov | Statutory deductions form fix |
| 34–35 | 26 Nov | HR's 15-point list (activity log by code, ESI card, escalation, HOD view, team moves, no-punch mail, ex-employee check, FNF mail, alumni documents, auto letters, transfer acknowledgement) and HR guide |
| 36 | 27 Nov | Org chart as a tree |
| 37 | 27 Nov | Apply link per opening, ATS scoring, department head view |
| 38 | 27 Nov | Bulk HR documents mapped to employees; clearer ATS score |
| 39 | 28 Nov | Email through the company mailbox (SMTP) for password reset links |
