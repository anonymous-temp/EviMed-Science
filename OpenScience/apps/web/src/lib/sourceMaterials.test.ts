import { describe, expect, it } from "vitest";
import { coverageGap, materialEntries, pageRanges, type SourceMaterialsLedger, type SourceMaterialsStructure } from "./sourceMaterials";

const ledger = (overrides: Partial<SourceMaterialsLedger> = {}): SourceMaterialsLedger => ({
  version: 1, status: "extracted", format: "pdf", pagination: "paginated", origin: "reported", extraction: { materials: "m@1" },
  sourceSha256: null, textSha256: null, pages: { status: "mapped", pageCount: 38, textLayerPages: 38 },
  tables: { total: 0, structured: 0, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 },
  values: { total: 0, located: 0, ambiguous: 0, unlocated: 0, unextracted: 0, failed: 0 },
  figures: { total: 0, captioned: 0, valuesKnown: 0 }, footnotes: { linked: 0, orphanMarkers: 0, orphanNotes: 0 },
  supplements: { referenced: 0, linked: 0 }, reasons: [], ...overrides,
});

describe("page ranges", () => {
  it("run consecutive pages together, in order, once each", () => {
    expect(pageRanges([31, 32, 33, 34])).toBe("31—34");
    expect(pageRanges([40, 31, 32, 34, 33, 31])).toBe("31—34、40");
    expect(pageRanges([2, 4, 6])).toBe("2、4、6");
    expect(pageRanges([7])).toBe("7");
    expect(pageRanges([])).toBe("");
    expect(pageRanges([0, -1, 2.5, 3])).toBe("3");
  });
});

describe("what was not read", () => {
  it("is nothing where nothing was missed", () => {
    expect(coverageGap(null)).toBeNull();
    expect(coverageGap(undefined)).toBeNull();
    expect(coverageGap({ failed: 0 })).toBeNull();
    expect(coverageGap({ failed: 0, materials: ledger({ tables: { total: 4, structured: 4, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 } }) })).toBeNull();
  });

  it("says nothing either way for a document read before the extraction existed, or one it was not attempted on", () => {
    expect(coverageGap({ failed: 0, materials: undefined })).toBeNull();
    expect(coverageGap({ failed: 0, materials: ledger({ status: "unavailable", unavailable: "not_a_document_format", pages: { status: "not_paginated" } }) })).toBeNull();
  });

  it("is one sentence, in the order: text, pages, tables, figures", () => {
    expect(coverageGap({ failed: 2, materials: ledger({
      pages: { status: "mapped", pageCount: 40, textLayerPages: 30, noTextLayerPages: [31, 32, 33, 34, 40] },
      tables: { total: 5, structured: 2, unextracted: 2, failed: 1, continued: 0, continuedAmbiguous: 0 },
      figures: { total: 6, captioned: 4, valuesKnown: 0 },
    }) })).toBe("没有读全：2 段文字没能读取，第 31—34、40 页没有文字层，3 张表格没有读成数据，6 张图的内容没有读取。");
  });

  it("names a document none of whose pages has a text layer, and a derivation that failed", () => {
    expect(coverageGap({ materials: ledger({ pages: { status: "no_text_layer", pageCount: 12, textLayerPages: 0, noTextLayerPages: [1, 2, 3] } }) })).toBe("没有读全：所有页面都没有文字层。");
    expect(coverageGap({ materials: ledger({ status: "failed", failure: "derivation_failed", pages: { status: "failed", reason: "derivation_failed" } }) })).toBe("没有读全：表格和图没能逐项读取。");
  });

  it("states the figures alone when that is all", () => {
    expect(coverageGap({ materials: ledger({ figures: { total: 1, captioned: 0, valuesKnown: 0 } }) })).toBe("没有读全：1 张图的内容没有读取。");
  });

  it("never says a page was not read for a reason the ledger does not give: page numbers unavailable is not a page gap", () => {
    expect(coverageGap({ materials: ledger({ pages: { status: "unavailable", reason: "locator_unavailable" } }) })).toBeNull();
    expect(coverageGap({ materials: ledger({ pages: { status: "failed", reason: "locator_failed" } }) })).toBeNull();
  });
});

describe("tables and figures", () => {
  const structure: SourceMaterialsStructure = {
    tables: [
      { id: "tbl-1", index: 1, kind: "table", status: "structured", caption: { label: "表 3", text: "表 3 推荐等级汇总" }, page: { status: "located", pages: [9] } },
      { id: "tbl-2", index: 2, kind: "table", status: "unextracted", reason: "headerless_rows", page: { status: "unknown", reason: "not_requested" } },
      { id: "sheet-1", index: 3, kind: "sheet", name: "基线", status: "structured", page: { status: "ambiguous", candidates: [4, 5] } },
    ],
    figures: [
      { kind: "figure", index: 1, id: "fig-1", label: "图 1", caption: { text: "图 1 治疗流程" }, page: { status: "located", pages: [4] } },
      { kind: "figure", index: 2, id: "fig-2", image: { alt: "", ref: "x.png" } },
    ],
  };

  it("are listed by the page they are on, the ones with no page after, and name themselves by caption, label, sheet or number", () => {
    expect(materialEntries(structure).map((entry) => [entry.label, entry.pages])).toEqual([
      ["图 1 治疗流程", [4]],
      ["表 3 推荐等级汇总", [9]],
      ["表格 2", []],
      ["基线", []],
      ["图 2", []],
    ]);
  });

  it("never offer an ambiguous placement as a page", () => {
    expect(materialEntries(structure).find((entry) => entry.label === "基线")?.pages).toEqual([]);
  });

  it("keep a long caption to a line", () => {
    const long = "表 1 " + "很长的标题".repeat(40);
    const [entry] = materialEntries({ tables: [{ id: "tbl-1", index: 1, kind: "table", status: "structured", caption: { text: long } }], figures: [] });
    expect(entry.label.length).toBe(80);
    expect(entry.label.endsWith("…")).toBe(true);
  });

  it("are nothing for a document with no structure", () => {
    expect(materialEntries(null)).toEqual([]);
    expect(materialEntries(undefined)).toEqual([]);
    expect(materialEntries({ tables: [], figures: [] })).toEqual([]);
  });
});
