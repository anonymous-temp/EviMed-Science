import { describe, expect, it } from "vitest";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import { derivedTopics, isAboutYou, markKindWord, narrowMap, relationTitle } from "./mapModel";

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
const doc = { nodes, edges };
const none = { topic: null, look: false, q: "" };
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

describe("what is about the person", () => {
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
    const withTopics = { nodes: small, edges: [] };
    const kind = narrowMap(withTopics, { ...none, topic: "derived:kind:偏好" });
    expect(ids(kind.nodes)).toEqual(["memory:a"]);
    expect(ids(narrowMap(withTopics, { ...none, topic: "derived:project:p" }).nodes)).toEqual(["memory:c", "memory:d"]);
    expect(derivedTopics({ nodes: small }, () => null, now).some((topic) => topic.label === "未归入项目")).toBe(true);
  });
});

describe("what the relation picture holds, in a sentence", () => {
  it("counts the memories in force and what they are tied to, and leaves out what is not there", () => {
    expect(relationTitle(nodes)).toBe("3 件现行的记忆，连着 1 份资料和 1 个项目");
    expect(relationTitle(nodes.filter((node) => node.type === "memory"))).toBe("3 件现行的记忆");
    expect(relationTitle(nodes.filter((node) => node.type !== "memory"))).toBe("记忆、资料和项目的关系");
  });
});

describe("the name of a kind of mark", () => {
  it("names a mark of every kind", () => {
    expect(markKindWord(nodes[6]!)).toBe("资料");
    expect(markKindWord(nodes[7]!)).toBe("论文");
    expect(markKindWord({ id: "cluster:x", type: "cluster", label: "x", group: "偏好", count: 12 })).toBe("偏好（12 个）");
    expect(markKindWord({ id: "reference:evidence_card:c", type: "reference", subtype: "evidence_card", label: "证据卡" })).toBe("证据卡");
  });
});
