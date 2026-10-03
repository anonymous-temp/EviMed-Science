import assert from "node:assert/strict";
import test from "node:test";
import { ResultImpactService, clinicalResultLinks } from "../src/resultImpact.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

async function fixture() {
  const documents = productDocumentsDouble();
  const versions = Array.from({ length: 3 }, (_, index) => ({ versionId: `rv_topic${index}`, projectId: "p",
    digest: String(index).repeat(64), inputs: [{ kind: "source", id: `source-${index}`, digest: `digest-${index}`, versionId: `source-v${index}`, availability: "captured" }],
    findings: index === 0 ? [{ elementId: "CLM-001", sourceRefs: [{ id: "source-0", digest: "digest-0", versionId: "source-v0" }] }] : [] }));
  const calls = [];
  const notices = new Map();
  const results = {
    async scope(userId, projectId) { if (["alice", "bob"].includes(userId) && projectId === "p") return { userId: "alice", id: "p" }; throw new Error("scope denied"); },
    async list(userId, { projectId }) { return { items: userId === "alice" && projectId === "p" ? versions : [], nextCursor: null }; },
    async get(userId, projectId, id) { const row = userId === "alice" && projectId === "p" ? versions.find(item => item.versionId === id) : null; if (!row) throw Object.assign(new Error("Unavailable"), { code: "result_not_found" }); return structuredClone(row); },
  };
  const service = new ResultImpactService({ documents, results, now: () => new Date("2026-10-02T00:00:00Z"),
    notifications: { async create(_user, input) { notices.set(input.idempotencyKey, input); } },
    autopilot: { async schedule(_user, agendaId, input) { if (!calls.some(call => call.input.requestId === input.requestId)) calls.push({ agendaId, input }); return { episode: { id: `episode-${input.requestId}` } }; } } });
  await documents.put("alice", "agenda", "active", { enabled: true, status: "active" }, { expectedRevision: 0, projectId: "p" });
  await documents.put("alice", "agenda", "paused", { enabled: true, status: "paused" }, { expectedRevision: 0, projectId: "p" });
  await documents.put("alice", "agenda", "other", { enabled: true, status: "active" }, { expectedRevision: 0, projectId: "elsewhere" });
  return { service, documents, versions, calls, notices };
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
  assert.equal(f.calls.length, 0, "no research execution without explicit continuation or existing authorization resolver");
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

test("unavailability is a recorded source gap and cannot launch a successor", async () => {
  const f = await fixture();
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: { state: "unavailable", checkedAt: null, reason: "timeout", updates: [] } });
  assert.equal(reply.items[0].payload.effect, "source_gap");
  assert.equal(f.notices.size, 0);
  await assert.rejects(f.service.continueImpact("alice", "p", reply.items[0].id, { agendaId: "active" }), { code: "result_impact_not_changed" });
  assert.equal(f.calls.length, 0);
});

test("continuation rechecks existing same-project authorization, uses bounded agenda and recovers a lost impact CAS", async () => {
  const f = await fixture();
  const { items: [impact] } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: change() });
  for (const agendaId of ["paused", "other", "missing"]) await assert.rejects(f.service.continueImpact("alice", "p", impact.id, { agendaId }), { code: "result_impact_agenda_unauthorized" });
  const originalPut = f.documents.put;
  let interrupted = true;
  f.documents.put = async (...args) => { if (args[1] === "result-impact" && args[3].continuation.status === "scheduled" && interrupted) { interrupted = false; throw new Error("lost connection after schedule"); } return originalPut(...args); };
  await assert.rejects(f.service.continueImpact("alice", "p", impact.id, { agendaId: "active" }), /lost connection/);
  const continued = await f.service.continueImpact("alice", "p", impact.id, { agendaId: "active" });
  assert.equal(continued.payload.continuation.status, "scheduled");
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].input.note, /Preserve the prior result/);
  assert.equal(continued.revision, 3);
  assert.equal((await f.documents.history("alice", "result-impact", impact.id))[0].payload.continuation.status, "scheduled");
});

test("an existing trusted authorization resolver may continue, and pagination reaches later results", async () => {
  const f = await fixture();
  f.service.results.list = async (_user, { cursor }) => cursor ? { items: [f.versions[1]], nextCursor: null } : { items: [f.versions[0]], nextCursor: "second" };
  f.service.authorizeContinuation = async () => "active";
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-1" }, status: change() });
  assert.equal(reply.scanned, 2);
  assert.equal(reply.items[0].payload.continuation.status, "scheduled");
  assert.equal(f.calls.length, 1);
});

test("a shared reader sees owner's impact history but cannot authorize the owner's continuation", async () => {
  const f = await fixture();
  const { items: [impact] } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: change() });
  f.service.results.get = async (_user, _project, id) => f.versions.find(row => row.versionId === id);
  assert.equal((await f.service.list("bob", { projectId: "p" })).items[0].id, impact.id);
  assert.equal((await f.service.get("bob", "p", impact.id)).id, impact.id);
  await assert.rejects(f.service.continueImpact("bob", "p", impact.id, { agendaId: "active" }), { code: "result_impact_agenda_unauthorized" });
  assert.equal(f.calls.length, 0);
});

test("a trusted source projection reaches actual stored input refs and repeated sources are folded", async () => {
  const f = await fixture();
  f.versions[0].inputs[0].id = "10.9999/paper";
  const source = { doi: "10.9999/paper", artifactPath: "paper.md", updateStatus: change() };
  const reply = await f.service.reconcileVerification("alice", "p", { claims: [{ sources: [source] }, { sources: [source] }] });
  assert.equal(reply.items.length, 1);
  assert.equal(reply.items[0].payload.versionId, "rv_topic0");
});

test("concurrent continuations cannot bind one evidence update to two agendas", async () => {
  const f = await fixture();
  await f.documents.put("alice", "agenda", "second", { enabled: true, status: "active" }, { expectedRevision: 0, projectId: "p" });
  const { items: [impact] } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: change() });
  const replies = await Promise.allSettled(["active", "second"].map(agendaId => f.service.continueImpact("alice", "p", impact.id, { agendaId })));
  assert.equal(replies.filter(reply => reply.status === "fulfilled").length, 1);
  assert.equal(f.calls.length, 1);
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
      assert.equal(row.payload.continuation.status, "unavailable");
      assert.equal(JSON.stringify(row).includes("10.9999/notice"), false);
      assert.equal(JSON.stringify(row).includes("digest-0"), false);
    }
    assert.deepEqual(await f.documents.get("alice", "result-impact", impact.id), before);
    await assert.rejects(f.service.continueImpact("alice", "p", impact.id, { agendaId: "active" }), { code: "result_impact_source_unavailable" });
    assert.equal(f.calls.length, 0);
  }
});
test("source access narrowed during continuation preparation cannot reach agenda context or replace stored source evidence", async () => {
  const f = await fixture();
  const { items: [impact] } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: change() });
  const put = f.documents.put;
  f.documents.put = async (...args) => {
    const row = await put(...args);
    if (args[1] === "result-impact" && args[3].continuation.status === "preparing") f.versions[0].inputs[0].availability = "restricted";
    return row;
  };
  await assert.rejects(f.service.continueImpact("alice", "p", impact.id, { agendaId: "active" }), { code: "result_impact_source_unavailable" });
  assert.equal(f.calls.length, 0);
  const stored = await f.documents.get("alice", "result-impact", impact.id);
  assert.equal(stored.payload.source.id, "source-0");
  assert.equal(stored.payload.sourceStatus.updates[0].noticeDoi, "10.9999/notice");
  assert.equal(stored.payload.continuation.status, "preparing");
});
test("a stale list projection cannot create an impact after the matching source is revoked", async () => {
  const f = await fixture();
  const get = f.service.results.get;
  f.service.results.get = async (...args) => { f.versions[0].inputs[0].availability = "restricted"; return get(...args); };
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "source-0" }, status: change() });
  assert.deepEqual(reply.items, []);
  assert.equal(f.notices.size, 0);
  assert.equal(f.calls.length, 0);
});
