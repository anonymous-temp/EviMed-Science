#!/usr/bin/env node
/** Executable local campaign recorder. Component controls never manufacture a serving qualification receipt. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { canonicalJson, EXTENSION_SAAS_CASE_IDS } from '@evimed/domain';
import { extensionRequestObject } from '../../apps/server/src/extensionAccess.mjs';
const names = ['Account isolation', 'Project isolation', 'Role isolation', 'Caller continuity', 'Revocation', 'Secret handling', 'Patient-data boundary', 'Files and archives', 'Frontend origin', 'Client persistence', 'UI action replay', 'Network destination', 'Nested tool permissions', 'Metering and limits', 'Browser/session state', 'Preparation containment', 'Resource containment', 'Update/rollback', 'Context integrity', 'External actions', 'Telemetry', 'Proof freshness'];
const sources = ['extensionCenterApi/extensionAccountExport', 'extensionDocumentResources/extensionOperation', 'extensionAccess/extensionService', 'extensionActorBindings/extensionInvocationLookup/native pending facts', 'extensionOperation/connection revocation', 'connectorCredentials/accountExport/protected cache', 'extensionDocumentResources/VCR access', 'Cowork policy/skillArchive/controller DAC', 'runtimeUiPolicy/frame origin', 'runtimeUiPolicy/account switch', 'runtimeUiPolicy/generation action replay', 'webReadNetwork/Cowork network-none', 'native registry/run policy', 'ProductJobs/usageLedger', 'native session/resource ownership', 'contained controller/image inventory', 'contained limits/cancel/join', 'immutable generation/busy/restore', 'native transcript/source/compaction', 'existing scoped external adapters', 'network/telemetry/actual ledger', 'ExtensionQualification/source-policy identity'];
export const assessmentCaseMatrix = Object.freeze(EXTENSION_SAAS_CASE_IDS.map((caseId, index) => Object.freeze({ caseId, name: names[index], boundary: sources[index] })));
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
/** Raw controls are evidence references, not case verdicts. Qualification requires a complete independent boundary campaign. */
export function createCampaignReport(subject, observations = []) {
  extensionRequestObject(subject, ['artifactDigest', 'sourcePolicy', 'nativeImage', 'descriptor'], ['artifactDigest', 'sourcePolicy']);
  const cases = assessmentCaseMatrix.map(row => ({ ...row, status: 'unknown', observations: [], observationDigests: [] }));
  for (const observation of observations) {
    extensionRequestObject(observation, ['caseId', 'scope', 'setup', 'expected', 'actual', 'ordinaryActors', 'artifactDigest'], ['caseId', 'scope', 'actual']);
    const selected = cases.find(row => row.caseId === observation.caseId);
    if (!selected) throw new Error('unknown_acceptance_case');
    const bytes = canonicalJson(observation); if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('acceptance_observation_too_large');
    selected.observations.push(observation); selected.observationDigests.push(hash(bytes));
  }
  return { schemaVersion: 1, recordedAt: new Date().toISOString(), scope: 'local-assessment-components', subject, cases, qualified: false,
    qualificationPending: 'Actual applicable22 case outcomes and unchanged final serving image tuple, then independent Root validation and default hosted journey',
    reportDigest: hash(canonicalJson({ subject, cases })) };
}
/** Child environment is closed. No real provider/production/connector secret can be inherited by the local web fixture. */
export function assessmentChildEnvironment(environment) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'OPEN_SCIENCE_TEST_POSTGRES_URL', 'COWORK_TEST_IMAGE', 'NATIVE_SKILL_VALIDATOR_IMAGE'];
  return Object.fromEntries(allowed.filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]]));
}
/** A real child is not considered joined until its close event. Forced exit never proves resource cleanup.
 * No executable/path is accepted by this helper or the CLI; the caller owns the ChildProcess.
 */
export function runBoundedAssessmentChild(child, { deadlineMs = 120000, terminationGraceMs = 20000, forceJoinMs = 5000, maxOutputBytes = 2 * 1024 * 1024, signal = null } = {}) {
  if (![deadlineMs, terminationGraceMs, forceJoinMs, maxOutputBytes].every(Number.isSafeInteger)
    || deadlineMs < 50 || deadlineMs > 600000 || terminationGraceMs < 10 || terminationGraceMs > 60000 || forceJoinMs < 50 || forceJoinMs > 10000
    || maxOutputBytes < 64 || maxOutputBytes > 8 * 1024 * 1024) throw new Error('invalid_assessment_child_limits');
  return new Promise(resolve => {
    const stdout = [], stderr = []; let bytes = 0, failure = null, forced = false, settled = false, grace, join;
    const finish = (joined, code = null, exitSignal = null) => {
      if (settled) return; settled = true; clearTimeout(deadline); clearTimeout(grace); clearTimeout(join);
      signal?.removeEventListener('abort', interrupted);
      child.stdout?.removeListener('data', captureOut); child.stderr?.removeListener('data', captureErr);
      if (!joined) { child.stdout?.destroy(); child.stderr?.destroy(); }
      resolve({ joined, code, exitSignal, failure: failure ?? (code === 0 ? null : 'child-exit'), forced,
        cleanupConfirmed: joined && !forced && !failure && code === 0, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), observedBytes: bytes });
    };
    const terminate = reason => {
      if (failure || settled) return; failure = reason; child.kill('SIGTERM');
      grace = setTimeout(() => {
        if (settled) return; forced = true; child.kill('SIGKILL');
        join = setTimeout(() => finish(false), forceJoinMs);
      }, terminationGraceMs);
    };
    const capture = (chunk, target) => { bytes += chunk.length; if (bytes > maxOutputBytes) terminate('output-limit'); else target.push(chunk); };
    const captureOut = chunk => capture(chunk, stdout), captureErr = chunk => capture(chunk, stderr);
    const interrupted = () => terminate('interrupted');
    const deadline = setTimeout(() => terminate('deadline'), deadlineMs);
    child.stdout?.on('data', captureOut); child.stderr?.on('data', captureErr);
    child.once('error', () => { failure ??= 'child-start'; });
    child.once('close', (code, exitSignal) => finish(true, code, exitSignal));
    signal?.addEventListener('abort', interrupted, { once: true }); if (signal?.aborted) interrupted();
  });
}
async function ordinaryJourney() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./extension-saas-acceptance-journey.mjs', import.meta.url))],
    { env: assessmentChildEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const abort = new AbortController(), interrupted = () => abort.abort();
  process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
  let outcome;
  try { outcome = await runBoundedAssessmentChild(child, { signal: abort.signal }); }
  finally { process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted); }
  if (!outcome.joined || outcome.failure || outcome.code !== 0) throw Object.assign(new Error('ordinary_journey_failed'), {
    assessmentFailure: outcome.failure ?? 'join-unconfirmed', childJoined: outcome.joined, forced: outcome.forced,
    cleanupConfirmed: outcome.cleanupConfirmed, childExitCode: outcome.code, childSignal: outcome.exitSignal, observedBytes: outcome.observedBytes });
  const lines = outcome.stdout.toString('utf8').trim().split('\n'), result = JSON.parse(lines.at(-1));
  const report = createCampaignReport({ artifactDigest: result.identity.descriptor.artifactDigest, sourcePolicy: result.identity.sourcePolicy,
    nativeImage: result.identity.nativeImage, descriptor: result.identity.descriptor }, result.observations);
  report.measurements = result.timing; report.cleanup = result.cleanup;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('acceptance_accepts_no_public_authority_arguments');
    const report = await ordinaryJourney(); process.stdout.write(canonicalJson(report) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', qualified: false, code: 'extension_local_acceptance_incomplete', reason: error?.assessmentFailure ?? 'setup', childJoined: error?.childJoined ?? false, forced: error?.forced ?? false, cleanupConfirmed: error?.cleanupConfirmed ?? false, childExitCode: error?.childExitCode ?? null, childSignal: error?.childSignal ?? null, observedBytes: error?.observedBytes ?? null }) + '\n'); process.exitCode = 1; }
}
