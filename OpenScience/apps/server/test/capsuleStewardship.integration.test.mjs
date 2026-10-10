// 2026-10-10 review C-10, through the transfer service on a real database:
//   - a pack whose password wrap names a cost the platform never wrote is refused by name before any key is derived;
//   - password work is shared out account by account, and a refusal is a named 429 with a retry hint;
//   - an account keeps a bounded number of live snapshots, a revoke takes the ciphertext off the disk, and a sweep takes off
//     what no record names.
import assert from "node:assert/strict";
import crypto, { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";

import { signablePayload } from "@evimed/domain";

import { CapsuleIdentityStore, capsuleAccountHash } from "../src/capsuleIdentityStore.mjs";
import { generateCapsuleIdentity, packCapsule } from "../src/capsuleContainer.mjs";
import { capsuleShareMetricFamilies, capsuleStewardshipMetricFamilies, resetCapsuleShareMetrics } from "../src/capsuleShareMetrics.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url };
const password = "test-only-stewardship-passphrase";
const owner = `steward_${randomUUID()}`;
const other = `steward_${randomUUID()}`;
const sharer = `steward_${randomUUID()}`;
/** @type {string} */ let directory;
/** @type {any} */ let database, documents, capsules, identities, transfers;

before(async () => {
  if (!url) return;
  directory = await mkdtemp("/tmp/evimed-stewardship-");
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateResearchMemory(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Steward owner','development'),($2,'Steward other','development'),($3,'Steward sharer','development')", [owner, other, sharer]);
  documents = new ProductDocuments(database);
  capsules = new CapsuleService(documents);
  identities = new CapsuleIdentityStore(directory);
  transfers = new CapsuleTransferService({ documents, capsules, identities, dataDir: directory });
});
after(async () => {
  if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other, sharer]]); await database.close(); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** @param {string} user */
async function source(user = owner) {
  const capsule = await capsules.create(user, { title: "Stewardship source" });
  await capsules.addEntry(user, capsule.id, { factKind: "method_preference", layer: "methods", content: `Preserve reproducible analysis steps ${randomUUID()}.` });
  return capsule;
}
/** Holds every scrypt result until released: who is running a derivation is then a state the test sets. */
function holdScrypt() {
  const original = crypto.scrypt;
  /** @type {(() => void)[]} */ const held = [];
  crypto.scrypt = (/** @type {any[]} */ ...args) => { const callback = args.pop(); return original(...args, (/** @type {any} */ error, /** @type {any} */ key) => { held.push(() => callback(error, key)); }); };
  syncBuiltinESMExports();
  return {
    held,
    release(count = 1) { for (const resume of held.splice(0, count)) resume(); },
    async reached(count = 1) { for (let attempt = 0; attempt < 600 && held.length < count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(held.length >= count, `${held.length} derivations held, expected ${count}`); },
    restore() { crypto.scrypt = original; syncBuiltinESMExports(); for (const resume of held.splice(0)) resume(); },
  };
}
/** @param {Promise<unknown>} promise */
async function settledWithin(promise, ms = 60) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
}
const snapshotFiles = async () => (await readdir(path.join(directory, "capsule-snapshots"))).sort();
const metric = (/** @type {string} */ name, /** @type {string} */ label, /** @type {string} */ value) =>
  capsuleStewardshipMetricFamilies().find((family) => family.name === name)?.series.find((series) => series.labels?.[label] === value)?.value;

test("a pack whose password wrap names a cost the platform never wrote is refused by name before any key is derived", options, async () => {
  resetCapsuleShareMetrics();
  // What a hostile sender can make with their own key: a correctly signed pack, shaped like a share, whose password wrap
  // asks for 256 MiB of scrypt. Nothing about it is wrong except the cost it names.
  const attacker = generateCapsuleIdentity();
  const hostile = await packCapsule({
    capsuleId: randomUUID(), version: 1, createdAt: new Date().toISOString(),
    issuer: { userId: `issuer-${randomUUID()}`, signingKeyId: attacker.signing.keyId, signingPrivateKey: attacker.signing.privateKey },
    scope: ["workstyle"], layers: ["methods"], password,
    entries: [{ path: "provenance.json", content: "{}", mime: "application/json", layer: "methods" }],
  });
  const salt = randomBytes(16);
  const header = Buffer.from(JSON.stringify({ kdf: "scrypt", N: 262144, r: 8, p: 1, maxmem: 320 * 1024 * 1024, salt: salt.toString("base64") }), "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(header.length);
  const wrap = Buffer.concat([length, header, randomBytes(12 + 32 + 16)]);
  hostile.manifest.encryption.passwordWrapSha256 = createHash("sha256").update(wrap).digest("hex");
  hostile.manifest.signature.value = sign(null, Buffer.from(signablePayload(hostile.manifest), "utf8"),
    crypto.createPrivateKey({ key: Buffer.from(attacker.signing.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64");
  const archive = JSON.stringify({ format: "evimedcap", version: 1, manifest: hostile.manifest, issuerPublicKey: attacker.signing.publicKey,
    passwordWrap: wrap.toString("base64"), payload: Object.fromEntries(Object.entries(hostile.payload).map(([name, bytes]) => [name, bytes.toString("base64")])) });

  // Counted, not held: a derivation that does start must finish, or the test would wait on it instead of failing.
  const original = crypto.scrypt;
  let started = 0;
  crypto.scrypt = (/** @type {any[]} */ ...args) => { started += 1; return original(...args); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(transfers.preview(other, { archive, password }),
      (error) => error.status === 400 && error.code === "capsule_password_params_unsupported");
    assert.equal(started, 0, "no derivation was started for it");
    assert.equal(metric("open_science_capsule_password_refused_total", "reason", "params_unsupported"), 1);
  } finally { crypto.scrypt = original; syncBuiltinESMExports(); }
});

test("password work is shared out account by account: a refusal is a named 429 with a hint, and another account waits its turn", options, async () => {
  resetCapsuleShareMetrics();
  const capsule = await source();
  const sealed = await transfers.export(owner, capsule.id, { password });
  const hold = holdScrypt();
  try {
    const first = transfers.preview(other, { archive: sealed.archive, password });
    await hold.reached(1);
    await assert.rejects(transfers.preview(other, { archive: sealed.archive, password }),
      (error) => error.status === 429 && error.code === "capsule_password_busy" && error.retryAfterSeconds > 0);
    const waiting = transfers.preview(owner, { archive: sealed.archive, password });
    assert.equal(await settledWithin(waiting), false, "another account is not refused: it waits behind the first");
    hold.release();
    assert.equal((await first).entries.length, 1);
    await hold.reached(1);
    hold.release();
    assert.equal((await waiting).entries.length, 1);
    assert.equal(metric("open_science_capsule_password_refused_total", "reason", "account_busy"), 1);

    // An export is a derivation too: asked twice by one account, the second is the same named answer, not a failure.
    const firstExport = transfers.export(owner, capsule.id, { password });
    await hold.reached(1);
    await assert.rejects(transfers.export(owner, capsule.id, { password }),
      (error) => error.status === 429 && error.code === "capsule_password_busy");
    hold.release();
    assert.ok((await firstExport).archive);
  } finally { hold.restore(); }
});

test("an account keeps a bounded number of live snapshots, a revoke takes the ciphertext off the disk and makes room", options, async () => {
  resetCapsuleShareMetrics();
  const bounded = new CapsuleTransferService({ documents, capsules, identities, dataDir: directory, maxLiveSnapshots: 2 });
  const capsule = await source(sharer);
  const first = await bounded.export(sharer, capsule.id, { recipients: [owner] });
  const second = await bounded.export(sharer, capsule.id, { recipients: [owner] });
  await assert.rejects(bounded.export(sharer, capsule.id, { recipients: [owner] }), (error) => error.status === 409 && error.code === "capsule_snapshots_limit");
  assert.equal((await snapshotFiles()).filter((name) => name.startsWith(capsuleAccountHash(sharer))).length, 2, "the refused export wrote nothing");

  const file = (/** @type {{ snapshot: { id: string } }} */ made) => `${capsuleAccountHash(sharer)}-${made.snapshot.id}.evimedcap`;
  assert.ok((await snapshotFiles()).includes(file(first)));
  await bounded.revoke(sharer, capsule.id, first.snapshot.id, first.snapshot.revision);
  assert.ok(!(await snapshotFiles()).includes(file(first)), "a revoked snapshot's ciphertext has no reader and goes off the disk");
  assert.ok((await snapshotFiles()).includes(file(second)), "the other is untouched");
  await assert.rejects(bounded.download(sharer, capsule.id, first.snapshot.id), { code: "capsule_snapshot_revoked" });
  const third = await bounded.export(sharer, capsule.id, { recipients: [owner] });
  assert.ok(third.archive, "the revoke made room");

  // Deleting the capsule revokes what is left of it, and its files go with them.
  assert.deepEqual((await bounded.revokeAllForCapsule(sharer, capsule.id)).sort(), [second.snapshot.id, third.snapshot.id].sort());
  assert.deepEqual((await snapshotFiles()).filter((name) => name.startsWith(capsuleAccountHash(sharer))), []);
  assert.ok((metric("open_science_capsule_snapshot_files_total", "event", "discarded") ?? 0) >= 3);
  assert.equal(capsuleShareMetricFamilies().find((family) => family.name === "open_science_capsule_share_refused_total")?.series.find((series) => series.labels?.reason === "snapshot_limit")?.value, 1);
});

test("a sweep takes off the disk what nothing can serve, and leaves a take-down's file, a live one and a write in flight", options, async () => {
  resetCapsuleShareMetrics();
  const account = `steward_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Steward sweeper','development')", [account]);
  try {
    const capsule = await source(account);
    const live = await transfers.export(account, capsule.id, { recipients: [owner] });
    const revokedByHand = await transfers.export(account, capsule.id, { recipients: [owner] });
    const takenDown = await transfers.export(account, capsule.id, { recipients: [owner] });
    const hash = capsuleAccountHash(account);
    const dir = path.join(directory, "capsule-snapshots");
    const nameOf = (/** @type {{ snapshot: { id: string } }} */ made) => `${hash}-${made.snapshot.id}.evimedcap`;
    // A revoke whose file removal failed: the record says revoked, the file is still there.
    const record = await documents.get(account, "preferences", revokedByHand.snapshot.id);
    await documents.put(account, "preferences", record.id, { ...record.payload, status: "revoked", revokedAt: new Date().toISOString() }, { expectedRevision: record.revision });
    await transfers.takeDown({ authorId: account, snapshotId: takenDown.snapshot.id, by: "author", reason: "test-only" });
    // Leftovers of crashed writes: a file no record names, an older build's flat name, a temporary copy; and one just written.
    const orphan = `${hash}-${randomUUID()}.evimedcap`;
    const flatOrphan = `${randomUUID()}.evimedcap`;
    const temporary = `${hash}-${randomUUID()}.evimedcap.${randomUUID()}.tmp`;
    const inFlight = `${hash}-${randomUUID()}.evimedcap`;
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    for (const name of [orphan, flatOrphan, temporary, inFlight]) await writeFile(path.join(dir, name), "x", { mode: 0o600 });
    for (const name of [orphan, flatOrphan, temporary, nameOf(revokedByHand), nameOf(takenDown), nameOf(live)]) await utimes(path.join(dir, name), old, old);

    const result = await transfers.sweepSnapshots();
    assert.deepEqual(result.removed, { orphan: 2, revoked: 1, temporary: 1 });
    assert.equal(result.failed, 0);
    const left = await snapshotFiles();
    for (const gone of [orphan, flatOrphan, temporary, nameOf(revokedByHand)]) assert.ok(!left.includes(gone), `${gone} is gone`);
    for (const kept of [nameOf(live), nameOf(takenDown), inFlight]) assert.ok(left.includes(kept), `${kept} stays`);
    assert.equal(metric("open_science_capsule_snapshot_files_total", "event", "orphan"), 2);
    assert.equal(metric("open_science_capsule_snapshot_files_total", "event", "revoked"), 1);
    assert.deepEqual(await transfers.sweepSnapshots(), { examined: 2, removed: { orphan: 0, revoked: 0, temporary: 0 }, failed: 0 }, "idempotent: the live and the taken-down file are looked at and kept");
    assert.ok((await stat(path.join(dir, nameOf(live)))).isFile());
  } finally {
    await database.query("DELETE FROM evimed_control.users WHERE id=$1", [account]);
  }
});
