import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SkillLibraryService, renderPersonalSkill } from "../src/skillLibraryService.mjs";
import { SkillLibraryArtifacts } from "../src/skillLibraryArtifacts.mjs";
import { canonicalJson, personalSkillName } from "@evimed/domain";
import { HttpError } from "../src/security.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const owner = { id: "skill-owner" }, other = { id: "skill-other" };
const roots = [];
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });

// Service tests deliberately use a ledger fixture; real PostgreSQL/native tests are separate.
function fixture() {
  const current = new Map(), versions = new Map();
  const key = (user, kind, id) => JSON.stringify([user, kind, id]);
  const documents = {
    async put(user, kind, id, payload, { expectedRevision, projectId = null }) {
      const k = key(user, kind, id), old = current.get(k);
      if ((old?.revision ?? 0) !== expectedRevision || old?.deletedAt) throw Object.assign(Error("conflict"), { code: "product_revision_conflict" });
      const row = { id, kind, projectId, payload: structuredClone(payload), revision: expectedRevision + 1, deletedAt: null };
      current.set(k, row); versions.set(k, [...(versions.get(k) ?? []), structuredClone(row)]); return structuredClone(row);
    },
    async get(user, kind, id, { includeDeleted = false } = {}) {
      const row = current.get(key(user, kind, id)); return row && (!row.deletedAt || includeDeleted) ? structuredClone(row) : null;
    },
    // The real store's shape (productStore.mjs `history`): a revision row has
    // no id, kind or project of its own. This double returned whole documents,
    // which is how a reader of `row.id` passed here and was undefined live.
    async history(user, kind, id, { beforeRevision = null, limit = 50 } = {}) {
      return structuredClone((versions.get(key(user, kind, id)) ?? []).filter(row => beforeRevision == null || row.revision < beforeRevision).reverse().slice(0, limit)
        .map(row => ({ revision: row.revision, payload: row.payload, deletedAt: row.deletedAt, recordedAt: "2026-10-02T00:00:00.000Z" })));
    },
    async list(user, kind) { return { items: [...current.entries()].filter(([k, row]) => JSON.parse(k)[0] === user && row.kind === kind && !row.deletedAt).map(([, row]) => structuredClone(row)), nextCursor: null }; },
    async remove(user, kind, id, expectedRevision) {
      const row = await this.get(user, kind, id); if (row.revision !== expectedRevision) throw Object.assign(Error("conflict"), { code: "product_revision_conflict" });
      const removed = { ...row, revision: row.revision + 1, deletedAt: "2026-10-02T00:00:00Z" };
      const k = key(user, kind, id); current.set(k, removed); versions.set(k, [...versions.get(k), structuredClone(removed)]); return removed;
    },
  };
  const invocations = [];
  const service = new SkillLibraryService(null, { documents,
    artifacts: { prepare: async (_user, input) => ({ nativeName: input.nativeName, digest: input.digest }) },
    projectAccess: async (user, project) => { if (project.userId !== user.id) throw Object.assign(Error("missing"), { code: "not_found" }); },
    invoke: async input => { invocations.push(input); return { observedDispatch: "fixture-only" }; },
  });
  return { service, documents, invocations };
}
const content = { expectedRevision: 0, title: "Review checks", description: "Check the supplied sources", instructions: "Preserve source quotations." };

test("personal skill CAS and exact historical restore preserve native namespace", async () => {
  const { service } = fixture();
  const created = await service.create(owner, content);
  assert.match(created.payload.nativeName, /^personal-[a-f0-9]{16}-[a-f0-9]{32}$/);
  const edited = await service.update(owner, created.id, { ...content, expectedRevision: 1, title: "Renamed", instructions: "Also inspect tables." });
  assert.equal(edited.payload.nativeName, created.payload.nativeName);
  await assert.rejects(service.update(owner, created.id, { ...content, expectedRevision: 1 }), { code: "product_revision_conflict" });
  const restored = await service.restore(owner, created.id, { expectedRevision: 2, revision: 1 });
  assert.equal(restored.payload.digest, created.payload.digest);
  assert.deepEqual((await service.history(owner, created.id)).map(row => row.revision), [3, 2, 1]);
});
test("a mounted personal skill in the session catalogue names the skill it came from", async () => {
  // Found on the pilot (2026-10-03): the effective list's personalRef had no
  // skillId, so 「打开个人技能」 linked to /app/extensions/skills/undefined.
  const { service } = fixture();
  const skill = await service.create(owner, content);
  const project = { id: "paper", userId: owner.id };
  service.nativeCatalogue = { runtime: { runtimePersonalSkillPins: () => [{ nativeName: skill.payload.nativeName, skillId: skill.id, revision: 1, digest: skill.payload.digest }] } };
  const item = await service.personalCatalogueRef(owner, project, { source: "personal", name: skill.payload.nativeName, key: "opaque" });
  assert.deepEqual(item.personalRef, { skillId: skill.id, revision: 1, title: content.title });
  // A pin whose digest is not the stored revision's is left unlabelled, not mislabelled.
  service.nativeCatalogue = { runtime: { runtimePersonalSkillPins: () => [{ nativeName: skill.payload.nativeName, skillId: skill.id, revision: 1, digest: "sha256:" + "0".repeat(64) }] } };
  assert.equal((await service.personalCatalogueRef(owner, project, { source: "personal", name: skill.payload.nativeName, key: "opaque" })).personalRef, undefined);
});

test("foreign skill reads, revisions and mutations are concealed", async () => {
  const { service } = fixture(), created = await service.create(owner, content);
  for (const operation of [() => service.get(other, created.id), () => service.history(other, created.id),
    () => service.update(other, created.id, { ...content, expectedRevision: 1 }), () => service.remove(other, created.id, { expectedRevision: 1 })]) {
    await assert.rejects(operation(), { code: "product_document_not_found", status: 404 });
  }
  assert.deepEqual((await service.list(other)).items, []);
  assert(!Object.hasOwn((await service.list(owner)).items[0].payload, "instructions"));
});
test("default revisions snapshot once and project overrides do not change with defaults", async () => {
  const { service } = fixture(), created = await service.create(owner, content);
  await service.saveDefaults(owner, { expectedRevision: 0, skills: [{ skillId: created.id, revision: 1 }] });
  const project = { id: "p1", userId: owner.id };
  await service.initializeProject(owner, project);
  await service.saveDefaults(owner, { expectedRevision: 1, skills: [] });
  assert.equal((await service.initializeProject(owner, project)).payload.skills[0].revision, 1);
  await assert.rejects(service.saveProjectSelections(other, project, { expectedRevision: 1, skills: [] }), { code: "not_found" });
});
test("invocation requires an owned enabled exact revision and removal stops future admission", async () => {
  const { service, invocations } = fixture(), created = await service.create(owner, content), project = { id: "p1", userId: owner.id };
  const input = { revision: 1, sessionId: "session1", idempotencyKey: "invoke1" };
  await assert.rejects(service.invoke(owner, project, created.id, input), { status: 409 });
  assert.equal(invocations.length, 0);
  await service.saveProjectSelections(owner, project, { expectedRevision: 0, skills: [{ skillId: created.id, revision: 1 }] });
  await service.invoke(owner, project, created.id, input); assert.equal(invocations.length, 1);
  assert.equal(invocations[0].payload.digest, created.payload.digest);
  await assert.rejects(service.invoke(owner, project, created.id, { ...input, ownerId: other.id }), { status: 400 });
  await service.remove(owner, created.id, { expectedRevision: 1 });
  await assert.rejects(service.invoke(owner, project, created.id, input), { status: 404 });
});
test("a deleted optional default cannot block creation of a new research project", async () => {
  const { service } = fixture(), created = await service.create(owner, content);
  await service.saveDefaults(owner, { expectedRevision: 0, skills: [{ skillId: created.id, revision: 1 }] });
  await service.remove(owner, created.id, { expectedRevision: 1 });
  assert.deepEqual((await service.initializeProject(owner, { id: "new-project", userId: owner.id })).payload.skills, []);
});
test("authority fields and oversized serialized records are rejected before native preparation", async () => {
  const { service } = fixture();
  await assert.rejects(service.create(owner, { ...content, proof: "pass" }), { status: 400 });
  await assert.rejects(service.create(owner, { ...content, instructions: "\\".repeat(150000) }), { code: "product_document_too_large" });
});
test("optional native preparation failure does not save a fabricated ready skill", async () => {
  const { service } = fixture(); service.artifacts.prepare = async () => { throw Error("native refused"); };
  await assert.rejects(service.create(owner, content), /native refused/);
  assert.equal((await service.list(owner)).items.length, 0);
});
test("resource packages reject links, traversal, secret files and oversized files before publication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-test-")); roots.push(root);
  let entries;
  const artifacts = new SkillLibraryArtifacts({ root, parseSkill: async () => assert.fail("must not parse rejected files"), resolveImport: async () => entries });
  for (const entry of [{ type: "symlink", path: "SKILL.md", bytes: Buffer.from("x") },
    { type: "file", path: "../SKILL.md", bytes: Buffer.from("x") }, { type: "file", path: "secrets/key.txt", bytes: Buffer.from("x") },
    { type: "file", path: "SKILL.md", bytes: Buffer.alloc(4 * 1024 * 1024 + 1) }]) {
    entries = [entry]; await assert.rejects(artifacts.import(owner, { resourceId: "upload1", skillId: "skill1", nativeName: "unused" }), { status: 400 });
  }
  assert.deepEqual(await fs.readdir(root), []);
});
test("immutable publication verifies matching bytes and refuses symlink resource replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-test-")); roots.push(root);
  const name = personalSkillName(owner.id, "skill1", sha), file = renderPersonalSkill(name, content);
  const digest = `sha256:${sha(canonicalJson({ file, resources: [] }))}`;
  const artifacts = new SkillLibraryArtifacts({ root, parseSkill: async (_root, options) => ({ name: options.expectedName }), resolveImport: null });
  await artifacts.prepare(owner, { nativeName: name, file, digest, resources: [] });
  const prepared = await artifacts.preparedRoot(owner, { nativeName: name, digest, resources: [] });
  await artifacts.prepare(owner, { nativeName: name, file, digest, resources: [] });
  const skillFile = path.join(prepared, name, "SKILL.md");
  await fs.unlink(skillFile); await fs.symlink(path.join(root, "outside"), skillFile);
  await assert.rejects(artifacts.preparedRoot(owner, { nativeName: name, digest, resources: [] }), { code: "path_forbidden" });
  await assert.rejects(artifacts.preparedRoot(other, { nativeName: name, digest, resources: [] }));
});
test("concurrent uploads share finite owner capacity and identical retries do not double count", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-quota-"))); roots.push(root);
  const artifacts = new SkillLibraryArtifacts({ root, parseSkill: null, maxOwnerBytes: 1600, maxGlobalBytes: 10000, minFreeBytes: 0 });
  const outcomes = await Promise.allSettled([Buffer.alloc(1000, 1), Buffer.alloc(1000, 2)].map(bytes => artifacts.upload(owner, "skill", bytes)));
  assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(row => row.status === "rejected").reason.code, "project_quota_exceeded");
  const original = outcomes[0].status === "fulfilled" ? Buffer.alloc(1000, 1) : Buffer.alloc(1000, 2);
  assert.deepEqual(await artifacts.upload(owner, "skill", original), outcomes.find(row => row.status === "fulfilled").value);
});
test("global capacity and physical headroom stop admission without replacing existing content", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-quota-"))); roots.push(root);
  const artifacts = new SkillLibraryArtifacts({ root, parseSkill: null, maxOwnerBytes: 10000, maxGlobalBytes: 1600, minFreeBytes: 0 });
  const saved = await artifacts.upload(owner, "skill", Buffer.alloc(1000, 1));
  await assert.rejects(artifacts.upload(other, "skill", Buffer.alloc(1000, 2)), { code: "extension_storage_capacity" });
  assert.deepEqual(await artifacts.upload(owner, "skill", Buffer.alloc(1000, 1)), saved);
  const noRoom = new SkillLibraryArtifacts({ root, parseSkill: null, minFreeBytes: Number.MAX_SAFE_INTEGER });
  await assert.rejects(noRoom.upload(other, "skill", Buffer.from("new")), { code: "extension_storage_capacity" });
});
test("a missing validation executor is unavailable, not an invented malformed skill", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-unavailable-"))); roots.push(root);
  const artifacts = new SkillLibraryArtifacts({ root, parseSkill: async () => { throw new HttpError(503, "runtime_controller_unavailable", "Private diagnostic."); } });
  await assert.rejects(artifacts.parse(root, {}), { code: "product_state_unavailable", status: 503 });
});

test("library writes count existing immutable generations against the same finite global budget", async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-shared-skill-quota-"))); roots.push(base);
  const root = path.join(base, "library"), sharedStorageRoot = path.join(base, "generations");
  await fs.mkdir(root); await fs.mkdir(sharedStorageRoot); await fs.writeFile(path.join(sharedStorageRoot, "existing"), Buffer.alloc(900));
  const artifacts = new SkillLibraryArtifacts({ root, sharedStorageRoot, parseSkill: null, maxOwnerBytes: 10000, maxGlobalBytes: 1000, minFreeBytes: 0 });
  await assert.rejects(artifacts.upload(owner, "skill", Buffer.alloc(200)), { code: "extension_storage_capacity" });
  assert.equal((await fs.stat(path.join(sharedStorageRoot, "existing"))).size, 900);
  assert.throws(() => new SkillLibraryArtifacts({ root, sharedStorageRoot: root, parseSkill: null }), /disjoint/);
});
