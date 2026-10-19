import { readdir, readFile } from "node:fs/promises";

// Applies server/migrations/*.sql in name order, once each. Every migration runs
// in its own transaction and is recorded in schema_migrations.
export async function runMigrations(
  db,
  dir = new URL("./migrations/", import.meta.url),
) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    (await db.prepare("SELECT name FROM schema_migrations").all()).map(
      (r) => r.name,
    ),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(new URL(file, dir), "utf8");
    await db.transaction(async () => {
      await db.exec(sql);
      await db
        .prepare("INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)")
        .run(file, new Date().toISOString());
    });
  }
}
