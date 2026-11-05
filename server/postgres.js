import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";

// The queue every save waits in. The application runs as a single instance, and most
// routes read, check and then write, so saves are taken in order rather than all at once.
//
// - exclusive(fn): runs alone, as every save once did (HR, payroll and admin changes).
// - personal(key, fn): a save that changes only one person's own records (a punch, a
//   leave request). Different people's personal saves run side by side; one person's
//   run in the order they arrived. None runs alongside an exclusive save.
//
// Waiting is first come, first served: an exclusive save waits for the personal saves
// already running, and personal saves that arrive after it wait for it, so neither kind
// can hold the other back for long. With parallel: false (the embedded database, which
// has a single connection) every save runs alone.
export function createGate({ parallel = true } = {}) {
  const queue = [];
  let exclusive = false;
  let running = 0;
  const busy = new Set();
  const start = (entry) => {
    if (entry.key === null) exclusive = true;
    else busy.add(entry.key);
    running++;
    Promise.resolve()
      .then(entry.fn)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        if (entry.key === null) exclusive = false;
        else busy.delete(entry.key);
        running--;
        pump();
      });
  };
  const pump = () => {
    for (let i = 0; i < queue.length && !exclusive; ) {
      const entry = queue[i];
      if (entry.key === null) {
        // Nothing queued behind an exclusive save may pass it.
        if (i === 0 && running === 0) start(queue.shift());
        return;
      }
      if (busy.has(entry.key)) i++;
      else start(queue.splice(i, 1)[0]);
    }
  };
  const enqueue = (key, fn) =>
    new Promise((resolve, reject) => {
      queue.push({ key, fn, resolve, reject });
      pump();
    });
  return {
    exclusive: (fn) => enqueue(null, fn),
    personal: (key, fn) => enqueue(parallel ? String(key) : null, fn),
    get waiting() {
      return queue.length;
    },
    get running() {
      return running;
    },
  };
}

export function serializedStore(store, { parallel = false } = {}) {
  store.gate = createGate({ parallel });
  // Read-only requests (GET) may run alongside others: statements outside a transaction
  // use their own pooled connection, and the few GET routes that write do so idempotently.
  store.serialized = (fn, { concurrent = false } = {}) => {
    if (concurrent && store.dialect === "postgres")
      return Promise.resolve().then(fn);
    return store.gate.exclusive(fn);
  };
  return store;
}

// parallel: the pool hands each transaction its own connection, so personal saves may
// overlap. The embedded database (PGlite) shares one connection and leaves this off.
export function createPostgresStore(pool, { parallel = false } = {}) {
  const context = new AsyncLocalStorage();
  const query = (sql, params = []) =>
    (context.getStore() || pool).query(sql, params);
  const normalize = (row) =>
    row && { ...row, ...("n" in row ? { n: Number(row.n) } : {}) };
  // Tables with an id column, so an INSERT can hand back the new row's id. Read from the
  // database itself (and again when a table is not known yet, as after a migration), so
  // new tables never need listing by hand.
  let idTables = null;
  const loadIdTables = async () =>
    new Set(
      (
        await pool.query(
          "SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'",
        )
      ).rows.map((r) => r.table_name),
    );
  const noId = new Set();
  const hasId = async (table) => {
    if (idTables?.has(table)) return true;
    if (noId.has(table)) return false;
    idTables = await loadIdTables();
    if (!idTables.has(table)) noId.add(table);
    return idTables.has(table);
  };
  return serializedStore({
    dialect: "postgres",
    prepare(sql) {
      // SQL here is application-owned; values always travel as bound parameters.
      let index = 0;
      const statement = sql.replace(/\?/g, () => `$${++index}`);
      return {
        async get(...params) {
          return normalize((await query(statement, params)).rows[0]);
        },
        async all(...params) {
          return (await query(statement, params)).rows.map(normalize);
        },
        async run(...params) {
          const table = /^\s*INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i.exec(statement)?.[1]?.toLowerCase();
          const returning = table && !/\bRETURNING\b/i.test(statement) && (await hasId(table));
          const result = await query(
            statement + (returning ? " RETURNING id" : ""),
            params,
          );
          return {
            changes: result.rowCount ?? result.affectedRows,
            lastInsertRowid: result.rows[0]?.id,
          };
        },
      };
    },
    exec: (sql) => query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await context.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  }, { parallel });
}

export async function openPostgres(connectionString) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX) || 10,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
  });
  // Do not print connection strings or SQL parameters in logs.
  pool.on("error", () =>
    console.error(
      "PostgreSQL idle connection failed; the pool will reconnect.",
    ),
  );
  const db = createPostgresStore(pool, { parallel: true });
  try {
    await runMigrations(db);
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
