// A knowledge-base file that arrives with new bytes, through the real server composition (N15): the work that rests on the
// old document is found by its recorded id and bytes, labelled, and told in the inbox — and the registration is exactly
// what it was without any of it.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const sha = text => createHash("sha256").update(text).digest("hex");
const hex = (character, length = 64) => character.repeat(length);

test("through the server: new bytes for a held file label what read the old document, and a different file does not", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-knowledge-change-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl, sourceIngestionEnabled: false });
  let user;
  try {
    user = await app.store.createUser(`kc${randomUUID().slice(0, 8)}`, "test-only-source-password", "Knowledge change fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const manifest = (values = {}) => ({ projectId: project.id, connector: { type: "upload", id: "library" }, path: "knowledge-base/trial.txt",
      size: 9, mtime: "2026-10-04T00:00:00.000Z", mimeType: "text/plain", sha256: sha("trial v1"), ...values });
    const first = await app.sourceService.register(user.id, manifest());
    const documents = app.sourceService.documents;

    // A result that read the first version's exact bytes, a memory that names its id, and one that names a document nobody changes.
    const versionId = `rv_${hex("7")}`;
    await documents.put(user.id, "result-version", versionId, { recordType: "result-version", versionId, artifactId: `ra_${hex("6")}`, projectId: project.id,
      path: "analysis/trial-summary.md", digest: hex("5"), size: 10, mimeType: "text/markdown", capturedAt: "2026-10-04T00:00:00.000Z",
      producer: { kind: "tool", runId: "run-1" }, inputs: [{ kind: "data", id: "knowledge-base/trial.txt", path: "knowledge-base/trial.txt", digest: sha("trial v1"), versionId: null, availability: "captured" }],
      machineValues: [], findings: [], coverage: { gaps: [] }, storagePath: `result-snapshots/${hex("5")}`, bindingSources: [] },
    { expectedRevision: 0, projectId: project.id });
    const record = (key, links) => app.researchMemory.upsertRecord(user.id, { scope: "project", scopeId: project.id, kind: "project_fact", key,
      value: `${key} finding`, summary: key, origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false }, null, { sourceLinks: links });
    const resting = await record("project.trial", [{ type: "knowledge_source", id: first.source.id }]);
    const independent = await record("project.other", [{ type: "knowledge_source", id: `src_${hex("d", 32)}` }]);
    const impacts = async () => (await documents.list(user.id, "result-impact", { projectId: project.id })).items;
    const stateOf = async record_ => (await app.researchMemory.sourceLinks(user.id, record_.id))[0].state;

    // The same bytes again, and a different file, change nothing a result or a memory rests on.
    await app.sourceService.register(user.id, manifest({ path: "knowledge-base/trial-copy.txt" }));
    await app.sourceService.register(user.id, manifest({ path: "knowledge-base/another.txt", sha256: sha("another file") }));
    assert.deepEqual(await impacts(), []);
    assert.equal(await stateOf(resting), "current");

    const second = await app.sourceService.register(user.id, manifest({ sha256: sha("trial v2"), size: 12 }));
    assert.equal(second.duplicate, false);
    assert.equal(second.source.payload.version, 2);
    assert.equal("replaces" in second, false);
    const found = await impacts();
    assert.equal(found.length, 1, "the one result that read the old bytes");
    assert.equal(found[0].payload.versionId, versionId);
    assert.equal(found[0].payload.source.id, first.source.id);
    assert.equal(found[0].payload.source.replacedBy, second.source.id);
    assert.equal(found[0].payload.sourceStatus.updates[0].kind, "replaced");
    assert.equal(found[0].payload.recomputed, false, "nothing was rerun");
    assert.equal(found[0].payload.continuation.status, "awaiting_user", "no agenda produced it, so the researcher chooses");
    assert.deepEqual(found[0].payload.affected.memories.items.map(item => [item.recordId, item.state]), [[resting.id, "changed"]]);
    assert.equal(await stateOf(resting), "changed");
    assert.equal(await stateOf(independent), "current");
    assert.equal((await app.researchMemory.getRecord(user.id, resting.id)).version, resting.version, "labelling moved no version of the memory");

    const notices = (await app.notificationService.list(user.id, { projectId: project.id })).items;
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /资料库里这份文件有了新版本/);
    // The old document and its parse are untouched: it is still a source of this project.
    assert.equal((await app.sourceService.get(user.id, first.source.id)).payload.status, first.source.payload.status);
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close().catch(() => app.store.close());
    await rm(dataDir, { recursive: true, force: true });
  }
});
