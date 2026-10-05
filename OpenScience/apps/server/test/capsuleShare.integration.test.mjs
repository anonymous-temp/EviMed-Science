// Sharing memory inside the platform, against a real PostgreSQL (evidence-flywheel F17, plan §7, 2026-10-05): a delivery to a named
// account, a share link, the text-only rule, provenance that survives the recipient's edits, take-down, and what a share must earn
// before it may count for the platform.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { packCapsule } from "../src/capsuleContainer.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleShareLinks } from "../src/capsuleShareLinks.mjs";
import { resetCapsuleShareMetrics } from "../src/capsuleShareMetrics.mjs";
import { CapsuleSharing } from "../src/capsuleSharing.mjs";
import { createGuestInfluence, shareIsCorroborated } from "../src/capsuleShareTrust.mjs";
import { CapsuleTransferService, renderCapsuleTransferFiles } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createEvolutionLearningCoupling } from "../src/evolutionLearningCoupling.mjs";
import { LearningTriggers } from "../src/learningTriggers.mjs";
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
const DAY = 86_400_000;
const tag = randomUUID().slice(0, 8);
const author = `sh_author_${tag}`;
const alice = `sh_alice_${tag}`;
const bob = `sh_bob_${tag}`;
const carol = `sh_carol_${tag}`;
const dave = `sh_dave_${tag}`;
const subject = `sh_subject_${tag}`;
const everyone = [author, alice, bob, carol, dave, subject];
/** @type {any} */ let directory; /** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let capsules;
/** @type {any} */ let transfers; /** @type {any} */ let notifications; /** @type {any} */ let links; /** @type {any} */ let sharing;
let clock = Date.now();
const scans = [];

before(async () => {
  if (!url) return;
  directory = await mkdtemp("/tmp/evimed-share-int-");
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
  await database.query(`INSERT INTO evimed_control.users(id,name,auth_type) VALUES
    ($1,'李主任','development'),($2,'Alice Reader','development'),($3,'Bob Reader','development'),($4,'Carol Reader','development'),($5,'Dave Reader','development')`,
  [author, alice, bob, carol, dave]);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Subject Account','subject')", [subject]);
  documents = new ProductDocuments(database);
  // The scan's closed-set half runs for real; the double records that it ran, and when.
  const scanner = { scan: async (_who, entries) => { scans.push(entries.length); return { kept: entries.map((entry) => entry.id), dropped: [], checkedAt: new Date().toISOString(), model: "ok", unchecked: [], held: [], safety: [] }; } };
  capsules = new CapsuleService(documents, { scanner });
  transfers = new CapsuleTransferService({ documents, capsules, identities: new CapsuleIdentityStore(directory), dataDir: directory, scanner });
  notifications = new NotificationService(database);
  links = new CapsuleShareLinks({ database, ttlDays: 30, maxUses: 20, now: () => clock });
  sharing = new CapsuleSharing({ database, transfers, links, notifications, perDay: 50, now: () => clock });
});
after(async () => {
  if (database) {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [everyone]);
    await database.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** A capsule of the author's own with `contents` as approved methods. @param {string[]} contents */
async function authored(...contents) {
  const capsule = await capsules.create(author, { title: "我的记忆胶囊" });
  const entries = [];
  for (const content of contents) entries.push(await capsules.addEntry(author, capsule.id, { factKind: "method_preference", layer: "methods", content }));
  return { capsule, entries };
}
const shareNotices = async (userId) => (await notifications.list(userId, { limit: 50 })).items.filter((item) => item.source?.type === "share");
/** An imported copy enabled, as the recipient would. @param {string} userId @param {any} imported */
async function keep(userId, imported) { await capsules.enableReceived(userId, imported.id); return imported; }

test("a delivery to a named account is one share notice and imports without a file; an unknown name answers like a refusing one", options, async () => {
  resetCapsuleShareMetrics();
  const { capsule } = await authored("Meta 分析先报 GRADE 再报效应量。");
  // Unknown, ambiguous-by-nothing, a sign-in-less subject account and the sender themselves: one answer, in the same words.
  const unreachable = [];
  for (const ref of ["no-such-account-xyz", subject, author, "Subject Account"]) unreachable.push(await sharing.deliver(author, capsule.id, { recipients: [ref] }));
  assert.ok(unreachable.every((answer) => answer.delivered === 0 && answer.notDelivered === 1 && answer.snapshot === null));
  assert.deepEqual(unreachable[0], unreachable[1], "an unknown name is indistinguishable from an account that cannot receive");
  assert.equal((await transfers.history(author, capsule.id)).items.length, 0, "with nobody reachable nothing was exported");

  const delivered = await sharing.deliver(author, capsule.id, { recipients: [alice, "Bob Reader", "no-such-account-xyz"] });
  assert.equal(delivered.delivered, 2);
  assert.equal(delivered.notDelivered, 1);
  assert.equal(delivered.snapshot.channel, "delivery");
  assert.equal(JSON.stringify(delivered).includes("archive\""), false, "the sender is not handed a file either");

  const notices = await shareNotices(alice);
  assert.equal(notices.length, 1, "one share notice per delivery");
  assert.match(notices[0].title, /李主任/);
  assert.match(notices[0].body, /1 条做法/);
  assert.deepEqual(notices[0].actions.map((action) => action.id), ["open"]);
  assert.match(notices[0].source.id, /^delivery\/dlv_/);
  assert.equal((await shareNotices(carol)).length, 0);

  const deliveryId = notices[0].source.id.split("/")[1];
  await assert.rejects(sharing.open(carol, deliveryId), { code: "capsule_share_not_found" }, "another account's delivery is not found");
  const opened = await sharing.open(alice, deliveryId);
  assert.equal(opened.delivery.state, "opened");
  assert.equal(opened.delivery.sender.name, "李主任");
  assert.ok(!JSON.stringify(opened).includes(author), "the author's account id is shown to nobody");
  assert.deepEqual(opened.preview.entries.map((entry) => entry.content), ["Meta 分析先报 GRADE 再报效应量。"]);
  const scansBefore = scans.length;
  const imported = await sharing.import(alice, deliveryId, { expectedDigest: opened.preview.archiveSha256, title: "李主任的做法" });
  assert.ok(scans.length >= scansBefore, "the scan ran at the preview, before anything was written");
  assert.equal(imported.payload.share.channel, "delivery");
  assert.equal(imported.payload.share.authorId, author);
  assert.equal(imported.payload.share.authorName, "李主任");
  assert.equal(imported.payload.activationMode, "guest");
  assert.deepEqual((await capsules.active(alice)).items, [], "nothing is enabled by importing");
  await assert.rejects(sharing.import(alice, deliveryId, { expectedDigest: "0".repeat(64) }), { code: "capsule_preview_changed" });

  const sent = await sharing.sent(author, { capsuleId: capsule.id });
  const states = Object.fromEntries(sent.map((row) => [row.recipient.name, row.state]));
  assert.deepEqual(states, { "Alice Reader": "imported", "Bob Reader": "delivered" });

  const bobId = (await shareNotices(bob))[0].source.id.split("/")[1];
  assert.equal((await sharing.decline(bob, bobId)).state, "declined");
  assert.equal((await sharing.sent(author)).find((row) => row.recipient.name === "Bob Reader").state, "declined");
  await assert.rejects(sharing.import(bob, bobId, { expectedDigest: "0".repeat(64) }), { code: "capsule_share_delivery_closed" });
});

test("revoking a delivered snapshot says so to a recipient who has not taken it in, and the platform refuses further imports", options, async () => {
  const { capsule } = await authored("纳入标准先写成表格。");
  const made = await sharing.deliver(author, capsule.id, { recipients: [carol] });
  const deliveryId = (await shareNotices(carol))[0].source.id.split("/")[1];
  const snapshot = (await transfers.history(author, capsule.id)).items.find((item) => item.id === made.snapshot.id);
  await transfers.revoke(author, capsule.id, snapshot.id, snapshot.revision);
  await sharing.afterRevoke(author, snapshot.id);
  const notices = await shareNotices(carol);
  assert.ok(notices.some((item) => /撤回/.test(item.title)), "the notice says it was withdrawn");
  const after = await sharing.open(carol, deliveryId);
  assert.equal(after.delivery.state, "withdrawn");
  assert.equal(after.preview, null);
  await assert.rejects(sharing.import(carol, deliveryId, { expectedDigest: "0".repeat(64) }), { code: "capsule_share_delivery_closed" });
});

test("a share link is redeemed by an account until its expiry, its cap or its revocation, and stores no plaintext token", options, async () => {
  const { capsule } = await authored("先 PROSPERO 登记。");
  const made = await sharing.createLink(author, capsule.id, { maxUses: 2 });
  assert.match(made.token, /^[A-Za-z0-9_-]{32}$/, "192 bits, URL-safe");
  assert.equal(made.path, `/app/memory/shared/${made.token}`);
  const stored = JSON.stringify((await database.query("SELECT * FROM evimed_share.links WHERE owner_id=$1", [author])).rows)
    + JSON.stringify((await database.query("SELECT * FROM evimed_share.link_uses")).rows);
  assert.ok(!stored.includes(made.token), "only its hash is stored");

  await assert.rejects(sharing.openLink(alice, "short"), { code: "capsule_share_not_found" });
  await assert.rejects(sharing.openLink(alice, "A".repeat(32)), { code: "capsule_share_not_found" }, "an unknown token and a malformed one answer alike");
  const first = await sharing.openLink(alice, made.token);
  assert.equal(first.link.usesLeft, 1);
  assert.ok(!JSON.stringify(first).includes(author), "the owner's account id never reaches the redeemer");
  assert.equal(first.preview.card.author, "李主任");
  assert.equal((await sharing.openLink(alice, made.token)).link.usesLeft, 1, "a second look by the same account is not a second use");
  await sharing.openLink(bob, made.token);
  await assert.rejects(sharing.openLink(carol, made.token), { code: "capsule_share_link_exhausted" });

  const imported = await sharing.importLink(alice, made.token, { expectedDigest: first.preview.archiveSha256, title: "link pack" });
  assert.equal(imported.payload.share.channel, "link");
  const listed = (await links.list(author, { capsuleId: capsule.id }))[0];
  assert.equal(listed.uses, 2);
  assert.equal(listed.importedCount, 1);
  assert.equal(listed.state, "exhausted");

  const second = await sharing.createLink(author, capsule.id, {});
  clock += 31 * DAY;
  await assert.rejects(sharing.openLink(carol, second.token), { code: "capsule_share_link_expired" });
  clock -= 31 * DAY;
  const third = await sharing.createLink(author, capsule.id, {});
  await links.revoke(author, third.link.id);
  await assert.rejects(sharing.openLink(carol, third.token), { code: "capsule_share_link_revoked" });
  await assert.rejects(links.revoke(alice, third.link.id), { code: "capsule_share_not_found" }, "another account cannot revoke or see a link");
  assert.equal((await links.list(alice)).length, 0, "an account lists only its own links");
});

test("an archive that carries anything but the declared text entries is refused by name, before any key is derived", options, async () => {
  const { entries } = await authored("一条做法。");
  const identity = await new CapsuleIdentityStore(directory).forUser(author);
  const snapshotId = randomUUID();
  const entry = { id: randomUUID(), version: 1, factKind: "method_preference", layer: "methods", content: entries[0].payload.content, path: "", origin: "explicit" };
  entry.path = `methods/${entry.id}/SKILL.md`;
  entry.sha256 = (await import("node:crypto")).createHash("sha256").update(entry.content).digest("hex");
  const files = renderCapsuleTransferFiles(snapshotId, [entry]);
  /** @param {{ path: string, mime: string, content: string }[]} extra */
  const archive = async (extra) => {
    const container = await packCapsule({ capsuleId: snapshotId, version: 1, createdAt: new Date().toISOString(),
      issuer: { userId: identity.issuerId, signingKeyId: identity.signing.keyId, signingPrivateKey: identity.signing.privateKey },
      scope: ["workstyle"], layers: ["methods"], password: "test-only-share-passphrase",
      entries: [...Object.entries(files).map(([path, content]) => ({ path, content, mime: path.endsWith(".json") ? "application/json" : "text/markdown", layer: "methods" })), ...extra] });
    return JSON.stringify({ format: "evimedcap", version: 1, manifest: container.manifest, issuerPublicKey: identity.signing.publicKey,
      passwordWrap: container.passwordWrap.toString("base64"), payload: Object.fromEntries(Object.entries(container.payload).map(([name, bytes]) => [name, bytes.toString("base64")])) });
  };
  const preview = (extra) => archive(extra).then((text) => transfers.preview(alice, { archive: text, password: "test-only-share-passphrase" }));
  // Entries the container's own share scope would let through, and the share still refuses: an executable under a method, a file
  // that is not one of the five a pack is made of, a method's extra file, a tool definition kept as JSON.
  const method = randomUUID();
  for (const extra of [
    [{ path: `methods/${method}/scripts/a.py`, mime: "text/x-python", content: "print(1)", layer: "methods" }],
    [{ path: `methods/${method}/notes.md`, mime: "text/markdown", content: "a second file in a method", layer: "methods" }],
    [{ path: "exemplars/attachment.md", mime: "text/markdown", content: "an attachment named like text", layer: "methods" }],
    [{ path: "lessons.jsonl", mime: "application/x-ndjson", content: "{\"tool\":\"search\"}\n", layer: "methods" }],
  ]) await assert.rejects(preview(extra), { code: "capsule_share_not_text_only" }, extra[0].path);
  const clean = await archive([]);
  // Not hosted by anyone here, so nothing could be imported from it — but it is read, which is the point: no refusal by name.
  const read = await transfers.preview(alice, { archive: clean, password: "test-only-share-passphrase" });
  assert.equal(read.canImport, false);
  assert.equal(read.snapshotId, snapshotId, "the same pack without the extra entry is read, not refused");
});

test("a shared entry keeps its provenance through the recipient's edits, is labelled in recall, and is never re-shared as the recipient's own", options, async () => {
  const { capsule } = await authored("双人独立筛选文献，分歧交第三人裁决。");
  const made = await sharing.deliver(author, capsule.id, { recipients: [dave] });
  const deliveryId = (await shareNotices(dave))[0].source.id.split("/")[1];
  const opened = await sharing.open(dave, deliveryId);
  const imported = await sharing.import(dave, deliveryId, { expectedDigest: opened.preview.archiveSha256, title: "筛选做法" });
  await keep(dave, imported);
  const fact = (await capsules.entries(dave, imported.id)).items[0];
  assert.deepEqual(Object.keys(fact.payload.share).sort(), ["authorId", "authorName", "channel", "sharedAt", "snapshotHash"]);
  assert.equal(fact.payload.share.snapshotHash, made.snapshot.manifestSha256);

  const recalled = await capsules.recall(dave, { query: "文献" });
  const hit = recalled.items.find((item) => item.id === fact.id);
  assert.equal(hit.label, "来自 李主任 的分享");
  assert.equal(hit.sharedFrom.channel, "delivery");
  assert.equal(hit.contextOnly, true);
  assert.notEqual(hit.origin, "explicit", "never promoted to something the recipient said");

  // The recipient's own wording is a new entry of their own capsule; the shared one is untouched and keeps its provenance.
  const edited = await capsules.updateEntry(dave, imported.id, fact.id, { content: "我自己的版本：双人筛选。", expectedRevision: fact.revision });
  assert.notEqual(edited.id, fact.id);
  assert.equal(edited.payload.origin, "explicit");
  assert.equal(edited.payload.adaptedFrom.entryId, fact.id);
  assert.equal(edited.payload.share, undefined, "the adaptation is the recipient's own and claims no author");
  const original = await capsules.documents.get(dave, "fact", fact.id);
  assert.equal(original.payload.content, "双人独立筛选文献，分歧交第三人裁决。");
  assert.equal(original.payload.share.authorName, "李主任");
  // A status change is still theirs to make, and leaves the provenance as it was.
  const retired = await capsules.updateEntry(dave, imported.id, fact.id, { status: "retired", expectedRevision: original.revision });
  assert.equal(retired.payload.share.authorId, author);

  await assert.rejects(transfers.export(dave, imported.id, { password: "test-only-share-passphrase" }), { code: "capsule_share_not_own" });
  const own = await capsules.ownCapsule(dave, { create: true });
  const preview = await transfers.exportPreview(dave, own.id, {});
  assert.deepEqual(preview.entries.map((entry) => entry.content), ["我自己的版本：双人筛选。"], "what came by a share does not leave again under this account's name");
});

test("an author's take-down of one snapshot disables every recipient's copy and tells each why; the operator's reaches all an author shared", options, async () => {
  resetCapsuleShareMetrics();
  const { capsule } = await authored("先看撤稿再引用。");
  const toBoth = await sharing.deliver(author, capsule.id, { recipients: [alice, bob] });
  const take = async (userId) => {
    const notice = (await shareNotices(userId)).find((item) => /delivery\//.test(item.source.id) && /先看撤稿|分享了/.test(`${item.title}${item.body}`));
    const id = notice.source.id.split("/")[1];
    const opened = await sharing.open(userId, id);
    return keep(userId, await sharing.import(userId, id, { expectedDigest: opened.preview.archiveSha256, title: "撤稿做法" }));
  };
  const aliceCopy = await take(alice);
  const bobCopy = await take(bob);
  assert.ok((await capsules.active(alice)).items.some((item) => item.capsuleId === aliceCopy.id), "in force before the take-down");
  const result = await sharing.takeDown({ authorId: author, snapshotId: toBoth.snapshot.id, by: "author", reason: "这条做法有误" });
  assert.equal(result.copies, 2);
  for (const [userId, copy] of [[alice, aliceCopy], [bob, bobCopy]]) {
    assert.ok(!(await capsules.active(userId)).items.some((item) => item.capsuleId === copy.id), "out of every list");
    await assert.rejects(capsules.enableReceived(userId, copy.id), { code: "capsule_pack_taken_down" });
    await assert.rejects(capsules.prepareTrial(userId, copy.id, {}), { code: "capsule_pack_taken_down" });
    const told = (await shareNotices(userId)).find((item) => /下架/.test(item.title));
    assert.match(told.body, /这条做法有误/, "one sentence saying why");
    assert.equal((await capsules.recall(userId, { query: "撤稿", projectId: null })).items.length, 0, "nothing of it is recalled");
  }
  assert.equal((await capsules.received(alice)).find((pack) => pack.id === aliceCopy.id).takenDown.by, "author");
  await assert.rejects(transfers.snapshotArchive(author, toBoth.snapshot.id), { code: "capsule_snapshot_revoked" });
  assert.equal((await sharing.takeDown({ authorId: author, snapshotId: toBoth.snapshot.id, by: "author" })).copies, 0, "idempotent");

  const other = await authored("第二套做法。");
  const one = await sharing.deliver(author, other.capsule.id, { recipients: [carol] });
  const wide = await sharing.takeDown({ authorId: author, by: "operator", reason: "平台复核后下架" });
  assert.ok(wide.snapshots >= 2);
  const operatorNotice = (await shareNotices(carol)).find((item) => /平台/.test(item.title));
  assert.ok(operatorNotice, "a delivery nobody opened is withdrawn with a notice naming who took it down");
  await assert.rejects(transfers.snapshotArchive(author, one.snapshot.id), { code: "capsule_snapshot_revoked" });
});

test("a share is corroborated only by other accounts that kept it enabled for the period without disabling it", options, async () => {
  const { capsule } = await authored("只有被独立采用过的做法才算数。");
  const made = await sharing.deliver(author, capsule.id, { recipients: [alice, bob, carol, dave] });
  const hash = made.snapshot.manifestSha256;
  const days = 14;
  const at = (offset) => ({ database, minAccounts: 3, keptDays: days, now: () => Date.now() + offset * DAY });
  /** @type {any[]} */ const copies = [];
  for (const userId of [alice, bob, carol]) {
    const notice = (await shareNotices(userId)).find((item) => item.source.id.startsWith("delivery/"));
    const id = notice.source.id.split("/")[1];
    const opened = await sharing.open(userId, id);
    copies.push([userId, await sharing.import(userId, id, { expectedDigest: opened.preview.archiveSha256, title: "x" })]);
  }
  assert.equal(await shareIsCorroborated({ authorId: author, snapshotHash: hash }, at(30)), false, "imported and left is not kept");
  for (const [userId, copy] of copies.slice(0, 2)) await capsules.enableReceived(userId, copy.id);
  assert.equal(await shareIsCorroborated({ authorId: author, snapshotHash: hash }, at(30)), false, "two accounts are not three");
  await capsules.enableReceived(copies[2][0], copies[2][1].id);
  assert.equal(await shareIsCorroborated({ authorId: author, snapshotHash: hash }, at(1)), false, "not for long enough");
  assert.equal(await shareIsCorroborated({ authorId: author, snapshotHash: hash }, at(15)), true);
  assert.equal(await shareIsCorroborated({ authorId: alice, snapshotHash: hash }, at(15)), false, "named by its author");
  assert.equal(await shareIsCorroborated({ authorId: author, snapshotHash: "0".repeat(64) }, at(15)), false, "named by its snapshot");
  assert.equal(await shareIsCorroborated({ authorId: null, snapshotHash: hash }, at(15)), false, "a pack with no verified author cannot be vouched for");
  await capsules.disable(copies[2][0], copies[2][1].id);
  assert.equal(await shareIsCorroborated({ authorId: author, snapshotHash: hash }, at(15)), false, "disabling it takes the account's keeping away");

  // The same pack, enabled again by that account, starts its period over.
  await capsules.enableReceived(copies[2][0], copies[2][1].id);
  assert.equal(await shareIsCorroborated({ authorId: author, snapshotHash: hash }, at(1)), false);
  assert.equal(await shareIsCorroborated({ authorId: author, snapshotHash: hash }, at(15)), true);
});

test("a run that used an uncorroborated guest capsule still learns for its own account, and reaches no platform signal; a corroborated one does", options, async () => {
  const { capsule } = await authored("引导运行的做法。");
  const made = await sharing.deliver(author, capsule.id, { recipients: [alice, bob] });
  /** @param {string} userId */
  const takeIn = async (userId) => {
    const notice = (await shareNotices(userId)).find((item) => item.source.id.startsWith("delivery/") && item.body.includes("引导") === false && item.createdAt >= new Date(Date.now() - 60_000).toISOString());
    const id = notice.source.id.split("/")[1];
    const opened = await sharing.open(userId, id);
    const copy = await sharing.import(userId, id, { expectedDigest: opened.preview.archiveSha256, title: "引导" });
    await capsules.enableReceived(userId, copy.id);
    return copy;
  };
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Share test',1048576) ON CONFLICT DO NOTHING", [alice]);
  const copy = await takeIn(alice);
  await takeIn(bob);
  const factId = (await capsules.entries(alice, copy.id)).items[0].id;
  const queued = [];
  const project = { id: "default", userId: alice };
  const finished = (runId, extra = {}) => ({ id: runId, sessionId: `s-${runId}`, status: "succeeded", effectiveAgentId: "clinical-evidence-synthesis", artifacts: ["d/report.md"],
    transcript: { completeness: "complete" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...extra });
  const recalled = [{ id: `capsule:${factId}`, kind: "method_preference", scope: "capsule" }];
  /** One other account is enough to vouch here; the period is what separates the two moments. */
  const audited = [];
  const triggersAt = (offset) => new LearningTriggers({ jobs: { enqueue: async (_user, _kind, payload) => queued.push(payload) }, agentRuns: { list: async () => [], runWorkflowProjection: async () => null },
    audit: async (event, detail) => audited.push([event, detail.code]),
    guestInfluence: createGuestInfluence({ database, documents, minAccounts: 1, keptDays: 14, now: () => Date.now() + offset * DAY }) });
  const [guestA, guestB, vouchedA, vouchedB] = ["g1", "g2", "v1", "v2"].map((name) => finished(`run_${name}_${tag}`, { recalledMemories: recalled }));
  const early = await triggersAt(0).afterRun(project, { ...guestA });
  await triggersAt(0).afterRun(project, { ...guestB });
  assert.deepEqual(early.queued, ["delivered"], "the run still learns for its own account");
  assert.equal(early.guestInfluence, "uncorroborated", JSON.stringify(audited));
  assert.equal(queued[0].guestInfluence.uncorroborated, true);
  assert.ok(await documents.get(alice, "preferences", `guest-run:${guestA.id}`), "the run is marked");
  const late = await triggersAt(15).afterRun(project, { ...vouchedA });
  await triggersAt(15).afterRun(project, { ...vouchedB });
  assert.deepEqual(late.queued, ["delivered"]);
  assert.equal(late.guestInfluence, undefined, "another account has kept this snapshot for the period: the run is as any run");
  assert.equal(await documents.get(alice, "preferences", `guest-run:${vouchedA.id}`), null);
  assert.equal(queued.at(-1).guestInfluence, undefined);
  assert.equal((await triggersAt(0).afterRun(project, finished(`run_n1_${tag}`, { recalledMemories: [] }))).guestInfluence, undefined, "a run that used no guest capsule is as it always was");
  assert.equal(made.snapshot.channel, "delivery");

  // Observations of marked runs do not count towards a platform lead; the same observations of runs that were not marked do.
  const book = (name, runIds) => documents.put(alice, "method", `book-${name}-${tag}`, { recordType: "capability-handbook", status: "active", capabilityId: name, contentDigest: "d",
    observations: runIds.map((runId) => ({ runId, used: true, gapCodes: ["method-missing"] })) }, { expectedRevision: 0 });
  await book("guestgap", [guestA.id, guestB.id]);
  await book("vouchedgap", [vouchedA.id, vouchedB.id]);
  const events = [];
  await createEvolutionLearningCoupling({ service: { ingestEvent: async (event) => events.push(event) }, database }).scan();
  const mine = events.filter((event) => event.userId === alice);
  assert.ok(mine.some((event) => event.id.includes(`book-vouchedgap-${tag}`)), "runs that used a corroborated pack make a lead");
  assert.ok(!mine.some((event) => event.id.includes(`book-guestgap-${tag}`)), "runs that used an uncorroborated one make none");
});
