// One capsule per person (2026-10-24): the per-project notes capsules and the per-project lists of packs an earlier release made are
// folded into the account's capsule — against the in-memory store, the rules that do not need PostgreSQL. The integration suite
// (`capsuleOneCapsule.integration.test.mjs`) holds the real store, the recall index's outbox and a project's deletion.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { foldIntoOneCapsule } from "../src/capsuleOneCapsule.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const USER = "user_1";
const sha = (/** @type {unknown} */ value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A project's notes capsule and one note in it, as the release before wrote them. */
async function legacyNote(documents, projectId, content, { status = "approved", factKind = "preference" } = {}) {
  const capsuleId = `runtime-notes:${createHash("sha256").update(projectId).digest("hex")}`;
  if (!await documents.get(USER, "capsule", capsuleId)) {
    await documents.put(USER, "capsule", capsuleId, { title: "项目笔记", description: "这个项目的研究运行记下的内容。", imported: false, activationMode: "own" }, { expectedRevision: 0, projectId });
  }
  return documents.put(USER, "fact", `runtime-note:${sha([capsuleId, factKind, content])}`, { capsuleId, factKind, layer: "knowledge", content, origin: "inferred", status,
    provenance: [{ type: "source", id: `runtime-project:${projectId}` }], contextOnly: true }, { expectedRevision: 0, projectId });
}

/** A received pack, enabled since `keptSince`. */
async function pack(documents, id, keptSince) {
  return documents.put(USER, "capsule", id, { title: `包 ${id}`, description: "", imported: true, activationMode: "guest", ...(keptSince ? { keptSince } : {}),
    transfer: { issuerTrust: "verified" } }, { expectedRevision: 0 });
}

const projectList = (documents, projectId, items) => documents.put(USER, "preferences", `active-capsules:project:${projectId}`, { items }, { expectedRevision: 0, projectId });
const snapshot = (documents) => JSON.stringify([...documents.rows.entries()]);

test("the notes capsules become labelled entries of the account's capsule, the lists of packs one list, and nothing is lost on the way", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const first = await legacyNote(documents, "project_1", "回答先给结论");
  const forgotten = await legacyNote(documents, "project_1", "旧偏好", { status: "retired" });
  const second = await legacyNote(documents, "project_2", "表格优先", { factKind: "method_preference" });
  const trashed = await legacyNote(documents, "project_3", "我删掉的笔记");
  const trash = await documents.get(USER, "capsule", trashed.payload.capsuleId);
  await documents.remove(USER, "capsule", trash.id, trash.revision);
  await pack(documents, "pack-a", "2026-10-02T00:00:00.000Z");
  await pack(documents, "pack-b", "2026-10-03T00:00:00.000Z");
  await pack(documents, "pack-c", "2026-10-01T00:00:00.000Z");
  await documents.put(USER, "preferences", "active-capsules:account", { items: [{ capsuleId: "pack-c", mode: "guest" }] }, { expectedRevision: 0 });
  await projectList(documents, "project_1", [{ capsuleId: first.payload.capsuleId, mode: "own" }, { capsuleId: "pack-a", mode: "guest" }]);
  await projectList(documents, "project_2", [{ capsuleId: second.payload.capsuleId, mode: "own" }, { capsuleId: "pack-a", mode: "guest" }, { capsuleId: "pack-b", mode: "guest" }]);

  const withdrawn = [];
  const lines = [];
  const report = await foldIntoOneCapsule({ capsules: service, userId: USER, withdrawIndex: async (userId, capsuleIds) => { withdrawn.push([userId, capsuleIds]); }, log: (line) => lines.push(line) });
  assert.deepEqual({ notesCapsules: report.notesCapsules, entries: report.entries, lists: report.lists, dropped: report.dropped, left: report.left },
    { notesCapsules: 2, entries: 3, lists: 2, dropped: [], left: 0 });

  // Every note is an entry of the one capsule, with its id, its text, its status and its project, as a new revision of the same fact.
  const account = await service.ownCapsule(USER);
  assert.ok(String(account.id).startsWith("account-capsule:"));
  for (const [before, project] of [[first, "project_1"], [forgotten, "project_1"], [second, "project_2"]]) {
    const moved = await documents.get(USER, "fact", before.id);
    assert.equal(moved.payload.capsuleId, account.id);
    assert.equal(moved.payload.content, before.payload.content);
    assert.equal(moved.payload.status, before.payload.status, "what the person forgot stays forgotten");
    assert.equal(moved.projectId, project, "the document's own project column is untouched");
    assert.equal(moved.payload.projectId, project);
    assert.equal(moved.revision, before.revision + 1, "one new revision, not a new fact");
    assert.equal(moved.payload.movedFrom.capsuleId, before.payload.capsuleId);
    assert.equal(moved.payload.movedFrom.reason, "one-capsule-per-person");
    const history = await documents.history(USER, "fact", before.id);
    assert.deepEqual(history.map((item) => item.payload.capsuleId), [account.id, before.payload.capsuleId], "the history keeps where it was");
  }
  // The emptied capsules and the folded lists are in the trash (restorable); the one the person deleted is as they left it.
  for (const entry of [first, second]) assert.equal(await documents.get(USER, "capsule", entry.payload.capsuleId), null);
  assert.ok((await documents.get(USER, "capsule", first.payload.capsuleId, { includeDeleted: true })).deletedAt);
  const stillTrashed = await documents.get(USER, "fact", trashed.id);
  assert.equal(stillTrashed.payload.capsuleId, trashed.payload.capsuleId, "a capsule the person deleted is not emptied into their capsule");
  for (const projectId of ["project_1", "project_2"]) assert.equal(await documents.get(USER, "preferences", `active-capsules:project:${projectId}`), null);
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0][0], USER);
  assert.deepEqual([...withdrawn[0][1]].sort(), [first.payload.capsuleId, second.payload.capsuleId].sort(), "the index is owed the removal of the emptied capsules' copies");

  // The packs: the account's own first, then the newest enabled first, each once.
  assert.deepEqual((await service.active(USER)).items.map((item) => [item.capsuleId === account.id ? "own capsule" : item.capsuleId, item.mode]),
    [["own capsule", "own"], ["pack-b", "guest"], ["pack-a", "guest"], ["pack-c", "guest"]]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /notes_capsules=2 entries=3 lists=2 left=0$/);

  // What a conversation reads is what the project's notes capsule gave it: this project's notes, not the other's.
  assert.deepEqual((await service.recall(USER, { query: "结论", projectId: "project_1" })).items.map((item) => item.id), [first.id]);
  assert.deepEqual((await service.recall(USER, { query: "结论", projectId: "project_2" })).items, []);
  assert.deepEqual((await service.recall(USER, { query: "表格", projectId: "project_2" })).items.map((item) => item.id), [second.id]);

  // Run again: nothing changes, nothing is withdrawn, nothing is said.
  const settled = snapshot(documents);
  withdrawn.length = 0; lines.length = 0;
  const again = await foldIntoOneCapsule({ capsules: service, userId: USER, withdrawIndex: async (userId, capsuleIds) => { withdrawn.push([userId, capsuleIds]); }, log: (line) => lines.push(line) });
  assert.deepEqual({ notesCapsules: again.notesCapsules, entries: again.entries, lists: again.lists }, { notesCapsules: 0, entries: 0, lists: 0 });
  assert.equal(snapshot(documents), settled, "a second pass writes nothing");
  assert.deepEqual([withdrawn, lines], [[], []]);
});

test("more packs than the eight in force leave out the oldest enabled, name them, and keep them on the shelf", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const own = await service.ownCapsule(USER, { create: true });
  const accountItems = [];
  for (let index = 1; index <= 4; index += 1) {
    await pack(documents, `acct-${index}`, `2026-10-0${index}T00:00:00.000Z`);
    accountItems.push({ capsuleId: `acct-${index}`, mode: "guest" });
  }
  await documents.put(USER, "preferences", "active-capsules:account", { items: [{ capsuleId: own.id, mode: "own" }, ...accountItems] }, { expectedRevision: (await service.active(USER)).record.revision });
  for (let index = 1; index <= 5; index += 1) await pack(documents, `proj-${index}`, `2026-10-1${index}T00:00:00.000Z`);
  await projectList(documents, "project_1", [1, 2, 3].map((index) => ({ capsuleId: `proj-${index}`, mode: "guest" })));
  await projectList(documents, "project_2", [3, 4, 5].map((index) => ({ capsuleId: `proj-${index}`, mode: "guest" })));
  await legacyNote(documents, "project_1", "回答先给结论");

  const lines = [];
  const report = await foldIntoOneCapsule({ capsules: service, userId: USER, log: (line) => lines.push(line) });
  const items = (await service.active(USER)).items;
  assert.equal(items.length, 8);
  assert.equal(items[0].capsuleId, own.id);
  assert.deepEqual(items.slice(1).map((item) => item.capsuleId), ["proj-5", "proj-4", "proj-3", "proj-2", "proj-1", "acct-4", "acct-3"], "newest enabled first");
  assert.deepEqual(report.dropped.map((item) => item.capsuleId).sort(), ["acct-1", "acct-2"], "the two enabled longest ago do not fit");
  assert.match(lines.at(-1), /dropped_from_force=acct-2,acct-1$/);
  // Left out of force, not off the shelf: each is still a received pack, one click from enabled again.
  assert.deepEqual((await service.received(USER)).filter((item) => !item.enabled).map((item) => item.id).sort(), ["acct-1", "acct-2"]);
});

test("a project list that adds nothing leaves the account's list as it is, and a pack the list names that is gone is skipped", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const own = await service.ownCapsule(USER, { create: true });
  await pack(documents, "pack-a");
  await pack(documents, "pack-b");
  await documents.put(USER, "preferences", "active-capsules:account", { items: [{ capsuleId: own.id, mode: "own" }, { capsuleId: "pack-b", mode: "guest" }, { capsuleId: "pack-a", mode: "guest" }] },
    { expectedRevision: (await service.active(USER)).record.revision });
  await projectList(documents, "project_1", [{ capsuleId: "pack-a", mode: "guest" }, { capsuleId: "pack-gone", mode: "guest" }]);
  const before = (await service.active(USER)).record.revision;
  const report = await foldIntoOneCapsule({ capsules: service, userId: USER });
  assert.equal(report.lists, 1);
  assert.deepEqual((await service.active(USER)).items.map((item) => item.capsuleId), [own.id, "pack-b", "pack-a"], "the order the person made is kept");
  assert.equal((await service.active(USER)).record.revision, before, "not even rewritten");
});

test("a failed withdrawal of the index copies never fails the fold, and an account with nothing to fold is not touched", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const untouched = await foldIntoOneCapsule({ capsules: service, userId: USER });
  assert.deepEqual({ notesCapsules: untouched.notesCapsules, entries: untouched.entries, lists: untouched.lists }, { notesCapsules: 0, entries: 0, lists: 0 });
  assert.equal(documents.rows.size, 0, "no capsule is made for an account that has nothing to fold");

  const note = await legacyNote(documents, "project_1", "回答先给结论");
  const lines = [];
  const report = await foldIntoOneCapsule({ capsules: service, userId: USER, withdrawIndex: async () => { throw Object.assign(new Error("index down"), { code: "memory_index_timeout" }); }, log: (line) => lines.push(line) });
  assert.equal(report.notesCapsules, 1);
  assert.equal((await documents.get(USER, "fact", note.id)).payload.capsuleId.startsWith("account-capsule:"), true);
  assert.ok(lines.some((line) => /index withdrawal not owed \(memory_index_timeout\)/.test(line)));
});

test("a note whose revision moves under the fold is read again, and the person's edit survives the move", async () => {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  const moving = await legacyNote(documents, "project_1", "会被改动的笔记");
  // The person corrects the note while the fold reads: the first write of the fold meets a newer revision.
  const realPut = documents.put.bind(documents);
  let raced = false;
  documents.put = async (userId, kind, id, payload, options) => {
    if (kind === "fact" && id === moving.id && !raced) {
      raced = true;
      await realPut(userId, "fact", id, { ...moving.payload, content: "改过的笔记", correctedAt: "2026-10-24T00:00:00.000Z" }, { expectedRevision: moving.revision });
    }
    return realPut(userId, kind, id, payload, options);
  };
  const report = await foldIntoOneCapsule({ capsules: service, userId: USER });
  assert.equal(report.entries, 1);
  const moved = await documents.get(USER, "fact", moving.id);
  assert.equal(moved.payload.content, "改过的笔记", "the person's correction survived the move");
  assert.ok(moved.payload.capsuleId.startsWith("account-capsule:"));
});
