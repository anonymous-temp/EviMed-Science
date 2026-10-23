// The whole sharing path with two real accounts against a real PostgreSQL (memory-capsule rectification T4.4, 2026-10-23; the build
// spec's §15 steps 6 and 7): A previews what would leave and sends it, B previews, tries it once, enables it, and B's next
// conversation carries A's way of working; B disables it and the next conversation does not; A sends a newer version and B takes
// it in place. Each step is read from what the platform hands a runtime — the methods it mounts, the opening block of a native
// account, what the memory gateway's search finds — not from the rows the steps wrote.
//
// The controller repeats it live with two accounts on production.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { createNativeCapsuleSearch } from "../src/capsuleGateway.mjs";
import { materializeCapsuleMethods } from "../src/capsuleMethods.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleShareLinks } from "../src/capsuleShareLinks.mjs";
import { CapsuleSharing } from "../src/capsuleSharing.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { capsuleSearchText } from "../src/memoryGateway.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ResidentProfiles } from "../src/residentProfile.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const tag = randomUUID().slice(0, 8);
const A = `ta_ada_${tag}`;
const B = `ta_bo_${tag}`;
const PROJECT = "work";
const WIRE_ACCOUNT = { id: B, accountCreatedAt: "2026-01-01T00:00:00Z" };
/** @type {any} */ let directory; /** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let capsules;
/** @type {any} */ let transfers; /** @type {any} */ let sharing;
/** What the runtimes were told about the packs in force. @type {any[]} */
const told = [];

before(async () => {
  if (!url) return;
  directory = await mkdtemp("/tmp/evimed-two-accounts-");
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$3,'development'),($2,$4,'development')", [A, B, `Ada ${tag}`, `Bo ${tag}`]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$3,'Work',1048576),($2,$3,'Work',1048576)", [A, B, PROJECT]);
  documents = new ProductDocuments(database);
  // The closed sets run for real; the model's half answers "not an instruction" for everything.
  const scanner = { scan: async (_who, entries) => ({ kept: entries.map((entry) => entry.id), dropped: [], checkedAt: new Date().toISOString(), model: "ok", unchecked: [], held: [], safety: [] }) };
  capsules = new CapsuleService(documents, { scanner, onActivationChanged: async (change) => { told.push(change); } });
  transfers = new CapsuleTransferService({ documents, capsules, identities: new CapsuleIdentityStore(directory), dataDir: directory, scanner,
    memoryEngine: async () => "legacy" });
  sharing = new CapsuleSharing({ database, transfers, links: new CapsuleShareLinks({ database, ttlDays: 30, maxUses: 20 }),
    notifications: new NotificationService(database), perDay: 100 });
});
after(async () => {
  if (database) {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[A, B]]);
    await database.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** A's learned method, as the learning loop leaves one approved. */
async function learnedMethod(body) {
  return documents.put(A, "method", randomUUID(), { recordType: "learned-method", status: "approved",
    frontmatter: { name: "meta-heterogeneity-first", description: "Check heterogeneity before pooling.", whenToUse: "Any pooled estimate" },
    display: { title: "合并前先看异质性", summary: "先报 I²，再决定能不能合并" }, body, provenance: {} }, { expectedRevision: 0 });
}

/** A native account's opening block, for a conversation in the project. */
const opening = () => new ResidentProfiles({ config: {}, store: /** @type {any} */ ({
  async memoryEngine() { return "native"; },
  async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
  async sessionState() { return { trialCapsuleId: null }; },
  async residentRecords() { throw new Error("a native account's records are the engine's"); },
  async lookupCounts() { throw new Error("a native account's records are the engine's"); },
  async residentState() { return { digest: null, compactedSince: false }; },
  async noteResidentDelivered() {},
}), capsules }).forDispatch(B, { projectId: PROJECT, sessionId: "ses_b", attended: true });

/** What B's gateway search finds for a native conversation. @param {string} query */
const search = async (query) => capsuleSearchText(await createNativeCapsuleSearch({ service: capsules })({ user: WIRE_ACCOUNT, project: { id: PROJECT }, query, limit: 8 }));

/** What the runtime of B's project would mount for the next conversation: the methods' files and what they carry. */
async function mounted(label) {
  const rootDir = path.join(directory, `runtime-${label}`);
  const result = await materializeCapsuleMethods({ capsules, learning: null, project: { rootDir, userId: B, id: PROJECT }, directory: path.join(rootDir, "capsule-methods") });
  const files = await Promise.all(result.capsule.map((method) => readFile(path.join(rootDir, "capsule-methods", method.directoryName, "SKILL.md"), "utf8")));
  return { count: result.count, kinds: result.capsule.map((method) => method.factKind).sort(), text: files.join("\n") };
}

test("two accounts, end to end: preview, send, receive, try once, enable, B's conversation carries A's way of working, disable, a newer version in place", options, async () => {
  // ---- A: a method it learned, preferences it said, and what must not leave. -------------------------------------------------
  await learnedMethod("合并之前先报告 I² 和预测区间；I² 超过 50% 先找原因再谈合并。");
  await database.query(`INSERT INTO evimed_memory.records(id,user_id,scope,scope_id,kind,key,value,summary,status,origin,confidence,importance,version)
    VALUES($1,$3,'user','','preference','tables','表格一律放在正文里，不放附录','','active','explicit',1,0.5,1),
      ($2,$3,'user','','preference','inferred-one','助手以为对方喜欢长段落','','active','inferred',0.6,0.5,1)`, [`tr_${tag}_1`, `tr_${tag}_2`, A]);
  const own = await capsules.ownCapsule(A, { create: true });
  await capsules.note(A, PROJECT, { factKind: "preference", content: "助手猜对方喜欢先给结论" });
  await documents.put(A, "fact", randomUUID(), { capsuleId: own.id, factKind: "preference", layer: "sources", content: "资料里写的偏好：一律用 APA。",
    origin: "inferred", status: "approved", sourceId: `src_${"b".repeat(32)}`, projectId: PROJECT, contextOnly: true, provenance: [] }, { expectedRevision: 0 });

  const preview = await transfers.exportPreview(A, own.id, { scopes: ["workstyle"] });
  assert.deepEqual(preview.entries.map((entry) => entry.content).sort(),
    [preview.entries.find((entry) => entry.factKind === "method_preference").content, "表格一律放在正文里，不放附录"].sort());
  assert.ok(preview.entries.some((entry) => /合并之前先报告 I²/.test(entry.content)), "A's method");
  assert.ok(!preview.entries.some((entry) => /猜|以为|APA|资料里/.test(entry.content)), "nothing inferred, nothing from a document");
  assert.deepEqual(preview.excluded.map((item) => item.reason).sort(), ["document", "inferred"], "and the preview says why, in plain sentences");

  // ---- A sends it; B reads it, tries it once, enables it. ----------------------------------------------------------------------
  const sent = await sharing.deliver(A, own.id, { recipients: [B], scopes: ["workstyle"], card: { title: "Ada 的工作方式", summary: "合并前先看异质性；表格放正文" } });
  assert.equal(sent.delivered, 1);
  const waiting = (await sharing.pending(B))[0];
  assert.equal(waiting.card.title, "Ada 的工作方式");
  const opened = await sharing.open(B, waiting.id);
  assert.deepEqual(opened.preview.entries.map((entry) => entry.content).sort(), preview.entries.map((entry) => entry.content).sort(), "what B reads is what A saw");
  const pack = await sharing.import(B, waiting.id, { expectedDigest: opened.preview.archiveSha256, title: "Ada 的工作方式" });
  assert.deepEqual((await capsules.active(B, PROJECT)).items, [], "nothing is in force by importing");
  assert.deepEqual((await mounted("before")).count, 0);

  // A trial: the pack as context, writing nothing of B's.
  const before = Number((await database.query("SELECT (SELECT count(*) FROM evimed_memory.records WHERE user_id=$1) + (SELECT count(*) FROM evimed_product.documents WHERE user_id=$1 AND kind='fact' AND payload->>'capsuleId' <> $2) AS n", [B, pack.id])).rows[0].n);
  await capsules.prepareTrial(B, pack.id, { projectId: PROJECT });
  const context = await capsules.trialContext(B, pack.id);
  assert.match(context, /合并之前先报告 I²/);
  assert.match(context, /表格一律放在正文里/);
  const after = Number((await database.query("SELECT (SELECT count(*) FROM evimed_memory.records WHERE user_id=$1) + (SELECT count(*) FROM evimed_product.documents WHERE user_id=$1 AND kind='fact' AND payload->>'capsuleId' <> $2) AS n", [B, pack.id])).rows[0].n);
  assert.equal(after, before, "a trial writes nothing into B's own memory");

  told.length = 0;
  await capsules.enableReceived(B, pack.id, { projectId: PROJECT });
  assert.deepEqual(told, [{ userId: B, projectId: null, capsuleId: pack.id, change: "enabled" }], "the runtimes that are up are told at once");

  // ---- B's next conversation carries A's way of working. -----------------------------------------------------------------------
  const carried = await mounted("enabled");
  assert.equal(carried.count, 2, "the method and the preference");
  assert.deepEqual(carried.kinds, ["method_preference", "preference"]);
  assert.match(carried.text, /合并之前先报告 I²/);
  assert.match(carried.text, /表格一律放在正文里/);
  assert.match(carried.text, /来自 Ada .* 的分享|Ada 的工作方式|Ada/, "the sender is named in the mounted method's own label");
  // A native account's search finds the same entries, labelled as a reference; the opening block has none of A's identity.
  assert.match(await search("表格") ?? "", /表格一律放在正文里/);
  assert.match(await search("表格") ?? "", /参考胶囊《Ada 的工作方式》/);
  const block = await opening();
  assert.doesNotMatch(block.text ?? "", /Ada|表格一律|I²/, "a guest brings methods and standards, never an identity");

  // ---- B disables it: the next conversation does not carry it. -----------------------------------------------------------------
  told.length = 0;
  await capsules.disable(B, pack.id);
  assert.deepEqual(told.map((item) => item.change), ["disabled"]);
  assert.equal((await mounted("disabled")).count, 0, "the mounted methods leave");
  assert.equal(await search("表格"), null, "nothing of the pack is found");

  // ---- A sends a newer version (and now says something about itself); B takes it in place. -------------------------------------
  await database.query(`INSERT INTO evimed_memory.records(id,user_id,scope,scope_id,kind,key,value,summary,status,origin,confidence,importance,version)
    VALUES($1,$2,'user','','profile','role','临床流行病学家，做系统综述','','active','explicit',1,0.5,1)`, [`tr_${tag}_3`, A]);
  const second = await sharing.deliver(A, own.id, { recipients: [B], scopes: ["workstyle", "+profile"] });
  assert.equal(second.snapshot.supersedes, sent.snapshot.id, "the next version of what B took in");
  const next = (await sharing.pending(B)).find((item) => item.snapshotId === second.snapshot.id);
  const nextOpened = await sharing.open(B, next.id);
  assert.equal(nextOpened.preview.upgrades.capsuleId, pack.id);
  assert.equal(nextOpened.preview.card.changelog, "新增 1 条、保留 2 条");
  const upgraded = await sharing.import(B, next.id, { expectedDigest: nextOpened.preview.archiveSha256 });
  assert.equal(upgraded.id, pack.id, "the same capsule, in place");
  assert.equal((await capsules.received(B)).length, 1);
  assert.equal((await capsules.received(B))[0].enabled, false, "an upgrade does not turn a disabled pack on");

  told.length = 0;
  await capsules.enableReceived(B, pack.id);
  assert.equal(told.length, 1);
  const again = await mounted("upgraded");
  assert.equal(again.count, 2, "the profile line is context, not a mounted method");
  assert.match(await search("系统综述") ?? "", /临床流行病学家/, "the new profile line is found by a native conversation's search, labelled as a reference");
  assert.doesNotMatch((await opening()).text ?? "", /临床流行病学家/, "and is still not B's own identity");
});
