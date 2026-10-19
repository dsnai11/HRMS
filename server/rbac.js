// Roles and permissions. Managers are not a stored role: anyone with direct
// reports gets team access (see routes/team.js).
export const ROLES = ["super_admin", "admin", "hr", "payroll", "employee"];

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
export const can = (user, permission) =>
  permissionsFor(user.role).includes(permission);

// Roles a caller may grant when creating or editing people.
export function assignableRoles(user) {
  if (user.role === "super_admin") return ROLES;
  if (user.role === "admin") return ["admin", "hr", "payroll", "employee"];
  return ["employee"];
}
