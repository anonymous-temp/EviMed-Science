import { describe, expect, it } from "vitest";
import type { MapEdge, MapEvent, MapNode } from "@/lib/memoryMapClient";
import { freshSignals, memoryRingSpec, ringFigures, ringHeat, ringLog, ringMarks } from "./memoryRing";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const memory = (id: string, extra: Partial<MapNode> = {}): MapNode => ({
  id: `memory:${id}`, type: "memory", subtype: "project_fact", label: `记忆 ${id}`, weight: 0.5, at: "2026-10-01T00:00:00.000Z", state: "current", freshness: 0.8, ...extra,
});
const you: MapNode = { id: "you:account", type: "you", label: "林舟" };
const project: MapNode = { id: "project:p1", type: "project", label: "心衰随访", projectId: "p1" };
const NODES: MapNode[] = [
  you, project,
  memory("a", { subtype: "preference", at: "2026-10-02T00:00:00.000Z" }),
  memory("b", { subtype: "correction", projectId: "p1", recalledAt: "2026-11-25T12:30:00.000Z" }),
  memory("c", { projectId: "p1", weight: 1 }),
  memory("old", { state: "replaced" }),
  { id: "document:d", type: "document", label: "随访方案", at: "2026-09-01T00:00:00.000Z" },
];
const EDGES: MapEdge[] = [
  { from: "memory:b", to: "memory:old", type: "replaces" },
  { from: "memory:c", to: "document:d", type: "rests-on" },
  { from: "memory:c", to: "project:p1", type: "belongs-to" },
  { from: "memory:a", to: "memory:b", type: "conflicts" },
];

describe("the ring of a memory", () => {
  it("holds what the memory holds and none of its structure", () => {
    expect(ringMarks(NODES).map((node) => node.id)).toEqual(["memory:a", "memory:b", "memory:c", "memory:old", "document:d"]);
  });

  it("by kind: a segment for each kind it holds, in the legend's order, with the centre the person", () => {
    const spec = memoryRingSpec(NODES, EDGES, { by: "kind", now: NOW });
    expect(spec.segments.map((segment) => [segment.id, segment.label, segment.code])).toEqual([
      ["preference", "偏好", "PREFS"], ["correction", "纠正", "FIXES"], ["fact", "项目事实", "FACTS"], ["document", "资料", "SOURCES"],
    ]);
    expect(spec.centre).toEqual({ label: "林舟", tone: "you" });
    expect(spec.cells.find((cell) => cell.id === "memory:old")).toMatchObject({ segment: "fact", state: "replaced", bright: 0 });
  });

  it("by project: each project that holds something, then what belongs to none, every cell keeping its kind's colour", () => {
    const spec = memoryRingSpec(NODES, EDGES, { by: "project", now: NOW });
    expect(spec.segments.map((segment) => [segment.id, segment.label])).toEqual([["project:p1", "心衰随访"], ["project:none", "不属于项目"]]);
    expect(spec.cells.find((cell) => cell.id === "memory:b")).toMatchObject({ segment: "project:p1", tone: "correction" });
    expect(spec.cells.find((cell) => cell.id === "memory:a")).toMatchObject({ segment: "project:none", tone: "preference" });
  });

  it("puts a memory of a project the document does not know with what belongs to none", () => {
    const spec = memoryRingSpec([you, memory("x", { projectId: "elsewhere" })], [], { by: "project", now: NOW });
    expect(spec.cells[0].segment).toBe("project:none");
  });

  it("orders a segment by when each was written, weighs a cell by its weight, and lights a recall of the last three days", () => {
    const spec = memoryRingSpec(NODES, EDGES, { by: "kind", now: NOW });
    const c = spec.cells.find((cell) => cell.id === "memory:c");
    const b = spec.cells.find((cell) => cell.id === "memory:b");
    expect(c?.order).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(c?.length).toBe(1);
    expect(b?.spark).toBe(true);
    expect(c?.spark).toBe(false);
  });

  it("draws the relations between two cells, flowing except a conflict, and never belonging", () => {
    const spec = memoryRingSpec(NODES, EDGES, { by: "kind", now: NOW });
    expect(spec.links.map((link) => [link.from, link.to, link.tone, link.flow])).toEqual([
      ["memory:b", "memory:old", "line-replaces", true],
      ["memory:c", "document:d", "line-rests", true],
      ["memory:a", "memory:b", "line-conflicts", false],
    ]);
  });
});

const EVENTS: MapEvent[] = [
  { id: "e1", at: "2026-11-26T11:30:00.000Z", type: "memory", change: "created", ref: "memory:a", text: "写短一点" },
  { id: "e2", at: "2026-11-26T09:10:00.000Z", type: "memory", change: "archived", ref: "memory:gone", text: "夜班安排" },
  { id: "e3", at: "2026-11-01T00:00:00.000Z", type: "memory", change: "created", ref: "memory:c" },
  { id: "e4", at: "2026-11-26T11:00:00.000Z", type: "memory", change: "renamed", ref: "memory:c" },
  { id: "future", at: "2026-11-27T00:00:00.000Z", type: "memory", change: "created", ref: "memory:c" },
];

describe("the full-screen panels", () => {
  it("logs what the document says happened and each memory's last recall, newest first, nothing to come and nothing it cannot name", () => {
    const log = ringLog(NODES, EVENTS, NOW);
    expect(log.map((entry) => [entry.key, entry.verb, entry.word, entry.text, entry.cell])).toEqual([
      ["e1", "记下", "偏好", "写短一点", "memory:a"],
      ["e2", "忘记", "记忆", "夜班安排", null],
      ["recall:memory:b", "想起", "纠正", "记忆 b", "memory:b"],
      ["e3", "记下", "项目事实", "记忆 c", "memory:c"],
    ]);
  });

  it("counts the last 24 hours by the hour, a row for each kind with anything in them", () => {
    const heat = ringHeat(ringLog(NODES, EVENTS, NOW), NOW);
    expect(heat.map((row) => row.word)).toEqual(["偏好", "纠正", "记忆"]);
    const preference = heat.find((row) => row.word === "偏好");
    expect(preference?.hours).toHaveLength(24);
    expect(preference?.hours[23]).toBe(1);
    expect(heat.find((row) => row.word === "纠正")?.hours[0]).toBe(1);
  });

  it("counts each figure from the picture's own marks and events, a folded group by what it folds", () => {
    const folded: MapNode = { id: "cluster:docs", type: "cluster", memberType: "document", count: 9, label: "" };
    const figures = Object.fromEntries(ringFigures({ nodes: [...NODES, folded], edges: EDGES, events: EVENTS }, NOW).map((figure) => [figure.label, figure.value]));
    expect(figures).toEqual({ 现行的记忆: 3, "近 7 天被想起": 1, "近 30 天记下": 2, 关联: 3, 已被替代: 1, 资料: 10 });
  });

  it("takes the documents from the knowledge base's own count, and says “—” for what a source that did not answer would count", () => {
    const read = Object.fromEntries(ringFigures({ nodes: NODES, edges: EDGES, events: EVENTS, documentTypes: [{ count: 30 }, { count: 4 }] }, NOW).map((figure) => [figure.label, figure.value]));
    expect(read.资料).toBe(34);
    const failed = Object.fromEntries(ringFigures({ nodes: NODES, edges: EDGES, events: EVENTS, missing: ["documents", "native-memory"] }, NOW).map((figure) => [figure.label, figure.value]));
    expect(failed).toEqual({ 现行的记忆: null, "近 7 天被想起": null, "近 30 天记下": null, 关联: null, 已被替代: null, 资料: null });
    // The relations come from every source: the knowledge graph unread leaves the memories' figures and makes the relations unknown.
    const graphless = Object.fromEntries(ringFigures({ nodes: NODES, edges: EDGES, events: EVENTS, missing: ["knowledge-graph"] }, NOW).map((figure) => [figure.label, figure.value]));
    expect(graphless).toMatchObject({ 现行的记忆: 3, 关联: null, 资料: 1 });
  });

  it("counts the day's activity from everything in it, however long the log", () => {
    const many: MapEvent[] = Array.from({ length: 45 }, (_, i) => ({ id: `x${i}`, at: new Date(NOW - (i + 1) * 60_000).toISOString(), type: "memory", change: "created", ref: "memory:a" }));
    const morning: MapEvent = { id: "m", at: new Date(NOW - 20 * 3_600_000).toISOString(), type: "memory", change: "created", ref: "memory:b" };
    const all = ringLog(NODES, [...many, morning], NOW);
    expect(all.length).toBe(47);
    const heat = ringHeat(all, NOW);
    expect(heat.reduce((sum, row) => sum + row.hours.reduce((a, b) => a + b, 0), 0)).toBe(47);
    expect(heat.find((row) => row.word === "纠正")?.hours.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("what happened between two readings", () => {
  it("sends nothing on the first reading, and a spark for each memory written, changed or recalled since", () => {
    const first = { nodes: NODES, events: EVENTS.slice(0, 2) };
    expect(freshSignals(null, first)).toEqual([]);
    const next = {
      nodes: NODES.map((node) => (node.id === "memory:c" ? { ...node, recalledAt: "2026-11-26T11:59:00.000Z" } : node)),
      events: [...EVENTS.slice(0, 2), { id: "e9", at: "2026-11-26T11:58:00.000Z", type: "memory" as const, change: "created", ref: "memory:a" }, { id: "e10", at: "2026-11-26T11:58:00.000Z", type: "memory" as const, change: "created", ref: "memory:nowhere" }],
    };
    expect(freshSignals(first, next).sort()).toEqual(["memory:a", "memory:c"]);
    expect(freshSignals(next, next)).toEqual([]);
  });
});
