import { describe, expect, it } from "vitest";
import type { ReceivedCapsule } from "@/lib/memoryClient";
import type { MapDay, MapEvent, MapNode } from "@/lib/memoryMapClient";
import type { WebMethod } from "@/lib/methodsClient";
import {
  aboutYouCount, changeEvents, changeRows, defaultExplore, exploreOffered, growthOf, knowledgeCount, lastChangeDay, lookTableRows, narrowChanges, needsLook, overviewHeadline,
  rangeFrom, readable, receivedCounts, recentCount, relationCount, rememberedCount, withinRange, type ChangeEvent, type OverviewDoc,
} from "./memoryOverviewModel";

const memory = (id: string, over: Partial<MapNode> = {}): MapNode => ({
  id: `memory:${id}`, type: "memory", subtype: "preference", group: "偏好", label: `记忆 ${id}`, state: "current", at: "2026-10-01T00:00:00.000Z", projectId: null, open: { kind: "record", id }, ...over,
});
const method = (id: string, at: string, over: Partial<WebMethod> = {}): WebMethod => ({
  id, projectId: null, revision: 1, name: `method-${id}`, title: `做法 ${id}`, description: "", whenToUse: "", status: "approved", statusReason: null, origin: "inferred", counts: null,
  promotion: { status: "approved", reasons: [], missing: [] }, body: "", createdAt: at, updatedAt: at, ...over,
});
const event = (id: string, at: string, change = "created", over: Partial<MapEvent> = {}): MapEvent => ({ id: `memory:${id}:${change}`, at, type: "memory", change, ref: `memory:${id}`, text: `记忆 ${id}`, ...over });
const days = (rows: Array<[string, number]>): MapDay[] => rows.map(([t, document]) => ({ t, document }));
const pack = (id: string, importedAt: string | null, over: Partial<ReceivedCapsule> = {}): ReceivedCapsule => ({
  id, revision: 1, title: `包 ${id}`, description: "", issuerTrust: "verified", importedAt, enabled: true, counts: {}, methods: [], scanned: true, waiting: 0, scan: null, ...over,
});

function doc(over: Partial<OverviewDoc> = {}): OverviewDoc {
  return {
    summary: { memories: 0, documents: 0, needsLook: 0, since: null },
    facets: { projects: [], topics: [], aboutYou: [], documentTypes: [] },
    nodes: [], edges: [], buckets: { unit: "day", series: [] }, events: [], missing: [],
    scope: { projectId: null, range: { from: null, to: "2026-10-12", unit: "month" }, timeZone: "UTC", focus: null, depth: null },
    ...over,
  };
}
const change = (lane: ChangeEvent["lane"], day: string, over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  lane, day, title: `${lane} ${day}`, open: null, id: `${lane}:${day}`, projectId: null, about: false, state: "current", ...over,
});

describe("a part that could not be read is not a part with nothing in it", () => {
  it("is not readable when a source it is made of failed, and is when only another failed", () => {
    expect(readable(doc({ missing: ["native-memory"] }), "memories")).toBe(false);
    expect(readable(doc({ missing: ["native-memory"] }), "knowledge")).toBe(true);
    expect(readable(doc({ missing: ["documents"] }), "knowledge")).toBe(false);
    expect(readable(doc({ missing: ["documents"] }), "growth")).toBe(false);
    // The learned methods are their own read, not the map's: a failed methods source of the map costs the chart nothing.
    expect(readable(doc({ missing: ["methods", "topics", "knowledge-graph", "runs"] }), "growth")).toBe(true);
    expect(readable(doc({ missing: ["capsule-notes"] }), "memories")).toBe(false);
  });
});

describe("the numbers of the tiles", () => {
  it("counts 关于你 as the server counted it, before any memory is folded into a group; and from the marks when the server did not say", () => {
    expect(aboutYouCount(doc({ facets: { ...doc().facets, aboutYou: [{ id: "preference", label: "偏好", count: 7 }, { id: "profile", label: "背景", count: 5 }] } }))).toBe(12);
    const nodes = [memory("a"), memory("b"), memory("c", { projectId: "p1", subtype: "project_fact" }), memory("d", { state: "replaced" })];
    expect(aboutYouCount({ nodes, facets: { projects: [], topics: [] } })).toBe(2);
  });

  it("counts 关于你 as its list draws it: the memories about the person and the ones that carry a project, the ones that name no project the account has included", () => {
    const facets = { ...doc().facets, aboutYou: [{ id: "preference", label: "偏好", count: 4 }], projects: [
      { id: "p1", name: "房颤", kind: "own", memories: 3, documents: 5 }, { id: "p2", name: "空项目", kind: "own", memories: 0, documents: 0 }, { id: "p3", name: "只有资料", kind: "own", memories: 0, documents: 2 },
    ] };
    // 10 memories: 4 about the person, 3 in a project, 3 in none the account has — all of them are in the list.
    expect(rememberedCount({ nodes: [], facets, summary: { ...doc().summary, memories: 10 } })).toBe(10);
    // The summary can be behind the facets (a source that was folded): never fewer than the facets name.
    expect(rememberedCount({ nodes: [], facets, summary: { ...doc().summary, memories: 5 } })).toBe(7);
  });

  it("counts the documents by the knowledge base's own count, and from the summary for an older control plane", () => {
    expect(knowledgeCount(doc({ facets: { ...doc().facets, documentTypes: [{ id: "a", label: "a", count: 31 }, { id: "b", label: "b", count: 9 }] } }))).toBe(40);
    expect(knowledgeCount({ nodes: [], facets: { projects: [], topics: [] }, summary: { ...doc().summary, documents: 4 } })).toBe(4);
  });

  it("counts the packs in force, never a pack taken down, and all of them; a pack is never a memory", () => {
    expect(receivedCounts([{ enabled: true }, { enabled: false }, { enabled: true, takenDown: { by: "author", at: "x", reason: null } }])).toEqual({ enabled: 1, all: 3 });
  });

  it("lists what needs a look, the most worth knowing first — a withdrawn source before a changed one", () => {
    const nodes = [
      memory("a", { state: "check", reason: "source-changed", at: "2026-10-05T00:00:00.000Z" }),
      memory("b", { state: "check", reason: "source-retracted", at: "2026-10-02T00:00:00.000Z" }),
      memory("c", { state: "check", reason: "conflict", at: "2026-10-09T00:00:00.000Z" }),
      memory("d"),
    ];
    const look = needsLook({ nodes, summary: { ...doc().summary, needsLook: 3 } });
    expect(look.count).toBe(3);
    expect(look.rows.map((row) => [row.id, row.reason])).toEqual([["memory:b", "依据的资料已撤回"], ["memory:c", "和另一条说法不一致"], ["memory:a", "依据的资料有更新"]]);
    expect(needsLook({ nodes: [memory("d")], summary: doc().summary })).toEqual({ count: 0, rows: [] });
  });
});

describe("the changes", () => {
  const fixture = () => doc({
    nodes: [memory("a", { projectId: null }), memory("b", { projectId: "p1", subtype: "project_fact" }), memory("old", { state: "replaced" })],
    events: [event("a", "2026-10-01T02:00:00Z"), event("b", "2026-10-02T02:00:00Z"), event("old", "2026-09-20T02:00:00Z"), event("a", "2026-10-03T02:00:00Z", "updated"), event("gone", "2026-10-04T02:00:00Z", "archived"),
      event("a", "2026-10-05T02:00:00Z", "superseded"), { ...event("m9", "2026-10-06T02:00:00Z", "retired"), type: "method", ref: "method:m9", text: "停用的做法" }],
    buckets: { unit: "day", series: days([["2026-09-22", 2]]) },
  });

  it("counts what the capsule gained and lost: memories noted and forgotten, methods learned, documents added, packs taken in — and not a replaced memory, an update or a merge", () => {
    const events = changeEvents(fixture(), [pack("p1", "2026-10-09T02:00:00Z"), pack("p2", null)], [method("m1", "2026-10-02T01:00:00Z"), method("m2", "2026-10-03T01:00:00Z", { status: "retired" })]);
    expect(events.map((entry) => [entry.lane, entry.day])).toEqual([
      ["documents", "2026-09-22"], ["documents", "2026-09-22"], ["noted", "2026-10-01"], ["noted", "2026-10-02"], ["learned", "2026-10-02"], ["forgotten", "2026-10-04"], ["forgotten", "2026-10-06"], ["received", "2026-10-09"],
    ]);
    expect(events.find((entry) => entry.lane === "noted" && entry.id === "memory:a")).toMatchObject({ about: true, projectId: null, open: { kind: "record", id: "a" } });
    expect(events.find((entry) => entry.id === "memory:b")).toMatchObject({ about: false, projectId: "p1" });
    expect(events.find((entry) => entry.id === "pack:p1")).toMatchObject({ lane: "received", title: "包 p1" });
  });

  it("takes a day in the researcher's zone", () => {
    const shifted = doc({ nodes: [memory("a")], events: [event("a", "2026-10-01T20:00:00Z")], scope: { ...doc().scope, timeZone: "Asia/Shanghai" } });
    expect(changeEvents(shifted, [], []).map((entry) => entry.day)).toEqual(["2026-10-02"]);
  });

  it("narrows by the range counted back from today, one selected week, the search, and the memories a topic or a look kept", () => {
    const all = [change("noted", "2026-09-01"), change("noted", "2026-09-30", { id: "memory:a" }), change("noted", "2026-10-06", { id: "memory:b", title: "引用写到页码" }), change("learned", "2026-10-07"), change("noted", "2026-10-12", { id: "memory:c" })];
    const base = { from: null, today: "2026-10-12", week: null, query: "", only: null };
    expect(narrowChanges(all, base)).toHaveLength(5);
    expect(rangeFrom("30d", "2026-10-12")).toBe("2026-09-13");
    expect(rangeFrom("90d", "2026-10-12")).toBe("2026-07-15");
    expect(rangeFrom("all", "2026-10-12")).toBeNull();
    expect(narrowChanges(all, { ...base, from: rangeFrom("30d", "2026-10-12") }).map((entry) => entry.day)).toEqual(["2026-09-30", "2026-10-06", "2026-10-07", "2026-10-12"]);
    // Monday 2026-10-05 begins the week of the 6th and the 7th, not the 12th.
    expect(narrowChanges(all, { ...base, week: "2026-10-05" }).map((entry) => entry.day)).toEqual(["2026-10-06", "2026-10-07"]);
    expect(narrowChanges(all, { ...base, query: "页码" }).map((entry) => entry.id)).toEqual(["memory:b"]);
    // A topic or a look is about memories: what is not one is gone while it narrows.
    expect(narrowChanges(all, { ...base, only: new Set(["memory:a", "memory:c"]) }).map((entry) => entry.id)).toEqual(["memory:a", "memory:c"]);
    // Nothing after today counts.
    expect(narrowChanges([change("noted", "2026-10-13")], base)).toEqual([]);
  });

  it("draws a dot for each change up to thirty and counts weeks after, a lane only when it has changes, days under two weeks of history", () => {
    const few = growthOf([change("noted", "2026-10-01"), change("noted", "2026-10-02"), change("forgotten", "2026-10-03")], "2026-10-12");
    expect(few).toMatchObject({ total: 3, shape: "dots", lanes: ["noted", "forgotten"], first: "2026-10-01", today: "2026-10-12", axis: "days" });
    expect(growthOf([change("noted", "2026-09-01")], "2026-10-12").axis).toBe("weeks");
    expect(growthOf([], "2026-10-12")).toMatchObject({ total: 0, shape: "none", lanes: [], first: null });
    const many = growthOf(Array.from({ length: 31 }, (_unused, index) => change("noted", `2026-09-${String(1 + (index % 28)).padStart(2, "0")}`)), "2026-10-12");
    expect(many.shape).toBe("weeks");
    expect(many.weeks.reduce((sum, week) => sum + week.counts.noted, 0)).toBe(31);
    expect(many.weeks[0]!.start).toBe("2026-08-31");
  });

  it("counts the changes of the last thirty days, today included, by a test; and says the last day something was remembered or learned", () => {
    const all = [change("noted", "2026-09-13", { about: true }), change("noted", "2026-09-12", { about: true }), change("learned", "2026-10-12"), change("received", "2026-10-13"), change("forgotten", "2026-10-14")];
    expect(recentCount(all, "2026-10-12")).toBe(2);
    expect(recentCount(all, "2026-10-12", (entry) => entry.lane === "noted" && entry.about)).toBe(1);
    // A pack taken in, a document added and a memory forgotten are changes of the chart and not 「最近一次」 after 「记住了」 and 「学会了」.
    expect(lastChangeDay(all)).toBe("2026-10-12");
    expect(lastChangeDay([change("received", "2026-10-13")])).toBeNull();
  });
});

describe("the table behind the charts", () => {
  const projectName = (id: string | null) => (id === "p1" ? "房颤队列" : null);
  const sayDay = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;

  it("lists the newest first, each row saying what happened, when and where, and what a press opens", () => {
    const rows = changeRows([
      change("noted", "2026-10-01", { id: "memory:a", about: true, open: { kind: "record", id: "a" }, title: "回答先给结论" }),
      change("noted", "2026-10-02", { id: "memory:b", projectId: "p1", open: { kind: "record", id: "b" }, title: "纳入 75 岁以上" }),
      change("noted", "2026-10-03", { id: "memory:c", projectId: "gone", open: { kind: "record", id: "c" }, title: "已删除项目里的" }),
      change("learned", "2026-10-04", { id: "method:m1", open: { kind: "method", id: "m1" }, title: "证据矩阵先行" }),
      change("received", "2026-10-05", { id: "pack:p9", title: "李主任的工作方式" }),
      change("forgotten", "2026-10-06", { id: "memory:z", title: "忘了的一条", about: true }),
    ], { projectName, formatDay: sayDay });
    expect(rows.map((row) => [row.title, row.meta, row.glyph])).toEqual([
      ["忘了的一条", "忘记 · 10月6日 · 关于你", "✕"],
      ["李主任的工作方式", "收下 · 10月5日 · 收到的", "◆"],
      ["证据矩阵先行", "学会 · 10月4日 · 做法", "▲"],
      ["已删除项目里的", "记下 · 10月3日 · 未归入项目", "●"],
      ["纳入 75 岁以上", "记下 · 10月2日 · 房颤队列", "●"],
      ["回答先给结论", "记下 · 10月1日 · 关于你", "●"],
    ]);
    expect(rows.map((row) => row.target)).toEqual([
      { kind: "forgotten" }, { kind: "pack", id: "p9" }, { kind: "drawer", open: { kind: "method", id: "m1" } },
      { kind: "drawer", open: { kind: "record", id: "c" } }, { kind: "drawer", open: { kind: "record", id: "b" } }, { kind: "drawer", open: { kind: "record", id: "a" } },
    ]);
    expect(rows.find((row) => row.lane === "forgotten")!.state).toBe("replaced");
  });

  it("makes the documents added on one day one row that goes to the knowledge base", () => {
    const rows = changeRows([change("documents", "2026-10-02", { title: null }), change("documents", "2026-10-02", { title: null }), change("documents", "2026-10-03", { title: null })], { projectName, formatDay: sayDay });
    expect(rows.map((row) => [row.title, row.target.kind])).toEqual([["放进 1 份资料", "files"], ["放进 2 份资料", "files"]]);
  });

  it("leaves out a memory with no drawer to open, rather than draw a row that opens nothing", () => {
    expect(changeRows([change("noted", "2026-10-01", { id: "memory:a", open: null })], { projectName, formatDay: sayDay })).toEqual([]);
  });

  it("is, with 「只看需要看一眼」, the memories that need a look, each saying why", () => {
    const look = needsLook({ nodes: [memory("a", { state: "check", reason: "conflict", label: "回答先给结论" }), memory("b", { state: "check", reason: "source-changed", label: "引用写到页码" })], summary: { ...doc().summary, needsLook: 2 } });
    expect(lookTableRows(look.rows, "").map((row) => [row.title, row.meta, row.state])).toEqual([["回答先给结论", "和另一条说法不一致", "check"], ["引用写到页码", "依据的资料有更新", "check"]]);
    expect(lookTableRows(look.rows, "页码").map((row) => row.title)).toEqual(["引用写到页码"]);
  });
});

describe("the sentence over the page", () => {
  const links = { about: "/a", methods: "/m" };
  const text = (parts: ReturnType<typeof overviewHeadline>) => parts?.map((part) => (typeof part === "string" ? part : String(part.n))).join("");

  it("says what was remembered and learned, each number a link to the list it counts, and when it last changed", () => {
    const parts = overviewHeadline({ about: 23, methods: 8, last: "10月24日" }, links)!;
    expect(text(parts)).toBe("记住了 23 条关于你的事，学会了 8 种做法；最近一次在10月24日。");
    expect(parts.filter((part) => typeof part !== "string").map((part) => [(part as { n: number }).n, (part as { to: string }).to])).toEqual([[23, "/a"], [8, "/m"]]);
  });

  it("leaves out a clause whose part could not be read or holds nothing — never a 「0」 — and says nothing for a capsule that is empty", () => {
    expect(text(overviewHeadline({ about: null, methods: 3, last: "10月1日" }, links))).toBe("学会了 3 种做法；最近一次在10月1日。");
    expect(text(overviewHeadline({ about: 10, methods: 0, last: null }, links))).toBe("记住了 10 条关于你的事。");
    expect(overviewHeadline({ about: 0, methods: 0, last: null }, links)).toBeNull();
    expect(overviewHeadline({ about: null, methods: null, last: null }, links)).toBeNull();
  });
});

describe("the relations and topics", () => {
  const edges = (count: number, type = "rests-on" as const) => Array.from({ length: count }, (_unused, index) => ({ from: `memory:${index}`, to: `document:${index}`, type }));
  const summary = (memories: number) => ({ ...doc().summary, memories });

  it("is offered from twelve memories with three relations or a grouping into topics, and not below", () => {
    expect(exploreOffered({ summary: summary(12), edges: edges(3), facets: doc().facets })).toBe(true);
    expect(exploreOffered({ summary: summary(11), edges: edges(30), facets: doc().facets })).toBe(false);
    expect(exploreOffered({ summary: summary(12), edges: edges(2), facets: doc().facets })).toBe(false);
    expect(exploreOffered({ summary: summary(12), edges: edges(2), facets: { ...doc().facets, topics: [{ id: "t", label: "t", weight: 3, trend: 0, members: [] }] } })).toBe(true);
    expect(exploreOffered({ summary: summary(40), edges: [], facets: doc().facets })).toBe(false);
  });

  it("does not count a memory's belonging to its project as a relation, and opens on the relations when there are enough", () => {
    expect(relationCount({ edges: [...edges(2), ...edges(5, "belongs-to" as never)] })).toBe(2);
    expect(defaultExplore({ edges: edges(3) })).toBe("graph");
    expect(defaultExplore({ edges: edges(2) })).toBe("topics");
  });

  it("keeps the account and its projects whatever the range, a mark with no time, and what began inside it", () => {
    const nodes: MapNode[] = [
      { id: "you:account", type: "you", label: "你" }, memory("old", { at: "2026-06-01T00:00:00Z" }), memory("new", { at: "2026-10-05T00:00:00Z" }),
      { id: "entity:x", type: "entity", label: "概念" },
    ];
    const kept = withinRange({ nodes, edges: [{ from: "memory:old", to: "memory:new", type: "relates" }, { from: "memory:new", to: "entity:x", type: "relates" }] }, "2026-09-13", "2026-10-12", "UTC");
    expect(kept.nodes.map((node) => node.id)).toEqual(["you:account", "memory:new", "entity:x"]);
    expect(kept.edges).toEqual([{ from: "memory:new", to: "entity:x", type: "relates" }]);
    expect(withinRange({ nodes, edges: [] }, null, "2026-10-12", "UTC").nodes).toHaveLength(4);
  });
});
