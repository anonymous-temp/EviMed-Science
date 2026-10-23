// What a native account's conversation reaches of the capsule (2026-10-23), against the real capsule service on an in-memory store.
//
// The engine's plugin hands over the profile and the listing of the preferences at a session's start and its search finds the
// memory files; of the capsule it reached nothing, so a project's notes, the packs the person enabled and the evidence zones were
// invisible to such a conversation. These cases hold the two halves with the real selection rules, not a double of them: the own
// capsule's profile entries are in the opening block (a pack someone else wrote is not: it brings its methods and never an identity),
// and the search also finds the entries of every capsule in force, labelled as a reference where it is one, and of none that is not,
// retired or still waiting for the person.
import assert from "node:assert/strict";
import test from "node:test";

import { CapsuleService } from "../src/capsuleService.mjs";
import { capsuleSearchText } from "../src/memoryGateway.mjs";
import { createNativeCapsuleSearch } from "../src/capsuleGateway.mjs";
import { ResidentProfiles } from "../src/residentProfile.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const USER = "u_native";
const PROJECT = "p_notes";

/** A native account's research-memory store, as the resident profile reads one. */
const nativeStore = () => ({
  async memoryEngine() { return "native"; },
  async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
  async sessionState() { return { trialCapsuleId: null }; },
  async residentRecords() { throw new Error("a native account's records are the engine's"); },
  async lookupCounts() { throw new Error("a native account's records are the engine's"); },
  async residentState() { return { digest: null, compactedSince: false }; },
  async noteResidentDelivered() {},
});

async function world() {
  const documents = productDocumentsDouble();
  const service = new CapsuleService(/** @type {any} */ (documents));
  // The project's notes, as a run writes them: approved at once, in a capsule that is in force in the project.
  const note = await service.note(USER, PROJECT, { factKind: "preference", content: "引用一律用 AMA 格式，页码写全" });
  const profileNote = await service.note(USER, PROJECT, { factKind: "profile", content: "心内科临床药师，做真实世界研究" });
  // A pack someone else wrote, enabled as a reference.
  const pack = await service.create(USER, { title: "王老师的队列研究做法" });
  await service.addEntry(USER, pack.id, { factKind: "method_preference", layer: "methods", content: "队列研究先写目标试验，再写分析计划", origin: "explicit" });
  await service.addEntry(USER, pack.id, { factKind: "profile", layer: "profile", content: "王老师，流行病学教授", origin: "explicit" });
  await service.activate(USER, pack.id, { mode: "guest", projectId: PROJECT });
  return { documents, service, note, profileNote, pack };
}

const search = (service, query) => createNativeCapsuleSearch({ service })({ user: { id: USER, accountCreatedAt: "2026-01-01T00:00:00Z" }, project: { id: PROJECT }, query, limit: 8 });
const opening = (service) => new ResidentProfiles({ config: {}, store: /** @type {any} */ (nativeStore()), capsules: service }).forDispatch(USER, { projectId: PROJECT, sessionId: "ses_1", attended: true });

test("the own capsule's profile entries open a native conversation, and a pack someone else wrote does not: it brings methods, never an identity", async () => {
  const { service, note, profileNote } = await world();
  const handed = await opening(service);
  assert.equal(handed.reason, "first");
  assert.deepEqual(handed.memories.map((memo) => memo.id).sort(), [`fact:${note.id}`, `fact:${profileNote.id}`].sort());
  assert.match(handed.text, /引用一律用 AMA 格式/);
  assert.match(handed.text, /心内科临床药师/);
  assert.doesNotMatch(handed.text, /王老师|目标试验/, "a guest's entries are one search away and never the person's own profile");
});

test("a search of a native conversation finds the notes and the packs in force, labels a pack as a reference, and finds nothing of one that is not in force", async () => {
  const { service, documents, note, pack } = await world();
  const text = capsuleSearchText([...await search(service, "引用"), ...await search(service, "队列研究")]);
  assert.match(text, /\[preference\] 引用一律用 AMA 格式/);
  assert.match(text, /\[method_preference · 参考胶囊《王老师的队列研究做法》\] 队列研究先写目标试验/);

  // The pack is disabled: nothing of it is found, and what was the person's own stays.
  const active = await service.active(USER, PROJECT);
  await documents.put(USER, "preferences", `active-capsules:project:${PROJECT}`, { items: active.items.filter((item) => item.capsuleId !== pack.id) },
    { expectedRevision: active.record.revision, projectId: PROJECT });
  assert.equal(capsuleSearchText(await search(service, "队列研究")), null, "nothing of a pack that is not in force");
  assert.match(capsuleSearchText(await search(service, "引用")) ?? "", /AMA/);

  // A note the person put away is not found either.
  const entry = await documents.get(USER, "fact", note.id);
  await service.updateEntry(USER, entry.payload.capsuleId, note.id, { status: "retired", expectedRevision: entry.revision });
  assert.equal(capsuleSearchText(await search(service, "引用")), null);
});

test("a note an outside agent proposed waits: it is in neither the opening block nor a search until the person confirms it", async () => {
  const { service } = await world();
  const proposed = await service.note(USER, PROJECT, { factKind: "preference", content: "摘要一律写成结构化形式", review: true });
  assert.equal(proposed.payload.status, "candidate");
  assert.doesNotMatch((await opening(service)).text, /结构化形式/);
  assert.equal(capsuleSearchText(await search(service, "结构化")), null);
  await service.updateEntry(USER, proposed.payload.capsuleId, proposed.id, { status: "approved", expectedRevision: proposed.revision });
  assert.match((await opening(service)).text, /结构化形式/);
  assert.match(capsuleSearchText(await search(service, "结构化")) ?? "", /摘要一律写成结构化形式/);
});
