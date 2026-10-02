import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EXTENSION_SAAS_CASE_IDS } from '@evimed/domain';
import { createAssessmentDescriptor, prepareAssessmentDeployment } from '../extension-saas-acceptance-manifest.mjs';
import { createCampaignReport, assessmentCaseMatrix, assessmentChildEnvironment, runBoundedAssessmentChild } from '../extension-saas-acceptance.mjs';
const input = { imageId: 'sha256:' + 'a'.repeat(64), integrity: 'sha256:' + 'b'.repeat(64), closureExpectedSHA: 'c'.repeat(64) };
test('assessment inputs reject credential/command authority and accessors before reading data', async () => {
  await assert.rejects(createAssessmentDescriptor({ ...input, qualified: true }));
  await assert.rejects(createAssessmentDescriptor({ ...input, command: 'ignored' }));
  let read = false; const accessor = { ...input }; Object.defineProperty(accessor, 'imageId', { enumerable: true, get() { read = true; return input.imageId; } });
  await assert.rejects(createAssessmentDescriptor(accessor)); assert.equal(read, false);
});
test('assessment manifest is protected metadata without receipts; only an owned disposable tree is accepted', async () => {
  const repo = path.resolve(new URL('../../../../', import.meta.url).pathname), parent = path.join(repo, '.evimed-local/extensions/build/fixtures'); await fs.mkdir(parent, { recursive: true });
  const root = path.join(await fs.realpath(parent), 'extension-saas-' + randomUUID()); await fs.mkdir(root, { mode: 0o700 });
  try {
    const descriptor = await createAssessmentDescriptor(input);
    await assert.rejects(prepareAssessmentDeployment('/tmp/unowned', descriptor, 'sha256:' + 'd'.repeat(64)));
    const deployment = await prepareAssessmentDeployment(root, descriptor, 'sha256:' + 'd'.repeat(64));
    assert.equal(deployment.status, 'configured'); assert.equal(deployment.admittedArtifacts[0].artifactDigest, descriptor.artifactDigest);
    assert.equal((await fs.stat(path.join(root, '.openscience/extensions-deployment.json'))).mode & 0o777, 0o400);
    await assert.rejects(fs.stat(deployment.qualificationRoot), { code: 'ENOENT' });
    await assert.rejects(prepareAssessmentDeployment(root, descriptor, 'sha256:' + 'd'.repeat(64)), { code: 'EEXIST' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('component observations never become22 passes or a trusted receipt', () => {
  const report = createCampaignReport({ artifactDigest: input.integrity, sourcePolicy: { adapterRevision: input.integrity, permissionProfileRevision: input.integrity } }, [{ caseId: 'SAAS-01', scope: 'actual-local-http-pg-native-preparation', actual: { status: 200 } }]);
  assert.deepEqual(report.cases.map(item => item.caseId), EXTENSION_SAAS_CASE_IDS); assert(report.cases.every(item => item.status === 'unknown'));
  assert.equal(report.qualified, false); assert.equal(report.cases[0].observations.length, 1); assert.equal(Object.hasOwn(report, 'receiptDigest'), false);
});
test('acceptance matrix has exactly22 unique cases and refuses untrusted verdict controls', () => {
  assert.equal(assessmentCaseMatrix.length, 22); assert.equal(new Set(assessmentCaseMatrix.map(row => row.caseId)).size, 22);
  assert(assessmentCaseMatrix.every(row => typeof row.requiredObservation === 'string' && row.requiredObservation.length > 50));
  assert.equal(assessmentCaseMatrix.filter(row => row.unreachableSurface).length, 5);
  const subject = { artifactDigest: input.integrity, sourcePolicy: {} };
  assert.throws(() => createCampaignReport(subject, [{ caseId: 'SAAS-99', scope: 'unknown', actual: {} }]));
  assert.throws(() => createCampaignReport(subject, [{ caseId: 'SAAS-01', scope: 'unknown', actual: {}, status: 'pass' }]));
});
test('local fixture environment never inherits provider keys, production URLs or cloud state', () => {
  const actual = assessmentChildEnvironment({ PATH: '/fixture/bin', HOME: '/fixture/home', OPEN_SCIENCE_TEST_POSTGRES_URL: 'local-only', DEEPSEEK_API_KEY: 'canary', OPEN_SCIENCE_DATABASE_URL: 'production-canary', AWS_SECRET_ACCESS_KEY: 'canary' });
  assert.deepEqual(Object.keys(actual).sort(), ['HOME', 'OPEN_SCIENCE_TEST_POSTGRES_URL', 'PATH']); assert.equal(JSON.stringify(actual).includes('canary'), false);
});

const childFixture = source => spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
test('child success and nonzero failure both physically join before returning', async () => {
  const okay = await runBoundedAssessmentChild(childFixture("process.stdout.write('actual-output')"), { deadlineMs: 5000, terminationGraceMs: 100, forceJoinMs: 1000, maxOutputBytes: 4096 });
  assert.equal(okay.code, 0); assert.equal(okay.joined, true); assert.equal(okay.stdout.toString(), 'actual-output'); assert.equal(okay.failure, null);
  const failed = await runBoundedAssessmentChild(childFixture('process.exitCode=7'), { deadlineMs: 5000, terminationGraceMs: 100, forceJoinMs: 1000, maxOutputBytes: 4096 });
  assert.equal(failed.code, 7); assert.equal(failed.joined, true); assert.equal(failed.failure, 'child-exit');
});
test('output overflow terminates and joins the actual child instead of merely discarding bytes', async () => {
  const child = childFixture("setInterval(()=>process.stdout.write(Buffer.alloc(8192,65)),1)");
  const result = await runBoundedAssessmentChild(child, { deadlineMs: 5000, terminationGraceMs: 100, forceJoinMs: 1000, maxOutputBytes: 4096 });
  assert.equal(result.failure, 'output-limit'); assert.equal(result.joined, true); assert(result.stdout.length <= 4096); assert.equal(child.signalCode, 'SIGTERM');
});
test('deadline escalates an ignoring child and waits for physical exit without claiming descendant cleanup', async () => {
  const child = childFixture("process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)");
  await new Promise(resolve => child.stdout.once('data', resolve));
  const result = await runBoundedAssessmentChild(child, { deadlineMs: 100, terminationGraceMs: 100, forceJoinMs: 1000, maxOutputBytes: 4096 });
  assert.equal(result.failure, 'deadline'); assert.equal(result.forced, true); assert.equal(result.joined, true); assert.equal(result.cleanupConfirmed, false); assert.equal(child.signalCode, 'SIGKILL');
});
test('caller interruption lets cooperative child cleanup finish and joins before resolving', async () => {
  const child = childFixture("process.on('SIGTERM',()=>{process.stdout.write('cleanup');process.exit(0)});process.stdout.write('ready');setInterval(()=>{},1000)");
  await new Promise(resolve => child.stdout.once('data', resolve)); const abort = new AbortController();
  const joined = runBoundedAssessmentChild(child, { deadlineMs: 5000, terminationGraceMs: 500, forceJoinMs: 1000, maxOutputBytes: 4096, signal: abort.signal }); abort.abort();
  const result = await joined; assert.equal(result.failure, 'interrupted'); assert.equal(result.forced, false); assert.equal(result.joined, true); assert.equal(result.stdout.toString(), 'cleanup');
});
test('case records distinguish measured component scope from remaining full campaign requirements', () => {
  const report = createCampaignReport({ artifactDigest: input.integrity, sourcePolicy: {} }, [{ caseId: 'SAAS-08', scope: 'actual-archive-guard', setup: 'Fixture bytes; real guards', expected: 'Name disagreement refused', actual: { refused: true } }]);
  const observed = report.cases.find(row => row.caseId === 'SAAS-08'); assert.equal(observed.componentOutcome, 'observed-partial'); assert.equal(observed.status, 'unknown'); assert.equal(observed.verifiedScopes.length, 1); assert(observed.uncovered.length > 0);
  assert.equal(report.cases.find(row => row.caseId === 'SAAS-09').componentOutcome, 'not-measured'); assert.equal(report.cases.find(row => row.caseId === 'SAAS-09').applicability, 'unresolved'); assert.equal(report.qualified, false);
});
test('ordinary driver rejects redirected/nonPG fixture URLs before filesystem or database setup', async () => {
  const { runOrdinaryAssessmentJourney } = await import('../extension-saas-acceptance-journey.mjs');
  for (const databaseUrl of ['postgresql://fixture@127.0.0.1/evimed_test?host=example.invalid', 'postgresql://fixture@127.0.0.1/evimed_test?sslkey=/unowned/private.key', 'postgresql://fixture@127.0.0.1/evimed_test#fragment', 'https://fixture@127.0.0.1/evimed_test']) {
    await assert.rejects(runOrdinaryAssessmentJourney({ databaseUrl, coworkImage: input.imageId, validatorImage: input.imageId }));
  }
});
