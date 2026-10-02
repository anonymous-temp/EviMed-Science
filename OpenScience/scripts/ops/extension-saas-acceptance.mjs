#!/usr/bin/env node
/** Executable local campaign recorder. Component controls never manufacture a serving qualification receipt. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDocumentBoundaryControls } from './extension-saas-acceptance-boundaries.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { canonicalJson, EXTENSION_SAAS_CASE_IDS } from '@evimed/domain';
import { extensionRequestObject } from '../../apps/server/src/extensionAccess.mjs';
const names = ['Account isolation', 'Project isolation', 'Role isolation', 'Caller continuity', 'Revocation', 'Secret handling', 'Patient-data boundary', 'Files and archives', 'Frontend origin', 'Client persistence', 'UI action replay', 'Network destination', 'Nested tool permissions', 'Metering and limits', 'Browser/session state', 'Preparation containment', 'Resource containment', 'Update/rollback', 'Context integrity', 'External actions', 'Telemetry', 'Proof freshness'];
const sources = ['extensionCenterApi/extensionAccountExport', 'extensionDocumentResources/extensionOperation', 'extensionAccess/extensionService', 'extensionActorBindings/extensionInvocationLookup/native pending facts', 'extensionOperation/connection revocation', 'connectorCredentials/accountExport/protected cache', 'extensionDocumentResources/VCR access', 'Cowork policy/skillArchive/controller DAC', 'runtimeUiPolicy/frame origin', 'runtimeUiPolicy/account switch', 'runtimeUiPolicy/generation action replay', 'webReadNetwork/Cowork network-none', 'native registry/run policy', 'ProductJobs/usageLedger', 'native session/resource ownership', 'contained controller/image inventory', 'contained limits/cancel/join', 'immutable generation/busy/restore', 'native transcript/source/compaction', 'existing scoped external adapters', 'network/telemetry/actual ledger', 'ExtensionQualification/source-policy identity'];
const requiredObservations = [
  "Two ordinary authenticated actors: foreign settings/resources/jobs/revisions/exports refused with concealed metadata; own operations succeed.",
  "Cross-project IDs, input snapshots, cached outputs and downloads denied before dispatch and hydration, while current public input/output succeeds.",
  "Real viewer membership permits allowed reads but refuses install/configure/source mutation/owner connection; own ordinary project remains usable.",
  "Actual pending native root/child calls and queued callbacks retain original actor; forged/replayed actor or absent delegation never borrows owner authority.",
  "Membership and connector revoked during queued/running execution prevents subsequent read/write; joined cancellation is real and completed allowed output survives.",
  "Synthetic credential canary scanned across actual settings/errors/logs/export/cache: only intended managed resolution can expose value; foreign account cannot.",
  "Generic document routes reject protected patient-plane/bulk provenance despite caller classification; existing permitted individual-document policy stays intact.",
  "Actual path/symlink/archive limits and external assets refused before codec; bounded permitted document read/write remains confined to owned workspace.",
  "Actual reachable extension frontend cannot access shell/sibling frame/origin storage; or immutable image+descriptor proves no frontend payload/dispatch surface.",
  "Account/project switch leaves no prior extension state/service worker/script control; or actual admitted executable/UI closure proves no client persistence surface.",
  "Actual old generation/card action is rejected or deduplicated without wrong-scope mutation; or measured closed extension descriptor has no UI action dispatch.",
  "Actual raw URL/redirect/private/link-local destination refused; network-none image verified; intended fixed trusted internal resource path continues.",
  "Real native registry/router/nested or PTC discovery preserves blocked/foreign tool permission; absent independent pending facts reject nested calls.",
  "Real two-actor durable jobs deduplicate retry/claim, enforce finite caps/cancellation and settle once; provider usage and offline CPU explicitly distinguished.",
  "Concurrent actual browser/session/Office operations cannot cross cookie/document/lock/results; or immutable contained closure proves no such connection surface.",
  "Actual image/closure preparation cannot write host/read secrets/network/author qualification; final inventory hashes/modes match protected admitted artifact.",
  "Actual large/stalled/fanout contained work hits limits and joins physical processes before release; another owned project operation remains responsive.",
  "Actual native busy generation stays pinned during update; failed candidate startup restores known-good/baseline without losing completed work or false ready.",
  "Actual multi-turn native history records changed source/numeric assumptions/tool failure and compaction/discovery provenance without replacing protected context.",
  "Actual account-specific Notion/calendar/IM retry/revoke is authorized/idempotent and installation sends nothing; or measured image+descriptor exposes no external actions.",
  "Actual diagnostics/outbound network/mount/env/output scan with synthetic content/key canaries finds no unintended export; observed ledger remains scoped.",
  "Actual protected signature reader rejects forged/tampered/incomplete observations and reused identity after each package/adapter/DSH/image/permission/suite change."
];
const unreachableSurfaces = new Map([['SAAS-09', 'client'], ['SAAS-10', 'client'], ['SAAS-11', 'client'], ['SAAS-15', 'browser'], ['SAAS-20', 'externalActions']]);
export const assessmentCaseMatrix = Object.freeze(EXTENSION_SAAS_CASE_IDS.map((caseId, index) => Object.freeze({ caseId, name: names[index], boundary: sources[index], requiredObservation: requiredObservations[index], unreachableSurface: unreachableSurfaces.get(caseId) ?? null })));
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
/** Raw controls are evidence references, not case verdicts. Qualification requires a complete independent boundary campaign. */
export function createCampaignReport(subject, observations = []) {
  extensionRequestObject(subject, ['artifactDigest', 'sourcePolicy', 'nativeImage', 'descriptor'], ['artifactDigest', 'sourcePolicy']);
  const cases = assessmentCaseMatrix.map(row => ({ ...row, status: 'unknown', componentOutcome: 'not-measured', applicability: 'unresolved', verifiedScopes: [], uncovered: ['Full specification exercise/current artifact/runtime/setup identities/cleanup not yet independently complete'], observations: [], observationDigests: [] }));
  for (const observation of observations) {
    extensionRequestObject(observation, ['caseId', 'scope', 'setup', 'expected', 'actual', 'ordinaryActors', 'artifactDigest'], ['caseId', 'scope', 'actual']);
    const selected = cases.find(row => row.caseId === observation.caseId);
    if (!selected) throw new Error('unknown_acceptance_case');
    const bytes = canonicalJson(observation); if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('acceptance_observation_too_large');
    selected.observations.push(observation); selected.observationDigests.push(hash(bytes));
    selected.componentOutcome = 'observed-partial';
    selected.verifiedScopes.push({ boundary: observation.scope, exercise: observation.expected ?? 'See actual observation', setup: observation.setup ?? 'unspecified' });
    selected.uncovered = ['Full required observable result beyond the recorded component exercise', 'Actual final amd64 artifact/runtime tuple', 'Default authenticated native hosted journey and independent final review'];
  }
  return { schemaVersion: 1, recordedAt: new Date().toISOString(), scope: 'local-assessment-components', subject, cases, qualified: false,
    qualificationPending: 'Actual applicable22 case outcomes and unchanged final serving image tuple, then independent Root validation and default hosted journey',
    reportDigest: hash(canonicalJson({ subject, cases })) };
}
/** Child environment is closed. No real provider/production/connector secret can be inherited by the local web fixture. */
export function assessmentChildEnvironment(environment) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'OPEN_SCIENCE_TEST_POSTGRES_URL', 'COWORK_TEST_IMAGE', 'NATIVE_SKILL_VALIDATOR_IMAGE', 'COWORK_TEST_CLOSURE_SHA256', 'COWORK_TEST_INTEGRITY', 'EVIMED_EXTENSION_ACCEPTANCE_INPUTS'];
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
async function containedJourney() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./extension-saas-acceptance-contained.mjs', import.meta.url))], { env: assessmentChildEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const abort = new AbortController(), interrupted = () => abort.abort(); process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
  let result;
  try { result = await runBoundedAssessmentChild(child, { deadlineMs: 90000, signal: abort.signal }); }
  finally { process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted); }
  if (!result.joined || result.failure || result.code !== 0) throw Object.assign(new Error('contained_journey_failed'), { assessmentFailure: result.failure ?? 'child-exit', childJoined: result.joined, forced: result.forced, cleanupConfirmed: result.cleanupConfirmed });
  return JSON.parse(result.stdout.toString('utf8').trim().split('\n').at(-1));
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
  const boundaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-saas-boundaries-')));
  let boundaries;
  try { boundaries = await runDocumentBoundaryControls(boundaryRoot); }
  finally { await fs.rm(boundaryRoot, { recursive: true, force: true }); }
  const contained = await containedJourney();
  if (contained.artifact.artifactDigest !== result.identity.descriptor.artifactDigest || contained.artifact.imageId !== result.identity.descriptor.imageId) throw new Error('campaign_artifact_changed');
  const report = createCampaignReport({ artifactDigest: result.identity.descriptor.artifactDigest, sourcePolicy: result.identity.sourcePolicy,
    nativeImage: result.identity.nativeImage, descriptor: result.identity.descriptor }, [...result.observations, ...boundaries.observations, ...contained.observations]);
  report.measurements = result.timing; report.cleanup = result.cleanup;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('acceptance_accepts_no_public_authority_arguments');
    const report = await ordinaryJourney(); process.stdout.write(canonicalJson(report) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', qualified: false, code: 'extension_local_acceptance_incomplete', reason: error?.assessmentFailure ?? 'setup', childJoined: error?.childJoined ?? false, forced: error?.forced ?? false, cleanupConfirmed: error?.cleanupConfirmed ?? false, childExitCode: error?.childExitCode ?? null, childSignal: error?.childSignal ?? null, observedBytes: error?.observedBytes ?? null }) + '\n'); process.exitCode = 1; }
}
