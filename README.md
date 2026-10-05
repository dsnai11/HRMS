# Laxmi India Finance Ltd. — HRMS

Attendance application with an Android/iPhone Expo client, a responsive admin portal, and a Node.js API. Reports default to Asia/Kolkata. No employee or workplace data is seeded into production.

## Implemented

- Admin creates workplaces with GPS coordinates, radius (25–2,000 m), and maximum GPS uncertainty (5–100 m).
- Admin creates employees, assigns one workplace, resets passwords, and deactivates accounts. Temporary passwords must be changed on first login.
- Employees punch in and out using a fresh foreground GPS reading. The server checks coordinates, accuracy, timestamp, workplace assignment, mock-location flag, and shift state.
- Punch-out uses the workplace coordinates and radius saved at punch-in. Reassignment and deactivation are blocked during an open shift.
- Attendance history, active shifts, elapsed hours, date filters, CSV export, and an activity log are available in the portal.
- Passwords use salted scrypt hashes. Sessions expire after 24 hours; browser sessions use HttpOnly cookies and native sessions use Expo SecureStore. Roles are enforced by the API.

## Run the web portal and API

Requires Node.js 24 or newer. Run `npm ci` first. The server uses the `pg` driver for hosted PostgreSQL; local development can still use SQLite.

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_EMAIL`, `ADMIN_NAME`, and a unique `ADMIN_PASSWORD` of at least 12 characters.
3. Run `npm run bootstrap` once to create the administrator.
4. Remove `ADMIN_PASSWORD` from `.env` and run `npm start`.
5. Open http://localhost:3000. Add a workplace, then employees.

`npm test` exercises the geofence and authenticated attendance workflow against both SQLite and an embedded PostgreSQL engine (PGlite), plus PostgreSQL rollback and the hosted-storage guard. This does not replace a live Neon connection check. A separate local preview database, if present, lives under ignored `.local/`; it is never deployed.

## Free showcase deployment: Render + Neon

This is the selected showcase target. `render.yaml` explicitly requests Render's **free** web service; it does not provision a paid disk or Render database.

1. Create a **Free** Neon project and database. Copy the PostgreSQL connection string from its Connect dialog, keeping TLS enabled (`sslmode=require` or stronger). Keep it private.
2. Open [Deploy this repository to Render](https://render.com/deploy?repo=https://github.com/dsnai11/HRMS). Connect GitHub if prompted and select the Blueprint in this repository.
3. Enter the Neon connection string as `DATABASE_URL`. Confirm that the service plan is **Free** before deploying. The Blueprint generates a private `SETUP_TOKEN` automatically.
4. Wait for the deployment and `/health` check to succeed. Open the generated HTTPS URL. In Render's environment settings, view `SETUP_TOKEN` and use it once on the portal's setup screen to create your own administrator credentials. Remove `SETUP_TOKEN` after setup.
5. Add a showcase workplace at the place where you will demonstrate punching, and create a test employee. Share the test credentials privately. The code does not bypass location checks for demonstrations.
6. Set the mobile app's `EXPO_PUBLIC_API_URL` to the Render HTTPS origin and rebuild/restart the app as appropriate.

Free Render services sleep after idle periods, and waking may delay the first request. Open the portal before a presentation. Records live in Neon rather than Render's temporary filesystem; free quotas and provider availability still apply. Do not use Render's expiring free Postgres database for this setup. There is no production availability guarantee.

`DATABASE_URL` selects PostgreSQL. On Render, or with `REQUIRE_POSTGRES=true`, a missing URL stops startup instead of falling back to a disposable SQLite file. Existing local SQLite records are left untouched and are **not** automatically copied to Neon. Run one app instance for the showcase; requests are serialized to preserve the read/check/write semantics of the original app.

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
2. Attach a persistent volume mounted at `/data`. **Do this before storing real attendance.** Set `DATABASE_PATH=/data/hrms.sqlite` and keep a single replica.
3. Set `NODE_ENV=production`, `COMPANY_NAME=Laxmi India Finance Ltd.`, and `REPORT_TIMEZONE=Asia/Kolkata`.
4. Generate an HTTPS domain and set `PUBLIC_URL` to that exact origin. Railway supplies `PORT`; the service listens on `0.0.0.0`.
5. Set a private random `SETUP_TOKEN` of at least 32 bytes. Open the portal and use that code to create the first administrator, then remove the variable. Alternatively, run `node server/bootstrap.js` in the running service shell with administrator environment variables set. The live volume must be mounted; do not bootstrap during build/pre-deploy.
6. Verify `/health`, log in, create the real workplace and employees, and point the mobile build at this domain.

`railway.json` configures the Docker build and `/health` deployment check. The volume is provisioned separately. Enable volume backups and confirm a restore procedure before using this for payroll records.

Railway references: [volumes](https://docs.railway.com/volumes/reference), [healthchecks](https://docs.railway.com/deployments/healthchecks). Mobile references: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [location](https://docs.expo.dev/versions/v57.0.0/sdk/location/).

## Behavior and limits

- “Same location” means the same assigned workplace boundary, not the exact GPS point.
- The entire reported GPS uncertainty circle must fit within the boundary. GPS quality indoors may cause rejection; tune the radius after a real-device site test.
- Server timestamps determine working hours. Date reports group shifts by punch-in date; ongoing shifts contribute elapsed time as of refresh. Hours are not a payroll calculation (no breaks, overtime or leave rules).
- The active-shift view includes overnight shifts. No automatic punch-out or admin location bypass is provided. An employee who leaves without punching out must return to the assigned workplace; agree an exception policy before rollout.
- GPS and the mock flag are client-provided signals. They cannot prove physical presence against a modified client, spoofed device, or shared credentials. Device attestation and device binding are not implemented.
- SQLite with a volume supports a single-service pilot. Multi-instance deployment requires a shared database and distributed rate limits.
- No email delivery, self-service password recovery, leave, payroll, biometric identification, background tracking, or automatic retention policy is included.
- Validate GPS permission denial, poor signal, boundary edges, offline responses, duplicate taps, overnight shifts, and both physical phone platforms before employee rollout.
- The mobile dependency audit currently reports 29 findings (19 high, 10 moderate), including transitive Expo/Metro tooling and Expo Router dependencies. Compatible automatic fixes have been applied; remaining automated recommendations include incompatible SDK changes. These findings require review before production mobile distribution. The API's dependencies are audited separately from the mobile app.
