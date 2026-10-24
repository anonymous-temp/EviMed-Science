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
