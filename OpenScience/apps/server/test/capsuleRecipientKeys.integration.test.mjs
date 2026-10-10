// 2026-10-10 review C-9, the two halves that need a database:
//   - sealing a pack for named accounts made each existing account its key files while the export was still being checked, so a
//     refused export (an unknown name among them, nothing to share, a pack too large) left files behind for accounts that had
//     done nothing, one more for every existing name a sender probed;
//   - a recipient who exports their account was handed their sharer's login name with every imported pack.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { withAccountExportSnapshot } from "../src/accountExport.mjs";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url };
const password = "test-only-recipient-passphrase";
/** @type {string} */ let directory;
/** @type {any} */ let database, documents, capsules, transfers;
/** @type {string[]} */ const users = [];

before(async () => {
  if (!url) return;
  directory = await mkdtemp("/tmp/evimed-recipient-keys-");
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateResearchMemory(database);
  documents = new ProductDocuments(database);
  capsules = new CapsuleService(documents);
  transfers = new CapsuleTransferService({ documents, capsules, identities: new CapsuleIdentityStore(directory), dataDir: directory });
});
after(async () => {
  if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [users]); await database.close(); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** An account whose display name is its login name, which is what a local account has until it sets one. */
async function account(prefix = "rcpt") {
  const id = `${prefix}_${randomUUID()}`;
  users.push(id);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$1,'development')", [id]);
  return id;
}
/** @param {string} user @param {number} [entries] @param {number} [size] */
async function capsuleWith(user, entries = 1, size = 40) {
  const capsule = await capsules.create(user, { title: "Recipient methods" });
  for (let index = 0; index < entries; index += 1) {
    await capsules.addEntry(user, capsule.id, { factKind: "preference", layer: "profile", content: `${String(index).padStart(3, "0")} ${"x".repeat(size)}` });
  }
  return capsule;
}
const keyFiles = async () => (await readdir(path.join(directory, "capsule-keys")).catch(() => [])).sort();
const keyFileOf = (/** @type {string} */ user) => `account-${createHash("sha256").update(user).digest("hex")}.json`;

test("a refused export makes no key files for the accounts it named", options, async () => {
  const sender = await account("sender");
  const named = await account("named");
  const capsule = await capsuleWith(sender);
  // An unknown name among existing ones: refused as before, with nothing made for the account that does exist.
  await assert.rejects(transfers.export(sender, capsule.id, { recipients: [named, `nobody_${randomUUID()}`] }), { code: "capsule_recipient_unknown" });
  assert.ok(!(await keyFiles()).includes(keyFileOf(named)), "no key was made for an account that was only named");
  // Nothing to share: the pack is empty, so it is refused, and nobody is given a key for it.
  const empty = await capsules.create(sender, { title: "Nothing yet" });
  await assert.rejects(transfers.export(sender, empty.id, { recipients: [named] }), { code: "capsule_export_empty" });
  assert.ok(!(await keyFiles()).includes(keyFileOf(named)));
  // Too much to share: refused before anything is sealed for anyone.
  const large = await capsuleWith(sender, 60, 20_000 - 4);
  await assert.rejects(transfers.export(sender, large.id, { recipients: [named] }), { status: 413, code: "capsule_transfer_too_large" });
  assert.ok(!(await keyFiles()).includes(keyFileOf(named)));
  // And no export at all without a way to open it.
  await assert.rejects(transfers.export(sender, capsule.id, {}), { code: "capsule_transfer_invalid" });
  assert.ok(!(await keyFiles()).includes(keyFileOf(named)));
});

test("an export that goes ahead seals the pack for the accounts it named, and their keys are made for it", options, async () => {
  const sender = await account("sender");
  const named = await account("named");
  const capsule = await capsuleWith(sender);
  const exported = await transfers.export(sender, capsule.id, { recipients: [named] });
  assert.equal(exported.snapshot.recipientCount, 1);
  assert.ok((await keyFiles()).includes(keyFileOf(named)), "the recipient has the key the pack is sealed for");
  assert.equal((await transfers.preview(named, { archive: exported.archive })).entries.length, 1, "and opens it with that key alone");
});

test("a recipient who exports their account is not handed their sharer's login name", options, async () => {
  const sharer = await account("sharer");
  const recipient = await account("keeper");
  const capsule = await capsuleWith(sharer);
  const shared = await transfers.export(sharer, capsule.id, { password });
  const preview = await transfers.preview(recipient, { archive: shared.archive, password });
  const imported = await transfers.import(recipient, { archive: shared.archive, password, confirmed: true, expectedDigest: preview.archiveSha256 });
  const stored = await documents.get(recipient, "capsule", imported.id);
  assert.equal(stored.payload.share.authorId, sharer, "the id is kept in the record: the take-down and the corroboration count match on it");

  const generation = (await database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [recipient])).rows[0].generation;
  const archive = await withAccountExportSnapshot(database, { id: recipient, accountCreatedAt: generation }, {}, async (snapshot) => snapshot.data.toString());
  assert.ok(!archive.includes(sharer), "the sharer's login name is nowhere in the archive");
  const state = JSON.parse(archive);
  const pack = state.documents.find((/** @type {any} */ row) => row.kind === "capsule" && row.id === imported.id);
  assert.equal(pack.payload.share.authorId, undefined);
  assert.equal(pack.payload.imported, true, "the pack itself is the recipient's and is exported");
  assert.ok(state.documents.some((/** @type {any} */ row) => row.kind === "fact" && row.payload.capsuleId === imported.id), "and so are its entries");
});
