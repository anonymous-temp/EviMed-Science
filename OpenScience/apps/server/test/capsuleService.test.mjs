// The capsule service against an in-memory document store — the rules that do
// not need PostgreSQL to be decided. The integration suite holds the real store.
import assert from "node:assert/strict";
import test from "node:test";

import { CapsuleService } from "../src/capsuleService.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const USER = "user_1";

test("a capsule is used as one's own or as a reference; 合并参考 is stored and read as a reference", async () => {
  // Nothing ever told `blend` apart from `guest` — every reader asks only
  // "own or not" — so the page offers two (2026-09-19 plan §3.3 #4).
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const mine = await service.create(USER, { title: "我的记忆胶囊" });
  const theirs = await service.create(USER, { title: "李主任的工作方式" });
  await service.activate(USER, mine.id, { mode: "own" });
  await service.activate(USER, theirs.id, { mode: "blend" });
  const stored = [...documents.rows.values()].find((row) => row.kind === "preferences");
  assert.deepEqual(stored.payload.items.map((item) => item.mode), ["own", "guest"], "a request for blend is stored as what it meant");

  // An activation written before the change still says `blend`; no migration.
  stored.payload.items = [{ capsuleId: mine.id, mode: "own" }, { capsuleId: theirs.id, mode: "blend" }];
  const { items } = await service.active(USER);
  assert.deepEqual(items.map((item) => item.mode), ["own", "guest"]);
  // A mode this build does not know contributes as a reference, never as an identity.
  stored.payload.items = [{ capsuleId: theirs.id, mode: "merged-v3" }];
  assert.deepEqual((await service.active(USER)).items.map((item) => item.mode), ["guest"]);

  await assert.rejects(service.activate(USER, mine.id, { mode: "merged-v3" }), { code: "capsule_payload_invalid" });
});

test("a reference capsule's facts are recalled as a reference, and never render as the researcher's own profile", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const theirs = await service.create(USER, { title: "李主任的工作方式" });
  await service.addEntry(USER, theirs.id, { factKind: "profile", layer: "profile", content: "心内科主任，二十年临床经验" });
  await service.addEntry(USER, theirs.id, { factKind: "method_preference", layer: "methods", content: "超说明书用药先查说明书修订史" });
  // Stored the old way.
  await documents.put(USER, "preferences", "active-capsules:account", { items: [{ capsuleId: theirs.id, mode: "blend" }] }, { expectedRevision: 0 });

  const recalled = await service.recall(USER, { query: "说明书" });
  assert.deepEqual(recalled.items.map((item) => item.mode), ["guest"]);
  assert.deepEqual(await service.profileFacts(USER, null, ["profile"]), [], "someone else's identity is never presented as yours");
});

test("a runtime note takes effect at once as the assistant's note, and is never mounted as a method", async () => {
  const { selectCapsuleMethods } = await import("../src/capsuleMethods.mjs");
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const note = await service.note(USER, "project_1", { factKind: "method_preference", content: "做 meta 分析先查异质性" });
  assert.equal(note.payload.status, "approved", "no confirmation step");
  assert.equal(note.payload.origin, "inferred", "labelled as what it is: the assistant's wording");
  const recalled = await service.recall(USER, { query: "异质性", projectId: "project_1" });
  assert.deepEqual(recalled.items.map((item) => item.id), [note.id], "in force as context at once");
  // A page the run read can talk a model into writing a note; mounted, it would
  // be an instruction in every later run.
  assert.deepEqual(await selectCapsuleMethods(service, { userId: USER, projectId: "project_1" }), []);
  // What the researcher wrote themselves does mount.
  const own = (await service.active(USER, "project_1")).items[0].capsuleId;
  await service.addEntry(USER, own, { factKind: "method_preference", layer: "methods", content: "先查异质性再合并" });
  assert.deepEqual((await selectCapsuleMethods(service, { userId: USER, projectId: "project_1" })).map((method) => method.content),
    ["先查异质性再合并"]);
  // A writer that is not the platform — an external agent — waits for the owner.
  const external = await service.note(USER, "project_1", { factKind: "preference", content: "回答用英文", review: true });
  assert.equal(external.payload.status, "candidate");
  assert.equal(external.payload.origin, "inferred");
});

test("a retraction retires what nobody touched, and only annotates what the researcher changed", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const untouched = await service.note(USER, "project_1", { factKind: "decision", content: "已采纳：A 结论" });
  const retracted = await service.retractNote(USER, untouched.id, { reason: "独立复核未能复现" });
  assert.equal(retracted.payload.status, "retired");

  const curated = await service.note(USER, "project_1", { factKind: "decision", content: "已采纳：B 结论" });
  const corrected = await service.updateEntry(USER, curated.payload.capsuleId, curated.id,
    { content: "已采纳：B 结论（限老年人群）", expectedRevision: curated.revision });
  const kept = await service.retractNote(USER, corrected.id, { reason: "独立复核未能复现" });
  assert.equal(kept.payload.status, "approved", "an entry the researcher corrected is theirs");
  assert.equal(kept.payload.retracted.reason, "独立复核未能复现");
});

test("one click undoes an entry's last change, and undoing its creation removes it", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const capsule = await service.create(USER, { title: "我的记忆胶囊" });
  const entry = await service.addEntry(USER, capsule.id, { factKind: "preference", layer: "profile", content: "结论先行" });
  const edited = await service.updateEntry(USER, capsule.id, entry.id, { content: "结论先行，再给证据表", expectedRevision: entry.revision });
  const undone = await service.undoEntry(USER, capsule.id, entry.id, { expectedRevision: edited.revision });
  assert.equal(undone.undone, "restored");
  assert.equal(undone.entry.payload.content, "结论先行");
  assert.equal(undone.entry.revision, edited.revision + 1, "saved forward: the undo is itself a revision");
  await assert.rejects(service.undoEntry(USER, capsule.id, entry.id, { expectedRevision: edited.revision }), { code: "product_revision_conflict" });

  const fresh = await service.addEntry(USER, capsule.id, { factKind: "preference", layer: "profile", content: "表格优先" });
  const removed = await service.undoEntry(USER, capsule.id, fresh.id, { expectedRevision: fresh.revision });
  assert.equal(removed.undone, "removed");
  assert.equal(await documents.get(USER, "fact", fresh.id), null, "gone from use, and still in the trash to restore");
});

test("「我的记忆胶囊」 is one capsule per person: made once, in force account-wide, borrowed ones kept", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  assert.equal(await service.ownCapsule(USER), null, "reading does not make one");
  const theirs = await service.create(USER, { title: "李主任的工作方式" });
  await documents.put(USER, "capsule", theirs.id, { ...theirs.payload, imported: true }, { expectedRevision: theirs.revision });
  await service.activate(USER, theirs.id, { mode: "guest" });

  const [first, second] = await Promise.all([service.ownCapsule(USER, { create: true }), service.ownCapsule(USER, { create: true })]);
  assert.equal(first.id, second.id, "two first visits are one capsule");
  assert.equal(first.payload.title, "我的记忆胶囊");
  const active = await service.active(USER, null);
  assert.deepEqual(active.items.map((item) => [item.capsuleId, item.mode]), [[first.id, "own"], [theirs.id, "guest"]]);

  // In the trash, it comes back rather than being made twice.
  await service.remove(USER, first.id, (await service.get(USER, first.id)).revision);
  const back = await service.ownCapsule(USER, { create: true });
  assert.equal(back.id, first.id);
  assert.equal(back.deletedAt, null);

  // Read as one: the account capsule and each project's notes, never the borrowed.
  await service.addEntry(USER, first.id, { factKind: "method_preference", layer: "methods", content: "先查异质性再合并" });
  const noted = await service.note(USER, "project_1", { factKind: "project_fact", content: "队列 500 人" });
  const retired = await service.addEntry(USER, first.id, { factKind: "preference", content: "旧偏好" });
  await service.updateEntry(USER, first.id, retired.id, { status: "retired", expectedRevision: retired.revision });
  await service.addEntry(USER, theirs.id, { factKind: "preference", content: "别人的偏好" });
  const mine = await service.mine(USER);
  assert.equal(mine.capsule.id, first.id);
  assert.deepEqual(mine.entries.map((entry) => entry.payload.content).sort(), ["先查异质性再合并", "队列 500 人"]);
  assert.ok(mine.capsules.every((capsule) => capsule.id !== theirs.id));
  assert.equal(mine.entries.find((entry) => entry.id === noted.id).projectId, "project_1");
});
