// A knowledge-base file that arrives with new bytes, through the real server composition (N15): the work that rests on the
// old document is found by its recorded id and bytes, labelled, and told in the inbox — and the registration is exactly
// what it was without any of it.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { SourceIngestionWorker } from "../src/sourceWorker.mjs";

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
    const originalResult = await documents.get(user.id, "result-version", versionId);
    for (const [suffix, input] of [
      ["8", { kind: "data", id: "knowledge-base/trial-copy.txt", path: "knowledge-base/trial-copy.txt", digest: sha("trial v1"), availability: "captured" }],
      ["9", { kind: "source", id: first.source.id, digest: sha("trial v1"), availability: "captured" }],
      ["a", { kind: "data", id: "knowledge-base/trial.txt", path: "knowledge-base/trial.txt", digest: sha("wrong bytes"), availability: "captured" }],
    ]) {
      const id = `rv_${hex(suffix)}`;
      await documents.put(user.id, "result-version", id, { ...originalResult.payload, versionId: id, inputs: [input] }, { expectedRevision: 0, projectId: project.id });
    }
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
    await documents.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE user_id=$1 AND coalesce(payload->>'action','') <> 'source-replace'", [user.id]);
    const worker = new SourceIngestionWorker({ jobs: app.sourceService.jobs, sources: app.sourceService,
      parser: {}, resolveSource: async () => { throw Error("Replacement must not parse"); }, materialize: async () => { throw Error("Replacement must not materialize"); } });
    const reconcile = app.sourceService.afterReplace;
    let interrupt = true;
    app.sourceService.afterReplace = async event => {
      await reconcile(event);
      if (interrupt) { interrupt = false; throw Object.assign(new Error("Interrupted after reconciliation"), { code: "product_state_unavailable" }); }
    };
    await worker.tick();
    const pending = await documents.database.query("SELECT id,status,error FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='source-replace'", [user.id]);
    assert.equal(pending.rows[0].status, "queued", "partial callback success must remain durable for retry");
    assert.equal(pending.rows[0].error.code, "product_state_unavailable", "the first callback reached the deliberate post-reconciliation interruption");
    // This fixture requires an already-due retry; timestamptz(3) may round the current clock into the future.
    await documents.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1", [pending.rows[0].id]);
    const restartedWorker = new SourceIngestionWorker({ jobs: app.sourceService.jobs, sources: app.sourceService,
      parser: {}, resolveSource: async () => { throw Error("Replacement must not parse"); }, materialize: async () => { throw Error("Replacement must not materialize"); } });
    await restartedWorker.tick();
    const retryState = await app.sourceService.jobs.get(user.id, pending.rows[0].id);
    const retryDiagnostic = retryState.status === "succeeded" ? null : (await documents.database.query("SELECT id,status,attempts,error,run_after,clock_timestamp() AS database_now,statement_timestamp() AS statement_now FROM evimed_product.jobs WHERE id=$1", [pending.rows[0].id])).rows[0];
    assert.equal(retryState.status, "succeeded", JSON.stringify({ job: retryDiagnostic, workerLastError: restartedWorker.lastError }));
    const found = await impacts();
    assert.equal(found.length, 1, "the one result that read the old bytes");
    assert.equal(found[0].payload.versionId, versionId);
    assert.equal(found[0].payload.source.id, first.source.id);
    assert.equal(found[0].payload.source.replacedBy, second.source.id);
    assert.equal(found[0].payload.sourceStatus.updates[0].kind, "replaced");
    assert.equal(found[0].payload.recomputed, false, "nothing was rerun");
    assert.equal(found[0].payload.continuation.status, "awaiting_user", "no agenda produced it, so the researcher chooses");
    assert.deepEqual(found[0].payload.affected.memories.items, []);
    assert.equal(await stateOf(resting), "current");
    assert.equal(await stateOf(independent), "current");
    assert.equal((await app.researchMemory.getRecord(user.id, resting.id)).version, resting.version, "labelling moved no version of the memory");

    const notices = (await app.notificationService.list(user.id, { projectId: project.id })).items;
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /资料库里这份文件有了新版本/);
    // The old document and its parse are untouched: it is still a source of this project.
    assert.equal((await app.sourceService.get(user.id, first.source.id)).payload.status, first.source.payload.status);
    const retired = await app.sourceService.register(user.id, manifest({ path: "knowledge-base/trial-copy.txt", sha256: sha("trial v2"), size: 12 }));
    assert.equal(retired.source.id, second.source.id);
    await documents.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()+interval '1 day' WHERE user_id=$1 AND coalesce(payload->>'action','') <> 'source-replace'", [user.id]);
    const notePages = app.knowledgePages.noteSourcesChanged.bind(app.knowledgePages);
    app.knowledgePages.noteSourcesChanged = async (_user, _project, _changes, options) => { assert.equal(options?.strict, true); throw Error("page scheduling unavailable"); };
    await restartedWorker.tick();
    const retry = await documents.database.query("SELECT id,status FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='source-replace' AND status='queued'", [user.id]);
    assert.equal(retry.rowCount, 1, "page failures cannot falsely finish the durable replacement");
    app.knowledgePages.noteSourcesChanged = notePages;
    await documents.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1", [retry.rows[0].id]);
    await restartedWorker.tick();
    const pageRetryState = await app.sourceService.jobs.get(user.id, retry.rows[0].id);
    const pageRetryDiagnostic = pageRetryState.status === "succeeded" ? null : (await documents.database.query("SELECT id,status,attempts,error,run_after,clock_timestamp() AS database_now,statement_timestamp() AS statement_now FROM evimed_product.jobs WHERE id=$1", [retry.rows[0].id])).rows[0];
    assert.equal(pageRetryState.status, "succeeded", JSON.stringify({ job: pageRetryDiagnostic, workerLastError: restartedWorker.lastError }));
    const counts = { impacts: (await impacts()).length, notices: (await app.notificationService.list(user.id, { projectId: project.id })).items.length };
    await restartedWorker.tick();
    assert.deepEqual({ impacts: (await impacts()).length, notices: (await app.notificationService.list(user.id, { projectId: project.id })).items.length }, counts);

  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close().catch(() => app.store.close());
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("replacement eligibility and effects fence concurrent reactivation through the publication transaction", { skip: !databaseUrl }, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "source-replacement-fence-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl, sourceIngestionEnabled: false });
  let user, release;
  try {
    user = await app.store.createUser(`fence${randomUUID().slice(0, 8)}`, "test-only-password", "Fence fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const input = digest => ({ projectId: project.id, connector: { type: "upload", id: "library" }, path: "knowledge-base/fence.txt", size: 1, mtime: "2026-10-04T00:00:00.000Z", mimeType: "text/plain", sha256: digest });
    await app.sourceService.register(user.id, input(sha("A")));
    await app.sourceService.register(user.id, input(sha("B")));
    const jobs = await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='source-replace'", [user.id]);
    const job = await app.sourceService.jobs.get(user.id, jobs.rows[0].id);
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    app.sourceService.afterReplace = async event => { assert.equal(event.sourceRetired, true); enter(); await barrier; };
    const consuming = app.sourceService.consumeReplacement(job);
    await entered;
    let committed = false;
    const reactivation = app.sourceService.register(user.id, input(sha("A"))).then(value => { committed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(committed, false, "reactivation cannot commit between eligibility and dependency effects");
    release();
    await consuming;
    assert.equal((await reactivation).source.payload.publication.current, true);
  } finally {
    release?.();
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close().catch(() => app.store.close());
    await rm(dataDir, { recursive: true, force: true });
  }
});
