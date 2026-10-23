import { describe, expect, it } from "vitest";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import { derivedTopics, existingAt, headline, headlineParts, headlineText, isAboutYou, isThin, markKindWord, markRows, narrowMap, relationTitle, replayStops } from "./mapModel";

const memory = (id: string, over: Partial<MapNode> = {}): MapNode => ({ id: `memory:${id}`, type: "memory", subtype: "preference", group: "偏好", label: `记忆 ${id}`, state: "current", at: "2026-09-01T00:00:00.000Z", open: { kind: "record", id }, ...over });
const edge = (from: string, to: string, type: MapEdge["type"] = "belongs-to"): MapEdge => ({ from, to, type });

const nodes: MapNode[] = [
  { id: "you:account", type: "you", label: "你", state: "current" },
  { id: "project:p", type: "project", label: "心衰随访", state: "current", projectId: "p" },
  memory("a", { topics: ["topic:1"], at: "2026-08-01T00:00:00.000Z" }),
  memory("b", { subtype: "decision", group: "决定", topics: ["topic:1", "topic:2"], projectId: "p", at: "2026-09-10T00:00:00.000Z" }),
  memory("c", { subtype: "decision", group: "决定", state: "check", reason: "source-retracted", projectId: "p", at: "2026-09-20T00:00:00.000Z" }),
  memory("d", { state: "replaced", at: "2026-07-01T00:00:00.000Z" }),
  { id: "document:src_1", type: "document", label: "GOLD 报告", state: "current", at: "2026-09-05T00:00:00.000Z", open: { kind: "page", href: "/app/files/src_1" } },
  { id: "reference:doi:10.1/x", type: "reference", subtype: "doi", label: "10.1/x", state: "current" },
  { id: "method:m1", type: "method", label: "先给结论", state: "current", at: "2026-09-02T00:00:00.000Z", open: { kind: "method", id: "m1" } },
];
const edges: MapEdge[] = [
  edge("memory:a", "you:account"), edge("memory:b", "project:p"), edge("memory:c", "project:p"), edge("memory:d", "you:account"),
  edge("memory:b", "document:src_1", "rests-on"), edge("memory:c", "reference:doi:10.1/x", "rests-on"), edge("memory:b", "memory:d", "replaces"),
  edge("method:m1", "you:account"),
];
const facets = {
  projects: [], kinds: [], topics: [],
  dimensions: [{ id: "memory" as const, title: "各方面记了多少", previous: "30 天前", scale: "count" as const, total: 4, previousTotal: 3, axes: [
    { id: "aspect:decision", label: "已定的决策", value: 2, previousValue: 1, count: 2, kinds: ["decision"] },
    { id: "aspect:preference", label: "偏好", value: 1, previousValue: 1, count: 1, kinds: ["preference"] },
  ] }],
};
const doc = { nodes, edges, facets };
const none = { topic: null, kind: null, dimension: null, look: false, q: "" };
const ids = (list: readonly MapNode[]) => list.map((node) => node.id).sort();

describe("narrowing the document in hand", () => {
  it("leaves it whole while nothing narrows", () => {
    const whole = narrowMap(doc, none);
    expect(whole.narrowed).toBe(false);
    expect(whole.nodes).toBe(nodes);
    expect(whole.hits.size).toBe(0);
  });

  it("by topic: the memories in the topic, and what they are tied to; a method is not tied to a topic", () => {
    const narrowed = narrowMap(doc, { ...none, topic: "topic:2" });
    expect(ids(narrowed.nodes)).toEqual(["document:src_1", "memory:b", "memory:d", "project:p"]);
    expect(narrowed.edges.map((entry) => entry.type).sort()).toEqual(["belongs-to", "replaces", "rests-on"]);
    expect(narrowed.narrowed).toBe(true);
  });

  it("by kind and by an axis of the radar (the axis names the kinds it counts)", () => {
    expect(ids(narrowMap(doc, { ...none, kind: "decision" }).nodes)).toEqual(["document:src_1", "memory:b", "memory:c", "memory:d", "project:p", "reference:doi:10.1/x"]);
    expect(ids(narrowMap(doc, { ...none, dimension: "aspect:decision" }).nodes)).toEqual(ids(narrowMap(doc, { ...none, kind: "decision" }).nodes));
    expect(narrowMap(doc, { ...none, dimension: "cat:普通问答" }).narrowed).toBe(false);
  });

  it("by what needs a second look", () => {
    const look = narrowMap(doc, { ...none, look: true });
    expect(ids(look.nodes)).toEqual(["memory:c", "project:p", "reference:doi:10.1/x"]);
  });

  it("a search names hits and removes nothing; the structure is never a hit", () => {
    const found = narrowMap(doc, { ...none, q: "GOLD" });
    expect(found.nodes).toBe(nodes);
    expect([...found.hits]).toEqual(["document:src_1"]);
    expect([...narrowMap(doc, { ...none, q: "心衰" }).hits]).toEqual([]);
    expect(narrowMap(doc, { ...none, q: "  " }).hits.size).toBe(0);
    expect(narrowMap(doc, { ...none, q: "记忆 A" }).hits.has("memory:a")).toBe(true);
  });
});

describe("a part of the capsule, which is how a card of the overview opens the map", () => {
  const part = (name: "you" | "project" | "method" | "knowledge") => narrowMap(doc, { ...none, part: name });

  it("tells what is about the person from what is a project's: a project's memory, or a project's kind, is not about the person", () => {
    expect(isAboutYou(nodes[2]!)).toBe(true);
    expect(isAboutYou(nodes[3]!)).toBe(false);
    expect(isAboutYou(memory("e", { subtype: "decision" }))).toBe(false);
    expect(isAboutYou(memory("f", { subtype: "project_fact", projectId: null }))).toBe(false);
    expect(isAboutYou(memory("g", { subtype: "writing_style" }))).toBe(true);
    expect(isAboutYou({ type: "cluster", memberType: "memory", subtype: "preference", projectId: null })).toBe(true);
    expect(isAboutYou({ type: "cluster", memberType: "document", subtype: "preference", projectId: null })).toBe(false);
    expect(isAboutYou(nodes[6]!)).toBe(false);
  });

  it("关于你: the memories about the person and the account they hang from, nothing else of a project or the knowledge", () => {
    const you = part("you");
    expect(you.narrowed).toBe(true);
    // `memory:b` replaced `memory:d`: what a memory replaced is tied to it, as it is under any other narrowing.
    expect(ids(you.nodes)).toEqual(["memory:a", "memory:b", "memory:d", "you:account"]);
    expect(you.edges.map((entry) => `${entry.from}>${entry.to}`).sort()).toEqual(["memory:a>you:account", "memory:b>memory:d", "memory:d>you:account"]);
  });

  it("项目: a project's memories with the documents they rest on, the project they sit in and the documents that belong to it", () => {
    const withProjectDocument: MapNode[] = [...nodes, { id: "document:src_2", type: "document", label: "方案", state: "current", projectId: "p", at: "2026-09-06T00:00:00.000Z" }];
    const found = narrowMap({ nodes: withProjectDocument, edges: [...edges, edge("document:src_2", "project:p")], facets }, { ...none, part: "project" });
    expect(ids(found.nodes)).toEqual(["document:src_1", "document:src_2", "memory:b", "memory:c", "memory:d", "project:p", "reference:doi:10.1/x"]);
  });

  it("做法 and 知识: the learned methods and the documents, each with no memory in it", () => {
    expect(ids(part("method").nodes)).toEqual(["method:m1", "you:account"]);
    expect(ids(part("knowledge").nodes)).toEqual(["document:src_1", "reference:doi:10.1/x"]);
  });

  it("is one more narrowing among the others: a part and what needs a look are both held", () => {
    expect(ids(narrowMap(doc, { ...none, part: "project", look: true }).nodes)).toEqual(["memory:c", "project:p", "reference:doi:10.1/x"]);
    expect(ids(narrowMap(doc, { ...none, part: "you", look: true }).nodes)).toEqual([]);
  });
});

describe("the topics of a capsule the model has not grouped", () => {
  const small: MapNode[] = [
    memory("a", { subtype: "preference", at: "2026-10-01T00:00:00.000Z" }),
    memory("b", { subtype: "profile", at: "2026-10-02T00:00:00.000Z" }),
    memory("c", { subtype: "decision", projectId: "p", at: "2026-10-05T00:00:00.000Z" }),
    memory("d", { subtype: "project_fact", projectId: "p", at: "2026-07-01T00:00:00.000Z" }),
    memory("e", { subtype: "preference", state: "replaced" }),
    { id: "document:x", type: "document", label: "资料", state: "current" },
  ];
  const now = new Date("2026-10-12T00:00:00Z");
  const topics = derivedTopics({ nodes: small }, (id) => (id === "p" ? "心衰随访" : null), now);

  it("are the kinds in the memory page's words and the projects by name; a memory is in its kind and in its project", () => {
    expect(topics.map((topic) => [topic.label, topic.weight])).toEqual([["心衰随访", 2], ["偏好", 1], ["已定的决策", 1], ["背景", 1], ["项目事实", 1]]);
    expect(topics.find((topic) => topic.label === "心衰随访")?.members).toEqual(["memory:c", "memory:d"]);
    expect(topics.every((topic) => topic.derived === true)).toBe(true);
    // A replaced memory and a document are no one's topic; the 30 days' trend is the model's own count.
    expect(topics.flatMap((topic) => topic.members)).not.toContain("memory:e");
    expect(topics.find((topic) => topic.label === "心衰随访")?.trend).toBe(1);
    expect(derivedTopics({ nodes: [] }, () => null, now)).toEqual([]);
  });

  it("narrow the map to their members, the way the model's topics do, and a project the account no longer has is named plainly", () => {
    const withTopics = { nodes: small, edges: [], facets };
    const kind = narrowMap(withTopics, { ...none, topic: "derived:kind:偏好" });
    expect(ids(kind.nodes)).toEqual(["memory:a"]);
    expect(ids(narrowMap(withTopics, { ...none, topic: "derived:project:p" }).nodes)).toEqual(["memory:c", "memory:d"]);
    expect(derivedTopics({ nodes: small }, () => null, now).some((topic) => topic.label === "其他项目")).toBe(true);
  });
});

describe("the sentence the picture proves", () => {
  const summary = (memories: number, needsLook: number) => ({ memories, documents: 1, methods: 0, projects: 1, needsLook, since: null });
  it("names the count that needs a look, and makes that number a button", () => {
    const parts = headline({ summary: summary(48, 4), nodes: [0, 1, 2, 3].map((index) => memory(`s${index}`, { state: "check", reason: "source-retracted" })) });
    expect(headlineText(parts)).toBe("EviMed 记住了你的 48 件事，其中 4 件依据的资料变了或需要核对。");
    expect(parts.filter((part) => part.action).map((part) => part.text)).toEqual(["4 件"]);
  });
  it("says a conflict is a look, not a changed source", () => {
    const parts = headline({ summary: summary(10, 2), nodes: [memory("x", { state: "check", reason: "conflict" }), memory("y", { state: "check", reason: "conflict" })] });
    expect(headlineText(parts)).toBe("EviMed 记住了你的 10 件事，其中 2 件需要看一眼。");
  });
  it("has no button when there is nothing to look at, and a plain sentence when there is nothing at all", () => {
    expect(headline({ summary: summary(7, 0), nodes: [] })).toEqual([{ text: "EviMed 记住了你的 7 件事。" }]);
    expect(headline({ summary: { ...summary(0, 0), documents: 0 }, nodes: [] })).toEqual([{ text: "还没有记住什么。" }]);
  });
  it("does not say nothing is remembered over a picture of documents and methods: it says what is there", () => {
    expect(headline({ summary: summary(0, 0), nodes: [] })).toEqual([{ text: "胶囊里有 1 份资料，还没有记下关于你的事。" }]);
    expect(headlineText(headline({ summary: { ...summary(0, 0), documents: 47, methods: 3 }, nodes: [] }))).toBe("胶囊里有 47 份资料、3 种做法，还没有记下关于你的事。");
    expect(headlineText(headline({ summary: { ...summary(0, 0), documents: 0, methods: 2 }, nodes: [] }))).toBe("胶囊里有 2 种做法，还没有记下关于你的事。");
  });
});

describe("the sentence in the page's headline slot", () => {
  it("makes the number a link that narrows to what needs a look, with its unit outside the link", () => {
    const parts = headline({ summary: { memories: 48, documents: 1, methods: 0, projects: 1, needsLook: 4, since: null }, nodes: [0, 1, 2, 3].map((index) => memory(`s${index}`, { state: "check", reason: "source-retracted" })) });
    let looked = 0;
    const slot = headlineParts(parts, () => { looked += 1; });
    expect(slot).toEqual(["EviMed 记住了你的 48 件事，其中 ", { n: 4, onOpen: expect.any(Function), label: "4 件，只看这些" }, " 件", "依据的资料变了或需要核对。"]);
    (slot[1] as { onOpen: () => void }).onOpen();
    expect(looked).toBe(1);
  });
  it("is the plain sentence when nothing needs a look", () => {
    expect(headlineParts(headline({ summary: { memories: 7, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, nodes: [] }), () => undefined)).toEqual(["EviMed 记住了你的 7 件事。"]);
  });
});

describe("what the relation picture holds, in a sentence", () => {
  it("counts the memories in force and what they are tied to, and leaves out what is not there", () => {
    expect(relationTitle(nodes)).toBe("3 件现行的记忆，连着 1 份资料和 1 个项目");
    expect(relationTitle(nodes.filter((node) => node.type === "memory"))).toBe("3 件现行的记忆");
    expect(relationTitle(nodes.filter((node) => node.type !== "memory"))).toBe("记忆、资料和项目的关系");
  });
});

describe("sparse memory graphs", () => {
  it("keeps real isolated marks visible and omits only an empty graph", () => {
    expect(isThin({ nodes: [], edges: [] })).toBe(true);
    expect(isThin({ nodes: [memory("one")], edges: [] })).toBe(false);
    expect(isThin({ nodes: [memory("one"), memory("two")], edges: [] })).toBe(false);
  });
});

describe("the same marks as a list", () => {
  const formatDay = (iso: string | null | undefined) => (iso ? iso.slice(5, 10) : "");
  it("skips the structure, puts what needs a look first and what was replaced last, and says why", () => {
    const rows = markRows(nodes, { formatDay });
    expect(rows.map((row) => row.id)).toEqual(["memory:c", "memory:b", "document:src_1", "method:m1", "memory:a", "reference:doi:10.1/x", "memory:d"]);
    expect(rows[0]).toMatchObject({ id: "memory:c", state: "check", note: "依据的资料已撤回", kind: "已定的决策 · 09-20", open: { kind: "record", id: "c" } });
    expect(rows.at(-1)).toMatchObject({ id: "memory:d", state: "replaced", note: "已被后来的说法替代" });
    expect(rows.some((row) => row.id.startsWith("project:") || row.id.startsWith("you:"))).toBe(false);
  });
  it("lists only the hits of a search, and names a mark of every kind", () => {
    expect(markRows(nodes, { only: new Set(["document:src_1"]), formatDay }).map((row) => row.id)).toEqual(["document:src_1"]);
    expect(markKindWord(nodes[6])).toBe("资料");
    expect(markKindWord(nodes[7])).toBe("论文");
    expect(markKindWord({ id: "cluster:x", type: "cluster", label: "x", group: "偏好", count: 12 })).toBe("偏好（12 个）");
    expect(markKindWord({ id: "reference:evidence_card:c", type: "reference", subtype: "evidence_card", label: "证据卡" })).toBe("证据卡");
  });
});

describe("the replay", () => {
  it("stops at each moment something began and shows only what had begun, with the structure always there", () => {
    const stops = replayStops(nodes);
    expect(stops).toEqual(["2026-07-01", "2026-08-01", "2026-09-02", "2026-09-05", "2026-09-10", "2026-09-20"].map((day) => `${day}T00:00:00.000Z`));
    const early = existingAt({ nodes, edges }, "2026-08-15T00:00:00.000Z");
    expect(ids(early.nodes)).toEqual(["memory:a", "memory:d", "project:p", "reference:doi:10.1/x", "you:account"]);
    expect(early.edges.map((entry) => `${entry.from}>${entry.to}`).sort()).toEqual(["memory:a>you:account", "memory:d>you:account"]);
    expect(existingAt({ nodes, edges }, null).nodes).toHaveLength(nodes.length);
    expect(existingAt({ nodes, edges }, "2027-01-01T00:00:00.000Z").nodes).toHaveLength(nodes.length);
  });
});

