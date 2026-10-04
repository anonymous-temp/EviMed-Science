/**
 * The ledger of a source's structured materials — its tables, spreadsheet cells
 * and the values in them, and what was located, ambiguous, unlocated,
 * unextracted or failed (`sourceMaterialsCoverage` in @evimed/domain). Stored on
 * the source row as `coverage.materials`; absent for a document read before the
 * extraction existed, which is "not extracted" and never zero.
 */
export interface SourceMaterialsLedger {
  version: number;
  status: "extracted" | "partial" | "unavailable" | "failed";
  failure?: string;
  unavailable?: string;
  format: string;
  pagination: "paginated" | "sheet" | "delimited" | "image" | "flow";
  origin: "reported" | "ocr";
  uncertainty?: "unknown";
  extraction: { materials: string; parser?: string; locator?: string };
  sourceSha256: string | null;
  textSha256: string | null;
  pages: { status: "mapped" | "no_text_layer" | "unavailable" | "not_paginated" | "failed"; pageCount?: number; textLayerPages?: number; noTextLayerPages?: number[]; reason?: string };
  tables: { total: number; structured: number; unextracted: number; failed: number; continued: number; continuedAmbiguous: number };
  values: { total: number; located: number; ambiguous: number; unlocated: number; unextracted: number; failed: number };
  figures: { total: number; captioned: number; valuesKnown: number };
  footnotes: { linked: number; orphanMarkers: number; orphanNotes: number };
  supplements: { referenced: number; linked: number };
  reasons: string[];
}

/**
 * What a researcher is told about a document's tables and numbers, in one
 * sentence: how many were found and where each stands. Nothing when there is
 * nothing to say — no tables, a format with none, a document read before the
 * extraction — because a ledger of zeros on every prose paper would be noise.
 */
export function sourceMaterialsText(ledger: SourceMaterialsLedger | null | undefined): string | null {
  if (!ledger) return null;
  if (ledger.status === "failed") return "表格与数值：这份资料的表格结构没有提取成功，原文与理解不受影响。";
  if (ledger.status === "unavailable") return null;
  const { values, tables } = ledger;
  if (tables.total === 0 && values.total === 0) return null;
  const stands = [
    `已定位 ${values.located}`,
    values.ambiguous > 0 ? `页码待定 ${values.ambiguous}` : null,
    values.unlocated > 0 ? `页码未知 ${values.unlocated}` : null,
    values.unextracted + values.failed > 0 ? `未能提取 ${values.unextracted + values.failed}` : null,
  ].filter((part): part is string => part !== null);
  const scanned = ledger.origin === "ocr" ? "来自扫描件，数值是文字识别的结果，准确度未知。" : "";
  return `表格与数值：${tables.structured} 张表、${values.total} 个数值，${stands.join("，")}。${scanned}`;
}
