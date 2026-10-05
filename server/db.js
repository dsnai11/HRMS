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
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workplaces (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, latitude REAL NOT NULL,
      longitude REAL NOT NULL, radius REAL NOT NULL, max_accuracy REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','employee')),
      workplace_id INTEGER REFERENCES workplaces(id), active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      workplace_id INTEGER NOT NULL REFERENCES workplaces(id), workplace_name TEXT NOT NULL,
      site_latitude REAL NOT NULL, site_longitude REAL NOT NULL, radius REAL NOT NULL, max_accuracy REAL NOT NULL,
      in_at TEXT NOT NULL, in_latitude REAL NOT NULL, in_longitude REAL NOT NULL, in_accuracy REAL NOT NULL,
      out_at TEXT, out_latitude REAL, out_longitude REAL, out_accuracy REAL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts(user_id) WHERE out_at IS NULL;
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
  return db;
}
export function createAdmin(db, { name, email, password }) {
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
  if (db.prepare("SELECT id FROM users WHERE role='admin'").get())
    throw new Error("Administrator already exists.");
  db.prepare(
    "INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
  ).run(
    name,
    email.trim().toLowerCase(),
    passwordHash(password),
    "admin",
    new Date().toISOString(),
  );
}
