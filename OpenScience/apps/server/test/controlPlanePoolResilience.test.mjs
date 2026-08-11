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

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.released = false;
  }

  async query() {
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}

class FakePool extends EventEmitter {
  constructor() {
    super();
    this.queries = [];
    this.clients = [];
    // How many connect() calls to fail before the first success, and with what.
    this.connectFailures = 0;
    this.connectError = null;
  }

  async connect() {
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      throw this.connectError ?? new Error("connect failed");
    }
    const client = new FakeClient();
    this.clients.push(client);
    return client;
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

// The second production incident, two days long. A database still starting up
// refuses with 57P03, "the database system is not yet accepting connections".
// That rejection came from pool.connect(), which sat outside the try whose catch
// clears the cache — so the rejected promise stayed in this.ready and
// `if (this.ready) return this.ready` served it to every request that followed.
// Postgres accepted connections again within seconds; the API refused every
// login for two days, and only a restart could have cleared it.
test("a database that was not yet accepting connections is retried, not cached forever", async () => {
  const pool = new FakePool();
  pool.connectFailures = 1;
  pool.connectError = Object.assign(
    new Error("the database system is not yet accepting connections"),
    { code: "57P03" },
  );
  const database = databaseWith(pool);

  await assert.rejects(() => database.query("select 1"), /not yet accepting connections/);
  assert.equal(database.ready, null, "a failed connect must not leave a rejected promise cached");

  // The very next call succeeds against the same instance, no restart involved.
  await database.query("select 1");
  assert.ok(database.ready);
  assert.equal(pool.queries.filter(([text]) => text === "select 1").length, 1);
});

test("a connection dropped while checked out is absorbed instead of killing the process", async () => {
  const pool = new FakePool();
  const database = databaseWith(pool);
  await database.migrate();
  const [client] = pool.clients;
  assert.ok(client, "migrate checks a client out of the pool");
  assert.equal(client.released, true);

  // pg moves its own listener off a client on checkout, so during the window
  // this covers there is nobody else to hear this.
  await database.transaction(async (checkedOut) => {
    assert.doesNotThrow(() => checkedOut.emit(
      "error",
      Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P03" }),
    ));
  });

  // The listener is removed on release: a client back in the pool is pg's to
  // guard again, and leaving ours attached would leak one per checkout.
  for (const used of pool.clients) {
    assert.equal(used.released, true);
    assert.equal(used.listenerCount("error"), 0);
  }
});
