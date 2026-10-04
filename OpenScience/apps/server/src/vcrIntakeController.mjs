import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dockerRuntimeMount } from './dockerMounts.mjs';
import { HttpError, safeId, assertNoSymlinkPath } from './security.mjs';

/**
 * The disposable container behind 「虚拟临研」's two intake conversions: a
 * patient record as PDF or Word becomes text (`extract`), and a published
 * figure becomes curve points (`digitize`).
 *
 * It is the document-export renderer's mechanism (`documentRenderController.mjs`)
 * and deliberately not a second framework: the runtime controller starts a
 * container from the runtime image with no network, a read-only root, every
 * capability dropped, a memory and process ceiling, and exactly two mounts — the
 * one request and its one file, read-only, and an empty output directory. The
 * operation, the command, the image and the mounts are fixed here; a caller
 * names only an attempt directory and the digest of the request inside it.
 *
 * Hidden knowledge:
 *
 * - **The container is not a research runtime.** The standing rule that
 *   patient-level data is never mounted where a model works is about the
 *   runtime a run executes in. This container has no model, no gateway address,
 *   no credential, no workspace and no data plane — `workspace` and `runtime`
 *   are shadowed by empty read-only tmpfs mounts because the shared image
 *   declares them as volumes — and it can reach nothing but the two directories.
 *   `test/vcrIntakeController.test.mjs` asserts exactly that over the launch plan.
 * - **The scratch is a copy, and it dies with the attempt.** The API stages one
 *   copy of the file under `<dataDir>/vcr-intake/<kind>/<attempt>/` (the one
 *   directory the API and the controller both see), and removes the whole
 *   attempt when it has read the answer; a leftover from a crash is swept by
 *   age. The original stays in the data plane, which no container mounts.
 * - **A container name is per attempt, not a host-wide slot.** The renderer
 *   serializes the whole host on one name because a browser is heavy; these are
 *   a Python process and a few hundred megabytes, so up to
 *   `vcrIntakeConcurrency` run at once and a waiting request queues in this
 *   process (and leaves the queue when its caller goes away) instead of being
 *   turned away as busy.
 * - **The deadline is in the container too.** The script ends itself at the
 *   configured timeout, so a controller that dies mid-attempt does not leave a
 *   process running; the stopped container is pruned by label and age.
 */

export const VCR_INTAKE_KINDS = Object.freeze(['extract', 'digitize']);
/** Where the image keeps the two scripts: the research MCP server's own sources, which a delta release ships. */
export const VCR_INTAKE_SCRIPT_DIR = '/opt/evimed/mcp/evimed-research';
const SCRIPTS = Object.freeze({
  extract: `${VCR_INTAKE_SCRIPT_DIR}/vcr_record_extract.py`,
  digitize: `${VCR_INTAKE_SCRIPT_DIR}/vcr_curve_digitize.py`,
});
const LABEL = 'open-science.vcr-intake';
/** A stopped intake container older than this is a leftover; one prune per interval is enough. */
const PRUNE_AGE = '10m';
const PRUNE_INTERVAL_MS = 300_000;
const REQUEST_LIMIT = 64 * 1024;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MIB = 1024 * 1024;

/** @param {any} config */
export function vcrIntakeRoot(config) {
  return path.join(config.dataDir, 'vcr-intake');
}

/** @param {any} config @param {string} kind @param {string} attemptId */
export function vcrIntakeDirectory(config, kind, attemptId) {
  if (!VCR_INTAKE_KINDS.includes(kind)) throw new HttpError(400, 'vcr_intake_input_invalid', 'Unknown intake operation.');
  return path.join(vcrIntakeRoot(config), kind, safeId(attemptId, 'attemptId'));
}

/** "768m" or "2g" as bytes. @param {unknown} value */
export function dockerMemoryBytes(value) {
  const found = /^([1-9][0-9]*)([mg])$/.exec(String(value ?? '').trim().toLowerCase());
  if (!found) throw new HttpError(500, 'vcr_intake_failed', 'The intake memory limit is not a Docker size.');
  return Number(found[1]) * (found[2] === 'g' ? 1024 : 1) * MIB;
}

/** @param {unknown} reference */
function checkedReference(reference) {
  const value = /** @type {Record<string, any>} */ (reference ?? {});
  if (typeof reference !== 'object' || reference === null || Array.isArray(reference)
    || Object.keys(value).some(key => !['attemptId', 'inputDigest'].includes(key))
    || !/^[a-f0-9]{64}$/.test(String(value.inputDigest ?? ''))) {
    throw new HttpError(400, 'vcr_intake_input_invalid', 'Invalid intake reference.');
  }
  return { attemptId: safeId(value.attemptId, 'attemptId'), inputDigest: String(value.inputDigest) };
}

/**
 * Fixed operation, never a caller-defined command, mount or image.
 * `image` is the runtime image as the plan is built; `run` swaps in the image
 * id it has just resolved, so a moved tag cannot change what runs mid-attempt.
 * @param {any} config @param {string} kind @param {unknown} reference
 */
export function vcrIntakePlan(config, kind, reference) {
  const { attemptId, inputDigest } = checkedReference(reference);
  const dir = vcrIntakeDirectory(config, kind, attemptId);
  const label = createHash('sha256').update(`${kind}\0${attemptId}\0${inputDigest}`).digest('hex');
  const name = `evimed-vcr-intake-${kind}-${label.slice(0, 20)}`;
  const memory = String(config.vcrIntakeMemory ?? '768m');
  const deadlineSeconds = Math.max(5, Math.ceil(Number(config.vcrIntakeTimeoutMs ?? 60_000) / 1000) - 2);
  const args = ['create', '--name', name, '--label', `${LABEL}=${kind}`, '--label', `${LABEL}-attempt=${label}`,
    '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--cpus=1',
    `--memory=${memory}`, `--memory-swap=${memory}`,
    '--user', String(config.runtimeContainerUser || `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`),
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m',
    // The shared runtime image declares persistent workspace and runtime volumes.
    // This container owns neither: both are shadowed by an empty read-only mount.
    '--tmpfs', '/workspace:ro,noexec,nosuid,nodev,size=1m', '--tmpfs', '/runtime:ro,noexec,nosuid,nodev,size=1m',
    '--env', 'HOME=/tmp', '--env', 'XDG_CONFIG_HOME=/tmp/xdg-config', '--env', 'XDG_DATA_HOME=/tmp/xdg-data',
    '--env', 'XDG_CACHE_HOME=/tmp/xdg-cache', '--env', 'XDG_STATE_HOME=/tmp/xdg-state', '--env', 'PYTHONDONTWRITEBYTECODE=1',
    // One thread per numeric library: the process ceiling above is small on purpose.
    '--env', 'OMP_NUM_THREADS=1', '--env', 'OPENBLAS_NUM_THREADS=1',
    '--mount', `${dockerRuntimeMount(config, path.join(dir, 'input'), '/input')},readonly`,
    '--mount', dockerRuntimeMount(config, path.join(dir, 'output'), '/output'),
    '--entrypoint', 'python3', config.runtimeContainerImage, /** @type {Record<string, string>} */ (SCRIPTS)[kind],
    '--request', '/input/request.json', '--input-dir', '/input', '--output-dir', '/output', '--deadline', String(deadlineSeconds)];
  return { args, dir, label, name, kind };
}

/** A small counting semaphore whose waiters leave the queue when their caller does. @param {number} limit */
function createSlots(limit) {
  let active = 0;
  /** @type {Array<{ grant: () => void, dropped: boolean }>} */
  const waiting = [];
  const pump = () => {
    while (active < limit && waiting.length) {
      const next = /** @type {{ grant: () => void, dropped: boolean }} */ (waiting.shift());
      if (!next.dropped) { active += 1; next.grant(); }
    }
  };
  return {
    /** @param {AbortSignal | undefined} signal @returns {Promise<() => void>} */
    acquire(signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Intake canceled.', 'AbortError')); return; }
        const entry = { dropped: false, grant: () => {
          signal?.removeEventListener('abort', leave);
          let released = false;
          resolve(() => { if (!released) { released = true; active -= 1; pump(); } });
        } };
        const leave = () => { entry.dropped = true; reject(new DOMException('Intake canceled.', 'AbortError')); };
        signal?.addEventListener('abort', leave, { once: true });
        waiting.push(entry);
        pump();
      });
    },
    get active() { return active; },
    get queued() { return waiting.filter(entry => !entry.dropped).length; },
  };
}

/**
 * @param {any} config
 * @param {{ availableMemory?: () => Promise<number>, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [options]
 */
export function createVcrIntakeController(config, { availableMemory = async () => {
  const memory = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
  return Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024 || os.freemem();
}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const slots = createSlots(Math.max(1, Number(config.vcrIntakeConcurrency) || 2));
  /** @type {Map<string, any>} */
  const active = new Map();
  let lastPrune = 0;
  /** @param {string[]} args */
  const docker = args => spawnSync(config.runtimeContainerBin, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 65536 });
  /** @param {string} name */
  const remove = name => docker(['rm', '-f', name]);

  /** Stopped leftovers of an earlier controller, found by label and age. */
  function prune() {
    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    docker(['container', 'prune', '-f', '--filter', `label=${LABEL}`, '--filter', `until=${PRUNE_AGE}`]);
  }

  /**
   * One conversion. Resolves when the container exited cleanly; the caller reads
   * `output/` itself, because only the API knows what the answer means.
   * @param {string} kind @param {unknown} reference @param {AbortSignal} [signal]
   */
  async function run(kind, reference, signal) {
    const base = vcrIntakePlan(config, kind, reference);
    const { inputDigest } = checkedReference(reference);
    const missing = { missingCode: 'vcr_intake_input_invalid', missingMessage: 'The intake attempt is missing.' };
    await assertNoSymlinkPath(config.dataDir, base.dir, missing);
    const requestPath = path.join(base.dir, 'input', 'request.json');
    await assertNoSymlinkPath(config.dataDir, requestPath, missing);
    const stat = await fs.lstat(requestPath).catch(() => null);
    if (!stat?.isFile() || stat.size > REQUEST_LIMIT) throw new HttpError(400, 'vcr_intake_input_invalid', 'The intake request is missing or invalid.');
    const bytes = await fs.readFile(requestPath);
    if (createHash('sha256').update(bytes).digest('hex') !== inputDigest) throw new HttpError(409, 'vcr_intake_input_invalid', 'The intake request changed.');
    /** @type {any} */
    let request;
    try { request = JSON.parse(bytes.toString('utf8')); } catch { throw new HttpError(400, 'vcr_intake_input_invalid', 'The intake request is not JSON.'); }
    const file = request?.file;
    if (!file || !FILE_NAME.test(String(file.name ?? ''))) throw new HttpError(400, 'vcr_intake_input_invalid', 'The intake request names no usable file.');
    const filePath = path.join(base.dir, 'input', String(file.name));
    await assertNoSymlinkPath(config.dataDir, filePath, missing);
    const fileStat = await fs.lstat(filePath).catch(() => null);
    const ceiling = Math.max(Number(config.vcrIntakeMaxBytes) || 0, 10 * MIB);
    if (!fileStat?.isFile() || fileStat.size > ceiling) throw new HttpError(413, 'vcr_intake_input_invalid', 'The intake file is missing or too large.');
    const output = path.join(base.dir, 'output');
    await assertNoSymlinkPath(config.dataDir, output, missing);
    if ((await fs.readdir(output)).length) throw new HttpError(409, 'vcr_intake_input_invalid', 'Intake output must start empty.');
    const inspected = docker(['image', 'inspect', '--format', '{{.Id}}', config.runtimeContainerImage]);
    const imageId = inspected.stdout.trim();
    if (inspected.status !== 0 || !imageId) throw new HttpError(503, 'vcr_intake_failed', 'The intake image is not available.');
    const plan = { ...base, args: [...base.args] };
    plan.args[plan.args.indexOf(config.runtimeContainerImage)] = imageId;

    const release = await slots.acquire(signal);
    let timer;
    /** @type {(() => void) | null} */
    let stopRun = null;
    try {
      // The host keeps headroom for the API and the database: the container's own
      // ceiling and half a gigabyte beside it.
      const needed = dockerMemoryBytes(config.vcrIntakeMemory ?? '768m') + 512 * MIB;
      if ((await availableMemory()) < needed) throw new HttpError(429, 'vcr_intake_busy', 'Conversion is waiting for host memory.');
      if (signal?.aborted) throw new DOMException('Intake canceled.', 'AbortError');
      prune();
      const created = docker(plan.args);
      if (created.status !== 0) {
        remove(plan.name);
        throw new HttpError(/already in use/i.test(created.stderr) ? 429 : 503,
          /already in use/i.test(created.stderr) ? 'vcr_intake_busy' : 'vcr_intake_failed', 'The intake container could not start.');
      }
      let timedOut = false;
      return await new Promise((resolve, reject) => {
        const child = spawn(config.runtimeContainerBin, ['start', '--attach', plan.name], { stdio: ['ignore', 'ignore', 'ignore'] });
        active.set(plan.label, { child, name: plan.name });
        stopRun = () => {
          timedOut = !signal?.aborted;
          remove(plan.name);
          child.kill('SIGKILL');
          reject(timedOut ? new HttpError(504, 'vcr_intake_timeout', 'The conversion took too long and was stopped.')
            : new DOMException('Intake canceled.', 'AbortError'));
        };
        signal?.addEventListener('abort', stopRun, { once: true });
        timer = setTimer(stopRun, Math.max(5_000, Number(config.vcrIntakeTimeoutMs) || 60_000));
        child.once('error', () => reject(new HttpError(503, 'vcr_intake_failed', 'The intake container could not start.')));
        child.once('exit', code => {
          if (timedOut || signal?.aborted) return;
          if (code === 0) resolve({ finished: true });
          else reject(new HttpError(502, 'vcr_intake_failed', 'The conversion did not finish.'));
        });
      });
    } finally {
      clearTimer(timer);
      if (stopRun) signal?.removeEventListener('abort', stopRun);
      remove(plan.name);
      active.delete(plan.label);
      release();
    }
  }

  return {
    run,
    /** What an operator can read of the queue: containers running and requests waiting. */
    status() { return { running: slots.active, queued: slots.queued }; },
    async close() { for (const entry of [...active.values()]) { remove(entry.name); entry.child.kill('SIGKILL'); } active.clear(); },
  };
}
