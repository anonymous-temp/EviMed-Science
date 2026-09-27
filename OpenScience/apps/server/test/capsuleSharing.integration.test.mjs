// Sharing a capsule end to end, against a real PostgreSQL (2026-09-26 audit,
// M-6): what a pack says about itself, who can open it without a password,
// what an account with nothing to share hears, and a newer snapshot taken in
// place of the one the recipient already holds.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const sender = `share_sender_${randomUUID()}`;
const recipient = `share_recipient_${randomUUID()}`;
const bystander = `share_bystander_${randomUUID()}`;
const empty = `share_empty_${randomUUID()}`;
const password = "test-only-share-passphrase";
/** @type {any} */ let directory;
/** @type {any} */ let database;
/** @type {any} */ let documents;
/** @type {any} */ let capsules;
/** @type {any} */ let transfers;

before(async () => {
  if (!url) return;
  directory = await mkdtemp("/tmp/evimed-share-");
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
  await database.query(`INSERT INTO evimed_control.users(id,name,auth_type) VALUES
    ($1,'李主任','development'),($2,'Recipient','development'),($3,'Bystander','development'),($4,'Empty Owner','development')`,
  [sender, recipient, bystander, empty]);
  documents = new ProductDocuments(database);
  capsules = new CapsuleService(documents);
  transfers = new CapsuleTransferService({ documents, capsules, identities: new CapsuleIdentityStore(directory), dataDir: directory });
});

after(async () => {
  if (database) {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[sender, recipient, bystander, empty]]);
    await database.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** @param {string} content */
async function method(capsuleId, content) {
  return capsules.addEntry(sender, capsuleId, { factKind: "method_preference", layer: "methods", content });
}

test("an account with nothing to share hears it as a state, and its export is a named refusal", options, async () => {
  const capsule = await capsules.create(empty, { title: "我的记忆胶囊" });
  const preview = await transfers.exportPreview(empty, capsule.id, {});
  assert.deepEqual(preview, { scopes: ["workstyle"], empty: true, tooMany: false, card: null, entries: [] });
  await assert.rejects(transfers.export(empty, capsule.id, { password }), { status: 409, code: "capsule_export_empty" });
});

test("a pack carries a signed card — title, sender, what it holds — and the preview is what the recipient will read", options, async () => {
  const capsule = await capsules.create(sender, { title: "我的记忆胶囊" });
  await method(capsule.id, "Meta 分析先报 GRADE 再报效应量。");
  await capsules.addEntry(sender, capsule.id, { factKind: "preference", layer: "profile", content: "报告一律用中文。" });
  const own = await transfers.exportPreview(sender, capsule.id, {});
  assert.equal(own.empty, false);
  assert.deepEqual(own.card, { title: "李主任的工作方式", author: "李主任", summary: "1 条做法、1 条工作偏好" });
  assert.deepEqual(own.entries.map((entry) => entry.content).sort(), ["Meta 分析先报 GRADE 再报效应量。", "报告一律用中文。"]);

  const result = await transfers.export(sender, capsule.id, { password, card: { summary: "我做 Meta 分析的两条规矩" } });
  assert.ok(!result.archive.includes(sender), "the account id never leaves; its display name is the author");
  const preview = await transfers.preview(recipient, { archive: result.archive, password });
  assert.deepEqual(preview.card, { title: "李主任的工作方式", author: "李主任", summary: "我做 Meta 分析的两条规矩" });
  assert.equal(preview.upgrades, null);
  const imported = await transfers.import(recipient, { archive: result.archive, password, expectedDigest: preview.archiveSha256, confirmed: true });
  assert.equal(imported.payload.title, "李主任的工作方式", "named by its card, not 「收到的研究胶囊」");
  const shelf = await capsules.received(recipient);
  assert.deepEqual(shelf.find((pack) => pack.id === imported.id)?.card, preview.card);
});

test("a pack sealed for named accounts opens with each one's own key, and for nobody else", options, async () => {
  const capsule = await capsules.create(sender, { title: "我的记忆胶囊" });
  await method(capsule.id, "纳入标准先写成表格再检索。");
  await assert.rejects(transfers.export(sender, capsule.id, { recipients: ["no-such-account"] }), { code: "capsule_recipient_unknown" });
  const result = await transfers.export(sender, capsule.id, { recipients: [recipient] });
  assert.equal(result.snapshot.recipientCount, 1);
  assert.equal(JSON.parse(result.archive).passwordWrap, undefined, "no password was chosen, so none was wrapped");
  const opened = await transfers.preview(recipient, { archive: result.archive });
  assert.deepEqual(opened.entries.map((entry) => entry.content), ["纳入标准先写成表格再检索。"]);
  await assert.rejects(transfers.preview(bystander, { archive: result.archive }), { code: "capsule_password_required" });
  await assert.rejects(transfers.preview(bystander, { archive: result.archive, password }), { code: "capsule_transfer_open_failed" });
  await assert.rejects(transfers.export(sender, capsule.id, {}), { code: "capsule_transfer_invalid" }, "sealed for nobody is not a pack");
});

test("a newer snapshot is taken in place of the one the recipient holds, with what changed", options, async () => {
  const capsule = await capsules.create(sender, { title: "我的记忆胶囊" });
  await method(capsule.id, "先 PROSPERO 登记。");
  const leaving = await method(capsule.id, "只看 RCT。");
  const first = await transfers.export(sender, capsule.id, { password });
  const firstPreview = await transfers.preview(recipient, { archive: first.archive, password });
  const held = await transfers.import(recipient, { archive: first.archive, password, expectedDigest: firstPreview.archiveSha256, confirmed: true });
  await capsules.enableReceived(recipient, held.id);

  await capsules.updateEntry(sender, capsule.id, leaving.id, { status: "retired", expectedRevision: leaving.revision });
  await method(capsule.id, "高质量队列研究也纳入。");
  await method(capsule.id, "报告先写结论。");
  const second = await transfers.export(sender, capsule.id, { password, supersedes: first.snapshot.id });
  const preview = await transfers.preview(recipient, { archive: second.archive, password });
  assert.deepEqual(preview.upgrades, { capsuleId: held.id, title: held.payload.title, added: 2, removed: 1, kept: 1 });
  assert.equal(preview.card.changelog, "新增 2 条、移除 1 条、保留 1 条");

  const upgraded = await transfers.import(recipient, { archive: second.archive, password, expectedDigest: preview.archiveSha256, confirmed: true });
  assert.equal(upgraded.id, held.id, "the same capsule: still enabled, still where it was");
  assert.equal(upgraded.payload.transfer.snapshotId, second.snapshot.id);
  assert.equal(upgraded.payload.transfer.previousSnapshotId, first.snapshot.id);
  assert.ok(upgraded.payload.transfer.upgradedAt);
  const facts = (await capsules.entries(recipient, held.id)).items;
  assert.deepEqual(facts.filter((fact) => fact.payload.status === "approved").map((fact) => fact.payload.content).sort(),
    ["先 PROSPERO 登记。", "报告先写结论。", "高质量队列研究也纳入。"]);
  assert.ok(facts.filter((fact) => fact.payload.status === "retired").every((fact) => fact.payload.retiredBy?.type === "upgrade"));
  assert.deepEqual((await capsules.active(recipient)).items.map((item) => item.capsuleId), [held.id], "in force as before");
  assert.equal((await capsules.list(recipient)).items.filter((item) => item.payload.imported).length, 2,
    "the upgrade made no second pack (the other is the earlier test's)");
});
