import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";
import { notMigratedBecause } from "../src/nativeMemoryMigration.mjs";
import { nativeMemoryRoot } from "../src/openVikingLayout.mjs";

const userId = "native-export-owner";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture({ unavailable = false, foreign = false, many = false, migrated = false, adopted = false, changedAfterAdoption = false,
  complete = false, legacy = null, extra = [] } = {}) {
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
    ...extra,
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
    // The one read of the legacy rows a native account's export may make: the statements the person made before the move, to tell a
    // replayed file that is theirs from one the replay made up — and only once the migration is complete.
    if (sql.includes("SELECT value FROM evimed_memory.records") && legacy) return { rows: legacy.map((value) => ({ value })) };
    if (sql.includes("FROM evimed_memory.records")) throw new Error("native export reached legacy memory");
    if (sql.includes("migrated_at FROM evimed_memory.native_accounts")) return { rows: complete ? [{ migrated_at: "2026-10-23T00:00:00Z" }] : [] };
    if (sql.includes("WITH RECURSIVE migration")) return { rows: migrated ? [{ uri: `${root}/preferences/writing.md` }, { uri: `${root}/projects/trial.md` }, { uri: `${root}/profile.md` },
      ...extra.filter(([name]) => migrated === "all" || /^migrated\//.test(name) || /\/migrated-/.test(name)).map(([name]) => ({ uri: `${root}/${name}` }))] : [] };
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


const BACK_OFFICE = /origin|inferred|provenance|migration|migrat|replay|revision|uri|sha256|engine|引擎|迁移|血统/i;

test("once the migration is complete a replayed file that says only what the person said before it is theirs; one the replay reworded or merged is not, and the preview says so", async () => {
  // Before: every file the replay touched is out for good (this is what the account's own export looked like after its move).
  const stranded = fixture({ migrated: true, complete: false, legacy: ["Keep result tables concise."] });
  assert.equal((await stranded.service.exportPreview(userId, "own-capsule")).empty, true);

  const scopes = ["workstyle", "+profile", "+knowledge"];
  const done = fixture({ migrated: true, complete: true, legacy: ["Keep result tables concise.", "I am a researcher."] });
  const preview = await done.service.exportPreview(userId, "own-capsule", { scopes });
  // The preference file and the profile line are the person's legacy statements word for word; the project file is not among them.
  assert.deepEqual(preview.entries.map((entry) => entry.content).sort(), ["I am a researcher.", "Keep result tables concise."]);
  assert.ok(preview.entries.every((entry) => entry.included === true));
  const unconfirmed = preview.excluded.find((item) => item.reason === "unconfirmed");
  assert.equal(unconfirmed.count, 1, "the project file the replay wrote");
  assert.match(unconfirmed.text, /1 条/);
  assert.doesNotMatch(unconfirmed.text, BACK_OFFICE, "a sentence a person reads, not the back office's words");

  // A statement the engine merged or reworded is no longer the person's word for word.
  const reworded = fixture({ migrated: true, complete: true, legacy: ["Keep result tables short."] });
  assert.equal((await reworded.service.exportPreview(userId, "own-capsule")).empty, true);
  // And the legacy rows are consulted only to compare: an inferred record is not among the statements read (the query asks for the person's own).
  const queries = [];
  const recording = fixture({ migrated: true, complete: true, legacy: ["Keep result tables concise."] });
  const ask = recording.service.documents.database.query;
  recording.service.documents.database.query = async (sql, ...rest) => { queries.push(sql); return ask(sql, ...rest); };
  const reader = recording.service.documents.database.transaction;
  recording.service.documents.database.transaction = async (callback) => reader(async (client) => callback({ ...client, query: async (sql, ...rest) => { queries.push(sql); return client.query(sql, ...rest); } }));
  await recording.service.exportPreview(userId, "own-capsule");
  const legacyRead = queries.find((sql) => sql.includes("SELECT value FROM evimed_memory.records"));
  assert.match(legacyRead, /origin IN \('explicit','manual'\)/);
  assert.match(legacyRead, /NOT sensitive/);
});

test("the preview says, in one plain sentence each, why something is not in the pack: sensitive, paused, replayed, and nothing of the back office", async () => {
  const { service } = fixture({ migrated: true, complete: true, legacy: [] });
  const preview = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+profile", "+knowledge"] });
  const reasons = Object.fromEntries(preview.excluded.map((item) => [item.reason, item.count]));
  assert.deepEqual(reasons, { sensitive: 1, unconfirmed: 3, paused: 1 }, "the file the person marked sensitive, the three the replay wrote, the project they paused");
  for (const item of preview.excluded) {
    assert.match(item.text, /^[^\n]+。$/, "one sentence");
    assert.doesNotMatch(item.text, BACK_OFFICE);
  }
  assert.ok(!preview.excluded.some((item) => item.text.includes("secret")), "counts, never the text of what is left out");
  // What is not in the chosen scope is not a reason: the default pack does not mention the project files.
  const plain = await service.exportPreview(userId, "own-capsule");
  assert.deepEqual(plain.excluded.map((item) => item.reason), ["unconfirmed"]);
});

test("the sender unticks entries one by one: they stay listed, are not included, and the card and the count are the pack without them", async () => {
  const { service } = fixture();
  const all = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+profile", "+knowledge"] });
  assert.equal(all.entries.length, 3);
  assert.ok(all.entries.every((entry) => /^native:nm_/.test(entry.id) && entry.included));
  const drop = all.entries.find((entry) => entry.content === "I am a researcher.");
  const fewer = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+profile", "+knowledge"], excludeEntryIds: [drop.id] });
  assert.equal(fewer.entries.length, 3, "an unticked entry stays in the list, so it can be ticked again");
  assert.deepEqual(fewer.entries.filter((entry) => !entry.included).map((entry) => entry.content), ["I am a researcher."]);
  assert.equal(fewer.card.summary, "1 条工作偏好、1 条项目事实", "the card describes the pack that would leave");
  assert.equal(fewer.empty, false);
  // All unticked: nothing to send, but not the state of an account with nothing to share.
  const none = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+profile", "+knowledge"], excludeEntryIds: all.entries.map((entry) => entry.id) });
  assert.equal(none.card, null);
  assert.equal(none.empty, false);
  assert.ok(none.entries.every((entry) => entry.included === false));
  // An id that matches nothing is not an error; a malformed one is.
  assert.equal((await service.exportPreview(userId, "own-capsule", { excludeEntryIds: ["fact:gone"] })).entries.length, 1);
  await assert.rejects(service.exportPreview(userId, "own-capsule", { excludeEntryIds: ["nm_x"] }), { code: "capsule_transfer_invalid" });
  await assert.rejects(service.exportPreview(userId, "own-capsule", { excludeEntryIds: "all" }), { code: "capsule_transfer_invalid" });
  // Unticking is how a pack over the bound gets small enough.
  const crowded = fixture({ many: true });
  const big = await crowded.service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+knowledge"] });
  assert.equal(big.tooMany, true);
});

test("a correction lives under the preferences directory and is shared as a correction, never as a preference", async () => {
  const { service } = fixture({ extra: [["preferences/corrections/length.md", "Keep abstracts under 200 words.", null]] });
  const defaults = await service.exportPreview(userId, "own-capsule");
  assert.deepEqual(defaults.entries.map((entry) => entry.content), ["Keep result tables concise."], "a correction is not a work-style kind");
  const knowledge = await service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+knowledge"] });
  const correction = knowledge.entries.find((entry) => entry.content === "Keep abstracts under 200 words.");
  assert.equal(correction.factKind, "correction");
  assert.equal(correction.layer, "knowledge");
  assert.equal(knowledge.entries.filter((entry) => entry.factKind === "preference").length, 1);
  assert.match(knowledge.card.summary, /1 条经验教训/);
});

test("the domain's share scopes and paths are exactly what the transfer service accepts and writes — the validator is not the looser of the two checks", async () => {
  const { CAPSULE_SHARE_SCOPES, SHARE_SCOPE_ENTRIES } = await import("@evimed/domain");
  const { capsuleTransferLocation, renderCapsuleTransferFiles } = await import("../src/capsuleTransferService.mjs");
  assert.deepEqual([...CAPSULE_SHARE_SCOPES], ["workstyle", "+profile", "+knowledge"]);
  assert.deepEqual(Object.keys(SHARE_SCOPE_ENTRIES), [...CAPSULE_SHARE_SCOPES]);
  const { service } = fixture();
  for (const scope of CAPSULE_SHARE_SCOPES) {
    await service.exportPreview(userId, "own-capsule", { scopes: scope === "workstyle" ? ["workstyle"] : ["workstyle", scope] });
  }
  await assert.rejects(service.exportPreview(userId, "own-capsule", { scopes: ["workstyle", "+documents"] }), { code: "capsule_transfer_invalid" });
  // Every file a share of each scope is made of is a path its scope declares.
  const kindsOfScope = { workstyle: ["method_preference", "writing_style", "preference", "tooling"], "+profile": ["profile", "behavior", "expertise"],
    "+knowledge": ["project_fact", "analysis", "decision", "stance", "tension", "correction", "follow_up"] };
  /** @param {string} path @param {readonly string[]} allowed */
  const within = (path, allowed) => allowed.some((one) => (one.endsWith("/") ? path.startsWith(one) : path === one));
  for (const [scope, kinds] of Object.entries(kindsOfScope)) {
    for (const kind of kinds) {
      const place = capsuleTransferLocation(kind);
      const entry = { id: "00000000-0000-4000-8000-000000000001", version: 1, factKind: kind, layer: place.layer, content: "x", sha256: "0".repeat(64), path: place.path ?? "methods/00000000-0000-4000-8000-000000000001/SKILL.md", origin: "explicit" };
      for (const path of Object.keys(renderCapsuleTransferFiles("00000000-0000-4000-8000-000000000002", [entry]))) {
        // Its own scope's paths, or the workstyle's (every share carries it, and with it the provenance file).
        assert.ok(within(path, SHARE_SCOPE_ENTRIES[/** @type {keyof typeof SHARE_SCOPE_ENTRIES} */ (scope)]) || within(path, SHARE_SCOPE_ENTRIES.workstyle), `${scope} / ${kind}: ${path}`);
      }
    }
  }
});
