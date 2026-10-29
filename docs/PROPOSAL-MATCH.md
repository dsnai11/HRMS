# Laxmi India Finance HRMS: status against the Unthinkable proposal

This maps every user story in the proposal (V2, 12 modules) to what this system does. "Done" means it works end to end and has automated tests. "Partly" says what is missing. "Needs you" means it depends on something only the company can supply (an API, a device, an account).

## Module 01: Recruitment and ATS

| ID | Story | Status |
| --- | --- | --- |
| RCT-01 | Hiring manager raises a requisition (role, department, positions, qualifications, pay range) | Done: *Requisitions* page for managers; HR approves or declines with a reason |
| RCT-02 | Publish to LinkedIn, Naukri, Indeed and the careers page in one action | **Partly.** The public careers page is live and each opening has a ready-made advert (copy to any site). Posting directly to LinkedIn/Naukri/Indeed needs their paid APIs and credentials, which the company must provide |
| RCT-03 | Kanban pipeline | Done: *Pipeline board*, drag a candidate between stages |
| RCT-04 | Skill matrix and minimum criteria | Done: skills and minimum experience per opening; every candidate gets a match score; low matches are flagged |
| RCT-05 | Automated, templated emails on stage changes | Done: acknowledgement, interview invitation, rejection, offer, welcome; editable. Sent when email is set up (`RESEND_API_KEY`, `MAIL_FROM`); otherwise the candidate's timeline records that nothing was sent |
| RCT-06 | Branded candidate portal with progress tracker | Done: careers page with apply form and a private tracking link |
| RCT-07 | Dynamic offer letter, CTC breakup, e-acceptance | Done: breakup table in the letter; the candidate accepts online by typing their name (recorded with time and address). This is a click-to-accept record, not a certified e-signature |
| — | Resume parsing (module summary) | Done: PDF and Word (.docx) resumes are read for name, email, phone, years of experience and skills, which feed the match score; HR can search inside resumes and re-read one. Photos and old .doc files are stored but not read (that needs OCR). Resumes from every source (LinkedIn, Naukri, WhatsApp, agencies, imports) arrive in one inbox per job (*RMS*) |
| RCT-10 | Recruitment dashboard | Done: funnel, time to hire, time to fill, offer acceptance, source of hire |

## Module 02: CIBIL score integration

Done as the integration layer the proposal describes: candidate consent (online or recorded by HR), a bureau connection you configure (address, key, request format, where the score is in the answer) with a manual-entry fallback, risk bands you set, every consent, check and report view in an audit log, and an optional rule that blocks hiring until a check is on file. **Needs you:** the bureau's API details. Without them HR types the score from the bureau's report.

## Module 03: Interview management and question bank

| ID | Story | Status |
| --- | --- | --- |
| INT-01 | Schedule from the candidate with a panel | Done |
| INT-02 | Calendar invite and notification to the panel | Done: email with an `.ics` file (opens in Google Calendar, Outlook, Apple), plus an "Add to Google Calendar" link. It is not a live Google Calendar API integration |
| INT-03/05 | Department-wise question bank with type and difficulty; admin UI | Done, including pasting many questions at once |
| INT-04 | Interviewer reviews questions; timeline for HR | Done |
| INT-05 | Consolidated scorecard across the panel | Done |
| INT-06 | Interview analytics | Done: by department, panel consistency, question effectiveness |

The bank starts empty: the proposal says the company's HR team writes the questions.

## Module 04: Employee onboarding

Done: checklists owned by HR, IT, Finance, Admin, the manager and the employee; the pre-joining portal (documents, details, bank, NDA and policy sign-off with typed-name consent); a welcome email with login details and manager contact; IT, Finance and Admin are told when someone is hired; a readiness dashboard (documents, policies, tasks, assets, training, credit check).

## Module 05: Employee master and organisation

Done: 360° profile (education, experience, skills, certifications with HR verification), interactive org chart, promotions, transfers, increments and confirmations with letters, separation workflow with clearance and full and final, grades with salary bands, cost centres, business units, departments, designations, custom fields and renamed terms.

## Module 06: Attendance and leave

| ID | Story | Status |
| --- | --- | --- |
| ATT-01 | Mark attendance by phone with geo-fencing, or by biometric device | Phone: done. Biometric: **partly**, CSV import works; a live device connection needs the device make and its SDK or API |
| ATT-02 | Fixed, flexible, rotational and night shifts, by person or department | Done: ready-made templates, assignment to company, branch, department or person, day-by-day roster |
| ATT-03 | Regularisation with approval | Done |
| ATT-04 | CL, PL, SL, LOP, comp-off, maternity; balances and status | Done, including comp-off earned on holidays and weekly offs with an expiry |
| ATT-05 | Manager's team calendar and coverage | Done |
| ATT-06 | Leave policies (accrual, carry-forward, encashment, notice) | Done |
| ATT-07 | Real-time attendance reports | Done |

## Module 07: Payroll

Done: salary structures, one-run payroll from attendance and leave, PF, ESI, professional tax, TDS, labour welfare fund, arrears, loans, claims, bonus, gratuity, full and final, bank advice file, ECR and challan files, PDF payslips. Added: grade-band warning when setting pay; investment declarations that feed TDS (see ESS-03).

## Module 08: Performance

Done: goals with weights, KRAs by designation, self and manager review, release, continuous feedback, and anonymous 360° rounds (PER-05): HR opens a round, each person is rated by themselves, their manager, their team and peers; results are group averages with unsigned comments, and the peers-and-team group stays hidden below three answers.

## Module 10: Employee self-service

| ID | Story | Status |
| --- | --- | --- |
| ESS-01 | Update personal information with supporting documents and approval | Done: contact details are edited directly; **bank changes need a proof and someone else's approval** |
| ESS-02 | 24 months of payslips and year-to-date summary | Done |
| ESS-03 | Investment declarations with proof | Done: sections and limits, provisional until verified, regime comparison, verified amounts feed TDS |
| ESS-05 | Helpdesk with response times | Done: configurable hours by priority, overdue flagged |
| ESS-06 | Employment documents | Done: appointment, offer, confirmation, promotion, increment letters |

## Module 11: Laxmi AI bot and internal chat

Done on the web portal (branch `claude/stage7-bot`):

- **Internal chat** (*Messages*): direct messages with any colleague, group chats created by managers and HR, unread counts, new messages every few seconds, desktop alerts through the browser once the person allows them.
- **Laxmi** (*Ask Laxmi*): answers from the person's own records (leave balance, holidays, payday, latest payslip, this month's attendance; for managers, who in the team is on leave or punched in and what waits for approval); a guided leave application that fills in the request and sends it only when the person presses Confirm; HR's knowledge base and the company policies as searchable answers; a log of every question and answer with helpful / not helpful feedback, so HR can add answers for what went unanswered.
- **Free text by Claude**, optional: with `ANTHROPIC_API_KEY` set, questions the rules cannot answer go to Claude with only the asking person's own facts and matching knowledge-base entries. It has no tools and cannot act.

Also in the phone app (Messages and Ask Laxmi). Chat is text only (no files, no read receipts per person).

## Module 12: Reports, analytics and compliance

Done: the HR Command Centre (live headcount by department and branch, joiners and leavers this month, monthly and 12-month attrition, open positions, attendance and leave today, workforce mix by gender, age and service), Insights dashboards, payroll cost report by department, cost centre, business unit, branch, grade and employment type against budget, statutory exports (ECR, ESIC, PF and ESI challans, PT, LWF), tax statements, gratuity liability, activity log, and reports emailed on a schedule (daily, weekly or monthly).

## Configuration and customisation scope

Done: renamed terms, custom fields, shift and leave rules, salary components and statutory settings, multi-level leave approval (up to three steps: manager, manager's manager, HR) with reminders and escalation to HR, custom roles with chosen rights, optionally limited to branches (region- or entity-wise permission sets), and SMS alerts through Twilio or any HTTP gateway (**needs you:** an SMS account with DLT-registered templates). Attendance corrections have their own approval chain with the same rules. Standard HR roles (HR Manager, HR Executive, Branch HR, Recruiter, Payroll Executive and others) can be added in one step.

## Things the proposal assumes that are not software

Data migration from old systems (CSV bulk import exists), hosting, penetration testing, certifications (ISO 27001, CMMI) and support SLAs.
