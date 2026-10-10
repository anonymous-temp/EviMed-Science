// The drift table is written once per judged observation (every J4 line, since its comparator is free) and kept for
// 35 days. The retention DELETE used to run after every insert, a table-wide statement per judged report line; it now
// runs at most once an hour per process, which keeps the same retention (the summary reads eight days) at a fraction of
// the statements.
import assert from "node:assert/strict";
import test from "node:test";

import { recordJudgeDrift } from "../src/judgePersistence.mjs";

/** A database that records every statement it is given. */
function recordingDatabase() {
  /** @type {string[]} */
  const statements = [];
  return {
    statements,
    transaction: async (/** @type {(client: any) => Promise<any>} */ fn) => fn({ query: async () => ({ rows: [] }) }),
    query: async (/** @type {string} */ sql) => { statements.push(sql.replace(/\s+/g, " ").trim()); return { rows: [] }; },
  };
}
const observation = { site: "J4", model: "jev-1.13.0", promptFingerprint: "pin", agreement: true };
const inserts = (/** @type {string[]} */ statements) => statements.filter((sql) => sql.startsWith("INSERT")).length;
const deletes = (/** @type {string[]} */ statements) => statements.filter((sql) => sql.startsWith("DELETE"));

test("every observation is recorded, and the retention delete runs once an hour, not once per insert", async () => {
  const database = recordingDatabase();
  let now = Date.parse("2026-10-10T00:00:00Z");
  for (let i = 0; i < 200; i += 1) {
    await recordJudgeDrift(database, observation, { now: () => now });
    now += 1_000;
  }
  assert.equal(inserts(database.statements), 200, "no observation is skipped");
  assert.equal(deletes(database.statements).length, 1, "200 observations in under four minutes cost one retention delete");
  now += 61 * 60_000;
  await recordJudgeDrift(database, observation, { now: () => now });
  assert.equal(deletes(database.statements).length, 2, "an hour later the next observation prunes again");
  assert.equal(inserts(database.statements), 201);
});

test("the retention is unchanged: rows older than 35 days, and nothing newer", async () => {
  const database = recordingDatabase();
  await recordJudgeDrift(database, observation, { now: () => 1_000 });
  assert.deepEqual(deletes(database.statements), ["DELETE FROM evimed_judge.drift WHERE created_at < now() - interval '35 days'"]);
});

test("a retention delete that fails does not fail the observation, and is tried again a minute later", async () => {
  const database = recordingDatabase();
  let broken = true;
  const query = database.query;
  database.query = async (sql) => {
    if (broken && sql.startsWith("DELETE")) throw new Error("canceling statement due to statement timeout");
    return query(sql);
  };
  const written = [];
  const stderr = process.stderr.write;
  process.stderr.write = /** @type {any} */ ((chunk) => { written.push(String(chunk)); return true; });
  try {
    await recordJudgeDrift(database, observation, { now: () => 5_000 });
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(inserts(database.statements), 1, "the observation was recorded and reported as recorded");
  assert.ok(written.some((line) => /judge drift retention/.test(line)), "the failure is traceable");
  broken = false;
  await recordJudgeDrift(database, observation, { now: () => 6_000 });
  assert.equal(deletes(database.statements).length, 0, "a burst of observations is not a burst of failing deletes");
  await recordJudgeDrift(database, observation, { now: () => 5_000 + 61_000 });
  assert.equal(deletes(database.statements).length, 1, "a failed prune does not count as a prune: the next minute's observation prunes");
  await recordJudgeDrift(database, observation, { now: () => 5_000 + 62_000 });
  assert.equal(deletes(database.statements).length, 1, "and then the hour starts again");
});
