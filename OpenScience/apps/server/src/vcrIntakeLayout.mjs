import { HttpError } from './security.mjs';

/**
 * Where a patient record's conversion keeps its working files: inside the VCR
 * data plane, in a scratch area the plane owns. Pure — no file system, no
 * Docker — because three parties read it and must agree on every character: the
 * API that stages the files (`vcrIntakeStage.mjs`), the runtime controller that
 * binds them into the container (`vcrIntakeController.mjs`), and the data
 * plane's location guard that refuses to let an engine job be pointed at them.
 *
 * ```
 * <plane>/studies/<study>/.intake/<attempt>/in/document.<pdf|docx>   one file, bound read-only
 * <plane>/studies/<study>/.intake/<attempt>/in/import.<ext>          or: a standard-format import (FHIR, OMOP, ADaM), the same
 * <plane>/studies/<study>/.intake/<attempt>/out/                     one empty directory, bound read-write
 * ```
 *
 * Hidden knowledge:
 *
 * - **The segment is hidden on purpose.** The domain's location grammar
 *   (`vcrLocationIsValid`: a segment starts with a letter, digit or underscore)
 *   cannot spell `.intake`, so no engine job can name anything in it; the same
 *   convention keeps the study's `.pseudonym-key` out of reach. The directory is
 *   also 0700 and owned by the web user, which the engine's user is not.
 * - **It lives under the study, so it dies with the study.** `removeStudyDirectory`
 *   removes `studies/<study>/` whole; a leftover of a crashed attempt goes with
 *   it, and the age sweep (`sweepStalePlaneScratch`) takes the rest.
 * - **A path is parsed, never joined.** The controller is handed one relative
 *   path, and `parseVcrIntakeInput` accepts exactly the shape above — study id,
 *   attempt id, a fixed file name with one of two extensions — so what reaches a
 *   `--mount` is built from three validated pieces, and a comma, a dot-dot or a
 *   second file cannot be spelled.
 * - **An import is a second shape in the same place, with its own parser.**
 *   `parseVcrIntakeImportInput` accepts `import.<ext>` for the extensions of
 *   `VCR_IMPORT_FORMATS` and nothing else, so the `extract` operation cannot be
 *   handed an import and `convert` cannot be handed a record: each parser refuses
 *   the other's file name.
 */

/** The hidden directory, inside each study's, that holds the attempts. */
export const VCR_INTAKE_SCRATCH = '.intake';
/** The record formats the extractor converts, and the extension its one file carries. */
export const VCR_INTAKE_DOCUMENT_FORMATS = Object.freeze(['pdf', 'docx']);
/**
 * The ceilings the container is told besides the page count (which is a
 * configured limit): the text a document may yield, and the largest XML part of
 * a Word package. The API's own check of the answer uses the same text ceiling,
 * which is why both read it from here.
 */
export const VCR_INTAKE_LIMITS = Object.freeze({ maxChars: 1024 * 1024, maxXmlBytes: 24 * 1024 * 1024 });
/**
 * What one table of the plane may be, however it arrived: the columns and rows an
 * upload is held to. The data plane's upload limit and the import container's
 * table ceiling are one definition, so a converted table is never refused by the
 * plane for a limit the converter did not know.
 */
export const VCR_TABLE_LIMITS = Object.freeze({ columns: 500, rows: 2_000_000 });
/**
 * The standard formats a patient-level source may be imported from, and the
 * extensions each is uploaded as: FHIR resources (a bulk export's NDJSON, a
 * Bundle, or a zip of them), OMOP CDM tables (a zip of CSV files) and CDISC ADaM
 * datasets (SAS transport files, alone or zipped).
 */
export const VCR_IMPORT_FORMATS = Object.freeze({
  fhir: Object.freeze(['ndjson', 'json', 'zip']),
  omop: Object.freeze(['zip']),
  adam: Object.freeze(['xpt', 'zip']),
});
/** Every extension an import may be staged under. */
export const VCR_IMPORT_EXTENSIONS = Object.freeze([...new Set(Object.values(VCR_IMPORT_FORMATS).flat())]);
/** The intake operations that read a whole source rather than a few pages: they get twice the time. */
export const VCR_INTAKE_LONG_KINDS = Object.freeze(['materials', 'convert']);

const STUDY_ID = /^[A-Za-z0-9_-]{1,80}$/;
const ATTEMPT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMPORT_PATH = new RegExp(`^studies/([A-Za-z0-9_-]{1,80})/\\.intake/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/in/import\\.(${VCR_IMPORT_EXTENSIONS.join('|')})$`);
const INPUT_PATH = /^studies\/([A-Za-z0-9_-]{1,80})\/\.intake\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/in\/document\.(pdf|docx)$/;

/** @param {string} message */
const invalid = message => new HttpError(400, 'vcr_intake_input_invalid', message);

/**
 * Every path of one attempt, relative to the plane's root, posix-separated.
 * @param {string} studyId @param {string} attemptId @param {string} format
 */
export function vcrIntakeScratchPaths(studyId, attemptId, format) {
  if (!STUDY_ID.test(String(studyId)) || !ATTEMPT_ID.test(String(attemptId)) || !VCR_INTAKE_DOCUMENT_FORMATS.includes(String(format))) {
    throw invalid('Invalid intake scratch reference.');
  }
  const scratch = `studies/${studyId}/${VCR_INTAKE_SCRATCH}`;
  const attempt = `${scratch}/${attemptId}`;
  return {
    /** The study's scratch directory: every attempt of the study is a child of it. */
    scratch,
    attempt,
    /** The directory holding the one input file. */
    inputDirectory: `${attempt}/in`,
    /** The one file the container reads. */
    input: `${attempt}/in/document.${format}`,
    /** The empty directory the container writes. */
    output: `${attempt}/out`,
  };
}

/**
 * Every path of one import attempt, relative to the plane's root, posix-separated.
 * @param {string} studyId @param {string} attemptId @param {string} extension
 */
export function vcrIntakeImportPaths(studyId, attemptId, extension) {
  if (!STUDY_ID.test(String(studyId)) || !ATTEMPT_ID.test(String(attemptId)) || !VCR_IMPORT_EXTENSIONS.includes(String(extension))) {
    throw invalid('Invalid intake scratch reference.');
  }
  const scratch = `studies/${studyId}/${VCR_INTAKE_SCRATCH}`;
  const attempt = `${scratch}/${attemptId}`;
  return { scratch, attempt, inputDirectory: `${attempt}/in`, input: `${attempt}/in/import.${extension}`, output: `${attempt}/out` };
}

/**
 * The attempt a controller request for an import names, from the one path it carries.
 * @param {unknown} relative
 * @returns {{ studyId: string, attemptId: string, extension: string, scratch: string, attempt: string, inputDirectory: string, input: string, output: string }}
 */
export function parseVcrIntakeImportInput(relative) {
  const found = IMPORT_PATH.exec(typeof relative === 'string' ? relative : '');
  if (!found) throw invalid('The intake input is not the staged file of an import attempt.');
  const [, studyId, attemptId, extension] = found;
  return { studyId, attemptId, extension, ...vcrIntakeImportPaths(studyId, attemptId, extension) };
}

/**
 * The attempt a controller request names, from the one path it carries.
 * @param {unknown} relative
 * @returns {{ studyId: string, attemptId: string, format: string, scratch: string, attempt: string, inputDirectory: string, input: string, output: string }}
 */
export function parseVcrIntakeInput(relative) {
  const found = INPUT_PATH.exec(typeof relative === 'string' ? relative : '');
  if (!found) throw invalid('The intake input is not the staged file of an intake attempt.');
  const [, studyId, attemptId, format] = found;
  return { studyId, attemptId, format, ...vcrIntakeScratchPaths(studyId, attemptId, format) };
}

/**
 * Whether a plane-relative location is, or is inside, the scratch area: what the
 * data plane's location guard refuses.
 * @param {string} relative
 */
export function isVcrIntakeScratchLocation(relative) {
  return String(relative ?? '').split(/[\\/]+/).includes(VCR_INTAKE_SCRATCH);
}
