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

test('a persisted key loses internal API access when its owner leaves the allowlist', options, async () => {
  const { createAgentMemoryRoutes } = await import('../src/agentMemoryRoutes.mjs');
  const config = { agentMemoryApiInternalUsers: [hospital] };
  const created = await keys.create(hospital, { name: 'Internal history', scopes: ['memory.read', 'memory.history.read'] });
  const routes = createAgentMemoryRoutes({ config, apiKeys: keys,
    store: { userById: async id => (await database.query('SELECT id FROM evimed_control.users WHERE id=$1', [id])).rows[0] ?? null } });
  const req = token => ({ url: '/api/agent-memory/v1', method: 'GET', headers: { authorization: `Bearer ${token}` } });
  const res = { body: null, writeHead() {}, end(body) { this.body = JSON.parse(body); } };
  await routes(req(created.key), res);
  assert.ok(res.body.data.scopes.includes('memory.history.read'));
  config.agentMemoryApiInternalUsers = [clinic];
  for (const token of [created.key, 'unknown']) await assert.rejects(routes(req(token), res), error => error.code === 'agent_memory_disabled' && error.status === 503);
  config.agentMemoryApiInternalUsers = [hospital];
  await routes(req(created.key), res);
  await keys.revoke(hospital, created.id);
  await assert.rejects(routes(req(created.key), res), error => error.code === 'agent_memory_disabled' && error.status === 503);
});

test('public clients share one atomic key budget and minute budget', options, async () => {
  const { AGENT_KEY_LIMIT, AGENT_KEY_REQUESTS_PER_MINUTE, AGENT_ACCOUNT_REQUESTS_PER_MINUTE } = await import('../src/agentApiKeys.mjs');
  const owner = `clients_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Clients','development')", [owner]);
  try {
    const results = await Promise.allSettled(Array.from({ length: AGENT_KEY_LIMIT + 2 }, (_, i) => keys.create(owner, { name: `Client ${i}` })));
    const active = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    assert.equal(active.length, AGENT_KEY_LIMIT);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'agent_key_limit'));
    assert.ok((await keys.list(owner)).every(key => !key.key && !key.key_digest));
    const [first, second] = active;
    assert.deepEqual(first.scopes, ['memory.read']);
    assert.equal((await keys.resolve(second.key)).userId, owner);
    const seed = (ids, count) => database.query(`UPDATE evimed_agent.api_keys SET request_count=$2,
      request_minute=floor(extract(epoch FROM clock_timestamp()) / 60) WHERE id=ANY($1::text[])`, [ids, count]);
    await seed([first.id], AGENT_KEY_REQUESTS_PER_MINUTE);
    await assert.rejects(keys.countMemoryRequest(owner, first.id), { code: 'agent_memory_rate_limited' });
    await keys.countMemoryRequest(owner, second.id);
    await seed(active.slice(0, AGENT_ACCOUNT_REQUESTS_PER_MINUTE / AGENT_KEY_REQUESTS_PER_MINUTE).map(key => key.id), AGENT_KEY_REQUESTS_PER_MINUTE);
    await assert.rejects(keys.countMemoryRequest(owner, active.at(-1).id), { code: 'agent_memory_rate_limited' });
    await keys.revoke(owner, first.id);
    await assert.rejects(keys.resolve(first.key), { code: 'agent_key_invalid' });
    assert.ok(await keys.create(owner, { name: 'Replacement' }));
  } finally { await database.query('DELETE FROM evimed_control.users WHERE id=$1', [owner]); }
});
