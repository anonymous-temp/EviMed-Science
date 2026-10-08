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

/** Where the page job placed a table or a figure: `located` names the page(s); `ambiguous` only candidates, which are never shown as the page. */
export interface MaterialPagePlacement {
  status: "located" | "ambiguous" | "unknown";
  pages?: number[];
  candidates?: number[];
  basis?: string;
  reason?: string;
}

/** One table or sheet of the summary `GET /api/sources/:id/materials` returns: what it is called, its size, its page when one is known. */
export interface MaterialTableSummary {
  id: string;
  index: number;
  kind: "table" | "sheet";
  name?: string;
  status: string;
  reason?: string;
  rows?: number;
  columns?: number;
  caption?: { label?: string; text?: string; placement?: string };
  heading?: { level: number; text: string };
  page?: MaterialPagePlacement;
}

/** One figure the text names by a caption or an image reference. What it plots is never read, and the ledger says so. */
export interface MaterialFigureSummary {
  kind: "figure";
  index: number;
  id: string;
  label?: string;
  caption?: { text?: string | null };
  image?: { alt?: string; ref?: string };
  page?: MaterialPagePlacement;
}

/** The structure under the ledger: every table and figure of the current capture. Null where the ledger says none was derived. */
export interface SourceMaterialsStructure {
  tables: MaterialTableSummary[];
  figures: MaterialFigureSummary[];
}

/** `GET /api/sources/:id/materials`: `materials: null` with a reason is an answer (not extracted), never an empty ledger. */
export interface SourceMaterialsResult {
  sourceId: string;
  generation: number;
  materials: { coverage: SourceMaterialsLedger; structure: SourceMaterialsStructure | null } | null;
  reason?: string;
}

/** `[31, 32, 33, 34, 40]` as 「31—34、40」: runs of consecutive pages are one range. */
export function pageRanges(pages: readonly number[]): string {
  const sorted = [...new Set(pages.filter((page) => Number.isInteger(page) && page > 0))].sort((left, right) => left - right);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    parts.push(end > index ? `${sorted[index]}—${sorted[end]}` : String(sorted[index]));
    index = end + 1;
  }
  return parts.join("、");
}

/** What the parse recorded of how much of the document it read, as stored on the source (`payload.coverage`). */
export interface SourceReadCoverage {
  failed?: number;
  materials?: SourceMaterialsLedger;
}

/**
 * The one sentence a document's key points say about what was not read, or null when nothing was missed (E-9). It is
 * written only from what the ledgers state: the text units the parser failed on, the pages with no text layer, the
 * tables that did not become cells, and the figures — whose contents are never read. A document is never said to be
 * fully understood because its file exists: a ledger absent (a document read before the extraction existed) says
 * nothing about tables, pages or figures either way, and neither does one that was not attempted.
 */
export function coverageGap(coverage: SourceReadCoverage | null | undefined): string | null {
  if (!coverage) return null;
  const clauses: string[] = [];
  if (Number.isInteger(coverage.failed) && (coverage.failed ?? 0) > 0) clauses.push(`${coverage.failed} 段文字没能读取`);
  const ledger = coverage.materials;
  if (ledger) {
    const noText = ledger.pages?.noTextLayerPages ?? [];
    if (ledger.pages?.status === "no_text_layer") clauses.push("所有页面都没有文字层");
    else if (noText.length > 0) clauses.push(`第 ${pageRanges(noText)} 页没有文字层`);
    const tables = (ledger.tables?.unextracted ?? 0) + (ledger.tables?.failed ?? 0);
    if (tables > 0) clauses.push(`${tables} 张表格没有读成数据`);
    const figures = ledger.figures?.total ?? 0;
    if (figures > 0) clauses.push(`${figures} 张图的内容没有读取`);
    if (ledger.status === "failed") clauses.push("表格和图没能逐项读取");
  }
  return clauses.length > 0 ? `没有读全：${clauses.join("，")}。` : null;
}

/** One line of 「表格与图」: what it is called and the pages it is on, when the page job placed it on exactly those. */
export interface MaterialEntry {
  key: string;
  kind: "table" | "figure";
  label: string;
  pages: number[];
}

/** How long a caption is when it names an entry: a line, not the paragraph under a figure. */
const ENTRY_LABEL_CHARS = 80;

const located = (placement: MaterialPagePlacement | undefined): number[] => (
  placement?.status === "located" ? (placement.pages ?? []).filter((page) => Number.isInteger(page) && page > 0) : []
);
const clip = (text: string) => (text.length > ENTRY_LABEL_CHARS ? `${text.slice(0, ENTRY_LABEL_CHARS - 1)}…` : text);

/**
 * The tables and figures of a document in the order a reader meets them: by the page they are on, the ones with no
 * known page after, tables before figures within a page. A page appears only when the page job placed the entry
 * there (`located`); an ambiguous placement is not offered as a page.
 */
export function materialEntries(structure: SourceMaterialsStructure | null | undefined): MaterialEntry[] {
  if (!structure) return [];
  const tables: MaterialEntry[] = (structure.tables ?? []).map((table) => ({
    key: `table:${table.id}`, kind: "table", pages: located(table.page),
    label: clip((table.caption?.text ?? "").trim() || (table.caption?.label ?? "").trim() || (table.name ?? "").trim() || `表格 ${table.index}`),
  }));
  const figures: MaterialEntry[] = (structure.figures ?? []).map((figure) => ({
    key: `figure:${figure.id}`, kind: "figure", pages: located(figure.page),
    label: clip((figure.caption?.text ?? "").trim() || (figure.label ?? "").trim() || `图 ${figure.index}`),
  }));
  const first = (entry: MaterialEntry) => entry.pages[0] ?? Number.POSITIVE_INFINITY;
  return [...tables, ...figures]
    .map((entry, order) => ({ entry, order }))
    .sort((left, right) => first(left.entry) - first(right.entry) || left.order - right.order)
    .map(({ entry }) => entry);
}
