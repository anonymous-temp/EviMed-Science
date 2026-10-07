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
  pagination: "paginated" | "sheet" | "delimited" | "image" | "flow" | "unaddressed";
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
