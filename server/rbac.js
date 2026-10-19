// Roles and permissions. Managers are not a stored role: anyone with direct
// reports gets team access (see routes/team.js).
export const ROLES = ["super_admin", "admin", "hr", "employee"];

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
];
const ADMIN = [...HR, "workplaces.manage", "audit.read", "roles.assign"];
const PERMISSIONS = {
  super_admin: [...ADMIN, "companies.manage"],
  admin: ADMIN,
  hr: HR,
  employee: [],
};

export const permissionsFor = (role) => PERMISSIONS[role] ?? [];
export const can = (user, permission) =>
  permissionsFor(user.role).includes(permission);

// Roles a caller may grant when creating or editing people.
export function assignableRoles(user) {
  if (user.role === "super_admin") return ROLES;
  if (user.role === "admin") return ["admin", "hr", "employee"];
  return ["employee"];
}
