// Embedded PostgreSQL (PGlite) for tests and local development without a server.
import { createPostgresStore } from "./postgres.js";
import { runMigrations } from "./migrate.js";

export async function openPglite(dataDir, { beforeMigrate } = {}) {
  const { PGlite } = await import("@electric-sql/pglite");
  const engine = dataDir ? new PGlite(dataDir) : new PGlite();
  // PGlite's query() takes one statement; exec() takes many but no parameters.
  const query = async (sql, params = []) =>
    params.length
      ? engine.query(sql, params)
      : ((await engine.exec(sql)).at(-1) ?? { rows: [], affectedRows: 0 });
  const db = createPostgresStore({
    query,
    connect: async () => ({ query, release() {} }),
    end: () => engine.close(),
  });
  await beforeMigrate?.(engine);
  await runMigrations(db);
  return db;
}
