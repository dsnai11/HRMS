import { openPostgres } from "./postgres.js";
import {
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password, encoded) {
  const [salt, hash] = encoded.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(hash, "hex"),
  );
}
export async function passwordHashAsync(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (err, k) => (err ? reject(err) : resolve(k))),
  );
  return `${salt}:${key.toString("hex")}`;
}
// Same check without blocking the event loop: scrypt runs on the thread pool, so a
// burst of sign-ins does not stall punches and other requests.
export async function passwordMatchesAsync(password, encoded) {
  const [salt, hash] = encoded.split(":");
  const derived = await new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
  return timingSafeEqual(derived, Buffer.from(hash, "hex"));
}
export const tokenHash = (token) =>
  createHash("sha256").update(token).digest("hex");

// The first company is created with the first administrator (or adopted from
// pre-existing data by ensureDefaultCompany).
async function firstCompany(db, name) {
  const existing = await db
    .prepare("SELECT id FROM companies ORDER BY id LIMIT 1")
    .get();
  if (existing) return existing.id;
  return Number(
    (
      await db
        .prepare("INSERT INTO companies(name,code,created_at) VALUES(?,?,?)")
        .run(name || "Company", "MAIN", new Date().toISOString())
    ).lastInsertRowid,
  );
}
export async function createAdmin(db, { name, email, password, companyName }) {
  if (
    !name ||
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    throw new Error(
      "Supply a name, valid email and password of 12–128 characters.",
    );
  if (
    await db
      .prepare("SELECT id FROM users WHERE role IN ('admin','super_admin')")
      .get()
  )
    throw new Error("Administrator already exists.");
  const companyId = await firstCompany(db, companyName);
  await db
    .prepare(
      "INSERT INTO users(name,email,password_hash,role,company_id,created_at,employee_code) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      name,
      email.trim().toLowerCase(),
      passwordHash(password),
      "super_admin",
      companyId,
      new Date().toISOString(),
      "E0001",
    );
}
// Databases that predate companies get one company that adopts all their data.
export async function ensureDefaultCompany(db, name) {
  const orphan = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM users WHERE company_id IS NULL) + (SELECT COUNT(*) FROM workplaces WHERE company_id IS NULL) n",
    )
    .get();
  if (!orphan.n) return;
  const id = await firstCompany(db, name);
  for (const table of ["users", "workplaces", "audit"])
    await db
      .prepare(`UPDATE ${table} SET company_id=? WHERE company_id IS NULL`)
      .run(id);
}
// People created before employee codes existed get E0001, E0002, … in join order.
export async function backfillEmployeeCodes(db) {
  const rows = await db
    .prepare(
      "SELECT id,company_id FROM users WHERE employee_code IS NULL AND company_id IS NOT NULL ORDER BY id",
    )
    .all();
  const last = new Map();
  for (const { id, company_id } of rows) {
    if (!last.has(company_id))
      last.set(
        company_id,
        (
          await db
            .prepare(
              "SELECT MAX(CAST(SUBSTRING(employee_code FROM 2) AS INTEGER)) n FROM users WHERE company_id=? AND employee_code ~ '^E[0-9]{1,9}$'",
            )
            .get(company_id)
        ).n ?? 0,
      );
    const n = last.get(company_id) + 1;
    last.set(company_id, n);
    await db
      .prepare("UPDATE users SET employee_code=? WHERE id=?")
      .run(`E${String(n).padStart(4, "0")}`, id);
  }
}
export async function openConfiguredDatabase() {
  let db;
  if (process.env.DATABASE_URL) {
    db = await openPostgres(process.env.DATABASE_URL);
  } else if (
    process.env.REQUIRE_POSTGRES === "true" ||
    process.env.RENDER === "true" ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "DATABASE_URL is required for hosted attendance; refusing ephemeral local storage.",
    );
  } else {
    // Local development: an embedded PostgreSQL stored under ./data.
    const { openPglite } = await import("./pglite.js");
    db = await openPglite(process.env.DEV_DATA_DIR || "./data/pglite");
  }
  await ensureDefaultCompany(db, process.env.COMPANY_NAME);
  await backfillEmployeeCodes(db);
  return db;
}

// Inserts many rows in statements of up to 500 rows each, for actions that reach
// everyone in a company (5,000 people is ten statements, not 5,000 round trips).
export async function insertMany(db, table, columns, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    await db
      .prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES ${part.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`,
      )
      .run(...part.flat());
  }
}
