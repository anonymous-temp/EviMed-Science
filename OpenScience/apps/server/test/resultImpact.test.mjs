import assert from "node:assert/strict";
import test from "node:test";
import { ResultImpactService, clinicalResultLinks } from "../src/resultImpact.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

async function fixture() {
  const documents = productDocumentsDouble();
  const versions = Array.from({ length: 3 }, (_, index) => ({ versionId: `rv_topic${index}`, projectId: "p",
    digest: String(index).repeat(64), inputs: [{ kind: "source", id: `source-${index}`, digest: `digest-${index}`, versionId: `source-v${index}`, availability: "captured" }],
    findings: index === 0 ? [{ elementId: "CLM-001", sourceRefs: [{ id: "source-0", digest: "digest-0", versionId: "source-v0" }] }] : [] }));
  const notices = new Map();
  const results = {
    async scope(userId, projectId) { if (["alice", "bob"].includes(userId) && projectId === "p") return { userId: "alice", id: "p" }; throw new Error("scope denied"); },
    async list(userId, { projectId }) { return { items: userId === "alice" && projectId === "p" ? versions : [], nextCursor: null }; },
    async get(userId, projectId, id) { const row = userId === "alice" && projectId === "p" ? versions.find(item => item.versionId === id) : null; if (!row) throw Object.assign(new Error("Unavailable"), { code: "result_not_found" }); return structuredClone(row); },
  };
  const service = new ResultImpactService({ documents, results, now: () => new Date("2026-10-02T00:00:00Z"),
    notifications: { async create(_user, input) { notices.set(input.idempotencyKey, input); } } });
  return { service, documents, versions, notices };
}
const change = (kind = "correction") => ({ state: "changed", checkedAt: "2026-10-02T00:00:00Z", updates: [{ kind, noticeDoi: "10.9999/notice", date: "2026-10-01", source: "crossref" }] });

test("three tracked source corrections name only affected immutable results and retain original metadata", async () => {
  const f = await fixture();
  const before = structuredClone(f.versions);
  for (let index = 0; index < 3; index += 1) {
    const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: `source-${index}`, digest: `digest-${index}`, versionId: `source-v${index}` }, status: change(index === 2 ? "retraction" : "correction") });
    assert.equal(reply.items.length, 1);
    assert.equal(reply.items[0].payload.versionId, `rv_topic${index}`);
    assert.equal(reply.items[0].payload.recomputed, false);
    assert.equal(reply.items[0].payload.historicalResultPreserved, true);
    assert.deepEqual(reply.items[0].payload.claimIds, index === 0 ? ["CLM-001"] : []);
  }
  assert.deepEqual(f.versions, before);
  assert.equal(f.notices.size, 3);
  const impacts = await f.service.list("alice", { projectId: "p", versionId: "rv_topic1" });
  assert.equal(impacts.items.length, 1);
});

test("update replay and concurrent checks deduplicate while a second notice remains a distinct versioned impact", async () => {
  const f = await fixture();
  const input = { projectId: "p", source: { id: "source-0" }, status: change() };
  const [a, b] = await Promise.all([f.service.reconcileSourceUpdate("alice", input), f.service.reconcileSourceUpdate("alice", { ...input, status: { ...change(), checkedAt: "2026-10-03T00:00:00Z" } })]);
  assert.equal(a.items[0].id, b.items[0].id);
  assert.equal((await f.service.list("alice", { projectId: "p" })).items.length, 1);
  assert.equal(f.notices.size, 1);
  await f.service.reconcileSourceUpdate("alice", { ...input, status: change("retraction") });
  assert.equal((await f.service.list("alice", { projectId: "p" })).items.length, 2);
});

test("wrong source versions, other owners, restricted inputs and absent full text never acquire result authority", async () => {
  const f = await fixture();
  for (const source of [{ id: "source-0", digest: "wrong" }, { id: "source-0", versionId: "wrong" }, { id: "unknown-source" }]) {
    assert.equal((await f.service.reconcileSourceUpdate("alice", { projectId: "p", source, status: change() })).items.length, 0);
  }
  assert.equal((await f.service.reconcileSourceUpdate("bob", { projectId: "p", source: { id: "source-0" }, status: change() })).items.length, 0);
  f.versions[0].inputs[0].availability = "restricted";
  assert.equal((await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: change() })).items.length, 0);
});

test("unavailability is a recorded source gap", async () => {
  const f = await fixture();
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: { state: "unavailable", checkedAt: null, reason: "timeout", updates: [] } });
  assert.equal(reply.items[0].payload.effect, "source_gap");
  assert.equal(f.notices.size, 0);
});

test("pagination reaches later results", async () => {
  const f = await fixture();
  f.service.results.list = async (_user, { cursor }) => cursor ? { items: [f.versions[1]], nextCursor: null } : { items: [f.versions[0]], nextCursor: "second" };
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-1" }, status: change() });
  assert.equal(reply.scanned, 2);
  assert.equal(reply.items.length, 1);
});

test("a shared reader sees the owner's impact history", async () => {
  const f = await fixture();
  const { items: [impact] } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: change() });
  f.service.results.get = async (_user, _project, id) => f.versions.find(row => row.versionId === id);
  assert.equal((await f.service.list("bob", { projectId: "p" })).items[0].id, impact.id);
  assert.equal((await f.service.get("bob", "p", impact.id)).id, impact.id);
});

test("a trusted source projection reaches actual stored input refs and repeated sources are folded", async () => {
  const f = await fixture();
  f.versions[0].inputs[0].id = "10.9999/paper";
  const source = { doi: "10.9999/paper", artifactPath: "paper.md", updateStatus: change() };
  const reply = await f.service.reconcileVerification("alice", "p", { claims: [{ sources: [source] }, { sources: [source] }] });
  assert.equal(reply.items.length, 1);
  assert.equal(reply.items[0].payload.versionId, "rv_topic0");
});

test("canonical clinical links preserve exact source versions and explicit derived dependencies without inventing capture", () => {
  const capturedSources = new Map([[".evimed-sources/paper/v1/fulltext.md", { digest: "a".repeat(64), versionId: "source-v1" }]]);
  const matrix = { claims: [
    { claimId: "CLM-001", claimType: "direct", identifier: "DOI:10.9999/paper", artifactPath: ".evimed-sources/paper/v1/fulltext.md" },
    { claimId: "CLM-002", claimType: "derived", derivedFrom: ["CLM-001"] },
    { claimId: "CLM-003", claimType: "direct", identifier: "10.9999/metadata" },
    { claimId: "CLM-004", claimType: "derived", derivedFrom: ["CLM-004"] },
    { claimId: "CLM-005", claimType: "direct", artifactPath: "../../protected" },
  ] };
  const links = clinicalResultLinks(matrix, { capturedSources, verdict: { claims: [{ claimId: "CLM-001", status: "verified" }] } });
  assert.equal(links.inputs.length, 2);
  assert.equal(links.inputs[0].digest, "a".repeat(64));
  assert.equal(links.inputs[0].id, "10.9999/paper");
  assert.equal(links.inputs[1].availability, "reference");
  assert.equal(links.inputs[1].digest, null);
  assert.deepEqual(links.findings[1].sourceRefs, links.findings[0].sourceRefs);
  assert.equal(links.findings[1].status, "not_run");
  assert.equal(links.findings.length, 3);
  // The mark is the finding (owner ruling 2026-10-10): the platform's English sentence once under every claim is gone, and what a claim's
  // status says is the reader's two words, drawn by the inspector from the kind and the status.
  assert.deepEqual(links.findings.map(finding => [finding.kind, finding.status, finding.message]),
    [["claim_source_binding", "verified", ""], ["claim_source_binding", "not_run", ""], ["claim_source_binding", "not_run", ""]]);
});
test("current source revocation or deletion redacts public impacts without changing their stored advisory record", async () => {
  for (const availability of ["restricted", "deleted"]) {
    const f = await fixture();
    const { items: [impact] } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: {
      id: "source-0", digest: "digest-0", versionId: "source-v0" }, status: change() });
    const before = await f.documents.get("alice", "result-impact", impact.id);
    f.versions[0].inputs[0].availability = availability;
    const found = await f.service.get("alice", "p", impact.id);
    const listed = (await f.service.list("alice", { projectId: "p", versionId: "rv_topic0" })).items[0];
    for (const row of [found, listed]) {
      assert.deepEqual(row.payload.source, { id: "unavailable-source" });
      assert.deepEqual(row.payload.sourceStatus.updates, []);
      assert.equal(row.payload.sourceStatus.state, "unavailable");
      assert.deepEqual(row.payload.claimIds, []);
      assert.equal(JSON.stringify(row).includes("10.9999/notice"), false);
      assert.equal(JSON.stringify(row).includes("digest-0"), false);
    }
    assert.deepEqual(await f.documents.get("alice", "result-impact", impact.id), before);
  }
});
test("a stale list projection cannot create an impact after the matching source is revoked", async () => {
  const f = await fixture();
  const get = f.service.results.get;
  f.service.results.get = async (...args) => { f.versions[0].inputs[0].availability = "restricted"; return get(...args); };
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: change() });
  assert.deepEqual(reply.items, []);
  assert.equal(f.notices.size, 0);
});

test("binding replacements affect only the exact path and digest, retain source-only memory, and distinguish occurrences", async () => {
  const f = await fixture();
  const sha = "a".repeat(64), sourceId = `src_${"a".repeat(32)}`;
  f.versions.splice(0, f.versions.length, ...[
    { versionId: "original", inputs: [{ kind: "data", path: "knowledge-base/original.txt", id: "original", digest: sha }] },
    { versionId: "copy", inputs: [{ kind: "data", path: "knowledge-base/copy.txt", id: "copy", digest: sha }] },
    { versionId: "content", inputs: [{ kind: "source", id: sourceId, digest: sha }] },
    { versionId: "wrong-digest", inputs: [{ kind: "data", path: "knowledge-base/original.txt", id: "wrong", digest: "b".repeat(64) }] },
  ].map(row => ({ ...row, projectId: "p", findings: [] })));
  f.service.results.query = async (_user, projectId) => ({ items: projectId === "p" ? f.versions : [], nextCursor: null });
  let memoryCalls = 0;
  f.service.knowledge = { memories: async () => { memoryCalls++; return { items: [] }; }, pages: async () => { throw Error("content pages must remain current"); }, methodsFor: async () => ({ items: [] }) };
  const event = { projectId: "p", logicalPath: "knowledge-base/original.txt", familyId: "fam-original", sourceRetired: false,
    replaced: { sourceId, sha256: sha, version: 1 }, by: { sourceId: `src_${"b".repeat(32)}`, version: 2 } };
  const first = await f.service.reconcileReplacement("alice", event);
  assert.deepEqual(first.items.map(row => row.payload.versionId), ["original"]);
  assert.equal(memoryCalls, 0);
  assert.equal((await f.service.reconcileReplacement("alice", event)).items[0].id, first.items[0].id);
  const next = await f.service.reconcileReplacement("alice", { ...event, by: { ...event.by, version: 4 } });
  assert.notEqual(next.items[0].id, first.items[0].id);
  await assert.rejects(f.service.reconcileReplacement("alice", { ...event, projectId: "other-project" }), /scope denied/);
});

test("durable replacements propagate failed page persistence instead of completing an advisory lookup", async () => {
  const f = await fixture();
  f.service.results.query = async () => ({ items: [], nextCursor: null });
  f.service.knowledge = { memories: async () => ({ items: [] }), pages: async () => ({ unknown: "lookup_failed" }) };
  await assert.rejects(f.service.reconcileReplacement("alice", { projectId: "p", replaced: { sourceId: "source-0", sha256: "a".repeat(64) } }), { code: "source_replacement_pages_unavailable" });
  f.service.knowledge.pages = async () => { throw Error("page scheduling failed"); };
  await assert.rejects(f.service.reconcileReplacement("alice", { projectId: "p", replaced: { sourceId: "source-0", sha256: "a".repeat(64) } }), /page scheduling failed/);
  // Other source-update checks retain the existing advisory lookup policy.
  await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "missing" }, status: change() });
});
