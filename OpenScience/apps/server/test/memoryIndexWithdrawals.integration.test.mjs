import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { HttpError } from "../src/security.mjs";
import { MemoryIndexWithdrawals, withdrawalBackoffMs } from "../src/memoryIndexWithdrawals.mjs";
import { MemoryIndexWorker } from "../src/memoryIndexWorker.mjs";
import { MemoryIndexing } from "../src/memoryIndexing.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { projectMemoryUri, researchMemoryRoots, userMemoryRoot } from "../src/openVikingClient.mjs";

/**
 * What a deletion owes the recall index, against a real PostgreSQL.
 *
 * 2026-10-05, live: `DELETE /api/projects/<id>` answered 503 `memory_index_timeout`
 * right after the project's runs ended and succeeded two minutes later, because the
 * route asked the index to forget the subtree first and failed when it was slow. The
 * index owns no record (every hit is re-read from PostgreSQL), so the rows go and the
 * withdrawal is a row of its own, in the deleting transaction, retried until it lands.
 */
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const owner = `withdraw_owner_${randomUUID()}`;
/** @type {any} */ let database;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Withdrawal owner','development')", [owner]);
  await migrateProductStore(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_memory.index_withdrawals").catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
});

/** An index that answers or does not, and keeps the list of what it was asked to forget. */
function indexDouble() {
  const asked = [];
  const double = {
    asked,
    failure: /** @type {Error | null} */ (null),
    async remove(userId, uri, opts) {
      asked.push({ userId, uri, recursive: opts?.recursive === true });
      if (double.failure) throw double.failure;
      return true;
    },
  };
  return double;
}

const timeout = () => new HttpError(503, "memory_index_timeout", "The memory index is unavailable.");
// The whole table: a drain takes whatever is due, and another test file's account may have left its debt here.
const rows = async () => (await database.query("SELECT * FROM evimed_memory.index_withdrawals ORDER BY created_at, id")).rows;
const clear = () => database.query("DELETE FROM evimed_memory.index_withdrawals");
/** Make every owed withdrawal due now, as if the backoff had passed. */
const due = () => database.query("UPDATE evimed_memory.index_withdrawals SET next_attempt_at=clock_timestamp()-interval '1 second'");

test("a withdrawal is owed in the deleting transaction: it commits with it and rolls back with it", options, async () => {
  const ledger = new MemoryIndexWithdrawals({ database, openViking: indexDouble() });
  await ledger.migrate();
  await clear();
  const uri = projectMemoryUri(owner, "paper1");
  await assert.rejects(() => database.transaction(async (client) => {
    await ledger.enqueue(client, owner, [uri]);
    throw new Error("the deletion failed");
  }), /the deletion failed/);
  assert.deepEqual(await rows(), [], "a deletion that did not happen owes the index nothing");
  await database.transaction((client) => ledger.enqueue(client, owner, [uri, uri]));
  assert.deepEqual((await rows()).map((row) => row.uri), [uri], "one row for an address however often it is owed");
  await assert.rejects(() => ledger.enqueue(database, owner, ["viking://other/place"]), /subtree of the memory index/);
  await assert.rejects(() => ledger.enqueue(null, owner, [uri]), /inside the deleting transaction/);
});

test("a slow index does not stop the deletion: the withdrawal waits, backs off and lands when the index answers", options, async () => {
  const index = indexDouble();
  const ledger = new MemoryIndexWithdrawals({ database, openViking: index });
  await clear();
  const uri = projectMemoryUri(owner, "paper2");
  await database.transaction((client) => ledger.enqueue(client, owner, [uri]));

  index.failure = timeout();
  assert.deepEqual(await ledger.drain(), { removed: 0, failed: 1, code: "memory_index_timeout" });
  const [row] = await rows();
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, "memory_index_timeout");
  assert.equal(row.lease_until, null);
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now() + 20_000, "asked again after a backoff, not at once");
  assert.deepEqual(await ledger.drain(), { removed: 0, failed: 0 }, "nothing is due, so the slow index is not asked again");
  assert.equal(index.asked.length, 1);

  index.failure = null;
  await due();
  assert.deepEqual(await ledger.drain(), { removed: 1, failed: 0 });
  assert.deepEqual(await rows(), [], "a withdrawal the index has made is gone");
  assert.deepEqual(index.asked.at(-1), { userId: owner, uri, recursive: true });
  assert.deepEqual(await ledger.pending(), { pending: 0, oldestSeconds: 0, mostAttempts: 0 });
});

test("one failure ends the pass, the rows behind it are released, and the backoff doubles to an hour", options, async () => {
  const index = indexDouble();
  const ledger = new MemoryIndexWithdrawals({ database, openViking: index });
  await clear();
  const uris = ["a", "b", "c"].map((id) => projectMemoryUri(owner, `paper-${id}`));
  for (const uri of uris) await database.transaction((client) => ledger.enqueue(client, owner, [uri]));
  index.failure = timeout();
  await ledger.drain();
  assert.equal(index.asked.length, 1, "the index is not asked three times what it answered once");
  const waiting = await rows();
  assert.deepEqual(waiting.map((row) => [row.attempts, row.lease_until === null]), [[1, true], [0, true], [0, true]]);
  const pending = await ledger.pending();
  assert.equal(pending.pending, 3);
  assert.equal(pending.mostAttempts, 1);
  assert.deepEqual([1, 2, 3, 7, 20].map(withdrawalBackoffMs), [60_000, 120_000, 240_000, 3_600_000, 3_600_000]);
  await clear();
});

test("an account's own deletion is owed to the index and outlives the account", options, async () => {
  const index = indexDouble();
  const ledger = new MemoryIndexWithdrawals({ database, openViking: index });
  const leaving = `withdraw_leaving_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Leaving','development')", [leaving]);
  await migrateProductStore(database);
  const indexing = new MemoryIndexing({ database, openViking: index, jobs: new ProductJobs(database), withdrawals: ledger });
  const generation = (await indexing.accountGeneration(leaving));
  // The deletion's own transaction: the purge records what it owes instead of calling the index.
  index.failure = timeout();
  const outcome = await database.transaction(async (client) => {
    await indexing.lockAccountDeletion(leaving, client);
    const purge = await indexing.prepareAccountDeletion(leaving, generation, client);
    await client.query("DELETE FROM evimed_control.users WHERE id=$1", [leaving]);
    return purge;
  });
  assert.equal(outcome.verified, false);
  assert.ok(outcome.queued >= 2);
  assert.equal(index.asked.length, 0, "the deletion never asked a slow index anything");
  assert.equal((await database.query("SELECT 1 FROM evimed_control.users WHERE id=$1", [leaving])).rowCount, 0, "the account is gone");
  const owed = (await rows()).filter((row) => row.user_id === leaving).map((row) => row.uri);
  assert.ok(owed.includes(userMemoryRoot(leaving)), "everything of the account in the index is owed");
  // The index recovers and the worker's drain tells it, for an account that no longer exists.
  index.failure = null;
  await due();
  await ledger.drain();
  assert.ok(index.asked.some((call) => call.userId === leaving && call.uri === userMemoryRoot(leaving) && call.recursive));
  assert.deepEqual((await rows()).filter((row) => row.user_id === leaving), []);
});

test("deleting a project's memory removes its rows and owes the index the subtree, in one transaction, with no index call", options, async () => {
  const index = indexDouble();
  const ledger = new MemoryIndexWithdrawals({ database, openViking: index });
  await ledger.migrate();
  await clear();
  const store = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database, withdrawals: ledger });
  await store.upsertRecord(owner, {
    scope: "project", scopeId: "paper3", kind: "preference", key: "withdrawal.test", value: "Prefer primary evidence.",
    summary: "Primary evidence.", origin: "inferred", status: "active", confidence: 0.7, importance: 0.9,
  });
  assert.equal((await store.listRecords(owner, { scopeId: "paper3" })).length, 1);
  index.failure = timeout();
  const removed = await store.deleteProjectMemory(owner, "paper3");
  assert.equal(removed.structured, 1, "the project's memory is gone while the index is down");
  assert.equal((await store.listRecords(owner, { scopeId: "paper3" })).length, 0);
  assert.equal(index.asked.length, 0);
  assert.deepEqual((await rows()).map((row) => row.uri), [projectMemoryUri(owner, "paper3")]);
  // The memory reset owes the three research subtrees and not the capsule tree beside them.
  await store.purgeUserMemory(owner);
  const owedNow = (await rows()).map((row) => row.uri);
  for (const root of researchMemoryRoots(owner)) assert.ok(owedNow.includes(root), root);
  assert.equal(owedNow.some((uri) => uri.endsWith("/capsule")), false);
  await clear();
});

test("the index worker drains what is owed, on its own cadence and when asked, and a failing drain never throws", options, async () => {
  const index = indexDouble();
  const ledger = new MemoryIndexWithdrawals({ database, openViking: index });
  await clear();
  await database.transaction((client) => ledger.enqueue(client, owner, [projectMemoryUri(owner, "paper4")]));
  const worker = new MemoryIndexWorker({ jobs: { claim: async () => null }, indexing: { reconcile: async () => 0 }, withdrawals: ledger, reconcileMs: 300_000 });
  index.failure = timeout();
  assert.deepEqual(await worker.drainWithdrawals(), { removed: 0, failed: 1, code: "memory_index_timeout" });
  const brokenLedger = { drain: async () => { throw new HttpError(503, "memory_index_unavailable", "down"); } };
  const broken = new MemoryIndexWorker({ jobs: { claim: async () => null }, indexing: { reconcile: async () => 0 }, withdrawals: brokenLedger });
  assert.equal(await broken.drainWithdrawals(), null);
  assert.equal(broken.status().lastError, "memory_index_unavailable");
  index.failure = null;
  await due();
  assert.deepEqual(await worker.drainWithdrawals(), { removed: 1, failed: 0 });
  await worker.reconcile();
  await worker.close();
});
