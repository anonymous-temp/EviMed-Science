import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingResources } from "../src/openVikingResources.mjs";
import { OpenVikingSourceSync, sourceRendition } from "../src/openVikingSourceSync.mjs";
import { sourceReadable } from "../src/sourceService.mjs";
import { createOpenVikingStub } from "./helpers/openVikingResourcesStub.mjs";

const sha256 = text => createHash("sha256").update(text).digest("hex");
const id = n => `src_${n.toString(16).padStart(32, "0")}`;
function fixture(count = 1) {
  const engine = createOpenVikingStub();
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed" }, { fetchImpl: engine.fetch });
  const resources = new OpenVikingResources({ client }), records = new Map();
  for (let n = 1; n <= count; n += 1) records.set(id(n), { id: id(n), kind: "source", projectId: "project", revision: 1, deletedAt: null,
    payload: { paths: [`knowledge-base/${n}.md`], status: "complete", generation: 1, docType: "paper", fingerprint: { sha256: sha256(`file${n}`) },
      metadata: { title: `Title ${n}` }, analysis: { generation: 1, textSha256: sha256(`Body ${n}`) } } });
  const sources = {
    async get(_user, sourceId) { return records.get(sourceId) ?? null; },
    async loadCapture(_user, source) { return { input: { text: `Body ${Number.parseInt(source.id.slice(4), 16)}` },
      extractor: { name: "fixture", version: "1", parser: "local" }, metadata: source.payload.metadata, pageMap: source.payload.pageMap ?? null }; },
    async list(_user, { projectId, state, limit, cursor }) {
      const items = [...records.values()].filter(row => row.projectId === projectId && (state !== "ready" || sourceReadable(row.payload)));
      const offset = Number(cursor ?? 0);
      return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
    },
  };
  const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, sources, resources, jobs: {} });
  return { engine, resources, sources, records, sync };
}

test("source convergence updates rendered metadata and page markers even when captured text is unchanged", async () => {
  const f = fixture(), uri = f.resources.sourceUri("owner", "project", id(1));
  assert.equal((await f.sync.convergeSource("owner", id(1))).action, "pushed");
  assert.equal((await f.sync.convergeSource("owner", id(1))).action, "unchanged");
  const beforeSha = f.records.get(id(1)).payload.analysis.textSha256;
  f.records.get(id(1)).payload.metadata.title = "Corrected title";
  f.records.get(id(1)).payload.pageMap = [{ page: 1, start: 0, end: 6, status: "ok" }];
  assert.equal((await f.sync.convergeSource("owner", id(1))).action, "pushed");
  assert.match(f.engine.text(uri), /Corrected title/); assert.match(f.engine.text(uri), /<!-- page 1 -->/);
  const tags = await f.resources.attrs("owner", uri);
  assert.equal(tags.sha, beforeSha);
  assert.equal(tags.rendition, sha256(f.engine.text(uri)));
  // Old tagged copies get a rendered receipt on their next convergence.
  f.engine.files.get(uri).tags = f.engine.files.get(uri).tags.filter(tag => !tag.startsWith("rendition="));
  assert.equal((await f.sync.convergeSource("owner", id(1))).action, "pushed");
});

test("reconciliation includes readable partial captures and detects metadata-only changes before applying", async () => {
  const f = fixture(101);
  f.records.get(id(101)).payload.status = "needs_attention";
  for (const sourceId of f.records.keys()) await f.sync.convergeSource("owner", sourceId);
  let report = await f.sync.reconcileProject("owner", "project", { apply: false });
  assert.equal(report.expected, 101); assert.deepEqual(report.extra, []);
  f.records.get(id(101)).payload.metadata.title = "Corrected partial source";
  report = await f.sync.reconcileProject("owner", "project", { apply: false });
  assert.deepEqual(report.stale, [id(101)]);
  report = await f.sync.reconcileProject("owner", "project");
  assert.equal(report.pushed, 1);
  const uri = f.resources.sourceUri("owner", "project", id(101));
  assert.equal(f.engine.text(uri), sourceRendition(f.records.get(id(101)), await f.sources.loadCapture("owner", f.records.get(id(101)))));
  report = await f.sync.reconcileProject("owner", "project", { apply: false });
  assert.deepEqual([report.missing, report.stale, report.extra], [[], [], []]);
});

test("a compiled alias removes only its derived source copy and a bounded scan never removes unseen sources", async () => {
  const f = fixture(), uri = f.resources.sourceUri("owner", "project", id(1));
  await f.sync.convergeSource("owner", id(1));
  const otherUri = f.resources.sourceUri("owner", "other-project", id(1));
  f.engine.put(otherUri, "Other project copy");
  f.records.get(id(1)).payload.paths.push("knowledge-base/wiki/generated.md");
  assert.equal((await f.sync.convergeSource("owner", id(1))).action, "removed");
  assert.equal(f.engine.text(uri), null);
  assert.equal(f.engine.text(otherUri), "Other project copy");
  assert.ok(await f.sources.loadCapture("owner", f.records.get(id(1))));
  const wide = fixture(5001);
  await assert.rejects(wide.sync.reconcileProject("owner", "project"), { code: "ov_resource_scan_incomplete" });
  assert.equal(wide.engine.requests.length, 0, "an incomplete inventory cannot mutate the engine");
});

/** The periodic pass alone: project and library reconciliation are counted, never run. */
function reconcileFixture() {
  const records = new Map();
  const documents = {
    async get(userId, kind, id) { return records.get(`${userId}:${kind}:${id}`) ?? null; },
    async put(userId, kind, id, payload, options) {
      const key = `${userId}:${kind}:${id}`;
      const previous = records.get(key);
      assert.equal(previous?.revision ?? 0, options.expectedRevision);
      const value = { id, payload, revision: options.expectedRevision + 1 };
      records.set(key, value);
      return value;
    },
  };
  const seen = [];
  const libraries = [];
  const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, sources: { documents }, resources: { configured: true }, jobs: {} });
  sync.reconcileProject = async (userId, projectId) => {
    assert.ok(projectId, "library-only scopes must not reconcile a nonexistent project");
    seen.push(`${userId}:${projectId}`);
    return { pushed: 0, removed: 0, failed: [] };
  };
  sync.reconcileLibrary = async (userId) => { libraries.push(userId); return { pushed: 0, removed: 0, failed: [] }; };
  return { sync, records, seen, libraries };
}

test("periodic reconciliation persists attempts so more than fifty projects make progress", async () => {
  const { sync, records, seen } = reconcileFixture();
  const scopes = Array.from({ length: 201 }, (_, i) => ({ userId: "u1", projectId: `p${String(i).padStart(3, "0")}` }));
  const projects = async () => [...scopes].sort((a, b) => {
    const at = (scope) => records.get(`${scope.userId}:preferences:ov-resource-check:${scope.projectId}`)?.payload.checkedAt ?? "";
    return at(a).localeCompare(at(b)) || a.projectId.localeCompare(b.projectId);
  }).slice(0, 200);
  for (let pass = 0; pass < 5; pass++) await sync.reconcileAll({ projects });
  assert.equal(new Set(seen).size, 201);
  assert.equal(records.size, 201);
});

test("library-only owners remain in the reconciliation pass", async () => {
  const { sync, libraries, seen } = reconcileFixture();
  const result = await sync.reconcileAll({ projects: async () => [{ userId: "library-only", projectId: null }] });
  assert.equal(result.error, null);
  assert.deepEqual(seen, []);
  assert.deepEqual(libraries, ["library-only"]);
});

test("a table imported from the researcher's own database is never pushed to the engine, however the push is asked for, and one pushed earlier is withdrawn", async () => {
  const f = fixture(2);
  const queued = [];
  const sync = new OpenVikingSourceSync({ config: { ovKnowledgeEnabled: true }, sources: f.sources, resources: f.resources, jobs: { async enqueue(...args) { queued.push(args); return {}; } } });
  // The second document is a table imported from a database: its bytes sit in the databases folder's revision directory.
  f.records.get(id(2)).payload.paths = [`knowledge-base/databases/.evimed-revisions/${sha256("table")}/public.cohort-1a2b3c4d.csv`];
  f.records.get(id(2)).payload.logicalPath = "knowledge-base/databases/public.cohort-1a2b3c4d.csv";
  const table = f.records.get(id(2)), uri = f.resources.sourceUri("owner", "project", id(2));
  assert.equal(OpenVikingSourceSync.pushable(f.records.get(id(1))), true);
  assert.equal(OpenVikingSourceSync.pushable(table), false, "readable, in a project and parsed, and still not for the engine");
  assert.equal(OpenVikingSourceSync.pushable({ ...table, payload: { ...table.payload, paths: ["knowledge-base/cohort.csv"] } }), true, "the same record anywhere else is a document");
  // A change event asks for nothing, and an ordinary document's does.
  assert.equal(await sync.note("owner", "project", id(2)), null); assert.equal(queued.length, 0);
  await sync.note("owner", "project", id(1)); assert.equal(queued.length, 1);
  // A convergence leaves the engine without it; reconciliation does not expect it.
  assert.equal((await sync.convergeSource("owner", id(2))).action, "absent");
  assert.equal(f.engine.files.has(uri), false);
  assert.equal((await sync.convergeSource("owner", id(1))).action, "pushed");
  let report = await sync.reconcileProject("owner", "project", { apply: false });
  assert.equal(report.expected, 1); assert.deepEqual(report.missing, []); assert.deepEqual(report.extra, []);
  // A copy the engine already holds (from before the rule, or by hand) is withdrawn by the next convergence and by reconciliation.
  await f.resources.pushSource("owner", uri, "rows of a table", { sourceId: id(2), sha: sha256("table"), docType: "dataset" });
  assert.equal(f.engine.files.has(uri), true);
  report = await sync.reconcileProject("owner", "project", { apply: false });
  assert.deepEqual(report.extra, [id(2)]);
  report = await sync.reconcileProject("owner", "project");
  assert.equal(report.removed, 1); assert.equal(f.engine.files.has(uri), false);
});
