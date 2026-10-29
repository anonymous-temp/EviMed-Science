import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSharedKnowledgeContext } from "../src/sharedKnowledgeContext.mjs";
import { OpenVikingResources } from "../src/openVikingResources.mjs";
import { KnowledgePageService } from "../src/knowledgePageService.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const id = `src_${"a".repeat(32)}`;

test("periodic catch-up remembers the exact failed shared input set until input changes or a manual request", async () => {
  let sourceSetDigest = "failed-source-set", enqueued = 0;
  const rows = new Map([
    ["wiki:state:p", { revision: 1, payload: { round: 1, pending: {}, run: { generationId: "kg_generation", step: "wiki" } } }],
    ["kg_generation", { revision: 1, payload: { sourceSetDigest, tasks: { wiki: { taskId: "task" } } } }],
  ]);
  const documents = { database: { withTransactionClient: async (_client, work) => work() },
    get: async (_owner, _kind, key) => rows.get(key), put: async (_owner, _kind, key, payload, { expectedRevision }) => {
      const row = { revision: expectedRevision + 1, payload }; rows.set(key, row); return row;
    } };
  const jobs = { withLease: async (_owner, _id, _token, work) => work({ query: async () => ({ rows: [{ id: "live" }] }) }),
    enqueue: async () => { enqueued++; return { id: "job" }; } };
  const service = new KnowledgePageService({ config: { ovKnowledgeEnabled: true, knowledgePagesMinSources: 1, knowledgePagesDebounceMs: 0 },
    documents, jobs, sources: {}, store: {}, entries: {}, resources: { configured: true, cancelTask: async () => null },
    knowledgeContext: { forProject: async () => ({ kind: "geo-project", inputs: [{}], selected: null, sourceSetDigest }) } });
  await service.recordFailure({ userId: "owner", projectId: "p", id: "job", leaseToken: "lease", payload: { round: 1 } }, "knowledge_compile_failed");
  assert.equal(rows.get("wiki:state:p").payload.lastError.sourceSetDigest, sourceSetDigest);
  assert.equal(await service.catchUp("owner", "p"), "skipped");
  assert.equal(enqueued, 0);
  await service.requestRound("owner", "p");
  assert.equal(enqueued, 1, "an explicit user retry remains available");
  sourceSetDigest = "changed-source-set";
  assert.equal(await service.catchUp("owner", "p"), "scheduled");
  assert.equal(enqueued, 2);
});
function fixture() {
  const project = { userId: "owner", id: "project" };
  const policy = { kind: "geo-project", ownerId: "owner", controlProjectId: "project", ownerCreatedAt: "2026-01-01", projectCreatedAt: "2026-02-01",
    referenceId: "policy", revision: 1, namespace: { id: "namespace" } };
  const text = "Project-only fact.";
  const payload = { generation: 1, version: 1, status: "complete", paths: ["knowledge-base/documents/fact.md"], metadata: { title: "Project title" },
    fingerprint: { sha256: hash("file") }, analysis: { generation: 1, textSha256: hash(text), unitCount: 1, extractor: { name: "test", version: "1" } } };
  const row = { id, kind: "source", projectId: "project", revision: 1, payload, deletedAt: null };
  const capture = { input: { sourceId: id, generation: 1, text, units: [{ id: `${id}:g1:u1`, start: 0, end: text.length, text }] }, metadata: payload.metadata, extractor: payload.analysis.extractor };
  const reads = [];
  const resources = new OpenVikingResources({ client: { configured: true } });
  resources.download = async (_owner, uri) => { reads.push(uri); return Buffer.from(f.input.text); };
  const sources = { get: async (_owner, sourceId) => sourceId === id ? structuredClone(row) : null,
    list: async () => ({ items: [{ id }], nextCursor: null }), loadCapture: async () => structuredClone(capture) };
  const documents = { list: async () => ({ items: [], nextCursor: null }), get: async () => null, history: async () => [] };
  const dependencies = { store: { userById: async owner => owner === "owner" ? { id: owner } : null,
    requireProject: async (_owner, projectId) => { if (projectId !== "project") throw new Error("foreign"); return project; } },
    contextPolicies: { forProject: async () => policy }, sources, documents, resources,
    proveSession: async (_project, sessionId) => sessionId === "associated", sourceScope: async () => [id, `src_${"b".repeat(32)}`] };
  const f = { project, policy, row, capture, reads, resources, sources, dependencies, input: null };
  return f;
}

test("shared project raw sources remain usable before clean generation and forbidden roots are refused before engine reads", async () => {
  const f = fixture();
  const { readKnowledgeSourceInput } = await import("../src/knowledgeGeneration.mjs");
  f.input = await readKnowledgeSourceInput({ sources: f.sources, ownerId: "owner", projectId: "project", sourceId: id });
  const service = createSharedKnowledgeContext(f.dependencies), context = await service.forProject(f.project);
  assert.equal(context.includeLibrary, false); assert.equal(context.selected, null);
  assert.equal(await context.acceptSource({ id }), true);
  const roots = context.resources.roots(), uri = f.resources.sourceUri("owner", "project", id);
  assert.equal(roots.wiki, null); assert.equal(roots.kg, null); assert.equal(roots.library, undefined);
  assert.equal((await context.resources.listAll("owner", roots.sources))[0].uri, uri);
  assert.match(await context.resources.read("owner", uri), /Project-only fact/);
  const before = f.reads.length;
  await assert.rejects(context.resources.read("owner", f.resources.libraryUri("owner", id)), { code: "knowledge_scope_denied" });
  assert.equal(f.reads.length, before);
  assert.deepEqual(await context.sourceScope("associated"), [id]);
  await assert.rejects(context.sourceScope("forged"), { code: "knowledge_scope_denied" });
  assert.doesNotMatch(context.neutral(`private viking://user/private/resources/library/src_${"b".repeat(32)}.md`), /src_|viking:/);
  await context.current();
});

test("a changed policy/source or a corrupt upstream rendition cannot return shared content", async () => {
  const f = fixture(), service = createSharedKnowledgeContext(f.dependencies);
  const { readKnowledgeSourceInput } = await import("../src/knowledgeGeneration.mjs");
  f.input = await readKnowledgeSourceInput({ sources: f.sources, ownerId: "owner", projectId: "project", sourceId: id });
  const context = await service.forWorkload({ userId: "owner", projectId: "project" });
  f.resources.download = async () => Buffer.from("stale owner-wide content");
  await assert.rejects(context.resources.read("owner", f.resources.sourceUri("owner", "project", id)), { code: "knowledge_resource_changed" });
  f.row.revision += 1;
  await assert.rejects(context.current(), { code: "knowledge_scope_denied" });
  f.dependencies.contextPolicies.forProject = async () => { throw new Error("ledger unavailable"); };
  await assert.rejects(service.forProject(f.project), /ledger unavailable/);
  await assert.rejects(service.forWorkload({ userId: "editor", projectId: "project" }), { code: "knowledge_scope_denied" });
});
