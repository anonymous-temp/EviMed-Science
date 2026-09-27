import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { correctMemoryOrigin, parseArguments } from "../../../scripts/ops/correct-memory-origin.mjs";

/**
 * Putting stored memory right after the 2026-09-26 audit, against a real
 * PostgreSQL: a record whose words were the platform's is relabelled as a
 * revision (M-2), and every path that deletes a record tells the index and
 * takes its usage counters with it (M-7).
 */
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const owner = `memory_repair_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let store;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Memory repair','development')", [owner]);
  store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
});

/** The GEO record of 2026-09-25, as extraction wrote it. @param {string} projectId */
async function geoProductRecord(projectId) {
  return store.upsertRecord(owner, {
    scope: "project", scopeId: projectId, kind: "project_fact", key: "project.geo.product",
    value: "GEO 项目围绕信尔美（玛仕度肽注射液）开展，产品为一盒 2 支的处方药，需冷链。",
    summary: "GEO 项目围绕信尔美（玛仕度肽注射液）开展，产品为一盒 2 支的处方药，需冷链。",
    origin: "explicit", status: "active", confidence: 1, importance: 0.7, lastConfirmedAt: "2026-09-25T18:42:00Z",
  }, { sourceType: "conversation_message", sourceRef: "sessions/session_2e114dd/messages/seq_9",
    quote: "产品：信尔美（通用名：玛仕度肽注射液）。", observedAt: "2026-09-25T18:42:00Z" }, { by: "extraction" });
}

test("an origin is corrected as a revision by the platform, and nothing the record says moves", options, async () => {
  const written = await geoProductRecord("geo-origin");
  assert.equal(written.provenance.basis, "stated", "shown as the researcher's words before");
  const { record, changed } = await store.correctOrigin(owner, written.id, { origin: "system", reason: "the evidence is a dispatch brief", expectedVersion: written.version });
  assert.equal(changed, true);
  assert.equal(record.origin, "system");
  assert.equal(record.confidence, 0.8);
  assert.equal(record.lastConfirmedAt, null, "no confirmation was ever given");
  assert.equal(record.value, written.value);
  assert.deepEqual(record.evidence.map((item) => item.quote), ["产品：信尔美（通用名：玛仕度肽注射液）。"]);
  assert.notEqual(record.provenance.basis, "stated");
  const revision = record.revisions.at(-1);
  assert.equal(revision.by, "system");
  assert.match(revision.reason, /^origin explicit -> system: the evidence is a dispatch brief/);
  assert.equal(record.version, written.version + 1);

  // Asking again changes nothing, and a stale version is refused.
  assert.equal((await store.correctOrigin(owner, written.id, { origin: "system", reason: "again" })).changed, false);
  await assert.rejects(store.correctOrigin(owner, written.id, { origin: "inferred", reason: "stale", expectedVersion: written.version }),
    { code: "memory_conflict" });
  await assert.rejects(store.correctOrigin(owner, written.id, { origin: "system", reason: "" }), { code: "memory_payload_invalid" });
});

test("the operator script reports by default, corrects with --apply, and finds nothing the second time", options, async () => {
  const target = await geoProductRecord("geo-script");
  const elsewhere = await geoProductRecord("geo-other");
  const report = await correctMemoryOrigin(store, parseArguments(["--user", owner, "--key", "project.geo.product", "--project", "geo-script"]));
  assert.equal(report.applied, false);
  assert.deepEqual(report.matched.map((item) => item.id), [target.id]);
  assert.equal((await store.getRecord(owner, target.id)).origin, "explicit", "a report writes nothing");

  const applied = await correctMemoryOrigin(store, parseArguments(["--user", owner, "--key", "project.geo.product", "--project", "geo-script", "--apply"]));
  assert.deepEqual(applied.corrected.map((item) => [item.id, item.origin, item.changed]), [[target.id, "system", true]]);
  assert.equal((await store.getRecord(owner, elsewhere.id)).origin, "explicit", "another project's record is not touched");
  const again = await correctMemoryOrigin(store, parseArguments(["--user", owner, "--key", "project.geo.product", "--project", "geo-script", "--apply"]));
  assert.deepEqual(again.matched, []);
  assert.throws(() => parseArguments(["--user", owner]), /--key/);
  assert.throws(() => parseArguments(["--user", owner, "--key", "k", "--from", "system"]), /same origin/);
});

/** @param {string} userId */
async function indexJobs(userId) {
  const result = await database.query(`SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='memory-record-index'
    AND idempotency_key LIKE 'memory-record-index:%' ORDER BY created_at, id`, [userId]);
  return result.rows.map((row) => row.payload);
}

/** @param {string} userId */
async function usageRows(userId) {
  const result = await database.query("SELECT record_id FROM evimed_memory.record_usage WHERE user_id=$1 ORDER BY record_id", [userId]);
  return result.rows.map((row) => row.record_id);
}

/** @param {any} indexed @param {string} scopeId @param {string} key */
function fact(indexed, scopeId, key) {
  return indexed.upsertRecord(indexed.owner, {
    scope: "project", scopeId, kind: "follow_up", key, value: `待补：${key}`, summary: `待补：${key}`,
    origin: "system", status: "active", confidence: 0.8, importance: 0.6,
  }, null, { by: "extraction" });
}

test("clearing a project's memory and resetting an account tell the index row by row, and take the counters", options, async () => {
  const user = `memory_bulk_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Bulk delete','development')", [user]);
  try {
    const jobs = new ProductJobs(database);
    const indexed = Object.assign(new ResearchMemoryStore({}, { database, jobs }), { owner: user });
    const inDefault = [await fact(indexed, "default", "project.follow_up.a"), await fact(indexed, "default", "project.follow_up.b")];
    const elsewhere = await fact(indexed, "crma-1001", "project.follow_up.c");
    await indexed.noteRecordUsage(user, [...inDefault.map((record) => record.id), elsewhere.id]);
    await database.query("DELETE FROM evimed_product.jobs WHERE user_id=$1", [user]);

    assert.deepEqual(await indexed.deleteProjectMemory(user, "default"), { structured: 2 });
    assert.deepEqual((await indexJobs(user)).map((payload) => payload.recordId).sort(), inDefault.map((record) => record.id).sort(),
      "one index delete per removed record, from the delete's own transaction");
    assert.deepEqual((await indexJobs(user)).map((payload) => [payload.scope, payload.scopeId, payload.memoryKind]),
      [["project", "default", "follow_up"], ["project", "default", "follow_up"]]);
    assert.deepEqual(await usageRows(user), [elsewhere.id], "the removed records' counters went with them");

    await database.query("DELETE FROM evimed_product.jobs WHERE user_id=$1", [user]);
    assert.equal(await indexed.purgeRecords(user), 1);
    assert.deepEqual((await indexJobs(user)).map((payload) => payload.recordId), [elsewhere.id]);
    assert.deepEqual(await usageRows(user), []);
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [user]);
  }
});

test("undoing the write that created a memory removes its counter too", options, async () => {
  const created = await store.upsertRecord(owner, {
    scope: "user", kind: "preference", key: "preference.undo_counter", value: "结论先行", summary: "结论先行",
    origin: "explicit", status: "active", confidence: 1, importance: 0.7,
  }, null, { by: "extraction" });
  await store.noteRecordUsage(owner, [created.id]);
  assert.ok((await usageRows(owner)).includes(created.id));
  const undone = await store.undo(owner, created.id, { expectedVersion: created.version });
  assert.equal(undone.undone, "removed");
  assert.ok(!(await usageRows(owner)).includes(created.id));
});

test("orphan counters are reported by account, removed with apply, and a second pass finds none", options, async () => {
  const kept = await store.upsertRecord(owner, {
    scope: "user", kind: "preference", key: "preference.kept_counter", value: "表格优先", summary: "表格优先",
    origin: "explicit", status: "active", confidence: 1, importance: 0.7,
  }, null, {});
  await store.noteRecordUsage(owner, [kept.id]);
  // What a bare DELETE left behind before 2026-09-27.
  await database.query(`INSERT INTO evimed_memory.record_usage(user_id,record_id,used_count,last_used_at)
    VALUES ($1,'orphan-one',3,clock_timestamp()),($1,'orphan-two',1,clock_timestamp())`, [owner]);
  const report = await store.orphanUsage({ userId: owner });
  assert.deepEqual(report, { applied: false, orphans: [{ userId: owner, rows: 2 }] });
  assert.ok((await usageRows(owner)).includes("orphan-one"), "a report removes nothing");
  assert.deepEqual(await store.orphanUsage({ userId: owner, apply: true }), { applied: true, orphans: [{ userId: owner, rows: 2 }] });
  assert.deepEqual(await store.orphanUsage({ userId: owner, apply: true }), { applied: true, orphans: [] });
  assert.ok((await usageRows(owner)).includes(kept.id), "a counter whose record exists is kept");
});

test("the index sweep reads every account in id order, including one with no records", options, async () => {
  const listed = [];
  let after = "";
  for (let page = 0; page < 1000; page += 1) {
    const batch = await store.accountsAfter({ after, limit: 50 });
    listed.push(...batch);
    if (batch.length < 50) break;
    after = batch.at(-1);
  }
  assert.ok(listed.includes(owner));
  assert.deepEqual(listed, [...listed].sort(), "id order, so the cursor never skips one");
});
