#!/usr/bin/env node
/**
 * Import an immutable GitHub numerical-run artifact into the protected method
 * evidence contract. A stage is operator-owned and cannot activate a badge;
 * --install requires root and a protected destination directory.
 *
 * node scripts/ops/import-vcr-method-validation.mjs --repo owner/repo \
 *   --run-id 123 --job-id 456 --source-revision <40-character SHA> \
 *   --source-root /checkout --health /path/to/engine-health.json \
 *   --output /path/to/method-validation.json [--install]
 *
 * Metadata and artifact bytes are obtained from gh, never caller-supplied
 * success flags. The health snapshot must be taken from the deployed engine;
 * the consumer independently rechecks live health on every read.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalScenarioJson } from '../../packages/domain/src/vcrEngineJob.mjs';
import { parseMethodValidation, bindMethodValidation, assertMethodValidationFile } from '../../apps/server/src/vcrMethodValidation.mjs';
import { openScopedDirectoryNoFollow, openScopedFileNoFollow, readStableFileHandle } from '../../apps/server/src/security.mjs';
import { NUMERIC_REFERENCES, methodsWithoutReference, sourceCases } from './vcr-method-references.mjs';

export { NUMERIC_REFERENCES, methodsWithoutReference, sourceCases };

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const ENGINE_PATH = '项目代码/vcr-engine';
const SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[1-9][0-9]*$/;
const requiredSteps = ['Prove the library is exactly the locks', 'Run every numeric acceptance case', 'Check the run was whole', 'Preserve numerical validation evidence'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (ok, code) => { if (!ok) throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => canonicalScenarioJson(a) === canonicalScenarioJson(b);
const strings = value => typeof value === 'string' ? [value] : value;
// The hosted helper scopes beneath a directory; its root+separator containment
// check does not accept the filesystem root. The first directory still checks
// every ancestor without weakening the workspace helper.
const scopeFor = file => {
  const root = path.parse(file).root;
  return path.join(root, path.relative(root, file).split(path.sep)[0]);
};

// Which cases hold which method to a reference that is not its own code lives in `vcr-method-references.mjs`
// (reviewed entries, each with source anchors), and the methods that must have one are the engine's dispatch.

/** Match the shipped Python health digest: only installed R/*.R and R/*.json. */
export function numericalSourceDigest(files) {
  const selected = files.filter(file => /^R\/.+\.(?:R|json)$/.test(file.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  requireValue(selected.length > 0 && selected.some(file => file.path === 'R/engine.R') && selected.some(file => file.path === 'R/package-lock.json'), 'numerical_source_missing');
  requireValue(new Set(selected.map(file => file.path)).size === selected.length, 'numerical_source_duplicate');
  const digest = createHash('sha256');
  for (const file of selected) digest.update(`${file.path}\0${file.bytes.length}\0${sha256(file.bytes)}\n`, 'utf8');
  return digest.digest('hex');
}

export function packageLockHash(bytes) {
  const lock = JSON.parse(bytes.toString('utf8'));
  requireValue(lock.rVersion === '4.3.3' && Array.isArray(lock.packages) && lock.packages.length > 0, 'package_lock_invalid');
  const packages = lock.packages.map(({ package: name, version }) => {
    requireValue(typeof name === 'string' && name.length > 0 && typeof version === 'string' && version.length > 0, 'package_lock_invalid');
    return { package: name, version };
  }).sort((a, b) => a.package < b.package ? -1 : a.package > b.package ? 1 : 0);
  requireValue(new Set(packages.map(entry => entry.package)).size === packages.length, 'package_lock_invalid');
  return sha256(canonicalScenarioJson({ rVersion: lock.rVersion, packages }));
}

function referenceFor(id, definition) {
  const spec = NUMERIC_REFERENCES[id];
  const located = spec.anchors.map(anchor => {
    const index = definition.lines.findIndex(line => line.includes(anchor));
    requireValue(index >= 0, 'numeric_reference_missing');
    return `${definition.path}:${definition.line + index}: ${definition.lines[index].trim().replace(/^#\s*/, '')}`;
  });
  const commentLines = definition.lines.slice(1).filter(line => /^\s*#/.test(line));
  const comments = commentLines.map(line => line.trim().replace(/^#\s*/, '')).join(' ');
  const reference = `${comments.slice(0, 2400)}\n${located.join('\n')}`.trim();
  requireValue(reference.length > 0 && reference.length <= 4096, 'numeric_reference_invalid');
  // The fixture's own declarations describe its assumptions. Preserve them
  // verbatim with locations; never promote them to general clinical guidance.
  const assumptions = [];
  for (let index = 0; index < definition.lines.length && assumptions.length < 4; index += 1) {
    const line = definition.lines[index];
    if (!/\b(?:truth|analysis|accrual|historical|tauPrior|prognostic)\s*=\s*list\(/.test(line) || /^\s*#/.test(line)) continue;
    assumptions.push({ text: line.trim(), source: `${definition.path}:${definition.line + index}` });
  }
  return { reference, assumptions };
}

/** jsonlite auto_unbox serializes singleton character vectors as strings.
 * Normalize only the registry's declared array fields; every value, version,
 * method and other field still has to equal the committed source metadata.
 * The original artifact bytes remain the provenance and hash input.
 * @param {any} methods */
function reportedMethodMetadata(methods) {
  if (!object(methods)) return methods;
  return Object.fromEntries(Object.entries(methods).map(([name, value]) => {
    if (!object(value)) return [name, value];
    const metadata = { ...value };
    for (const field of ['endpoints', 'crossChecks']) {
      if (typeof metadata[field] === 'string') metadata[field] = [metadata[field]];
    }
    return [name, metadata];
  }));
}

/**
 * The report as the engine's own snapshot shapes it. R writes a one-element array as its element (jsonlite's auto-unboxing),
 * at any depth: `endpoints: "continuous"`, but also `legacyDesigns: "two_arm_fixed"` and `support.single_arm: "binary"` inside
 * `legacyReleases`, fields the engine gained in release 10 — and the import refused every report since
 * (`report_methods_mismatch`, 2026-10-08). Where the snapshot has an array and the report has one value, the value is boxed;
 * nothing else changes, so a real difference still fails the comparison.
 * @param {unknown} value the report's @param {unknown} shape the snapshot's @returns {unknown}
 */
export function boxedLike(value, shape) {
  if (Array.isArray(shape)) {
    const items = Array.isArray(value) ? value : value === undefined ? value : [value];
    return Array.isArray(items) ? items.map((item, index) => boxedLike(item, shape[Math.min(index, shape.length - 1)])) : items;
  }
  if (object(shape) && object(value)) {
    return Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (value)).map(([key, item]) => [key, boxedLike(item, /** @type {Record<string, unknown>} */ (shape)[key])]));
  }
  return value;
}

/** Bind GitHub's own run, job and immutable artifact metadata to one revision. */
export function verifyGitHubIdentity({ repository, sourceRevision, runId, jobId, run, job, artifact }) {
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) && SHA.test(sourceRevision) && IDENTIFIER.test(String(runId)) && IDENTIFIER.test(String(jobId)), 'ci_identity_invalid');
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  requireValue(String(run.id) === String(runId) && run.repository?.full_name === repository && run.head_sha === sourceRevision
    && run.path === '.github/workflows/web.yml' && ['push', 'workflow_dispatch'].includes(run.event)
    && run.status === 'completed' && run.conclusion === 'success' && run.html_url === runUrl, 'ci_run_untrusted');
  requireValue(String(job.id) === String(jobId) && String(job.run_id) === String(runId) && job.head_sha === sourceRevision
    && job.name === 'vcr-engine' && job.status === 'completed' && job.conclusion === 'success'
    && job.html_url === `${runUrl}/job/${jobId}` && Number.isFinite(Date.parse(job.completed_at)), 'ci_job_untrusted');
  for (const name of requiredSteps) {
    const steps = job.steps?.filter(step => step.name === name) ?? [];
    requireValue(steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success', 'ci_step_incomplete');
  }
  requireValue(IDENTIFIER.test(String(artifact.id)) && artifact.name === `vcr-numerical-evidence-${sourceRevision}` && artifact.expired === false
    && String(artifact.workflow_run?.id) === String(runId) && artifact.workflow_run?.head_sha === sourceRevision
    && /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ''), 'ci_artifact_untrusted');
  return { runId: String(runId), jobId: String(jobId), url: job.html_url, headSha: sourceRevision, status: 'success', completedAt: job.completed_at };
}

/** Only a complete executed suite with real reference comparisons creates rows. */
export function produceMethodValidation({ reportBytes, logBytes, sourceRevision, source, health, ci }) {
  requireValue(Buffer.isBuffer(reportBytes) && reportBytes.length > 0 && reportBytes.length <= MAX_EVIDENCE_BYTES, 'report_size_invalid');
  const report = JSON.parse(reportBytes.toString('utf8'));
  const allowed = ['schemaVersion', 'sourceRevision', 'rVersion', 'packageLockHash', 'numericalSourceDigest', 'methods', 'cases', 'methodsByCase', 'complete', 'testOnly', 'skippedCaseIds'];
  requireValue(object(report) && Object.keys(report).every(key => allowed.includes(key)) && report.schemaVersion === 1
    && SHA.test(sourceRevision) && report.sourceRevision === sourceRevision && report.complete === true && report.testOnly === ''
    && Array.isArray(report.skippedCaseIds) && report.skippedCaseIds.length === 0 && report.rVersion === '4.3.3', 'report_run_incomplete');
  const digest = numericalSourceDigest(source.runtimeFiles);
  const lockHash = packageLockHash(source.runtimeFiles.find(file => file.path === 'R/package-lock.json').bytes);
  requireValue(report.numericalSourceDigest === digest && report.packageLockHash === lockHash, 'report_source_mismatch');
  requireValue(equal(boxedLike(reportedMethodMetadata(report.methods), source.methods), source.methods), 'report_methods_mismatch');
  const definitions = sourceCases(source.caseFiles);
  requireValue(Array.isArray(report.cases) && report.cases.length === definitions.size && object(report.methodsByCase), 'report_cases_incomplete');
  const executed = new Set();
  for (const item of report.cases) {
    requireValue(object(item) && definitions.has(item.id) && !executed.has(item.id) && item.pass === true
      && typeof item.detail === 'string' && item.detail.length > 0 && !/\bskip(?:ped|ping)?\b/i.test(item.detail)
      && Number.isFinite(item.seconds) && item.seconds >= 0, 'report_case_invalid');
    executed.add(item.id);
  }
  for (const [id, value] of Object.entries(report.methodsByCase)) {
    const methods = strings(value);
    // Structural/refusal cases record attempted dispatches, including the
    // unknown method they deliberately reject. Those names never qualify a
    // numerical badge. Reference-bearing cases still require known methods.
    requireValue(executed.has(id) && Array.isArray(methods) && methods.length > 0 && new Set(methods).size === methods.length
      && methods.every(method => typeof method === 'string' && method.length > 0 && method.length <= 128)
      && (!Object.hasOwn(NUMERIC_REFERENCES, id) || methods.every(method => Object.hasOwn(source.methods, method))), 'report_coverage_invalid');
  }
  requireValue(Buffer.isBuffer(logBytes) && logBytes.length <= MAX_SOURCE_BYTES, 'numeric_log_invalid');
  const log = logBytes.toString('utf8');
  const logCases = [...log.matchAll(/^([A-Za-z0-9-]+)\s+(PASS|FAIL)\s+[^\n]*\|\s+([^\n]+)$/gm)];
  requireValue(logCases.length === definitions.size && new Set(logCases.map(match => match[1])).size === definitions.size
    && logCases.every(match => executed.has(match[1]) && match[2] === 'PASS' && !/\bskip(?:ped|ping)?\b/i.test(match[3]))
    && new RegExp(`(?:^|\\n)PASSED ${definitions.size}/${definitions.size}\\s*$`).test(log), 'numeric_log_incomplete');
  const methods = new Map();
  for (const [caseId, definition] of definitions) {
    const spec = NUMERIC_REFERENCES[caseId];
    if (!spec) continue;
    const coverage = strings(report.methodsByCase[caseId]) ?? [];
    const exercised = spec.methods.filter(method => coverage.includes(method));
    if (exercised.length === 0) continue;
    const reference = referenceFor(caseId, definition);
    for (const method of exercised) {
      const entry = methods.get(method) ?? { method, version: source.methods[method].version, assumptions: [], numericTests: { status: 'passed', caseIds: [], referenceCases: [] } };
      entry.numericTests.caseIds.push(caseId);
      entry.numericTests.referenceCases.push({ caseId, reference: reference.reference });
      for (const assumption of reference.assumptions) if (!entry.assumptions.some(item => equal(item, assumption))) entry.assumptions.push(assumption);
      methods.set(method, entry);
    }
  }
  requireValue(methods.size > 0, 'numeric_reference_missing');
  // Every method the engine dispatches (the registry of its own domain snapshot, never a list written here) has at least one
  // reference case this run executed. A method that has none is not left out of the evidence quietly: the evidence is refused,
  // naming the methods, because "unmeasured" in the module must mean a deployment's choice and not a table nobody updated.
  const unreferenced = Object.keys(source.methods).filter(method => !methods.has(method));
  if (unreferenced.length) throw Object.assign(new Error('method_reference_missing'), { methods: unreferenced });
  const evidence = parseMethodValidation({ schemaVersion: 1, sourceRevision, numericalSourceDigest: digest, rVersion: report.rVersion,
    packageLockHash: lockHash, ci: { ...ci, reportSha256: sha256(reportBytes) }, methods: [...methods.values()].sort((a, b) => a.method.localeCompare(b.method)) });
  requireValue(bindMethodValidation(evidence, health).status === 'verified', 'runtime_identity_mismatch');
  return evidence;
}

async function readBounded(file, limit) {
  const opened = await openScopedFileNoFollow(scopeFor(file), file);
  try {
    requireValue(opened.stat.size > 0 && opened.stat.size <= limit, 'input_size_invalid');
    return await readStableFileHandle(opened.handle, opened.stat);
  } finally { await opened.handle.close(); }
}

async function sourceFiles(directory, prefix) {
  const opened = await openScopedDirectoryNoFollow(scopeFor(directory), directory);
  try {
    const found = [];
    for (const entry of await fsp.readdir(opened.path, { withFileTypes: true })) {
      requireValue(!entry.isSymbolicLink(), 'source_symlink_refused');
      const full = path.join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) found.push(...await sourceFiles(full, relative));
      else if (/\.(?:R|json|mjs|sh)$/.test(entry.name)) found.push({ path: relative, bytes: await readBounded(full, MAX_SOURCE_BYTES) });
    }
    return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  } finally { await opened.handle.close(); }
}

/** Working bytes and inventories must be the files GitHub tested at that SHA. */
export async function readValidationSource(repositoryRoot, sourceRevision, execute = execFileSync) {
  requireValue(path.isAbsolute(repositoryRoot) && SHA.test(sourceRevision), 'source_identity_invalid');
  const engine = path.join(repositoryRoot, ENGINE_PATH);
  const runtimeFiles = (await sourceFiles(path.join(engine, 'R'), 'R')).filter(file => /\.(?:R|json)$/.test(file.path));
  const tests = await sourceFiles(path.join(engine, 'tests'), 'tests');
  const files = [...runtimeFiles, ...tests];
  const tracked = execute('git', ['-C', repositoryRoot, 'ls-tree', '-rz', '--name-only', sourceRevision, `${ENGINE_PATH}/R`, `${ENGINE_PATH}/tests`], { maxBuffer: MAX_SOURCE_BYTES }).toString('utf8').split('\0')
    .filter(name => name && /\.(?:R|json|mjs|sh)$/.test(name)).map(name => name.slice(ENGINE_PATH.length + 1)).sort();
  requireValue(equal(tracked, files.map(file => file.path).sort()), 'source_inventory_mismatch');
  for (const file of files) {
    const committed = execute('git', ['-C', repositoryRoot, 'show', `${sourceRevision}:${ENGINE_PATH}/${file.path}`], { maxBuffer: MAX_SOURCE_BYTES });
    requireValue(Buffer.from(committed).equals(file.bytes), 'source_revision_mismatch');
  }
  const methods = JSON.parse(runtimeFiles.find(file => file.path === 'R/domain-snapshot.json')?.bytes.toString('utf8') ?? '{}').methods;
  requireValue(object(methods), 'source_methods_missing');
  return { runtimeFiles, caseFiles: tests.filter(file => /^tests\/numeric\/[^/]+\.R$/.test(file.path)), methods };
}

/** Download the exact immutable v4 artifact whose digest GitHub exposes. */
export async function fetchGitHubEvidence(options, execute = execFileSync) {
  const { repository, sourceRevision, runId, jobId } = options;
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) && SHA.test(sourceRevision) && IDENTIFIER.test(runId) && IDENTIFIER.test(jobId), 'ci_identity_invalid');
  const api = suffix => JSON.parse(execute('gh', ['api', `repos/${repository}/actions/${suffix}`], { maxBuffer: MAX_SOURCE_BYTES }).toString('utf8'));
  const run = api(`runs/${runId}`);
  const job = api(`jobs/${jobId}`);
  const matches = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = api(`runs/${runId}/artifacts?per_page=100&page=${page}`);
    requireValue(Array.isArray(result.artifacts), 'ci_artifact_untrusted');
    matches.push(...result.artifacts.filter(item => item.name === `vcr-numerical-evidence-${sourceRevision}`));
    if (result.artifacts.length < 100) break;
    requireValue(page < 100, 'ci_artifact_inventory_limit');
  }
  requireValue(matches.length === 1, 'ci_artifact_untrusted');
  const artifact = matches[0];
  const ci = verifyGitHubIdentity({ ...options, run, job, artifact });
  const archive = execute('gh', ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: MAX_ARCHIVE_BYTES });
  requireValue(Buffer.isBuffer(archive) && archive.length > 0 && archive.length <= MAX_ARCHIVE_BYTES && `sha256:${sha256(archive)}` === artifact.digest, 'ci_archive_digest_mismatch');
  const temporary = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'vcr-ci-evidence-'));
  try {
    const zip = path.join(temporary, 'evidence.zip');
    await fsp.writeFile(zip, archive, { mode: 0o600, flag: 'wx' });
    const names = execute('unzip', ['-Z1', zip], { maxBuffer: MAX_EVIDENCE_BYTES }).toString('utf8').trim().split('\n');
    requireValue(equal([...names].sort(), ['vcr-numeric.log', 'vcr-numerical-evidence.json', 'vcr-service.log']), 'ci_archive_members_invalid');
    const reportBytes = execute('unzip', ['-p', zip, 'vcr-numerical-evidence.json'], { maxBuffer: MAX_EVIDENCE_BYTES });
    const logBytes = execute('unzip', ['-p', zip, 'vcr-numeric.log'], { maxBuffer: MAX_SOURCE_BYTES });
    return { ci, reportBytes, logBytes };
  } finally { await fsp.rm(temporary, { force: true, recursive: true }); }
}

export function assertProtectedDirectory(stat) {
  requireValue(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'destination_directory_unprotected');
}

/** Descriptor-held atomic rename; protected ancestors prevent mount replacement. */
export async function writeMethodValidation(file, evidence, { install = false } = {}) {
  requireValue(path.isAbsolute(file), 'destination_path_invalid');
  const bytes = Buffer.from(`${JSON.stringify(parseMethodValidation(evidence), null, 2)}\n`);
  requireValue(bytes.length > 0 && bytes.length <= MAX_EVIDENCE_BYTES, 'evidence_size_invalid');
  if (install) {
    requireValue(process.getuid?.() === 0, 'installation_requires_root');
    let cursor = path.parse(file).root;
    assertProtectedDirectory(await fsp.lstat(cursor));
    for (const part of path.relative(cursor, path.dirname(file)).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const directory = await openScopedDirectoryNoFollow(scopeFor(cursor), cursor);
      try { assertProtectedDirectory(directory.stat); } finally { await directory.handle.close(); }
    }
  }
  const parent = await openScopedDirectoryNoFollow(scopeFor(file), path.dirname(file));
  const target = path.join(parent.path, path.basename(file));
  const temporary = path.join(parent.path, `.${path.basename(file)}.${randomUUID()}`);
  let handle;
  try {
    const previous = await fsp.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    requireValue(!previous || (previous.isFile() && previous.nlink === 1), 'destination_file_untrusted');
    if (install && previous) assertMethodValidationFile(previous);
    handle = await fsp.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    await handle.chmod(0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    if (install) assertMethodValidationFile(await handle.stat());
    await handle.close(); handle = null;
    await fsp.rename(temporary, target);
    await parent.handle.sync();
    const installed = await readBounded(file, MAX_EVIDENCE_BYTES);
    requireValue(installed.equals(bytes), 'installed_evidence_changed');
    return { status: install ? 'installed' : 'staged_untrusted', sha256: sha256(bytes), bytes: bytes.length, methods: evidence.methods.length };
  } finally {
    await handle?.close();
    await fsp.rm(temporary, { force: true });
    await parent.handle.close();
  }
}

export function parseArguments(argv) {
  const keys = { '--repo': 'repository', '--run-id': 'runId', '--job-id': 'jobId', '--source-revision': 'sourceRevision', '--source-root': 'sourceRoot', '--health': 'healthFile', '--output': 'output' };
  const options = { install: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--install') { requireValue(!options.install, 'argument_duplicate'); options.install = true; continue; }
    const key = keys[flag];
    requireValue(key && !Object.hasOwn(options, key) && argv[index + 1] && !argv[index + 1].startsWith('--'), 'argument_invalid');
    options[key] = argv[++index];
  }
  requireValue(Object.values(keys).every(key => Object.hasOwn(options, key)), 'argument_missing');
  for (const key of ['sourceRoot', 'healthFile', 'output']) requireValue(path.isAbsolute(options[key]), 'argument_path_invalid');
  return options;
}

export async function main(argv) {
  const options = parseArguments(argv);
  const source = await readValidationSource(options.sourceRoot, options.sourceRevision);
  const health = JSON.parse((await readBounded(options.healthFile, MAX_EVIDENCE_BYTES)).toString('utf8'));
  const downloaded = await fetchGitHubEvidence(options);
  const evidence = produceMethodValidation({ ...downloaded, sourceRevision: options.sourceRevision, source, health });
  return writeMethodValidation(options.output, evidence, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    // gh or unzip errors can contain diagnostic output; expose a fixed code.
    const code = /^[a-z_]+$/.test(error.message) ? error.message : 'method_validation_import_failed';
    process.stderr.write(`${code}\n`);
    // method names are the engine's own registry, never gh or unzip output
    if (code === 'method_reference_missing' && Array.isArray(error.methods)) process.stderr.write(`methods without a reference case: ${error.methods.join(', ')}\n`);
    process.exitCode = 1;
  });
}
