import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@/lib/sourceClient";
import kgMedical from "./knowledgeFixtures/graph-kg-medical.json";
import kgMixed from "./knowledgeFixtures/graph-kg-mixed.json";
import wikiMedical from "./knowledgeFixtures/graph-wiki-medical.json";
import {
  OVERVIEW_LIMIT, withoutIndexLines, evidenceOf, foldId, hueOfTypes, isFold, isThin, linesBetween, listedMarks, modelOf, neighbourhood, overview, searchHits, typeLabelOf,
} from "./knowledgeGraph";

const kg = modelOf(kgMedical as unknown as KnowledgeGraph);
const wiki = modelOf(wikiMedical as unknown as KnowledgeGraph);
const mixed = modelOf(kgMixed as unknown as KnowledgeGraph);

/** A graph of `count` marks in four types, every mark tied to the one before it and a few to the first. */
function big(count: number): ReturnType<typeof modelOf> {
  const types = ["drug", "trial", "outcome", "person"];
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`, path: `entities/n${index}.md`, title: `实体${index}`, entityType: types[index % 4]!, description: "", aliases: [], degree: index === 0 ? count : 1 + (index % 7), sourceId: `src_${String(index).padStart(32, "0")}`, stale: [], sources: [],
  }));
  const links = nodes.slice(1).flatMap((node, index) => [
    { source: node.id, target: `n${index}`, relation: "relates_to", label: "相关", evidence: [] },
    ...(index % 2 === 0 && index > 0 ? [{ source: node.id, target: "n0", relation: "part_of", label: "属于", evidence: [] }] : []),
  ]);
  return modelOf({ kind: "kg", nodes, links, relations: [], unresolved: 0, problems: [] } as unknown as KnowledgeGraph);
}

describe("modelOf", () => {
  it("reads the pages graph and the entity graph into one shape, with the kinds in words", () => {
    expect(wiki.kind).toBe("wiki");
    expect(wiki.marks).toHaveLength(19);
    expect(new Set(wiki.marks.map((mark) => mark.typeLabel))).toEqual(new Set(["实体", "概念", "分析", "比较", "目录"]));
    expect(kg.marks).toHaveLength(22);
    expect(new Set(kg.marks.map((mark) => mark.typeLabel))).toEqual(new Set(["试验", "药物", "结局", "文件", "疾病"]));
    expect(kg.lines.length).toBeGreaterThan(40);
    expect(kg.lines.every((line) => line.label !== "")).toBe(true);
  });

  it("leaves an unknown kind as the compile wrote it, and drops a line to a mark that is not there", () => {
    expect(typeLabelOf("kg", "regulatory_body")).toBe("regulatory body");
    const graph = { kind: "kg", nodes: [{ id: "a", path: "p", title: "甲", entityType: "x", description: "", degree: 0, sourceId: null, stale: [], sources: [] }],
      links: [{ source: "a", target: "ghost", label: "x" }, { source: "a", target: "a", label: "y" }], unresolved: 0, problems: [] } as unknown as KnowledgeGraph;
    expect(modelOf(graph).lines).toEqual([]);
  });
});

describe("overview", () => {
  it("draws a small graph whole", () => {
    expect(overview(kg).marks).toHaveLength(22);
    expect(overview(kg).folded).toEqual([]);
    expect(overview(mixed).marks.length).toBe(mixed.marks.length);
  });

  it("holds a big graph to the limit and folds the rest by type, the most connected kept", () => {
    const model = big(400);
    const view = overview(model);
    expect(view.marks).toHaveLength(OVERVIEW_LIMIT);
    expect(view.marks.some((mark) => mark.id === "n0")).toBe(true);
    expect(view.folded.reduce((sum, fold) => sum + fold.count, 0)).toBe(400 - OVERVIEW_LIMIT);
    expect(view.folded.map((fold) => fold.type).sort()).toEqual(["drug", "outcome", "person", "trial"]);
    // A line to a folded mark becomes a line from its fold, once.
    const fromFold = view.lines.filter((line) => isFold(line.from) || isFold(line.to));
    expect(fromFold.length).toBeGreaterThan(0);
    expect(new Set(fromFold.map((line) => `${line.from}|${line.to}`)).size).toBe(fromFold.length);
    const shown = new Set(view.marks.map((mark) => mark.id));
    expect(view.lines.every((line) => (shown.has(line.from) || isFold(line.from)) && (shown.has(line.to) || isFold(line.to)))).toBe(true);
  });

  it("shows every mark of a type the reader unfolded, and still folds the other types", () => {
    const view = overview(big(400), { expanded: new Set(["person"]) });
    expect(view.marks.filter((mark) => mark.type === "person")).toHaveLength(100);
    expect(view.folded.some((fold) => fold.type === "person")).toBe(false);
    expect(view.folded.some((fold) => fold.type === "drug")).toBe(true);
    expect(foldId("drug")).toBe("fold:drug");
  });
});

describe("neighbourhood", () => {
  it("is the mark and what is one step away, then two", () => {
    const rocket = kg.marks.find((mark) => mark.id === "trial-rocket-af")!;
    const near = neighbourhood(kg, rocket.id, 1);
    const ids = new Set(near.marks.map((mark) => mark.id));
    expect(ids.has(rocket.id)).toBe(true);
    for (const line of kg.lines.filter((entry) => entry.from === rocket.id || entry.to === rocket.id)) {
      expect(ids.has(line.from) && ids.has(line.to)).toBe(true);
    }
    expect(near.marks.length).toBeLessThan(kg.marks.length);
    expect(neighbourhood(kg, rocket.id, 2).marks.length).toBeGreaterThan(near.marks.length);
    expect(near.lines.every((line) => ids.has(line.from) && ids.has(line.to))).toBe(true);
  });

  it("is the whole graph for a mark that is not in it, and cut to the limit for a hub", () => {
    expect(neighbourhood(kg, "nowhere", 2)).toBe(kg);
    const cut = neighbourhood(big(400), "n0", 3);
    expect(cut.marks).toHaveLength(OVERVIEW_LIMIT);
    expect(cut.marks.some((mark) => mark.id === "n0")).toBe(true);
  });
});

describe("search, colour, lines and the list", () => {
  it("names the marks a search matches, by title, alias or kind", () => {
    expect(searchHits(kg.marks, "").size).toBe(0);
    const hits = searchHits(kg.marks, "ROCKET");
    expect([...hits].some((id) => id.includes("rocket"))).toBe(true);
    const byKind = searchHits(kg.marks, "试验");
    expect(kg.marks.filter((mark) => mark.type === "trial").every((mark) => byKind.has(mark.id))).toBe(true);
  });

  it("colours the three kinds with the most marks and leaves every other kind neutral", () => {
    const hues = hueOfTypes(kg.marks);
    expect(hues.size).toBe(3);
    expect([...hues.values()].sort()).toEqual([0, 1, 2]);
    // Seven trials, seven drugs, six outcomes: a tie goes to the name that sorts first.
    expect([hues.get("drug"), hues.get("trial"), hues.get("outcome")]).toEqual([0, 1, 2]);
    expect(hues.has("document")).toBe(false);
  });

  it("finds the lines between two marks and the documents they were read from, once each", () => {
    const first = kg.lines[0]!;
    const between = linesBetween(kg.lines, first.to, first.from);
    expect(between).toContain(first);
    const documents = evidenceOf(between);
    expect(documents.length).toBeGreaterThan(0);
    expect(new Set(documents.map((entry) => entry.sourceId)).size).toBe(documents.length);
  });

  it("lists the most connected first, or the hits alone", () => {
    const rows = listedMarks(kg.marks, new Set());
    expect(rows[0]!.degree).toBeGreaterThanOrEqual(rows.at(-1)!.degree);
    expect(listedMarks(kg.marks, new Set(["trial-rocket-af"])).map((mark) => mark.id)).toEqual(["trial-rocket-af"]);
  });

  it("calls a graph with almost nothing in it thin", () => {
    expect(isThin(kg)).toBe(false);
    expect(isThin({ marks: kg.marks.slice(0, 2), lines: [] })).toBe(true);
  });
});

describe("withoutIndexLines", () => {
  it("leaves out the lines of the index page, which links to every page, unless it is the focus", () => {
    const index = wiki.marks.find((mark) => mark.type === "index")!;
    const touching = wiki.lines.filter((line) => line.from === index.id || line.to === index.id).length;
    expect(touching).toBeGreaterThan(5);
    const drawn = withoutIndexLines(wiki.lines, wiki.marks, null);
    expect(drawn).toHaveLength(wiki.lines.length - touching);
    expect(withoutIndexLines(wiki.lines, wiki.marks, index.id)).toHaveLength(wiki.lines.length);
    expect(withoutIndexLines(kg.lines, kg.marks, null)).toHaveLength(kg.lines.length);
  });
});
