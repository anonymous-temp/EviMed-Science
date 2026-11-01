/**
 * The main document of a run that was stopped before it could hand anything over.
 *
 * Hidden knowledge: a run cancelled at its cap (DeepResearch Bench task 65, 2026-10-28) had written a 52 KB `report.md` and
 * the Word file built from it four minutes earlier, and its record said `presentedFiles: []` with a mid-run sentence as the
 * last text. The files were in `outputFiles` among the figures, the build scripts and the five `parts/p*.md` the report was
 * assembled from, so a reader of the record — a person, the inbox, a benchmark harness — had nothing to tell the report from
 * the scratch. A run that is stopped keeps what it wrote (principle 19); this names which of it is the document.
 *
 * Chosen by a closed rule over what the run wrote, never by reading a file or its name as language (principle 1):
 *   1. Eligible: a visible file outside the scratch, dependency and platform directories (`ordinaryOutputPath`, the same list
 *      `runWorkspaceChanges.mjs` walks by), outside a directory that holds pieces of a document (`PART_DIRECTORIES`), whose
 *      extension is one of `MAIN_DOCUMENT_EXTENSIONS`, that is not the platform's backstage file (`artifactPresentation`
 *      role `work`: revision notes) and is not empty.
 *   2. Order: a file the reader's own classification calls a report (`artifactPresentation` role `report`) first, the platform's
 *      `delivery-summary.md` last, then the larger file, then the newer, then the path. A document and a workbook are not ranked
 *      against each other: the larger is the more likely to be the work.
 *   3. At most `MAIN_DOCUMENT_LIMIT` files: the first, and the first of the others in the same directory that is a document in
 *      another format family (`report.md` and the `.docx` built from it; their stems need not match). Two renditions of one
 *      report are one hand-over; two unrelated files are not.
 *
 * Pure: the caller reads the sizes and times, so the rule is testable on fixtures.
 *
 * @module terminalPresentation
 */

import { artifactPresentation } from "@evimed/domain";
import { ordinaryOutputPath } from "./runArtifacts.mjs";

/** The formats a person opens as a document. Lower case, no dot. */
export const MAIN_DOCUMENT_EXTENSIONS = Object.freeze(new Set(["docx", "pdf", "pptx", "xlsx", "md", "html", "htm"]));

/**
 * Directories that hold pieces of a document or its earlier drafts, compared in lower case by whole name. Joins
 * `SCRATCH_DIRECTORIES` (`runArtifacts.mjs`), which does not name them because an ordinary conversation's `parts/` can be a
 * folder the person asked for; here the question is only which file to put first, so a piece is passed over.
 */
export const PART_DIRECTORIES = Object.freeze(new Set(["parts", "part", "chunks", "sections", "fragments", "partials", "snippets", "drafts", "draft"]));

/** How many files one stopped run hands over. */
export const MAIN_DOCUMENT_LIMIT = 2;

/**
 * @typedef {object} CandidateFile
 * @property {string} path workspace-relative, forward slashes
 * @property {number} size bytes
 * @property {number} mtimeMs last write, epoch milliseconds
 */

/** @param {string} value */
function extensionOf(value) {
  const name = value.slice(value.lastIndexOf("/") + 1).toLowerCase();
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
}

/** @param {string} value */
function directoryOf(value) {
  const at = value.lastIndexOf("/");
  return at < 0 ? "" : value.slice(0, at);
}

/** The two Markdown spellings are one format, as are the two HTML ones. @param {string} extension */
function familyOf(extension) {
  return extension === "htm" ? "html" : extension;
}

/**
 * @param {CandidateFile} file
 * @returns {{ file: CandidateFile, lead: number, role: string, family: string } | null}
 */
function describe(file) {
  const path = String(file?.path ?? "");
  if (!path || !ordinaryOutputPath(path)) return null;
  const extension = extensionOf(path);
  if (!MAIN_DOCUMENT_EXTENSIONS.has(extension)) return null;
  const directories = path.split("/").slice(0, -1);
  if (directories.some((name) => PART_DIRECTORIES.has(name.toLowerCase()))) return null;
  if (!(Number(file.size) > 0)) return null;
  const { role, rank } = artifactPresentation(path);
  if (role === "work") return null;
  // `rank` 0 is a report; 5 is the platform's own `delivery-summary.md`, which names what was delivered and is not it.
  return { file, lead: rank === 0 ? 0 : rank >= 5 ? 2 : 1, role, family: familyOf(extension) };
}

/**
 * The files a stopped run hands over as its main document, from what it wrote.
 * @param {readonly CandidateFile[]} files the run's own files with their size and last write
 * @returns {string[]} at most `MAIN_DOCUMENT_LIMIT` workspace-relative paths, best first
 */
export function pickMainDocuments(files) {
  const ranked = (Array.isArray(files) ? files : [])
    .map(describe)
    .filter((entry) => entry !== null)
    .sort((left, right) => left.lead - right.lead
      || right.file.size - left.file.size
      || right.file.mtimeMs - left.file.mtimeMs
      || left.file.path.localeCompare(right.file.path, "en"));
  const [first, ...rest] = ranked;
  if (!first) return [];
  const folder = directoryOf(first.file.path);
  const rendition = rest.find((entry) => directoryOf(entry.file.path) === folder
    && entry.family !== first.family && (entry.role === "report" || entry.role === "document"));
  return [first, ...(rendition ? [rendition] : [])].slice(0, MAIN_DOCUMENT_LIMIT).map((entry) => entry.file.path);
}
