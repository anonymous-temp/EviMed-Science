// Expired sign-ins in the PostgreSQL session store (store.mjs
// `purgeExpiredSessions`). Nothing used to delete them: the store's inherited
// cleanup sat in `loadSessions`, which no path on this store calls, and
// production held 1,362 expired rows on 2026-09-27. The recurring pass that
// drives this is asserted in serverComposition.test.mjs; the statement's
// PostgreSQL behaviour in postgresStore.integration.test.mjs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PostgresStore } from "../src/store.mjs";

/** A pg.Pool double: every statement recorded, the purge answered from a count of expired rows. */
class RecordingPool extends EventEmitter {
  /** @param {number} expired */
  constructor(expired) {
    super();
    this.expired = expired;
    /** @type {{ sql: string, values: any[] }[]} */
    this.calls = [];
  }

  /** @param {string} text @param {any[]} [values] */
  answer(text, values = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    this.calls.push({ sql, values });
    if (sql.startsWith("DELETE FROM evimed_control.auth_sessions WHERE id_hash IN")) {
      const deleted = Math.min(Number(values[0]), this.expired);
      this.expired -= deleted;
      return { rows: [], rowCount: deleted };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    const pool = this;
    return { on() {}, off() {}, release() {}, async query(/** @type {string} */ text, /** @type {any[]} */ values) { return pool.answer(text, values); } };
  }

  /** @param {string} text @param {any[]} [values] */
  async query(text, values) { return this.answer(text, values); }

  async end() {}
}

const config = { databasePoolMax: 2, databaseConnectionTimeoutMs: 1_000 };

test("expired sign-ins are deleted a bounded batch at a time, oldest first, and counted", async () => {
  const pool = new RecordingPool(1_362);
  const store = new PostgresStore(config, { databasePool: pool });
  assert.equal(await store.purgeExpiredSessions({ limit: 1_000 }), 1_000);
  assert.equal(await store.purgeExpiredSessions({ limit: 1_000 }), 362, "the production backlog clears in two passes");
  assert.equal(await store.purgeExpiredSessions({ limit: 1_000 }), 0);
  assert.equal(store.expiredSessionsPurged, 1_362);

  const purges = pool.calls.filter((call) => call.sql.startsWith("DELETE FROM evimed_control.auth_sessions"));
  assert.equal(purges.length, 3, "one statement per pass");
  for (const purge of purges) {
    assert.equal(purge.sql, "DELETE FROM evimed_control.auth_sessions WHERE id_hash IN ( SELECT id_hash FROM evimed_control.auth_sessions"
      + " WHERE expires_at <= now() ORDER BY expires_at LIMIT $1)");
    assert.deepEqual(purge.values, [1_000]);
  }
});

test("the batch is bounded whatever the configuration says", async () => {
  const pool = new RecordingPool(0);
  const store = new PostgresStore(config, { databasePool: pool });
  for (const [limit, bound] of [[50_000, 10_000], [0, 1_000], [Number.NaN, 1_000], [-5, 1], [2.9, 2]]) {
    await store.purgeExpiredSessions({ limit });
    assert.deepEqual(pool.calls.at(-1)?.values, [bound], String(limit));
  }
});

test("loading sessions on this store deletes nothing: expiry is the timer's, in bounded batches", async () => {
  const pool = new RecordingPool(10);
  const store = new PostgresStore(config, { databasePool: pool });
  await store.loadSessions();
  assert.equal(pool.calls.filter((call) => call.sql.startsWith("DELETE")).length, 0);
});
