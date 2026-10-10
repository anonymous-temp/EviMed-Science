// 2026-10-10 review C-11: an account deletion writes its capsule-side state (`pending`) inside the database transaction that
// deletes the account, but a file is not part of the transaction. When the transaction rolled back, the account stayed and its
// `pending` state stayed with it, so every later capsule call of a live account answered 409 capsule_account_deleting for good,
// the 30-second sweep reported it pending forever, and a cleanup that failed said nothing of why.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { capsuleStewardshipMetricFamilies, resetCapsuleShareMetrics } from "../src/capsuleShareMetrics.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url };
const password = "test-only-rollback-passphrase";
/** @type {string} */ let root;
/** @type {any} */ let db, documents, capsules, identities;
/** @type {string[]} */ const users = [];
/** @type {{ event: string, details: any }[]} */ const reported = [];
/** @type {(userId: string) => Promise<void>} */ let privateCleanup = async () => {};
/** @type {CapsuleTransferService} */ let transfers;

before(async () => {
  if (!url) return;
  root = await fs.realpath(await fs.mkdtemp("/tmp/evimed-capsule-rollback-"));
  db = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateResearchMemory(db);
  await migrateProductStore(db);
  documents = new ProductDocuments(db);
  capsules = new CapsuleService(documents);
  identities = new CapsuleIdentityStore(root);
  transfers = new CapsuleTransferService({ documents, capsules, identities, dataDir: root,
    privateAccountCleanup: (userId) => privateCleanup(userId), report: (event, details) => { reported.push({ event, details }); } });
});
after(async () => {
  if (db) { await db.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [users]); await db.close(); }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function account() {
  const id = `rollback_${randomUUID()}`;
  users.push(id);
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Rollback fixture','development')", [id]);
  return id;
}
/** @param {string} owner */
async function source(owner) {
  const capsule = await capsules.create(owner, { title: "Rollback methods" });
  await capsules.addEntry(owner, capsule.id, { factKind: "method_preference", layer: "methods", content: "Retain study uncertainty." });
  return capsule;
}
/** The deletion route's transaction, up to the point where it fails: the capsule side is prepared, then everything rolls back. @param {string} owner */
async function deletionRollsBack(owner) {
  await assert.rejects(db.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-user:${owner}`]);
    await transfers.prepareAccountDeletion(owner, client);
    throw new Error("test-only-rollback");
  }), /test-only-rollback/);
}
/** @param {string} owner */
async function deleteForGood(owner) {
  await db.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-user:${owner}`]);
    await transfers.prepareAccountDeletion(owner, client);
    await client.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  });
}
const stateFile = (/** @type {string} */ owner) => path.join(root, "capsule-revocations", `account-${createHash("sha256").update(owner).digest("hex")}.json`);
const readState = async (/** @type {string} */ owner) => JSON.parse(await fs.readFile(stateFile(owner), "utf8"));
const counter = (/** @type {string} */ outcome) => capsuleStewardshipMetricFamilies().find((family) => family.name === "open_science_capsule_account_cleanup_total")
  ?.series.find((series) => series.labels?.outcome === outcome)?.value;

test("a deletion that rolled back gives the account its capsules back on the next call, and is counted and reported", options, async () => {
  resetCapsuleShareMetrics();
  reported.length = 0;
  const owner = await account();
  const capsule = await source(owner);
  await deletionRollsBack(owner);
  assert.equal((await readState(owner)).phase, "pending", "the rollback left the file the transaction wrote");
  // The account is still here. Until now every capsule call of it answered 409 capsule_account_deleting from this point on.
  const exported = await transfers.export(owner, capsule.id, { password });
  assert.ok(exported.archive);
  await assert.rejects(fs.stat(stateFile(owner)), { code: "ENOENT" }, "nothing of the aborted deletion is left");
  assert.equal(counter("rolled_back"), 1);
  assert.deepEqual(reported, [{ event: "rolled_back", details: { userId: owner } }]);
  // And the account can be deleted after all.
  await deleteForGood(owner);
  assert.equal((await transfers.finishAccountDeletion(owner)).completed, true);
});

test("what the rolled-back deletion overwrote comes back with it: an earlier account's tombstone", options, async () => {
  const owner = await account();
  const first = await source(owner);
  await transfers.export(owner, first.id, { password });
  await deleteForGood(owner);
  await transfers.finishAccountDeletion(owner);
  const tombstone = await readState(owner);
  assert.equal(tombstone.phase, "completed");
  // The same name registers again, and an attempt to delete that account rolls back.
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Rollback recreated','development')", [owner]);
  await deletionRollsBack(owner);
  assert.equal((await readState(owner)).phase, "pending");
  const second = await source(owner);
  assert.ok((await transfers.export(owner, second.id, { password })).archive);
  assert.deepEqual(await readState(owner), tombstone, "the earlier account's tombstone is back as it was");
});

test("the sweep releases a rolled-back deletion too, and a cleanup that fails says what failed (review C-11)", options, async () => {
  resetCapsuleShareMetrics();
  reported.length = 0;
  const rolledBack = await account();
  await source(rolledBack);
  await deletionRollsBack(rolledBack);
  const swept = await transfers.recoverPendingDeletions();
  assert.equal(swept.rolledBack, 1);
  assert.equal(swept.pending, 0, "a live account is not a deletion waiting to finish");
  await assert.rejects(fs.stat(stateFile(rolledBack)), { code: "ENOENT" });

  // A deletion that did commit, whose cleanup cannot finish: the cause is a code, in the counter, the report and the result.
  const leaving = await account();
  await source(leaving);
  await deleteForGood(leaving);
  privateCleanup = async () => { throw Object.assign(new Error("test-only-denied"), { code: "EACCES" }); };
  try {
    await assert.rejects(transfers.finishAccountDeletion(leaving), (error) => error.status === 503 && error.code === "capsule_cleanup_pending" && error.cause?.code === "EACCES");
    const retried = await transfers.recoverPendingDeletions();
    assert.equal(retried.pending, 1);
    assert.deepEqual(retried.causes, ["EACCES"]);
  } finally { privateCleanup = async () => {}; }
  assert.deepEqual(reported.filter((item) => item.event === "cleanup_failed").map((item) => item.details), [{ userId: leaving, code: "EACCES" }, { userId: leaving, code: "EACCES" }]);
  assert.equal(counter("failed"), 2);
  const finished = await transfers.recoverPendingDeletions();
  assert.equal(finished.completed, 1);
  assert.equal(counter("completed"), 1);
});
