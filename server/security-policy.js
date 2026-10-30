import net from "node:net";
import { HttpError } from "./http.js";
import { permissionsOf } from "./rbac.js";

// A custom role's rights and branches, as authenticate() loads them for every request.
export async function loadRole(db, user) {
  if (user.role !== "custom") return user;
  const role = await db
    .prepare("SELECT name,permissions,branch_ids FROM custom_roles WHERE id=? AND company_id=?")
    .get(user.custom_role_id, user.company_id);
  user.custom_role_name = role?.name ?? null;
  user.custom_permissions = role ? JSON.parse(role.permissions) : [];
  user.branch_scope = role ? JSON.parse(role.branch_ids) : [];
  return user;
}

// The company's security policy. "Staff" means anyone holding at least one HR or admin
// right; plain employees and the phone app are never limited by address.
export const isStaff = (user) => user.role !== "super_admin" && permissionsOf(user).length > 0;

// Entries are single addresses or ranges (CIDR), IPv4 or IPv6.
export function parseAllowlist(entries) {
  if (!Array.isArray(entries) || entries.length > 50)
    throw new HttpError(400, "List up to 50 addresses or ranges.");
  const out = [];
  for (const raw of entries) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    const [addr, bits, extra] = v.split("/");
    const type = net.isIP(addr);
    const max = type === 4 ? 32 : 128;
    if (
      !type ||
      extra !== undefined ||
      (bits !== undefined && !(/^\d{1,3}$/.test(bits) && Number(bits) <= max))
    )
      throw new HttpError(400, `"${v}" is not an address or a range like 203.0.113.0/24.`);
    out.push(v);
  }
  return [...new Set(out)];
}

export function ipAllowed(ip, list) {
  if (!list.length) return true;
  if (!ip) return false;
  // An IPv4 client can arrive as ::ffff:1.2.3.4.
  const plain = ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  const type = net.isIP(plain) === 6 ? "ipv6" : "ipv4";
  const block = new net.BlockList();
  for (const e of list) {
    const [addr, bits] = e.split("/");
    const t = net.isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) block.addAddress(addr, t);
    else block.addSubnet(addr, Number(bits), t);
  }
  return block.check(plain, type);
}

export const policyOf = (company) => ({
  staff_ip_allowlist: JSON.parse(company?.staff_ip_allowlist || "[]"),
  idle_minutes: Number(company?.idle_minutes ?? 0),
  password_max_days: Number(company?.password_max_days ?? 0),
  require_staff_2fa: Boolean(company?.require_staff_2fa),
});

// Raised for a web sign-in or request from outside the office addresses.
export const outsideOffice = () =>
  new HttpError(
    403,
    "Your account has HR or admin rights, which can be used only from the office network. Connect to the office network (or VPN) and try again.",
    "ip_blocked",
  );
