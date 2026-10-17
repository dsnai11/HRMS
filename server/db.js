import { readFile } from "node:fs/promises";
import { serializedStore, openPostgres } from "./postgres.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  randomBytes,
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
export const tokenHash = (token) =>
  createHash("sha256").update(token).digest("hex");
export function openDatabase(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), {
      recursive: true,
    });
  const db = new DatabaseSync(path);
  db.exec(SQLITE_SCHEMA);
  // Databases created before the shift rules lack these columns.
  const have = new Set(
    db
      .prepare("PRAGMA table_info(shifts)")
      .all()
      .map((c) => c.name),
  );
  for (const [name, ddl] of [
    ["required_out_at", "TEXT"],
    ["day_type", "TEXT"],
    ["half_day_reasons", "TEXT NOT NULL DEFAULT '[]'"],
  ])
    if (!have.has(name))
      db.exec(`ALTER TABLE shifts ADD COLUMN ${name} ${ddl}`);
  return serializedStore({
    dialect: "sqlite",
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    async transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  });
}
export async function createAdmin(db, { name, email, password }) {
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
  if (await db.prepare("SELECT id FROM users WHERE role='admin'").get())
    throw new Error("Administrator already exists.");
  await db
    .prepare(
      "INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
    )
    .run(
      name,
      email.trim().toLowerCase(),
      passwordHash(password),
      "admin",
      new Date().toISOString(),
    );
}
export const SQLITE_SCHEMA =
  "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;\n    CREATE TABLE IF NOT EXISTS workplaces (\n      id INTEGER PRIMARY KEY, name TEXT NOT NULL, latitude REAL NOT NULL,\n      longitude REAL NOT NULL, radius REAL NOT NULL, max_accuracy REAL NOT NULL\n    );\n    CREATE TABLE IF NOT EXISTS users (\n      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,\n      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','employee')),\n      workplace_id INTEGER REFERENCES workplaces(id), active INTEGER NOT NULL DEFAULT 1,\n      must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL\n    );\n    CREATE TABLE IF NOT EXISTS sessions (\n      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL\n    );\n    CREATE TABLE IF NOT EXISTS shifts (\n      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),\n      workplace_id INTEGER NOT NULL REFERENCES workplaces(id), workplace_name TEXT NOT NULL,\n      site_latitude REAL NOT NULL, site_longitude REAL NOT NULL, radius REAL NOT NULL, max_accuracy REAL NOT NULL,\n      in_at TEXT NOT NULL, in_latitude REAL NOT NULL, in_longitude REAL NOT NULL, in_accuracy REAL NOT NULL,\n      out_at TEXT, out_latitude REAL, out_longitude REAL, out_accuracy REAL,\n      required_out_at TEXT, day_type TEXT, half_day_reasons TEXT NOT NULL DEFAULT '[]'\n    );\n    CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts(user_id) WHERE out_at IS NULL;\n    CREATE TABLE IF NOT EXISTS audit (\n      id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL,\n      detail TEXT NOT NULL, created_at TEXT NOT NULL\n    );\n    CREATE TABLE IF NOT EXISTS devices (\n      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),\n      device_id TEXT NOT NULL, platform TEXT, model TEXT, secret_hash TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','approved','revoked')),\n      registered_at TEXT NOT NULL, last_seen_at TEXT, decided_by INTEGER REFERENCES users(id), decided_at TEXT,\n      UNIQUE(user_id, device_id)\n    );\n    CREATE UNIQUE INDEX IF NOT EXISTS one_approved_device ON devices(user_id) WHERE status='approved';\n    CREATE TABLE IF NOT EXISTS punch_events (\n      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), shift_id INTEGER,\n      action TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected')),\n      reason TEXT, flags TEXT NOT NULL DEFAULT '[]', device_row_id INTEGER,\n      latitude REAL, longitude REAL, accuracy REAL, signals TEXT, created_at TEXT NOT NULL\n    );\n    CREATE INDEX IF NOT EXISTS punch_events_user ON punch_events(user_id, id);";
export async function openConfiguredDatabase() {
  if (process.env.DATABASE_URL) {
    const schema = await readFile(
      new URL("./schema-postgres.sql", import.meta.url),
      "utf8",
    );
    return openPostgres(process.env.DATABASE_URL, schema);
  }
  if (process.env.REQUIRE_POSTGRES === "true" || process.env.RENDER === "true")
    throw new Error(
      "DATABASE_URL is required for hosted attendance; refusing ephemeral SQLite storage.",
    );
  return openDatabase(process.env.DATABASE_PATH || "./data/hrms.sqlite");
}
