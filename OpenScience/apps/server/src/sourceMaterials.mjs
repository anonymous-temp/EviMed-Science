import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import {
  SOURCE_MATERIAL_LIMITS,
  deriveDelimitedStructure,
  deriveMarkdownStructure,
  deriveSheetStructure,
  locateUnitsOnPages,
  materialCaptureText,
  materialTableCounts,
  sourceFileFormat,
  sourceMaterialsCoverage,
  sourceMaterialsCoverageIssues,
  sourceMaterialsPagination,
} from "@evimed/domain";
import { runIntakeAttempt } from "./vcrIntakeStage.mjs";

/**
 * The structured materials of one parsed source: its tables, figures and
 * spreadsheet cells with their addresses, the page each is on, and the ledger of
 * what was located, ambiguous, unlocated, unextracted or failed
 * (`packages/domain/src/sourceMaterials.mjs` and `sourceMaterialsLocate.mjs` own
 * the rules; this file owns the two things that need the host).
 *
 * Hidden knowledge:
 *
 * - **It extends the parse, it never gates it.** Everything here runs after the
 *   parser has answered and before the capture is frozen, inside the same
 *   ingestion lease, and every failure of it is a ledger entry (`status:
 *   "failed"`, a reason) and not an error: a document whose tables could not be
 *   structured is still ingested, searchable and understood (plan §11.6: a parser
 *   dependency can limit supported material; it must not manufacture a region or
 *   stop other usable work). The one thing that does propagate is the caller's
 *   own cancellation, because a canceled ingestion must stop.
 * - **The page comes from the original bytes, in the runtime controller's
 *   disposable intake container** (`vcrIntakeController.mjs`, operation
 *   `materials`, controller protocol 10): one staged copy of the PDF, no network,
 *   a read-only root, bounded memory and time. The container only measures — the
 *   text of every page — and the matching of a table's rows to pages is the
 *   domain's (`locateUnitsOnPages`), testable without a container. A deployment
 *   without a controller answers `locator_unavailable`: every value in a PDF is
 *   then unlocated, with its table and cell still known.
 * - **A spreadsheet is read in the container too** (openpyxl, in the runtime
 *   image), not in this process: an untrusted zip of XML has no business in the
 *   control plane. If that read is unavailable the parser's own Markdown for the
 *   workbook is structured instead, with no sheet addresses and the reason said.
 * - **Nothing is invented for what the parser does not send.** The page of a
 *   Word file, the region of anything, the axes of a figure stay unknown, and
 *   the ledger says so (`reasons`).
 */

/** The most pages the container reads from one PDF, and the most characters it returns. */
export const SOURCE_MATERIALS_PDF_MAX_PAGES = 1000;
export const SOURCE_MATERIALS_MAX_TEXT_CHARS = 16 * 1024 * 1024;
const RESULT_LIMIT = 16 * 1024 * 1024;
const PAGES_LIMIT = 24 * 1024 * 1024;
/** A table record stays under the product ledger's 256 KiB with room for its identity. */
const TABLE_RECORD_LIMIT = 230_000;
const SUMMARY_RECORD_LIMIT = 230_000;
/** Formats the knowledge base reads as text that are not documents: they have no tables to structure. */
const NOT_DOCUMENTS = new Set(["json", "yaml", "yml", "xml", "r", "py", "sql"]);

/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** @param {unknown} value */
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));

/** The record ids of one source generation's structure, in one place. @param {string} sourceId @param {number} generation */
export const materialsRecordIds = (sourceId, generation) => ({
  summary: `structure:${sourceId}:g${generation}`,
  /** @param {string} tableId */
  table: (tableId) => `table:${sourceId}:g${generation}:${tableId}`,
});

/**
 * One table inside a product record: past the bound its last cells are dropped
 * and counted as unextracted, so the record is storable and the ledger still
 * says what is missing from it.
 * @param {Record<string, any>} table
 */
function fitTable(table) {
  if (table.status !== "structured" || bytesOf(table) <= TABLE_RECORD_LIMIT) return table;
  const original = table.cells.length;
  const cells = [...table.cells];
  let lostValues = 0;
  while (cells.length > 1 && bytesOf({ ...table, cells }) > TABLE_RECORD_LIMIT) {
    const cut = Math.max(1, Math.floor(cells.length * 0.1));
    for (const cell of cells.splice(cells.length - cut, cut)) if (cell.v) lostValues += 1;
  }
  return { ...table, cells, unextracted: (table.unextracted ?? 0) + lostValues,
    truncated: { cells: cells.length, of: table.truncated?.of ?? original, reason: "record_size" } };
}

/** @param {Record<string, any>} table @param {string} pagination */
function summarizeTable(table, pagination) {
  return {
    id: table.id, index: table.index, kind: table.kind, ...(table.name ? { name: table.name } : {}),
    status: table.status, ...(table.reason ? { reason: table.reason } : {}),
    ...(table.start != null ? { start: table.start, end: table.end } : {}),
    ...(table.rows != null ? { rows: table.rows, columns: table.columns } : {}),
    ...(table.caption ? { caption: { label: table.caption.label, text: String(table.caption.text ?? "").slice(0, 200), placement: table.caption.placement } } : {}),
    ...(table.heading ? { heading: { level: table.heading.level, text: String(table.heading.text ?? "").slice(0, 200) } } : {}),
    ...(table.page ? { page: table.page } : {}),
    ...(table.continuation ? { continuation: table.continuation } : {}),
    ...(table.continuedBy ? { continuedBy: table.continuedBy } : {}),
    ...(Array.isArray(table.footnotes) ? { footnotes: table.footnotes.length } : {}),
    ...(table.sheetState && table.sheetState !== "visible" ? { sheetState: table.sheetState } : {}),
    ...(table.truncated ? { truncated: table.truncated } : {}),
    values: materialTableCounts(table, pagination),
  };
}

/**
 * The records of a structure: one summary and one record per table. Pure.
 * @param {{ structure: Record<string, any>, tables: Record<string, any>[] }} materials
 * @param {{ sourceId: string, generation: number }} identity
 * @returns {{ kind: string, id: string, payload: Record<string, any> }[]}
 */
export function materialsRecords(materials, { sourceId, generation }) {
  const ids = materialsRecordIds(sourceId, generation);
  const textSha256 = materials.structure.textSha256;
  return [
    { kind: "knowledge", id: ids.summary, payload: { recordType: "source-structure", sourceId, generation, ...materials.structure } },
    ...materials.tables.map((table) => ({ kind: "knowledge", id: ids.table(table.id),
      payload: { recordType: "source-table", sourceId, generation, textSha256, tableId: table.id, table } })),
  ];
}

/**
 * @param {{ config: any, controller?: { runVcrIntake?: Function } | null, report?: (code: string) => void, now?: () => Date }} dependencies
 */
export function createSourceMaterials({ config, controller = null, report = () => {}, now = () => new Date() }) {
  const enabled = () => config.sourceMaterialsEnabled !== false;
  const locatorAvailable = () => typeof controller?.runVcrIntake === "function";
  /** @param {string} code */
  const note = (code) => { try { report(code); } catch { /* a report never fails an ingestion */ } };

  /**
   * One measurement of the original bytes in the intake container.
   * @param {{ file: string, name: string, sourceSha256: string, format: string, limits: Record<string, number>, signal?: AbortSignal }} input
   * @returns {Promise<{ result: Record<string, any>, pages: string[] | null }>}
   */
  async function measure({ file, name, sourceSha256, format, limits, signal }) {
    return runIntakeAttempt({
      config, controller: /** @type {any} */ (controller), kind: "materials", name, source: { path: file },
      request: { format, limits }, signal, expectSha256: sourceSha256,
    }, async (attempt) => {
      const raw = await attempt.read("result.json", RESULT_LIMIT);
      /** @type {any} */
      let result = null;
      try { result = raw ? JSON.parse(raw.toString("utf8")) : null; } catch { result = null; }
      if (!result || typeof result !== "object" || result.protocol !== 1 || !["pages", "cells", "refused"].includes(result.outcome)) {
        throw new Error("materials_result_invalid");
      }
      if (result.outcome !== "pages") return { result, pages: null };
      const pagesRaw = await attempt.read("pages.json", PAGES_LIMIT);
      /** @type {any} */
      let pages = null;
      try { pages = pagesRaw ? JSON.parse(pagesRaw.toString("utf8")) : null; } catch { pages = null; }
      if (!Array.isArray(pages) || pages.some((entry) => typeof entry !== "string") || pages.length !== result.pagesRead
        || !Array.isArray(result.textLayer) || result.textLayer.length !== pages.length || !Number.isSafeInteger(result.pages) || result.pages < pages.length) {
        throw new Error("materials_result_invalid");
      }
      return { result, pages };
    });
  }

  /**
   * What a failed or refused container means for the ledger: a reason, never an error.
   * @param {unknown} error @param {AbortSignal | undefined} signal
   * @returns {string}
   */
  function failureReason(error, signal) {
    if (signal?.aborted) throw error;
    const code = /** @type {any} */ (error)?.code;
    if (typeof code === "string" && (code.startsWith("runtime_controller_") || code.startsWith("vcr_intake_"))) {
      note(code);
      return code === "vcr_intake_input_invalid" ? "locator_failed" : "locator_unavailable";
    }
    note("source_materials_measure_failed");
    return "locator_failed";
  }

  /** @param {string} refusal */
  const refusalReason = (refusal) => (["too_many_pages", "too_large", "memory"].includes(refusal) ? "source_too_large" : "locator_failed");

  /**
   * Structure a parsed source. Never throws, except for the caller's own cancellation.
   * @param {{ text: string, file?: string | null, name: string, sha256: string, parserRevision: string, signal?: AbortSignal }} input
   */
  async function extract({ text, file = null, name, sha256: sourceSha256, parserRevision, signal }) {
    const at = now().toISOString();
    const format = sourceFileFormat(name);
    const pagination = sourceMaterialsPagination(format);
    const capture = materialCaptureText(text);
    const textSha256 = sha256(capture);
    /** @type {{ materials?: string, parser?: string, locator?: string }} */
    const extraction = { parser: parserRevision };
    const identity = { format, pagination, sourceSha256, textSha256, extraction, now: at };
    /** None was attempted, and the ledger says why. @param {string} why @param {Record<string, any>} [pages] */
    const notAttempted = (why, pages = { status: "unavailable", reason: why }) => ({
      coverage: sourceMaterialsCoverage({ tables: [], pages, unavailable: why, ...identity }), structure: null, tables: [],
    });
    if (!enabled()) return notAttempted("materials_disabled");
    if (!capture.trim()) return notAttempted("no_text");
    if (NOT_DOCUMENTS.has(format)) return notAttempted("not_a_document_format", { status: "not_paginated" });
    try {
      /** @type {{ tables: Record<string, any>[], figures: Record<string, any>[], supplements: Record<string, any>[], limits: string[] }} */
      let derived;
      /** @type {Record<string, any>} */
      let pages = pagination === "paginated"
        ? { status: "unavailable", reason: format === "pdf" ? "not_requested" : "format_without_page_source" } : { status: "not_paginated" };
      /** @type {string[]} */
      const extraLimits = [];
      if (format === "csv" || format === "tsv") {
        derived = deriveDelimitedStructure({ text: capture, delimiter: format === "tsv" ? "\t" : "," });
      } else if (["xlsx", "xlsm"].includes(format) && file) {
        derived = { tables: [], figures: [], supplements: [], limits: [] };
        /** @type {string | null} */
        let reason = null;
        if (!locatorAvailable()) reason = "sheet_reader_unavailable";
        else {
          try {
            const { result } = await measure({ file, name: `workbook.${format}`, sourceSha256, format,
              limits: { maxSheets: SOURCE_MATERIAL_LIMITS.maxSheets, maxCellsPerSheet: SOURCE_MATERIAL_LIMITS.maxCellsPerTable }, signal });
            if (result.outcome === "cells") {
              const sheets = deriveSheetStructure({ sheets: result.sheets });
              derived = { ...derived, tables: sheets.tables, limits: sheets.limits };
              if (result.extractor?.version) extraction.locator = `${result.extractor.name}@${result.extractor.version}`;
              if (result.truncated) derived.limits.push("sheet_limit");
            } else reason = "sheet_reader_failed";
          } catch (error) {
            failureReason(error, signal);
            reason = "sheet_reader_failed";
          }
        }
        if (reason) {
          // The workbook's Markdown from the parser still holds its tables, without a sheet address.
          const fallback = deriveMarkdownStructure({ text: capture });
          derived = { ...fallback };
          extraLimits.push(reason);
          pages = { status: "unavailable", reason };
        }
      } else {
        derived = deriveMarkdownStructure({ text: capture });
      }

      let { tables, figures } = derived;
      if (format === "pdf" && file && (tables.some((table) => table.status === "structured") || figures.length)) {
        const size = (await fs.stat(file).catch(() => null))?.size ?? 0;
        if (!locatorAvailable()) pages = { status: "unavailable", reason: "locator_unavailable" };
        else if (size > Math.max(Number(config.vcrIntakeMaxBytes) || 0, 10 * 1024 * 1024)) pages = { status: "unavailable", reason: "source_too_large" };
        else {
          try {
            const { result, pages: texts } = await measure({ file, name: "document.pdf", sourceSha256, format: "pdf",
              limits: { maxPages: SOURCE_MATERIALS_PDF_MAX_PAGES, maxChars: SOURCE_MATERIALS_MAX_TEXT_CHARS }, signal });
            if (result.outcome === "pages" && texts) {
              if (result.extractor?.version) extraction.locator = `${result.extractor.name}@${result.extractor.version} (pypdf ${result.extractor.libraries?.pypdf ?? "unknown"})`;
              const located = locateUnitsOnPages({ tables, figures, pageCount: result.pages,
                pages: texts.map((pageText, index) => ({ page: index + 1, text: pageText, hasTextLayer: result.textLayer[index] === true })) });
              tables = located.tables;
              figures = located.figures;
              pages = { status: located.info.status, pageCount: located.info.pageCount, textLayerPages: located.info.textLayerPages,
                ...(located.info.noTextLayerPages.length ? { noTextLayerPages: located.info.noTextLayerPages.slice(0, 50) } : {}),
                ...(result.truncated || result.pagesRead < result.pages ? { reason: "source_too_large" } : {}),
                ...(located.info.budgetSpent ? { reason: "locator_budget" } : {}) };
            } else pages = { status: "unavailable", reason: refusalReason(String(result.reason ?? "")) };
          } catch (error) {
            pages = { status: "failed", reason: failureReason(error, signal) };
          }
        }
      }

      tables = tables.map(fitTable);
      const coverage = sourceMaterialsCoverage({
        tables, figures, supplements: derived.supplements, pages, limits: [...derived.limits, ...extraLimits], ...identity,
      });
      // A ledger that does not hold together is not stored as one: it is a failure, and says so.
      if (sourceMaterialsCoverageIssues(coverage).length) throw new Error("materials_coverage_invalid");
      const structure = {
        version: coverage.version, extraction: coverage.extraction, sourceSha256, textSha256, format, pagination, origin: coverage.origin,
        ...(coverage.origin === "ocr" ? { uncertainty: "unknown" } : {}), pages, limits: [...new Set([...derived.limits, ...extraLimits])],
        tables: tables.map((table) => summarizeTable(table, pagination)), figures: figures.slice(0, SOURCE_MATERIAL_LIMITS.maxFigures),
        supplements: derived.supplements, at,
      };
      if (bytesOf(structure) > SUMMARY_RECORD_LIMIT) {
        // The summary is a convenience over the table records: past its bound it keeps counts and drops the figure and supplement lists.
        structure.figures = structure.figures.slice(0, 50);
        structure.supplements = structure.supplements.slice(0, 50);
        structure.tables = structure.tables.map((table) => ({ ...table, caption: undefined, heading: undefined }));
      }
      return { coverage, structure, tables: tables.filter((table) => table.status === "structured") };
    } catch (error) {
      if (signal?.aborted) throw error;
      note("source_materials_failed");
      return {
        coverage: sourceMaterialsCoverage({ tables: [], pages: { status: "failed", reason: "derivation_failed" }, failure: "derivation_failed", ...identity }),
        structure: null, tables: [],
      };
    }
  }

  return { extract, get enabled() { return enabled(); }, get locatorAvailable() { return locatorAvailable(); } };
}
