import assert from "node:assert/strict";
import test from "node:test";
import { retryingOnConflict } from "../../../scripts/ops/frontier-rewrite.mjs";

// The rewrite runs beside the live pipeline: a deadlock victim or a serialization failure is asked again a bounded number of
// times; any other error, and the last attempt, are thrown as they were (the first production run died on one deadlock, 2026-10-27).
const conflict = (code) => Object.assign(new Error(code === "40P01" ? "deadlock detected" : "could not serialize access"), { code });

test("a deadlock or serialization failure is asked again, other errors are not, and the attempts are bounded", async () => {
  const calls = { query: 0, transaction: 0 };
  const failures = { query: ["40P01", "40001"], transaction: ["40P01"] };
  const database = {
    marker: "kept",
    async query(sql) { calls.query += 1; const code = failures.query.shift(); if (code) throw conflict(code); return { rows: [{ sql }] }; },
    async transaction(work) { calls.transaction += 1; const code = failures.transaction.shift(); if (code) throw conflict(code); return work({ query: async () => ({ rows: [] }) }); },
    describe() { return this.marker; },
  };
  const retrying = retryingOnConflict(database, { pause: async () => {} });
  assert.deepEqual((await retrying.query("SELECT 1")).rows, [{ sql: "SELECT 1" }]);
  assert.equal(calls.query, 3);
  assert.equal(await retrying.transaction(async () => "written"), "written");
  assert.equal(calls.transaction, 2);
  assert.equal(retrying.describe(), "kept", "other members are the database's own, bound to it");

  failures.query.push("23505");
  await assert.rejects(retrying.query("INSERT"), { code: "23505" });
  assert.equal(calls.query, 4, "a constraint violation is not retried");

  failures.transaction.push("40P01", "40P01", "40P01");
  const bounded = retryingOnConflict(database, { attempts: 3, pause: async () => {} });
  await assert.rejects(bounded.transaction(async () => "never"), { code: "40P01" });
  assert.equal(calls.transaction, 5, "three attempts, then the conflict is thrown");
});
