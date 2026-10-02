#!/usr/bin/env node
/** Executable local campaign recorder. Component controls never manufacture a serving qualification receipt. */
import fs from 'node:fs/promises';
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
async function ordinaryJourney() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./extension-saas-acceptance-journey.mjs', import.meta.url))],
    { env: assessmentChildEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; let size = 0;
  for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => { size += chunk.length; if (size <= 2 * 1024 * 1024) target.push(chunk); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0 || size > 2 * 1024 * 1024) throw new Error('ordinary_journey_failed');
  const lines = Buffer.concat(stdout).toString('utf8').trim().split('\n'), result = JSON.parse(lines.at(-1));
  const report = createCampaignReport({ artifactDigest: result.identity.descriptor.artifactDigest, sourcePolicy: result.identity.sourcePolicy,
    nativeImage: result.identity.nativeImage, descriptor: result.identity.descriptor }, result.observations);
  report.measurements = result.timing; report.cleanup = result.cleanup;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('acceptance_accepts_no_public_authority_arguments');
    const report = await ordinaryJourney(); process.stdout.write(canonicalJson(report) + '\n');
  } catch { process.stderr.write(JSON.stringify({ status: 'failed', qualified: false, code: 'extension_local_acceptance_incomplete' }) + '\n'); process.exitCode = 1; }
}
