// 「记忆地图」 is one document assembled from independent sources: what the aggregator guarantees is the id grammar, the caps,
// that a source which fails costs its own part and nothing else, and that what must never be drawn is not.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  MAP_EDGES, MAP_FOCUS_NODES, MAP_OVERVIEW_NODES, blocksOf, buildMemoryMap, createMemoryMapRoutes, egoOf, foldToFit, rangeOf,
} from "../src/memoryMap.mjs";
import { edgeIdOf } from "../src/memoryMapEdges.mjs";
import { nodeId, parseNodeId } from "../src/memoryMapSources/common.mjs";
import { recordsContribution } from "../src/memoryMapSources/records.mjs";
import { HttpError, sendError } from "../src/security.mjs";

const NOW = new Date("2026-10-12T08:00:00Z");
const user = { id: "usr_1" };
const projects = [{ id: "prj_a", name: "心衰随访" }, { id: "prj_b", name: "季度预算" }];

function record(overrides = {}) {
  return {
    id: "rec_1", scope: "user", scopeId: "", kind: "preference", key: "style.length", value: "回答要短", summary: "回答要短",
    origin: "inferred", status: "active", importance: 0.5, confidence: 0.6, sensitive: false, version: 1,
    createdAt: "2026-09-01T01:00:00Z", updatedAt: "2026-09-01T01:00:00Z", validFrom: null, invalidSince: null, expiresAt: null, supersededBy: null,
    provenance: { basis: "inferred", observations: 1, runs: 1, conversations: 1 }, revisions: [], evidence: [],
    ...overrides,
  };
}
const source = (name, answer) => ({ name, read: async () => answer });
const build = (sources, request = {}) => buildMemoryMap({ sources }, { user, projects, now: NOW, ...request });

test("a mark's id is <type>:<id>, split at the first colon only", () => {
  assert.equal(nodeId("memory", "rec_1"), "memory:rec_1");
  assert.deepEqual(parseNodeId("reference:doi:10.1056/nejmoa2034577"), { type: "reference", id: "doi:10.1056/nejmoa2034577" });
  assert.equal(parseNodeId("nocolon"), null);
  assert.equal(parseNodeId(":x"), null);
  assert.equal(parseNodeId("memory:"), null);
});

test("the range is days in the researcher's zone: a named span, all, or two dates", () => {
  assert.deepEqual(rangeOf(undefined, NOW, "Asia/Shanghai"), { from: null, to: "2026-10-12", unit: "month" });
  assert.deepEqual(rangeOf("30d", NOW, "Asia/Shanghai"), { from: "2026-09-13", to: "2026-10-12", unit: "day" });
  assert.deepEqual(rangeOf("1y", NOW, "UTC").unit, "week");
  assert.deepEqual(rangeOf("2026-07-14..2026-07-14", NOW, "UTC"), { from: "2026-07-14", to: "2026-07-14", unit: "day" });
  assert.deepEqual(rangeOf("2026-08-01..2026-07-01", NOW, "UTC"), { from: "2026-07-01", to: "2026-08-01", unit: "day" }, "dates the wrong way round are put right");
  assert.throws(() => rangeOf("last week", NOW, "UTC"), { code: "memory_map_invalid" });
  assert.throws(() => rangeOf("2026-13-45..2026-14-01", NOW, "UTC"), { code: "memory_map_invalid" });
  // 08:00Z is already the 12th in Shanghai and still the 11th at 20:00Z the day before.
  assert.equal(rangeOf("30d", new Date("2026-10-11T20:00:00Z"), "Asia/Shanghai").to, "2026-10-12");
  assert.equal(rangeOf("30d", new Date("2026-10-11T20:00:00Z"), "UTC").to, "2026-10-11");
});

test("a request names the blocks it wants, and events are not among the defaults", () => {
  assert.deepEqual([...blocksOf("")].sort(), ["buckets", "edges", "facets", "lanes", "nodes", "summary"]);
  assert.deepEqual([...blocksOf("events,summary")].sort(), ["events", "summary"]);
  assert.throws(() => blocksOf("nodes,secrets"), { code: "memory_map_invalid" });
});

test("a source that fails costs its own part and is named in missing; the others are drawn as they would have been", async () => {
  const good = recordsContribution([record()], {}, { now: NOW, timeZone: "UTC" });
  const map = await build([
    source("records", good),
    { name: "documents", read: async () => { throw new Error("db down"); } },
    { name: "topics", read: () => new Promise(() => {}) , applies: () => false },
    source("activity", { missing: ["feedback"], buckets: [{ t: "2026-10-01", run: 2 }] }),
  ]);
  assert.deepEqual(map.missing, ["documents", "feedback"], "a source that stood aside was never asked and is not missing");
  assert.equal(map.summary.memories, 1);
  assert.deepEqual(map.nodes.map((node) => node.id).sort(), ["memory:rec_1", "you:account"]);
  assert.equal(map.version, 1);
  assert.deepEqual(map.buckets.series.map((bucket) => [bucket.t, bucket.run]), [["2026-09-01", 0], ["2026-10-01", 2]], "the memory's own day and the ledger's");
});

test("a source that never answers is given up on, not waited for", async () => {
  // The timeout is 8 s; a source that stands aside is not read at all, and one that answers late loses only itself.
  const slow = { name: "slow", read: () => new Promise((resolve) => setTimeout(() => resolve({ nodes: [{ id: "method:m", type: "method", label: "x" }] }), 50)) };
  const map = await build([slow, source("records", { nodes: [{ id: "method:n", type: "method", label: "n" }] })]);
  assert.deepEqual(map.nodes.map((node) => node.id).sort(), ["method:m", "method:n"]);
});

test("a run summary, a sensitive memory and a forgotten one are never drawn", async () => {
  const contribution = recordsContribution([
    record({ id: "ok" }),
    record({ id: "summary", kind: "run_summary" }),
    record({ id: "secret", sensitive: true }),
    record({ id: "gone", status: "archived" }),
    record({ id: "session", scope: "session", scopeId: "ses_1" }),
  ], {}, { now: NOW, timeZone: "UTC" });
  const map = await build([source("records", contribution)], { include: "nodes,events,lanes" });
  assert.deepEqual(map.nodes.filter((node) => node.type === "memory").map((node) => node.id), ["memory:ok"]);
  assert.deepEqual(map.events.map((event) => event.ref), ["memory:ok"], "nor an event about one");
});

test("nothing the platform keeps for itself about a memory reaches the document", async () => {
  const contribution = recordsContribution([record({ origin: "inferred", provenance: { basis: "inferred" }, confidence: 0.3 })], {}, { now: NOW, timeZone: "UTC" });
  const map = await build([source("records", contribution)], { include: "summary,facets,nodes,edges,buckets,lanes,events" });
  const text = JSON.stringify(map);
  assert.doesNotMatch(text, /inferred|provenance|basis|origin|confidence|推断/u);
});

test("a memory is marked when a source it rests on was withdrawn, when it is in disagreement, or when its date has passed", async () => {
  const records = [
    record({ id: "a" }), record({ id: "b" }), record({ id: "c" }), record({ id: "d", expiresAt: "2026-09-30T00:00:00Z" }), record({ id: "e" }), record({ id: "f" }),
  ];
  const links = {
    sources: [
      { recordId: "a", type: "doi", id: "10.1/x", state: "retracted", linkedAt: null },
      { recordId: "e", type: "knowledge_source", id: "src_1", state: "changed", linkedAt: null },
      { recordId: "f", type: "knowledge_source", id: "src_2", state: "current", linkedAt: null },
    ],
    conflicts: [{ recordId: "b", otherId: "c", recordStatus: "active", otherStatus: "active" }],
    usage: {},
  };
  const map = await build([source("records", recordsContribution(records, links, { now: NOW, timeZone: "UTC" }))]);
  const reason = Object.fromEntries(map.nodes.filter((node) => node.type === "memory").map((node) => [node.id, [node.state, node.reason]]));
  assert.deepEqual(reason, {
    "memory:a": ["check", "source-retracted"], "memory:b": ["check", "conflict"], "memory:c": ["check", "conflict"],
    "memory:d": ["check", "expired"], "memory:e": ["check", "source-changed"], "memory:f": ["current", null],
  });
  assert.equal(map.summary.needsLook, 5);
  assert.ok(map.edges.some((edge) => edge.type === "conflicts" && edge.from === "memory:b" && edge.to === "memory:c"));
  const rests = map.edges.find((edge) => edge.from === "memory:a" && edge.type === "rests-on");
  assert.deepEqual(rests, { from: "memory:a", to: "reference:doi:10.1/x", type: "rests-on", state: "retracted", at: null, id: edgeIdOf(rests) });
});

test("every line has a stable id, and a line the account called wrong is left out of the map and of what hangs only from it", async () => {
  const records = [record({ id: "a" }), record({ id: "b" })];
  const links = { sources: [{ recordId: "a", type: "doi", id: "10.1/x", state: "current", linkedAt: null }, { recordId: "b", type: "knowledge_source", id: "src_1", state: "current", linkedAt: null }], conflicts: [], usage: {} };
  const sources = [source("records", recordsContribution(records, links, { now: NOW, timeZone: "UTC" }))];
  const whole = await build(sources);
  const again = await build(sources);
  assert.deepEqual(whole.edges.map((edge) => edge.id), again.edges.map((edge) => edge.id), "the same line has the same id in two reads");
  assert.ok(whole.edges.every((edge) => /^e_[0-9a-f]{24}$/.test(edge.id)));
  assert.equal(new Set(whole.edges.map((edge) => edge.id)).size, whole.edges.length);
  const wrong = whole.edges.find((edge) => edge.type === "rests-on" && edge.from === "memory:a");
  const structure = whole.edges.find((edge) => edge.type === "belongs-to");
  const cut = await build(sources, { dismissedEdges: new Set([wrong.id, structure.id]) });
  assert.equal(cut.edges.some((edge) => edge.id === wrong.id), false, "the line the researcher called wrong is not drawn");
  assert.equal(cut.nodes.some((node) => node.id === "reference:doi:10.1/x"), false, "an outside source nothing rests on any more is not a mark");
  assert.ok(cut.edges.some((edge) => edge.id === structure.id), "structure is never a claim to dismiss: a belongs-to line stays");
  assert.ok(cut.nodes.some((node) => node.id === "memory:a"), "the memory itself is still remembered");
  assert.equal(cut.summary.memories, whole.summary.memories);
  // Another account's corrections are another account's: a set that names nothing here changes nothing.
  assert.deepEqual((await build(sources, { dismissedEdges: new Set(["e_000000000000000000000000"]) })).edges, whole.edges);
});

test("a disagreement that is settled, or that a replaced memory was a side of, is no reason to look", async () => {
  const records = [record({ id: "a" }), record({ id: "b", status: "superseded", supersededBy: "a", invalidSince: "2026-09-20T00:00:00Z" })];
  const links = { sources: [], conflicts: [{ recordId: "a", otherId: "b", recordStatus: "active", otherStatus: "superseded" }], usage: {} };
  const map = await build([source("records", recordsContribution(records, links, { now: NOW, timeZone: "UTC" }))]);
  assert.equal(map.nodes.find((node) => node.id === "memory:a").state, "current");
  assert.equal(map.nodes.find((node) => node.id === "memory:b").state, "replaced");
  assert.ok(!map.edges.some((edge) => edge.type === "conflicts"));
  assert.ok(map.edges.some((edge) => edge.type === "replaces" && edge.from === "memory:a" && edge.to === "memory:b"));
});

test("a belief that changed is a lane: each version over the interval it held, oldest first", async () => {
  const records = [
    record({ id: "v1", kind: "decision", scope: "project", scopeId: "prj_a", summary: "纳入 ≥16 岁", status: "superseded", supersededBy: "v2", createdAt: "2026-08-01T00:00:00Z", invalidSince: "2026-09-01T00:00:00Z" }),
    record({ id: "v2", kind: "decision", scope: "project", scopeId: "prj_a", summary: "纳入 ≥18 岁", status: "superseded", supersededBy: "v3", createdAt: "2026-09-01T00:00:00Z", invalidSince: "2026-10-01T00:00:00Z" }),
    record({ id: "v3", kind: "decision", scope: "project", scopeId: "prj_a", summary: "纳入 ≥18 岁且有影像", createdAt: "2026-10-01T00:00:00Z" }),
    record({ id: "alone", kind: "decision", scope: "project", scopeId: "prj_a", summary: "只做 ITT" }),
  ];
  const map = await build([source("records", recordsContribution(records, { conflicts: [{ recordId: "v3", otherId: "alone", recordStatus: "active", otherStatus: "active" }] }, { now: NOW, timeZone: "UTC" }))]);
  assert.equal(map.lanes.length, 1, "a memory that never changed is no lane");
  assert.deepEqual(map.lanes[0].segments.map((segment) => [segment.recordId, segment.state, segment.from, segment.to, segment.conflict]), [
    ["v1", "replaced", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", false],
    ["v2", "replaced", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", false],
    ["v3", "current", "2026-10-01T00:00:00.000Z", null, true],
  ]);
  assert.equal(map.lanes[0].label, "纳入 ≥18 岁且有影像");
  assert.equal(map.lanes[0].projectId, "prj_a");
  const replaces = map.edges.filter((edge) => edge.type === "replaces").map((edge) => [edge.from, edge.to]);
  assert.deepEqual(replaces.sort(), [["memory:v2", "memory:v1"], ["memory:v3", "memory:v2"]]);
});

test("the second radar counts memories in force under fixed named aspects, now and thirty days before, on one scale", async () => {
  const records = [
    record({ id: "p1", kind: "profile" }), record({ id: "p2", kind: "preference" }), record({ id: "p3", kind: "preference", createdAt: "2026-10-05T00:00:00Z" }),
    record({ id: "p4", kind: "decision", scope: "project", scopeId: "prj_a", createdAt: "2026-10-10T00:00:00Z" }),
    record({ id: "old", kind: "preference", status: "superseded", supersededBy: "p3", createdAt: "2026-08-01T00:00:00Z", invalidSince: "2026-10-05T00:00:00Z" }),
  ];
  const map = await build([source("records", recordsContribution(records, {}, { now: NOW, timeZone: "UTC" }))]);
  const memory = map.facets.dimensions.find((dimension) => dimension.id === "memory");
  assert.deepEqual(memory.axes.map((axis) => axis.label), ["背景", "偏好", "工作与写作习惯", "纠正过的", "项目事实", "已定的决策"]);
  const preference = memory.axes.find((axis) => axis.id === "aspect:preference");
  assert.deepEqual([preference.value, preference.previousValue, preference.count], [2, 2, 2], "one now (two in force), and two a month ago (one of them since replaced)");
  assert.equal(memory.scale, "count");
  assert.equal(memory.total, 4);
  assert.equal(memory.axes.find((axis) => axis.id === "aspect:decision").previousValue, 0);
});

test("a range keeps the marks that began inside it and what they are tied to", async () => {
  const records = [
    record({ id: "early", createdAt: "2026-06-01T00:00:00Z" }),
    record({ id: "mid", createdAt: "2026-09-20T00:00:00Z" }),
    record({ id: "late", createdAt: "2026-10-10T00:00:00Z", status: "superseded", supersededBy: "mid" }),
  ];
  const links = { sources: [{ recordId: "mid", type: "doi", id: "10.1/y", state: "current", linkedAt: null }], conflicts: [], usage: {} };
  const sources = [source("records", recordsContribution(records, links, { now: NOW, timeZone: "UTC" }))];
  const all = await build(sources);
  assert.equal(all.nodes.filter((node) => node.type === "memory").length, 3);
  const month = await build(sources, { range: "30d" });
  assert.deepEqual(month.nodes.filter((node) => node.type === "memory").map((node) => node.id).sort(), ["memory:late", "memory:mid"]);
  assert.ok(month.nodes.some((node) => node.id === "reference:doi:10.1/y"), "what a kept memory rests on is kept");
  const week = await build(sources, { range: "2026-10-09..2026-10-12" });
  assert.deepEqual(week.nodes.filter((node) => node.type === "memory").map((node) => node.id).sort(), ["memory:late", "memory:mid"], "mid is kept as what late replaced");
  assert.deepEqual(week.scope.range, { from: "2026-10-09", to: "2026-10-12", unit: "day" });
  const none = await build(sources, { range: "2026-01-01..2026-01-02" });
  assert.deepEqual(none.nodes, []);
  assert.equal(none.summary.memories, 0);
});

test("the calendar is the last year whatever the range, and the sources' days add up", async () => {
  const map = await build([
    source("records", { buckets: [{ t: "2026-05-01", memory: 2 }, { t: "2026-10-11", memory: 1 }] }),
    source("activity", { buckets: [{ t: "2026-10-11", run: 3, feedback: 1 }] }),
  ], { range: "30d" });
  assert.deepEqual(map.buckets.series, [
    { t: "2026-05-01", memory: 2, run: 0, method: 0, feedback: 0 },
    { t: "2026-10-11", memory: 1, run: 3, method: 0, feedback: 1 },
  ]);
});

function crowd(count, { projectId = "prj_a", kind = "project_fact", prefix = "m" } = {}) {
  return Array.from({ length: count }, (_, index) => record({
    id: `${prefix}${String(index).padStart(4, "0")}`, scope: "project", scopeId: projectId, kind, summary: `记忆 ${index}`,
    importance: (index % 10) / 10, createdAt: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00Z`,
  }));
}

test("an overview never draws more than the cap: the rest is folded into clusters by project and kind, and it is counted", async () => {
  const records = [...crowd(300), ...crowd(90, { projectId: "prj_b", kind: "decision", prefix: "d" }), record({ id: "look", scope: "project", scopeId: "prj_a" })];
  const links = { sources: [{ recordId: "look", type: "doi", id: "10.1/z", state: "retracted", linkedAt: null }], conflicts: [], usage: {} };
  const map = await build([source("records", recordsContribution(records, links, { now: NOW, timeZone: "UTC" }))]);
  assert.ok(map.nodes.length <= MAP_OVERVIEW_NODES, `${map.nodes.length} marks`);
  assert.ok(map.edges.length <= MAP_EDGES);
  assert.ok(map.truncated.nodes > 200 && map.truncated.nodes < 391, `${map.truncated.nodes} folded`);
  assert.equal(map.summary.memories, 391, "the headline counts every memory, folded or not");
  assert.ok(map.nodes.some((node) => node.id === "memory:look"), "a mark that needs a second look is never folded");
  const clusters = map.nodes.filter((node) => node.type === "cluster");
  assert.ok(clusters.length > 0);
  assert.equal(clusters.reduce((sum, node) => sum + node.count, 0), map.truncated.nodes);
  assert.ok(clusters.some((node) => node.id.startsWith("cluster:memory:prj_a:")) && clusters.some((node) => node.id.startsWith("cluster:memory:prj_b:")), "by project and kind");
  const ids = new Set(map.nodes.map((node) => node.id));
  assert.ok(map.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to), "no line ends in a mark that is not drawn");
});

test("a cluster is opened by focusing on it, and a mark by focusing on it with a depth", async () => {
  const records = [...crowd(260), record({ id: "other", scope: "project", scopeId: "prj_b", kind: "decision" })];
  const sources = [source("records", recordsContribution(records, {}, { now: NOW, timeZone: "UTC" }))];
  const overview = await build(sources);
  const cluster = overview.nodes.find((node) => node.type === "cluster");
  assert.equal(cluster.id, "cluster:memory:prj_a:project_fact");
  const opened = await build(sources, { focus: cluster.id });
  assert.equal(opened.scope.focus, cluster.id);
  assert.ok(opened.nodes.length <= MAP_FOCUS_NODES && opened.nodes.length > 100);
  assert.ok(opened.nodes.filter((node) => node.type === "memory").every((node) => node.projectId === "prj_a"));
  assert.ok(opened.nodes.some((node) => node.id === "project:prj_a"), "the cluster's project is its neighbour");

  const one = await build(sources, { focus: "memory:m0003", depth: 1 });
  assert.deepEqual(one.nodes.map((node) => node.id).sort(), ["memory:m0003", "project:prj_a"]);
  const two = await build(sources, { focus: "memory:m0003", depth: 2 });
  assert.ok(two.nodes.length > 100, "two lines out reaches the project's other memories");
  assert.ok(two.nodes.length <= MAP_FOCUS_NODES);
  assert.equal(two.scope.depth, 2);
  assert.equal(two.truncated.nodes, 263 - two.nodes.length, "what a focus leaves out is counted");

  const lost = await build(sources, { focus: "memory:nobody" });
  assert.equal(lost.scope.focus, null, "a focus that names nothing is the overview");
  await assert.rejects(() => build(sources, { focus: "not-an-id" }), { code: "memory_map_invalid" });
});

test("foldToFit and egoOf are the pure halves: a small map is untouched, a source chain is walked by depth", () => {
  const nodes = [{ id: "memory:a", type: "memory" }, { id: "document:b", type: "document" }];
  assert.deepEqual(foldToFit(nodes, [], 10), { nodes, edges: [], folded: 0 });
  const chain = ["a", "b", "c", "d"].map((id) => ({ id: `memory:${id}`, type: "memory" }));
  const edges = [["a", "b"], ["b", "c"], ["c", "d"]].map(([from, to]) => ({ from: `memory:${from}`, to: `memory:${to}`, type: "replaces" }));
  assert.deepEqual(egoOf(chain, edges, "memory:a", 1, 10).nodes.map((node) => node.id).sort(), ["memory:a", "memory:b"]);
  assert.deepEqual(egoOf(chain, edges, "memory:a", 2, 10).nodes.map((node) => node.id).sort(), ["memory:a", "memory:b", "memory:c"]);
  assert.equal(egoOf(chain, edges, "memory:zzz", 1, 10), null);
  assert.deepEqual(egoOf(chain, edges, "memory:a", 2, 2).nodes.length, 2, "the cap is kept");
});

test("a memory of a project the account no longer has hangs from 「其他」", async () => {
  const contribution = recordsContribution([record({ id: "orphan", scope: "project", scopeId: "prj_gone", kind: "project_fact" })], {}, { now: NOW, timeZone: "UTC" });
  const map = await build([source("records", contribution)]);
  const other = map.nodes.find((node) => node.type === "project");
  assert.equal(other.label, "其他");
  assert.ok(map.edges.some((edge) => edge.from === "memory:orphan" && edge.to === other.id));
  assert.equal(map.nodes.find((node) => node.id === "memory:orphan").projectId, "__other");
});

test("a topic is attached to the marks it holds that are drawn, and one with none left is not shown", async () => {
  const contribution = recordsContribution([record({ id: "a" }), record({ id: "b" })], {}, { now: NOW, timeZone: "UTC" });
  const map = await build([source("records", contribution), source("topics", {
    facets: { topics: [
      { id: "topic:1", label: "回答风格", weight: 2, trend: 1, members: ["memory:a", "memory:b", "memory:gone"] },
      { id: "topic:2", label: "没有了", weight: 1, trend: 0, members: ["memory:gone"] },
    ] },
    facts: { topicsStatus: "stale" },
  })]);
  assert.deepEqual(map.facets.topics.map((topic) => [topic.id, topic.members]), [["topic:1", ["memory:a", "memory:b"]]]);
  assert.deepEqual(map.nodes.find((node) => node.id === "memory:a").topics, ["topic:1"]);
  assert.equal(map.status.topics, "stale");
});

test("a source that is only a seam contributes nothing, and is not missing", async () => {
  const { createNativeMemorySource } = await import("../src/memoryMapSources/nativeMemory.mjs");
  const { createKnowledgeGraphSource } = await import("../src/memoryMapSources/knowledgeGraph.mjs");
  const map = await build([createNativeMemorySource(), createKnowledgeGraphSource()], { engine: "native" });
  assert.deepEqual(map.nodes, []);
  assert.deepEqual(map.missing, []);
});

// ------------------------------------------------------------------ routes

async function serve(t, handler) {
  const server = createServer((req, res) => {
    handler(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end("{}"); } }, (error) => sendError(res, error, {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function routes(overrides = {}) {
  const calls = [];
  const handler = createMemoryMapRoutes({
    config: { memoryEnabled: true, memoryMapEnabled: true, maxJsonBytes: 100_000 },
    researchMemory: { configured: true, getRecord: async (_user, id) => { if (id === "mine") return record({ id }); if (id === "secret") return record({ id, sensitive: true }); throw new HttpError(404, "memory_not_found", "Memory not found."); } },
    sources: [source("records", recordsContribution([record()], {}, { now: NOW, timeZone: "UTC" }))],
    store: {
      requireProject: async (_user, id) => { calls.push(["project", id]); if (id === "theirs") throw new HttpError(404, "project_not_found", "Project not found."); return { id }; },
      listProjects: async () => projects,
    },
    context: async () => ({ user, project: { id: "prj_a" } }),
    decodeRouteComponent: (value) => decodeURIComponent(value),
    isInternalProject: (_user, id) => id === "evimed-frontier",
    recordLinks: async (_user, found) => ({ rests: [], replaced: [], replacedBy: null, conflicts: [], usedIn: [], for: found.id }),
    ...overrides,
  });
  return { handler, calls };
}

test("GET /api/memory/map answers the document, and another account's project is a 404 before anything is read", async (t) => {
  const { handler, calls } = routes();
  const base = await serve(t, handler);
  const ok = await fetch(`${base}/api/memory/map?timeZone=Asia/Shanghai`);
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.equal(data.version, 1);
  assert.equal(data.scope.timeZone, "Asia/Shanghai");
  assert.deepEqual(data.nodes.map((node) => node.id).sort(), ["memory:rec_1", "you:account"]);
  assert.ok(!("events" in data), "events are asked for");
  assert.ok("events" in (await (await fetch(`${base}/api/memory/map?include=events`)).json()).data);

  const theirs = await fetch(`${base}/api/memory/map?projectId=theirs`);
  assert.equal(theirs.status, 404);
  assert.equal((await theirs.json()).code, "project_not_found");
  const internal = await fetch(`${base}/api/memory/map?projectId=evimed-frontier`);
  assert.equal(internal.status, 404, "the platform's own projects are not the researcher's");
  assert.equal((await fetch(`${base}/api/memory/map?range=forever`)).status, 400);
  assert.equal((await fetch(`${base}/api/memory/map?timeZone=Mars/Base`)).status, 400);
  assert.equal((await fetch(`${base}/api/memory/map`, { method: "POST" })).status, 405);
  assert.ok(calls.some(([, id]) => id === "theirs"));
});

test("the map is off with the memory subsystem or with its own switch, and says so by name", async (t) => {
  for (const config of [{ memoryEnabled: false }, { memoryMapEnabled: false }]) {
    const { handler } = routes({ config: { maxJsonBytes: 1000, memoryEnabled: true, memoryMapEnabled: true, ...config } });
    const base = await serve(t, handler);
    const response = await fetch(`${base}/api/memory/map`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "memory_map_disabled");
  }
});

test("a memory's links are its own: another account's record, and a sensitive one, are a 404", async (t) => {
  const { handler } = routes();
  const base = await serve(t, handler);
  const mine = await fetch(`${base}/api/memory/records/mine/links`);
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).data.for, "mine");
  assert.equal((await fetch(`${base}/api/memory/records/theirs/links`)).status, 404);
  assert.equal((await fetch(`${base}/api/memory/records/secret/links`)).status, 404);
  assert.equal(await (await fetch(`${base}/api/memory/elsewhere`)).status, 404, "it answers only its own paths");
});
