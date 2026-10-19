# Running the HRMS in production

## Capacity (measured)

`node scripts/bench.mjs 300` signs in and punches 300 employees at once against an in-process server and in-memory database. On the development sandbox it handled roughly 110 punches and 130 app-opens a second, so the application's own cost is small. In production the database round trips dominate: each write request makes several queries, and writes run one at a time to keep read-check-write sequences safe. Read requests (GET) run in parallel on PostgreSQL.

Rules of thumb for 1,000 employees: a punch burst of one or two a second is trivial; a worst case of everyone punching within a minute should still clear in well under a minute on a same-region database. Re-run the script with a larger number after any change to the punch path, and watch the slow-request lines described below.

Phones keep their session for 30 days, so the morning is not a rush of sign-ins (password hashing is the most expensive step). Browsers sign in again every 24 hours.

## What to set up before real use

- **Do not run on a plan that sleeps.** Render's free web service stops after 15 minutes without traffic and takes tens of seconds to wake, so the first punch of the morning would stall. Use a paid instance (or keep it warm), and put the database in the same region as the web service.
- **Database:** use the pooled connection string if your provider offers one. `DB_POOL_MAX` (default 5) sets connections per instance.
- **Backups.** Turn on the provider's point-in-time recovery and check its history window on your plan. Also take your own logical backup regularly: `DATABASE_URL=... scripts/backup.sh /safe/place`. **Back up `DATA_ENCRYPTION_KEY` separately**; without it encrypted bank, PAN, UAN and two-factor data cannot be read.
- **Restore drill (do this once before go-live, then every quarter):** create a new empty database, load the latest backup with `gunzip -c file.sql.gz | psql "$NEW_DATABASE_URL"`, start a copy of the app pointed at it with the same `DATA_ENCRYPTION_KEY`, sign in and open a payslip and a bank file. A backup you have not restored is not a backup.
- **Monitoring.** Point an uptime monitor at `/health` (it checks the database). The server prints one JSON line for any request slower than one second or that fails with a 5xx, for example `{"status":200,"ms":1840,"method":"GET","path":"/api/admin/insights"}`; set an alert on those in your log service.
- **Secrets:** `DATA_ENCRYPTION_KEY` (required for payroll identity data and two-factor), `RESEND_API_KEY` and `MAIL_FROM` (optional, for email), `SETUP_TOKEN` (remove after the first administrator exists). Rotate the database password after setup.
- **Limits:** `LOGIN_IP_LIMIT` (default 5000 sign-in attempts per address per 15 minutes; an office behind one address needs this above its headcount) and the per-email limit of 10 per 15 minutes.

## Phone push notifications (Android)

Every notification that reaches the in-app bell can also be pushed to the person's Android phone. It uses Firebase Cloud Messaging and is off until you set it up; nothing breaks without it.

1. In the Firebase console (free) create a project, then **Add app → Android** with the package name `com.laxmiindia.hrms` (or your `ANDROID_PACKAGE`).
2. Download `google-services.json`. In GitHub: **Settings → Secrets and variables → Actions → New repository secret** named `GOOGLE_SERVICES_JSON`, value = the whole file. The next Android build includes it.
3. In Firebase: **Project settings → Service accounts → Generate new private key**. Paste the downloaded JSON, as one value, into a Render environment variable named `FCM_SERVICE_ACCOUNT`. Keep that file private; anyone with it can send notifications as your app.
4. Build and install the new APK. The app asks for notification permission after sign-in.

**iPhone:** apps installed through Sideloadly with a free Apple ID cannot receive push (Apple requires a paid developer account for push). iPhone users still see everything in the in-app bell and the Alerts tab, which refresh when the app opens. Paid-account push would need an Apple key added in Firebase and a signed build.

Push is best effort: a failed send is logged and never blocks the action. Phones that uninstall the app are forgotten automatically.

## Known limits

- One application instance. The write queue and the sign-in/rate-limit counters live in memory, so running two instances would lose the ordering guarantee. Scaling out needs the write ordering moved into the database (row locks or advisory locks) and the counters moved to a shared store.
- Documents are stored in the database (2 MB each). Move to object storage if volume grows.
- Device attestation (Play Integrity, App Attest) is not in place; spoofing resistance relies on device binding, mock-location flags and server-side checks.
