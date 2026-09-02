/**
 * @fileoverview D1 and Durable Object emulators on Node's built-in
 * `node:sqlite`, so the state layer and the routes that call it can be tested
 * with plain `node` -- no wrangler, no miniflare, no network.
 *
 * These expose the same call shapes the real bindings do:
 *   D1  -- `prepare(sql).bind(...).run()` returning `{ success, meta.changes,
 *          meta.last_row_id }`, plus `.first()` / `.all()` / `.batch()`.
 *   DO  -- `ctx.storage.sql.exec(sql, ...bind)` returning `.toArray()` /
 *          `.one()` / `.rowsWritten` / `.rowsRead`, `transactionSync` (nested
 *          via savepoints), and `setAlarm` / `deleteAlarm` / `deleteAll`.
 *
 * If the emulator and a real binding ever disagree, that is a bug HERE -- the
 * shapes are written against the documented D1/Durable Object APIs, and a test
 * that passes against a wrong emulator is worse than no test. The Durable
 * Object namespace below drives REAL class instances (`new GiftCardLedger(...)`)
 * over their real `fetch` transport, so only storage is simulated; every line of
 * ledger logic under test is the shipped one.
 *
 * Extracted from scripts/worker-state.test.js so scripts/worker-checkout.test.js
 * can drive the same ledger the Worker will use in production.
 */

const { DatabaseSync } = require("node:sqlite");

function isRead(sql) {
  return /^\s*(select|with)\b/i.test(sql);
}

/** A D1 binding over one in-memory SQLite database. */
function makeD1(db) {
  function statement(sql, params) {
    return {
      bind(...args) {
        return statement(sql, args);
      },
      async run() {
        const stmt = db.prepare(sql);
        if (isRead(sql)) {
          stmt.all(...params);
          return { success: true, meta: { changes: 0, last_row_id: 0 } };
        }
        const info = stmt.run(...params);
        return {
          success: true,
          meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }
        };
      },
      async first(column) {
        const row = db.prepare(sql).get(...params);
        if (row === undefined || row === null) return null;
        return column ? row[column] : row;
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...params), meta: {} };
      }
    };
  }
  return {
    prepare(sql) {
      return statement(sql, []);
    },
    async batch(statements) {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const s of statements) out.push(await s.run());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return out;
    },
    _raw: db
  };
}

/** Fresh D1 binding over a fresh database. */
function makeMemoryD1() {
  return makeD1(new DatabaseSync(":memory:"));
}

/** Durable Object state: SQLite storage, synchronous transactions, alarms. */
function makeDurableCtx() {
  const db = new DatabaseSync(":memory:");
  const alarm = { at: null, sets: 0, deletes: 0 };
  let depth = 0;

  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (isRead(query)) {
        const rows = stmt.all(...bindings);
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error("expected exactly one row");
            return rows[0];
          },
          rowsRead: rows.length,
          rowsWritten: 0
        };
      }
      const info = stmt.run(...bindings);
      return {
        toArray: () => [],
        one: () => {
          throw new Error("no rows");
        },
        rowsRead: 0,
        rowsWritten: Number(info.changes)
      };
    }
  };

  return {
    storage: {
      sql,
      transactionSync(fn) {
        const name = `sp_${depth}`;
        db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
        depth++;
        try {
          const result = fn();
          depth--;
          db.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
          return result;
        } catch (err) {
          depth--;
          db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}`);
          throw err;
        }
      },
      async setAlarm(at) {
        alarm.at = at;
        alarm.sets++;
      },
      async deleteAlarm() {
        alarm.at = null;
        alarm.deletes++;
      },
      async deleteAll() {
        db.exec("DELETE FROM windows");
      }
    },
    _alarm: alarm,
    _db: db
  };
}

/**
 * A Durable Object namespace binding over real class instances, kept in a Map
 * so `idFromName(x)` twice reaches the same object -- which is the entire
 * property the ledger's safety rests on.
 */
function makeNamespace(ClassRef, env = {}) {
  const instances = new Map();
  return {
    idFromName(name) {
      return { name, toString: () => name };
    },
    get(id) {
      if (!instances.has(id.name)) instances.set(id.name, new ClassRef(makeDurableCtx(), env));
      const instance = instances.get(id.name);
      return {
        fetch: (url, init) => instance.fetch(new Request(url, init)),
        _instance: instance
      };
    },
    _instances: instances
  };
}

module.exports = { makeD1, makeMemoryD1, makeDurableCtx, makeNamespace, isRead };
