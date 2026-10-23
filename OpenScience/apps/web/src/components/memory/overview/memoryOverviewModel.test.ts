import { describe, expect, it } from "vitest";
import type { ReceivedCapsule } from "@/lib/memoryClient";
import type { MapDay, MapEvent, MapNode } from "@/lib/memoryMapClient";
import type { WebMethod } from "@/lib/methodsClient";
import {
  aboutYouCard, amountOf, DOT_LIMIT, FEW_MAX, growthCard, growthEvents, growthOf, knowledgeCard, methodsCard, monthCounts, needsLook, overviewHeadline, partAddress,
  projectsCard, readable, receivedCard, recentGains, SOME_MAX, workStyle, type OverviewDoc,
} from "./memoryOverviewModel";

const memory = (id: string, over: Partial<MapNode> = {}): MapNode => ({
  id: `memory:${id}`, type: "memory", subtype: "preference", group: "偏好", label: `记忆 ${id}`, state: "current", at: "2026-10-01T00:00:00.000Z", projectId: null, open: { kind: "record", id }, ...over,
});
const method = (id: string, at: string, over: Partial<WebMethod> = {}): WebMethod => ({
  id, projectId: null, revision: 1, name: `method-${id}`, title: `做法 ${id}`, description: "", whenToUse: "", status: "approved", statusReason: null, origin: "inferred", counts: null,
  promotion: { status: "approved", reasons: [], missing: [] }, body: "", createdAt: at, updatedAt: at, ...over,
});
const document = (id: string, over: Partial<MapNode> = {}): MapNode => ({ id: `document:${id}`, type: "document", subtype: "literature", group: "文献与指南", label: `资料 ${id}`, state: "current", at: "2026-09-20T00:00:00.000Z", open: { kind: "page", href: `/app/files/${id}` }, ...over });
const many = <T,>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));

function doc(over: Partial<OverviewDoc> = {}): OverviewDoc {
  return {
    summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null },
    facets: { projects: [], kinds: [], topics: [], dimensions: [], aboutYou: [], documentTypes: [] },
    nodes: [], buckets: { unit: "day", series: [] }, events: [], missing: [],
    scope: { projectId: null, range: { from: null, to: "2026-10-12", unit: "month" }, timeZone: "UTC", focus: null, depth: null },
    ...over,
  };
}

describe("the amounts a card is drawn for", () => {
  it("are 0, 1–5, 6–30 and 31 and more, in the numbers the page and these tests share", () => {
    expect([FEW_MAX, SOME_MAX, DOT_LIMIT]).toEqual([5, 30, 30]);
    expect([0, 1, 5, 6, 30, 31].map(amountOf)).toEqual(["none", "few", "few", "some", "some", "many"]);
    expect([-1, Number.NaN].map(amountOf)).toEqual(["none", "none"]);
  });
});

describe("a part that could not be read is not a part with nothing in it", () => {
  it("is not readable when a source it is made of failed, and is when only another failed", () => {
    expect(readable(doc({ missing: ["native-memory"] }), "memories")).toBe(false);
    expect(readable(doc({ missing: ["native-memory"] }), "knowledge")).toBe(true);
    expect(readable(doc({ missing: ["documents"] }), "knowledge")).toBe(false);
    expect(readable(doc({ missing: ["documents"] }), "projects")).toBe(false);
    expect(readable(doc({ missing: ["documents"] }), "growth")).toBe(false);
    // The learned methods are their own read, not the map's: a failed methods source of the map costs the strip nothing.
    expect(readable(doc({ missing: ["methods", "topics", "knowledge-graph", "runs"] }), "growth")).toBe(true);
    expect(readable(doc({ missing: ["capsule-notes"] }), "memories")).toBe(false);
  });
});

describe("关于你", () => {
  const you = (count: number, kind = "preference") => doc({
    nodes: many(count, (index) => memory(`y${index}`, { subtype: kind, at: `2026-10-${String(1 + (index % 9)).padStart(2, "0")}T00:00:00.000Z` })),
    facets: { projects: [], kinds: [], topics: [], dimensions: [], aboutYou: count > 0 ? [{ id: kind, label: kind, count }] : [] },
  });

  it("is a recipe at 0, the statements themselves at 1 and 5, ranked bars at 6 and 30, bars and the newest three at 31", () => {
    expect(aboutYouCard(you(0))).toMatchObject({ count: 0, shape: "recipe", rows: [], bars: [] });
    const one = aboutYouCard(you(1));
    expect([one.count, one.shape, one.rows.map((row) => row.title)]).toEqual([1, "rows", ["记忆 y0"]]);
    expect(aboutYouCard(you(5))).toMatchObject({ count: 5, shape: "rows" });
    expect(aboutYouCard(you(5)).rows).toHaveLength(5);
    for (const count of [6, 30]) expect(aboutYouCard(you(count))).toMatchObject({ count, shape: "bars", rows: [], newest: [] });
    const folded = aboutYouCard(you(31));
    expect([folded.count, folded.shape, folded.newest.length]).toEqual([31, "bars", 3]);
  });

  it("counts what the server counted, not the marks it was given: a capsule folded into groups still says how many, and lists none one by one", () => {
    const folded = doc({ nodes: [], facets: { projects: [], kinds: [], topics: [], dimensions: [], aboutYou: [{ id: "preference", label: "偏好", count: 3 }] } });
    expect(aboutYouCard(folded)).toMatchObject({ count: 3, shape: "bars", rows: [] });
  });

  it("ranks the aspects the memory page files by: 背景 for profile and expertise, 习惯 for a writing style, 其他 for what is none", () => {
    const card = aboutYouCard(doc({
      nodes: [], facets: { projects: [], kinds: [], topics: [], dimensions: [], aboutYou: [
        { id: "profile", label: "用户画像", count: 2 }, { id: "expertise", label: "背景知识", count: 3 }, { id: "writing_style", label: "写作习惯", count: 1 },
        { id: "preference", label: "偏好", count: 4 }, { id: "tension", label: "两难之处", count: 1 }, { id: "correction", label: "纠正", count: 1 },
      ] },
    }));
    expect(card.bars.map((bar) => [bar.label, bar.count])).toEqual([["背景", 5], ["偏好", 4], ["工作与写作习惯", 1], ["纠正过的", 1], ["其他", 1]]);
    expect(card.count).toBe(12);
  });

  it("never lists a memory of a project or one that was replaced", () => {
    const card = aboutYouCard(doc({
      nodes: [memory("a"), memory("b", { projectId: "p" }), memory("c", { subtype: "decision" }), memory("d", { state: "replaced" })],
      facets: { projects: [], kinds: [], topics: [], dimensions: [], aboutYou: [{ id: "preference", label: "偏好", count: 1 }] },
    }));
    expect(card.rows.map((row) => row.title)).toEqual(["记忆 a"]);
  });
});

describe("项目", () => {
  const project = (id: string, memories: number, documents: number) => ({ id, name: `项目 ${id}`, kind: "own", memories, documents });
  const projects = (rows: ReturnType<typeof project>[], over: Partial<OverviewDoc> = {}) => doc({
    summary: { memories: rows.reduce((sum, row) => sum + row.memories, 0), documents: 0, methods: 0, projects: rows.length, needsLook: 0, since: null },
    facets: { projects: rows, kinds: [], topics: [], dimensions: [], aboutYou: [], documentTypes: [] }, ...over,
  });

  it("is a recipe with none, the project's own facts with one, a table with a bar in each row with several", () => {
    expect(projectsCard(projects([]))).toMatchObject({ count: 0, shape: "recipe", rows: [], single: null });
    expect(projectsCard(projects([project("a", 0, 0)]))).toMatchObject({ count: 0, shape: "recipe" });
    const one = projectsCard(projects([project("a", 5, 22)]));
    expect([one.count, one.shape, one.single?.id, one.memories]).toEqual([1, "single", "a", 5]);
    const two = projectsCard(projects([project("a", 5, 22), project("b", 0, 3)]));
    expect([two.count, two.shape, two.rows.length]).toEqual([2, "table", 2]);
  });

  it("lists the eight most recently active and says how many more there are", () => {
    const ids = many(31, (index) => `p${String(index).padStart(2, "0")}`);
    const nodes = ids.map((id, index) => memory(`m_${id}`, { projectId: id, at: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00.000Z` }));
    const card = projectsCard(projects(ids.map((id) => project(id, 1, 0)), { nodes }));
    expect([card.count, card.rows.length, card.more]).toEqual([31, 8, 23]);
    // The newest memory is in the project listed first.
    expect(card.rows[0]!.id).toBe("p27");
    expect(projectsCard(projects(ids.slice(0, 8).map((id) => project(id, 1, 0)))).more).toBe(0);
    expect(projectsCard(projects(ids.slice(0, 9).map((id) => project(id, 1, 0)))).more).toBe(1);
  });

  it("holds the memories that name no project the account has as one 其他, and the headline's memories are 关于你 and the projects together", () => {
    const base = projects([project("a", 2, 1)], { summary: { memories: 9, documents: 1, methods: 0, projects: 1, needsLook: 0, since: null } });
    const card = projectsCard({ ...base, facets: { ...base.facets, aboutYou: [{ id: "preference", label: "偏好", count: 4 }] } });
    expect(card.rows.map((row) => [row.name, row.memories])).toContainEqual(["其他", 3]);
    expect(card.memories + 4).toBe(9);
  });

  it("counts each project's memories that need a look", () => {
    const card = projectsCard(projects([project("a", 2, 0)], { nodes: [memory("x", { projectId: "a", state: "check", reason: "source-changed" }), memory("y", { projectId: "a" })] }));
    expect(card.rows[0]!.needsLook).toBe(1);
  });
});

describe("我的做法", () => {
  const methods = (count: number) => many(count, (index) => method(`m${index}`, `2026-${String(1 + (index % 9)).padStart(2, "0")}-15T00:00:00.000Z`));

  it("is a recipe at 0, rows at 1 and 5, dots on a month axis at 6 and 30, monthly bars at 31, the newest three beside them", () => {
    expect(methodsCard(methods(0))).toMatchObject({ count: 0, shape: "recipe", marks: null });
    for (const count of [1, 5]) expect(methodsCard(methods(count))).toMatchObject({ count, shape: "rows", marks: null, months: [] });
    expect(methodsCard(methods(5)).rows).toHaveLength(5);
    for (const count of [6, 30]) {
      const card = methodsCard(methods(count));
      expect([card.count, card.shape, card.marks, card.rows.length]).toEqual([count, "months", "dots", 3]);
      expect(card.months.reduce((sum, month) => sum + month.count, 0)).toBe(count);
    }
    expect(methodsCard(methods(31))).toMatchObject({ count: 31, shape: "months", marks: "bars" });
  });

  it("puts the newest first, opens the method's own drawer, and shows no count of use", () => {
    const card = methodsCard([method("old", "2026-01-01T00:00:00.000Z"), method("new", "2026-09-01T00:00:00.000Z", { counts: { eligible: 9, loaded: 9, invoked: 9, succeeded: 9, read: 9 } })]);
    expect(card.rows.map((row) => row.title)).toEqual(["做法 new", "做法 old"]);
    expect(card.rows[0]!.open).toEqual({ kind: "method", id: "new" });
    expect(JSON.stringify(card)).not.toMatch(/usage|used|invoked|loaded|eligible/);
  });

  it("is made of the approved methods only, by the researcher's own line and else the method's name", () => {
    const card = methodsCard([method("a", "2026-01-01T00:00:00.000Z", { title: null }), method("b", "2026-02-01T00:00:00.000Z", { status: "retired" }), method("c", "2026-03-01T00:00:00.000Z", { status: "candidate" })]);
    expect(card.rows.map((row) => row.title)).toEqual(["method-a"]);
    expect(card.count).toBe(1);
  });

  it("draws every month between the first and the last, a month with none as a gap", () => {
    expect(monthCounts(["2026-01-05T00:00:00Z", "2026-01-20T00:00:00Z", "2026-04-02T00:00:00Z"])).toEqual([
      { month: "2026-01", count: 2 }, { month: "2026-02", count: 0 }, { month: "2026-03", count: 0 }, { month: "2026-04", count: 1 },
    ]);
    expect(monthCounts(["2025-11-30T00:00:00Z", "2026-02-01T00:00:00Z"]).map((entry) => entry.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthCounts([])).toEqual([]);
    expect(monthCounts([""])).toEqual([]);
  });
});

describe("知识", () => {
  const types = (counts: number[]) => counts.map((count, index) => ({ id: `t${index}`, label: `类型${index}`, count }));
  const knowledge = (counts: number[], over: Partial<OverviewDoc> = {}) => doc({
    facets: { projects: [], kinds: [], topics: [], dimensions: [], aboutYou: [], documentTypes: types(counts) },
    summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, ...over,
  });

  it("is a recipe at 0, documents as rows at 1 and 5, the composition by kind from 6", () => {
    expect(knowledgeCard(knowledge([]))).toMatchObject({ count: 0, shape: "recipe", types: [] });
    const rowsOf = (count: number) => many(count, (index) => document(`d${index}`, { at: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00.000Z` }));
    const one = knowledgeCard(knowledge([1], { nodes: rowsOf(1) }));
    expect([one.count, one.shape, one.rows.length]).toEqual([1, "rows", 1]);
    expect(knowledgeCard(knowledge([3, 2], { nodes: rowsOf(5) }))).toMatchObject({ count: 5, shape: "rows" });
    expect(knowledgeCard(knowledge([6], { nodes: rowsOf(6) }))).toMatchObject({ count: 6, shape: "types", rows: [] });
    // Counted by the knowledge base, not by the marks: three hundred documents of which the map drew a hundred are three hundred.
    expect(knowledgeCard(knowledge([200, 100], { nodes: rowsOf(100) })).count).toBe(300);
    // Documents the marks do not hold keep the card to its bars: five documents it cannot list are not five empty rows.
    expect(knowledgeCard(knowledge([5], { nodes: [] }))).toMatchObject({ count: 5, shape: "types", rows: [] });
  });

  it("names five kinds at most and folds the rest into 其他, whose count is theirs", () => {
    const card = knowledgeCard(knowledge([40, 30, 20, 10, 9, 8, 7]));
    expect(card.types.map((type) => [type.label, type.count])).toEqual([["类型0", 40], ["类型1", 30], ["类型2", 20], ["类型3", 10], ["其他", 24]]);
    expect(card.count).toBe(124);
    expect(knowledgeCard(knowledge([40, 30, 20, 10, 9])).types).toHaveLength(5);
    expect(knowledgeCard(knowledge([40, 30, 20, 10, 9])).types.some((type) => type.label === "其他")).toBe(false);
  });

  it("says how many memories rest on a document that changed, was withdrawn or expired — and not those that need a look for another reason", () => {
    const card = knowledgeCard(knowledge([3], { nodes: [
      memory("a", { state: "check", reason: "source-changed" }), memory("b", { state: "check", reason: "source-retracted" }), memory("c", { state: "check", reason: "conflict" }), memory("d", { state: "check", reason: "expired" }),
      memory("e", { state: "replaced", reason: null }),
    ] }));
    expect(card.changed).toBe(2);
  });

  it("falls back to the marks when the control plane has no inventory (an older one)", () => {
    const old = doc({ nodes: [document("a"), document("b", { group: "数据表" })], summary: { memories: 0, documents: 2, methods: 0, projects: 0, needsLook: 0, since: null } });
    delete (old.facets as { documentTypes?: unknown }).documentTypes;
    expect(knowledgeCard(old)).toMatchObject({ count: 2, shape: "rows" });
  });
});

describe("收到的", () => {
  const pack = (id: string, importedAt: string | null): ReceivedCapsule => ({
    id, revision: 1, title: `包 ${id}`, description: "", issuerTrust: "verified", importedAt, enabled: false, counts: {}, methods: [], scanned: true, waiting: 0, scan: null,
  });

  it("is a recipe at 0 and the packs as rows, the newest first, eight at most", () => {
    expect(receivedCard([])).toMatchObject({ count: 0, shape: "recipe", rows: [], more: 0 });
    const card = receivedCard([pack("a", "2026-09-01T00:00:00Z"), pack("b", "2026-10-01T00:00:00Z")]);
    expect([card.shape, card.rows.map((row) => row.id)]).toEqual(["rows", ["b", "a"]]);
    const long = receivedCard(many(11, (index) => pack(`p${index}`, `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00Z`)));
    expect([long.count, long.rows.length, long.more]).toEqual([11, 8, 3]);
  });
});

describe("what a capsule would hand over, in the three words of its card", () => {
  it("counts methods, standards and preferences, and background — a kind that is neither is background", () => {
    const entries = ["method_preference", "method_preference", "preference", "writing_style", "correction", "tooling", "behavior", "profile", "expertise", "project_fact", "tension"].map((factKind) => ({ factKind }));
    expect(workStyle(entries)).toEqual({ methods: 2, standards: 5, background: 4, total: 11 });
    expect(workStyle([])).toEqual({ methods: 0, standards: 0, background: 0, total: 0 });
  });
});

describe("需要看一眼", () => {
  it("lists five, the most worth knowing first — a withdrawn source before a changed one — and says how many more", () => {
    const marked = many(7, (index) => memory(`k${index}`, { state: "check", reason: index === 6 ? "source-retracted" : index % 2 ? "conflict" : "source-changed", at: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00.000Z` }));
    const look = needsLook(doc({ nodes: marked, summary: { memories: 7, documents: 0, methods: 0, projects: 0, needsLook: 7, since: null } }));
    expect([look.count, look.rows.length, look.more]).toEqual([7, 5, 2]);
    expect(look.rows[0]).toMatchObject({ id: "memory:k6", reason: "依据的资料已撤回" });
    expect(look.rows[1]!.reason).toBe("和另一条说法不一致");
  });

  it("is empty when nothing needs one", () => {
    expect(needsLook(doc({ nodes: [memory("a")] }))).toEqual({ count: 0, rows: [], more: 0 });
  });
});

describe("成长", () => {
  const created = (id: string, at: string): MapEvent => ({ id: `memory:${id}:created`, at, type: "memory", change: "created", ref: `memory:${id}`, lane: "account", text: `记忆 ${id}` });
  const days = (...list: Array<[string, number]>): MapDay[] => list.map(([t, count]) => ({ t, memory: 0, run: 0, method: 0, feedback: 0, document: count }));
  const grown = (over: Partial<OverviewDoc> = {}) => doc({ ...over });
  const pack = (importedAt: string | null) => ({ title: "李主任的工作方式", importedAt });
  const formatDay = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;

  it("counts gains only: the memories noted, the methods learned, the documents added, the packs taken in — and not what was replaced, forgotten or merely changed", () => {
    const events = growthEvents(grown({
      nodes: [memory("a"), memory("b", { state: "replaced" })],
      events: [
        created("a", "2026-09-22T02:00:00Z"), created("b", "2026-09-20T02:00:00Z"),
        { id: "memory:a:v2", at: "2026-09-23T02:00:00Z", type: "memory", change: "updated", ref: "memory:a", lane: "account" },
        { id: "memory:a:gone", at: "2026-09-25T02:00:00Z", type: "memory", change: "archived", ref: "memory:a", lane: "account" },
        { id: "run:1", at: "2026-09-26T02:00:00Z", type: "run", change: "completed", ref: "run:1", lane: "account" },
      ],
      buckets: { unit: "day", series: days(["2026-09-21", 2]) },
    }), [pack("2026-09-27T01:00:00Z"), pack(null)], [method("m", "2026-09-24T03:00:00Z"), method("gone", "2026-09-25T03:00:00Z", { status: "retired" })]);
    expect(events.map((event) => [event.lane, event.day])).toEqual([
      ["documents", "2026-09-21"], ["documents", "2026-09-21"], ["noted", "2026-09-22"], ["learned", "2026-09-24"], ["received", "2026-09-27"],
    ]);
  });

  it("is a dot for each event up to thirty, weekly counts for each lane at thirty-one, and a lane only when it has events", () => {
    const one = (lane: "noted" | "documents", day: string) => ({ lane, day, title: null, open: null });
    const strip = (count: number) => growthOf(many(count, (index) => one(index % 2 ? "noted" : "documents", `2026-09-${String(1 + (index % 28)).padStart(2, "0")}`)), "2026-10-01", formatDay);
    expect(growthOf([], "2026-10-01", formatDay)).toMatchObject({ total: 0, shape: "none", title: null, lanes: [], first: null });
    expect(strip(1)).toMatchObject({ total: 1, shape: "dots", lanes: ["documents"] });
    expect(strip(5).shape).toBe("dots");
    expect(strip(6).shape).toBe("dots");
    expect(strip(30)).toMatchObject({ total: 30, shape: "dots", lanes: ["noted", "documents"] });
    const folded = strip(31);
    expect([folded.total, folded.shape]).toEqual([31, "weeks"]);
    expect(folded.weeks.reduce((sum, week) => sum + week.counts.noted + week.counts.documents, 0)).toBe(31);
    expect(folded.weeks.every((week) => week.counts.learned === 0 && week.counts.received === 0)).toBe(true);
  });

  it("says what it adds up to in the time view's grammar: since the first day, each lane that has events, in its own unit", () => {
    const events = [
      { lane: "noted" as const, day: "2026-09-22", title: null, open: null }, { lane: "noted" as const, day: "2026-09-23", title: null, open: null },
      { lane: "learned" as const, day: "2026-09-24", title: null, open: null }, ...many(3, () => ({ lane: "documents" as const, day: "2026-09-25", title: null, open: null })),
    ];
    expect(growthOf(events, "2026-10-12", formatDay).title).toBe("自9月22日起，记下 2 件、学会 1 种做法、放进 3 份资料");
    expect(growthOf([{ lane: "received", day: "2026-10-01", title: null, open: null }], "2026-10-12", formatDay).title).toBe("自10月1日起，收下 1 个胶囊");
  });

  it("counts days on the axis under fourteen days of history and weeks after", () => {
    const one = (day: string) => ({ lane: "noted" as const, day, title: null, open: null });
    expect(growthOf([one("2026-10-05")], "2026-10-12", formatDay).axis).toBe("days");
    expect(growthOf([one("2026-10-05")], "2026-10-18", formatDay).axis).toBe("days");
    expect(growthOf([one("2026-10-05")], "2026-10-19", formatDay).axis).toBe("weeks");
  });

  it("counts the gains of the last thirty days, today included", () => {
    const at = (day: string) => ({ lane: "noted" as const, day, title: null, open: null });
    expect(recentGains([at("2026-09-13"), at("2026-09-12"), at("2026-10-12"), at("2026-10-13")], "2026-10-12")).toBe(2);
  });

  it("is read from the document: its zone's today, its events, nodes and days — and a card's own growth equals its own sentence", () => {
    const card = growthCard(grown({ nodes: [memory("a")], events: [created("a", "2026-10-10T02:00:00Z")] }), [], [], new Date("2026-10-12T05:00:00Z"));
    expect(card).toMatchObject({ total: 1, shape: "dots", today: "2026-10-12", axis: "days" });
    expect(card.title).toBe("自10月10日起，记下 1 件");
  });
});

describe("the sentence over the cards", () => {
  const links = { memories: "/m", methods: "/t", documents: "/k", recent: "/g" };
  const text = (parts: ReturnType<typeof overviewHeadline>) => (parts ?? []).map((part) => (typeof part === "string" ? part : String(part.n))).join("");

  it("says what the capsule holds, each number a link to its part, and the last month's gains", () => {
    const parts = overviewHeadline({ memories: 12, methods: 3, documents: 47, recent: 5 }, links);
    expect(text(parts)).toBe("胶囊里有 12 件关于你和项目的事、3 种做法、47 份资料；近 30 天新增 5 件。");
    expect((parts ?? []).filter((part) => typeof part !== "string").map((part) => typeof part !== "string" && part.to)).toEqual(["/m", "/t", "/k", "/g"]);
  });

  it("says that nothing about the person is written yet when documents are all there is", () => {
    expect(text(overviewHeadline({ memories: 0, methods: 0, documents: 47, recent: 0 }, links))).toBe("胶囊里有 47 份资料，还没有记下关于你的事。");
  });

  it("leaves out the number of a part whose read failed, and never turns it into a zero", () => {
    expect(text(overviewHeadline({ memories: null, methods: 3, documents: 47, recent: null }, links))).toBe("胶囊里有 3 种做法、47 份资料。");
    expect(text(overviewHeadline({ memories: 12, methods: null, documents: null, recent: 2 }, links))).toBe("胶囊里有 12 件关于你和项目的事；近 30 天新增 2 件。");
    expect(overviewHeadline({ memories: null, methods: null, documents: null, recent: null }, links)).toBeNull();
  });

  it("has no sentence for an empty capsule: its cards are recipes", () => {
    expect(overviewHeadline({ memories: 0, methods: 0, documents: 0, recent: 0 }, links)).toBeNull();
  });
});

describe("where a part leads", () => {
  it("is the map narrowed to it, or the time view for the growth", () => {
    expect(partAddress("you")).toBe("/app/memory/map?part=you");
    expect(partAddress("knowledge")).toBe("/app/memory/map?part=knowledge");
    expect(partAddress("growth")).toBe("/app/memory/map?view=time");
    expect(partAddress("look")).toBe("/app/memory/map?look=1");
  });
});
