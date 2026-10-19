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

## Stage 3 — Payroll (in progress)

Done:

- Salary structure, per-employee salaries with revision history; monthly runs from the muster with draft, approval and paid states; one-off adjustments.
- PF (₹25,000 ceiling from 17 Sep 2026, labour-code 50% rule), ESI, professional tax by state, TDS under the new and old regimes with opening balances.
- Payslips (printable), payroll register, PF, ESI, professional-tax and bank exports.
- Bank, PAN and UAN stored encrypted, masked and audited; `payroll` role; optional maker-checker.

- Arrears from back-dated revisions, loans and advances, reimbursement claims, statutory bonus, leave encashment, gratuity, ECR and ESIC upload files, Form 130 and 138 data.

Still to do:

- ECR 2.0 layout and ESIC `.xls`; perquisite tax on interest-free loans.
- Salary structures per grade or employee group; investment declarations and proof workflow for the old regime.
- Must be reviewed by a payroll professional or CA before real use.

## Stage 4 — Hiring, onboarding, exit (done)

- Job openings, candidate pipeline, interviews and feedback, offers and offer letters, hire to employee.
- Joining checklists (standard or company's own); asset allocation and return.
- Resignation and company-initiated exits, notice period, clearance, full and final settlement through payroll, relieving and experience letters, mid-month exit proration.

Still to do:

- Document collection and storage for candidates and joiners (needs file storage; stage 5).
- Careers page and applicant self-service; email and calendar invites (needs notifications; stage 5).
- Rehire flow, notice-buyout approvals, multi-level exit approval.

## Stage 5 — Insight, engagement and hardening (mostly done)

Done: dashboards, in-app notifications and email, announcements, helpdesk, policy acknowledgement, goals and review cycles, training records, document storage, two-factor login, session controls.

Still to do:

- Single sign-on (Google / Microsoft), IP allow-lists, API tokens for integrations.
- Push notifications to the phone app; calendar invites for interviews.
- Document storage in object storage with retention rules (documents are in the database for now).
- 360-degree feedback, calibration, goal cascading, learning paths.
- Scale out beyond one instance (write ordering in the database, shared counters); background jobs. Reads already run in parallel, backups/restore drill and monitoring are in `docs/OPERATIONS.md`.
- Real device attestation (Play Integrity, App Attest).

## Stage 6 — Match Addetto HRMS (in progress)

Done: phone self-service screens, selfie at punch, shift rules per branch or employee, directory, referrals, career changes with letters, forgot password, employee tax statement.

Also done: attendance import, minimum app version, PF/ESI challans, Labour Welfare Fund, KRAs and feedback.

Also done: rosters.

Also done: Android push (iPhone needs a paid Apple account).

Still to do: customisable dashboard, LMS content, live biometric device connection (see `docs/COMPARISON.md`).
