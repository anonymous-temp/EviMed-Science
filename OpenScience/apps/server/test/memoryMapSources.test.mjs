// The sources of the map, one at a time, and the two seams for packages still being built: the native memory engine and the
// knowledge graph an OpenViking compile writes. The seams are tested against fixtures written in the formats their contracts name.
import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryMap } from "../src/memoryMap.mjs";
import { bucketsOf, createActivitySource, memoryEventsOf } from "../src/memoryMapSources/activity.mjs";
import { requestMemo } from "../src/memoryMapSources/common.mjs";
import { createDocumentsSource, documentNode } from "../src/memoryMapSources/documents.mjs";
import {
  createKnowledgeGraphSource, documentIdOfUri, entityTypeOf, graphFromCompile, parseEntity, parseFrontmatter, parseRelations, parseWikiPage, resolveLink,
} from "../src/memoryMapSources/knowledgeGraph.mjs";
import { createMethodsSource } from "../src/memoryMapSources/methods.mjs";
import { createNativeMemorySource } from "../src/memoryMapSources/nativeMemory.mjs";
import { createRecordLinks } from "../src/memoryMapSources/recordLinks.mjs";
import { createRecordsSource, recordsContribution } from "../src/memoryMapSources/records.mjs";
import { createRunsSource, workDimension, workOf } from "../src/memoryMapSources/runs.mjs";
import { createTopicsSource } from "../src/memoryMapSources/topics.mjs";

const NOW = new Date("2026-10-12T08:00:00Z");
const user = { id: "usr_1" };
const projects = [{ id: "prj_a", name: "心衰随访" }];

function record(overrides = {}) {
  return {
    id: "rec_1", scope: "user", scopeId: "", kind: "preference", key: "style.length", value: "回答要短", summary: "回答要短",
    origin: "inferred", status: "active", importance: 0.5, sensitive: false, version: 1,
    createdAt: "2026-09-01T01:00:00Z", updatedAt: "2026-09-01T01:00:00Z", validFrom: null, invalidSince: null, expiresAt: null, supersededBy: null,
    revisions: [], ...overrides,
  };
}
const request = (overrides = {}) => ({ user, projects, projectId: null, range: { from: null, to: "2026-10-12", unit: "month" }, timeZone: "UTC", now: NOW, engine: "postgres", focus: null, memo: requestMemo(), ...overrides });

test("the records source reads the store once for the nodes and once for what the others share, and nothing it does is a write", async () => {
  let reads = 0;
  const researchMemory = {
    mapRecords: async (userId, options) => { reads += 1; assert.equal(userId, "usr_1"); assert.equal(options.projectId, "prj_a"); return [record({ id: "a", scope: "project", scopeId: "prj_a" }), record({ id: "b", sensitive: true })]; },
    mapLinks: async (_userId, ids) => { assert.deepEqual(ids, ["a"], "a sensitive memory is not even asked about"); return { sources: [], conflicts: [], usage: { a: { count: 10 } } }; },
  };
  const source = createRecordsSource({ researchMemory });
  const asked = request({ projectId: "prj_a" });
  const contribution = await source.read(asked);
  await createDocumentsSource({ sources: { list: async () => ({ items: [] }) }, researchMemory }).read(asked);
  assert.equal(reads, 1, "the second source reuses the first's read");
  assert.deepEqual(contribution.nodes.map((node) => node.id), ["memory:a"]);
  assert.equal(contribution.nodes[0].weight, 0.75, "importance 0.5 and use at its ceiling");
  assert.equal(source.applies(request({ engine: "native" })), false, "an account on the native engine has no PostgreSQL records");
});

test("what a memory rests on becomes a mark: a document by its id, a work by its DOI, a card or a news item by its kind", () => {
  const links = { sources: [
    { recordId: "rec_1", type: "knowledge_source", id: "src_abc", state: "current", linkedAt: "2026-09-02T00:00:00Z" },
    { recordId: "rec_1", type: "doi", id: "10.1056/nejmoa2034577", state: "expired", linkedAt: null },
    { recordId: "rec_1", type: "evidence_card", id: "card_1", state: "unknown", linkedAt: null },
    { recordId: "rec_1", type: "frontier_item", id: "fi_1", state: "unknown", linkedAt: null },
  ], conflicts: [], usage: {} };
  const found = recordsContribution([record()], links, { now: NOW, timeZone: "UTC" });
  const byId = Object.fromEntries(found.nodes.map((node) => [node.id, node]));
  assert.deepEqual(Object.keys(byId).sort(), ["document:src_abc", "memory:rec_1", "reference:doi:10.1056/nejmoa2034577", "reference:evidence_card:card_1", "reference:frontier_item:fi_1"]);
  assert.deepEqual(byId["document:src_abc"].open, { kind: "page", href: "/app/files/src_abc" });
  assert.equal(byId["reference:doi:10.1056/nejmoa2034577"].label, "10.1056/nejmoa2034577");
  assert.equal(byId["memory:rec_1"].reason, "source-expired");
  assert.deepEqual(found.edges.filter((edge) => edge.type === "rests-on").map((edge) => edge.state), ["current", "expired", "unknown", "unknown"]);
});

test("the documents source titles the documents and tells a memory's placeholder what it is", async () => {
  const sources = {
    list: async (_userId, { projectId }) => ({ items: projectId === "prj_a" ? [
      { id: "src_1", projectId, createdAt: "2026-09-10T00:00:00Z", deletedAt: null, payload: { title: "GOLD 2025 报告", docType: "guideline", paths: ["gold.pdf"] } },
      { id: "src_gone", projectId, createdAt: "2026-09-10T00:00:00Z", deletedAt: "2026-09-11T00:00:00Z", payload: { title: "已删除", paths: ["x.pdf"] } },
    ] : [] }),
    get: async (_userId, id) => { if (id === "src_other") return { id, projectId: "prj_z", createdAt: "2026-08-01T00:00:00Z", deletedAt: null, payload: { title: "别处的资料", paths: ["z.pdf"] } }; throw new Error("not found"); },
  };
  const researchMemory = {
    mapRecords: async () => [record()],
    mapLinks: async () => ({ sources: [
      { recordId: "rec_1", type: "knowledge_source", id: "src_other", state: "current", linkedAt: null },
      { recordId: "rec_1", type: "knowledge_source", id: "src_1", state: "current", linkedAt: null },
      { recordId: "rec_1", type: "knowledge_source", id: "src_missing", state: "current", linkedAt: null },
    ], conflicts: [], usage: {} }),
  };
  const asked = request();
  const map = await buildMemoryMap({ sources: [createRecordsSource({ researchMemory }), createDocumentsSource({ sources, researchMemory })] }, { ...asked, projects, include: "nodes,edges" });
  const labels = Object.fromEntries(map.nodes.filter((node) => node.type === "document").map((node) => [node.id, node.label]));
  assert.deepEqual(labels, { "document:src_1": "GOLD 2025 报告", "document:src_other": "别处的资料", "document:src_missing": "一份资料" },
    "a deleted document is not listed, one the memory names is looked up, and one that is gone keeps its place with a plain name");
  assert.ok(map.edges.some((edge) => edge.type === "belongs-to" && edge.from === "document:src_1" && edge.to === "project:prj_a"));
  assert.equal(documentNode({ id: "src_x", projectId: "p", createdAt: "2026-01-01T00:00:00Z", payload: { paths: ["a/b/notes.md"], docType: "other" } }).label, "notes.md", "an untitled document is its file's name");
});

test("a documents read that failed in every project is the source's failure; one project failing is only its own", async () => {
  const asked = request({ projects: [{ id: "p1", name: "一" }, { id: "p2", name: "二" }] });
  const half = createDocumentsSource({ sources: { list: async (_u, { projectId }) => { if (projectId === "p1") throw new Error("boom"); return { items: [{ id: "src_2", projectId, createdAt: "2026-09-01T00:00:00Z", payload: { title: "二的资料", paths: ["a.md"] } }] }; } } });
  assert.deepEqual((await half.read(asked)).nodes.map((node) => node.id), ["document:src_2"]);
  const none = createDocumentsSource({ sources: { list: async () => { throw new Error("db down"); } } });
  await assert.rejects(() => none.read(asked), /db down/);
  assert.equal(createDocumentsSource({ sources: null }).applies(), false);
});

test("the learned methods are marks hanging from the account, named as the memory page names them", async () => {
  const learning = { listMethods: async (_userId, options) => { assert.equal(options.status, "approved"); return { items: [
    { id: "mth_1", createdAt: "2026-09-05T00:00:00Z", payload: { display: { title: "先给结论再给依据", summary: "回答先写结论" }, frontmatter: { name: "answer-first" } } },
    { id: "mth_2", createdAt: "2026-09-06T00:00:00Z", payload: { frontmatter: { name: "write-sql-plan" } } },
    { id: "mth_3", createdAt: "2026-09-07T00:00:00Z", payload: {} },
  ] }; } };
  const source = createMethodsSource({ learning });
  const found = await source.read(request());
  assert.deepEqual(found.nodes.map((node) => [node.id, node.label, node.open]), [
    ["method:mth_1", "先给结论再给依据", { kind: "method", id: "mth_1" }], ["method:mth_2", "write-sql-plan", { kind: "method", id: "mth_2" }],
  ]);
  assert.deepEqual(found.edges.map((edge) => edge.to), ["you:account", "you:account"]);
  assert.equal(source.applies(request({ projectId: "prj_a" })), false, "methods are the account's, not a project's");
});

test("the first radar counts the researcher's own finished conversations by the kind of work, and shows a medical axis only when it was used", () => {
  const run = (id, agent, finishedAt, extra = {}) => ({ id, status: "succeeded", effectiveAgentId: agent, finishedAt, automated: false, ...extra });
  const runs = [
    run("1", "open-domain-answer", "2026-10-05T00:00:00Z"), run("2", "open-domain-answer", "2026-10-06T00:00:00Z"),
    run("3", "manuscript-support", "2026-10-07T00:00:00Z"), run("4", "statistical-analysis", "2026-09-20T00:00:00Z"),
    run("5", "open-domain-answer", "2026-09-01T00:00:00Z"),
    run("x1", "open-domain-answer", "2026-10-08T00:00:00Z", { automated: true }),
    run("x2", "open-domain-answer", "2026-10-08T00:00:00Z", { status: "failed" }),
    run("x3", "open-domain-answer", "2026-10-08T00:00:00Z", { deleted: true }),
    run("x4", "source-understanding", "2026-10-08T00:00:00Z"),
    run("x5", "evolution-scout", "2026-10-08T00:00:00Z"),
    run("x6", "no-such-capability", "2026-10-08T00:00:00Z"),
  ];
  const work = workOf(runs, (agent) => agent === "source-understanding" || agent === "evolution-scout");
  assert.deepEqual(work.map((item) => item.label).sort(), ["普通问答", "普通问答", "普通问答", "研究设计与数据", "写作与传播"].sort());
  const dimension = workDimension(work, NOW);
  assert.deepEqual(dimension.axes.map((axis) => axis.label), ["普通问答", "写作与传播", "研究设计与数据"], "no clinical axis for an account that never used one");
  const byLabel = Object.fromEntries(dimension.axes.map((axis) => [axis.label, axis]));
  assert.deepEqual([byLabel["普通问答"].count, byLabel["普通问答"].value, byLabel["普通问答"].previousValue], [2, 0.5, 1]);
  assert.deepEqual([dimension.total, dimension.previousTotal, dimension.scale], [4, 1, "share"]);
  assert.equal(byLabel["研究设计与数据"].previousValue, 0, "a month ago the account only asked questions");
  const clinical = workDimension(workOf([run("c", "clinical-evidence-synthesis", "2026-10-09T00:00:00Z")]), NOW);
  assert.ok(clinical.axes.some((axis) => axis.label === "临床证据"));
});

test("the runs source reads each project's ledger once, shared with the activity source, and fails only when every ledger did", async () => {
  let reads = 0;
  const agentRuns = { researcherRuns: async (project) => { reads += 1; return [{ id: `r-${project.id}`, status: "succeeded", effectiveAgentId: "open-domain-answer", finishedAt: "2026-10-05T00:00:00Z", sessionId: "s", title: "t" }]; } };
  const projectOf = async (_user, id) => ({ id });
  const asked = request({ projects: [{ id: "p1", name: "一" }, { id: "p2", name: "二" }] });
  const dimension = (await createRunsSource({ agentRuns, projectOf }).read(asked)).facets.dimensions[0];
  const activity = await createActivitySource({ agentRuns, projectOf }).read(asked);
  assert.equal(reads, 2, "two projects, one read each");
  assert.equal(dimension.total, 2);
  assert.equal(activity.buckets[0].run, 2);
  const broken = { researcherRuns: async () => { throw new Error("ledger unreadable"); } };
  await assert.rejects(() => createRunsSource({ agentRuns: broken, projectOf }).read(request({ projects })), /ledger unreadable/);
  const partial = await createActivitySource({ agentRuns: broken, projectOf }).read(request({ projects }));
  assert.deepEqual(partial.missing, ["runs"], "the activity source names the part it could not read and still answers");
});

test("the calendar counts events by day in the researcher's zone, and only the last year", () => {
  const events = [
    { at: "2026-10-11T17:30:00Z", type: "memory" }, { at: "2026-10-11T23:30:00Z", type: "run" }, { at: "2026-10-12T01:00:00Z", type: "run" },
    { at: "2025-09-01T00:00:00Z", type: "memory" }, { at: "2027-01-01T00:00:00Z", type: "memory" },
  ];
  assert.deepEqual(bucketsOf(events, "Asia/Shanghai", NOW), [
    { t: "2026-10-12", memory: 1, run: 2, method: 0, feedback: 0 },
  ], "17:30Z is already the 12th in Shanghai; a year ago and the future are not drawn");
  assert.deepEqual(bucketsOf(events, "UTC", NOW).map((bucket) => [bucket.t, bucket.memory, bucket.run]), [["2026-10-11", 1, 1], ["2026-10-12", 0, 1]]);
  const memories = memoryEventsOf([record({ id: "a", scope: "project", scopeId: "prj_a", kind: "decision" })]);
  assert.deepEqual(memories.map((event) => [event.ref, event.lane, event.kind, event.change]), [["memory:a", "project:prj_a", "decision", "created"]]);
});

test("the topics source serves the grouping as it stands and never groups: members are marks, and the status says if it is due", async () => {
  const topics = {
    configured: true,
    read: async (userId, records) => { assert.equal(userId, "usr_1"); assert.deepEqual(records.map((entry) => entry.id), ["a"], "only what can be drawn is offered"); return { status: "stale", topics: [{ id: "topic:aaaaaaaaaa", label: "回答风格", weight: 1, trend: 0, members: ["a"] }] }; },
    refresh: async () => { throw new Error("a read must never group"); },
  };
  const researchMemory = { mapRecords: async () => [record({ id: "a" }), record({ id: "b", sensitive: true })] };
  const found = await createTopicsSource({ topics, researchMemory }).read(request());
  assert.deepEqual(found.facets.topics[0].members, ["memory:a"]);
  assert.equal(found.facts.topicsStatus, "stale");
  assert.equal(createTopicsSource({ topics: { configured: false }, researchMemory }).applies(request()), false);
});

// ------------------------------------------------------ the native memory seam

const NATIVE_FIXTURE = {
  records: [
    record({ id: "nat_1", scope: "user", kind: "profile", summary: "后端工程师，主要写 Go 和 SQL", createdAt: "2026-08-01T00:00:00Z" }),
    record({ id: "nat_2", scope: "project", scopeId: "prj_a", kind: "decision", summary: "迁移先做只读副本", createdAt: "2026-09-01T00:00:00Z", status: "superseded", supersededBy: "nat_3", invalidSince: "2026-09-20T00:00:00Z" }),
    record({ id: "nat_3", scope: "project", scopeId: "prj_a", kind: "decision", summary: "迁移直接切主库", createdAt: "2026-09-20T00:00:00Z" }),
    record({ id: "nat_4", scope: "project", scopeId: "prj_b", kind: "project_fact", summary: "另一个项目" }),
    record({ id: "nat_s", sensitive: true }),
  ],
  sources: [{ recordId: "nat_3", type: "knowledge_source", id: "src_9", state: "changed", linkedAt: null }],
  conflicts: [], usage: { nat_1: { count: 4 } },
};

test("the native memory seam draws an account's memories exactly as the PostgreSQL source does, from whatever reader is wired in", async () => {
  const asked = request({ engine: "native" });
  const unwired = createNativeMemorySource();
  assert.equal(unwired.applies(asked), false, "until a reader is wired the seam stands aside");
  const wired = createNativeMemorySource({ readMemories: async (seen) => { assert.equal(seen.user.id, "usr_1"); return NATIVE_FIXTURE; } });
  assert.equal(wired.applies(asked), true);
  assert.equal(wired.applies(request()), false, "an account on PostgreSQL is not read from files");

  const native = await wired.read(asked);
  const same = recordsContribution(NATIVE_FIXTURE.records, NATIVE_FIXTURE, { now: NOW, timeZone: "UTC" });
  assert.deepEqual(native, same, "one function draws both engines' memories");
  assert.ok(!native.nodes.some((node) => node.id === "memory:nat_s"), "a sensitive memory is not drawn from files either");
  assert.equal(native.nodes.find((node) => node.id === "memory:nat_3").reason, "source-changed");
  assert.equal(native.lanes.length, 1);
  assert.equal(native.lanes[0].segments.length, 2);

  const narrowed = await wired.read(request({ engine: "native", projectId: "prj_a" }));
  assert.deepEqual(narrowed.nodes.filter((node) => node.type === "memory").map((node) => node.id).sort(), ["memory:nat_2", "memory:nat_3"]);

  const map = await buildMemoryMap({ sources: [createRecordsSource({ researchMemory: { mapRecords: async () => { throw new Error("must not be read"); } } }), wired] },
    { user, projects, now: NOW, engine: "native", include: "summary,nodes" });
  assert.deepEqual(map.missing, [], "the PostgreSQL source stood aside for this account");
  assert.equal(map.summary.memories, 3);
  const broken = await buildMemoryMap({ sources: [createNativeMemorySource({ readMemories: async () => { throw new Error("files unreadable"); } })] }, { user, projects, now: NOW, engine: "native" });
  assert.deepEqual(broken.missing, ["native-memory"]);
});

// ------------------------------------------------------- the knowledge graph seam

const ENTITY_ASPIRIN = `---
type: entity
id: aspirin
title: 阿司匹林
entity_type: Drug
description: 一种常用的抗血小板药物。
aliases: [ASA, 乙酰水杨酸]
sources:
  - viking://user/u1/resources/prj_a/src_${"a".repeat(64)}.md
  - viking://user/u1/resources/prj_a/notes/handwritten.md
---

# 阿司匹林

正文。
`;
const ENTITY_STROKE = `---
type: entity
id: stroke
title: 卒中
entity_type: disease
description: 脑血管事件。
sources: [viking://user/u1/resources/prj_a/b.md]
---
`;
const RELATIONS = [
  JSON.stringify({ from: "aspirin", relation: "prevents", label: "预防", to: "stroke", evidence: [`viking://user/u1/resources/prj_a/src_${"a".repeat(64)}.md`] }),
  JSON.stringify({ from: "aspirin", relation: "prevents", label: "预防", to: "stroke", evidence: ["viking://user/u1/resources/prj_a/b.md"] }),
  JSON.stringify({ from: "aspirin", relation: "causes", label: "引起", to: "bleeding", evidence: ["viking://x"] }),
  JSON.stringify({ from: "stroke", relation: "Bad Predicate", label: "x", to: "aspirin", evidence: ["viking://x"] }),
  JSON.stringify({ from: "stroke", relation: "treated_with", label: "治疗", to: "aspirin", evidence: [] }),
  "not json at all",
  "[1,2]",
  "",
].join("\n");
const WIKI_INDEX = `---
type: index
title: 知识页
---
# 目录
- [阿司匹林](entity/aspirin.md)
- [卒中](entity/stroke.md "卒中页")
- [外部](https://example.com/x.md)
- [不存在](entity/ghost.md)
- ![图](img/a.png)
`;
const WIKI_ASPIRIN = `---
type: entity
title: 阿司匹林
---
见 [卒中](stroke.md#risk) 与 [目录](../index.md)，以及自己 [本页](aspirin.md)。
`;

test("a compile's files are read by their frontmatter: an entity needs the type, an id that is its file's name, and a title", () => {
  const entity = parseEntity(ENTITY_ASPIRIN, { path: "entities/aspirin.md" });
  assert.deepEqual(entity, {
    id: "aspirin", title: "阿司匹林", entityType: "drug", description: "一种常用的抗血小板药物。", aliases: ["ASA", "乙酰水杨酸"],
    sources: [`viking://user/u1/resources/prj_a/src_${"a".repeat(64)}.md`, "viking://user/u1/resources/prj_a/notes/handwritten.md"],
  });
  assert.equal(parseEntity(ENTITY_ASPIRIN, { path: "entities/other.md" }), null, "an id that is not the file's own is not a stable id");
  assert.equal(parseEntity("# no frontmatter", { path: "entities/x.md" }), null);
  assert.equal(parseEntity("---\ntype: page\nid: x\ntitle: X\n---\n", { path: "entities/x.md" }), null);
  assert.equal(parseEntity("---\ntype: entity\nid: x\n---\n", { path: "entities/x.md" }), null, "no title");
  assert.equal(parseEntity("---\n: [broken\n---\n"), null);
  assert.equal(parseFrontmatter("---\n- a\n- b\n---\n"), null, "a list is not a mapping");
  assert.equal(entityTypeOf("Service Account"), "service_account");
  assert.equal(entityTypeOf("设备"), "other", "a type that is not snake_case is other");
  assert.equal(entityTypeOf(undefined), "other");
});

test("relations.jsonl: every line that stands, each that does not with its number, a repeated edge merged and a predicate's label kept", () => {
  const { relations, rejected } = parseRelations(RELATIONS);
  assert.deepEqual(relations.map((relation) => [relation.from, relation.relation, relation.label, relation.to, relation.evidence.length]), [
    ["aspirin", "prevents", "预防", "stroke", 2], ["aspirin", "causes", "引起", "bleeding", 1],
  ]);
  assert.deepEqual(rejected, [
    { line: 4, reason: "relation_not_a_predicate" }, { line: 5, reason: "evidence_missing" }, { line: 6, reason: "not_json" }, { line: 7, reason: "not_an_object" },
  ]);
  assert.deepEqual(parseRelations("").relations, []);
  assert.equal(parseRelations(JSON.stringify({ from: "a", relation: "r", to: "b", evidence: ["u"] })).relations[0].label, "r", "a missing label is the predicate");
  const relabelled = parseRelations([{ from: "a", to: "b", relation: "r", label: "一", evidence: ["u"] }, { from: "c", to: "d", relation: "r", label: "二", evidence: ["u"] }].map((row) => JSON.stringify(row)).join("\n"));
  assert.deepEqual(relabelled.relations.map((relation) => relation.label), ["一", "一"], "the same predicate has one label across the graph");
});

test("wiki pages: the type and title from the frontmatter, ordinary Markdown links resolved against the page, outside addresses left", () => {
  assert.equal(resolveLink("entity/aspirin.md", "stroke.md#risk"), "entity/stroke.md");
  assert.equal(resolveLink("entity/aspirin.md", "../index.md"), "index.md");
  assert.equal(resolveLink("entity/aspirin.md", "/concept/x.md"), "concept/x.md");
  assert.equal(resolveLink("a.md", "https://example.com/x.md"), null);
  assert.equal(resolveLink("a.md", "mailto:x@y.z"), null);
  assert.equal(resolveLink("a.md", "#top"), null);
  assert.equal(resolveLink("a.md", "../../outside.md"), null, "a link cannot climb out of the wiki");
  const index = parseWikiPage(WIKI_INDEX, { path: "index.md" });
  assert.deepEqual([index.type, index.title], ["index", "知识页"]);
  assert.deepEqual(index.links, ["entity/aspirin.md", "entity/stroke.md", "entity/ghost.md"]);
  const page = parseWikiPage(WIKI_ASPIRIN, { path: "entity/aspirin.md" });
  assert.deepEqual(page.links, ["entity/stroke.md", "index.md"], "its own link is not a link");
  assert.equal(parseWikiPage("# 只有标题\n正文", { path: "concept/x.md" }).title, "只有标题");
  assert.equal(parseWikiPage("没有标题", { path: "concept/x.md" }).title, "x");
});

test("a compile becomes entity marks, typed relation lines and page links; what does not stand is left out", () => {
  const graph = graphFromCompile({
    entities: [
      { path: "entities/aspirin.md", text: ENTITY_ASPIRIN }, { path: "entities/stroke.md", text: ENTITY_STROKE },
      { path: "entities/broken.md", text: "no frontmatter" },
    ],
    relations: RELATIONS,
    pages: [
      { uri: "index.md", text: WIKI_INDEX }, { uri: "entity/aspirin.md", text: WIKI_ASPIRIN },
      { uri: "entity/stroke.md", text: "---\ntype: entity\ntitle: 卒中\n---\n没有链接" },
    ],
  });
  const marks = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
  assert.deepEqual(Object.keys(marks).sort(), ["entity:aspirin", "entity:stroke", "page:entity/aspirin.md", "page:entity/stroke.md", "page:index.md"]);
  assert.deepEqual([marks["entity:aspirin"].subtype, marks["entity:aspirin"].label, marks["entity:aspirin"].open], ["drug", "阿司匹林", null]);
  assert.deepEqual(graph.edges.filter((edge) => edge.type === "relates"), [
    { from: "entity:aspirin", to: "entity:stroke", type: "relates", label: "预防", relation: "prevents" },
  ]);
  assert.deepEqual(graph.edges.filter((edge) => edge.type === "quotes"), [{ from: "entity:aspirin", to: `document:src_${"a".repeat(64)}`, type: "quotes" }],
    "a source that is one of our documents is a line to it; one that is not is not a line");
  assert.deepEqual(graph.edges.filter((edge) => edge.type === "links").map((edge) => [edge.from, edge.to]).sort(), [
    ["page:entity/aspirin.md", "page:entity/stroke.md"], ["page:entity/aspirin.md", "page:index.md"],
    ["page:index.md", "page:entity/aspirin.md"], ["page:index.md", "page:entity/stroke.md"],
  ].sort(), "a link to a page that is not there is not a line");
  assert.equal(graph.rejected.length, 4);
  assert.equal(documentIdOfUri("viking://u/src_0123456789abcdef.md"), "src_0123456789abcdef");
  assert.equal(documentIdOfUri("viking://u/notes.md"), null);
  assert.equal(documentIdOfUri("viking://u/xsrc_0123456789abcdef.md"), null);
});

test("the knowledge-graph seam stands aside until a reader is wired, then draws entities and their lines without opening a drawer", async () => {
  assert.equal(createKnowledgeGraphSource().applies(request()), false);
  const source = createKnowledgeGraphSource({ fetchProducts: async () => ({ entities: [{ path: "entities/aspirin.md", text: ENTITY_ASPIRIN }, { path: "entities/stroke.md", text: ENTITY_STROKE }], relations: RELATIONS, pages: [] }) });
  assert.equal(source.applies(request()), true);
  const map = await buildMemoryMap({ sources: [source] }, { user, projects, now: NOW, include: "nodes,edges,summary" });
  assert.deepEqual(map.nodes.map((node) => [node.id, node.type]).sort(), [["entity:aspirin", "entity"], ["entity:stroke", "entity"]]);
  assert.deepEqual(map.edges.map((edge) => [edge.type, edge.label]), [["relates", "预防"]]);
  assert.equal(map.summary.memories, 0);
  assert.deepEqual((await buildMemoryMap({ sources: [createKnowledgeGraphSource({ fetchProducts: async () => null })] }, { user, projects, now: NOW })).missing, [], "no graph yet is not a failure");
  assert.deepEqual((await buildMemoryMap({ sources: [createKnowledgeGraphSource({ fetchProducts: async () => { throw new Error("OpenViking unreachable"); } })] }, { user, projects, now: NOW })).missing, ["knowledge-graph"]);
});

// ------------------------------------------------------------- the drawer's links

test("a memory's links: what it rests on, what it replaced and what replaced it, who it disagrees with, and the conversations it was handed to", async () => {
  const researchMemory = {
    sourceLinks: async () => [
      { type: "knowledge_source", id: "src_1", state: "retracted" }, { type: "doi", id: "10.1/x", state: "current" }, { type: "evidence_card", id: "card_1", state: "unknown" },
    ],
    recordNeighbours: async () => ({
      replaced: [record({ id: "old", status: "superseded", summary: "旧说法", invalidSince: "2026-09-01T00:00:00Z" })],
      replacedBy: record({ id: "new", summary: "新说法" }),
      conflicts: [record({ id: "foe", sensitive: true, summary: "不能说", value: "不能说" })],
    }),
  };
  const agentRuns = { researcherRuns: async (project) => [
    { id: "r1", sessionId: "ses_1", title: "心衰指南", finishedAt: "2026-10-01T00:00:00Z", recalledMemories: [{ id: "rec_1" }, { id: "other" }] },
    { id: "r2", sessionId: "ses_2", title: "没用到", finishedAt: "2026-10-02T00:00:00Z", recalledMemories: [{ id: "other" }] },
    { id: "r3", sessionId: "ses_3", title: "删掉的", finishedAt: "2026-10-03T00:00:00Z", deleted: true, recalledMemories: [{ id: "rec_1" }] },
    { id: "r4", sessionId: "ses_4", question: "后来的问题", finishedAt: "2026-10-04T00:00:00Z", recalledMemories: [{ id: "rec_1" }], project },
  ] };
  const sources = { get: async (_user, id) => ({ id, payload: { title: "GOLD 报告", paths: ["g.pdf"] } }) };
  const links = createRecordLinks({ researchMemory, sources, agentRuns, projectOf: async (_u, id) => ({ id }), listProjects: async () => [{ id: "prj_a" }] });
  const found = await links(user, record({ scope: "project", scopeId: "prj_a" }));
  assert.deepEqual(found.rests.map((rest) => [rest.type, rest.state, rest.title, rest.href]), [
    ["knowledge_source", "retracted", "GOLD 报告", "/app/files/src_1"], ["doi", "current", "10.1/x", "https://doi.org/10.1/x"], ["evidence_card", "unknown", null, null],
  ]);
  assert.deepEqual(found.replaced.map((entry) => [entry.id, entry.text, entry.to]), [["old", "旧说法", "2026-09-01T00:00:00.000Z"]]);
  assert.equal(found.replacedBy.text, "新说法");
  assert.deepEqual(found.conflicts.map((entry) => [entry.id, entry.sensitive, entry.text]), [["foe", true, ""]], "a sensitive neighbour carries no words");
  assert.deepEqual(found.usedIn.map((entry) => [entry.sessionId, entry.title]), [["ses_4", "后来的问题"], ["ses_1", "心衰指南"]], "newest first; a deleted conversation and one that never used it are not listed");
  assert.ok(!JSON.stringify(found).match(/count|次/u), "how often is the platform's, not the researcher's");

  const failing = createRecordLinks({
    researchMemory: { sourceLinks: async () => { throw new Error("x"); }, recordNeighbours: async () => { throw new Error("y"); } },
    agentRuns: { researcherRuns: async () => { throw new Error("z"); } }, projectOf: async (_u, id) => ({ id }), listProjects: async () => [{ id: "prj_a" }],
  });
  assert.deepEqual(await failing(user, record()), { rests: [], replaced: [], replacedBy: null, conflicts: [], usedIn: [] }, "each part stands or falls by itself");
});
