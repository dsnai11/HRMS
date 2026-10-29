# HRMS

Attendance application with an Android/iPhone Expo client, a responsive admin portal, and a Node.js API. Reports default to Asia/Kolkata. No employee or workplace data is seeded into production.

## Implemented

- Admin creates workplaces with GPS coordinates, radius (25–2,000 m), and maximum GPS uncertainty (5–100 m).
- Admin creates employees, assigns one workplace, resets passwords, and deactivates accounts. Temporary passwords must be changed on first login.
- Employees punch in and out using a fresh foreground GPS reading. The server checks coordinates, accuracy, timestamp, workplace assignment, mock-location flag, and shift state.
- Punch-out uses the workplace coordinates and radius saved at punch-in. Reassignment and deactivation are blocked during an open shift.
- Attendance history, active shifts, elapsed hours, date filters, CSV export, and an activity log are available in the portal.
- Passwords use salted scrypt hashes. Browser sessions expire after 24 hours and phone sessions after 30 days; browser sessions use HttpOnly cookies and native sessions use Expo SecureStore. Roles are enforced by the API.

## Companies, roles and people

- **Companies.** Every record belongs to a company. The platform owner (`super_admin`) creates companies under **Organization → Companies** and switches between them with the selector in the top bar; nobody else can see or reach another company's data.
- **Roles.** `super_admin` (platform owner), `admin` (everything inside one company), `hr` (people, org, attendance and device approvals; cannot create admins, HR users, workplaces or read the activity log), and `employee`. Permissions are defined in `server/rbac.js` and enforced on the server.
- **Managers are derived.** Anyone with direct reports gets **My team** (members and their attendance, including indirect reports). Reporting lines cannot be circular, and a manager with active reports cannot be deactivated until they are reassigned.
- **Organization.** Branches, departments and designations per company (names unique per company, ignoring case).
- **Employee profile.** Employee code (auto-generated `E0001…` or set by HR), job details (department, designation, branch, workplace, manager, employment type, joining date), personal details and an emergency contact. Employees edit only their contact details under **My profile**.
- **Server layout.** `server/routes/*` hold the API by area, `server/rbac.js` the roles, `server/migrations/*.sql` the schema. Bank, PAN and Aadhaar data are deliberately not stored yet; they arrive with payroll and its protections.

## Time off

- **Leave types** are per company (**Leave & holidays → Leave types**). "Add standard Indian types" creates Casual (12), Sick (7), Earned (15, carry forward up to 30), Maternity (182, women only) and unpaid Leave Without Pay (unlimited). Each type sets paid or unpaid, yearly quota, monthly or yearly accrual, carry-forward limit, half-day permission, gender and a per-request maximum.
- **Accrual** is computed when balances are read or HR runs "accrue", and is safe to repeat. Monthly accrual is rounded cumulatively, so a year always totals its quota exactly. Joiners accrue from their joining month. Accrual starts in the leave year in which leave was first set up; earlier years are never back-filled, so enter opening balances as adjustments. The leave year can start in any month (January or April) and cannot change once balances exist.
- **Calendar.** Weekly offs (any weekdays, plus chosen Saturdays such as the 2nd and 4th) and company or branch holidays are not deducted from leave.
- **Applying.** Employees apply for full or half days. A request is checked for balance (pending requests are reserved), overlapping leave (also enforced by the database), holidays, leave-year boundaries and gender rules. Approved leave is a ledger entry; cancelling returns the days.
- **Approvals.** A person's manager (anyone above them in the reporting line) or HR/admin decides; nobody decides their own. Managers and HR have an **Approvals** inbox with a pending count. Started leave can only be cancelled by HR.
- **Attendance corrections.** Missed or wrong punch, on duty and work from home. Allowed for today or the last N days (default 7) and at most N per month (default 5), both set by HR. Approval creates or completes that day's shift, marked _corrected_, _on duty_ or _work from home_; late arrival or early leave still makes a half day, while on duty and work from home count as full days. A day with leave cannot also be corrected.
- **OD punch (on duty).** People HR switches on (Workplaces → OD punch) get OD Punch In and OD Punch Out in the phone app: a purpose, the time, GPS location and selfie, with no workplace boundary. The OD punch-out sends an on-duty request through the correction approval chain with the real times. Approved, the day is a full day on duty; rejected, it counts as absent. OD punches do not use up the monthly correction limit and cannot be withdrawn.
- **Punch map** (Administration → Punch map, needs `attendance.read`). A day's punch-ins, punch-outs and refused attempts on a map (Leaflet, served by the app; map pictures from OpenStreetMap), with workplace boundaries, distance from the workplace, OD purpose and GPS accuracy. Filters for branch, OD only and outside-the-workplace only; today's map refreshes every minute. Branch-limited roles see only their branches; opening it is recorded in the activity log.
- **Monthly muster** (HR) and **Time off** calendar (everyone): each day is present, half day, leave, holiday, weekly off or absent, giving payable days and loss-of-pay days for payroll. Days before the company started using the system (or before a person joined) are not counted; HR can set "counted from". Today is not counted until it has attendance or leave. Export as CSV.

Not yet included: shifts or weekly offs per branch or employee, a per-company timezone, multi-level approval chains, comp-off and optional holidays. See `docs/ROADMAP.md`.

## Payroll

Payroll is for payroll staff (role `payroll`) and administrators; HR does not see salaries. Only an administrator approves a run.

- **Salary structure.** Components split a monthly gross: a percentage of gross, a percentage of basic, a fixed amount, and exactly one balancing component. "Add standard structure" creates Basic (50% of gross), HRA (40% of basic) and Special allowance (balance). Each employee's salary keeps its own copy of the amounts, with a revision history; revisions cannot reach back into an approved month.
- **Pay days** come from the monthly muster (present, paid leave, holidays and weekly offs); pay is prorated by paid days over calendar days, rounded to the rupee. Only a completed month can be run.
- **Provident fund:** 12% employee and employer on PF wages, capped at the statutory ceiling (₹15,000, raised to **₹25,000 from 17 September 2026**; a month that straddles the change is weighted by days, as in EPFO's FAQ). The employer's share splits 8.33% to EPS (only for employees eligible for it) and the rest to EPF; EDLI and admin charges are 0.5% each. PF wages are basic, raised to **50% of total pay** under the labour codes' wage definition (switchable).
- **ESI:** 0.75% employee and 3.25% employer for wages up to ₹21,000, rounded up; coverage is decided on the full monthly wage and contributions are on wages earned.
- **Professional tax:** by the state of the employee's branch, from editable slabs (gender and month-specific amounts supported). Presets exist for Maharashtra, Karnataka, West Bengal, Telangana and Gujarat. Rajasthan and several other states levy none. Confirm any preset against your state's notification.
- **Income tax (TDS on salary):** FY 2026-27 new regime (slabs to 30% above ₹24 lakh, ₹75,000 standard deduction, ₹60,000 rebate up to ₹12 lakh with marginal relief, surcharge with marginal relief, 4% cess) and the old regime (declared deductions, professional tax, senior-citizen slabs from date of birth). Tax is projected for the year and the remainder spread over the months left, counting opening balances and approved runs. Enter opening balances when you start part-way through the year.
- **Runs.** Draft (recompute freely, add one-off earnings and deductions) → approved (locked; payslips appear for employees) → paid. A run with negative net pay cannot be approved. Optionally the preparer cannot approve their own run. Exports: payroll register, PF, ESI, professional tax and bank file.
- **Payslips** open as a printable page (save as PDF from the browser) with the amount in words.
- **Personal data.** Bank account, IFSC, PAN, UAN and ESI numbers are encrypted with AES-256-GCM using `DATA_ENCRYPTION_KEY` (generate with `openssl rand -base64 32` and set it on the server; **keep a backup, because encrypted data cannot be recovered without it**). Without the key nothing sensitive is stored. Values are masked on screen, revealing one is audited, and bank, PF and ESI exports are audited. Aadhaar is deliberately not stored.

- **Arrears.** A salary revision dated in an approved month is refused unless confirmed; the confirmation previews the month-by-month difference (and PF on it) and adds it to the next run as an earning and a deduction, or as a recovery if pay fell.
- **Loans and advances.** Interest-free, fixed instalments recovered from each month's pay; skip an instalment (it moves to the end), cancel the rest, and the loan closes itself when the last instalment is deducted. Employees see their own schedule.
- **Reimbursement claims.** Claim types with an optional yearly limit (checked per tax year) and taxable or non-taxable treatment. Employees claim from the portal, the manager, HR or payroll approves (HR and managers see them under Approvals), and approved claims are paid with the next run and marked paid on approval.
- **Statutory bonus.** Eligible if wages are up to ₹21,000 and at least 30 days were worked; calculated on wages capped at the higher of ₹7,000 or the minimum wage, at a configurable 8.33–20%, from approved runs of the financial year. Added to payroll once per year.
- **Leave encashment.** For leave types marked payable: days come off the ledger and a taxable earning is added at basic (or gross) ÷ a divisor you set; deleting the line gives the days back.
- **Gratuity.** Calculator and liability report: 15 days' wages per completed year (a part over six months counts), wages at least half of gross, ₹20 lakh cap, five years (one for fixed-term) to qualify, with the provision accruing before that.
- **Statutory files.** EPFO ECR text upload (`#~#`-separated; blocked until every member has a UAN), ESIC upload CSV, and Form 130 (annual salary and tax) and Form 138 (quarterly deduction) data as CSV.

**Not included yet:** the revamped EPFO ECR 2.0 layout and ESIC `.xls` file (the data is exported as CSV), perquisite tax on interest-free loans, investment-proof workflow for the old regime, and the official Form 130/138 e-filing files. The statutory rules are reference values for your payroll team or CA to confirm before a real run; they are not legal advice. Parameters and their sources are in `server/payroll/statutory.js` and `server/payroll/extras.js`.

## Hiring, onboarding and exit

Under **Hiring & exits** (HR and admin); employees see **My employment**.

- **Recruitment.** Job openings (department, branch, positions, hiring manager) → candidates with a stage (applied, screening, interview, offer, hired, rejected, withdrawn) and a history → interviews with an interviewer, mode and place → interviewer feedback (rating, recommendation) → offers (draft, sent, accepted, declined, withdrawn) with a printable offer letter. A duplicate candidate in the same pipeline is refused; a declined offer closes the candidate.
- **Hiring.** An accepted offer turns into an employee in one step (login, joining date from the offer, department, branch and manager from the opening). The standard 9-task joining checklist, or your company's own, is created, each task owned by HR, IT, the manager or the new joiner. Managers and interviewers see their tasks and interviews under Approvals.
- **Joining portal (pre-boarding).** Once an offer is marked sent, HR invites the candidate (Candidates → Open → _Invite to the joining portal_). They get a private 30-day link (emailed if mail is configured; otherwise HR copies it) that needs no login: they read the offer, accept it by typing their full name (recorded with time and address), fill in date of birth, address, emergency contact, education, previous jobs and — when `DATA_ENCRYPTION_KEY` is set — PAN, UAN and bank details (stored encrypted, shown masked), and upload ID and address proofs (PDF/JPG/PNG, 2 MB). HR reviews, verifies each document and approves or sends it back with a note. On hire everything moves onto the employee: profile fields, verified documents and the encrypted payroll details. Links expire, are replaced by a new invite, and stop working after joining.
- **Buddy and manager heads-up.** The hire step can name an onboarding buddy, who is notified and shown on the new joiner's _My employment_ page; the reporting manager is told who is joining. _Hiring & exits → Onboarding_ shows a "Joining soon" pipeline (offer, details and document status) beside the joiners' checklist progress.
- **Probation and confirmation.** The offer carries a probation length (default 6 months); the hire sets the end date. HR sees reviews due within 45 days or overdue, and can _Confirm_ (records a confirmation and ends probation) or _Extend_. The manager and HR are reminded by a background job 15 days ahead, once per period.
- **Assets.** Register assets with tags (unique per company), issue to one person at a time, receive back; employees see what they hold.
- **Exit.** The employee resigns (notice period from company or employee setting, default 30 days) or HR starts an exit (termination, retirement, end of contract). HR accepts and sets the last working day; a clearance checklist (manager, IT, finance, HR, plus one line per asset held) is created. Payroll stops counting days after the last working day, so the final month is pro-rated.
- **Full and final settlement.** Calculated and posted into the final month's payroll as one-off lines, so tax and net pay come from the normal run: notice shortfall recovery on resignation (gross ÷ 30 a day, can be waived), leave encashment (tax-exempt up to ₹25 lakh on resignation or retirement only), gratuity, and the remaining loan instalments recovered in the same run; approved claims are paid with it. HR can add one-off lines or leave a line out, and the settlement can be voided until the run is approved.
- **Completing the exit** needs every clearance item done, the settlement posted, the pay-in month's run approved, no assets still held and the last day reached. It then closes the login and revokes the phone, and relieving and experience letters become available.

## Insight, engagement and security

- **Insights** (HR and admin): headcount by department, branch and type; joiners and leavers by month and 12-month attrition; today's attendance and the last 14 days; leave taken and pending; hiring pipeline; open helpdesk tickets; payroll cost for the last approved months (admin and payroll access only).
- **Notifications.** A bell in the portal lists updates: leave, correction, claim and resignation decisions, interviews scheduled, payslips ready, announcements, policies, helpdesk replies, review cycles and training. Email is sent for the important ones when `RESEND_API_KEY` and `MAIL_FROM` are set on the server (sent through the Resend HTTPS API, recorded in an outbox with its result). Without them the bell works and nothing is emailed.
- **Announcements** to everyone, a branch or a department, optionally pinned, expiring or emailed.
- **Helpdesk.** Employees open tickets (payroll, leave, attendance, IT, policy); HR replies, adds internal notes the employee cannot see, assigns, resolves and closes. A reply from the employee reopens a resolved ticket.
- **Policies** with versions: changing the text asks everyone to acknowledge again; HR sees who is pending.
- **Documents.** Employees and HR upload PDF, JPG or PNG files up to 2 MB (checked against the file's real header), kept in the database. Visible only to the owner and HR; each HR view is logged; HR verifies; a report lists who is missing ID, address or PAN proof.
- **Performance.** Goals with weight and progress (set by the person or their manager); review cycles that give every employee a self-review, then a manager review; the manager's rating stays hidden from the employee until HR releases it. Training moved to the **Learning** page (below).
- **Learning.** HR builds a course under _Learning → Manage courses_: lessons (text, or a link/video address), an optional multiple-choice quiz with a pass mark and attempt limit, and a description. Assign it to everyone or one person, or tick _assign to every new joiner_ so hires get it automatically with a due date. Employees open it from _My learning_, mark lessons read, take the quiz, and on passing (or on finishing the last lesson of a quiz-less course) it completes and a printable certificate is issued. Content locks once anyone starts, HR can reset a person's attempts, and people get reminders 3 days before and after a due date. Tracked training (confirmed by a manager or HR) still works for classroom sessions. Videos are links that open in a new tab; nothing is embedded or stored.
- **Two-factor login** (browser sign-in) with any authenticator app and eight one-time recovery codes; a code cannot be reused; admin can reset it for someone who lost their phone. Phones are protected by device binding instead. Needs `DATA_ENCRYPTION_KEY` (the secret is stored encrypted).
- **Sessions.** See where you are signed in and sign out one or all other sessions.

## Employee phone app and the rest of stage 6

See `docs/COMPARISON.md` for how this lines up with Addetto HRMS.

- **Phone app.** Besides punching (Today, History): **Leave** (balances, apply, cancel, upcoming holidays), **Payslips**, **Requests** (missed punch, on duty, work from home), **Directory** (with referrals), **Helpdesk**, **Alerts** and **Profile**. It uses the same API, rules and approvals as the web portal. Dates are typed as YYYY-MM-DD (no date picker yet). The app needs a new APK/IPA build to get these screens.
- **Selfie at punch.** Turn on under Workplaces; the phone then asks for a front-camera selfie with every punch. HR sees it in Attendance records (each view is logged). Selfies are deleted after `PHOTO_RETENTION_DAYS` (default 90); the punch itself stays.
- **Shift rules.** Start time, grace, shift hours and earliest punch-out per company, branch or employee (Workplaces page). Without one, the server default applies. A **roster** (Workplaces page) gives people a different shift, or a rest day, on particular dates; it beats the standing rule and the weekly off, a rostered working Sunday counts as a working day, and employees see their next two weeks under My employment.
- **Directory** for everyone (names, designation, department, branch). Email and phone are shown only to HR, the person themselves and their manager or direct reports; **Refer a candidate** creates a candidate tagged with the referrer and tells HR.
- **Career changes** (Hiring & exits → Career changes): promotion, transfer, increment and confirmation with an effective date. Applying updates the profile, creates the salary revision for increments (keeping the person's PF setting; ESI is switched off above ₹21,000), notifies the employee and gives a printable letter.
- **Forgot password.** Emails a one-hour link (needs `RESEND_API_KEY`, `MAIL_FROM` and `APP_URL`); the answer never reveals whether an address has an account. Without email, HR resets passwords.
- **Annual tax statement** for each employee on the Payslips page.
- **Customisable Insights:** each person chooses which widgets to show and their order; new widgets show birthdays and work anniversaries for the next 30 days (never the birth year) and people who joined in the last 30 days.
- **Bulk import** from CSV: employees (Employees page; names are matched to existing departments, designations, branches; each person gets a one-time temporary password you download) and salaries (Payroll → Salaries). Both show a dry run first and send large files in chunks. The employee import can also **update existing people** (matched by employee code or email), changing only the columns the row fills in.
- **Android push notifications** for everything the bell shows, through Firebase (setup in `docs/OPERATIONS.md`). iPhones installed with a free Apple ID cannot receive push; they use the in-app alerts.
- **Attendance import** from a biometric machine or another system (Workplaces → Import attendance): CSV with a dry run, skips days that already have attendance, applies the late and early rules. **Minimum app version** to refuse punches from old apps.
- **Challan summaries** for PF (A/c 01, 02, 10, 21) and ESI, a **Labour Welfare Fund** rule per state (you enter the state's current figures and months), shown on the payroll register.
- **KRAs by designation** applied as goals, and **continuous feedback** (praise, improve, private to managers and HR) under Performance.


## Laxmi proposal parity (stage 7)

The company asked for the features in the Unthinkable proposal. `docs/PROPOSAL-MATCH.md` lists every user story with its status. In short:

- **Hiring:** managers raise requisitions; HR approves; a public careers page with an applicant tracker; skill match scores; a pipeline board; recruitment insights; editable candidate emails; a question bank, panel interviews with calendar invites and a scorecard; a credit (CIBIL) check with consent and an audit log.
- **Joining:** NDA and policy sign-off on the joining link, welcome email with login, IT, Finance and Admin task owners, a readiness dashboard.
- **People:** grades and salary bands, cost centres, business units, custom fields, org chart, 360° profile, renamed terms.
- **Time:** shift templates and department rules, comp-off, a team leave calendar.
- **Pay:** investment declarations that feed TDS, year-to-date, a cost report against budget.
- **Self-service:** employment letters, bank changes with approval, helpdesk response times.

## Attendance integrity (anti-spoofing)

Attendance can only be recorded from the company mobile app on an administrator-approved phone.

- **Phone-only punching.** `/api/punch` accepts only a bearer session plus a registered device ID and secret. Browser sessions are refused, and the web portal has no punch button.
- **One approved phone per employee.** An employee's first sign-in on a phone registers it as _pending_. An administrator approves it under **Devices** in the portal. Approving a new phone revokes the old one. The server stores only a hash of the phone's secret. A phone already registered to one account cannot be registered to another.
- **Server-side checks on every punch.** Mock-location flag, emulator detection, impossible travel between accepted punches (over 250 km/h and 1 km), and a warning for rooted devices and for identical coordinates repeated exactly across several punches.
- **Evidence trail.** Every refused attempt, and every accepted punch with a warning sign, is stored and shown under **Security** in the portal.

**Known limit.** The mock-location, emulator and root signals are reported by the app, so a modified app or a rooted phone can lie about them. These checks raise the cost of cheating and leave a record, but they do not prove the app is genuine. Proof needs Google Play Integrity (Android) and Apple App Attest (iOS), which require Google Cloud and Apple Developer accounts and are the next step. Until then, approve a phone only after the employee confirms they have just registered it.

## Shift rules (full day and half day)

Rules apply in the report timezone (Asia/Kolkata by default) and are stored on each shift at punch-in.

- **On time:** punch in at or before 09:45 (09:30 start plus a 15-minute grace). A punch-in at 09:46 or later makes the day a **half day**.
- **Required punch-out:** punch-in time plus 9 hours, but never earlier than 18:30. Punching in at 09:32 means 18:32; punching in at 09:00 still means 18:30.
- **Leaving early:** punching out before the required time makes the day a half day. The app asks the employee to confirm first.
- **One shift per day.** After punching out, an employee cannot punch in again the same day. If punch-out was tapped by mistake, punching out again at the workplace replaces the earlier punch-out time (the latest one is kept) and the day type is recalculated. The next calendar day starts a new shift.
- **Both rules missed** still records one half day, with both reasons kept.
- The portal's attendance table and the CSV export include the day type, reasons and required punch-out time. Shifts recorded before this feature have no day type.

Defaults can be changed with the environment variables `SHIFT_START` (`09:30`), `LATE_GRACE_MINUTES` (`15`), `SHIFT_HOURS` (`9`) and `EARLIEST_OUT` (`18:30`). One policy applies to everyone for now.

## Run the web portal and API

Requires Node.js 24 or newer. Run `npm ci` first. The server uses PostgreSQL: set `DATABASE_URL` (Neon or any PostgreSQL with TLS). With no `DATABASE_URL` in development, an embedded PostgreSQL (PGlite) stores data under `./data/pglite`.

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_EMAIL`, `ADMIN_NAME`, and a unique `ADMIN_PASSWORD` of at least 12 characters.
3. Run `npm run bootstrap` once to create the administrator.
4. Remove `ADMIN_PASSWORD` from `.env` and run `npm start`.
5. Open http://localhost:3000. Add a workplace, then employees.

`npm test` runs the whole suite against an embedded PostgreSQL engine (PGlite) with the real migrations: geofence and attendance rules, device binding, multi-company isolation, roles and permissions, org structure, profiles, reporting lines, and upgrading a pre-company database. This does not replace a live Neon connection check. A separate local preview database, if present, lives under ignored `.local/`; it is never deployed.

## Free showcase deployment: Render + Neon

This is the selected showcase target. `render.yaml` explicitly requests Render's **free** web service; it does not provision a paid disk or Render database.

1. Create a **Free** Neon project and database. Copy the PostgreSQL connection string from its Connect dialog, keeping TLS enabled (`sslmode=require` or stronger). Keep it private.
2. Open [Deploy this repository to Render](https://render.com/deploy?repo=https://github.com/dsnai11/HRMS). Connect GitHub if prompted and select the Blueprint in this repository.
3. Enter the Neon connection string as `DATABASE_URL`. Confirm that the service plan is **Free** before deploying. The Blueprint generates a private `SETUP_TOKEN` automatically.
4. Wait for the deployment and `/health` check to succeed. Open the generated HTTPS URL. In Render's environment settings, view `SETUP_TOKEN` and use it once on the portal's setup screen to create your own administrator credentials. Remove `SETUP_TOKEN` after setup.
5. Add a showcase workplace at the place where you will demonstrate punching, and create a test employee. Share the test credentials privately. The code does not bypass location checks for demonstrations.
6. Set the mobile app's `EXPO_PUBLIC_API_URL` to the Render HTTPS origin and rebuild/restart the app as appropriate.

Free Render services sleep after idle periods, and waking may delay the first request. Open the portal before a presentation. Records live in Neon rather than Render's temporary filesystem; free quotas and provider availability still apply. Do not use Render's expiring free Postgres database for this setup. There is no production availability guarantee.

`DATABASE_URL` selects PostgreSQL. On Render, or with `REQUIRE_POSTGRES=true`, a missing URL stops startup instead of falling back to local storage. Schema changes are applied automatically at startup from `server/migrations/`, each once, in order. Run one app instance for now; requests are serialized to preserve the read/check/write semantics of the original app (see `docs/ROADMAP.md`, stage 5).

Before moving to paid production, review the existing mobile audit findings, test real phones, define attendance exceptions and backups, and load-test the database/request concurrency approach. Upgrading hosting does not by itself complete those steps.

References: [Render free-service limits](https://render.com/docs/free), [Render Blueprint configuration](https://render.com/docs/blueprint-spec), [Neon](https://neon.com).

See `docs/PILOT.md` for how to run a trial with real people, and `docs/OPERATIONS.md` for capacity, backups, the restore drill and monitoring.

## Android and iPhone

The mobile source is in `mobile/` and uses Expo SDK 57, React Native, Expo Router, foreground location, and SecureStore.

1. In `mobile/`, run `npm ci`.
2. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_URL` to the HTTPS backend origin (no `/api` suffix).
3. Run `npx expo start`. Use an SDK-compatible Expo Go or development build on a real phone. For local development, use your computer's LAN address, not the phone's `localhost`.
4. Run `npx tsc --noEmit`, `npx expo lint`, and `npx expo-doctor` before release.
5. Configure the company-owned iOS bundle identifier, Android application ID, and EAS project using `npx eas-cli@latest build:configure`. These identifiers are deliberately not invented here.
6. Set `EXPO_PUBLIC_API_URL` in the EAS build environment. Run `npx eas-cli@latest build --platform android --profile preview` for an internal APK, or `--platform all --profile production` for store builds.

Signed app distribution requires your Expo account and the appropriate Apple/Google developer accounts. An exported JavaScript bundle is not an APK or an App Store release. Do not enable background location; this product captures location only at punches.

## Deploy to Railway from GitHub

Target repository: https://github.com/dsnai11/HRMS

1. Create a Railway project and deploy this repository, using its root Dockerfile.
2. Add a PostgreSQL database (Railway PostgreSQL or Neon) and set `DATABASE_URL`. Keep a single replica.
3. Set `NODE_ENV=production`, `COMPANY_NAME=Laxmi India Finance Ltd.`, and `REPORT_TIMEZONE=Asia/Kolkata`.
4. Generate an HTTPS domain and set `PUBLIC_URL` to that exact origin. Railway supplies `PORT`; the service listens on `0.0.0.0`.
5. Set a private random `SETUP_TOKEN` of at least 32 bytes. Open the portal and use that code to create the first administrator, then remove the variable. Alternatively, run `node server/bootstrap.js` in the running service shell with administrator environment variables set. Do not bootstrap during build/pre-deploy.
6. Verify `/health`, log in, create the real workplace and employees, and point the mobile build at this domain.

`railway.json` configures the Docker build and `/health` deployment check. Enable database backups and confirm a restore procedure before using this for payroll records.

Railway references: [volumes](https://docs.railway.com/volumes/reference), [healthchecks](https://docs.railway.com/deployments/healthchecks). Mobile references: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [location](https://docs.expo.dev/versions/v57.0.0/sdk/location/).

## Behavior and limits

- “Same location” means the same assigned workplace boundary, not the exact GPS point.
- The entire reported GPS uncertainty circle must fit within the boundary. GPS quality indoors may cause rejection; tune the radius after a real-device site test.
- Server timestamps determine working hours. Date reports group shifts by punch-in date; ongoing shifts contribute elapsed time as of refresh. Hours are not a payroll calculation (no breaks, overtime or leave rules).
- The active-shift view includes overnight shifts. No automatic punch-out or admin location bypass is provided. An employee who leaves without punching out must return to the assigned workplace; agree an exception policy before rollout.
- GPS and the mock flag are client-provided signals. They cannot prove physical presence against a modified client, spoofed device, or shared credentials. Device attestation and device binding are not implemented.
- Multi-instance deployment needs distributed rate limits and removal of request serialization; both are planned (`docs/ROADMAP.md`).
- Not included yet: email delivery, self-service password recovery, file storage for documents, biometric identification, background tracking, or automatic retention policy. See `docs/ROADMAP.md`.
- Validate GPS permission denial, poor signal, boundary edges, offline responses, duplicate taps, overnight shifts, and both physical phone platforms before employee rollout.
- The mobile dependency audit currently reports 29 findings (19 high, 10 moderate), including transitive Expo/Metro tooling and Expo Router dependencies. Compatible automatic fixes have been applied; remaining automated recommendations include incompatible SDK changes. These findings require review before production mobile distribution. The API's dependencies are audited separately from the mobile app.
