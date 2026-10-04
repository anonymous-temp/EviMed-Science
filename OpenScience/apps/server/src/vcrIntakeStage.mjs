import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, assertNoSymlinkPath, openScopedFileNoFollow, readStableFileHandle } from './security.mjs';
import { vcrIntakeDirectory, vcrIntakeRoot } from './vcrIntakeController.mjs';
import { VCR_INTAKE_SCRATCH, vcrIntakeScratchPaths } from './vcrIntakeLayout.mjs';

/**
 * The API's half of an intake conversion: stage one file, ask the runtime
 * controller to convert it, read the answer back under a bound, and remove what
 * was staged. What the answer means is the caller's, which is why this file holds
 * no policy.
 *
 * Two kinds of bytes, two places to stage them:
 *
 * - **A patient record is staged inside the VCR data plane** (`runPlaneExtraction`),
 *   in the scratch area the plane owns (`vcrIntakeLayout.mjs`): a copy of the
 *   one file, 0400, and an empty output directory, 0700, under
 *   `studies/<study>/.intake/<attempt>/`. Nothing of it is ever written under the
 *   data volume (`open-science-data`), which the specialist engines mount
 *   read-write, the data backup archives and every project runtime mounts from. The
 *   whole attempt is removed when the answer has been read; a crash leaves it,
 *   and the next attempt sweeps what is older than an hour.
 * - **A published figure is not patient data** (`runIntakeAttempt`), so its
 *   scratch stays a copy under `<dataDir>/vcr-intake/digitize/<attempt>/`, the one
 *   directory the API and the controller both see, with its request beside it.
 *
 * Either way everything staged is a copy: the original stays where it was (the
 * plane's incoming directory for a record, the project workspace for a figure).
 */

const STALE_AFTER_MS = 3_600_000;
const SWEEP_INTERVAL_MS = 300_000;
let lastSweep = 0;
let lastPlaneSweep = 0;

/** @param {Buffer | string} data */
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** @param {string} file */
async function sha256OfFile(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

/**
 * Remove a figure's attempts older than an hour from the data volume, at most
 * once in five minutes per process. Never throws: housekeeping must not fail a
 * conversion.
 * @param {any} config @param {number} [now]
 */
export async function sweepStaleIntake(config, now = Date.now()) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return 0;
  lastSweep = now;
  let removed = 0;
  const parent = path.join(vcrIntakeRoot(config), 'digitize');
  const names = await fs.readdir(parent).catch(() => []);
  for (const name of names) {
    const target = path.join(parent, name);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_AFTER_MS) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

/**
 * Remove a record's attempts older than an hour from the plane's scratch areas,
 * at most once in five minutes per process. A link is never followed: the scratch
 * directory is looked at with `lstat`, and what is removed is the entry itself.
 * Never throws.
 * @param {string} root the plane's root @param {number} [now]
 */
export async function sweepStalePlaneScratch(root, now = Date.now()) {
  if (now - lastPlaneSweep < SWEEP_INTERVAL_MS) return 0;
  lastPlaneSweep = now;
  let removed = 0;
  const studies = await fs.readdir(path.join(root, 'studies')).catch(() => []);
  for (const study of studies) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(study)) continue;
    const scratch = path.join(root, 'studies', study, VCR_INTAKE_SCRATCH);
    const directory = await fs.lstat(scratch).catch(() => null);
    if (!directory?.isDirectory()) continue;
    for (const attempt of await fs.readdir(scratch).catch(() => [])) {
      const target = path.join(scratch, attempt);
      const stat = await fs.lstat(target).catch(() => null);
      if (stat && now - stat.mtimeMs > STALE_AFTER_MS) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        removed += 1;
      }
    }
  }
  return removed;
}

/** Test seam: both sweeps remember when they last ran. */
export function resetIntakeSweep() { lastSweep = 0; lastPlaneSweep = 0; }

/**
 * One figure's attempt directory with the image and the request staged, under the
 * data volume.
 * @param {any} config
 * @param {string} kind `digitize`
 * @param {{ name: string, source: { path?: string, bytes?: Buffer }, request: Record<string, any> }} staged
 */
export async function stageIntakeAttempt(config, kind, { name, source, request }) {
  void sweepStaleIntake(config);
  const attemptId = randomUUID();
  const dir = vcrIntakeDirectory(config, kind, attemptId);
  try {
    await fs.mkdir(path.join(dir, 'input'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(dir, 'output'), { mode: 0o700 });
    const target = path.join(dir, 'input', name);
    if (source.path) await fs.copyFile(source.path, target, fsConstants.COPYFILE_EXCL);
    else await fs.writeFile(target, /** @type {Buffer} */ (source.bytes), { mode: 0o400, flag: 'wx' });
    await fs.chmod(target, 0o400);
    const stat = await fs.stat(target);
    const fileSha256 = await sha256OfFile(target);
    const body = Buffer.from(JSON.stringify({ ...request, file: { name, sha256: fileSha256, bytes: stat.size } }));
    await fs.writeFile(path.join(dir, 'input', 'request.json'), body, { mode: 0o400, flag: 'wx' });
    return { attemptId, dir, reference: { attemptId, inputDigest: sha256(body) }, fileSha256, bytes: stat.size };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * A regular file of an attempt's output directory, read whole under a bound,
 * never through a link.
 * @param {string} outputDir @param {string} name @param {number} limit
 * @returns {Promise<Buffer | null>} null when the file does not exist
 */
export async function readIntakeOutput(outputDir, name, limit) {
  let opened;
  try {
    opened = await openScopedFileNoFollow(outputDir, path.join(outputDir, name));
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT' || /** @type {any} */ (error)?.status === 404) return null;
    throw new HttpError(502, 'vcr_intake_failed', 'The conversion left an unreadable result.');
  }
  try {
    if (!opened.stat.isFile() || opened.stat.size > limit) throw new HttpError(502, 'vcr_intake_failed', 'The conversion result is outside its bound.');
    return await readStableFileHandle(opened.handle, opened.stat);
  } finally {
    await opened.handle.close();
  }
}

/**
 * Stage, run, read, remove — for a figure, on the data volume. `consume` receives
 * a reader bound to the attempt's output and returns what the caller wants out of
 * it; the attempt is gone when this returns or throws.
 * @template T
 * @param {{ config: any, controller: { runVcrIntake: Function }, kind: string, name: string,
 *   source: { path?: string, bytes?: Buffer }, request: Record<string, any>, signal?: AbortSignal }} options
 * @param {(attempt: { read: (name: string, limit: number) => Promise<Buffer | null>, fileSha256: string, bytes: number }) => Promise<T>} consume
 * @returns {Promise<T>}
 */
export async function runIntakeAttempt({ config, controller, kind, name, source, request, signal }, consume) {
  const staged = await stageIntakeAttempt(config, kind, { name, source, request });
  try {
    await controller.runVcrIntake(kind, staged.reference, { signal });
    return await consume({ read: (file, limit) => readIntakeOutput(path.join(staged.dir, 'output'), file, limit), fileSha256: staged.fileSha256, bytes: staged.bytes });
  } finally {
    await fs.rm(staged.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One record's attempt inside the plane: a 0400 copy of the file and an empty 0700
 * output directory, in a scratch area only the web user can enter. Everything is
 * created through the layout, so a path here is one the controller will accept.
 * @param {string} root the plane's root @param {string} studyId @param {string} format @param {string} sourcePath
 */
async function stagePlaneExtraction(root, studyId, format, sourcePath) {
  const paths = vcrIntakeScratchPaths(studyId, randomUUID(), format);
  const attemptDir = path.join(root, paths.attempt);
  try {
    // 0700 from the study's scratch directory down: the engine's user, which reads
    // the rest of the plane, cannot so much as list it.
    await fs.mkdir(path.join(root, paths.scratch), { recursive: true, mode: 0o700 });
    await assertNoSymlinkPath(root, path.join(root, paths.scratch));
    await fs.mkdir(attemptDir, { mode: 0o700 });
    await fs.mkdir(path.join(root, paths.inputDirectory), { mode: 0o700 });
    await fs.mkdir(path.join(root, paths.output), { mode: 0o700 });
    const target = path.join(root, paths.input);
    await fs.copyFile(sourcePath, target, fsConstants.COPYFILE_EXCL);
    await fs.chmod(target, 0o400);
    const stat = await fs.stat(target);
    return { attemptDir, outputDir: path.join(root, paths.output), relative: paths.input, sha256: await sha256OfFile(target), bytes: stat.size };
  } catch (error) {
    await fs.rm(attemptDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Stage a record in the plane, run the converter, read the answer, remove the
 * attempt. The controller is told the path of the staged file inside the plane,
 * its SHA-256 and its size, and nothing else; the script holds the file to both
 * before it reads it. `consume` receives a reader bound to the attempt's output
 * directory; the attempt is gone when this returns or throws.
 * @template T
 * @param {{ root: string, studyId: string, controller: { runVcrIntake: Function }, source: string, format: string, signal?: AbortSignal }} options
 * @param {(attempt: { read: (name: string, limit: number) => Promise<Buffer | null>, fileSha256: string, bytes: number }) => Promise<T>} consume
 * @returns {Promise<T>}
 */
export async function runPlaneExtraction({ root, studyId, controller, source, format, signal }, consume) {
  void sweepStalePlaneScratch(root);
  const staged = await stagePlaneExtraction(root, studyId, format, source);
  try {
    await controller.runVcrIntake('extract', { path: staged.relative, sha256: staged.sha256, bytes: staged.bytes }, { signal });
    return await consume({ read: (file, limit) => readIntakeOutput(staged.outputDir, file, limit), fileSha256: staged.sha256, bytes: staged.bytes });
  } finally {
    await fs.rm(staged.attemptDir, { recursive: true, force: true }).catch(() => {});
  }
}
