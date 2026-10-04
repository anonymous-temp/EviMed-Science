import { describe, expect, it } from "vitest";
import { sourceMaterialsText, type SourceMaterialsLedger } from "./sourceMaterials";

const ledger = (overrides: Partial<SourceMaterialsLedger> = {}): SourceMaterialsLedger => ({
  version: 1, status: "extracted", format: "pdf", pagination: "paginated", origin: "reported",
  extraction: { materials: "evimed-materials@1", parser: "evimed-extract@0.5.0" }, sourceSha256: "a".repeat(64), textSha256: "b".repeat(64),
  pages: { status: "mapped", pageCount: 12 },
  tables: { total: 3, structured: 3, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 },
  values: { total: 40, located: 31, ambiguous: 2, unlocated: 5, unextracted: 2, failed: 0 },
  figures: { total: 1, captioned: 1, valuesKnown: 0 }, footnotes: { linked: 1, orphanMarkers: 0, orphanNotes: 0 }, supplements: { referenced: 0, linked: 0 },
  reasons: [], ...overrides,
});

describe("what a researcher is told about a document's tables and numbers", () => {
  it("says how many were found and where each stands, naming only the states that are not empty", () => {
    expect(sourceMaterialsText(ledger())).toBe("表格与数值：3 张表、40 个数值，已定位 31，页码待定 2，页码未知 5，未能提取 2。");
    expect(sourceMaterialsText(ledger({ values: { total: 8, located: 8, ambiguous: 0, unlocated: 0, unextracted: 0, failed: 0 } }))).toBe("表格与数值：3 张表、8 个数值，已定位 8。");
  });

  it("says a scan's numbers are OCR readings of unknown accuracy", () => {
    expect(sourceMaterialsText(ledger({ origin: "ocr", uncertainty: "unknown", values: { total: 4, located: 0, ambiguous: 0, unlocated: 4, unextracted: 0, failed: 0 } })))
      .toBe("表格与数值：3 张表、4 个数值，已定位 0，页码未知 4。来自扫描件，数值是文字识别的结果，准确度未知。");
  });

  it("says a failed extraction did not cost the document anything, and says nothing for a ledger with nothing in it or none at all", () => {
    expect(sourceMaterialsText(ledger({ status: "failed" }))).toBe("表格与数值：这份资料的表格结构没有提取成功，原文与理解不受影响。");
    expect(sourceMaterialsText(ledger({ status: "unavailable", unavailable: "not_a_document_format" }))).toBeNull();
    expect(sourceMaterialsText(ledger({ tables: { total: 0, structured: 0, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 }, values: { total: 0, located: 0, ambiguous: 0, unlocated: 0, unextracted: 0, failed: 0 } }))).toBeNull();
    expect(sourceMaterialsText(undefined)).toBeNull();
    expect(sourceMaterialsText(null)).toBeNull();
  });
});
