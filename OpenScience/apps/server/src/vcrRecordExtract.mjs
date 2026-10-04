import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { HttpError } from './security.mjs';
import { VCR_INTAKE_LIMITS } from './vcrIntakeLayout.mjs';
import { runPlaneExtraction } from './vcrIntakeStage.mjs';

/**
 * A patient record as PDF or Word, turned into the text the matching step reads.
 *
 * The conversion runs inside this deployment, in the intake container
 * (`vcrIntakeController.mjs`: no network, no model, no workspace, and of the data
 * plane nothing but one read-only file and one empty directory of its own
 * scratch area). It is NOT sent to the external document-parsing service, by
 * design and by test: a hospital record must not leave the deployment to be read,
 * and nothing here — or in the data plane that calls it — imports
 * `documentParserClient.mjs` (`test/vcrRecordExtract.test.mjs` walks the import
 * graph to prove it).
 *
 * Hidden knowledge:
 *
 * - **The record is staged in the plane and nowhere else.** `extract` is handed
 *   the plane's root and the study, copies the raw upload into the study's
 *   scratch area (`vcrIntakeStage.mjs`), and removes the copy when the answer is
 *   read; no byte of the record is written under the data volume, which engines,
 *   backups and project runtimes all reach.
 * - **The container measures; this module decides.** The script reports the
 *   page count and the characters each page yielded; "scanned" is decided here,
 *   by code, as extracted characters per page under `vcrIntakeMinCharsPerPage`.
 *   A document that fails that is refused with `vcr_document_needs_text`, whose
 *   sentence tells the reader to supply a text version. A text PDF with a few
 *   scanned pages in it passes — most of it is text — and the blank pages are
 *   recorded in the provenance so a reader can see what was not read.
 * - **The text is the contract; the original is provenance.** What this returns
 *   is what the plane stores and the matching step reads, exactly as for a
 *   `.txt` upload. The original's hash, format and page count, and the
 *   extractor's identity and library versions, ride beside it.
 * - **Every number here is re-derived.** The result file comes from a container
 *   of our own image, and it is still checked: the text must hash to what the
 *   result says, the page count must be a count, and the characters are
 *   recounted from the text before any threshold is applied.
 */

/** The ceiling of the extracted text, the same one a `.txt` upload has (the container is told it too). */
export const VCR_DOCUMENT_TEXT_CAP = VCR_INTAKE_LIMITS.maxChars;
/** A Word file carries no page count a reader can rely on; no text at all is what it can fail on. */
const DOCX_MIN_CHARS = 20;
/** A page with fewer characters than this is blank for the record of which pages were. */
const BLANK_PAGE_CHARS = 10;
const BLANK_PAGES_LISTED = 50;
const RESULT_LIMIT = 256 * 1024;
const HEAD_BYTES = 1024;
const FORMATS = Object.freeze({ pdf: 'pdf', docx: 'docx' });

/** The extensions this module converts, and the stored format each is. */
export const VCR_RECORD_FORMATS = FORMATS;

/** What the counters count, in the order the metrics list them. */
export const VCR_INTAKE_COUNTER_KEYS = Object.freeze([
  'extracted', 'needsText', 'unreadable', 'tooLong', 'tooLarge', 'timedOut', 'failed', 'unavailable',
  'digitized', 'digitizeRefused', 'digitizeFailed',
]);

/** @returns {Record<string, number>} */
export function createIntakeCounters() {
  return Object.fromEntries(VCR_INTAKE_COUNTER_KEYS.map(key => [key, 0]));
}

/** @param {string} text */
const significantChars = text => Array.from(text.replace(/\s+/gu, '')).length;

/**
 * What a finished container's answer means. Pure: the container's files in, a
 * verdict out, so the rule is testable without a container.
 * @param {{ format: string, result: any, text: Buffer | null,
 *   limits: { maxPages: number, minCharsPerPage: number, textCap?: number } }} input
 * @returns {{ ok: true, text: string, extraction: Record<string, any> } | { ok: false, refusal: 'needs_text' | 'unreadable' | 'too_long' | 'too_large' | 'timeout' | 'failed' | 'unavailable' | 'changed' }}
 */
export function decideExtraction({ format, result, text, limits }) {
  const cap = limits.textCap ?? VCR_DOCUMENT_TEXT_CAP;
  if (!result || typeof result !== 'object' || result.protocol !== 1 || typeof result.outcome !== 'string') return { ok: false, refusal: 'failed' };
  if (result.outcome === 'refused') {
    switch (result.reason) {
      case 'too_many_pages': return { ok: false, refusal: 'too_long' };
      case 'too_large': return { ok: false, refusal: 'too_large' };
      case 'deadline': case 'memory': return { ok: false, refusal: 'timeout' };
      case 'converter_missing': return { ok: false, refusal: 'unavailable' };
      // The container could not hold the staged file to the digest and size it was given.
      case 'request_invalid': return { ok: false, refusal: 'changed' };
      case 'encrypted': case 'corrupt': case 'not_pdf': case 'not_docx': return { ok: false, refusal: 'unreadable' };
      default: return { ok: false, refusal: 'failed' };
    }
  }
  if (result.outcome !== 'text' || result.format !== format || !text) return { ok: false, refusal: 'failed' };
  if (createHash('sha256').update(text).digest('hex') !== result.textSha256) return { ok: false, refusal: 'failed' };
  if (result.truncated === true || text.length > cap) return { ok: false, refusal: 'too_large' };
  const body = text.toString('utf8');
  const chars = significantChars(body);
  /** @type {number | null} */
  let pages = null;
  /** @type {number[]} */
  let blank = [];
  if (format === 'pdf') {
    pages = Number(result.pages);
    if (!Number.isSafeInteger(pages) || pages < 1) return { ok: false, refusal: 'failed' };
    if (pages > limits.maxPages) return { ok: false, refusal: 'too_long' };
    const perPage = Array.isArray(result.pageChars) ? result.pageChars.map(Number) : [];
    if (perPage.length !== pages || perPage.some(count => !Number.isFinite(count) || count < 0)) return { ok: false, refusal: 'failed' };
    // The decision: characters per page, as this module recounted them.
    if (chars / pages < limits.minCharsPerPage) return { ok: false, refusal: 'needs_text' };
    blank = perPage.flatMap((count, index) => (count < BLANK_PAGE_CHARS ? [index + 1] : []));
  } else {
    if (chars < DOCX_MIN_CHARS) return { ok: false, refusal: 'needs_text' };
    const declared = Number(result.pages);
    pages = Number.isSafeInteger(declared) && declared > 0 ? declared : null;
  }
  const extractor = result.extractor && typeof result.extractor === 'object' ? result.extractor : {};
  return {
    ok: true,
    text: body,
    extraction: {
      sourceFormat: format,
      pages,
      blankPages: blank.length,
      blankPageNumbers: blank.slice(0, BLANK_PAGES_LISTED),
      significantChars: chars,
      charsPerPage: pages ? Math.round((chars / pages) * 10) / 10 : null,
      textSha256: createHash('sha256').update(text).digest('hex'),
      extractor: {
        name: String(extractor.name ?? '').slice(0, 60),
        version: String(extractor.version ?? '').slice(0, 20),
        libraries: Object.fromEntries(Object.entries(extractor.libraries ?? {}).slice(0, 8).map(([name, version]) => [String(name).slice(0, 30), String(version).slice(0, 20)])),
      },
    },
  };
}

/** The sentence-bearing refusal for a verdict; the registry holds the reader's words. */
const REFUSALS = Object.freeze({
  needs_text: [422, 'vcr_document_needs_text', 'The document has no extractable text; it is a scan or an image. Supply a text version.', 'needsText'],
  unreadable: [422, 'vcr_document_unreadable', 'The document could not be opened: it is damaged, protected or not a PDF or .docx file.', 'unreadable'],
  too_long: [413, 'vcr_document_too_long', 'The document has more pages than this deployment converts.', 'tooLong'],
  too_large: [413, 'vcr_data_file_too_large', 'The extracted text is larger than a record document may be.', 'tooLarge'],
  timeout: [504, 'vcr_intake_timeout', 'The conversion took too long and was stopped.', 'timedOut'],
  failed: [502, 'vcr_intake_failed', 'The conversion did not finish.', 'failed'],
  unavailable: [503, 'vcr_document_converter_unavailable', 'This deployment cannot convert PDF or Word files.', 'unavailable'],
  changed: [409, 'vcr_intake_input_invalid', 'The staged document is not the file that was uploaded; upload it again.', 'failed'],
});

/**
 * @param {{ config: any, controller?: { runVcrIntake?: Function } | null, counters?: Record<string, number>, report?: (code: string) => void }} deps
 */
export function createVcrRecordExtractor({ config, controller = null, counters = createIntakeCounters(), report = () => {} }) {
  /** @param {keyof typeof REFUSALS} verdict */
  const refuse = verdict => {
    const [status, code, message, counter] = REFUSALS[verdict];
    counters[counter] = (counters[counter] ?? 0) + 1;
    return new HttpError(Number(status), String(code), String(message));
  };
  const limits = () => ({
    maxPages: Number(config.vcrIntakeMaxPages) || 300,
    minCharsPerPage: Number(config.vcrIntakeMinCharsPerPage) || 100,
  });

  return {
    counters,
    /** Whether a conversion can be attempted at all: a controller is composed. */
    get available() { return typeof controller?.runVcrIntake === 'function'; },
    /** What the intake page tells a person about this converter. */
    describe() {
      return {
        available: this.available, formats: Object.keys(FORMATS), maxBytes: Number(config.vcrIntakeMaxBytes) || 0,
        maxPages: limits().maxPages, minCharsPerPage: limits().minCharsPerPage,
      };
    },
    /**
     * Convert one staged upload. `path` is the raw bytes in the data plane's
     * incoming directory and `root` is the plane that holds it; the conversion's
     * own copy lives in the study's scratch area and is gone when this returns.
     * Nothing here moves or deletes the raw bytes.
     * @param {{ root: string, studyId: string, path: string, format: string, signal?: AbortSignal }} input
     * @returns {Promise<{ text: string, extraction: Record<string, any> }>}
     */
    async extract({ root, studyId, path, format, signal }) {
      if (!Object.hasOwn(FORMATS, format)) throw new HttpError(415, 'vcr_data_format_unsupported', 'Only PDF and Word records are converted.');
      if (!this.available) throw refuse('unavailable');
      const handle = await fs.open(path, 'r');
      let head;
      try { head = Buffer.alloc(HEAD_BYTES); const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0); head = head.subarray(0, bytesRead); } finally { await handle.close(); }
      const magicOk = format === 'pdf' ? head.includes('%PDF-') : head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      if (!magicOk) throw refuse('unreadable');
      /** @type {ReturnType<typeof decideExtraction>} */
      let verdict;
      try {
        // The container is given its limits by the controller, from the same
        // configuration this module reads (compose passes both one definition).
        verdict = await runPlaneExtraction({
          root, studyId, controller: /** @type {any} */ (controller), source: path, format, signal,
        }, async attempt => {
          const resultFile = await attempt.read('result.json', RESULT_LIMIT);
          let result = null;
          try { result = resultFile ? JSON.parse(resultFile.toString('utf8')) : null; } catch { result = null; }
          const text = result?.outcome === 'text' ? await attempt.read('text.txt', VCR_DOCUMENT_TEXT_CAP * 4) : null;
          return decideExtraction({ format, result, text, limits: limits() });
        });
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (error instanceof HttpError && typeof code === 'string' && code.startsWith('runtime_controller_')) {
          report(code);
          throw refuse('unavailable');
        }
        if (error instanceof HttpError && code === 'vcr_intake_timeout') counters.timedOut += 1;
        else if (error instanceof HttpError && code === 'vcr_intake_failed') counters.failed += 1;
        else if (error instanceof HttpError && code === 'vcr_document_converter_unavailable') counters.unavailable += 1;
        throw error;
      }
      if (verdict.ok === false) throw refuse(verdict.refusal);
      counters.extracted += 1;
      return { text: verdict.text, extraction: { ...verdict.extraction } };
    },
  };
}
