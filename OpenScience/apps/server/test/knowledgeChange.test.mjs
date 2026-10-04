import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SOURCE_CHANGE_LINK_STATES } from "@evimed/domain";
import { loadConfig } from "../src/config.mjs";
import { MEMORY_SOURCE_STATES } from "../src/researchMemoryPersistence.mjs";
import { KnowledgeChangeService, memoryLinkOf, producingAgenda } from "../src/knowledgeChange.mjs";
import { ResultImpactService } from "../src/resultImpact.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const rv = letter => `rv_${letter.repeat(64)}`;
const SRC_OLD = `src_${"a".repeat(32)}`;
const SRC_NEW = `src_${"b".repeat(32)}`;
const BYTES_OLD = "c".repeat(64);
const DOI = "10.9999/paper";
const source = (id, extra = {}) => ({ kind: "source", id, digest: `${"1".repeat(63)}2`, versionId: null, availability: "captured", ...extra });
const binding = (calculationId, key, printed) => ({ basis: "matched", printed, calculation: { versionId: calculationId, key, value: 1, unit: null } });
const correction = (kind = "correction") => ({ state: "changed", checkedAt: "2026-10-04T00:00:00Z", updates: [{ kind, noticeDoi: "10.9999/notice", date: "2026-10-01", source: "publisher" }] });
const NOW = new Date("2026-10-04T12:00:00Z");

/** A small project: a pooled calculation resting on the paper, a report whose numbers are bound to it, a report that cites the paper
 * itself, a second calculation on other data and the report bound to that one, and a report that rests on nothing. */
function project({ calculationInputs = [source(DOI)] } = {}) {
  const versions = [
    { versionId: rv("1"), path: "results/pool.json", digest: "9".repeat(64), inputs: calculationInputs, machineValues: [{ key: "pooled", value: 0.71 }], bindings: { items: [] }, findings: [], producer: { runId: "run-agenda" } },
    { versionId: rv("2"), path: "report.md", digest: "8".repeat(64), inputs: [], machineValues: [], bindings: { items: [binding(rv("1"), "pooled", "0.71"), binding(rv("1"), "ci.low", "0.5")] }, findings: [], producer: { runId: "run-agenda" } },
    { versionId: rv("3"), path: "cited.md", digest: "7".repeat(64), inputs: [source(DOI)], machineValues: [], bindings: { items: [] },
      findings: [{ elementId: "CLM-9", sourceRefs: [{ id: DOI }] }], producer: { runId: "run-chat" } },
    { versionId: rv("4"), path: "results/other.json", digest: "6".repeat(64), inputs: [source("10.9999/other")], machineValues: [{ key: "x", value: 2 }], bindings: { items: [] }, findings: [] },
    { versionId: rv("5"), path: "other-report.md", digest: "5".repeat(64), inputs: [], machineValues: [], bindings: { items: [binding(rv("4"), "x", "2")] }, findings: [] },
    { versionId: rv("6"), path: "unrelated.md", digest: "4".repeat(64), inputs: [], machineValues: [], bindings: { items: [] }, findings: [] },
  ];
  const containing = (version, filter) => (filter.inputs ? filter.inputs.some(want => (version.inputs ?? []).some(input => Object.entries(want).every(([key, value]) => input[key] === value)))
    : filter.bindingSources ? (version.bindings?.items ?? []).some(item => filter.bindingSources.includes(item.calculation.versionId)) : true);
  const results = {
    async scope(userId, projectId) { if (userId === "alice" && projectId === "p") return { userId: "alice", id: "p" }; throw new Error("scope denied"); },
    async list() { return { items: structuredClone(versions), nextCursor: null }; },
    async get(userId, projectId, id) {
      const row = versions.find(item => item.versionId === id);
      if (!row) throw Object.assign(new Error("Unavailable"), { status: 404, code: "result_version_unavailable" });
      return structuredClone(row);
    },
    async query(_user, _project, filter) { return { items: structuredClone(versions.filter(version => containing(version, filter))), nextCursor: null }; },
  };
  return { versions, results };
}

function memoryDouble({ rows = [], fail = false } = {}) {
  const calls = [];
  return {
    calls, configured: true,
    async dependentsOfSource(_user, link) {
      calls.push(["dependents", link]);
      if (fail) throw Object.assign(new Error("db down"), { code: "memory_unavailable" });
      return rows.map(row => ({ ...row }));
    },
    async markSourceLinks(_user, link, finding) {
      calls.push(["mark", link, finding]);
      const moved = rows.filter(row => finding.onlyFrom.includes(row.state) && row.state !== finding.state);
      for (const row of moved) row.state = finding.state;
      return { recordIds: moved.map(row => row.recordId) };
    },
  };
}
const memoryRow = (recordId, over = {}) => ({ recordId, scope: "project", scopeId: "p", kind: "project_fact", key: "k", status: "active", state: "current", ...over });

function methodsDouble({ linked = {}, fail = false } = {}) {
  const labels = [];
  return {
    labels,
    async methodsLinkedTo(_user, versionId) {
      if (fail) throw new Error("ledger down");
      return (linked[versionId] ?? []).map(id => ({ id, payload: { frontmatter: { name: id }, provenance: { results: id.startsWith("learnt") ? [{ versionId }] : [] } } }));
    },
    async recordSourceChange(_user, methodId, entry) { labels.push({ methodId, entry }); return { added: true }; },
  };
}

function fixture({ memory = memoryDouble(), methods = methodsDouble(), authorize = null, autoRecheckLimit, ...options } = {}) {
  const documents = productDocumentsDouble();
  const { versions, results } = project(options);
  const calls = [];
  const notices = new Map();
  const knowledge = new KnowledgeChangeService({ memory, methods, now: () => NOW });
  const service = new ResultImpactService({ documents, results, knowledge, now: () => NOW, authorizeContinuation: authorize,
    ...(autoRecheckLimit === undefined ? {} : { autoRecheckLimit }),
    notifications: { async create(_user, input) { notices.set(input.idempotencyKey, input); } },
    autopilot: { async schedule(_user, agendaId, input) { calls.push({ agendaId, input }); return { episode: { id: `episode-${input.requestId}` } }; } } });
  return { service, documents, versions, calls, notices, memory, methods };
}

const impactsOf = async f => (await f.service.list("alice", { projectId: "p" })).items;

test("a correction finds the calculation, the report bound to it and the report that cites it, and nothing else", async () => {
  const f = fixture();
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  const byVersion = new Map(reply.items.map(item => [item.payload.versionId, item.payload]));
  assert.deepEqual([...byVersion.keys()].sort(), [rv("1"), rv("2"), rv("3")], "the other calculation, its report and the unrelated report are not affected");
  const report = byVersion.get(rv("2"));
  assert.equal(report.affected.via, "calculation");
  assert.equal(report.coverage, "calculation_bindings");
  assert.deepEqual(report.affected.calculations.items, [{ versionId: rv("1"), path: "results/pool.json", boundValues: 2, keys: ["pooled", "ci.low"] }]);
  const calculation = byVersion.get(rv("1"));
  assert.equal(calculation.affected.via, "input");
  assert.deepEqual(calculation.affected.dependents.items.map(item => [item.versionId, item.boundValues]), [[rv("2"), 2]]);
  assert.equal(byVersion.get(rv("3")).affected.via, "input");
  assert.deepEqual(byVersion.get(rv("3")).claimIds, ["CLM-9"]);
  for (const payload of byVersion.values()) {
    assert.equal(payload.recomputed, false);
    assert.equal(payload.historicalResultPreserved, true);
  }
  assert.deepEqual(f.versions.map(version => version.versionId), [1, 2, 3, 4, 5, 6].map(n => rv(String(n))), "nothing was deleted or reordered");
});

test("unaffected work is not asked to run again: a recheck names only what rests on the source", async () => {
  const f = fixture();
  const { items } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  const report = items.find(item => item.payload.versionId === rv("2"));
  await f.documents.put("alice", "agenda", "running", { enabled: true, status: "active" }, { expectedRevision: 0, projectId: "p" });
  const scheduled = await f.service.continueImpact("alice", "p", report.id, { agendaId: "running" });
  assert.equal(scheduled.payload.continuation.status, "scheduled");
  const note = f.calls[0].input.note;
  assert.ok(note.includes(rv("1")), "the calculation that rests on the source is named");
  assert.ok(!note.includes(rv("4")) && !note.includes(rv("5")) && !note.includes(rv("6")), "no unaffected version is named");
  assert.match(note, /Recheck only what rests on this source and leave every other result/);
  assert.match(note, /does not by itself show the result's conclusion is wrong/);
  assert.match(note, /Preserve the prior result/);
});

test("the inbox says the source changed and what rests on it, never that a result is wrong", async () => {
  const f = fixture({ memory: memoryDouble({ rows: [memoryRow("m1"), memoryRow("m2", { scope: "user", scopeId: null })] }),
    methods: methodsDouble({ linked: { [rv("2")]: ["learnt-pooling"] } }) });
  await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  const bodies = [...f.notices.values()].map(item => item.body);
  assert.equal(f.notices.size, 3, "one notice per affected result version");
  for (const body of bodies) {
    assert.match(body, /不说明原来的结论有误/);
    assert.doesNotMatch(body, /(结论|结果)(已)?(错误|不成立|无效)/);
    assert.match(body, /2 条记忆/);
  }
  assert.ok(bodies.some(body => /1 个计算/.test(body) && /1 个方法/.test(body)), "the report names its calculation and the method linked to it");
});

test("memories that name the source are labelled with its new state and listed only where the project may see them", async () => {
  const memory = memoryDouble({ rows: [memoryRow("mine"), memoryRow("account", { scope: "user", scopeId: null }), memoryRow("other-project", { scopeId: "q" }),
    memoryRow("old", { status: "superseded" }), memoryRow("session", { scope: "session", scopeId: "s" })] });
  const f = fixture({ memory });
  const { items } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction("retraction") });
  const mark = memory.calls.find(call => call[0] === "mark");
  assert.deepEqual(mark[1], { type: "doi", id: DOI });
  assert.equal(mark[2].state, "retracted");
  assert.equal(mark[2].reason, "retraction");
  assert.ok(mark[2].onlyFrom.includes("changed") && !mark[2].onlyFrom.includes("retracted"), "a retraction may outrank a correction and is not rewritten by itself");
  assert.ok(memory.calls.filter(call => call[0] === "mark").length === 1, "one statement labels every dependent at once, not one per result");
  for (const item of items) {
    assert.deepEqual(item.payload.affected.memories.items.map(entry => entry.recordId).sort(), ["account", "mine"]);
    assert.ok(item.payload.affected.memories.items.every(entry => entry.state === "retracted"));
    assert.equal(item.payload.affected.memories.total, 2);
  }
});

test("a failed lookup is unknown, never none and never clean, and it does not fail the check", async () => {
  const f = fixture({ memory: memoryDouble({ fail: true }), methods: methodsDouble({ fail: true }) });
  const reported = [];
  f.service.knowledge.report = code => reported.push(code);
  const { items } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  assert.equal(items.length, 3, "the impacts are still recorded");
  for (const item of items) {
    assert.deepEqual([item.payload.affected.memories.status, item.payload.affected.methods.status], ["unknown", "unknown"]);
    assert.equal(item.payload.affected.memories.total, 0);
  }
  assert.ok(reported.includes("memory_unavailable"), "the failure is traceable");
  for (const notice of f.notices.values()) assert.match(notice.body, /暂时查不到，不能当作没有/);
  const none = fixture({ memory: memoryDouble({ rows: [] }) });
  const clean = await none.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  assert.equal(clean.items[0].payload.affected.memories.status, "none", "an answered lookup that found nothing is none");
  const absent = new ResultImpactService({ documents: productDocumentsDouble(), results: project().results, now: () => NOW });
  const bare = await absent.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  assert.equal(bare.items[0].payload.affected.memories.status, "unknown", "a deployment without the memory service did not look");
});

test("a check that could not answer leaves a correction found earlier and marks only a link nobody had a finding on", async () => {
  const memory = memoryDouble({ rows: [memoryRow("a", { state: "changed" }), memoryRow("b", { state: "current" })] });
  const f = fixture({ memory });
  await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: { state: "unavailable", checkedAt: null, reason: "timeout", updates: [] } });
  const mark = memory.calls.find(call => call[0] === "mark");
  assert.deepEqual([mark[2].state, mark[2].reason, mark[2].onlyFrom], ["unknown", "check_timeout", ["current"]]);
  assert.equal((await memory.dependentsOfSource()).find(row => row.recordId === "a").state, "changed", "the earlier finding stands");
  assert.equal((await memory.dependentsOfSource()).find(row => row.recordId === "b").state, "unknown");
  assert.equal(f.notices.size, 0, "a gap is not announced as a change");
  assert.ok((await impactsOf(f)).every(item => item.payload.effect === "source_gap"));
});

test("a clean answer sets right a link an earlier outage left unknown and nothing else, and creates no impact", async () => {
  const memory = memoryDouble({ rows: [memoryRow("a", { state: "unknown" }), memoryRow("b", { state: "retracted" })] });
  const f = fixture({ memory });
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: { state: "no_update", checkedAt: "2026-10-04T00:00:00Z", updates: [] } });
  assert.deepEqual(reply.items, []);
  const states = Object.fromEntries((await memory.dependentsOfSource()).map(row => [row.recordId, row.state]));
  assert.deepEqual(states, { a: "current", b: "retracted" });
});

test("learned methods linked to the affected versions are labelled once, by how they meet the result", async () => {
  const methods = methodsDouble({ linked: { [rv("1")]: ["learnt-pool-method"], [rv("2")]: ["used-report-method"] } });
  const f = fixture({ methods });
  const first = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI, doi: DOI }, status: correction() });
  const labelled = new Set(methods.labels.map(label => label.methodId));
  assert.deepEqual([...labelled].sort(), ["learnt-pool-method", "used-report-method"]);
  const pool = methods.labels.find(label => label.methodId === "learnt-pool-method").entry;
  assert.equal(pool.state, "changed");
  assert.equal(pool.reason, "correction");
  assert.equal(pool.relation, "learnt_from");
  assert.deepEqual(pool.source, { id: DOI, doi: DOI });
  const report = first.items.find(item => item.payload.versionId === rv("2")).payload;
  assert.deepEqual(report.affected.methods.items.map(item => item.id).sort(), ["learnt-pool-method", "used-report-method"], "a calculation's method reaches the report bound to it");
  const again = methods.labels.length;
  await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI, doi: DOI }, status: correction() });
  assert.deepEqual(methods.labels.slice(again).map(label => label.entry.id).sort(), methods.labels.slice(0, again).map(label => label.entry.id).sort(),
    "the same change is offered with the same identity, which the method record deduplicates");
});

test("a source gap labels no method: there is no change to record", async () => {
  const methods = methodsDouble({ linked: { [rv("3")]: ["used-report-method"] } });
  const f = fixture({ methods });
  await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: { state: "unknown", checkedAt: null, reason: "not_in_crossref", updates: [] } });
  assert.deepEqual(methods.labels, []);
});

test("a later check refreshes what rests on the same change without moving its continuation", async () => {
  const memory = memoryDouble({ rows: [] });
  const f = fixture({ memory });
  const first = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  const cited = first.items.find(item => item.payload.versionId === rv("3"));
  assert.equal(cited.payload.affected.memories.status, "none");
  memory.calls.length = 0;
  const written = memoryDouble({ rows: [memoryRow("late")] });
  f.service.knowledge.memory = written;
  const second = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  const again = second.items.find(item => item.payload.versionId === rv("3"));
  assert.equal(again.id, cited.id, "one change is one impact");
  assert.equal(again.payload.affected.memories.total, 1);
  assert.equal(again.payload.continuation.status, "awaiting_user");
  assert.equal(again.revision, cited.revision + 1);
  const third = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  assert.equal(third.items.find(item => item.payload.versionId === rv("3")).revision, again.revision, "an unchanged answer writes nothing");
});

test("a revoked calculation input redacts the reports that rested on the source through it", async () => {
  const f = fixture();
  const { items } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  const report = items.find(item => item.payload.versionId === rv("2"));
  f.versions[0].inputs[0].availability = "restricted";
  const redacted = await f.service.get("alice", "p", report.id);
  assert.deepEqual(redacted.payload.source, { id: "unavailable-source" });
  assert.equal(redacted.payload.affected, undefined);
  assert.equal(JSON.stringify(redacted).includes(rv("1")), false);
  const recheck = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction("retraction") });
  assert.ok(!recheck.items.some(item => item.payload.versionId === rv("2")), "a calculation whose source is restricted brings in no dependents");
});

test("a knowledge-base replacement finds what read the old document by its recorded identifiers and nothing by its name", async () => {
  const memory = memoryDouble({ rows: [memoryRow("fact")] });
  const f = fixture({ memory, calculationInputs: [{ kind: "data", id: "knowledge-base/trial.xlsx", path: "knowledge-base/trial.xlsx", digest: BYTES_OLD, availability: "captured" }] });
  f.versions[5].inputs = [{ kind: "data", id: "knowledge-base/trial-2.xlsx", digest: "d".repeat(64), availability: "captured" }];
  const reply = await f.service.reconcileReplacement("alice", { projectId: "p", replaced: { sourceId: SRC_OLD, sha256: BYTES_OLD }, by: { sourceId: SRC_NEW, at: "2026-10-04T10:00:00Z" } });
  assert.deepEqual(reply.items.map(item => item.payload.versionId).sort(), [rv("1"), rv("2")], "the calculation that read the old bytes and the report bound to it");
  const [first] = reply.items;
  assert.equal(first.payload.sourceStatus.state, "changed");
  assert.equal(first.payload.sourceStatus.updates[0].kind, "replaced");
  assert.equal(first.payload.source.replacedBy, SRC_NEW);
  assert.equal(first.payload.source.contentDigest, BYTES_OLD);
  assert.deepEqual(memory.calls.find(call => call[0] === "mark")[1], { type: "knowledge_source", id: SRC_OLD });
  assert.equal(memory.calls.find(call => call[0] === "mark")[2].reason, "replaced");
  assert.ok([...f.notices.values()].every(notice => /资料库里这份文件有了新版本/.test(notice.body)));
  const again = await f.service.reconcileReplacement("alice", { projectId: "p", replaced: { sourceId: SRC_OLD, sha256: BYTES_OLD }, by: { sourceId: SRC_NEW, at: "2026-10-04T10:00:00Z" } });
  assert.deepEqual(again.items.map(item => item.id).sort(), reply.items.map(item => item.id).sort(), "reading the same replacement again is the same impact");
  const other = await f.service.reconcileReplacement("alice", { projectId: "p", replaced: { sourceId: `src_${"e".repeat(32)}`, sha256: "e".repeat(64) } });
  assert.deepEqual(other.items, [], "a document nothing recorded is a source of nothing");
});

test("a memory that names a replaced document is found by its src id even when no result of the project does", async () => {
  const memory = memoryDouble({ rows: [memoryRow("fact")] });
  const f = fixture({ memory });
  const reply = await f.service.reconcileReplacement("alice", { projectId: "p", replaced: { sourceId: SRC_OLD, sha256: BYTES_OLD }, by: { sourceId: SRC_NEW } });
  assert.deepEqual(reply.items, []);
  assert.equal(memory.calls.find(call => call[0] === "mark")[2].state, "changed");
  assert.equal(f.notices.size, 1, "the inbox still says a source the memories rest on changed");
  assert.match([...f.notices.values()][0].body, /1 条记忆/);
  assert.doesNotMatch([...f.notices.values()][0].body, /暂时查不到/, "no result and no method link is a finished lookup, not a failed one");
});

test("an agenda the researcher is running rechecks without a further approval; a paused or not started one is not started", async () => {
  const f = fixture({ authorize: async (_owner, impact) => (impact.payload.versionId === rv("3") ? "running" : impact.payload.versionId === rv("2") ? "paused" : null) });
  await f.documents.put("alice", "agenda", "running", { enabled: true, status: "active" }, { expectedRevision: 0, projectId: "p" });
  await f.documents.put("alice", "agenda", "paused", { enabled: false, status: "paused" }, { expectedRevision: 0, projectId: "p" });
  const { items } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  const status = Object.fromEntries(items.map(item => [item.payload.versionId, item.payload.continuation.status]));
  assert.equal(status[rv("3")], "scheduled");
  assert.equal(status[rv("2")], "awaiting_user", "a paused agenda starts nothing and the researcher can still choose");
  assert.equal(status[rv("1")], "awaiting_user", "no agenda produced this one");
  assert.deepEqual(f.calls.map(call => call.agendaId), ["running"]);
});

test("automatic rechecks of one change are bounded and a failure leaves the impact for the researcher", async () => {
  const f = fixture({ authorize: async () => "running", autoRecheckLimit: 2 });
  await f.documents.put("alice", "agenda", "running", { enabled: true, status: "active" }, { expectedRevision: 0, projectId: "p" });
  const reported = [];
  f.service.report = code => reported.push(code);
  const { items } = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  assert.equal(items.filter(item => item.payload.continuation.status === "scheduled").length, 2);
  assert.equal(items.filter(item => item.payload.continuation.status === "awaiting_user").length, 1, "the rest wait for the researcher, still visible in the panel");
  const broken = fixture({ authorize: async () => { throw Object.assign(new Error("agenda store down"), { code: "autopilot_unavailable" }); } });
  broken.service.report = code => reported.push(code);
  const reply = await broken.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: correction() });
  assert.equal(reply.items.length, 3, "the labels and impacts survive the failed recheck");
  assert.ok(reported.includes("autopilot_unavailable"));
  assert.equal(broken.calls.length, 0);
});

test("an unknown or unavailable source never starts a recheck", async () => {
  const f = fixture({ authorize: async () => "running" });
  await f.documents.put("alice", "agenda", "running", { enabled: true, status: "active" }, { expectedRevision: 0, projectId: "p" });
  await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: { state: "unknown", checkedAt: null, reason: "not_in_crossref", updates: [] } });
  assert.equal(f.calls.length, 0);
});

test("only identifiers a memory can record are memory links", () => {
  assert.deepEqual(memoryLinkOf({ id: "DOI:10.1000/ABC", doi: "10.1000/ABC" }), { type: "doi", id: "10.1000/abc" });
  assert.deepEqual(memoryLinkOf({ id: SRC_OLD }), { type: "knowledge_source", id: SRC_OLD });
  assert.equal(memoryLinkOf({ id: ".evimed-sources/paper/fulltext.md" }), null, "a path names no memory source");
  assert.equal(memoryLinkOf({ id: "src_short" }), null);
});

test("the agenda that produced a result is the one authorization, and only while it is running", async () => {
  const f = fixture();
  const agendas = new Map([
    ["running", { projectId: "p", payload: { enabled: true, status: "active" } }],
    ["paused", { projectId: "p", payload: { enabled: false, status: "paused" } }],
    ["archived", { projectId: "p", payload: { enabled: true, status: "active", archivedAt: "2026-10-01" } }],
    ["elsewhere", { projectId: "q", payload: { enabled: true, status: "active" } }],
  ]);
  const episodes = { "run-agenda": "running", "run-chat": null, "run-paused": "paused", "run-archived": "archived", "run-elsewhere": "elsewhere" };
  const autopilot = {
    async episodeForRun(_owner, _project, runId) { return episodes[runId] ? { payload: { agendaId: episodes[runId] } } : null; },
    async get(_owner, id) { const row = agendas.get(id); if (!row) throw new Error("gone"); return row; },
  };
  const resolve = producingAgenda({ results: f.service.results, autopilot });
  const impact = (versionId, calculations = []) => ({ projectId: "p", payload: { versionId, affected: { calculations: { items: calculations.map(id => ({ versionId: id })) } } } });
  assert.equal(await resolve("alice", impact(rv("1"))), "running");
  assert.equal(await resolve("alice", impact(rv("2"), [rv("1")])), "running", "a report whose own run is unknown takes the agenda of the calculation it rests on");
  assert.equal(await resolve("alice", impact(rv("3"))), null, "a chat run is no agenda's");
  assert.equal(await resolve("alice", impact(rv("6"))), null);
  for (const [run, expected] of [["run-paused", null], ["run-archived", null], ["run-elsewhere", null]]) {
    f.versions[0].producer = { runId: run };
    assert.equal(await resolve("alice", impact(rv("1"))), expected, run);
  }
  f.versions[0].producer = { runId: "run-agenda" };
  autopilot.episodeForRun = async () => { throw new Error("agenda store down"); };
  assert.equal(await resolve("alice", impact(rv("1"))), null, "a failing lookup is no authorization");
});

test("every state a check gives a link is one the memory store records", () => {
  for (const state of SOURCE_CHANGE_LINK_STATES) assert.ok(MEMORY_SOURCE_STATES.includes(state), state);
});

test("the automatic recheck bound is a lever whose compose fallback is the code's own default and which .env.example names", async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const config = loadConfig({ rootDir: repoRoot });
  assert.equal(config.sourceChangeRecheckLimit, 3);
  assert.equal(loadConfig({ rootDir: repoRoot, sourceChangeRecheckLimit: 0 }).sourceChangeRecheckLimit, 0, "zero turns the automatic recheck off");
  assert.equal(loadConfig({ rootDir: repoRoot, sourceChangeRecheckLimit: 5000 }).sourceChangeRecheckLimit, 20);
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.match(compose, new RegExp(`^ +OPEN_SCIENCE_SOURCE_CHANGE_RECHECK_LIMIT: \\$\\{OPEN_SCIENCE_SOURCE_CHANGE_RECHECK_LIMIT:-${config.sourceChangeRecheckLimit}\\}$`, "m"),
    "a compose fallback that differed from the code's default would override it");
  assert.match(await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8"), new RegExp(`^OPEN_SCIENCE_SOURCE_CHANGE_RECHECK_LIMIT=${config.sourceChangeRecheckLimit}$`, "m"));
});
