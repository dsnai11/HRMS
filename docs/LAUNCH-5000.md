# Launching for 5,000 employees

What the system needs to run smoothly for about 5,000 people across India, and what was
measured. Read this before the go-live date.

## What was tested

A copy with 5,000 employees in 30 branches and a month of attendance (125,000 shifts):

| Action | Result |
| --- | --- |
| 1,000 punch-ins, 25 at the same moment | all recorded; 12 database queries each |
| Sign-in, Home, Employees (25 a page), search, approvals, chat | under 0.2 s, 2–16 queries |
| Attendance records | 100 a page with search (was every row: 2.9 MB for one day) |
| Monthly muster for 5,000 | about 2–4 s; shown 100 a page with search |
| Payroll run for 5,000 | about 4 s (77 queries) |
| Announcement, review cycle, training to everyone | under 1 s each (was over the 20 s request limit) |
| Leave accrual for everyone | runs in the background; the admin is notified when done |

Also changed for this size: the Overview shows the latest 20 people working (not all);
Devices, the punch-map table, review cycles and payroll runs list 100 at a time with search;
OD punch is set up by searching for people; the punch map draws on a canvas; the web portal
checks for chat messages every 10 s (30 s in a background tab); emails to many people are
queued at the mail provider's pace; phone pushes go out ten at a time.

## Hosting you must change before launch

### 1. Database: leave the free plan

The Neon project is on the **free plan with a 1 GB limit**. Attendance, punch events and the
activity log alone grow about 200 MB a month at 5,000 people; with selfies in the database it
would fill in two days. Move to a paid plan (Neon "Launch" or "Scale").

Put the database **near the server and near India**: today it is in `aws-us-east-2` (Ohio).
Create the paid project in **AWS Asia Pacific (Singapore) `ap-southeast-1`** (or Mumbai
when offered), copy the data across (the database is small now, so this takes minutes), and
change `DATABASE_URL` on Render. Use the **pooled** connection string.

### 2. File storage for selfies and documents (required)

A selfie is now about 15–25 KB. 5,000 people punching in and out is still 5–6 GB a month,
plus documents and resumes. Set up S3-compatible storage and the app keeps files there,
with only a reference in the database:

- **Cloudflare R2** (recommended: 10 GB free, then about $0.015 per GB a month, no download
  charges). Create a bucket, then an API token with *Object Read & Write* on that bucket.
- Or AWS S3 in `ap-south-1` (Mumbai), or Backblaze B2.

Set on Render:

| Variable | Example |
| --- | --- |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | `lifc-hrms-files` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from the API token |
| `S3_REGION` | `auto` for R2; `ap-south-1` for AWS Mumbai |

Keep the bucket **private** (no public access); every file is served through the app after
its permission checks. Files already in the database keep working. Selfies are deleted after
`PHOTO_RETENTION_DAYS` (default 90) from storage too.

### 3. Server (Render)

- Use a paid instance that does not sleep: at least **Standard (2 GB)**. The free instance
  sleeps after 15 minutes and takes up to a minute to wake: the first punch of the morning
  would fail.
- Put it in the **Singapore** region, next to the database.
- `DB_POOL_MAX`: default is now 10 connections. Keep it under the database plan's limit if you run more than one instance.
- `MAIL_PER_SECOND`: your mail provider's sending rate (Resend's default is 2).

### 4. Before the first day

- Import employees with the bulk CSV import and check managers and branches: approvals,
  OD and the branch limits for HR all depend on them.
- Approve phones in batches by branch on the days before, not on launch morning
  (Administration → Devices, search "pending").
- Stagger the roll-out by region (for example North on Monday, West on Wednesday) so
  device approvals and questions arrive in manageable numbers.
- Switch on the GitHub database backup (`DATABASE_URL`, `BACKUP_PASSPHRASE` secrets) and do
  one restore test (`docs/OPERATIONS.md`).
- Set the security policy (Administration → Security): office addresses for HR and admin,
  idle sign-out, and two-factor login for staff.
