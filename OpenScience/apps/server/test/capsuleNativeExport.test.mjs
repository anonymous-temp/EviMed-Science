import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";
import { notMigratedBecause } from "../src/nativeMemoryMigration.mjs";
import { nativeMemoryRoot } from "../src/openVikingLayout.mjs";

const userId = "native-export-owner";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture({ unavailable = false, foreign = false, many = false, migrated = false, adopted = false, changedAfterAdoption = false } = {}) {
  const root = nativeMemoryRoot(foreign ? "another-account" : userId);
  const body = "# Trial project\n\nThe supplied cohort contains exactly 123 participants.";
  const held = [
    ["preferences/writing.md", "Keep result tables concise.", null],
    ["profile.md", "I am a researcher.", null],
    ["projects/trial.md", body, "owned"],
    ["projects/paused.md", "Paused project secret.", "paused"],
    ["projects/foreign.md", "Foreign project secret.", "foreign"],
    ["projects/unassociated.md", "Unassociated project secret.", null],
    ["projects/internal.md", "Internal project secret.", "evimed-learning"],
    ["project_facts/sensitive.md", "Sensitive secret.", "owned"],
    ...(many ? Array.from({ length: 101 }, (_, index) => [`project_facts/item-${index}.md`, `Fact ${index}`, "owned"]) : []),
  ];
  const sessions = {
    configured: true, memoryRoot: () => root,
    tree: async () => { if (unavailable) throw Object.assign(new Error("engine unavailable"), { code: "memory_engine_unavailable" }); return held.map(([name, value, project]) => ({ uri: `${root}/${name}`, isDir: false, modTime: "2026-10-21", size: value.length, tags: project ? [`project=${project}`] : [] })); },
    read: async (_user, uri) => held.find(([name]) => `${root}/${name}` === uri)?.[1],
  };
  const overlay = { configured: true, files: async () => new Map([[`${root}/project_facts/sensitive.md`, { sensitive: true }]]),
    revisionsOfMany: async () => new Map([[`${root}/preferences/writing.md`, [{ actor: "user", change: "updated", changedAt: "2026-10-21", before: "Old preference", after: adopted && !changedAfterAdoption ? "Keep result tables concise." : "Earlier body" }]]]), sources: async () => [] };
  const nativeMemory = new NativeMemoryStore({ sessions, overlay });
  const reads = [];
  const client = { query: async (sql) => {
    reads.push(sql);
    if (sql.includes("FROM evimed_memory.records")) throw new Error("native export reached legacy memory");
    if (sql.includes("WITH RECURSIVE migration")) return { rows: migrated ? [{ uri: `${root}/preferences/writing.md` }, { uri: `${root}/projects/trial.md` }, { uri: `${root}/profile.md` }] : [] };
    if (sql.includes("kind='capsule'")) return { rows: [{ revision: 7 }] };
    if (sql.includes("paused_projects")) return { rows: [{ paused_projects: ["paused"] }] };
    if (sql.includes("FROM evimed_control.projects")) return { rows: [{ id: "owned" }, { id: "paused" }, { id: "evimed-learning" }] };
    if (sql.includes("SELECT name")) return { rows: [{ name: "Researcher" }] };
    return { rows: [] };
  } };
  const database = { query: client.query, transaction: async (callback) => callback(client) };
  const service = new CapsuleTransferService({ documents: { database }, capsules: { get: async () => ({ payload: {} }) },
    identities: {}, dataDir: "/tmp/unused-native-export", nativeMemory, memoryEngine: async () => "native" });
  return { service, reads, body, nativeMemory };
}

test("native selected export uses full authoritative bodies, manual origin and explicit scope opt-ins", async () => {
  const { service, body, reads } = fixture();
  const defaults = await service.exportPreview(userId, "own-capsule");
  assert.deepEqual(defaults.entries.map(({ content }) => content), ["Keep result tables concise."]);
  assert.equal(defaults.entries[0].origin, "explicit");
  const full = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+profile", "+knowledge"] });
  assert.equal(full.entries.length, 3);
  assert.ok(full.entries.some(({ content }) => content === body));
  assert.ok(full.entries.some(({ content }) => content === "I am a researcher."));
  assert.ok(!full.entries.some(({ content }) => /secret/.test(content)));
  assert.ok(!reads.some((sql) => sql.includes("FROM evimed_memory.records")));
  assert.equal(hash(body).length, 64);
});

test("native engine failure and a foreign-account engine tree fail without legacy fallback", async () => {
  for (const options of [{ unavailable: true }, { foreign: true }]) {
    const { service } = fixture(options);
    await assert.rejects(service.exportPreview(userId, "own-capsule"), { code: "memory_engine_unavailable" });
  }
});

test("native selected knowledge reports the 100-entry bound instead of silently claiming a complete pack", async () => {
  const { service } = fixture({ many: true });
  const preview = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+knowledge"] });
  assert.equal(preview.tooMany, true);
  assert.equal(preview.entries.length, 100);
});


test("native export excludes inferred, borrowed, retired and conversation records even when shaped like explicit files", async () => {
  for (const refused of [{ origin: "inferred" }, { share: { snapshotId: "borrowed" } }, { status: "retired" }, { scope: "session" }]) {
    const { service, nativeMemory } = fixture();
    const records = nativeMemory.records.bind(nativeMemory);
    nativeMemory.records = async (...args) => (await records(...args)).map((row) => ({ ...row, ...refused }));
    const preview = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+profile", "+knowledge"] });
    assert.equal(preview.empty, true);
  }
});


test("migration-derived memory needs a user edit of the current exact body, including after engine updates", async () => {
  assert.equal(notMigratedBecause({ origin: "inferred", kind: "preference", status: "active", value: "Legacy inference" }, Date.now()), null);
  const migration = fixture({ migrated: true });
  assert.equal((await migration.service.exportPreview(userId, "own-capsule")).empty, true);
  const edited = fixture({ migrated: true, adopted: true });
  assert.equal((await edited.service.exportPreview(userId, "own-capsule")).entries.length, 1);
  const changed = fixture({ migrated: true, adopted: true, changedAfterAdoption: true });
  assert.equal((await changed.service.exportPreview(userId, "own-capsule")).empty, true);
});


test("only the latest exact-body user edit adopts migration content; old edits cannot survive undo or engine writes", async () => {
  const body = "Keep result tables concise.";
  const at = "2026-10-21T00:00:00.000Z";
  const editA = { id: "10", actor: "user", change: "updated", reason: "edited", after: body, changedAt: at };
  const engineB = { id: "11", actor: "engine", change: "updated", reason: "", after: "Engine body B", changedAt: at };
  for (const latest of [
    { id: "12", actor: "user", change: "updated", reason: "undo", after: body, changedAt: at },
    { id: "12", actor: "engine", change: "updated", reason: "", after: body, changedAt: at },
    { id: "12", actor: "user", change: "restored", reason: "undo", after: body, changedAt: at },
  ]) {
    const { service, nativeMemory } = fixture({ migrated: true });
    nativeMemory.overlay.revisionsOfMany = async () => new Map([[`${nativeMemoryRoot(userId)}/preferences/writing.md`, [latest, engineB, editA]]]);
    assert.equal((await service.exportPreview(userId, "own-capsule")).empty, true);
  }
  const { service, nativeMemory } = fixture({ migrated: true });
  nativeMemory.overlay.revisionsOfMany = async () => new Map([[`${nativeMemoryRoot(userId)}/preferences/writing.md`, [
    { ...editA, id: "13" }, engineB, editA,
  ]]]);
  assert.equal((await service.exportPreview(userId, "own-capsule")).entries.length, 1);
});


test("an edit to a migrated profile line does not adopt the other statements in its document", async () => {
  const { service, nativeMemory } = fixture({ migrated: true });
  nativeMemory.overlay.revisionsOfMany = async () => new Map([[`${nativeMemoryRoot(userId)}/profile.md`, [
    { id: "20", actor: "user", change: "updated", reason: "edited", after: "I am a researcher." },
  ]]]);
  const preview = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+profile"] });
  assert.equal(preview.empty, true);
});

test("native capsule snapshot refuses a body changed while the database snapshot is assembled", async () => {
  const { service, nativeMemory } = fixture();
  const original = service.documents.database.transaction;
  service.documents.database.transaction = async callback => {
    const value = await original(callback);
    const read = nativeMemory.sessions.read;
    nativeMemory.sessions.read = async (owner, uri) => `${await read(owner, uri)} changed concurrently`;
    return value;
  };
  await assert.rejects(service.exportPreview(userId, "own-capsule"), { code: "capsule_native_snapshot_changed" });
});
