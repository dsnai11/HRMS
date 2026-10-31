// The HR guide: how the HR team runs this HRMS, step by step. It is kept on the
// server and sent only to the HR team (anyone with at least one HR, payroll or
// admin permission), so ordinary employees and managers never receive it. Ask
// Laxmi searches it for the same people.
import { permissionsOf } from "./rbac.js";

/** Employees and managers have no permissions of their own; everyone else is HR team. */
export const isHrTeam = (user) => permissionsOf(user).length > 0;

// Each topic: area (for grouping), title, who needs which right, keywords people
// might type, the steps in order, and tips. Menu paths use the portal's labels.
export const GUIDE = [
  // ---- Getting started ------------------------------------------------------------------------
  {
    id: "first-setup",
    area: "Getting started",
    title: "Set up the company for the first time",
    who: "Administrator",
    keywords: "setup start begin new company configure first day go live",
    steps: [
      "Administration → Organization: add branches, departments and designations. Add grades, cost centres and business units if you use them.",
      "Administration → Workplaces: add each office with its GPS point and radius (25 to 2,000 m). Punches only count inside a workplace.",
      "Workplaces page: set the shift rules (start time, grace, shift hours, earliest punch-out). Without them the standard 09:30 start, 15 minutes' grace and 9 hours apply.",
      "Administration → Leave & holidays → Leave types: click “Add standard Indian types”, then change quotas to match your leave policy. Add holidays and set the weekly offs under Calendar & rules.",
      "Administration → Roles & rights: add the HR roles you need (HR Manager, Payroll Executive, Branch HR and so on) and give them to your team.",
      "Administration → Employees: add people one by one or import a CSV (see “Add or import employees”).",
      "Administration → Payroll → Salary structure: click “Add standard structure”, then enter each person's salary under Salaries.",
      "Documents → Policies: publish the policies everyone must accept.",
    ],
    tips: [
      "Set up leave before importing opening balances. The leave year (January or April start) cannot change once balances exist.",
      "Ask employees to install the phone app and sign in once, then approve their phones under Devices.",
    ],
  },
  {
    id: "roles",
    area: "Getting started",
    title: "Give HR staff the right access",
    who: "Administrator (roles.assign)",
    keywords: "role roles rights access permission permissions branch hr executive manager restrict",
    steps: [
      "Open Administration → Roles & rights.",
      "Click “Add standard HR roles” to get ready-made roles such as HR Manager, HR Executive, Branch HR, Recruiter, Payroll Executive and HR Viewer.",
      "Open a role to change what it can do, or limit it to one or more branches.",
      "Open the person under Administration → Employees and choose their role.",
    ],
    tips: [
      "HR roles do not see salaries; only payroll and administrators do.",
      "Approving a payroll run needs the Payroll Approver right. Give it to someone other than the preparer.",
      "Managers need no role: anyone with direct reports gets the Supervisor and Approvals pages automatically.",
    ],
  },

  // ---- People --------------------------------------------------------------------------------
  {
    id: "add-employee",
    area: "People",
    title: "Add or import employees",
    who: "HR (employees.write)",
    keywords: "add employee new create import csv bulk upload staff join password",
    steps: [
      "Open Administration → Employees.",
      "Click Add employee. Fill in name, email, workplace, department, designation, branch, manager and joining date. The employee code is created automatically (E0001…) unless you type one.",
      "Give them the temporary password. They must change it on first sign-in.",
      "For many people at once, click Import, download the template, fill it in and upload it. Check the dry run before saving, then download the file of one-time passwords.",
      "The same import can update existing people (matched by employee code or email). Only the columns you fill in change.",
    ],
    tips: [
      "People who come through hiring are created by the Hire step, so do not add them again here.",
      "Departments, designations and branches in the CSV must already exist under Organization.",
    ],
  },
  {
    id: "edit-employee",
    area: "People",
    title: "Change an employee's details, reset a password or deactivate",
    who: "HR (employees.write)",
    keywords: "edit change update reset password deactivate disable manager reporting transfer profile",
    steps: [
      "Open Administration → Employees and click the person.",
      "Edit job, personal or emergency-contact details and save.",
      "Use Reset password to give them a new temporary password.",
      "Use Deactivate only for someone who has left without an exit record. Normally close people through Hiring & exits → Exits.",
    ],
    tips: [
      "A manager with active reports cannot be deactivated until the reports move to someone else.",
      "Reporting lines cannot go in a circle; the system refuses that.",
      "Promotions, transfers and increments go through Career changes so a letter and history are kept.",
    ],
  },
  {
    id: "career-changes",
    area: "People",
    title: "Promotion, transfer, increment or confirmation",
    who: "HR (changes.manage)",
    keywords: "promotion promote transfer increment hike raise designation change letter confirmation",
    steps: [
      "Open Administration → Hiring & exits → Career changes.",
      "Choose the person, the kind of change and the effective date, and fill in the new designation, branch or salary.",
      "Apply it on or after the effective date. The profile updates, an increment creates the salary revision, and the employee is told.",
      "Print the letter from the change.",
    ],
    tips: ["An increment above ₹21,000 a month switches ESI off automatically."],
  },
  {
    id: "devices",
    area: "People",
    title: "Approve an employee's phone for punching",
    who: "HR (devices.manage)",
    keywords: "phone device approve mobile app new phone cannot punch pending register",
    steps: [
      "The employee signs in on the phone app once. The phone shows as pending.",
      "Open Administration → Devices.",
      "Check it is the right person (call them if unsure) and click Approve.",
    ],
    tips: [
      "One phone per person. Approving a new phone switches off the old one.",
      "A phone already used by one account cannot be registered to another.",
    ],
  },

  // ---- Attendance ----------------------------------------------------------------------------
  {
    id: "attendance-daily",
    area: "Attendance",
    title: "Check daily attendance and suspicious punches",
    who: "HR (attendance.read)",
    keywords: "attendance today present absent late half day punch report export security fake gps spoof",
    steps: [
      "Overview shows who is working now and today's numbers.",
      "Administration → Attendance records lists every shift with day type (full or half day) and the reason. Filter by date and export to CSV.",
      "Administration → Punch map shows a day's punches on a map with workplace boundaries.",
      "Administration → Security lists refused punches and warnings (fake location, emulator, rooted phone, impossible travel).",
    ],
    tips: [
      "Punching in after start time plus grace, or leaving before the required punch-out, makes a half day.",
      "Selfies, if turned on, are under Attendance records. Each view is logged.",
    ],
  },
  {
    id: "corrections",
    area: "Attendance",
    title: "Missed punch, on duty, work from home and OD",
    who: "Managers and HR (leave.approve)",
    keywords: "missed punch regularize regularisation correction on duty od wfh work from home forgot",
    steps: [
      "The employee raises a request from the phone or My Attendance.",
      "It reaches their manager under Leave → Approvals (HR when there is no manager).",
      "Approve or reject. Approval creates or completes that day's shift.",
      "To allow OD punching, open Workplaces → OD punch and switch it on for the person or for everyone.",
    ],
    tips: [
      "HR sets how many days back a correction may go (default 7) and how many per month (default 5).",
      "On duty and work from home count as full days.",
    ],
  },
  {
    id: "attendance-import",
    area: "Attendance",
    title: "Import attendance from a biometric machine",
    who: "HR (attendance.import)",
    keywords: "import biometric machine csv upload attendance file",
    steps: [
      "Export the punches from the machine as CSV.",
      "Open Workplaces → Import attendance and upload the file.",
      "Check the dry run, then import. Days that already have attendance are skipped.",
    ],
    tips: [],
  },
  {
    id: "shifts",
    area: "Attendance",
    title: "Shift rules, rosters and overtime",
    who: "HR",
    keywords: "shift timing roster rest day weekly off overtime ot late grace",
    steps: [
      "Workplaces page: set shift rules for the company, a branch or one person.",
      "Use the roster to give someone a different shift or a rest day on particular dates.",
      "Workplaces → Overtime: set the overtime rate. Employees claim overtime from My Attendance; managers approve it under Approvals, and it is paid once through payroll.",
    ],
    tips: ["A roster entry beats the standing rule and the weekly off for that date."],
  },
  {
    id: "muster",
    area: "Attendance",
    title: "Close the monthly muster for payroll",
    who: "HR (attendance.read)",
    keywords: "muster monthly payable days lop loss of pay attendance month end",
    steps: [
      "Before the month ends, clear pending leave and correction requests under Approvals.",
      "Open Administration → Monthly muster and choose the month.",
      "Check each person's present, half-day, leave, holiday, weekly-off and absent days. Payable and loss-of-pay days feed payroll.",
      "Export the CSV if you want a copy for records.",
    ],
    tips: ["Days before someone joined, or before the company started using the system, are not counted."],
  },

  // ---- Leave ---------------------------------------------------------------------------------
  {
    id: "leave-setup",
    area: "Leave",
    title: "Set up leave types, holidays and weekly offs",
    who: "HR (leave.manage)",
    keywords: "leave type casual sick earned quota holiday holidays weekly off saturday calendar policy",
    steps: [
      "Administration → Leave & holidays → Leave types: add or edit types (paid or unpaid, yearly quota, monthly or yearly accrual, carry forward, half days, gender, most days per request).",
      "Holidays: add company holidays, or holidays for one branch.",
      "Calendar & rules: choose weekly offs, including which Saturdays are off.",
    ],
    tips: ["Weekly offs and holidays are never deducted from leave."],
  },
  {
    id: "leave-balances",
    area: "Leave",
    title: "Opening balances, adjustments and accrual",
    who: "HR (leave.manage)",
    keywords: "balance opening adjust adjustment accrue accrual carry forward credit add leave",
    steps: [
      "Open Administration → Leave & holidays → Balances.",
      "Enter opening balances as adjustments with a note (for example, carried from the old system).",
      "Accrual runs by itself when balances are read. You can also click Accrue; it is safe to repeat.",
    ],
    tips: ["Earlier years are never filled in automatically, so enter what people bring with them as an adjustment."],
  },
  {
    id: "leave-approvals",
    area: "Leave",
    title: "Approve or cancel leave",
    who: "Managers and HR (leave.approve)",
    keywords: "approve reject leave request pending cancel inbox delegate hand over",
    steps: [
      "Open Leave → Approvals. The number beside it shows what is waiting.",
      "Approve or reject with a note.",
      "To cancel leave that has already started, open Leave & holidays → Requests (HR only).",
      "A manager going away can use Approvals → Hand over approvals to pass their team's approvals to a colleague for up to 90 days.",
    ],
    tips: ["Nobody can decide their own request."],
  },

  // ---- Payroll -------------------------------------------------------------------------------
  {
    id: "payroll-setup",
    area: "Payroll",
    title: "Set up salaries and statutory settings",
    who: "Payroll staff and administrators",
    keywords: "salary structure ctc basic hra pf esi professional tax pt statutory setup",
    steps: [
      "Administration → Payroll → Salary structure: click “Add standard structure” (Basic 50% of gross, HRA 40% of basic, Special allowance as the balance) or build your own.",
      "Salaries: enter each person's monthly gross, or import salaries from CSV with a dry run.",
      "Statutory & settings: check PF, ESI, professional tax for your states and Labour Welfare Fund figures.",
      "If you start part-way through the year, enter each person's opening earnings and tax.",
    ],
    tips: [
      "Bank, PAN, UAN and ESI numbers are stored encrypted only when DATA_ENCRYPTION_KEY is set on the server.",
      "Have your CA confirm the statutory figures before the first real run.",
    ],
  },
  {
    id: "payroll-run",
    area: "Payroll",
    title: "Run monthly payroll",
    who: "Payroll prepares, an administrator approves",
    keywords: "payroll run monthly salary process pay calculate approve paid bank file payslip",
    steps: [
      "Close the muster for the month first (see “Close the monthly muster”).",
      "Administration → Payroll → Payroll runs: create a run for the completed month.",
      "Add one-off earnings or deductions under Adjustments, then recompute the draft. Approved claims, bills, overtime, loans and settlements come in automatically.",
      "Check the payroll register. A run with negative net pay cannot be approved.",
      "The approver approves the run. It locks and payslips appear for employees.",
      "Download the bank file, pay salaries, then mark the run paid.",
      "Download PF (ECR), ESI and professional tax files for filing.",
    ],
    tips: ["Only a completed month can be run, and an approved month cannot be changed. Corrections go into the next month as arrears."],
  },
  {
    id: "tax-declarations",
    area: "Payroll",
    title: "Tax declarations, proofs and Form 16",
    who: "Payroll staff",
    keywords: "tax tds declaration investment proof 80c regime old new form 16 form16 annual statement",
    steps: [
      "Employees fill in their declaration from Payslips & Declarations or the phone app and submit it with proofs.",
      "Administration → Payroll → Tax declarations: review each one, check the proofs and approve or send back.",
      "Approved amounts feed the monthly TDS under the old regime.",
      "At year end, use Bonus, gratuity & tax forms for Form 16 and the annual tax data.",
    ],
    tips: [],
  },
  {
    id: "claims-bills",
    area: "Payroll",
    title: "Reimbursement claims and bills",
    who: "Managers, HR and payroll",
    keywords: "claim claims reimbursement expense travel bill bills fuel phone tax free",
    steps: [
      "Payroll → Reimbursements: set up claim types with yearly limits and taxable or tax-free treatment.",
      "Employees raise claims; managers or HR approve them under Approvals; approved claims are paid with the next run.",
      "Payroll → Reimbursement bills: check bills employees upload against tax-free allowances and approve or reject them.",
    ],
    tips: [],
  },
  {
    id: "loans",
    area: "Payroll",
    title: "Loans and salary advances",
    who: "Payroll staff",
    keywords: "loan advance emi instalment recover deduction",
    steps: [
      "Administration → Payroll → Loans & advances: add the amount and number of instalments.",
      "Each instalment is deducted in the monthly run. Skip one if needed (it moves to the end) or cancel the rest.",
    ],
    tips: ["Any remaining instalments are recovered in the full and final settlement."],
  },

  // ---- Hiring and joining --------------------------------------------------------------------
  {
    id: "recruitment",
    area: "Hiring & joining",
    title: "Open a job and move candidates through hiring",
    who: "HR (recruitment.manage)",
    keywords: "job opening vacancy candidate recruit interview hire resume cv careers requisition",
    steps: [
      "Managers raise a requisition; HR approves it. Or open Administration → Hiring & exits → Openings and add the job directly.",
      "Candidates arrive from the careers page, referrals, agencies, email or RMS, or HR adds them.",
      "Move each candidate through screening and interview. Schedule interviews; interviewers give feedback under Approvals.",
      "Use the Pipeline board for a quick view and Recruitment insights for numbers.",
    ],
    tips: ["Run a credit (CIBIL) check only with the candidate's consent; every check is logged."],
  },
  {
    id: "offer",
    area: "Hiring & joining",
    title: "Send an offer and the joining link",
    who: "HR (recruitment.manage)",
    keywords: "offer letter send joining link portal preboarding pre-boarding accept candidate documents",
    steps: [
      "Open the candidate and create an offer: designation, monthly gross, joining date, probation months and salary breakup.",
      "Mark it sent. The candidate gets a private joining link that works for 30 days without a login.",
      "On the link they accept the offer, fill in their details, upload ID and address proofs and accept the NDA and policies.",
      "Open the candidate, verify each document and approve their details or send them back with a note.",
    ],
    tips: ["If email is not set up, copy the link and send it on WhatsApp."],
  },
  {
    id: "onboarding",
    area: "Hiring & joining",
    title: "Hire and onboard a new joiner",
    who: "HR (recruitment.manage)",
    keywords: "onboarding onboard hire joiner joining checklist buddy induction welcome first day tasks",
    steps: [
      "Open the candidate with an accepted offer and click Hire. Name an onboarding buddy if you like.",
      "The employee is created with a login, and everything from the joining link moves onto their record.",
      "A joining checklist is created with tasks for HR, IT, Admin, Finance, the manager and the joiner. IT, Finance and Admin teams are alerted.",
      "Hiring & exits → Onboarding: follow “Joining soon” and each joiner's checklist progress. Tick off HR tasks.",
      "On the same Onboarding tab, choose who belongs to the IT, Finance and Admin task teams.",
      "Approve the joiner's phone under Devices on day one.",
    ],
    tips: ["Edit the Joining checklist on the Onboarding tab so every hire gets your own tasks instead of the standard ones."],
  },
  {
    id: "probation",
    area: "Hiring & joining",
    title: "Confirm or extend probation",
    who: "HR",
    keywords: "probation confirm confirmation extend review end",
    steps: [
      "Hiring & exits → Onboarding shows probation reviews due within 45 days or overdue.",
      "Talk to the manager, then click Confirm or Extend.",
    ],
    tips: ["The manager and HR get a reminder 15 days before probation ends."],
  },
  {
    id: "assets",
    area: "Hiring & joining",
    title: "Issue and receive company assets",
    who: "HR (assets.manage)",
    keywords: "asset assets laptop phone sim id card issue return",
    steps: [
      "Hiring & exits → Assets: register each asset with a unique tag.",
      "Issue it to a person; receive it back when returned.",
    ],
    tips: ["Assets still held block an exit from completing."],
  },

  // ---- Exits ---------------------------------------------------------------------------------
  {
    id: "exit",
    area: "Exits",
    title: "Handle a resignation and full and final settlement",
    who: "HR (exit.manage) and payroll",
    keywords: "resignation resign exit leaving notice last working day clearance full final settlement fnf relieving experience letter",
    steps: [
      "The resignation arrives under Hiring & exits → Exits (and the manager sees it on Supervisor). HR can also start an exit for termination, retirement or end of contract.",
      "Accept it and set the last working day. A clearance checklist is created for the manager, IT, Finance, HR and each asset held.",
      "Each owner completes their clearance items.",
      "Calculate the full and final settlement: notice recovery (can be waived), leave encashment, gratuity and loan recovery. Post it into the final month's payroll.",
      "Once the run is approved, all clearance is done, assets are back and the last day has passed, complete the exit. The login and phone are closed.",
      "Print the relieving and experience letters.",
    ],
    tips: ["Absconding or other separations also need HR approval on the Exits page before they take effect."],
  },

  // ---- Performance and learning --------------------------------------------------------------
  {
    id: "performance",
    area: "Performance & learning",
    title: "Run an appraisal cycle",
    who: "HR (performance.manage)",
    keywords: "appraisal review cycle performance rating goals kra competency self review manager review release",
    steps: [
      "PMR → Performance: set KRAs by designation and apply them as goals, or let people and managers add goals.",
      "Create a review cycle. Every employee gets a self-review, then their manager reviews them, including core competencies.",
      "Follow progress through each phase.",
      "Release the manager's ratings when you are ready; employees cannot see them before that.",
    ],
    tips: ["Continuous feedback (praise or improve) is private to managers and HR."],
  },
  {
    id: "learning",
    area: "Performance & learning",
    title: "Create courses and training sessions",
    who: "HR",
    keywords: "course training lms learning quiz certificate session classroom induction assign",
    steps: [
      "LMS → My Courses → Manage courses: build a course with lessons and an optional quiz with a pass mark.",
      "Assign it to everyone or one person, or tick “assign to every new joiner”.",
      "Training sessions: schedule a classroom or online session, invite people and mark attendance.",
    ],
    tips: ["Course content locks once anyone starts it. You can reset a person's attempts."],
  },

  // ---- Employee help -------------------------------------------------------------------------
  {
    id: "helpdesk",
    area: "Employee help",
    title: "Answer helpdesk tickets",
    who: "HR (helpdesk.manage)",
    keywords: "helpdesk ticket query complaint question reply resolve",
    steps: [
      "Open Connect → Helpdesk and filter for open tickets.",
      "Assign, reply, or add an internal note the employee cannot see.",
      "Resolve when done. A reply from the employee reopens it.",
    ],
    tips: [],
  },
  {
    id: "announcements-policies",
    area: "Employee help",
    title: "Post announcements and policies",
    who: "HR (announcements.manage, policies.manage)",
    keywords: "announcement notice circular policy policies acknowledge publish handbook",
    steps: [
      "Announcements: post from the home page to everyone, a branch or a department. Pin it, set an expiry or email it.",
      "Documents → Policies → New policy: publish the text. Everyone is asked to accept it.",
      "Changing a policy's text asks everyone to accept again. HR sees who is still pending.",
    ],
    tips: [],
  },
  {
    id: "laxmi-admin",
    area: "Employee help",
    title: "Teach Ask Laxmi new answers",
    who: "HR (bot.manage)",
    keywords: "laxmi bot assistant knowledge answer unanswered teach chatbot",
    steps: [
      "Open Connect → Ask Laxmi and scroll to the knowledge base.",
      "Check “Questions people asked” for anything not answered or marked not helpful.",
      "Click Add answer beside it, write the answer and add other words people might use.",
      "Set the pay day in Settings so Laxmi can answer “when is payday?”.",
    ],
    tips: ["Employees' answers come only from their own records, the knowledge base and policies. This HR guide is never shown to them."],
  },
  {
    id: "cases",
    area: "Employee help",
    title: "Grievance, POSH and whistleblower cases",
    who: "Case committees",
    keywords: "grievance posh harassment whistleblower complaint case concern committee",
    steps: [
      "Employees raise concerns under Connect → Raise a concern.",
      "Administration → Cases: grievances go to HR, POSH only to the Internal Committee, whistleblower reports only to the vigilance committee.",
    ],
    tips: ["Nobody named in a case can see it, and every case opened is logged."],
  },

  // ---- Reports and security ------------------------------------------------------------------
  {
    id: "reports",
    area: "Reports & security",
    title: "Reports, dashboards and the activity log",
    who: "HR (insights.read)",
    keywords: "report reports dashboard insights headcount attrition export custom analytics audit log activity",
    steps: [
      "Administration → HR Command Centre and Insights: headcount, joiners and leavers, attrition, attendance and leave.",
      "Administration → Custom reports: pick the columns and filters you need and export.",
      "Administration → Activity log (administrators): who did what and when.",
    ],
    tips: [],
  },
  {
    id: "security",
    area: "Reports & security",
    title: "Keep accounts and data safe",
    who: "Everyone in HR",
    keywords: "security password two factor 2fa otp authenticator session sign out data privacy",
    steps: [
      "Turn on two-factor login under My Profile → Sign-in security with an authenticator app, and keep the recovery codes safe.",
      "In the same card, check where you are signed in and sign out of devices you don't use.",
      "Reveal bank, PAN or UAN numbers only when you need them. Every reveal and every statutory export is logged.",
    ],
    tips: ["Never share your password. Administrators can reset two-factor for someone who lost their phone."],
  },
];
