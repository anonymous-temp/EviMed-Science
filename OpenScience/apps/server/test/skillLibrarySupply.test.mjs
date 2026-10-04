// A personal skill carries its source, licence, version, scripts and dependencies with it, and an update toward a newer
// upstream preserves what the researcher edited and the revisions that projects and running conversations pinned. The
// ledger is a fixture (as in skillLibraryService.test.mjs); the packages and the supply are the real ones.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { SkillLibraryService } from "../src/skillLibraryService.mjs";
import { SkillSupply } from "../src/skillSupplyService.mjs";

const sha = (/** @type {string|Buffer} */ value) => createHash("sha256").update(value).digest("hex");
const owner = { id: "skill-owner" };
const adapters = { metaAnalysis: "http://m/x", mendelianRandomization: "http://m/x", bibliometricAnalysis: "http://m/x", researchTopicSelection: "http://m/x", peerReview: "http://m/x", drugSafetyAnalysis: "http://m/x" };
const config = { runtimeMode: "kernel", runtimeProvider: "docker", evimedDisabledTools: "", evimedAdapterUrls: adapters, specialistAgents: {}, publicSourceGatewayInternalUrl: "http://127.0.0.1:8787/internal/sources/v1/fetch", modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1", operatorUsers: [], publicSourceCredentials: {} };

/** A ledger with the real store's shape, and artifacts that serve a table of fixture packages by upload id. */
function fixture() {
  const current = new Map(), versions = new Map();
  const key = (/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id) => JSON.stringify([user, kind, id]);
  const documents = {
    async put(/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id, /** @type {any} */ payload, { expectedRevision = 0 } = {}) {
      const k = key(user, kind, id), old = current.get(k);
      if ((old?.revision ?? 0) !== expectedRevision || old?.deletedAt) throw Object.assign(Error("conflict"), { code: "product_revision_conflict" });
      const row = { id, kind, payload: structuredClone(payload), revision: expectedRevision + 1, deletedAt: null };
      current.set(k, row); versions.set(k, [...(versions.get(k) ?? []), structuredClone(row)]); return structuredClone(row);
    },
    async get(/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id, { includeDeleted = false } = {}) {
      const row = current.get(key(user, kind, id)); return row && (!row.deletedAt || includeDeleted) ? structuredClone(row) : null;
    },
    async history(/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id, { beforeRevision = null, limit = 50 } = {}) {
      return structuredClone((versions.get(key(user, kind, id)) ?? []).filter((/** @type {any} */ row) => beforeRevision == null || row.revision < beforeRevision).reverse().slice(0, limit)
        .map((/** @type {any} */ row) => ({ revision: row.revision, payload: row.payload, deletedAt: row.deletedAt, recordedAt: "2026-10-04T00:00:00.000Z" })));
    },
    async list() { return { items: [], nextCursor: null }; },
    async remove(/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id, /** @type {number} */ expectedRevision) {
      const row = await this.get(user, kind, id); if (row.revision !== expectedRevision) throw Object.assign(Error("conflict"), { code: "product_revision_conflict" });
      const removed = { ...row, revision: row.revision + 1, deletedAt: "2026-10-04T00:00:00Z" };
      const k = key(user, kind, id); current.set(k, removed); versions.set(k, [...versions.get(k), structuredClone(removed)]); return removed;
    },
  };
  /** @type {Map<string, any>} */ const uploads = new Map();
  /** @type {Map<string, Buffer>} */ const blobs = new Map();
  /** Registers a fixture package under an upload id: its files by path (strings), parsed the way the native reader would. */
  const upload = (/** @type {string} */ resourceId, /** @type {{instructions:string, description?:string, metadata?:any, files?:Record<string,string>}} */ spec) => {
    const files = Object.entries(spec.files ?? {}).map(([filePath, text]) => ({ path: filePath, bytes: Buffer.from(text) }));
    const list = [{ path: "SKILL.md", sha256: sha(spec.instructions), text: spec.instructions }, ...files.map((file) => ({ path: file.path, sha256: sha(file.bytes), ...(/\.(?:py|r)$/i.test(file.path) ? { text: file.bytes.toString() } : {}) }))]
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const file of files) blobs.set(`sha256:${sha(file.bytes)}`, file.bytes);
    uploads.set(resourceId, { description: spec.description ?? "A skill", instructions: spec.instructions, invocation: { userInvocable: true, modelInvocable: true }, metadata: spec.metadata ?? {}, whenToUse: null,
      resources: files.map((file) => ({ id: `resource:${sha(file.bytes)}`, path: file.path, digest: `sha256:${sha(file.bytes)}`, size: file.bytes.length })),
      files: list, packageDigest: `sha256:${sha(JSON.stringify(list.map((file) => [file.path, file.sha256])))}` });
  };
  const artifacts = {
    prepare: async (/** @type {any} */ _user, /** @type {any} */ input) => ({ nativeName: input.nativeName, digest: input.digest }),
    import: async (/** @type {any} */ _user, /** @type {any} */ input) => { const found = uploads.get(input.resourceId); if (!found) throw Object.assign(Error("missing"), { status: 404 }); return { nativeName: input.nativeName, ...structuredClone(found) }; },
    read: async (/** @type {any} */ _user, /** @type {any} */ { resource }) => blobs.get(resource.digest) ?? Buffer.alloc(0),
    verifyUpload: async () => {},
  };
  const service = new SkillLibraryService(null, { documents, artifacts, supply: new SkillSupply({ config }),
    projectAccess: async (/** @type {any} */ user, /** @type {any} */ project) => { if (project.userId !== user.id) throw new Error("missing"); } });
  return { service, documents, upload };
}
const ask = { expectedRevision: 0 };
const importAs = (/** @type {any} */ service, /** @type {string} */ resourceId, title = "Imported") => service.import(owner, { resourceId, title });

test("an authored skill says it was authored, and carries its own digest and no invented licence, version or baseline", async () => {
  const { service } = fixture();
  const row = await service.create(owner, { ...ask, title: "Mine", description: "d", instructions: "Do the thing." });
  assert.equal(row.payload.package.source.kind, "authored");
  assert.equal(row.payload.package.digest, row.payload.digest);
  assert.equal(row.payload.package.digestAlgorithm, "personal-skill-v1");
  assert.equal(row.payload.package.version, null);
  assert.equal(row.payload.package.licence, null);
  assert.equal(row.payload.baseline, null);
  const supply = await service.supplyOf(owner, row.id);
  assert.equal(supply.availability.state, "installed");
  assert.equal(supply.baseKnown, false);
  assert.ok(supply.package.unknown.some((entry) => entry.field === "licence"), "the unknown licence is named");
});

test("an import of a repository preview names the repository and commit the control plane fetched, bound to the bytes it fetched", async () => {
  const { service, upload } = fixture();
  upload("upload:" + "a".repeat(64), { instructions: "Read the source.", files: { "scripts/run.py": "import numpy\n" } });
  const commit = "c".repeat(40);
  const preview = await service.previewImport(owner, { resourceId: "upload:" + "a".repeat(64) }, { source: { kind: "repository", repository: "owner/skill", commit, path: "skills/a" } });
  assert.equal(preview.supply.package.source.commit, commit, "the preview shows the source before anything is imported");
  const row = await importAs(service, "upload:" + "a".repeat(64));
  assert.deepEqual([row.payload.package.source.kind, row.payload.package.source.repository, row.payload.package.source.commit, row.payload.package.source.path], ["repository", "owner/skill", commit, "skills/a"]);
  assert.match(row.payload.package.scripts[0].path, /scripts\/run\.py/);
  assert.ok(row.payload.baseline.resources["scripts/run.py"], "the baseline is the digests it came in with");
  // Bytes nobody previewed from a repository are an upload, whatever the caller says: the same id with other bytes names no commit.
  upload("upload:" + "b".repeat(64), { instructions: "Other bytes." });
  const plain = await importAs(service, "upload:" + "b".repeat(64));
  assert.equal(plain.payload.package.source.kind, "upload");
  assert.match(plain.payload.package.source.digest, /^sha256:[a-f0-9]{64}$/);
  upload("upload:" + "a".repeat(64), { instructions: "Changed after the preview.", files: { "scripts/run.py": "import numpy\n" } });
  assert.equal((await importAs(service, "upload:" + "a".repeat(64))).payload.package.source.kind, "upload", "the recorded commit is not believed for different bytes");
});

test("what a script imports is observed and labelled: software the image lacks limits the skill, which is still saved and listed", async () => {
  const { service, upload } = fixture();
  upload("upload:" + "d".repeat(64), { instructions: "Enrich.", metadata: { requires: { python: ["gseapy"] }, version: "2.1" }, files: { "scripts/e.py": "import numpy\ntry:\n    import h5py\nexcept ImportError:\n    pass\n" } });
  const row = await importAs(service, "upload:" + "d".repeat(64));
  const by = Object.fromEntries(row.payload.package.dependencies.map((dependency) => [dependency.name, dependency]));
  assert.equal(by.gseapy.basis, "declared");
  assert.equal(by.numpy.basis, "observed");
  assert.equal(by.h5py.optional, true);
  assert.equal(row.payload.package.version, "2.1");
  const supply = await service.supplyOf(owner, row.id);
  assert.equal(supply.availability.state, "limited");
  assert.equal(supply.availability.reason.detail, "gseapy");
  assert.deepEqual(supply.availability.notes.map((note) => note.detail), ["h5py"]);
  assert.equal((await service.get(owner, row.id)).id, row.id, "the skill is still there to read, edit and select");
});

test("a built-in copy names the built-in it was made from and the digests that built-in had, and an edit keeps both", async () => {
  const { service, upload } = fixture();
  upload("upload:" + "e".repeat(64), { instructions: "Built-in body.", files: { "references/r.md": "ref" } });
  const builtinDigest = "sha256:" + "9".repeat(64);
  service.nativeCatalogue = {
    read: async () => ({ skill: { name: "cheminformatics", digest: builtinDigest, entries: [{ path: "SKILL.md", size: 1, digest: "sha256:" + sha("x"), bytesBase64: Buffer.from("x").toString("base64") }] } }),
    assertCurrent: async () => {}, runtime: { runtimePersonalSkillPins: () => [] },
  };
  // The snapshot is uploaded and imported by the library's own paths; the fixture's upload() stands for the archive's content.
  service.upload = async () => ({ resourceId: "upload:" + "e".repeat(64) });
  service.removeUpload = async () => ({ removed: true });
  service.requireProject = async () => {};
  const row = await service.duplicateNative(owner, { id: "p", userId: owner.id }, { sessionId: "s", key: "skill:" + "a".repeat(64), title: "Copy", idempotencyKey: "copy-1", expectedRuntimeGeneration: "g1" });
  assert.equal(row.payload.package.source.kind, "builtin-copy");
  assert.equal(row.payload.package.source.package, "cheminformatics");
  assert.equal(row.payload.package.source.digest, builtinDigest);
  assert.ok(row.payload.baseline.parts.instructions);
  const edited = await service.update(owner, row.id, { expectedRevision: 1, title: "Copy", description: "A skill", instructions: "My edit." });
  assert.equal(edited.payload.package.source.package, "cheminformatics", "an edit keeps what it was copied from");
  assert.deepEqual(edited.payload.baseline, row.payload.baseline, "an edit keeps the baseline: it is what the copy came in as, not what it is now");
  assert.notEqual(edited.payload.package.digest, row.payload.package.digest);
  // Retrying the same request returns the same copy rather than a second one.
  assert.equal((await service.duplicateNative(owner, { id: "p", userId: owner.id }, { sessionId: "s", key: "skill:" + "a".repeat(64), title: "Copy", idempotencyKey: "copy-1", expectedRuntimeGeneration: "g1" })).id, row.id);
});

test("an update keeps the researcher's edit, takes the upstream's change, and leaves every pinned revision where it was", async () => {
  const { service, upload } = fixture();
  upload("upload:" + "1".repeat(64), { instructions: "v1 body", description: "v1 description", files: { "scripts/a.py": "a1", "references/r.md": "r1" } });
  const first = await importAs(service, "upload:" + "1".repeat(64));
  // The researcher edits the instructions; a project selects that revision.
  const edited = await service.update(owner, first.id, { expectedRevision: 1, title: "Imported", description: "v1 description", instructions: "my own edit" });
  const project = { id: "p1", userId: owner.id };
  const selection = await service.saveProjectSelections(owner, project, { expectedRevision: 0, skills: [{ skillId: first.id, revision: 2 }] });
  assert.equal(selection.payload.skills[0].revision, 2);
  // Upstream moves: new description, a changed script, a removed reference.
  upload("upload:" + "2".repeat(64), { instructions: "v1 body", description: "v2 description", files: { "scripts/a.py": "a2" } });
  const plan = await service.updatePreview(owner, first.id, { resourceId: "upload:" + "2".repeat(64) });
  const decision = (/** @type {string} */ name) => plan.entries.find((entry) => entry.name === name).decision;
  assert.equal(plan.baseKnown, true);
  assert.equal(decision("instructions"), "keep-local", "their edit stays");
  assert.equal(decision("description"), "take-upstream");
  assert.equal(decision("scripts/a.py"), "take-upstream");
  assert.equal(decision("references/r.md"), "remove");
  assert.equal(plan.conflicts, 0);
  assert.equal((await service.get(owner, first.id)).revision, 2, "previewing changed nothing");
  const done = await service.applyUpdate(owner, first.id, { resourceId: "upload:" + "2".repeat(64), expectedRevision: 2, resolutions: {} });
  assert.equal(done.applied, true);
  assert.equal(done.pinnedRevision, 2);
  const now = done.skill.payload;
  assert.equal(now.instructions, "my own edit");
  assert.equal(now.description, "v2 description");
  assert.deepEqual(now.resources.map((resource) => resource.path), ["scripts/a.py"]);
  assert.equal(done.skill.revision, 3);
  assert.equal(now.nativeName, edited.payload.nativeName, "the native identity does not change");
  // The project still selects revision 2: an update is a new revision, not a silent move of what a conversation runs.
  assert.equal((await service.projectSelections(owner, project)).payload.skills[0].revision, 2);
  // Every earlier revision keeps its identity.
  const history = await service.history(owner, first.id);
  assert.deepEqual(history.map((row) => row.revision), [3, 2, 1]);
  assert.equal(history[2].payload.digest, first.payload.digest);
  assert.equal(history[1].payload.digest, edited.payload.digest);
  // The baseline is now the upstream version it was synchronised with, so the next comparison starts there.
  assert.deepEqual(now.baseline.resources, { "scripts/a.py": now.resources[0].digest });
  const again = await service.updatePreview(owner, first.id, { resourceId: "upload:" + "2".repeat(64) });
  assert.equal(again.changes, 0);
  const noop = await service.applyUpdate(owner, first.id, { resourceId: "upload:" + "2".repeat(64), expectedRevision: 3, resolutions: {} });
  assert.equal(noop.applied, false, "nothing new to record is no new revision");
  assert.equal((await service.history(owner, first.id)).length, 3);
});

test("a difference both sides made is a conflict that keeps the local text unless the researcher says otherwise", async () => {
  const { service, upload } = fixture();
  upload("upload:" + "3".repeat(64), { instructions: "base" });
  const first = await importAs(service, "upload:" + "3".repeat(64));
  await service.update(owner, first.id, { expectedRevision: 1, title: "Imported", description: "A skill", instructions: "mine" });
  upload("upload:" + "4".repeat(64), { instructions: "theirs" });
  const plan = await service.updatePreview(owner, first.id, { resourceId: "upload:" + "4".repeat(64) });
  assert.equal(plan.conflicts, 1);
  assert.equal(plan.entries.find((entry) => entry.name === "instructions").decision, "conflict");
  const kept = await service.applyUpdate(owner, first.id, { resourceId: "upload:" + "4".repeat(64), expectedRevision: 2, resolutions: {} });
  assert.equal(kept.skill.payload.instructions, "mine");
  assert.deepEqual(kept.kept, ["instructions"]);
  const second = await service.update(owner, first.id, { expectedRevision: 3, title: "Imported", description: "A skill", instructions: "mine again" });
  upload("upload:" + "5".repeat(64), { instructions: "theirs, later" });
  const taken = await service.applyUpdate(owner, first.id, { resourceId: "upload:" + "5".repeat(64), expectedRevision: second.revision, resolutions: { instructions: "upstream" } });
  assert.equal(taken.skill.payload.instructions, "theirs, later", "the researcher's explicit choice takes the upstream's text for that part only");
  await assert.rejects(service.applyUpdate(owner, first.id, { resourceId: "upload:" + "5".repeat(64), expectedRevision: 1, resolutions: {} }), { code: "product_revision_conflict" });
  await assert.rejects(service.applyUpdate(owner, first.id, { resourceId: "upload:" + "5".repeat(64), expectedRevision: 5, resolutions: { instructions: "merge" } }), { code: "extension_contract_invalid" });
});

test("with no baseline (an authored skill, a transfer) every difference is a conflict and an update overwrites nothing", async () => {
  const { service, upload } = fixture();
  const authored = await service.create(owner, { ...ask, title: "Mine", description: "d", instructions: "my words" });
  upload("upload:" + "6".repeat(64), { instructions: "their words", description: "theirs" });
  const plan = await service.updatePreview(owner, authored.id, { resourceId: "upload:" + "6".repeat(64) });
  assert.equal(plan.baseKnown, false);
  assert.equal(plan.changes, 0);
  assert.ok(plan.conflicts >= 2);
  const done = await service.applyUpdate(owner, authored.id, { resourceId: "upload:" + "6".repeat(64), expectedRevision: 1, resolutions: {} });
  assert.equal(done.skill.payload.instructions, "my words");
  assert.equal(done.skill.payload.description, "d");
  assert.ok(done.skill.payload.baseline, "the synchronisation point is recorded, so the next update can tell edits from changes");
});

test("restoring a revision brings back its content, its package and its baseline: the identity is the historical one", async () => {
  const { service, upload } = fixture();
  upload("upload:" + "7".repeat(64), { instructions: "original", files: { "scripts/x.py": "import numpy\n" } });
  const first = await importAs(service, "upload:" + "7".repeat(64));
  await service.update(owner, first.id, { expectedRevision: 1, title: "Imported", description: "A skill", instructions: "changed" });
  const restored = await service.restore(owner, first.id, { expectedRevision: 2, revision: 1 });
  assert.equal(restored.revision, 3);
  assert.equal(restored.payload.digest, first.payload.digest);
  assert.deepEqual(restored.payload.package.source, first.payload.package.source);
  assert.deepEqual(restored.payload.baseline, first.payload.baseline);
  assert.equal((await service.supplyOf(owner, first.id, 1)).package.digest, first.payload.digest, "the historical revision is still readable by its own number");
});

test("a retired skill keeps every revision's identity, and its history can still be read", async () => {
  const { service, upload } = fixture();
  upload("upload:" + "8".repeat(64), { instructions: "kept" });
  const first = await importAs(service, "upload:" + "8".repeat(64));
  await service.remove(owner, first.id, { expectedRevision: 1 });
  const history = await service.history(owner, first.id);
  assert.equal(history.at(-1).payload.package.digest, first.payload.digest);
  assert.equal(history.at(-1).payload.package.source.kind, "upload");
  await assert.rejects(service.get(owner, first.id), { code: "product_document_not_found" }, "retired for new reads and new selections");
});

test("the session catalogue labels each skill with its package and never filters one out", async () => {
  const { service } = fixture();
  const skill = await service.create(owner, { ...ask, title: "Mine", description: "d", instructions: "x" });
  const project = { id: "p", userId: owner.id };
  const items = [
    { key: "k1", name: "cheminformatics", source: "builtin", description: "d", invocation: {}, canDuplicate: true },
    { key: "k2", name: "stats-integrity", source: "builtin", description: "d", invocation: {}, canDuplicate: true },
    { key: "k3", name: "dsh-ppt", source: "community", description: "d", invocation: {}, canDuplicate: true },
    { key: "k4", name: "nobody-ships-this", source: "builtin", description: "d", invocation: {}, canDuplicate: false },
    { key: "k5", name: skill.payload.nativeName, source: "personal", description: "d", invocation: {}, canDuplicate: false },
  ];
  service.nativeCatalogue = {
    list: async () => ({ state: "available", runtimeGeneration: "g1", sessionId: "s", items, findings: [] }),
    assertCurrent: async () => {},
    runtime: { runtimePersonalSkillPins: () => [{ nativeName: skill.payload.nativeName, skillId: skill.id, revision: 1, digest: skill.payload.digest }] },
  };
  service.requireProject = async () => {};
  const catalogue = await service.effectiveCatalogue(owner, project, "s");
  assert.equal(catalogue.items.length, 5, "nothing is hidden");
  const by = Object.fromEntries(catalogue.items.map((item) => [item.name, item.supply]));
  assert.equal(by.cheminformatics.state, "limited");
  assert.match(by.cheminformatics.text, /rdkit/);
  assert.match(by.cheminformatics.sourceText, /scientific-agent-skills/);
  assert.equal(by["stats-integrity"].state, "installed");
  assert.match(by["dsh-ppt"].sourceText, /STARDUSTLC666\/dsh-ppt @ 0db836e8251a/);
  assert.equal(by["dsh-ppt"].licenceText, "MIT");
  assert.equal(by["nobody-ships-this"], null, "a name no shipped package carries is unknown, not fine");
  assert.equal(by[skill.payload.nativeName].state, "installed");
});

test("a record that does not fit beside the instructions loses its lists first and its baseline second, and then fails as an oversized save always did", () => {
  const { service } = fixture();
  const files = Array.from({ length: 90 }, (_, index) => ({ path: `scripts/file-${index}.py`, sha256: sha(String(index)) }));
  const record = { schemaVersion: 1, id: "personal/x", name: "x", origin: "personal", scripts: files, references: files, dependencies: [], operations: [], source: { kind: "authored" } };
  const payload = { instructions: "x".repeat(262_144 - 20_000), package: record, baseline: { parts: {}, resources: Object.fromEntries(files.map((file) => [file.path, `sha256:${file.sha256}`])) } };
  service.fitPayload(payload);
  assert.deepEqual(payload.package.scripts, []);
  assert.equal(payload.package.source.kind, "authored", "the identifying facts stay");
  const huge = { instructions: "x".repeat(262_144 - 1_000), package: record, baseline: payload.baseline };
  service.fitPayload(huge);
  assert.equal(huge.baseline, null);
  assert.throws(() => service.fitPayload({ instructions: "x".repeat(262_144), package: record, baseline: null }), { code: "product_document_too_large" });
});
