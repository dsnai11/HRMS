// Roles and permissions. Managers are not a stored role: anyone with direct
// reports gets team access (see routes/team.js).
// "custom" means the person's permissions come from a role an administrator defined
// (custom_roles); the server loads them onto the user as custom_permissions.
export const ROLES = ["super_admin", "admin", "hr", "payroll", "employee", "custom"];

const HR = [
  "employees.read",
  "employees.write",
  "org.read",
  "org.manage",
  "attendance.read",
  "devices.manage",
  "security.read",
  "leave.manage",
  "leave.approve",
  "leave.read",
  "recruitment.manage",
  "assets.manage",
  "exit.manage",
  "insights.read",
  "helpdesk.manage",
  "announcements.manage",
  "policies.manage",
  "performance.manage",
  "changes.manage",
  "attendance.import",
  "credit.manage",
  "bot.manage",
  "hrchat.use",
  "cases.manage",
];
const PAYROLL = ["payroll.manage", "payroll.read"];
const ADMIN = [
  ...HR,
  ...PAYROLL,
  "payroll.approve",
  "workplaces.manage",
  "audit.read",
  "roles.assign",
];
const PERMISSIONS = {
  super_admin: [...ADMIN, "companies.manage"],
  admin: ADMIN,
  hr: HR,
  // Payroll staff prepare pay but do not see the wider HR record or approve runs.
  payroll: ["employees.read", "org.read", "attendance.read", ...PAYROLL],
  employee: [],
};

export const permissionsFor = (role) => PERMISSIONS[role] ?? [];
export const permissionsOf = (user) =>
  user.role === "custom"
    ? (user.custom_permissions ?? [])
    : permissionsFor(user.role);
export const can = (user, permission) =>
  permissionsOf(user).includes(permission);

// What an administrator can put in a custom role, with a plain description for the
// form. Managing roles themselves stays with administrators.
export const GRANTABLE = {
  "employees.read": ["People", "See employee records"],
  "employees.write": ["People", "Add and edit employees"],
  "changes.manage": ["People", "Promotions, transfers and increments"],
  "org.read": ["Organisation", "See departments, branches and workplaces"],
  "org.manage": ["Organisation", "Change departments, branches and other lists"],
  "workplaces.manage": ["Organisation", "Add workplaces"],
  "attendance.read": ["Attendance", "See everyone's attendance"],
  "attendance.import": ["Attendance", "Import attendance files"],
  "devices.manage": ["Attendance", "Approve employees' phones"],
  "leave.read": ["Leave", "See leave balances and requests"],
  "leave.approve": ["Leave", "Approve anyone's leave and requests"],
  "leave.manage": ["Leave", "Leave types, holidays and balances"],
  "payroll.read": ["Payroll", "See payroll"],
  "payroll.manage": ["Payroll", "Prepare payroll"],
  "payroll.approve": ["Payroll", "Approve payroll runs"],
  "recruitment.manage": ["Hiring", "Openings, candidates and offers"],
  "credit.manage": ["Hiring", "Credit (CIBIL) checks"],
  "exit.manage": ["Hiring", "Exits and settlements"],
  "assets.manage": ["Hiring", "Company assets"],
  "performance.manage": ["Engagement", "Reviews and goals"],
  "announcements.manage": ["Engagement", "Post announcements"],
  "policies.manage": ["Engagement", "Publish policies"],
  "helpdesk.manage": ["Engagement", "Answer helpdesk tickets"],
  "bot.manage": ["Engagement", "Laxmi assistant knowledge and log"],
  "hrchat.use": ["Engagement", "HR team chat (the private HR Team room)"],
  "cases.manage": ["Engagement", "Handle grievances (POSH and whistleblower cases go only to their committees)"],
  "insights.read": ["Reports", "Insights dashboards"],
  "security.read": ["Reports", "Security overview"],
  "audit.read": ["Reports", "Activity log"],
};

// Roles a caller may grant when creating or editing people.
export function assignableRoles(user) {
  if (user.role === "super_admin") return ROLES;
  if (user.role === "admin")
    return ["admin", "hr", "payroll", "employee", "custom"];
  return ["employee"];
}
