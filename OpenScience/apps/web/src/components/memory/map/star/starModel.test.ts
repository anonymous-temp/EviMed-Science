import { describe, expect, it } from "vitest";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import {
  PICK_SLOP, YOU_HUB, packSky, brightnessOf, encodingWords, familyCounts, familyOf, fibresOf, freshnessWord, homeDistance, isRecentlyRecalled, layoutStars, markAt, nearestMark, neighboursOf, replayStart,
  type Point3,
} from "./starModel";

const memory = (id: string, extra: Partial<MapNode> = {}): MapNode => ({ id: `memory:${id}`, type: "memory", subtype: "project_fact", label: id, weight: 0.5, at: "2026-10-01T00:00:00.000Z", state: "current", freshness: 0.8, ...extra });
const project = (id: string): MapNode => ({ id: `project:${id}`, type: "project", label: id, projectId: id });
const you: MapNode = { id: YOU_HUB, type: "you", label: "你" };
const NOW = Date.parse("2026-10-30T00:00:00.000Z");

describe("families and the legend", () => {
  it("tells a mark's family by its kind, a cluster by what it folds, and the structure has none", () => {
    expect(familyOf(memory("a", { subtype: "correction" }))).toBe("correction");
    expect(familyOf(memory("a", { subtype: "behavior" }))).toBe("about");
    expect(familyOf({ type: "cluster", subtype: "decision", memberType: "memory" })).toBe("decision");
    expect(familyOf({ type: "cluster", memberType: "document" })).toBe("document");
    expect(familyOf({ type: "page" })).toBe("document");
    expect(familyOf({ type: "you" })).toBeNull();
    expect(familyOf({ type: "project" })).toBeNull();
  });

  it("counts what is in force, a cluster by what it folds, in the one order, naming only what the picture has", () => {
    const counts = familyCounts([
      you, memory("a", { subtype: "decision" }), memory("b"), memory("old", { state: "replaced" }),
      { id: "cluster:x", type: "cluster", memberType: "memory", subtype: "project_fact", count: 12, label: "" },
    ]);
    expect(counts).toEqual([{ family: "fact", word: "项目事实", count: 13 }, { family: "decision", word: "决定", count: 1 }]);
  });

  it("names an encoding only when the picture has it", () => {
    expect(encodingWords([you], NOW)).toEqual([]);
    expect(encodingWords([memory("a")], NOW)).toEqual(["越亮越新、越常用到"]);
    expect(encodingWords([memory("a", { recalledAt: "2026-10-29T00:00:00.000Z" }), memory("b", { state: "replaced" })], NOW)).toEqual(["越亮越新、越常用到", "流光是最近被想起", "灰色连橙线是已被替代"]);
  });
});

describe("brightness and its words", () => {
  it("draws what was replaced dark and what has no word at an even middle", () => {
    expect(brightnessOf(memory("a", { state: "replaced" }))).toBe(0);
    expect(brightnessOf({ type: "document" })).toBe(0.7);
    expect(brightnessOf(memory("a", { freshness: 2 }))).toBe(1);
  });

  it("says what happened, and never that a dim memory is gone", () => {
    expect(freshnessWord(memory("a", { freshness: 0.9 }))).toBe("最近用到");
    expect(freshnessWord(memory("a", { freshness: 0.5 }))).toBe("有一阵没用到");
    expect(freshnessWord(memory("a", { freshness: 0.1 }))).toContain("仍然记着");
    expect(freshnessWord({ type: "document" })).toBe("");
  });

  it("a recall sends a spark for three days, an old statement never", () => {
    expect(isRecentlyRecalled({ recalledAt: "2026-10-29T00:00:00.000Z" }, NOW)).toBe(true);
    expect(isRecentlyRecalled({ recalledAt: "2026-10-20T00:00:00.000Z" }, NOW)).toBe(false);
    expect(isRecentlyRecalled({ recalledAt: "2026-10-29T00:00:00.000Z", state: "replaced" }, NOW)).toBe(false);
    expect(isRecentlyRecalled({}, NOW)).toBe(false);
  });
});

describe("where a mark stands", () => {
  const nodes: MapNode[] = [
    you, project("p1"), project("p2"),
    memory("a", { projectId: "p1" }), memory("b", { projectId: "p2" }), memory("c", { subtype: "preference" }),
    memory("old", { projectId: "p1", state: "replaced" }), memory("older", { projectId: "p1", state: "replaced" }),
    { id: "document:d", type: "document", label: "d", projectId: "p1" }, { id: "entity:e", type: "entity", label: "e", projectId: "p1" },
    { id: "method:m", type: "method", label: "m" },
  ];
  const edges: MapEdge[] = [
    { from: "memory:a", to: "memory:old", type: "replaces" }, { from: "memory:old", to: "memory:older", type: "replaces" },
    { from: "entity:e", to: "document:d", type: "relates" }, { from: "memory:a", to: "project:p1", type: "belongs-to" },
  ];

  it("gives the same picture for the same document", () => {
    expect(Object.fromEntries(layoutStars(nodes, edges).positions)).toEqual(Object.fromEntries(layoutStars([...nodes].reverse(), edges).positions));
  });

  it("moves nothing when a mark is added: a new memory takes its place and the sky stays", () => {
    const before = layoutStars(nodes, edges).positions;
    const after = layoutStars([...nodes, memory("new", { projectId: "p1", at: "2026-10-29T00:00:00.000Z" })], edges).positions;
    for (const [id, place] of before) expect(after.get(id), id).toEqual(place);
    expect(after.has("memory:new")).toBe(true);
  });

  it("moves no project when another comes or goes", () => {
    const many = Array.from({ length: 6 }, (_, index) => project(`p${index}`));
    const before = layoutStars([you, ...many], []);
    const after = layoutStars([you, ...many.slice(0, 2), ...many.slice(3)], []);
    const moved = after.hubs.filter((hub) => JSON.stringify(hub.position) !== JSON.stringify(before.positions.get(hub.id)));
    expect(moved.length).toBeLessThanOrEqual(1);
    expect(layoutStars([you, project("p4")], []).positions.get("project:p4")).toEqual(before.positions.get("project:p4"));
  });

  it("keeps projects apart, each with room for its shells' middle", () => {
    const many = Array.from({ length: 16 }, (_, index) => project(`p${index}`));
    const places = layoutStars(many, []).hubs.filter((hub) => hub.kind === "project").map((hub) => hub.position);
    for (let a = 0; a < places.length; a += 1) for (let b = a + 1; b < places.length; b += 1) {
      expect(Math.hypot(places[a][0] - places[b][0], places[a][1] - places[b][1], places[a][2] - places[b][2])).toBeGreaterThan(90);
    }
    expect(new Set(places.map((place) => place.join())).size).toBe(16);
  });

  it("hangs a project's memory from the project and everything else from the account, an unknown project too", () => {
    const layout = layoutStars([...nodes, memory("gone", { projectId: "nowhere" })], edges);
    expect(layout.homes.get("memory:a")).toBe("project:p1");
    expect(layout.homes.get("memory:c")).toBe(YOU_HUB);
    expect(layout.homes.get("memory:gone")).toBe(YOU_HUB);
  });

  it("stands an old statement by what replaced it, and a concept by its document", () => {
    const { positions } = layoutStars(nodes, edges);
    const gap = (a: string, b: string) => Math.hypot(...(positions.get(a) as Point3).map((value, index) => value - (positions.get(b) as Point3)[index]));
    expect(gap("memory:old", "memory:a")).toBeLessThan(30);
    expect(gap("memory:older", "memory:old")).toBeLessThan(30);
    expect(gap("entity:e", "document:d")).toBeLessThan(45);
  });

  it("survives a chain that closes on itself", () => {
    const loop: MapEdge[] = [{ from: "memory:x", to: "memory:y", type: "replaces" }, { from: "memory:y", to: "memory:x", type: "replaces" }];
    const layout = layoutStars([you, memory("x", { state: "replaced" }), memory("y", { state: "replaced" })], loop);
    expect(layout.positions.has("memory:x") && layout.positions.has("memory:y")).toBe(true);
  });

  it("draws an axon for what hangs from a hub, a trunk for a project, and nothing for belonging", () => {
    const layout = layoutStars(nodes, edges);
    const fibres = fibresOf(nodes, edges, layout);
    expect(fibres.filter((fibre) => fibre.kind === "trunk")).toHaveLength(2);
    expect(fibres.some((fibre) => fibre.kind === "belongs-to")).toBe(false);
    expect(fibres.some((fibre) => fibre.kind === "axon" && fibre.to === "memory:old")).toBe(false);
    expect(fibres.some((fibre) => fibre.kind === "axon" && fibre.to === "entity:e")).toBe(false);
    expect(fibres.some((fibre) => fibre.kind === "replaces" && fibre.from === "memory:a")).toBe(true);
    expect([...neighboursOf("memory:a", fibres)].sort()).toEqual(["memory:a", "memory:old", "project:p1"]);
  });

  it("stands the camera back far enough for a narrow canvas too", () => {
    expect(homeDistance(400, 52, 0.5)).toBeGreaterThan(homeDistance(400, 52, 2));
    expect(homeDistance(1, 52, 2)).toBe(300);
  });
});

describe("a shared pack's sky", () => {
  it("holds the sender and one mark an entry, tied by nothing but the sender", () => {
    const { nodes, edges } = packSky([{ id: "e1", factKind: "method_preference", text: "先列框架" }, { id: "e2", factKind: "writing_style", text: "句子短" }], "林晓");
    expect(edges).toEqual([]);
    const layout = layoutStars(nodes, edges);
    expect(layout.hubs).toHaveLength(1);
    expect(layout.hubs[0].label).toBe("林晓");
    expect(nodes.map((node) => familyOf(node))).toEqual([null, "method", "preference"]);
    expect(layout.positions.has("memory:e1")).toBe(true);
    expect(packSky([], null).nodes[0].label).toBe("对方");
  });
});

describe("pressing a mark", () => {
  const mark = (id: string, x: number, y: number, depth = 0.5, radius = 2) => ({ id, x, y, depth, radius });
  it("takes a mark a pixel wide within the slop and nothing beyond it", () => {
    expect(nearestMark([mark("a", 100, 100)], 100 + PICK_SLOP - 1, 100)).toBe("a");
    expect(nearestMark([mark("a", 100, 100)], 100 + PICK_SLOP + 1, 100)).toBeNull();
  });
  it("holds a large mark by its size", () => {
    expect(nearestMark([mark("a", 100, 100, 0.5, 30)], 130, 100)).toBe("a");
  });
  it("of two at one place takes the one in front, and of two apart the nearer", () => {
    expect(nearestMark([mark("far", 100, 100, 0.9), mark("near", 100, 100, 0.2)], 100, 100)).toBe("near");
    expect(nearestMark([mark("a", 90, 100), mark("b", 102, 100)], 100, 100)).toBe("b");
  });
});

describe("the replay", () => {
  it("starts at the earliest mark, and has nothing to play with no time at all", () => {
    expect(replayStart([memory("a", { at: "2026-01-01T00:00:00.000Z" }), memory("b")])).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(replayStart([you])).toBeNull();
  });
  it("shows a mark from when it began, and an old statement in force until it was replaced", () => {
    const old = memory("old", { state: "replaced", at: "2026-02-01T00:00:00.000Z", until: "2026-06-01T00:00:00.000Z" });
    expect(markAt(old, Date.parse("2026-01-01T00:00:00.000Z"))).toBe("absent");
    expect(markAt(old, Date.parse("2026-03-01T00:00:00.000Z"))).toBe("current");
    expect(markAt(old, Date.parse("2026-07-01T00:00:00.000Z"))).toBe("replaced");
    expect(markAt(old, null)).toBe("replaced");
    expect(markAt({ state: "current" }, Date.parse("2020-01-01T00:00:00.000Z"))).toBe("current");
  });
});
