import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore } from "../server/postgres.js";
import { openConfiguredDatabase } from "../server/db.js";
import { attendanceCases } from "./attendance-cases.js";

async function openTestDatabase() {
  const engine = new PGlite();
  await engine.exec(
    await readFile(
      new URL("../server/schema-postgres.sql", import.meta.url),
      "utf8",
    ),
  );
  const query = (sql, params) => engine.query(sql, params);
  return createPostgresStore({
    query,
    connect: async () => ({ query, release() {} }),
    end: () => engine.close(),
  });
}
attendanceCases(openTestDatabase);

test("PostgreSQL transaction rolls back both the business change and its audit event", async () => {
  const db = await openTestDatabase();
  try {
    await assert.rejects(
      db.transaction(async () => {
        await db
          .prepare(
            "INSERT INTO workplaces(name,latitude,longitude,radius,max_accuracy) VALUES(?,?,?,?,?)",
          )
          .run("Rollback office", 0, 0, 100, 20);
        await db
          .prepare(
            "INSERT INTO audit(actor_id,action,detail,created_at) VALUES(?,?,?,?)",
          )
          .run(null, "rollback_test", "{}", new Date().toISOString());
        throw new Error("deliberate transaction failure");
      }),
      /deliberate transaction failure/,
    );
    assert.equal(
      (await db.prepare("SELECT COUNT(*) n FROM workplaces").get()).n,
      0,
    );
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit").get()).n, 0);
    const saved = await db.transaction(() =>
      db
        .prepare(
          "INSERT INTO workplaces(name,latitude,longitude,radius,max_accuracy) VALUES(?,?,?,?,?)",
        )
        .run("Committed office", 0, 0, 100, 20),
    );
    assert.equal(
      (
        await db
          .prepare("SELECT * FROM workplaces WHERE id=?")
          .get(saved.lastInsertRowid)
      ).name,
      "Committed office",
    );
  } finally {
    await db.close();
  }
});

test("free hosting refuses an ephemeral SQLite fallback when PostgreSQL is missing", async () => {
  const original = {
    DATABASE_URL: process.env.DATABASE_URL,
    REQUIRE_POSTGRES: process.env.REQUIRE_POSTGRES,
  };
  delete process.env.DATABASE_URL;
  process.env.REQUIRE_POSTGRES = "true";
  try {
    await assert.rejects(openConfiguredDatabase(), /DATABASE_URL is required/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
