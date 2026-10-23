import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgePageService } from "../src/knowledgePageService.mjs";

const id = `src_${"a".repeat(32)}`;
const root = "viking://user/u1/resources/p/p1";
const quote = "The protocol uses UDP port 4123 for synchronization.";
const markdown = `---\ntype: concept\ntitle: Protocol\nsources:\n  - ${root}/sources/${id}.md\n---\n\nThe port is 4123 [Protocol](${root}/sources/${id}.md "${quote}").\n`;
const project = { id: "p1" };
const pageSource = { id: `src_${"b".repeat(32)}`, payload: { paths: ["knowledge-base/wiki/concept/protocol.md"] } };

function fixture({ shared = false } = {}) {
  const record = { projectId: project.id, payload: { tree: "wiki", path: "concept/protocol.md", pageSourceId: pageSource.id } };
  const source = { id, projectId: shared ? "p2" : "p1", revision: 7, payload: { title: "Protocol", status: "complete", version: 4, generation: 2, paths: ["knowledge-base/protocol.md"], fingerprint: { sha256: "c".repeat(64) }, analysis: { textSha256: "d".repeat(64) } } };
  const service = new KnowledgePageService({ config: {}, documents: { async list() { return { items: [record] }; } }, jobs: {}, store: {},
    sources: { async get() { return source; }, async loadCapture() { return { input: { text: quote }, extractor: {} }; } },
    resources: { treeUri: () => `${root}/wiki` }, entries: { async readPage() { return markdown; } },
    libraryText: async () => shared ? `# Personal library protocol\n\n${quote}` : null,
    now: () => new Date("2026-10-23T08:00:00.000Z"),
  });
  return { service, source, record };
}

test("a quotation backed by an authorized personal-library copy remains available", async () => {
  const { service } = fixture({ shared: true });
  const view = await service.pageView("u1", project, pageSource);
  assert.equal(view.links.find((link) => link.kind === "source").status, "present");
  assert.equal(view.sources[0].available, true);
  assert.equal(view.sources[0].title, "Personal library protocol");
});

test("knowledge quotations carry the source version and the time of their check", async () => {
  const { service } = fixture();
  const view = await service.pageView("u1", project, pageSource);
  const link = view.links.find((entry) => entry.kind === "source");
  assert.equal(link.sourceVersion, 4);
  assert.equal(link.checkedAt, "2026-10-23T08:00:00.000Z");
  assert.equal(view.quotations.checkedAt, link.checkedAt);
});

test("library withdrawal notifies actual dependent projects and propagates failures for replay", async () => {
  const { service, record } = fixture();
  record.payload.dependsOn = [id];
  const calls = [];
  service.noteSourcesChanged = async (...args) => { calls.push(args); return { pages: 1 }; };
  await service.noteLibraryChanged("u1", id, "removed");
  assert.deepEqual(calls, [["u1", "p1", [{ sourceId: id, reason: "removed" }], { strict: true }]]);
  service.noteSourcesChanged = async () => { throw new Error("write failed"); };
  await assert.rejects(service.noteLibraryChanged("u1", id, "removed"), /write failed/);
});

test("runtime eligibility excludes a revoked dependency without erasing the historical reader", async () => {
  const { service, record, source } = fixture();
  record.payload.dependsOn = [id];
  assert.equal((await service.browseEligibility("u1", "p1", "wiki", record.payload.path)).allowed, true);
  source.deletedAt = "2026-10-23T09:00:00.000Z";
  assert.equal((await service.browseEligibility("u1", "p1", "wiki", record.payload.path)).allowed, false);
  assert.equal((await service.pageView("u1", project, pageSource)).markdown, markdown);
});
