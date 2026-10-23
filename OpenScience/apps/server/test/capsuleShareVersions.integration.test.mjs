// Sharing that carries on from one version to the next, against a real PostgreSQL (memory-capsule rectification, 2026-10-23):
// a delivery or a link of a newer snapshot is the next version of what its recipients already took in (they upgrade in place and
// read the changelog), a file can be sealed to the names a delivery would reach, the sender unticks entries by id and every
// capsule an account holds is read, not the first hundred.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleShareLinks } from "../src/capsuleShareLinks.mjs";
import { CapsuleSharing } from "../src/capsuleSharing.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const tag = randomUUID().slice(0, 8);
const sender = `sv_sender_${tag}`;
const vera = `sv_vera_${tag}`;
const wen = `sv_wen_${tag}`;
const xia = `sv_xia_${tag}`;
const subject = `sv_subject_${tag}`;
const reader = `sv_reader_${tag}`;
const everyone = [sender, vera, wen, xia, subject, reader];
const password = "test-only-versions-password";
/** @type {any} */ let directory; /** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let capsules;
/** @type {any} */ let transfers; /** @type {any} */ let sharing; /** @type {any} */ let links;

before(async () => {
  if (!url) return;
  directory = await mkdtemp("/tmp/evimed-share-versions-");
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
  await database.query(`INSERT INTO evimed_control.users(id,name,auth_type) VALUES
    ($1,$5,'development'),($2,$6,'development'),($3,$7,'development'),($4,$8,'development')`,
  [sender, vera, wen, xia, `发送者${tag}`, `Vera ${tag}`, `Wen ${tag}`, `Xia ${tag}`]);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Subject','subject'),($2,'Reader','development')", [subject, reader]);
  documents = new ProductDocuments(database);
  const scanner = { scan: async (_who, entries) => ({ kept: entries.map((entry) => entry.id), dropped: [], checkedAt: new Date().toISOString(), model: "ok", unchecked: [], held: [], safety: [] }) };
  capsules = new CapsuleService(documents, { scanner });
  transfers = new CapsuleTransferService({ documents, capsules, identities: new CapsuleIdentityStore(directory), dataDir: directory, scanner });
  links = new CapsuleShareLinks({ database, ttlDays: 30, maxUses: 20 });
  sharing = new CapsuleSharing({ database, transfers, links, notifications: new NotificationService(database), perDay: 500 });
});
after(async () => {
  if (database) {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [everyone]);
    await database.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** A capsule of the sender's own holding `contents` as approved methods. @param {string[]} contents */
async function authored(...contents) {
  const capsule = await capsules.create(sender, { title: "我的记忆胶囊" });
  const entries = [];
  for (const content of contents) entries.push(await capsules.addEntry(sender, capsule.id, { factKind: "method_preference", layer: "methods", content }));
  return { capsule, entries };
}

/** The delivery a recipient has waiting from this snapshot, opened and taken in. @param {string} userId @param {string} snapshotId */
async function takeIn(userId, snapshotId) {
  const waiting = (await sharing.pending(userId)).find((item) => item.snapshotId === snapshotId);
  assert.ok(waiting, "the delivery is waiting");
  const opened = await sharing.open(userId, waiting.id);
  return { opened, imported: await sharing.import(userId, waiting.id, { expectedDigest: opened.preview.archiveSha256, title: "收到的做法" }) };
}

test("a delivery of a newer snapshot is the next version of what a recipient took in: it upgrades in place with the changelog, and a recipient who never held the first gets a pack of their own", options, async () => {
  const { capsule } = await authored("Meta 分析先报 GRADE 再报效应量。", "纳入标准先写成表格。");
  const first = await sharing.deliver(sender, capsule.id, { recipients: [vera, wen] });
  assert.equal(first.snapshot.supersedes, null, "nothing was taken in yet: this starts a chain");
  const { imported } = await takeIn(vera, first.snapshot.id);
  // Wen did not take the first one in; a version beside it would have nothing to replace.
  const added = await capsules.addEntry(sender, capsule.id, { factKind: "method_preference", layer: "methods", content: "敏感性分析要写明排除了哪几项研究。" });

  const second = await sharing.deliver(sender, capsule.id, { recipients: [vera, xia] });
  assert.equal(second.snapshot.supersedes, first.snapshot.id, "the newest snapshot one of these recipients took in");
  const opened = await sharing.open(vera, (await sharing.pending(vera)).find((item) => item.snapshotId === second.snapshot.id).id);
  assert.deepEqual(opened.preview.upgrades, { capsuleId: imported.id, title: "收到的做法", added: 1, removed: 0, kept: 2 });
  assert.equal(opened.preview.card.changelog, "新增 1 条、保留 2 条", "the changelog is on the card the recipient reads");
  const upgraded = await sharing.import(vera, (await sharing.pending(vera)).find((item) => item.snapshotId === second.snapshot.id).id,
    { expectedDigest: opened.preview.archiveSha256 });
  assert.equal(upgraded.id, imported.id, "the same capsule, upgraded in place: no second pack");
  assert.equal((await capsules.received(vera)).length, 1);
  assert.deepEqual((await capsules.entries(vera, imported.id)).items.filter((item) => item.payload.status === "approved").map((item) => item.payload.content).sort(),
    ["Meta 分析先报 GRADE 再报效应量。", added.payload.content, "纳入标准先写成表格。"].sort());

  // Xia never held the first: a pack of its own, the same content.
  const xiaFirst = await takeIn(xia, second.snapshot.id);
  assert.notEqual(xiaFirst.imported.id, imported.id);
  assert.equal(xiaFirst.opened.preview.upgrades, null);
  // Wen's first delivery is still waiting and never upgraded anything; the chain pointer harms nobody.
  assert.equal((await sharing.pending(wen)).filter((item) => item.snapshotId === first.snapshot.id).length, 1);

  // A third version continues from the newest one Vera took in, not from an earlier export nobody holds.
  await transfers.export(sender, capsule.id, { password, scopes: ["workstyle"], supersedes: second.snapshot.id });
  const third = await sharing.deliver(sender, capsule.id, { recipients: [vera] });
  assert.equal(third.snapshot.supersedes, second.snapshot.id);
});

test("a link continues the newest snapshot anybody took in, and the redeemer upgrades in place", options, async () => {
  const { capsule } = await authored("先 PROSPERO 登记。");
  const first = await sharing.createLink(sender, capsule.id, {});
  assert.equal(first.snapshot.supersedes, null);
  const opened = await sharing.openLink(vera, first.token);
  const imported = await sharing.importLink(vera, first.token, { expectedDigest: opened.preview.archiveSha256, title: "link pack" });
  await capsules.addEntry(sender, capsule.id, { factKind: "method_preference", layer: "methods", content: "先写好检索式再检索。" });

  const next = await sharing.createLink(sender, capsule.id, {});
  assert.equal(next.snapshot.supersedes, first.snapshot.id);
  const preview = await sharing.openLink(vera, next.token);
  assert.equal(preview.preview.upgrades.capsuleId, imported.id);
  const upgraded = await sharing.importLink(vera, next.token, { expectedDigest: preview.preview.archiveSha256 });
  assert.equal(upgraded.id, imported.id);
  // Somebody who never held it previews the same link as a new pack.
  assert.equal((await sharing.openLink(xia, next.token)).preview.upgrades, null);
  // A delivery after a link continues the link's snapshot for a recipient who took that in.
  const later = await sharing.deliver(sender, capsule.id, { recipients: [vera] });
  assert.equal(later.snapshot.supersedes, next.snapshot.id, "whichever channel the version was taken in by");
});

test("a file is sealed to the names a delivery would reach, without a password, and says how many it reached and nothing of which", options, async () => {
  const { capsule } = await authored("检索式要写进附录。");
  const named = await transfers.export(sender, capsule.id, { scopes: ["workstyle"], recipientNames: [`Vera ${tag}`, `no such ${tag}`, subject, sender] });
  assert.deepEqual(named.reached, { requested: 4, sealed: 1 }, "a subject account, the sender and a stranger are not reached; nothing says which");
  assert.equal(named.snapshot.recipientCount, 1);
  // Vera opens it with her own key, no password; nobody else can.
  const preview = await transfers.preview(vera, { archive: named.archive });
  assert.equal(preview.entries.length, 1);
  await assert.rejects(transfers.preview(wen, { archive: named.archive }), { code: "capsule_password_required" });
  // A pack sealed for names that reached nobody is refused by name unless a password seals it too.
  await assert.rejects(transfers.export(sender, capsule.id, { scopes: ["workstyle"], recipientNames: [`no such ${tag}`] }), { code: "capsule_recipient_unknown" });
  const both = await transfers.export(sender, capsule.id, { scopes: ["workstyle"], password, recipientNames: [`no such ${tag}`] });
  assert.deepEqual(both.reached, { requested: 1, sealed: 0 });
  assert.equal((await transfers.preview(wen, { archive: both.archive, password })).entries.length, 1, "the password still opens it");
  // By id too, as a delivery takes one; and bounded.
  const byId = await transfers.export(sender, capsule.id, { scopes: ["workstyle"], recipientNames: [xia] });
  assert.equal((await transfers.preview(xia, { archive: byId.archive })).entries.length, 1);
  await assert.rejects(transfers.export(sender, capsule.id, { scopes: ["workstyle"], recipientNames: Array.from({ length: 33 }, (_, index) => `n${index}`) }), { code: "capsule_transfer_invalid" });
  await assert.rejects(transfers.export(sender, capsule.id, { scopes: ["workstyle"], recipientNames: "Vera" }), { code: "capsule_transfer_invalid" });
});

test("what the sender unticked is not in the pack, at export, in a delivery and in a link; unticking everything is an empty export, not a different one", options, async () => {
  const { capsule, entries } = await authored("第一条做法。", "第二条做法。", "第三条做法。");
  const preview = await transfers.exportPreview(sender, capsule.id, {});
  assert.equal(preview.entries.length, 3);
  assert.ok(preview.entries.every((entry) => /^fact:/.test(entry.id) && entry.included === true));
  const second = preview.entries.find((entry) => entry.content === "第二条做法。");
  assert.equal(second.id, `fact:${entries[1].id}`, "the id is the source's own, the same at export as in the preview");

  const file = await transfers.export(sender, capsule.id, { password, scopes: ["workstyle"], excludeEntryIds: [second.id] });
  const read = await transfers.preview(vera, { archive: file.archive, password });
  assert.deepEqual(read.entries.map((entry) => entry.content).sort(), ["第一条做法。", "第三条做法。"]);
  assert.equal(read.card.summary, "2 条做法");
  assert.equal(file.snapshot.entryCount, 2);

  const delivered = await sharing.deliver(sender, capsule.id, { recipients: [wen], excludeEntryIds: [second.id] });
  const item = (await sharing.pending(wen)).find((entry) => entry.snapshotId === delivered.snapshot.id);
  assert.deepEqual((await sharing.open(wen, item.id)).preview.entries.map((entry) => entry.content).sort(), ["第一条做法。", "第三条做法。"]);
  const link = await sharing.createLink(sender, capsule.id, { excludeEntryIds: [second.id] });
  assert.equal((await sharing.openLink(xia, link.token)).preview.entries.length, 2);

  await assert.rejects(transfers.export(sender, capsule.id, { password, scopes: ["workstyle"], excludeEntryIds: preview.entries.map((entry) => entry.id) }), { status: 409, code: "capsule_export_empty" });
  await assert.rejects(transfers.export(sender, capsule.id, { password, scopes: ["workstyle"], excludeEntryIds: ["fact"] }), { code: "capsule_transfer_invalid" });
});

test("the preview says, per reason and in one plain sentence, what is not in the pack: the assistant's notes, a document's yield, what is sensitive, what was shared with the person", options, async () => {
  const owner = sender;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'notes','Notes',1048576) ON CONFLICT DO NOTHING", [owner]);
  const capsule = await capsules.create(owner, { title: "我的记忆胶囊" });
  await capsules.addEntry(owner, capsule.id, { factKind: "preference", layer: "profile", content: "报告一律用中文。" });
  // The assistant's own notes, in force at once in the project's notes capsule, that the person never confirmed or changed (two).
  await capsules.note(owner, "notes", { factKind: "preference", content: "助手觉得对方喜欢短句。" });
  await capsules.note(owner, "notes", { factKind: "preference", content: "助手觉得对方不喜欢表格。" });
  // What a document yielded never leaves.
  await documents.put(owner, "fact", randomUUID(), { capsuleId: capsule.id, factKind: "preference", layer: "sources", content: "资料里写的偏好。",
    origin: "inferred", status: "approved", sourceId: `src_${"a".repeat(32)}`, projectId: "notes", contextOnly: true, provenance: [] }, { expectedRevision: 0 });
  // A pack someone shared with this person is theirs to use, never to forward.
  const pack = await documents.put(owner, "capsule", randomUUID(), { title: "别人的做法", description: "", imported: true, activationMode: "guest" }, { expectedRevision: 0 });
  await documents.put(owner, "fact", randomUUID(), { capsuleId: pack.id, factKind: "preference", layer: "profile", content: "别人的偏好。", origin: "system", status: "approved",
    contextOnly: true, share: { authorName: "某人" }, provenance: [] }, { expectedRevision: 0 });
  // A legacy record the person marked sensitive, and one the assistant inferred.
  await database.query(`INSERT INTO evimed_memory.records(id,user_id,scope,scope_id,kind,key,value,summary,status,origin,sensitive,confidence,importance,version)
    VALUES($1,$3,'user','','preference','k1','敏感的偏好','','active','explicit',true,1,0.5,1),($2,$3,'user','','preference','k2','推断的偏好','','active','inferred',false,0.6,0.5,1)`,
  [`mr_${tag}_1`, `mr_${tag}_2`, owner]);
  const preview = await transfers.exportPreview(owner, capsule.id, {});
  const byReason = Object.fromEntries(preview.excluded.map((item) => [item.reason, item]));
  assert.equal(byReason.inferred.count, 3, "two of the assistant's notes and a record it inferred");
  assert.equal(byReason.sensitive.count, 1, "the record the person marked sensitive");
  assert.equal(byReason.document.count, 1);
  assert.equal(byReason.received.count, 1);
  for (const item of preview.excluded) {
    assert.match(item.text, /^[^\n]+。$/);
    assert.doesNotMatch(item.text, /origin|inferred|provenance|share|sha|layer|capsule/i, "no back-office words");
    assert.ok(!/偏好|资料里写的/.test(item.text), "counts, never what is left out");
  }
  assert.match(byReason.inferred.text, /助手/);
  assert.match(byReason.document.text, /上传的资料/);
  assert.match(byReason.received.text, /别人分享给你/);
  assert.deepEqual(preview.entries.map((entry) => entry.content), ["报告一律用中文。"], "what the person said stays");
});

test("received and mine read every capsule an account holds, not the first hundred", options, async () => {
  for (let index = 0; index < 130; index += 1) {
    await documents.put(reader, "capsule", `pack-${tag}-${String(index).padStart(3, "0")}`, { title: `收到的 ${index}`, description: "", imported: true, activationMode: "guest",
      transfer: { issuerTrust: "verified" } }, { expectedRevision: 0 });
  }
  for (let index = 0; index < 130; index += 1) {
    await documents.put(reader, "capsule", `notes-${tag}-${String(index).padStart(3, "0")}`, { title: `项目笔记 ${index}`, description: "", imported: false, activationMode: "own" }, { expectedRevision: 0 });
  }
  assert.equal((await capsules.received(reader)).length, 130, "every pack is on the shelf");
  assert.equal((await capsules.mine(reader)).capsules.length, 130, "every project's notes capsule is read");
});

test("what replaces a version the author took down is a pack of its own: an upgrade in place would keep the copy marked and the new version would never be in force", options, async () => {
  const { capsule } = await authored("先画 PRISMA 流程图。");
  const heldBefore = (await capsules.received(vera)).length;
  const first = await sharing.deliver(sender, capsule.id, { recipients: [vera] });
  const { imported } = await takeIn(vera, first.snapshot.id);
  await capsules.enableReceived(vera, imported.id);
  // The author takes the first version down: the copy is disabled and marked, and nothing more is imported from it.
  const down = await sharing.takeDown({ authorId: sender, snapshotId: first.snapshot.id, by: "author", reason: "写错了" });
  assert.equal(down.copies, 1);
  assert.equal((await capsules.received(vera)).find((pack) => pack.id === imported.id).takenDown.by, "author");
  await capsules.addEntry(sender, capsule.id, { factKind: "method_preference", layer: "methods", content: "筛选先标题后摘要。" });
  const second = await sharing.deliver(sender, capsule.id, { recipients: [vera] });
  assert.equal(second.snapshot.supersedes, null, "a taken-down version is not continued");
  const next = await takeIn(vera, second.snapshot.id);
  assert.equal(next.opened.preview.upgrades, null);
  assert.notEqual(next.imported.id, imported.id, "a pack of its own");
  await capsules.enableReceived(vera, next.imported.id);
  const shelf = await capsules.received(vera);
  assert.equal(shelf.length, heldBefore + 2);
  assert.equal(shelf.find((pack) => pack.id === next.imported.id).enabled, true, "and it can be in force");
  assert.ok(shelf.find((pack) => pack.id === imported.id).takenDown);
  // The same when the file itself names the taken-down snapshot as the one it replaces: the copy is not upgraded.
  const forced = await transfers.export(sender, capsule.id, { password, scopes: ["workstyle"], supersedes: first.snapshot.id });
  const preview = await transfers.preview(vera, { archive: forced.archive, password });
  assert.equal(preview.upgrades, null);
});
