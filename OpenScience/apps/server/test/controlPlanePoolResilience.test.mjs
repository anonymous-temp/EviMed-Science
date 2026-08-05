// A pooled Postgres client losing its connection is routine — a TCP timeout, a
// database restart, a network blip. pg reports it by emitting "error" on the
// pool, and an EventEmitter with no error listener throws.
//
// It did. Production logs show "Unhandled 'error' event ... Connection
// terminated unexpectedly", the container's restart count at 1, and afterwards
// a readiness check stuck on 57P03 while a freshly constructed client connected
// to the same database without trouble. One missing listener explained both:
// the crash, and the pool never recovering from it.
//
// No database is needed to hold that line — the failure is an unhandled event,
// so a fake pool that emits one reproduces it exactly.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";

class FakePool extends EventEmitter {
  constructor() {
    super();
    this.queries = [];
  }

  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  }

  async query(text, values) {
    this.queries.push([text, values]);
    return { rows: [] };
  }

  async end() {}
}

function databaseWith(pool) {
  return new ControlPlaneDatabase({
    databaseUrl: "postgres://user@127.0.0.1:5432/evimed_test",
    databasePoolMax: 4,
    databaseConnectionTimeoutMs: 5_000,
  }, { pool });
}

test("a dropped pooled connection does not take the process down", () => {
  const pool = new FakePool();
  databaseWith(pool);
  const error = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P03" });
  // Without a listener this throws out of emit() and, in production, out of the
  // process. The assertion is simply that it returns.
  assert.doesNotThrow(() => pool.emit("error", error));
});

test("after a dropped connection the next query re-establishes rather than trusting the old one", async () => {
  const pool = new FakePool();
  const database = databaseWith(pool);
  await database.query("select 1");
  assert.ok(database.ready, "the migration promise is cached after a successful query");

  pool.emit("error", Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P03" }));
  assert.equal(database.ready, null, "a pool error must drop the cached migration promise");

  // And the database is usable again without a restart, which is what the
  // production incident required and did not get.
  await database.query("select 1");
  assert.ok(database.ready);
  assert.equal(pool.queries.filter(([text]) => text === "select 1").length, 2);
});
