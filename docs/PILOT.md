# Running a pilot

A short trial with real people before everyone moves over. Suggested: **one branch, 10 to 30 employees, two weeks, one trial payroll.** Nothing here needs code changes.

## Before day 1: set up (about half a day)

1. **Server.** Paid Render instance (not the sleeping free one); `DATA_ENCRYPTION_KEY`, `APP_URL`, and if you want email `RESEND_API_KEY` and `MAIL_FROM` set; `SETUP_TOKEN` removed once the first admin exists. See `docs/OPERATIONS.md`.
2. **Company and structure.** Organization → branches (with the **state**, which decides professional tax), departments, designations.
3. **Workplaces.** One per office, with GPS coordinates and a radius. Stand at the door with a phone and check the coordinates before trusting them; keep the radius generous enough for real GPS error (50 to 150 m for a branch).
4. **Shift rules.** Workplaces → Shift rules, if your times differ from 9:30 / 15 minutes grace / 9 hours / 6:30 pm. Set the weekly off and holidays under Leave & holidays. Set the **attendance start date** to the first pilot day so earlier days are not counted.
5. **Employees.** Employees → Import employees from a spreadsheet. Download the sample, fill it in, check the dry run, import, then **download the temporary-passwords file** and hand each person theirs. Then give each employee their workplace.
6. **Phones.** Install the new APK / IPA. Each person signs in once; you approve their phone under Devices.
7. **Leave.** Leave & holidays → add leave types (or use the defaults) and the leave year start.
8. **Payroll set-up.** Payroll → Salary structure (defaults, then adjust), Statutory & settings (professional tax for each state, plus Labour Welfare Fund rules if they apply), then Salaries → Import salaries. Add **opening balances** for tax already deducted this year, and each person's **PAN, UAN, ESI and bank details** (encrypted).

## During the two weeks

- Day 1: everyone punches in and out once with you watching. Fix workplace coordinates that reject honest punches.
- Check Security events daily: refused punches, mock-location and emulator flags. Talk to people before drawing conclusions; weak GPS indoors is common.
- Have two or three people raise a **leave request**, a **missed-punch correction** and a **helpdesk ticket**, and approve them, to test the approval path with real managers.
- Turn on **selfie at punch** only if you want it; tell people first.
- Keep a list of everything that surprised anyone. That list is the real product backlog.

## The trial payroll (after a full month, or a short test month)

1. Payroll → run the month. Do **not** approve yet.
2. Give your CA or payroll professional the **payroll register**, the **PF and ESI files**, and the salary list. Ask them to recompute 3 to 5 people by hand: a low-salary person (ESI), one near the PF ceiling, one with a loss-of-pay day, and one in the highest tax slab.
3. Compare: paid days against your own attendance, PF, ESI, professional tax, TDS. Differences are either a setting (fix it) or a rule (tell me).
4. Approve only when they agree. An approved run is locked; a draft can be recomputed freely.
5. Open one **payslip** as the employee and one **bank file** to see the formats.

## Go / no-go for the rest of the company

- Honest punches are accepted at every workplace (rejections explained).
- Payroll agrees with your CA for the sample.
- Managers and HR can find and decide their approvals without help.
- You have tried restoring a backup (`docs/OPERATIONS.md`).
- Phones and passwords are handled for everyone in the pilot branch.

Then roll out one branch at a time using the same imports. Moves, new managers and designation changes can be done the same way with the "update existing people" option.

## If you need to start over

Pilot data lives in the same database as the real data. If you want a clean slate before go-live, ask for a reset of the pilot company rather than deleting rows by hand; payroll runs and the audit log are meant to be permanent.
