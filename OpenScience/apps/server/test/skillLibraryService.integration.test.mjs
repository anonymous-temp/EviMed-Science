import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parsePersonalSkill } from "@evimed/harness-port";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { SkillLibraryService } from "../src/skillLibraryService.mjs";
import { SkillLibraryArtifacts } from "../src/skillLibraryArtifacts.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url); assert(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = { id: `skill_${randomUUID()}` }, other = { id: `skill_${randomUUID()}` };
let database, root, artifacts, service, uploadEntries;
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Skill fixture','development'),($2,'Other fixture','development')", [owner.id, other.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p1','Skill fixture',1048576),($1,'p2','Second fixture',1048576)", [owner.id]);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-skill-native-")));
  artifacts = new SkillLibraryArtifacts({ root, parseSkill: parsePersonalSkill, resolveImport: async (user, id) => {
    if (user.id !== owner.id || id !== "upload1") throw Object.assign(Error("missing"), { status: 404 }); return uploadEntries;
  } });
  service = new SkillLibraryService(database, { artifacts, projectAccess: async (user, project) => {
    const result = await database.query("SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2", [user.id, project.id]);
    if (project.userId !== user.id || result.rowCount !== 1) throw Object.assign(Error("missing"), { status: 404 });
  } });
});
after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner.id, other.id]]); await database.close(); }
});
const content = { expectedRevision: 0, title: "Source review", description: "Check supplied sources", instructions: "Preserve quotations and table counts." };

test("actual native parsing plus PostgreSQL survives service restart, CAS conflict and exact version restore", options, async () => {
  const created = await service.create(owner, content);
  const preparedRoot = await artifacts.preparedRoot(owner, created.payload);
  const native = await parsePersonalSkill(preparedRoot, { expectedName: created.payload.nativeName });
  assert.equal(native.instructions.trim(), content.instructions); assert.equal(native.description, content.description);
  assert.equal((await new SkillLibraryService(database).get(owner, created.id)).payload.digest, created.payload.digest);
  const results = await Promise.allSettled(["first", "second"].map(instructions => service.update(owner, created.id, { ...content, expectedRevision: 1, instructions })));
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(results.find(item => item.status === "rejected").reason.code, "product_revision_conflict");
  const restored = await service.restore(owner, created.id, { expectedRevision: 2, revision: 1 });
  assert.equal(restored.payload.digest, created.payload.digest);
  assert.deepEqual((await service.history(owner, created.id)).map(item => item.revision), [3, 2, 1]);
  await assert.rejects(service.get(other, created.id), { status: 404 });
});
test("native imported scripts/resources remain immutable data, namespace cannot shadow built-in skills", options, async () => {
  const script = Buffer.from("raise RuntimeError('must never execute on import')\n");
  uploadEntries = [{ type: "file", path: "SKILL.md", bytes: Buffer.from("---\nname: clinical-evidence-synthesis\ndescription: Imported checking\n---\n\nCheck only the supplied sources.\n") },
    { type: "file", path: "scripts/check.py", bytes: script }];
  const imported = await service.import(owner, { resourceId: "upload1", title: "My checking" });
  assert.notEqual(imported.payload.nativeName, "clinical-evidence-synthesis"); assert.match(imported.payload.nativeName, /^personal-/);
  const resource = imported.payload.resources[0];
  assert((await service.resource(owner, imported.id, 1, resource.id)).equals(script));
  await assert.rejects(service.resource(other, imported.id, 1, resource.id), { status: 404 });
  const edited = await service.update(owner, imported.id, { ...content, expectedRevision: 1, instructions: "New checking" });
  assert.deepEqual(edited.payload.resources, imported.payload.resources);
  await artifacts.preparedRoot(owner, imported.payload); await artifacts.preparedRoot(owner, edited.payload);
  await service.remove(owner, imported.id, { expectedRevision: 2 });
  await assert.rejects(service.resource(owner, imported.id, 1, resource.id), { status: 404 });
  // Existing pinned artifacts still exist, but cannot be used as new API admission.
  await artifacts.preparedRoot(owner, imported.payload);
});
test("native malformed imports are refused without fabricating a database record", options, async () => {
  uploadEntries = [{ type: "file", path: "SKILL.md", bytes: Buffer.from("---\nname: [invalid\n---\n\nUnparseable\n") }];
  const before = (await service.list(owner)).items.length;
  await assert.rejects(service.import(owner, { resourceId: "upload1", title: "Bad skill" }), { code: "extension_contract_invalid" });
  assert.equal((await service.list(owner)).items.length, before);
  assert.deepEqual(await fs.readdir(path.join(artifacts.ownerRoot(owner), "imports")), []);
});
test("owned raw upload deletion and expiry preserve every adopted historical artifact", options, async () => {
  const privateArtifacts = new SkillLibraryArtifacts({ root, parseSkill: parsePersonalSkill });
  const privateService = new SkillLibraryService(database, { artifacts: privateArtifacts });
  const bytes = Buffer.from("---\nname: transient-input\ndescription: Uploaded method\n---\n\nKeep this method.\n");
  const upload = await privateService.upload(owner, "skill", bytes);
  const imported = await privateService.import(owner, { resourceId: upload.resourceId, title: "Uploaded method" });
  assert.deepEqual(await fs.readdir(path.join(privateArtifacts.ownerRoot(owner), "imports")), []);
  await assert.rejects(privateService.removeUpload(other, upload.resourceId), { status: 404 });
  await privateService.removeUpload(owner, upload.resourceId);
  await assert.rejects(privateService.import(owner, { resourceId: upload.resourceId, title: "Removed input" }), { status: 404 });
  await privateArtifacts.preparedRoot(owner, imported.payload);
  const again = await privateService.upload(owner, "skill", bytes);
  const directory = path.join(privateArtifacts.ownerRoot(owner), "uploads", again.resourceId.slice(7));
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); await fs.utimes(directory, old, old);
  await assert.rejects(privateArtifacts.verifyUpload(owner, again.resourceId), { status: 404 });
  await privateService.upload(owner, "skill", Buffer.concat([bytes, Buffer.from("\nNew input.\n")]));
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  await privateArtifacts.preparedRoot(owner, imported.payload);
});
test("future project defaults snapshot the exact revision and deleted project admission is rechecked", options, async () => {
  const created = await service.create(owner, content), project = { id: "p2", userId: owner.id };
  await service.saveDefaults(owner, { expectedRevision: 0, skills: [{ skillId: created.id, revision: 1 }] });
  const initialized = await service.initializeProject(owner, project);
  await service.saveDefaults(owner, { expectedRevision: 1, skills: [] });
  assert.deepEqual((await service.initializeProject(owner, project)).payload, initialized.payload);
  await database.query("DELETE FROM evimed_control.projects WHERE user_id=$1 AND id=$2", [owner.id, project.id]);
  await assert.rejects(service.projectSelections(owner, project), { status: 404 });
});
test("imported native invocation policy, metadata and usage guidance survive edit and restore without broadening", options, async () => {
  uploadEntries = [{ type: "file", path: "SKILL.md", bytes: Buffer.from("---\nname: imported-policy\ndescription: Preserve the policy\nuser-invocable: false\ndisable-model-invocation: true\nwhenToUse: Only when explicitly supplied\nmetadata:\n  origin: private\n---\n\nUse only this source.\n") }];
  const imported = await service.import(owner, { resourceId: "upload1", title: "Restricted skill" });
  const verify = async payload => {
    const native = await parsePersonalSkill(await artifacts.preparedRoot(owner, payload));
    assert.deepEqual(native.invocation, { userInvocable: false, modelInvocable: false });
    assert.equal(native.whenToUse, "Only when explicitly supplied"); assert.equal(native.metadata.origin, "private");
  };
  await verify(imported.payload);
  const edited = await service.update(owner, imported.id, { ...content, expectedRevision: 1 }); await verify(edited.payload);
  const restored = await service.restore(owner, imported.id, { expectedRevision: 2, revision: 1 }); await verify(restored.payload);
  const project = { id: "p1", userId: owner.id }, previous = await service.projectSelections(owner, project);
  await service.saveProjectSelections(owner, project, { expectedRevision: previous.revision, skills: [{ skillId: imported.id, revision: 3 }] });
  await assert.rejects(service.invoke(owner, project, imported.id, { revision: 3, sessionId: "session1", idempotencyKey: "invoke1" }), { code: "extension_access_denied", status: 403 });
});
test("stale native revisions do not publish orphan packages before their durable CAS rejection", options, async () => {
  const created = await service.create(owner, content);
  const packageRoot = path.join(artifacts.ownerRoot(owner), "packages");
  const before = (await fs.readdir(packageRoot)).sort();
  for (let i = 0; i < 3; i++) await assert.rejects(service.update(owner, created.id, { ...content, expectedRevision: 0, instructions: `${i}${"x".repeat(240000)}` }), { code: "product_revision_conflict" });
  assert.deepEqual((await fs.readdir(packageRoot)).sort(), before);
  const outcomes = await Promise.allSettled(["first competing", "second competing"].map(instructions => service.update(owner, created.id, { ...content, expectedRevision: 1, instructions })));
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal((await fs.readdir(packageRoot)).length, before.length + 1);
});

test("native import preview exposes resources and invocation policy without persistent blobs or library activation", options, async () => {
  const previewRoot = path.join(root, "preview-only"); await fs.mkdir(previewRoot);
  const previewArtifacts = new SkillLibraryArtifacts({ root: previewRoot, parseSkill: parsePersonalSkill, resolveImport: async () => [
    { type: "file", path: "SKILL.md", bytes: Buffer.from("---\nname: preview-fixture\ndescription: Inspect supplied sources\nuser-invocable: false\ndisable-model-invocation: true\n---\n\nKeep uncertainty.\n") },
    { type: "file", path: "scripts/check.py", bytes: Buffer.from("print('inert fixture')\n") },
  ] });
  const previewService = new SkillLibraryService(database, { artifacts: previewArtifacts });
  const before = (await previewService.list(owner)).items.length;
  const preview = await previewService.previewImport(owner, { resourceId: "preview-upload" });
  assert.equal(preview.instructions, "Keep uncertainty.");
  assert.deepEqual(preview.invocation, { userInvocable: false, modelInvocable: false });
  assert.equal(preview.scripts[0].path, "scripts/check.py"); assert.equal(preview.resources.length, 1);
  assert.equal((await previewService.list(owner)).items.length, before);
  await assert.rejects(fs.stat(path.join(previewArtifacts.ownerRoot(owner), "blobs")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(previewArtifacts.ownerRoot(owner), "packages")), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(previewArtifacts.ownerRoot(owner), "imports")), []);
});
