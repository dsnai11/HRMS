# HRMS roadmap

Target: an enterprise HRMS for 1,000+ employees across several companies and branches, comparable in scope to Keka, greytHR or Zoho People, with India-specific payroll and compliance.

Each stage ships on its own, is tested, and leaves the system usable.

## Stage 0 — Attendance (done)
Geofenced mobile punching, device binding, anti-spoofing checks, shift rules (grace, 9-hour day, half day), one shift per day, security events.

## Stage 1 — Foundation and people (in progress)
- PostgreSQL only, versioned migrations.
- Companies and branches; every record belongs to a company.
- Roles and permissions: super admin, admin, HR, employee, and managers derived from the reporting line.
- Departments, designations, reporting managers.
- Full employee profile (personal, job, emergency contact) with self-service for contact details.
- Manager views: my team and their attendance.
- Modular server (routes per area) so later modules have a home.

## Stage 2 — Time off and attendance policy (in progress)
Done:
- Holiday calendars per company or branch; weekly offs including chosen Saturdays.
- Leave types, accrual (monthly or yearly), balances ledger, carry-forward, adjustments; apply, approve, reject, cancel.
- Attendance regularization (missed or wrong punch, on duty, work from home) with approval, window and monthly limit.
- Approvals inbox for managers and HR; monthly muster with payable and loss-of-pay days; employee calendar.

Still to do:
- Shift and policy per branch or employee (replacing the single global policy); per-company timezone.
- Multi-level approval chains (manager then HR); delegation when an approver is away.
- Comp-off, leave encashment, optional holidays, sandwich-leave rule.
- Leave in the mobile app.

## Stage 3 — Payroll
- Salary structures and components, revisions, arrears.
- Monthly payroll run from attendance and leave; loss of pay.
- India statutory: PF, ESI, professional tax, TDS (old and new regime), gratuity.
- Payslips (PDF), bank advice files, statutory reports, Form 16 data.
- Bank, PAN, Aadhaar and UAN stored in a separate, access-logged and encrypted store.
- Must be reviewed by a payroll professional or CA before real use.

## Stage 4 — Hiring, onboarding, exit
- Job openings, candidate pipeline, interview feedback, offers and offer letters.
- Onboarding checklists and document collection; asset allocation.
- Resignation, notice period, clearance, full and final settlement, experience letters.

## Stage 5 — Insight, engagement and hardening
- Dashboards: headcount, attrition, attendance, leave, payroll cost.
- Notifications (email and push), announcements, helpdesk, policy acknowledgement.
- Performance: goals, reviews, appraisal cycles. Training records.
- Two-factor login, SSO (Google / Microsoft), IP and session controls.
- Document storage with retention; API and exports.
- Scale: remove request serialization, background jobs, backups and restore drills, load tests, monitoring.
- Real device attestation (Play Integrity, App Attest).

## Principles
- Every query is scoped to a company; permissions are checked on the server, never only in the UI.
- Sensitive personal data is added only together with the controls that protect it.
- Money and statutory calculations get unit tests with worked examples.
