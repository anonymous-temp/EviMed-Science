/** Ordinary local accounts and actual HTTP/PG/native preparation. Runtime execution follows a separately qualified campaign. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeSkillSnapshotArchive } from '../../apps/server/src/nativeSkillCatalogue.mjs';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWebApiApp } from '../../apps/server/src/server.mjs';
import { createGeoTestDatabase } from '../../apps/server/test/helpers/geoTestDatabase.mjs';
import { createNativeValidationFixture } from '../../apps/server/test/helpers/nativeSkillValidationFixture.mjs';
import { createControllerExtensionComposition } from '../../apps/server/src/extensionControllerComposition.mjs';
import { ExtensionPreparationWorker } from '../../apps/server/src/extensionPreparationWorker.mjs';
import { createAssessmentDescriptor, prepareAssessmentDeployment, ASSESSMENT_BOOTSTRAP } from './extension-saas-acceptance-manifest.mjs';
const repo = path.resolve(new URL('../../../', import.meta.url).pathname);
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
/** Only local fixture connection/image inputs; credentials never enter observations. */
export async function runOrdinaryAssessmentJourney({ databaseUrl, coworkImage, validatorImage }) {
  const parsed = new URL(databaseUrl);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)); assert.match(parsed.pathname, /^\/evimed_test[a-z0-9_]*$/);
  assert.match(coworkImage, /^sha256:[a-f0-9]{64}$/); assert.match(validatorImage, /^sha256:[a-f0-9]{64}$/);
  const fixtureRoot = path.join(repo, '.evimed-local/extensions/build/fixtures'); await fs.mkdir(fixtureRoot, { recursive: true });
  const root = path.join(await fs.realpath(fixtureRoot), 'extension-saas-' + randomUUID()); await fs.mkdir(root, { mode: 0o700 });
  const isolated = await createGeoTestDatabase(databaseUrl, 'saas');
  const observations = [], timings = [], exchanges = [], started = performance.now();
  let app, validator, composition, phase = 'bootstrap';
  try {
    const descriptor = await createAssessmentDescriptor({ imageId: coworkImage, integrity: 'sha256:f9bae51a0c0c5858aedfa17fb2ba71f7d4db4c84b27ba959061cdaefd77fa95b',
      closureExpectedSHA: createHash('sha256').update(await fs.readFile(path.join(repo, '.evimed-local/extensions/build/cowork-final-mode-20261002/context/dependency-closure.json'))).digest('hex') });
    const deployment = await prepareAssessmentDeployment(root, descriptor, digest(await fs.readFile(new URL(import.meta.url))));
    validator = await createNativeValidationFixture({ dataDir: root, image: validatorImage });
    app = createWebApiApp({ dataDir: root, databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000,
      stateStore: 'postgres', runtimeMode: 'mock', localAutoConfig: false, devAuth: false, authMode: 'local', selfRegistrationEnabled: true,
      bootstrapUser: 'assessment-bootstrap', bootstrapPassword: randomBytes(24).toString('hex'),
      deepseekProviderEnabled: false, learningEnabled: false, reviewEnabled: false, geoEnabled: false, vcrEnabled: false, frontierEnabled: false,
      operatorUsers: 'assessment-bootstrap', modelGatewaySigningSecret: randomBytes(32).toString('hex'), runtimeContainerBin: 'docker', runtimeContainerImage: validatorImage,
      skillValidationController: { validatePersonalSkill: reference => validator.validate(reference) },
    });
    const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
    phase = 'ordinary-registration';
    const accounts = [];
    for (const username of ['ordinary-a', 'ordinary-b']) {
      const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: randomBytes(24).toString('hex'), name: username, warm: false }) });
      const body = await response.json(); assert.equal(response.status, 201, body.code);
      assert.notEqual(body.data.user.id, app.config.bootstrapUser);
      accounts.push({ username, user: body.data.user, headers: { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-Open-Science-CSRF': body.data.csrfToken } });
    }
    const request = async (actor, route, method = 'GET', value = undefined, expected = 200) => {
      const before = performance.now();
      const response = await fetch(base + route, { method, headers: { ...actor.headers, 'content-type': 'application/json' },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      const body = await response.json(); assert.equal(response.status, expected, body.code);
      exchanges.push({ method, route, status: response.status, code: body.code ?? null, responseDigest: digest(JSON.stringify(body)) });
      timings.push({ operation: method + ' ' + route.replace(/skill%3A[^/]+/g, 'skill:owned'), elapsedMs: performance.now() - before, status: response.status });
      return body.data;
    };
    phase = 'personal-lifecycle';
    const [alice, bob] = accounts, content = { expectedRevision: 0, title: 'Local authored method', description: 'Compare supplied public sources', instructions: 'Preserve quotation provenance and distinguish unknown from zero.' };
    const aliceMe = await request(alice, '/api/me'), bobMe = await request(bob, '/api/me');
    assert.equal(aliceMe.operator, false); assert.equal(bobMe.operator, false);
    const projectId = aliceMe.project.id;
    const skill = await request(alice, '/api/skills', 'POST', content, 201), skillUrl = '/api/skills/' + encodeURIComponent(skill.id);
    assert.equal(skill.payload.prepared, true);
    await request(bob, skillUrl, 'GET', undefined, 404); await request(bob, skillUrl + '/portable', 'GET', undefined, 404);
    const archiveEntries = { 'SKILL.md': Buffer.from('---\nname: account-resource-check\ndescription: Owned public resource\n---\n\nRead references/public.txt and retain provenance.\n'), 'references/public.txt': Buffer.from('Synthetic public evidence canary; no patient rows.') };
    const archive = await nativeSkillSnapshotArchive(Object.entries(archiveEntries).map(([name, bytes]) => ({ path: name, size: bytes.length, digest: digest(bytes), bytesBase64: bytes.toString('base64') })));
    const uploaded = await fetch(base + '/api/skills/uploads?kind=tar-gzip', { method: 'POST', headers: { ...alice.headers, 'content-type': 'application/octet-stream' }, body: archive });
    assert.equal(uploaded.status, 201); const resourceId = (await uploaded.json()).data.resourceId;
    const imported = await request(alice, '/api/skills/import', 'POST', { resourceId, title: 'Owned source with resource' }, 201);
    const resource = imported.payload.resources[0]; assert(resource);
    await request(bob, '/api/skills/' + encodeURIComponent(imported.id) + '/resources/' + encodeURIComponent(resource.id) + '?revision=1', 'GET', undefined, 404);
    const own = await request(bob, '/api/skills', 'POST', { ...content, title: 'Other ordinary account method' }, 201); assert.notEqual(own.id, skill.id);
    const changed = await request(alice, skillUrl, 'PUT', { ...content, expectedRevision: 1, instructions: content.instructions + '\nRetain failed tool observations.' });
    assert.equal(changed.revision, 2); await request(alice, skillUrl, 'PUT', { ...content, expectedRevision: 1 }, 409);
    const restored = await request(alice, skillUrl + '/restore', 'POST', { expectedRevision: 2, revision: 1 }); assert.equal(restored.revision, 3);
    assert.equal(restored.payload.digest, skill.payload.digest);
    phase = 'extension-install-prepare';
    const installed = await request(alice, '/api/extensions/installations', 'POST', { coordinate: descriptor.coordinate, scope: 'project', projectId, idempotencyKey: 'ordinary-install' }, 201);
    await request(bob, '/api/extensions/installations/' + encodeURIComponent(installed.installation.id), 'GET', undefined, 404);
    await request(bob, '/api/extensions/installations/' + encodeURIComponent(installed.installation.id) + '/revisions', 'GET', undefined, 404);
    await request(bob, '/api/extensions/jobs/' + encodeURIComponent(installed.job.id), 'GET', undefined, 404);
    const again = await request(alice, '/api/extensions/installations', 'POST', { coordinate: descriptor.coordinate, scope: 'project', projectId, idempotencyKey: 'ordinary-install' }, 201);
    assert.equal(again.installation.id, installed.installation.id); assert.equal(again.job.id, installed.job.id);
    phase = 'controller-composition';
    composition = createControllerExtensionComposition({ config: app.config, deployment, database: app.store.database }); assert(composition, JSON.stringify({ deploymentConfigured: deployment.status === 'configured', databaseConfigured: Boolean(app.config.databaseUrl), signerConfigured: typeof app.config.modelGatewaySigningSecret === 'string' && app.config.modelGatewaySigningSecret.length >= 32 }));
    const preparation = new ExtensionPreparationWorker({ service: app.extensionService, controller: composition.tools, admittedArtifacts: deployment.admittedArtifacts });
    phase = 'contained-preparation';
    await preparation.tick();
    const current = await request(alice, '/api/extensions/installations/' + encodeURIComponent(installed.installation.id));
    assert.equal(current.prepareJobId, installed.job.id); assert.equal(current.effective, false);
    const job = await app.extensionService.jobs.get(alice.user.id, installed.job.id);
    if (job.status !== 'succeeded') throw Object.assign(new Error('controlled_preparation_failed'), { code: job.error?.code ?? 'unknown_preparation_outcome', expected: 'succeeded', actual: job.status }); assert.equal(job.result.artifactDigest, descriptor.artifactDigest);
    observations.push({ caseId: 'SAAS-01', scope: 'actual-local-http-pg-native-preparation', setup: ASSESSMENT_BOOTSTRAP,
      expected: 'foreign metadata/history/resource/job/export denied; independent ordinary account operations usable', actual: { requests: exchanges, ownPrepared: own.payload.prepared },
      ordinaryActors: accounts.map(actor => ({ userId: actor.user.id, platformOperator: false })), artifactDigest: descriptor.artifactDigest });
    observations.push({ caseId: 'SAAS-16', scope: 'actual-default-controller-image-admission', setup: 'real leased preparation job; no qualification dependency used',
      expected: 'exact contained immutable artifact prepares without claiming effective or SaaS-qualified', actual: { status: job.status, artifactDigest: job.result.artifactDigest, effective: current.effective } });
    return { status: 'partial', qualified: false, defaultNativeHostedJourney: 'pending-real-campaign-receipt', identity: { descriptor, sourcePolicy: deployment.policy, nativeImage: validatorImage },
      observations, timing: { elapsedMs: performance.now() - started, operations: timings }, cleanup: 'owned processes and database joined in finally' };
  } catch (error) { error.assessmentStage = phase; throw error; } finally {
    let failed = false;
    for (const close of [() => composition?.close(), () => validator?.close(), () => app?.close()]) { try { await close(); } catch { failed = true; } }
    try { await isolated.drop(); } catch { failed = true; }
    if (!failed) await fs.rm(root, { recursive: true, force: true });
    if (failed) throw new Error('assessment_cleanup_unconfirmed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runOrdinaryAssessmentJourney({ databaseUrl: process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, coworkImage: process.env.COWORK_TEST_IMAGE, validatorImage: process.env.NATIVE_SKILL_VALIDATOR_IMAGE });
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', qualified: false, code: error?.code ?? error?.name ?? 'assessment_failed', phase: error?.assessmentStage ?? 'input', expected: ['string', 'number', 'boolean'].includes(typeof error?.expected) ? error.expected : undefined, actual: ['string', 'number', 'boolean'].includes(typeof error?.actual) ? error.actual : undefined, detail: error?.assessmentStage === 'controller-composition' ? error.message : undefined }) + '\n'); process.exitCode = 1; }
}
