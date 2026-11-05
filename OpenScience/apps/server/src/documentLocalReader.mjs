import { runIntakeAttempt } from "./vcrIntakeStage.mjs";

/**
 * The local reading of a PDF, a Word file, slides or a workbook, for when the
 * parsing service cannot give one (`documentParserClient.mjs` decides when).
 *
 * It is not a second parser with its own opinions. The original bytes are staged
 * as one copy and read in the runtime controller's disposable intake container —
 * no network, a read-only root, bounded memory and time, no model, no workspace —
 * by the same operation that locates a parsed table on its page
 * (`materials`, `source_material_extract.py`), and what comes back is plain text:
 *
 * - a PDF's text layer page by page, written as the service writes it
 *   (`[Page N]` lines), so the page map and every quotation's page work the same;
 *   a page with no text layer stays a page with no text;
 * - a Word file's paragraphs and table rows, with no page markers (the file has
 *   no page source);
 * - slides under `[Slide N]` lines, and a workbook's sheets under `[Sheet: name]`
 *   lines with a tab between cells, as the service writes them.
 *
 * Hidden knowledge:
 *
 * - **No text is no text.** A scanned PDF has no text layer; the container does no
 *   OCR. When no page has any text this answers an empty string, not the page
 *   markers: the ingestion then keeps the file as an original with no text
 *   (`source_original_no_text`) instead of storing a document that is only
 *   `[Page 1] [Page 2]`.
 * - **A deployment without a controller, or with an image that predates this
 *   format, cannot read.** The container answers `refused` and this throws
 *   `document_local_read_unavailable` / `document_local_read_refused`; the caller
 *   then reports the parsing service's own failure, which is the one an operator
 *   can act on.
 * - **A legacy `.doc`, `.ppt` or `.xls` is not read here.** They are not zip
 *   packages; nothing in the image opens them safely, and a guess is worse than
 *   the service's honest failure.
 */

const MAX_PAGES = 1000;
const MAX_CHARS = 16 * 1024 * 1024;
const RESULT_LIMIT = 16 * 1024 * 1024;
const TEXT_LIMIT = 24 * 1024 * 1024;
/** Cells listed per sheet: far above the 1,000 the table structure needs, bounded by the result file's size. */
const MAX_CELLS_PER_SHEET = 200_000;

/** @param {string} message @param {string} code */
function readError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** "AB12" -> { col: 28, row: 12 } @param {string} address */
function cellPosition(address) {
  const found = /^([A-Z]+)(\d+)$/.exec(address);
  if (!found) return null;
  let col = 0;
  for (const letter of found[1]) col = col * 26 + (letter.charCodeAt(0) - 64);
  return { col, row: Number(found[2]) };
}

/** A cell's value as the service writes it: text as it is, a number or a boolean plainly, a formula nobody computed as nothing.
 * @param {{ k?: string, v?: unknown }} cell */
function cellText(cell) {
  if (cell.v === null || cell.v === undefined) return "";
  return String(cell.v).replace(/[\t\r\n]+/g, " ");
}

/** Sheets as `[Sheet: name]` blocks of tab-separated rows. @param {any[]} sheets */
export function sheetsToText(sheets) {
  const blocks = [];
  for (const sheet of sheets) {
    const rows = new Map();
    for (const cell of sheet.cells ?? []) {
      const position = cellPosition(String(cell.a ?? ""));
      if (!position) continue;
      const row = rows.get(position.row) ?? new Map();
      row.set(position.col, cellText(cell));
      rows.set(position.row, row);
    }
    const lines = [...rows.keys()].sort((a, b) => a - b).map((rowNumber) => {
      const row = rows.get(rowNumber);
      const width = Math.max(...row.keys());
      return Array.from({ length: width }, (_, index) => row.get(index + 1) ?? "").join("\t").replace(/\t+$/, "");
    });
    blocks.push(`[Sheet: ${String(sheet.name ?? "").replace(/[\r\n]+/g, " ")}]\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/**
 * @param {{ config: any, controller?: { runVcrIntake?: Function } | null, report?: (code: string) => void }} dependencies
 */
export function createLocalDocumentReader({ config, controller = null, report = () => {} }) {
  const available = () => typeof controller?.runVcrIntake === "function";

  /** The container's answer, or a named failure. @param {{ bytes: Buffer|Uint8Array, name: string, sha256: string, form: string, limits: Record<string, number>, signal?: AbortSignal }} input */
  async function measure({ bytes, name, sha256, form, limits, signal }) {
    if (!available()) throw readError("document_local_read_unavailable", "No intake controller is available.");
    try {
      return await runIntakeAttempt({
        config, controller: /** @type {any} */ (controller), kind: "materials", name, source: { bytes: Buffer.from(bytes) },
        request: { format: form, limits }, signal, expectSha256: sha256,
      }, async (attempt) => {
        const raw = await attempt.read("result.json", RESULT_LIMIT);
        /** @type {any} */
        let result = null;
        try { result = raw ? JSON.parse(raw.toString("utf8")) : null; } catch { result = null; }
        if (!result || typeof result !== "object" || result.protocol !== 1) throw readError("document_local_read_invalid", "The intake result is not usable.");
        if (result.outcome === "refused") throw readError("document_local_read_refused", `The intake container refused the document: ${String(result.reason ?? "unknown").slice(0, 40)}.`);
        if (result.outcome === "text" || result.outcome === "pages") {
          const file = result.outcome === "pages" ? "pages.json" : "text.txt";
          const body = await attempt.read(file, TEXT_LIMIT);
          if (!body) throw readError("document_local_read_invalid", "The intake result is not usable.");
          return { result, body };
        }
        return { result, body: null };
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = /** @type {any} */ (error)?.code;
      if (typeof code === "string" && code.startsWith("document_local_read_")) throw error;
      try { report(typeof code === "string" ? code : "document_local_read_failed"); } catch { /* a report never fails a read */ }
      throw readError("document_local_read_unavailable", "The intake container could not read the document.");
    }
  }

  /**
   * @param {{ bytes: Buffer|Uint8Array, name: string, sha256: string, format: string, signal?: AbortSignal }} input
   * @returns {Promise<{ text: string, pageMap?: { page: number, start: number, end: number, status: string }[], version: string, partial?: { read: number, of: number } }>}
   */
  async function read({ bytes, name, sha256, format, signal }) {
    if (format === "pdf") {
      const { result, body } = await measure({ bytes, name: "document.pdf", sha256, form: "pdf", limits: { maxPages: MAX_PAGES, maxChars: MAX_CHARS }, signal });
      /** @type {any} */
      let pages = null;
      try { pages = JSON.parse(/** @type {Buffer} */ (body).toString("utf8")); } catch { pages = null; }
      if (result.outcome !== "pages" || !Array.isArray(pages) || pages.some((/** @type {unknown} */ page) => typeof page !== "string")) {
        throw readError("document_local_read_invalid", "The intake result is not usable.");
      }
      const version = String(result.extractor?.version ?? "1.1.0");
      const partial = result.truncated || result.pagesRead < result.pages ? { read: pages.length, of: Number(result.pages) } : undefined;
      // A scan: no page has a text layer. Nothing is not the page markers around nothing.
      if (!pages.some((/** @type {string} */ page) => page.trim())) return { text: "", version, ...(partial ? { partial } : {}) };
      let text = "";
      /** @type {{ page: number, start: number, end: number, status: string }[]} */
      const pageMap = [];
      pages.forEach((/** @type {string} */ page, index) => {
        if (index) text += "\n\n";
        text += `[Page ${index + 1}]\n`;
        const start = text.length;
        text += page;
        pageMap.push({ page: index + 1, start, end: text.length, status: page.trim() ? "ok" : "empty" });
      });
      return { text, pageMap, version, ...(partial ? { partial } : {}) };
    }
    if (format === "docx" || format === "pptx") {
      const { result, body } = await measure({ bytes, name: `document.${format}`, sha256, form: format, limits: { maxPages: MAX_PAGES, maxChars: MAX_CHARS }, signal });
      if (result.outcome !== "text") throw readError("document_local_read_invalid", "The intake result is not usable.");
      return { text: /** @type {Buffer} */ (body).toString("utf8"), version: String(result.extractor?.version ?? "1.1.0") };
    }
    if (format === "xlsx" || format === "xlsm") {
      const { result } = await measure({ bytes, name: `workbook.${format}`, sha256, form: format,
        limits: { maxSheets: 40, maxCellsPerSheet: MAX_CELLS_PER_SHEET }, signal });
      if (result.outcome !== "cells" || !Array.isArray(result.sheets)) throw readError("document_local_read_invalid", "The intake result is not usable.");
      const text = sheetsToText(result.sheets);
      return { text: text.replace(/\[Sheet: [^\n]*\]\n?(?=\n\n|$)/g, "").trim() ? text : "", version: String(result.extractor?.version ?? "1.1.0") };
    }
    throw readError("document_local_read_unsupported", `${name} is not a format the intake container reads.`);
  }

  return { read, get available() { return available(); } };
}
