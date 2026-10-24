// One capsule per person (2026-10-24) against a real PostgreSQL: an account whose runs made a 「项目笔记」 capsule for each of its projects
// ends with one capsule, the notes are its entries labelled with their projects, the recall index is told by the same outbox every
// other change of a capsule goes through, a project's deletion takes its notes with it, and the person's export still leaves the
// assistant's notes out. The production account has ten such capsules; this is its shape.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { foldAllIntoOneCapsule, indexWithdrawalOfCapsules } from "../src/capsuleOneCapsule.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { withdrawProjectDerivedMemory } from "../src/derivedMemory.mjs";
import { MemoryIndexWithdrawals } from "../src/memoryIndexWithdrawals.mjs";
import { MemoryIndexing } from "../src/memoryIndexing.mjs";
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
const USER = `oc_user_${tag}`;
const BYSTANDER = `oc_other_${tag}`;
const PROJECTS = Array.from({ length: 10 }, (_, index) => `proj${index}_${tag}`);
const sha = (/** @type {unknown} */ value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** @type {any} */ let directory; /** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let capsules; /** @type {any} */ let withdrawals;
/** @type {any} */ let indexing;

before(async () => {
  if (!url) return;
  directory = await mkdtemp("/tmp/evimed-one-capsule-");
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  await migrateResearchMemory(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$3,'development'),($2,$4,'development')", [USER, BYSTANDER, `Owner ${tag}`, `Other ${tag}`]);
  for (const owner of [USER, BYSTANDER]) {
    for (const id of ["default", ...PROJECTS]) {
      await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,$2,1048576) ON CONFLICT DO NOTHING", [owner, id]);
    }
  }
  documents = new ProductDocuments(database);
  capsules = new CapsuleService(documents);
  withdrawals = new MemoryIndexWithdrawals({ database, openViking: { remove: async () => true } });
  indexing = new MemoryIndexing({ database, openViking: {}, jobs: {}, withdrawals });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_memory.index_withdrawals WHERE user_id=ANY($1::text[])", [[USER, BYSTANDER]]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[USER, BYSTANDER]]);
  await database.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** A project's notes capsule and one note in it, as the release before this one wrote them (`CapsuleService.note`). */
async function legacyNote(/** @type {string} */ owner, /** @type {string} */ projectId, /** @type {string} */ content, factKind = "preference") {
  const capsuleId = `runtime-notes:${createHash("sha256").update(projectId).digest("hex")}`;
  if (!await documents.get(owner, "capsule", capsuleId)) {
    await documents.put(owner, "capsule", capsuleId, { title: "项目笔记", description: "这个项目的研究运行记下的内容。", imported: false, activationMode: "own" }, { expectedRevision: 0, projectId });
    await documents.put(owner, "preferences", `active-capsules:project:${projectId}`, { items: [{ capsuleId, mode: "own" }] }, { expectedRevision: 0, projectId });
  }
  return documents.put(owner, "fact", `runtime-note:${sha([capsuleId, factKind, content])}`, { capsuleId, factKind, layer: "knowledge", content, origin: "inferred", status: "approved",
    provenance: [{ type: "source", id: `runtime-project:${projectId}` }], contextOnly: true }, { expectedRevision: 0, projectId });
}

test("ten notes capsules become ten project-labelled entries of one capsule, the index is told, a second pass changes nothing, and nobody else is touched", options, async () => {
  const notes = [];
  for (const [index, projectId] of PROJECTS.entries()) notes.push(await legacyNote(USER, projectId, `第 ${index} 个项目的笔记 ${tag}`));
  const bystander = await legacyNote(BYSTANDER, PROJECTS[0], `别人的笔记 ${tag}`);
  const pack = await documents.put(USER, "capsule", `pack-${tag}`, { title: "收到的包", description: "", imported: true, activationMode: "guest", keptSince: "2026-10-01T00:00:00.000Z" }, { expectedRevision: 0 });
  // One pack enabled for one project alone, beside that project's notes capsule: what the release before let a person do.
  const list = await documents.get(USER, "preferences", `active-capsules:project:${PROJECTS[3]}`);
  await documents.put(USER, "preferences", list.id, { items: [...list.payload.items, { capsuleId: pack.id, mode: "guest" }] }, { expectedRevision: list.revision });

  const owed = [];
  const lines = [];
  // The very function the server hands the fold, over the real ledger; the index itself is a fake that says yes to every removal.
  const toLedger = indexWithdrawalOfCapsules({ indexing, withdrawals, database });
  const withdrawIndex = async (/** @type {string} */ userId, /** @type {string[]} */ capsuleIds) => {
    await toLedger(userId, capsuleIds);
    if (userId === USER) owed.push(...capsuleIds);
  };
  const total = await foldAllIntoOneCapsule({ database, capsules, withdrawIndex, log: (line) => lines.push(line) });
  assert.ok(total.accounts >= 2 && total.failed === 0, JSON.stringify(total));

  // One capsule: the account's, and no notes capsule is left in force.
  const own = (await capsules.list(USER, { limit: 100 })).items.filter((item) => item.payload.imported !== true);
  assert.deepEqual(own.map((item) => item.id), [(await capsules.ownCapsule(USER)).id], "one capsule of the person's own");
  assert.equal(own[0].id.startsWith("account-capsule:"), true);
  assert.equal((await capsules.list(USER, { limit: 100, deleted: true })).items.filter((item) => String(item.id).startsWith("runtime-notes:")).length, 10, "the ten emptied capsules are in the trash");

  // Ten entries of it, each with its project, its id, its text and the revision that moved it.
  const mine = await capsules.mine(USER);
  const entries = mine.entries.filter((entry) => entry.payload.content.includes(tag));
  assert.equal(entries.length, 10);
  for (const [index, projectId] of PROJECTS.entries()) {
    const entry = entries.find((item) => item.id === notes[index].id);
    assert.equal(entry.payload.capsuleId, own[0].id);
    assert.equal(entry.projectId, projectId);
    assert.equal(entry.payload.projectId, projectId);
    assert.equal(entry.revision, 2);
    assert.equal(entry.payload.movedFrom.capsuleId, notes[index].payload.capsuleId);
    assert.equal((await documents.history(USER, "fact", entry.id)).length, 2, "the revision before the move is kept");
  }

  // The index hears of it through the outbox every capsule change goes through: the account capsule is rebuilt with the ten, each emptied capsule once.
  const accountSnapshot = await indexing.snapshot(USER, own[0].id);
  assert.equal(accountSnapshot.entries.filter((entry) => String(entry.content).includes(tag)).length, 10);
  const emptied = await indexing.snapshot(USER, notes[0].payload.capsuleId);
  assert.equal(emptied.live, false);
  assert.equal(emptied.entries.length, 0);
  const jobs = await database.query("SELECT DISTINCT payload->>'capsuleId' AS capsule FROM evimed_product.jobs WHERE user_id=$1 AND kind='memory-index'", [USER]);
  const queued = new Set(jobs.rows.map((/** @type {any} */ row) => row.capsule));
  assert.ok(queued.has(own[0].id), "the account capsule is queued for a rebuild");
  for (const note of notes) assert.ok(queued.has(note.payload.capsuleId), "each emptied capsule is queued, so its subtree goes");
  assert.deepEqual([...owed].sort(), notes.map((note) => note.payload.capsuleId).sort(), "and the withdrawal ledger owes the index their subtrees");
  const ledger = await database.query("SELECT uri FROM evimed_memory.index_withdrawals WHERE user_id=$1", [USER]);
  assert.equal(ledger.rowCount, 10);
  assert.ok(ledger.rows.every((/** @type {any} */ row) => row.uri.startsWith("viking://user/") && row.uri.includes("/memories/evimed")));

  // The pack enabled for one project is in force for the account now, and the lists of a project are gone.
  assert.deepEqual((await capsules.active(USER)).items.map((item) => [item.capsuleId === own[0].id ? "own" : item.capsuleId, item.mode]), [["own", "own"], [pack.id, "guest"]]);
  assert.equal(await documents.get(USER, "preferences", `active-capsules:project:${PROJECTS[3]}`), null);

  // What each project's conversation reads is what its own capsule gave it.
  for (const [index, projectId] of PROJECTS.entries()) {
    const found = await capsules.recall(USER, { projectId, query: `第 ${index} 个项目的笔记` });
    assert.deepEqual(found.items.map((item) => item.id), [notes[index].id], projectId);
    assert.equal((await capsules.recall(USER, { projectId: PROJECTS[(index + 1) % 10], query: `第 ${index} 个项目的笔记` })).items.length, 0, "not another project's");
  }

  // Idempotent: nothing moves again, nothing more is owed or said, and the other account's capsule is exactly as it was.
  lines.length = 0; owed.length = 0;
  const again = await foldAllIntoOneCapsule({ database, capsules, withdrawIndex, log: (line) => lines.push(line) });
  assert.ok(!lines.some((line) => line.includes(`user=${USER}`)), "no pass for an account that is done");
  assert.equal(owed.length, 0);
  assert.equal(again.failed, 0);
  assert.equal((await documents.get(USER, "fact", notes[0].id)).revision, 2);
  const untouched = await documents.get(BYSTANDER, "fact", bystander.id);
  assert.ok(String(untouched.payload.capsuleId).startsWith("account-capsule:"), "the other account was folded too, into its own capsule");
  assert.equal(untouched.payload.content, `别人的笔记 ${tag}`);
  assert.equal((await capsules.recall(USER, { projectId: PROJECTS[0], query: "别人的笔记" })).items.length, 0, "and never into this one");
});

test("a project's deletion takes its notes with it, from the capsule and from the recall index's snapshot, and leaves the other projects' notes", options, async () => {
  const mine = await capsules.mine(USER);
  const [gone, kept] = [PROJECTS[1], PROJECTS[2]];
  assert.ok(mine.entries.some((entry) => entry.projectId === gone));
  await database.transaction(async (/** @type {any} */ client) => {
    await withdrawProjectDerivedMemory(client, USER, gone);
    await client.query("DELETE FROM evimed_control.projects WHERE user_id=$1 AND id=$2", [USER, gone]);
  });
  const after = await capsules.mine(USER);
  assert.equal(after.entries.some((entry) => entry.projectId === gone), false);
  assert.equal(after.forgotten.some((entry) => entry.projectId === gone), false, "not in 已忘记的内容 either: the project's notes are gone, not put away");
  assert.ok(after.entries.some((entry) => entry.projectId === kept));
  const own = await capsules.ownCapsule(USER);
  const snapshot = await indexing.snapshot(USER, own.id);
  assert.equal(snapshot.entries.some((entry) => String(entry.content).includes(`第 1 个项目的笔记 ${tag}`)), false, "the recall index's rebuild no longer holds them");
  assert.ok(snapshot.entries.some((entry) => String(entry.content).includes(`第 2 个项目的笔记 ${tag}`)));
});

test("the person's export leaves the assistant's notes out, however many project notes the one capsule now holds, and takes one the person confirmed", options, async () => {
  await migrateResearchMemory(database);
  const transfers = new CapsuleTransferService({ documents, capsules, identities: new CapsuleIdentityStore(directory), dataDir: directory, memoryEngine: async () => "legacy" });
  const own = await capsules.ownCapsule(USER);
  const before = await transfers.exportPreview(USER, own.id, { scopes: ["workstyle", "+profile", "+knowledge"] });
  assert.equal(before.entries.some((entry) => entry.content.includes(tag)), false, "an inferred note is never in the pack");
  assert.ok(before.excluded.some((item) => item.reason === "inferred" && item.count >= 8), "and the preview says why a note they remember is not in the list");
  // The person confirms one: they correct its words. That is their act on it, and the pack may carry it.
  const note = (await capsules.mine(USER)).entries.find((entry) => entry.projectId === PROJECTS[4]);
  await capsules.updateEntry(USER, own.id, note.id, { content: `回答先给结论，再给证据 ${tag}`, expectedRevision: note.revision });
  const after = await transfers.exportPreview(USER, own.id, { scopes: ["workstyle"] });
  assert.deepEqual(after.entries.filter((entry) => entry.content.includes(tag)).map((entry) => entry.content), [`回答先给结论，再给证据 ${tag}`]);
});
