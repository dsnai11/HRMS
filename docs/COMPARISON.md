# Compared with Addetto HRMS

Addetto HRMS (Intero Software LLP) is an Indian HRMS with an employee mobile app. This compares what their public feature page and App Store release notes describe against this system. It is a feature checklist, not a copy of their screens, text or branding. Status as of this branch.

| Area                                                       | Addetto         | Here                                                                                                          |
| ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| Recruitment to resignation lifecycle                       | yes             | Yes: openings, candidates, interviews, offers, onboarding, exit, full and final                               |
| Increments, promotions, transfers                          | workflows       | Yes: recorded with effective date, applied to profile and salary, letters                                     |
| Letters online                                             | yes             | Offer, promotion, transfer, increment, confirmation, relieving, experience                                    |
| Dues clearance and F&F                                     | yes             | Yes: clearance checklist, settlement posted into the final payroll                                            |
| Attendance from mobile, geo-tagged                         | yes             | Yes, with anti-spoofing (mock-location flags, device binding, risk rules)                                     |
| Selfie at punch                                            | yes (app 3.1.1) | Yes, optional per company; kept 90 days                                                                       |
| Attendance source and history in app                       | yes             | Yes (source shown for corrections and on-duty)                                                                |
| Device locking                                             | yes             | Yes: one approved phone per employee                                                                          |
| Biometric machine import                                   | yes             | CSV import (employee code, date, in, out) with a dry run; no live device connection                           |
| Customisable attendance policies, shifts                   | yes             | Yes: shift rules per company, branch or employee, plus a day-by-day roster with rest days                     |
| On-duty, work from home, regularisation                    | yes             | Yes, with manager approval                                                                                    |
| Leave: policies, accrual, carry-over, cancel, holiday list | yes             | Yes (phone app too)                                                                                           |
| Payroll: PF + ECR, ESI, PT, TDS, bonus                     | yes             | Yes. ECR as the classic text file; ESIC as CSV                                                                |
| Labour Welfare Fund                                        | yes             | Yes: per-state rule (amounts, months, wage limit); you enter the state figures                                |
| ESI challans                                               | yes             | Challan summary CSVs (ESI; PF A/c 01, 02, 10, 21) plus the ECR and ESIC upload files                          |
| Form 16 download in app                                    | yes             | Employee tax statement; Form 130/138 data for filing. No official Form 16 file                                |
| Performance: reviews, appraisal cycle                      | yes             | Yes: goals, self and manager review, release                                                                  |
| KRA/KPI by role, continuous feedback                       | yes             | KRAs by designation applied as goals; praise/improve/private feedback. No KPI scoring formulas                |
| Analytics dashboard                                        | yes             | Yes: show, hide and reorder widgets per person; includes birthdays, anniversaries and new joiners             |
| Alerts and notifications                                   | yes             | In-app bell, email when configured, Android push (needs Firebase set up); no iPhone push with a free Apple ID |
| Employee directory (app)                                   | yes             | Yes                                                                                                           |
| Documents and acknowledgement                              | yes             | Yes: upload, verify, policy acknowledgement                                                                   |
| Helpdesk                                                   | yes             | Yes (web and phone)                                                                                           |
| Refer a candidate                                          | yes             | Yes (web and phone)                                                                                           |
| LMS / courses                                              | yes             | Courses with lessons, quizzes, certificates, auto-assign and reminders; videos are links, not hosted          |
| Forgot password                                            | yes             | Yes: emailed link (needs email set up and `APP_URL`); otherwise HR resets                                     |
| Version-gated punching                                     | yes             | Yes: set the oldest app version allowed to punch                                                              |
| Data security: encrypted sensitive fields                  | yes             | Yes (AES-256-GCM), two-factor on the web, session controls                                                    |
| Absconding and manager-initiated separation                | yes             | Yes: absconding list, manager asks HR to separate, HR approves into an exit; manager's view on resignations   |
| Bill-backed salary reimbursements for TDS                  | yes             | Yes: bill-backed components, bills verified by payroll, verified amount off taxable income                    |
| Mid-year and year-end appraisal, competencies              | yes             | Yes: cycle phases, core competencies rated self then manager, goal change history                             |
| Classroom training sessions                                | yes             | Yes: scheduled sessions, invitations, seats, attendance completing tracked training                           |

## Still to build to match

a live biometric device connection.
