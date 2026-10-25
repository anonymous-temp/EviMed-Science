// What is left of the capability-handbook arm in a database, taken away once at start (`handbookArmRetirement.mjs`), against a real PostgreSQL.
//
// The step takes only what the arm alone used: an account's handbooks and the candidates waiting to become one, the evolution module's records of the
// platform handbook path, and the jobs of the arm that were still waiting. It leaves a learned method, a finished job and every other evolution record
// as it found them, says what it did once, finds nothing the second time, and never throws into the start.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { retireHandbookArm } from "../src/handbookArmRetirement.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60_000 };

const person = `handbook_person_${randomUUID()}`;
const operator = `handbook_operator_${randomUUID()}`;
/** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let jobs;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateProductStore(database);
  await database.query(`INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Person','development'),($2,'Operator','development')`, [person, operator]);
  documents = new ProductDocuments(database);
  jobs = new ProductJobs(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[person, operator]]);
  await database.close();
});

const rows = async (/** @type {string} */ owner, /** @type {string} */ kind) => (await database.query(
  "SELECT id, payload FROM evimed_product.documents WHERE user_id=$1 AND kind=$2 AND deleted_at IS NULL ORDER BY id", [owner, kind])).rows;

test("an account's handbooks and candidates, the evolution module's handbook records and the arm's waiting jobs go; nothing else does", options, async () => {
  const put = (/** @type {string} */ owner, /** @type {string} */ kind, /** @type {string} */ id, /** @type {any} */ payload) => documents.put(owner, kind, id, payload, { expectedRevision: 0, projectId: null });
  await put(person, "method", "method:capability-handbook:meta-analysis:a", { recordType: "capability-handbook", status: "active", capabilityId: "meta-analysis" });
  await put(person, "method", "method:handbook:meta-analysis:b", { recordType: "handbook-candidate", status: "candidate", capabilityId: "meta-analysis" });
  await put(person, "method", "method:learned:keep", { recordType: "learned-method", status: "approved" });
  await put(operator, "knowledge", "evolution-handbook-candidate-1", { recordType: "evolution-handbook-candidate", status: "probation" });
  await put(operator, "knowledge", "evolution-handbook-use-1", { recordType: "evolution-handbook-use" });
  await put(operator, "knowledge", "evolution-tool-keep", { recordType: "evolution-tool", toolKind: "engine", status: "active" });
  await put(operator, "knowledge", "evolution-tool-handbook", { recordType: "evolution-tool", toolKind: "handbook", status: "active" });
  const waiting = await jobs.enqueue(person, "consolidate", { action: "optimize", candidateId: "c1" }, { idempotencyKey: `arm:optimize:${person}` });
  const wrote = await jobs.enqueue(person, "distill", { trigger: "repair_accepted", runId: "r1" }, { idempotencyKey: `arm:distill:${person}` });
  const other = await jobs.enqueue(person, "consolidate", { action: "sleep", date: "2026-10-25" }, { idempotencyKey: `arm:sleep:${person}` });
  const correction = await jobs.enqueue(person, "distill", { trigger: "correction", runId: "r2" }, { idempotencyKey: `arm:correction:${person}` });

  const lines = [];
  const first = await retireHandbookArm({ database, report: (line) => lines.push(line) });
  assert.ok(first.handbooks >= 1 && first.candidates >= 1 && first.evolutionRecords >= 2 && first.jobs >= 2, JSON.stringify(first));
  assert.equal(first.failed, undefined);
  assert.deepEqual((await rows(person, "method")).map((row) => row.id), ["method:learned:keep"], "a learned method is the person's and stays");
  assert.deepEqual((await rows(operator, "knowledge")).map((row) => row.id), ["evolution-tool-handbook", "evolution-tool-keep"],
    "the evolution module's other records stay, and so does a tool of kind handbook: those are retired through the module, not here");
  const status = async (/** @type {any} */ job) => (await database.query("SELECT status, result FROM evimed_product.jobs WHERE id=$1", [job.id])).rows[0];
  assert.deepEqual([(await status(waiting)).status, (await status(wrote)).status], ["canceled", "canceled"]);
  assert.deepEqual((await status(waiting)).result, { retired: "handbook_arm" });
  assert.deepEqual([(await status(other)).status, (await status(correction)).status], ["queued", "queued"], "every other job of the same kinds waits for its worker as before");
  assert.ok(lines.some((line) => line.startsWith("handbook arm retired: ")), lines.join("\n"));
  assert.ok(lines.some((line) => /platform handbook tool\(s\) are still published/.test(line)), "the entries the supply still serves are said, not deleted");

  // Idempotent: a second start finds nothing and says nothing about the records.
  const quiet = [];
  const second = await retireHandbookArm({ database, report: (line) => quiet.push(line) });
  assert.deepEqual([second.handbooks, second.candidates, second.jobs, second.evolutionRecords], [0, 0, 0, 0]);
  assert.ok(quiet.every((line) => !line.startsWith("handbook arm retired")), quiet.join("\n"));
  // A job a worker already holds is not taken from it.
  const running = await jobs.enqueue(person, "consolidate", { action: "optimize", candidateId: "c2" }, { idempotencyKey: `arm:running:${person}` });
  await database.query("UPDATE evimed_product.jobs SET status='running' WHERE id=$1", [running.id]);
  await retireHandbookArm({ database, report: () => {} });
  assert.equal((await status(running)).status, "running");
});

test("a database that cannot be reached is reported and costs the start nothing", options, async () => {
  const lines = [];
  const result = await retireHandbookArm({ database: { query: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); },
    transaction: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } }, report: (line) => lines.push(line) });
  assert.equal(result.failed, "ECONNREFUSED");
  assert.deepEqual(lines, ["handbook arm retirement failed: ECONNREFUSED"]);
});
