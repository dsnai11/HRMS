# HRMS

Attendance application with an Android/iPhone Expo client, a responsive admin portal, and a Node.js API. Reports default to Asia/Kolkata. No employee or workplace data is seeded into production.

## Implemented

- Admin creates workplaces with GPS coordinates, radius (25–2,000 m), and maximum GPS uncertainty (5–100 m).
- Admin creates employees, assigns one workplace, resets passwords, and deactivates accounts. Temporary passwords must be changed on first login.
- Employees punch in and out using a fresh foreground GPS reading. The server checks coordinates, accuracy, timestamp, workplace assignment, mock-location flag, and shift state.
- Punch-out uses the workplace coordinates and radius saved at punch-in. Reassignment and deactivation are blocked during an open shift.
- Attendance history, active shifts, elapsed hours, date filters, CSV export, and an activity log are available in the portal.
- Passwords use salted scrypt hashes. Sessions expire after 24 hours; browser sessions use HttpOnly cookies and native sessions use Expo SecureStore. Roles are enforced by the API.

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
- **Attendance corrections.** Missed or wrong punch, on duty and work from home. Allowed for today or the last N days (default 7) and at most N per month (default 5), both set by HR. Approval creates or completes that day's shift, marked *corrected*, *on duty* or *work from home*; late arrival or early leave still makes a half day, while on duty and work from home count as full days. A day with leave cannot also be corrected.
- **Monthly muster** (HR) and **Time off** calendar (everyone): each day is present, half day, leave, holiday, weekly off or absent, giving payable days and loss-of-pay days for payroll. Days before the company started using the system (or before a person joined) are not counted; HR can set "counted from". Today is not counted until it has attendance or leave. Export as CSV.

Not yet included: shifts or weekly offs per branch or employee, a per-company timezone, multi-level approval chains, comp-off, leave encashment and optional holidays. See `docs/ROADMAP.md`.

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

**Not included yet:** Form 16 and quarterly TDS returns, the EPFO ECR upload format, ESI return format, gratuity, leave encashment, arrears from back-dated revisions, loans, reimbursements, bonus and statutory-bonus rules, and full-and-final settlement. The statutory rules are reference values for your payroll team or CA to confirm before a real run; they are not legal advice. Parameters and their sources are in `server/payroll/statutory.js`.

## Attendance integrity (anti-spoofing)

Attendance can only be recorded from the company mobile app on an administrator-approved phone.

- **Phone-only punching.** `/api/punch` accepts only a bearer session plus a registered device ID and secret. Browser sessions are refused, and the web portal has no punch button.
- **One approved phone per employee.** An employee's first sign-in on a phone registers it as *pending*. An administrator approves it under **Devices** in the portal. Approving a new phone revokes the old one. The server stores only a hash of the phone's secret. A phone already registered to one account cannot be registered to another.
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
- Not included yet: email delivery, self-service password recovery, leave, payroll, recruitment, biometric identification, background tracking, or automatic retention policy. See `docs/ROADMAP.md`.
- Validate GPS permission denial, poor signal, boundary edges, offline responses, duplicate taps, overnight shifts, and both physical phone platforms before employee rollout.
- The mobile dependency audit currently reports 29 findings (19 high, 10 moderate), including transitive Expo/Metro tooling and Expo Router dependencies. Compatible automatic fixes have been applied; remaining automated recommendations include incompatible SDK changes. These findings require review before production mobile distribution. The API's dependencies are audited separately from the mobile app.
