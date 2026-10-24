// The operator's view of whether the learning loop is being fed (2026-10-23): per account, when it last left evidence and what came of it.
import assert from "node:assert/strict";
import test from "node:test";

import { learningEvidenceReport, parseArguments, renderReport } from "../learning-evidence-report.mjs";

const NOW = new Date("2026-10-23T12:00:00.000Z");

/** A database that answers the three reads by what they select, and records the values it was asked with. */
function database() {
  /** @type {{ sql: string, values: any[] }[]} */
  const queries = [];
  return {
    queries,
    async query(/** @type {string} */ sql, /** @type {any[]} */ values) {
      queries.push({ sql, values });
      if (sql.includes("FROM evimed_product.feedback_events")) {
        return { rows: [
          { user_id: "alice", evidence: "follow-up", verdict: "correction", d7: 2, d30: 5, last_at: "2026-10-21T08:00:00.000Z" },
          { user_id: "alice", evidence: "follow-up", verdict: "accept", d7: 1, d30: 4, last_at: "2026-10-22T09:00:00.000Z" },
          { user_id: "alice", evidence: "silent", verdict: "none", d7: 3, d30: 9, last_at: "2026-10-22T10:00:00.000Z" },
          { user_id: "alice", evidence: "steer", verdict: "correction", d7: 0, d30: 1, last_at: "2026-10-01T10:00:00.000Z" },
          { user_id: "bob", evidence: "silent", verdict: "none", d7: 0, d30: 2, last_at: "2026-10-05T10:00:00.000Z" },
          { user_id: "bob", evidence: "from-the-future", verdict: "none", d7: 0, d30: 1, last_at: "2026-10-04T10:00:00.000Z" },
        ] };
      }
      if (sql.includes("FROM evimed_product.jobs")) {
        return { rows: [
          { user_id: "alice", trigger: "correction", status: "succeeded", n: 3, operation: "create" },
          { user_id: "alice", trigger: "correction", status: "succeeded", n: 1, operation: "no_change" },
          { user_id: "alice", trigger: "routine", status: "queued", n: 1, operation: "" },
          { user_id: "carol", trigger: "delivered", status: "failed", n: 2, operation: "" },
          { user_id: "carol", trigger: "something-new", status: "succeeded", n: 1, operation: "amend" },
        ] };
      }
      if (sql.includes("FROM evimed_product.documents")) return { rows: [{ user_id: "alice", n: 4 }, { user_id: "carol", n: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test("each account's last evidence, the evidence of seven and thirty days, its lessons and its methods in force, newest evidence first", async () => {
  const source = database();
  const rows = await learningEvidenceReport(source, { now: NOW });
  assert.deepEqual(rows.map((row) => row.user), ["alice", "bob", "carol"], "an account with no evidence at all comes last");
  const [alice, bob, carol] = rows;
  assert.equal(alice.lastEvidenceAt, "2026-10-22T10:00:00.000Z");
  assert.equal(alice.daysSinceEvidence, 1);
  assert.deepEqual(alice.evidence7d, { steer: 0, "follow-up": 3, "result-corrected": 0, silent: 3, other: 0 });
  assert.deepEqual(alice.evidence30d, { steer: 1, "follow-up": 9, "result-corrected": 0, silent: 9, other: 0 });
  assert.equal(alice.corrections30d, 6, "a steer and the follow-ups that corrected, preferred or rejected");
  assert.equal(alice.lessonsQueued30d, 5);
  assert.equal(alice.lessonsDistilled30d, 3, "what a lesson ended in: a method written, not a no_change");
  assert.deepEqual([alice.lessons30d.correction, alice.lessons30d.routine], [4, 1]);
  assert.equal(alice.methodsInForce, 4);
  assert.deepEqual([bob.daysSinceEvidence, bob.evidence30d.other], [18, 1], "a kind nobody named is `other`");
  assert.deepEqual([carol.lastEvidenceAt, carol.lessonsFailed30d, carol.lessons30d.other, carol.lessonsDistilled30d], [null, 2, 1, 1]);
  assert.ok(source.queries.every((query) => query.values[0] === null), "no account named is every account");
  assert.deepEqual((await learningEvidenceReport(database(), { user: "alice", now: NOW })).length, 3, "the database does the filtering; a double that ignores it returns what it holds");
  const scoped = database();
  await learningEvidenceReport(scoped, { user: "alice", now: NOW });
  assert.ok(scoped.queries.every((query) => query.values[0] === "alice"));
});

test("the table says never for an account with no evidence and prints no text of anyone's", async () => {
  const rows = await learningEvidenceReport(database(), { now: NOW });
  const table = renderReport(rows);
  assert.match(table, /^account\s+last evidence\s+days/);
  assert.match(table, /carol\s+never\s+-/);
  assert.match(table, /alice\s+2026-10-22T10:00:00.000Z\s+1\s+6 \(0\/3\/0\/3\)/);
  assert.equal(renderReport([]), "no account has left learning evidence, queued a lesson or holds a learned method\n");
  assert.deepEqual(parseArguments(["--user", "alice", "--json"]), { user: "alice", json: true });
  assert.throws(() => parseArguments(["--user"]), /needs a value/);
  assert.throws(() => parseArguments(["--apply"]), /unknown argument/);
});
