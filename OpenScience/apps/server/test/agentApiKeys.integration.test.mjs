/**
 * Integration keys against a real PostgreSQL: the account a subject is given,
 * the constraint that admits it, and the rule that keeps an integration key off
 * the institution's projects.
 *
 * The unit suite (`agentMemoryApi.test.mjs`) proves every route reads and
 * writes the account it is handed; this proves the account exists, is one per
 * doctor per institution, cannot be signed into, and goes with its institution.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { AgentApiKeyStore, subjectAccountId } from "../src/agentApiKeys.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const hospital = `agent_keys_${randomUUID()}`;
const clinic = `agent_keys_${randomUUID()}`;
/** @type {any} */
let database;
/** @type {AgentApiKeyStore} */
let keys;
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Hospital','development'),($2,'Clinic','development')", [hospital, clinic]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'ward','Ward',1048576)", [hospital]);
  keys = new AgentApiKeyStore(database);
});
after(async () => {
  if (!database) return;
  const subjects = await database.query("SELECT user_id FROM evimed_agent.subjects WHERE owner_user_id=ANY($1::text[])", [[hospital, clinic]]);
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[hospital, clinic, ...subjects.rows.map((row) => row.user_id)]]);
  await database.close();
});
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("an integration key says so when it is resolved, and cannot be bound to one of the institution's projects", options, async () => {
  const created = await keys.create(hospital, { name: "CDSS", scopes: ["memory.read", "memory.write"], subjects: true });
  assert.equal(created.subjects, true);
  const resolved = await keys.resolve(created.key);
  assert.equal(resolved.subjects, true);
  const plain = await keys.create(hospital, { name: "Notebook agent" });
  assert.equal((await keys.resolve(plain.key)).subjects, false, "a key is an integration key only when made as one");
  await assert.rejects(
    () => keys.create(hospital, { name: "Bound", subjects: true, projectId: "ward" }),
    (error) => error.code === "agent_key_subjects_unbound",
  );
  // The constraint says the same thing, for a row written any other way.
  await assert.rejects(
    () => database.query(`INSERT INTO evimed_agent.api_keys (id,user_id,project_id,name,key_prefix,key_digest,subjects)
      VALUES ($1,$2,'ward','x','evk_abcdefgh',$3,true)`, [`agk_${randomUUID()}`, hospital, "a".repeat(64)]),
    (error) => /api_keys_subjects_unbound/.test(String(error.message)),
  );
});

test("each doctor of each institution is an account of its own, made once, that nobody can sign in as", options, async () => {
  assert.equal(await keys.findSubjectAccount(hospital, "doc-7"), null, "a lookup creates nothing");
  const first = await keys.subjectAccount(hospital, "doc-7");
  const again = await keys.subjectAccount(hospital, "doc-7");
  assert.deepEqual([first.created, again.created], [true, false]);
  assert.equal(again.userId, first.userId);
  assert.equal(first.userId, subjectAccountId(hospital, "doc-7"));
  assert.equal(await keys.findSubjectAccount(hospital, "doc-7"), first.userId);
  const elsewhere = await keys.subjectAccount(clinic, "doc-7");
  assert.notEqual(elsewhere.userId, first.userId, "the same HIS id at another institution is another person");

  const row = (await database.query("SELECT auth_type, password_hash FROM evimed_control.users WHERE id=$1", [first.userId])).rows[0];
  assert.deepEqual(row, { auth_type: "subject", password_hash: null });
  const stored = (await database.query("SELECT * FROM evimed_agent.subjects WHERE user_id=$1", [first.userId])).rows[0];
  assert.ok(!JSON.stringify(stored).includes("doc-7"), "the HIS identifier itself is never stored");

  // Its memory is its own: a record written for one doctor is not the other's.
  const memory = new ResearchMemoryStore({}, { database });
  await memory.upsertRecord(first.userId, {
    scope: "user", scopeId: "", kind: "preference", key: "preference.herb_count", value: "药味控制在 12 味以内",
    summary: "药味不超过 12 味", origin: "explicit", status: "active", confidence: 1, importance: 0.8, sensitive: false,
  }, null);
  assert.equal((await memory.listRecords(first.userId, {})).length, 1);
  assert.equal((await memory.listRecords(elsewhere.userId, {})).length, 0);
  assert.equal((await memory.listRecords(hospital, {})).length, 0, "nor the institution's");
});

test("an institution lists the accounts that must go before it does", options, async () => {
  const made = await keys.subjectAccount(hospital, "doc-list");
  const listed = await keys.subjectAccounts(hospital);
  const entry = listed.find((item) => item.userId === made.userId);
  assert.ok(entry, "the subject is listed");
  const generation = (await database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [made.userId])).rows[0].generation;
  assert.equal(entry.accountCreatedAt, generation, "with the generation account deletion checks against");
  assert.ok(!listed.some((item) => (clinic === item.userId)), "and only its own");
});

test("an account already holding a subject's id is never adopted, and an institution that is gone names nobody", options, async () => {
  const id = subjectAccountId(hospital, "doc-taken");
  // An account under that id that is not this institution's subject.
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Someone','development')", [id]);
  await assert.rejects(() => keys.subjectAccount(hospital, "doc-taken"), (error) => error.code === "agent_subject_conflict");
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [id]);
  await assert.rejects(() => keys.subjectAccount(`missing_${randomUUID()}`, "doc-1"), (error) => error.code === "agent_key_invalid");
});
