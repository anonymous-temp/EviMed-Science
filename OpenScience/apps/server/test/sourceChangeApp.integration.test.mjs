// The source-change record through the real server composition (plan 2026-10-05 B5): the account that owns it is named by
// the integration, the frontier's notice is written to it, and the Crossref lookup, the result impact path and the memory
// labels the app composes all read it — and with no account named by a test it is the platform publisher account's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { recordFrontierNotices } from "../src/sourceChanges.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const hex = (character, length = 64) => character.repeat(length);
const DOI = "10.9999/app.retracted";

/** @param {Record<string, any>} extra */
function appWith(dataDir, extra = {}) {
  return createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl, sourceIngestionEnabled: false, ...extra });
}

test("through the server: a retraction the frontier recorded reaches a result and a memory by the app's own lookup and impact path, with Crossref never asked", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-source-change-app-"));
  const asked = [];
  /** @type {string | null} */ let platformId = null;
  const app = appWith(dataDir, { sourceChangesOwnerUserId: () => platformId,
    sourceUpdatesFetch: async (/** @type {any} */ request) => { asked.push(String(request)); throw new Error("no network in this test"); } });
  const created = [];
  try {
    const platform = await app.store.createUser(`scp${randomUUID().slice(0, 8)}`, "test-only-platform-password", "Platform publisher fixture");
    created.push(platform.id);
    const user = await app.store.createUser(`scr${randomUUID().slice(0, 8)}`, "test-only-researcher-password", "Source change researcher");
    created.push(user.id);
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const documents = app.sourceService.documents;
    const versionId = `rv_${hex("7")}`;
    await documents.put(user.id, "result-version", versionId, { recordType: "result-version", versionId, artifactId: `ra_${hex("6")}`, projectId: project.id,
      path: "analysis/pooled.md", digest: hex("5"), size: 10, mimeType: "text/markdown", capturedAt: "2026-10-05T00:00:00.000Z",
      producer: { kind: "tool", runId: "run-1" }, inputs: [{ kind: "source", id: DOI, digest: hex("1"), versionId: null, availability: "captured" }],
      machineValues: [], findings: [], coverage: { gaps: [] }, storagePath: `result-snapshots/${hex("5")}`, bindingSources: [] },
    { expectedRevision: 0, projectId: project.id });
    const fact = await app.researchMemory.upsertRecord(user.id, { scope: "project", scopeId: project.id, kind: "project_fact", key: "project.pooled",
      value: "the pooled finding", summary: "pooled", origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false }, null,
    { sourceLinks: [{ type: "doi", id: DOI }] });

    // The integration has named no account yet: the record knows nothing and refuses writes, and the app goes on.
    assert.equal((await app.sourceChanges.get(DOI)).state, "unknown");
    await recordFrontierNotices(app.sourceChanges, [{ kind: "retraction", noticeDoi: "10.9999/n1", doi: DOI, date: "2026-10-01" }]);
    assert.equal(app.sourceChanges.stats().writeFailures, 1);

    platformId = platform.id;
    await recordFrontierNotices(app.sourceChanges, [{ kind: "retraction", noticeDoi: "10.9999/n1", doi: DOI, date: "2026-10-01" }]);
    assert.equal((await app.sourceChanges.get(DOI)).state, "changed");

    const statuses = await app.sourceUpdates.lookupStatuses([DOI]);
    assert.equal(statuses.get(DOI)?.state, "changed");
    assert.deepEqual(asked, [], "the lookup was answered from the record");
    const reply = await app.resultImpacts.reconcileSourceUpdate(user.id, { projectId: project.id, source: { id: DOI, doi: DOI }, status: statuses.get(DOI) });
    assert.deepEqual(reply.items.map(item => item.payload.versionId), [versionId]);
    assert.equal((await app.researchMemory.sourceLinks(user.id, fact.id))[0].state, "retracted");
    const notices = (await app.notificationService.list(user.id, { projectId: project.id })).items;
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /来源发布了更正或撤回通知/);

    // The same facts, taken by position and never asked for.
    const caught = await app.resultImpacts.reconcileSince(user.id, { projectId: project.id });
    assert.deepEqual(caught.items.map(item => item.payload.versionId), [versionId]);
    assert.equal(caught.cursor, 1);
    assert.equal(app.sourceChanges.stats().recorded.crossref, 1);
    assert.deepEqual(asked, []);
  } finally {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [created]).catch(() => {});
    await app.close().catch(() => app.store.close());
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("through the server: with no account named by a test the record belongs to the platform publisher account, and the lookup, the impact path and the labels read it", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-source-change-app-"));
  const app = appWith(dataDir);
  try {
    // The control plane's own migration creates the publisher account; the record is written under it and nobody else's.
    assert.ok(app.sourceChanges);
    assert.ok(app.sourceUpdates && app.resultImpacts && app.knowledgeChange);
    assert.equal(app.resultImpacts.sourceChanges, app.sourceChanges);
    assert.equal(app.knowledgeChange.sourceChanges, app.sourceChanges);
    const doi = `10.9999/publisher.${randomUUID().slice(0, 8)}`;
    await recordFrontierNotices(app.sourceChanges, [{ kind: "retraction", noticeDoi: `${doi}.notice`, doi, date: "2026-10-01" }]);
    assert.equal(app.sourceChanges.stats().writeFailures, 0);
    assert.equal((await app.sourceChanges.get(doi)).state, "changed");
    const owners = await app.sourceService.documents.database.query(
      "SELECT DISTINCT user_id FROM evimed_product.documents WHERE kind = 'source-change' AND payload->>'identifier' = $1", [`doi:${doi}`]);
    assert.deepEqual(owners.rows.map((/** @type {any} */ row) => row.user_id), [PLATFORM_PUBLISHER_USER_ID]);
  } finally {
    await app.close().catch(() => app.store.close());
    await rm(dataDir, { recursive: true, force: true });
  }
});
