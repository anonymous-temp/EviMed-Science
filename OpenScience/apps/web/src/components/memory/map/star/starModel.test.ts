import { describe, expect, it } from "vitest";
import type { MapNode } from "@/lib/memoryMapClient";
import { YOU_HUB, packSky, brightnessOf, encodingWords, familyCounts, familyOf, freshnessWord, isRecentlyRecalled, replayStart } from "./starModel";

const memory = (id: string, extra: Partial<MapNode> = {}): MapNode => ({ id: `memory:${id}`, type: "memory", subtype: "project_fact", label: id, weight: 0.5, at: "2026-10-01T00:00:00.000Z", state: "current", freshness: 0.8, ...extra });
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
    expect(encodingWords([memory("a")], NOW)).toEqual(["一格一条，越亮越新、越常用到"]);
    expect(encodingWords([memory("a", { recalledAt: "2026-10-29T00:00:00.000Z" }), memory("b", { state: "replaced" })], NOW, true))
      .toEqual(["一格一条，越亮越新、越常用到", "光点飞向最近被想起的", "线上的流光是它们的关联", "灰色是已被替代"]);
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

describe("a shared pack's sky", () => {
  it("holds the sender and one mark an entry, tied by nothing but the sender", () => {
    const { nodes, edges } = packSky([{ id: "e1", factKind: "method_preference", text: "先列框架" }, { id: "e2", factKind: "writing_style", text: "句子短" }], "林晓");
    expect(edges).toEqual([]);
    expect(nodes[0]).toMatchObject({ id: YOU_HUB, type: "you", label: "林晓" });
    expect(nodes.map((node) => familyOf(node))).toEqual([null, "method", "preference"]);
    expect(packSky([], null).nodes[0].label).toBe("对方");
  });
});

describe("the replay", () => {
  it("starts at the earliest mark, and has nothing to play with no time at all", () => {
    expect(replayStart([memory("a", { at: "2026-01-01T00:00:00.000Z" }), memory("b")])).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(replayStart([you])).toBeNull();
  });
});

it("gives people and notes explicit legend families", () => {
 expect(familyOf({type:"memory",subtype:"person"})).toBe("person");
 expect(familyOf({type:"memory",subtype:"note"})).toBe("note");
});
