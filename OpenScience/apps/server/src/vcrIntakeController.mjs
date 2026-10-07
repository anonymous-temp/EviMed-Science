import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dockerRuntimeMount } from './dockerMounts.mjs';
import { HttpError, safeId, assertNoSymlinkPath } from './security.mjs';
import {
  VCR_IMPORT_FORMATS, VCR_INTAKE_LIMITS, VCR_INTAKE_LONG_KINDS, VCR_TABLE_LIMITS, parseVcrIntakeImportInput, parseVcrIntakeInput,
} from './vcrIntakeLayout.mjs';

/**
 * The disposable container behind 「虚拟临床研究」's intake conversions: a
 * patient record as PDF or Word becomes text (`extract`), and a published
 * figure becomes curve points (`digitize`) — and, since controller protocol 10,
 * behind a third that is not 「虚拟临床研究」's: a knowledge-base source's PDF becomes
 * its text page by page and a spreadsheet becomes its cells (`materials`), so
 * the platform can say which page and which sheet cell a parsed value is on
 * (`sourceMaterials.mjs`). It is the same mechanism, not a second one: a source
 * document is staged on the data volume exactly as a figure is (it is not
 * patient data; the external parser is sent the same bytes), and the answer is
 * read from its output directory.
 *
 * Since protocol 11 a fourth is 「虚拟临床研究」's again and is patient data from the
 * first byte: `convert` turns a source held in a standard format — FHIR
 * resources, OMOP CDM tables, CDISC ADaM transport files — into the module's own
 * tables, a field map and a dictionary (`vcrImport.mjs`, `vcr_import_convert.py`).
 * It is staged exactly as a patient record is: one file, read-only, and one empty
 * directory, both in the data plane's scratch area, bound by host path, with the
 * file's digest and size for the script to hold it to — never under the data
 * volume, never through the external parser, never in a research runtime.
 *
 * It is the document-export renderer's mechanism (`documentRenderController.mjs`)
 * and deliberately not a second framework: the runtime controller starts a
 * container from the runtime image with no network, a read-only root, every
 * capability dropped, a memory and process ceiling, and exactly two mounts that
 * hold the work — what it reads, read-only, and an empty directory it writes.
 * The operation, the command, the image and the mounts are fixed here; a caller
 * names only what it staged.
 *
 * Hidden knowledge:
 *
 * - **A patient record never sits in `open-science-data`, not even for the length
 *   of a conversion.** That volume is mounted read-write by the specialist
 *   engines and the drug-evidence adapter, it is what the data backup archives,
 *   and every project runtime mounts its directory out of it. An `extract`
 *   attempt therefore lives in the VCR data plane, in the scratch area the plane
 *   owns (`vcrIntakeLayout.mjs`): the API stages one file and one empty output
 *   directory there, and this controller binds exactly those two paths, the file
 *   read-only, by their HOST path (`vcrDataPlaneHostDir`). The Docker socket
 *   resolves a bind source on the host, so the controller mounts no plane of its
 *   own and never reads a patient byte; what it is handed is the relative path,
 *   the file's SHA-256 and its size. Because it cannot look at the file, the
 *   script's first act is to check that what is bound is a regular file of that
 *   size and digest, and it refuses on any mismatch (`vcr_record_extract.py`).
 *   `test/vcrIntakeController.test.mjs` asserts over the launch plan that every
 *   bind source is under the plane's host directory and that no path of the data
 *   volume appears in it, with the volume configured or not.
 * - **A figure is not patient data.** `digitize` works on a published image the
 *   study already holds, so its scratch stays a copy under
 *   `<dataDir>/vcr-intake/digitize/<attempt>/` (the one directory the API and the
 *   controller both see): the API removes the attempt when it has read the answer,
 *   and a leftover from a crash is swept by age. Moving it into the plane would
 *   add nothing; the plane holds patients, not papers.
 * - **A source document is not patient data either** (`materials`): it is a PDF
 *   or a spreadsheet the researcher put in the knowledge base, which the
 *   external parser is sent as well, so its scratch is a copy under
 *   `<dataDir>/vcr-intake/materials/<attempt>/` like a figure's and is removed
 *   when the answer has been read. The container measures — a PDF's text page by
 *   page, a spreadsheet's cells with their addresses — and the control plane
 *   decides what that says about the parser's tables (`sourceMaterials.mjs`); a
 *   container that cannot start leaves the document ingested without pages.
 * - **The container is not a research runtime.** The standing rule that
 *   patient-level data is never mounted where a model works is about the
 *   runtime a run executes in. This container has no model, no gateway address,
 *   no credential and no workspace — `workspace` and `runtime` are shadowed by
 *   empty read-only tmpfs mounts because the shared image declares them as
 *   volumes — and it can reach nothing but its two mounts: for a record, the one
 *   file and the one directory of its own attempt, not the plane around them.
 *   `test/vcrIntakeController.test.mjs` asserts exactly that over the launch plan.
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

export const VCR_INTAKE_KINDS = Object.freeze(['extract', 'digitize', 'materials', 'convert']);
/** The kinds whose scratch lives on the data volume, staged by the API: not a patient record. */
export const VCR_INTAKE_VOLUME_KINDS = Object.freeze(['digitize', 'materials']);
/** Where the image keeps the scripts: the research MCP server's own sources, which a delta release ships. */
export const VCR_INTAKE_SCRIPT_DIR = '/opt/evimed/mcp/evimed-research';
const SCRIPTS = Object.freeze({
  extract: `${VCR_INTAKE_SCRIPT_DIR}/vcr_record_extract.py`,
  digitize: `${VCR_INTAKE_SCRIPT_DIR}/vcr_curve_digitize.py`,
  materials: `${VCR_INTAKE_SCRIPT_DIR}/source_material_extract.py`,
  convert: `${VCR_INTAKE_SCRIPT_DIR}/vcr_import_convert.py`,
});
const LABEL = 'open-science.vcr-intake';
/** A stopped intake container older than this is a leftover; one prune per interval is enough. */
const PRUNE_AGE = '10m';
const PRUNE_INTERVAL_MS = 300_000;
const REQUEST_LIMIT = 64 * 1024;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MIB = 1024 * 1024;

/** The data volume's scratch root: figures only (see the header). @param {any} config */
export function vcrIntakeRoot(config) {
  return path.join(config.dataDir, 'vcr-intake');
}

/**
 * A figure's or a source document's attempt directory in the data volume. A
 * record has none, and asking for one is refused here rather than answered: no
 * caller can stage patient bytes under the data volume by naming `extract`.
 * @param {any} config @param {string} kind @param {string} attemptId
 */
export function vcrIntakeDirectory(config, kind, attemptId) {
  if (!VCR_INTAKE_VOLUME_KINDS.includes(kind)) throw new HttpError(400, 'vcr_intake_input_invalid', 'Only a figure or a source document is staged under the data volume.');
  return path.join(vcrIntakeRoot(config), kind, safeId(attemptId, 'attemptId'));
}

/** "768m" or "2g" as bytes. @param {unknown} value */
export function dockerMemoryBytes(value) {
  const found = /^([1-9][0-9]*)([mg])$/.exec(String(value ?? '').trim().toLowerCase());
  if (!found) throw new HttpError(500, 'vcr_intake_failed', 'The intake memory limit is not a Docker size.');
  return Number(found[1]) * (found[2] === 'g' ? 1024 : 1) * MIB;
}

/** A figure's reference: the attempt it staged under the data volume and the digest of its request. @param {unknown} reference */
function checkedReference(reference) {
  const value = /** @type {Record<string, any>} */ (reference ?? {});
  if (typeof reference !== 'object' || reference === null || Array.isArray(reference)
    || Object.keys(value).some(key => !['attemptId', 'inputDigest'].includes(key))
    || !/^[a-f0-9]{64}$/.test(String(value.inputDigest ?? ''))) {
    throw new HttpError(400, 'vcr_intake_input_invalid', 'Invalid intake reference.');
  }
  return { attemptId: safeId(value.attemptId, 'attemptId'), inputDigest: String(value.inputDigest) };
}

/** The most one file may be, in bytes: the configured ceiling, and never under 10 MiB. @param {any} config */
const fileCeiling = config => Math.max(Number(config.vcrIntakeMaxBytes) || 0, 10 * MIB);

/**
 * A record's reference: where the API staged the one file inside the plane, and
 * the file's SHA-256 and size for the script to hold it to. Nothing here is read
 * from disk — the controller has no view of the plane — so what this refuses is
 * what can be refused by its shape alone.
 * @param {any} config @param {unknown} reference
 */
function checkedRecordReference(config, reference) {
  const value = /** @type {Record<string, any>} */ (reference ?? {});
  if (typeof reference !== 'object' || reference === null || Array.isArray(reference)
    || Object.keys(value).some(key => !['path', 'sha256', 'bytes'].includes(key))
    || !/^[a-f0-9]{64}$/.test(String(value.sha256 ?? ''))
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1) {
    throw new HttpError(400, 'vcr_intake_input_invalid', 'Invalid intake reference.');
  }
  if (value.bytes > fileCeiling(config)) throw new HttpError(413, 'vcr_intake_input_invalid', 'The intake file is too large.');
  return { scratch: parseVcrIntakeInput(value.path), sha256: String(value.sha256), bytes: Number(value.bytes) };
}

/**
 * An import's reference: where the API staged the one file inside the plane, the
 * file's SHA-256 and size, and which standard it is claimed to be. As for a
 * record, nothing is read from disk; what is refused is what shape alone refuses —
 * including a file extension the claimed format is not uploaded as.
 * @param {any} config @param {unknown} reference
 */
function checkedImportReference(config, reference) {
  const value = /** @type {Record<string, any>} */ (reference ?? {});
  if (typeof reference !== 'object' || reference === null || Array.isArray(reference)
    || Object.keys(value).some(key => !['path', 'sha256', 'bytes', 'format'].includes(key))
    || !/^[a-f0-9]{64}$/.test(String(value.sha256 ?? ''))
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || !Object.hasOwn(VCR_IMPORT_FORMATS, String(value.format ?? ''))) {
    throw new HttpError(400, 'vcr_intake_input_invalid', 'Invalid intake reference.');
  }
  if (value.bytes > fileCeiling(config)) throw new HttpError(413, 'vcr_intake_input_invalid', 'The intake file is too large.');
  const scratch = parseVcrIntakeImportInput(value.path);
  const format = /** @type {keyof typeof VCR_IMPORT_FORMATS} */ (String(value.format));
  if (!VCR_IMPORT_FORMATS[format].includes(scratch.extension)) throw new HttpError(400, 'vcr_intake_input_invalid', 'The file is not one this standard is imported from.');
  return { scratch, format, sha256: String(value.sha256), bytes: Number(value.bytes) };
}

const HOST_ROOT = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

/**
 * The plane's directory as the Docker daemon sees it, the root of every bind
 * source of a record. A `--mount` value is comma-separated, so the path is held
 * to a plain alphabet and to its own normal form: a comma, a quote or a
 * dot-dot cannot be spelled into a mount option through this setting.
 * @param {any} config
 */
export function vcrIntakeHostRoot(config) {
  const root = String(config.vcrDataPlaneHostDir ?? '').trim();
  if (!root) {
    throw new HttpError(503, 'vcr_document_converter_unavailable',
      'The runtime controller has no host path for the data plane; OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR must reach it.');
  }
  if (!HOST_ROOT.test(root) || path.posix.normalize(root) !== root) {
    throw new HttpError(503, 'vcr_document_converter_unavailable',
      'The data plane host path must be a plain absolute path of letters, digits and . _ @ + - only.');
  }
  return root;
}

/**
 * One container's ceiling in milliseconds: the configured intake timeout, and
 * twice that for a source document, which is read whole (a few hundred pages of
 * text) where a record conversion reads a few, and for a standard-format import,
 * which reads every resource or row of an export. Every other limit is shared.
 * @param {any} config @param {string} kind
 */
export const vcrIntakeTimeoutOf = (config, kind) => Math.max(5_000, Number(config.vcrIntakeTimeoutMs) || 60_000) * (VCR_INTAKE_LONG_KINDS.includes(kind) ? 2 : 1);

/** The seconds the script may run: the controller's timeout less two, so the script ends before it is killed. @param {any} config @param {string} kind */
const deadlineSecondsOf = (config, kind) => Math.max(5, Math.ceil(vcrIntakeTimeoutOf(config, kind) / 1000) - 2);

/**
 * The hardening both operations share, then the two mounts and the command that
 * differ. `label` identifies the attempt; the name is derived from it.
 * @param {any} config @param {string} kind @param {string} label @param {string[]} mounts @param {string[]} command
 */
function containerArgs(config, kind, label, mounts, command) {
  const name = `evimed-vcr-intake-${kind}-${label.slice(0, 20)}`;
  const memory = String(config.vcrIntakeMemory ?? '768m');
  const args = ['create', '--name', name, '--label', `${LABEL}=${kind}`, '--label', `${LABEL}-attempt=${label}`,
    '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--cpus=1',
    `--memory=${memory}`, `--memory-swap=${memory}`,
    // The user that owns the plane's files is the one that must read the staged file
    // and write the output directory (both are 0400/0700, the web user's).
    '--user', String(config.runtimeContainerUser || `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`),
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m',
    // The shared runtime image declares persistent workspace and runtime volumes.
    // This container owns neither: both are shadowed by an empty read-only mount.
    '--tmpfs', '/workspace:ro,noexec,nosuid,nodev,size=1m', '--tmpfs', '/runtime:ro,noexec,nosuid,nodev,size=1m',
    '--env', 'HOME=/tmp', '--env', 'XDG_CONFIG_HOME=/tmp/xdg-config', '--env', 'XDG_DATA_HOME=/tmp/xdg-data',
    '--env', 'XDG_CACHE_HOME=/tmp/xdg-cache', '--env', 'XDG_STATE_HOME=/tmp/xdg-state', '--env', 'PYTHONDONTWRITEBYTECODE=1',
    // One thread per numeric library: the process ceiling above is small on purpose.
    '--env', 'OMP_NUM_THREADS=1', '--env', 'OPENBLAS_NUM_THREADS=1',
    ...mounts,
    '--entrypoint', 'python3', config.runtimeContainerImage, /** @type {Record<string, string>} */ (SCRIPTS)[kind], ...command];
  return { name, args };
}

/**
 * A record: one file of the data plane, read-only, and one empty directory of
 * the plane's scratch area, both bound by host path. Nothing under the data
 * volume appears here, whether or not the volume is configured.
 * @param {any} config @param {unknown} reference
 */
function extractPlan(config, reference) {
  const { scratch, sha256, bytes } = checkedRecordReference(config, reference);
  const host = vcrIntakeHostRoot(config);
  const hostInput = `${host}/${scratch.input}`;
  const hostOutput = `${host}/${scratch.output}`;
  const target = `/input/document.${scratch.format}`;
  const label = createHash('sha256').update(`extract\0${scratch.attemptId}\0${sha256}`).digest('hex');
  const { name, args } = containerArgs(config, 'extract', label, [
    '--mount', `type=bind,src=${hostInput},dst=${target},readonly`,
    '--mount', `type=bind,src=${hostOutput},dst=/output`,
  ], ['--file', target, '--format', scratch.format, '--expect-sha256', sha256, '--expect-bytes', String(bytes),
    '--max-pages', String(Math.max(1, Number(config.vcrIntakeMaxPages) || 300)),
    '--max-chars', String(VCR_INTAKE_LIMITS.maxChars), '--max-xml-bytes', String(VCR_INTAKE_LIMITS.maxXmlBytes),
    '--output-dir', '/output', '--deadline', String(deadlineSecondsOf(config, 'extract'))]);
  return { args, dir: null, label, name, kind: 'extract', mounts: { input: hostInput, output: hostOutput } };
}

/**
 * A standard-format import: the same two mounts as a record — the one staged
 * file, read-only, and the attempt's own empty output directory, both by host
 * path in the plane — and the plane's own table ceilings as the script's flags,
 * so a table the plane would refuse is reported skipped by name before it is written.
 * @param {any} config @param {unknown} reference
 */
function convertPlan(config, reference) {
  const { scratch, format, sha256, bytes } = checkedImportReference(config, reference);
  const host = vcrIntakeHostRoot(config);
  const hostInput = `${host}/${scratch.input}`;
  const hostOutput = `${host}/${scratch.output}`;
  const target = `/input/import.${scratch.extension}`;
  const label = createHash('sha256').update(`convert\0${scratch.attemptId}\0${sha256}`).digest('hex');
  const { name, args } = containerArgs(config, 'convert', label, [
    '--mount', `type=bind,src=${hostInput},dst=${target},readonly`,
    '--mount', `type=bind,src=${hostOutput},dst=/output`,
  ], ['--file', target, '--format', format, '--extension', scratch.extension, '--expect-sha256', sha256, '--expect-bytes', String(bytes),
    '--max-table-bytes', String(Math.max(MIB, Number(config.vcrDataMaxBytes) || 50 * MIB)),
    '--max-rows', String(VCR_TABLE_LIMITS.rows), '--max-columns', String(VCR_TABLE_LIMITS.columns),
    '--output-dir', '/output', '--deadline', String(deadlineSecondsOf(config, 'convert'))]);
  return { args, dir: null, label, name, kind: 'convert', mounts: { input: hostInput, output: hostOutput } };
}

/**
 * A figure or a source document: its attempt directory under the data volume,
 * the request and the one file in a read-only input and an empty output.
 * @param {any} config @param {'digitize' | 'materials'} kind @param {unknown} reference
 */
function stagedPlan(config, kind, reference) {
  const { attemptId, inputDigest } = checkedReference(reference);
  const dir = vcrIntakeDirectory(config, kind, attemptId);
  const label = createHash('sha256').update(`${kind}\0${attemptId}\0${inputDigest}`).digest('hex');
  const { name, args } = containerArgs(config, kind, label, [
    '--mount', `${dockerRuntimeMount(config, path.join(dir, 'input'), '/input')},readonly`,
    '--mount', dockerRuntimeMount(config, path.join(dir, 'output'), '/output'),
  ], ['--request', '/input/request.json', '--input-dir', '/input', '--output-dir', '/output', '--deadline', String(deadlineSecondsOf(config, kind))]);
  return { args, dir, label, name, kind };
}

/**
 * Fixed operation, never a caller-defined command, mount or image.
 * `image` is the runtime image as the plan is built; `run` swaps in the image
 * id it has just resolved, so a moved tag cannot change what runs mid-attempt.
 * @param {any} config @param {string} kind @param {unknown} reference
 * @returns {{ args: string[], dir: string | null, label: string, name: string, kind: string, mounts?: { input: string, output: string } }}
 */
export function vcrIntakePlan(config, kind, reference) {
  if (!VCR_INTAKE_KINDS.includes(kind)) throw new HttpError(400, 'vcr_intake_input_invalid', 'Unknown intake operation.');
  if (kind === 'extract') return extractPlan(config, reference);
  if (kind === 'convert') return convertPlan(config, reference);
  return stagedPlan(config, /** @type {'digitize' | 'materials'} */ (kind), reference);
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
 * A staged attempt (a figure's or a source document's), as the controller finds it on the data volume: a
 * request of the digest it was told, one regular file of the size the API
 * allows, no link anywhere, and an output directory that starts empty.
 * @param {any} config @param {string} dir @param {string} inputDigest
 */
async function verifyStagedFigure(config, dir, inputDigest) {
  const missing = { missingCode: 'vcr_intake_input_invalid', missingMessage: 'The intake attempt is missing.' };
  await assertNoSymlinkPath(config.dataDir, dir, missing);
  const requestPath = path.join(dir, 'input', 'request.json');
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
  const filePath = path.join(dir, 'input', String(file.name));
  await assertNoSymlinkPath(config.dataDir, filePath, missing);
  const fileStat = await fs.lstat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size > fileCeiling(config)) throw new HttpError(413, 'vcr_intake_input_invalid', 'The intake file is missing or too large.');
  const output = path.join(dir, 'output');
  await assertNoSymlinkPath(config.dataDir, output, missing);
  if ((await fs.readdir(output)).length) throw new HttpError(409, 'vcr_intake_input_invalid', 'Intake output must start empty.');
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
    // A figure's staged attempt is on a directory this process sees, so it is
    // checked here. A record's is in the plane, which this process does not mount:
    // nothing about it can be read from here, and the script holds the file to
    // its digest and size before it reads a byte (see the header).
    if (VCR_INTAKE_VOLUME_KINDS.includes(kind)) await verifyStagedFigure(config, /** @type {string} */ (base.dir), checkedReference(reference).inputDigest);
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
        timer = setTimer(stopRun, vcrIntakeTimeoutOf(config, kind));
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
