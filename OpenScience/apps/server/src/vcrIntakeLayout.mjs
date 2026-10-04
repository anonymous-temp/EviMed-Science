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

const STUDY_ID = /^[A-Za-z0-9_-]{1,80}$/;
const ATTEMPT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
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
