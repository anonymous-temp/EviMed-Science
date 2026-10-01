/** Release evidence is read from a protected operator mount, never a model/API write. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { VCR_ENGINE_METHODS } from '@evimed/domain';
import { openScopedFileNoFollow, readStableFileHandle } from './security.mjs';

const MAX_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
/** @param {any} value @param {number} [max] */
const text = (value, max = 4096) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
/** @param {any} value @param {string[]} keys */
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const invalid = () => new Error('Invalid protected method validation evidence.');

/** Parse the release contract. Passing numerical cases do not qualify a clinical model.
 * @param {any} value @returns {any} */
export function parseMethodValidation(value) {
  if (!fields(value, ['schemaVersion', 'sourceRevision', 'numericalSourceDigest', 'rVersion', 'packageLockHash', 'ci', 'methods'])
    || value.schemaVersion !== 1 || !REVISION.test(value.sourceRevision) || !HASH.test(value.numericalSourceDigest)
    || value.rVersion !== '4.3.3' || !HASH.test(value.packageLockHash)) throw invalid();
  const ci = value.ci;
  if (!fields(ci, ['runId', 'jobId', 'url', 'headSha', 'status', 'reportSha256', 'completedAt'])
    || !text(ci.runId, 200) || !text(ci.jobId, 200) || ci.headSha !== value.sourceRevision || ci.status !== 'success'
    || !HASH.test(ci.reportSha256) || !text(ci.completedAt, 64) || !Number.isFinite(Date.parse(ci.completedAt))) throw invalid();
  let url; try { url = new URL(ci.url); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || !text(ci.url, 2048)) throw invalid();
  if (!Array.isArray(value.methods) || value.methods.length > Object.keys(VCR_ENGINE_METHODS).length) throw invalid();
  const seen = new Set();
  for (const entry of value.methods) {
    if (!fields(entry, ['method', 'version', 'assumptions', 'numericTests']) || !Object.hasOwn(VCR_ENGINE_METHODS, entry.method)
      || entry.version !== VCR_ENGINE_METHODS[entry.method].version || seen.has(entry.method)
      || !Array.isArray(entry.assumptions) || entry.assumptions.length > 100
      || entry.assumptions.some(item => !fields(item, ['text', 'source']) || !text(item.text) || !text(item.source))) throw invalid();
    seen.add(entry.method);
    const numeric = entry.numericTests;
    if (!fields(numeric, ['status', 'caseIds', 'referenceCases']) || numeric.status !== 'passed'
      || !Array.isArray(numeric.caseIds) || numeric.caseIds.length < 1 || numeric.caseIds.length > 1000
      || numeric.caseIds.some(id => !text(id, 200)) || new Set(numeric.caseIds).size !== numeric.caseIds.length
      || !Array.isArray(numeric.referenceCases) || numeric.referenceCases.length < 1 || numeric.referenceCases.length > numeric.caseIds.length
      || numeric.referenceCases.some(ref => !fields(ref, ['caseId', 'reference']) || !numeric.caseIds.includes(ref.caseId) || !text(ref.reference))
      || new Set(numeric.referenceCases.map(ref => ref.caseId)).size !== numeric.referenceCases.length) throw invalid();
  }
  return structuredClone(value);
}

/** @param {any} stat */
export function assertMethodValidationFile(stat) {
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o644 || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_BYTES) throw invalid();
}

/** @param {any} artifact @param {any} health @param {string|null} [artifactSha256] */
export function bindMethodValidation(artifact, health, artifactSha256 = null) {
  if (!health?.ok || !HASH.test(health?.numericalSourceDigest ?? '') || !HASH.test(health?.packageLockHash ?? '')) {
    return { status: 'unmeasured', reason: 'engine_identity_unavailable' };
  }
  const runtimeVersion = /^(?:R(?: version)?\s+)?(\d+\.\d+\.\d+)(?:[ (].*)?$/.exec(String(health.rVersion ?? ''))?.[1];
  if (artifact.numericalSourceDigest !== health.numericalSourceDigest || artifact.packageLockHash !== health.packageLockHash || artifact.rVersion !== runtimeVersion) {
    return { status: 'unmeasured', reason: 'engine_identity_changed' };
  }
  return { status: 'verified', artifact, artifactSha256 };
}

/** Every display rechecks the current mount and engine; a restart/image change cannot retain a stale green badge.
 * @param {{file?:string,engine?:any,health?:any,report?:(code:string)=>void}} options */
export async function loadMethodValidation({ file = '', engine = null, health, report = () => {} }) {
  if (!file) return { status: 'unmeasured', reason: 'not_configured' };
  let opened; let artifact; let artifactSha256;
  try {
    if (!path.isAbsolute(file)) throw invalid();
    // The scoped helper walks from a real directory, not filesystem "/"
    // (whose separator would otherwise be doubled in containment checks).
    // Starting at the first directory still refuses every linked ancestor.
    const root = path.parse(file).root;
    const scope = path.join(root, path.relative(root, file).split(path.sep)[0]);
    opened = await openScopedFileNoFollow(scope, file);
    assertMethodValidationFile(opened.stat);
    const bytes = await readStableFileHandle(opened.handle, opened.stat);
    artifact = parseMethodValidation(JSON.parse(bytes.toString('utf8')));
    artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  } catch {
    report('vcr_method_validation_untrusted');
    return { status: 'unmeasured', reason: 'file_untrusted' };
  } finally { await opened?.handle.close(); }
  try { return bindMethodValidation(artifact, health ?? await engine?.health(), artifactSha256); }
  catch { return { status: 'unmeasured', reason: 'engine_identity_unavailable' }; }
}

/** @param {any[]} methods @param {any} validation */
export function validatedMethods(methods, validation) {
  return methods.map(method => {
    const entry = validation.status === 'verified'
      ? validation.artifact.methods.find(item => item.method === method.method && item.version === method.version) : null;
    const proof = entry ? { status: 'passed', caseIds: entry.numericTests.caseIds, referenceCases: entry.numericTests.referenceCases,
      ciUrl: validation.artifact.ci.url, completedAt: validation.artifact.ci.completedAt, sourceRevision: validation.artifact.sourceRevision,
      numericalSourceDigest: validation.artifact.numericalSourceDigest, packageLockHash: validation.artifact.packageLockHash,
      artifactSha256: validation.artifactSha256, ci: validation.artifact.ci }
      : { status: 'unmeasured', reason: validation.reason ?? 'no_reference_evidence' };
    return { ...method, assumptions: entry?.assumptions ?? [], numericTests: proof, validationEvidence: proof };
  });
}
