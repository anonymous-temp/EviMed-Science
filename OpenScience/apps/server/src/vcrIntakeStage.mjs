import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, openScopedFileNoFollow, readStableFileHandle } from './security.mjs';
import { VCR_INTAKE_KINDS, vcrIntakeDirectory, vcrIntakeRoot } from './vcrIntakeController.mjs';

/**
 * The API's half of an intake conversion: stage one file and its request in a
 * scratch attempt, ask the runtime controller to convert it, read the answer
 * back under a bound, and remove the attempt.
 *
 * The same three steps serve a patient record (`extract`) and a figure
 * (`digitize`); what the answer means is the caller's, which is why this file
 * holds no policy. Everything staged here is a copy: the original stays where it
 * was (the data plane for a record, the project workspace for a figure), and the
 * copy lives as long as one conversion — a crash leaves it behind, and the next
 * attempt sweeps what is older than an hour.
 */

const STALE_AFTER_MS = 3_600_000;
const SWEEP_INTERVAL_MS = 300_000;
let lastSweep = 0;

/** @param {Buffer | string} data */
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** @param {string} file */
async function sha256OfFile(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

/**
 * Remove attempts older than an hour, at most once in five minutes per process.
 * Never throws: housekeeping must not fail a conversion.
 * @param {any} config @param {number} [now]
 */
export async function sweepStaleIntake(config, now = Date.now()) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return 0;
  lastSweep = now;
  let removed = 0;
  for (const kind of VCR_INTAKE_KINDS) {
    const parent = path.join(vcrIntakeRoot(config), kind);
    const names = await fs.readdir(parent).catch(() => []);
    for (const name of names) {
      const target = path.join(parent, name);
      const stat = await fs.lstat(target).catch(() => null);
      if (stat && now - stat.mtimeMs > STALE_AFTER_MS) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        removed += 1;
      }
    }
  }
  return removed;
}

/** Test seam: the sweep remembers when it last ran. */
export function resetIntakeSweep() { lastSweep = 0; }

/**
 * One attempt directory with the file and the request staged.
 * @param {any} config
 * @param {string} kind `extract` or `digitize`
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
 * A regular file of the attempt's output directory, read whole under a bound,
 * never through a link.
 * @param {string} dir @param {string} name @param {number} limit
 * @returns {Promise<Buffer | null>} null when the file does not exist
 */
export async function readIntakeOutput(dir, name, limit) {
  const output = path.join(dir, 'output');
  let opened;
  try {
    opened = await openScopedFileNoFollow(output, path.join(output, name));
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
 * Stage, run, read, remove. `consume` receives a reader bound to the attempt's
 * output and returns what the caller wants out of it; the attempt is gone when
 * this returns or throws.
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
    return await consume({ read: (file, limit) => readIntakeOutput(staged.dir, file, limit), fileSha256: staged.fileSha256, bytes: staged.bytes });
  } finally {
    await fs.rm(staged.dir, { recursive: true, force: true }).catch(() => {});
  }
}
