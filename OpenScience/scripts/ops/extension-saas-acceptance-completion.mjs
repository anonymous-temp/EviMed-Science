/** Supplemental controls for a real, isolated hosted campaign. No synthetic job,
 * caller, controller proof, connection consumer or qualification receipt is made here.
 * Setup supplies ordinary authenticated actors and actual prepared/leased jobs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { ExtensionGenerationService } from '../../apps/server/src/extensionGenerationService.mjs';
import { ExtensionOperationService } from '../../apps/server/src/extensionOperationService.mjs';
import { runUsageKeys } from '../../apps/server/src/runUsage.mjs';
import { openScopedDirectoryNoFollow, openScopedFileNoFollow, readStableFileHandle } from '../../apps/server/src/security.mjs';
import { assertAssessmentFixtureRoot } from './extension-saas-acceptance-manifest.mjs';

const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const evidenceDigest = value => digest(canonicalJson(value));
const requireControl = (ok, code) => { if (!ok) throw new Error(code); };
const id = value => {
  requireControl(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(value), 'completion_identity_refused');
  return value;
};
const refusalCodes = new Set(['extension_access_denied', 'project_not_found', 'vcr_role_forbids', 'vcr_study_not_found', 'extension_contract_invalid', 'plugin_generation_changed', 'product_revision_conflict']);

/** Enabling VCR initializes the existing production study judge. No engine job
 * or patient source is needed; the fixture audience is confined by this app's
 * isolated database, loopback API, synthetic actors and owned filesystem.
 */
export const COMPLETION_FIXTURE_OVERRIDES = Object.freeze({ vcrEnabled: true, vcrAudience: 'all' });
export const COMPLETION_REMAINING = Object.freeze([
  'SAAS-19: actual multi-turn/compaction observations, if reached by this runtime, must be supplied by the native journey.',
  'SAAS-21: actual owned-network HTTP/DNS observation must be captured; a flag or internal-network declaration is not a packet observation.',
  'SAAS-14: this module verifies actual request attribution; the journey must additionally exercise retries, rolling caps and cancellation.',
]);

/** Bootstrap may seed real SQL records before the kernel admission is signed;
 * only the seed function permits that mode and returns no measured observation.
 */
async function fixtureBinding({ app, state }, preparation = false) {
  requireControl(app?.store?.database instanceof ControlPlaneDatabase
    && app?.hostedExtensions?.generations instanceof ExtensionGenerationService
    && app?.hostedExtensions?.operations instanceof ExtensionOperationService
    && (app.config?.runtimeMode === 'kernel' || preparation && app.config?.runtimeMode === 'mock')
    && app.config.dataDir === state?.root, 'completion_real_app_required');
  await assertAssessmentFixtureRoot(state.root);
  const configured = new URL(app.config.databaseUrl);
  requireControl(['postgres:', 'postgresql:'].includes(configured.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname)
    && !configured.search && !configured.hash, 'completion_database_refused');
  const actual = (await app.store.database.query('SELECT current_database() AS name')).rows[0]?.name;
  requireControl(/^evimed_test[a-z0-9_]*$/.test(actual ?? '') && actual === state.databaseName
    && configured.pathname === '/' + actual, 'completion_database_refused');
  requireControl(/^sha256:[a-f0-9]{64}$/.test(state.descriptor?.artifactDigest ?? ''), 'completion_artifact_refused');
  const artifact = app.hostedExtensions.generations.artifacts.get(state.descriptor.id);
  requireControl(artifact?.artifactDigest === state.descriptor.artifactDigest
    && artifact.integrity === state.descriptor.integrity
    && app.config.runtimeContainerImage === state.overrides?.runtimeContainerImage, 'completion_artifact_refused');
  return actual;
}

/** Closed live provenance gate before a measured control mutates a study. */
export async function assertCompletionFixture(context) { return fixtureBinding(context); }

function loopbackBase(value) {
  const url = new URL(value);
  requireControl(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
    && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash, 'completion_api_refused');
  return url.origin;
}

async function request(baseUrl, actor, route, { method = 'GET', body, signal, expected = [200], projectId } = {}) {
  requireControl(route.startsWith('/api/') && !route.includes('..') && !route.includes('#'), 'completion_route_refused');
  id(actor.user.id);
  const response = await fetch(loopbackBase(baseUrl) + route, {
    method, redirect: 'error', headers: { ...actor.headers, 'content-type': 'application/json', ...(projectId ? { 'X-Open-Science-Project': id(projectId) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  const chunks = [], reader = response.body?.getReader();
  let total = 0;
  requireControl(reader, 'completion_http_body_missing');
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      requireControl(total <= 512 * 1024, 'completion_http_unbounded');
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  const value = JSON.parse(bytes.toString('utf8'));
  requireControl(expected.includes(response.status), 'completion_unexpected_http_status');
  return { data: value.data, receipt: { method, route, status: response.status, responseDigest: digest(bytes), code: value.code ?? value.error?.code ?? null } };
}

async function actualActor(app, actor) {
  const current = await app.store.userById(id(actor?.user?.id));
  requireControl(current?.id === actor.user.id, 'completion_actor_unavailable');
  return current;
}

async function studyContext(app, studyId, projectId, owner) {
  requireControl(app.vcr?.members && app.vcr?.dataStore && app.vcr?.store, 'completion_real_study_consumer_required');
  const study = await app.vcr.store.getStudy(owner.id, id(studyId));
  requireControl(study?.userId === owner.id && study.projectId === id(projectId), 'completion_study_scope_refused');
  const project = await app.store.requireProject(owner, projectId);
  return { study, project };
}

/** Call during trusted fixture setup, BEFORE signing a collaborating installer's
 * admission. Uses the actual store and member service, not a projectAccess mock.
 * The unique control project avoids owner-local "default" ID ambiguity.
 */
export async function prepareCompletionStudy({ app, state, owner, lead, viewer, dataManager, site }) {
  await fixtureBinding({ app, state }, true);
  requireControl(app.vcr?.members && app.vcr?.store, 'completion_real_study_consumer_required');
  const actors = await Promise.all([owner, lead, viewer, dataManager, site].map(actor => actualActor(app, actor)));
  requireControl(new Set(actors.map(actor => actor.id)).size === 5, 'completion_distinct_actors_required');
  const project = await app.store.createProject(actors[0], 'completion-' + randomUUID(), 'Synthetic extension permission study');
  const study = await app.vcr.store.createStudy({ userId: actors[0].id, projectId: project.id, name: 'Synthetic extension permission study' });
  for (const [index, role] of [[1, 'lead'], [2, 'viewer'], [3, 'data_manager'], [4, 'site']]) {
    await app.vcr.members.add({ actor: actors[0].id, studyId: study.id, userId: actors[index].id, role,
      detail: role === 'site' ? { siteId: 'completion-synthetic-site' } : {} });
  }
  return { ownerId: actors[0].id, projectId: project.id, studyId: study.id, actorIds: actors.map(actor => actor.id) };
}

async function refused(work) {
  try { await work(); } catch (error) {
    requireControl(refusalCodes.has(error?.code), 'completion_unexpected_refusal');
    return error.code;
  }
  throw new Error('completion_expected_refusal_missing');
}

/** SAAS-03: actual authenticated routes and the SAME production study judge used
 * by invocation/generation. Viewer native frames are intentionally not exposed.
 */
export async function runStudyRoleControls({ app, state, baseUrl, fixture, owner, lead, viewer, dataManager, site, signal }) {
  await assertCompletionFixture({ app, state });
  const users = await Promise.all([owner, lead, viewer, dataManager, site].map(actor => actualActor(app, actor)));
  const { study, project } = await studyContext(app, fixture.studyId, fixture.projectId, users[0]);
  const access = app.hostedExtensions.generations.extensions.access;
  const viewerProject = await access.project(users[2], project.id);
  requireControl(viewerProject.userId === project.userId, 'completion_viewer_scope_mismatch');
  const receipts = [];
  for (const actor of [owner, lead, viewer, dataManager, site]) {
    const me = await request(baseUrl, actor, '/api/me', { signal });
    requireControl(me.data?.user?.id === actor.user.id && me.data.operator === false, 'completion_http_actor_mismatch');
    receipts.push(me.receipt);
  }
  receipts.push((await request(baseUrl, viewer, `/api/projects/${project.id}/extensions`, { signal })).receipt);
  const countJobs = async () => (await app.store.database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE project_id=$1 AND user_id=$2 AND kind IN ('extension-prepare','plugin-apply')", [project.id, project.userId])).rows[0].n;
  const before = await countJobs();
  for (const [route, method, body] of [
    ['/api/extensions/installations', 'POST', { coordinate: state.descriptor.coordinate, scope: 'project', projectId: project.id, idempotencyKey: 'completion-' + randomUUID() }],
    [`/api/projects/${project.id}/extensions`, 'PUT', { expectedRevision: 0, selections: [] }],
    [`/api/vcr/studies/${study.id}/data/sources`, 'POST', { name: 'Synthetic forbidden source' }],
    [`/api/extensions/connections?catalogueId=${encodeURIComponent(state.descriptor.id)}&projectId=${encodeURIComponent(project.id)}`, 'GET', undefined],
  ]) {
    const denied = await request(baseUrl, viewer, route, { method, body, signal, expected: [403, 404] });
    requireControl(['extension_access_denied', 'project_not_found', 'vcr_role_forbids', 'vcr_study_not_found'].includes(denied.receipt.code), 'completion_http_role_refusal_mismatch');
    receipts.push(denied.receipt);
  }
  requireControl(await countJobs() === before, 'completion_forbidden_job_created');
  const denied = [];
  for (const user of [users[2], users[3], users[4]]) denied.push(await refused(() => access.project(user, project.id, { manage: true })));
  denied.push(await refused(() => access.project(users[2], project.id, { ability: 'write' })));
  denied.push(await refused(() => access.project(users[4], project.id)));
  requireControl((await access.project(users[1], project.id, { manage: true })).userId === project.userId, 'completion_lead_scope_mismatch');
  requireControl((await access.project(users[3], project.id, { ability: 'write' })).userId === project.userId, 'completion_data_scope_mismatch');
  return { caseId: 'SAAS-03', scope: 'actual-current-http-study-membership-consumer',
    expected: 'Ordinary viewer reads remain usable, manage/source-write requests refuse, and current study abilities remain distinct.',
    actual: { studyId: study.id, ownerId: project.userId, projectId: project.id, viewerRead: true, leadManage: true, dataManagerWrite: true,
      dataManagerManage: false, siteRead: false, createdForbiddenJobs: 0, requests: receipts, refusalCodes: denied,
      artifactDigest: state.descriptor.artifactDigest,
      connectionSurface: 'Cowork has no connection consumer; viewer connection-management inventory is refused, no external call is fabricated.' } };
}

/** Existing succeeded write plus actual preserved bytes, not a result fabricated
 * for this test. Safe to call before and after membership removal; owner may
 * retain prior output even when a stale extension invocation is unavailable.
 */
export async function captureCompletedOutput({ app, state, owner, projectId, jobId }) {
  await assertCompletionFixture({ app, state });
  const user = await actualActor(app, owner), operations = app.hostedExtensions.operations;
  const job = await operations.jobs.get(user.id, id(jobId));
  requireControl(job?.kind === 'extension-execute' && job.status === 'succeeded' && job.projectId === id(projectId)
    && job.payload.scope.ownerId === user.id && job.payload.scope.artifactDigest === state.descriptor.artifactDigest
    && job.payload.request.operation === 'doc_write'
    && /^outputs\/extensions\/[A-Za-z0-9_-]+\.(?:xlsx|ipynb)$/.test(job.result?.artifactPath ?? ''), 'completion_actual_completed_output_required');
  const root = await app.hostedExtensions.documents.projectRoot(job.payload.scope, null);
  requireControl(root.startsWith(state.root + path.sep), 'completion_completed_output_scope_refused');
  const file = await openScopedFileNoFollow(root, path.join(root, job.result.artifactPath));
  let bytes;
  try {
    requireControl(file.stat.nlink === 1 && file.stat.size > 0 && file.stat.size <= 8 * 1024 * 1024, 'completion_completed_output_unbounded');
    bytes = await readStableFileHandle(file.handle, file.stat);
  } finally { await file.handle.close(); }
  requireControl(digest(bytes) === 'sha256:' + job.result.sha256, 'completion_completed_output_changed');
  return { jobId: job.id, ownerId: user.id, projectId: job.projectId, artifactPath: job.result.artifactPath,
    contentDigest: digest(bytes), bytes: bytes.length };
}

async function currentPin(app, state, project, scope) {
  const generation = await app.hostedExtensions.generations.current(project);
  const manifest = generation?.payload.effective;
  const binding = manifest?.bindings.installations.find(item => item.installationId === scope.installationId);
  requireControl(manifest && binding && binding.extensionId === state.descriptor.id
    && binding.artifactDigest === state.descriptor.artifactDigest
    && scope.descriptorId === state.descriptor.id && scope.artifactDigest === state.descriptor.artifactDigest, 'completion_actual_descriptor_binding_required');
  return { manifest, binding };
}

/** SAAS-05 queued: requires one actual queued generation containing the admitted
 * descriptor and its REAL collaborating actor epoch. No job/lease is fabricated.
 * The caller pauses its own apply consumer; other due/running work is refused.
 */
export async function runQueuedMembershipRevocation({ app, state, fixture, owner, lead, jobId }) {
  await assertCompletionFixture({ app, state });
  const user = await actualActor(app, owner), collaborator = await actualActor(app, lead);
  const { study, project } = await studyContext(app, fixture.studyId, fixture.projectId, user);
  const generations = app.hostedExtensions.generations, jobs = generations.jobs;
  const queued = await jobs.get(project.userId, id(jobId));
  requireControl(!app.pluginApplyWorker.timer && !app.pluginApplyWorker.running, 'completion_apply_worker_must_be_paused');
  const desired = (await generations.current(project))?.payload.desired;
  requireControl(queued?.status === 'queued' && Date.parse(queued.runAfter) <= Date.now() && queued.kind === 'plugin-apply' && queued.projectId === project.id
    && queued.payload.actorId === collaborator.id && queued.payload.actorMembershipEpoch
    && desired?.reference.generationHash === queued.payload.reference?.generationHash
    && desired.projection.plugins.some(pin => pin.extensionId === state.descriptor.id && pin.artifactDigest === state.descriptor.artifactDigest), 'completion_real_queued_descriptor_required');
  const before = await app.vcr.dataStore.membershipAuthority(study.id, collaborator.id);
  requireControl(before.epoch === queued.payload.actorMembershipEpoch && before.roles.includes('lead'), 'completion_queued_epoch_mismatch');
  const other = (await app.store.database.query("SELECT id FROM evimed_product.jobs WHERE kind='plugin-apply' AND (status='running' OR status='queued')", [])).rows;
  requireControl(other.length === 1 && other[0].id === queued.id, 'completion_other_apply_work_present');
  const effectiveBefore = evidenceDigest((await generations.current(project))?.payload.effective ?? null);
  await app.vcr.members.remove({ actor: user.id, studyId: study.id, userId: collaborator.id, role: 'lead' });
  const removedCode = await refused(() => generations.extensions.access.project(collaborator, project.id, { manage: true }));
  await app.vcr.members.add({ actor: user.id, studyId: study.id, userId: collaborator.id, role: 'lead' });
  const fresh = await app.vcr.dataStore.membershipAuthority(study.id, collaborator.id);
  requireControl(fresh.epoch !== before.epoch, 'completion_member_incarnation_unchanged');
  const epochCode = await app.store.database.transaction(client => app.store.database.withTransactionClient(client,
    () => refused(() => generations.assertAuthority(queued, client))));
  const claimed = await jobs.claim(['plugin-apply'], 'completion-' + randomUUID(), { leaseMs: 60000,
    admission: async client => {
      const rows = (await client.query("SELECT id FROM evimed_product.jobs WHERE kind='plugin-apply' AND status IN ('queued','running') ORDER BY id FOR UPDATE", [])).rows;
      return rows.length === 1 && rows[0].id === queued.id;
    } });
  requireControl(claimed?.id === queued.id, 'completion_queued_job_not_claimed');
  await app.pluginApplyWorker.generationWorker.runClaimed(claimed);
  const finished = await jobs.get(project.userId, queued.id);
  requireControl(finished.status === 'failed' || ['failed', 'rolled-back'].includes(finished.result?.phase), 'completion_revoked_job_not_refused');
  requireControl(evidenceDigest((await generations.current(project))?.payload.effective ?? null) === effectiveBefore, 'completion_revoked_effective_state_changed');
  const newAuthority = await generations.extensions.access.project(collaborator, project.id, { manage: true });
  return { caseId: 'SAAS-05', scope: 'actual-queued-generation-member-removal-regrant', actual: { jobId: queued.id, studyId: study.id,
    memberEpochBeforeDigest: digest(before.epoch), memberEpochAfterDigest: digest(fresh.epoch), removedCode, epochCode,
    jobStatus: finished.status, resultPhase: finished.result?.phase ?? null, effectiveUnchanged: true, freshManageAllowed: newAuthority.userId === project.userId,
    artifactDigest: state.descriptor.artifactDigest },
    expected: 'The actual queued descriptor job cannot reuse an old membership incarnation after removal/regrant; effective state remains unchanged.' };
}

/** SAAS-05 running: the journey supplies an actual native job currently running
 * under a collaborating installer. Replayed controller invocation is the exact
 * persisted attempt; it must refuse BEFORE a second process can start.
 * Revoked members remain revoked; cleanup always attempts physical cancellation.
 */
export async function runRunningMembershipRevocation({ app, state, fixture, owner, installer, jobId, completedJobId, signal }) {
  await assertCompletionFixture({ app, state });
  const user = await actualActor(app, owner), collaborator = await actualActor(app, installer);
  const { study, project } = await studyContext(app, fixture.studyId, fixture.projectId, user);
  const operations = app.hostedExtensions.operations, job = await operations.jobs.get(project.userId, id(jobId));
  requireControl(job?.kind === 'extension-execute' && job.status === 'running' && job.projectId === project.id
    && job.payload.dispatch && Date.parse(job.leaseExpiresAt) > Date.now(), 'completion_actual_running_attempt_required');
  const { binding } = await currentPin(app, state, project, job.payload.scope);
  const before = await app.vcr.dataStore.membershipAuthority(study.id, collaborator.id);
  requireControl(binding.actorId === collaborator.id && binding.actorMembershipEpoch === before.epoch
    && before.roles.includes('lead'), 'completion_running_installer_epoch_mismatch');
  const completedBefore = await captureCompletedOutput({ app, state, owner, projectId: project.id, jobId: completedJobId });
  const admittedBefore = await operations.resolve(job.payload.auth, job.payload.scope.descriptorId, job.payload.request);
  requireControl(canonicalJson(admittedBefore.scope) === canonicalJson(job.payload.scope), 'completion_running_original_authority_mismatch');
  const activeBefore = await operations.controller.executionStatus(job.payload.dispatch);
  requireControl(activeBefore.state === 'active' && activeBefore.joined === false && activeBefore.physicallyAbsent === false
    && canonicalJson(activeBefore.identity) === canonicalJson(job.payload.dispatch), 'completion_controller_attempt_not_active');
  let failure = null, observation;
  try {
    await app.vcr.members.remove({ actor: user.id, studyId: study.id, userId: collaborator.id, role: 'lead' });
    const statusCode = await refused(() => operations.status(job.payload.auth, job.id));
    const controllerCode = await refused(() => operations.controller.execute({ descriptorId: job.payload.scope.descriptorId,
      operationId: job.payload.operationId, request: job.payload.request, identity: job.payload.dispatch },
    { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }));
    observation = { caseId: 'SAAS-05', scope: 'actual-running-native-attempt-installer-membership-revocation',
      expected: 'A new controller attempt and hydration refuse revoked installer authority while previously permitted output remains whole.',
      actual: { jobId: job.id, studyId: study.id, installerId: collaborator.id, originalCallerId: job.payload.scope.userId,
        membershipEpochDigest: digest(before.epoch), statusCode, controllerCode, artifactDigest: state.descriptor.artifactDigest,
        controllerStateBefore: activeBefore.state } };
  } catch (error) { failure = error; }
  let cleanupFailure = null;
  try {
    const ack = await operations.controller.cancelExecution(job.payload.dispatch);
    requireControl(operations.joined(ack, job.payload.dispatch), 'completion_revoked_process_join_unconfirmed');
    const current = await operations.jobs.get(project.userId, job.id);
    if (current?.status === 'running' && current.leaseToken === job.leaseToken) {
      await operations.jobs.fail(project.userId, job.id, job.leaseToken, { code: 'extension_access_denied', message: 'Study installer permission was revoked.' }, { retry: false });
      await operations.grants.remove(job.payload.operationId);
    }
  } catch (cleanupError) { cleanupFailure = cleanupError; }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], 'completion_running_cleanup_failed', { cause: failure });
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  const completedAfter = await captureCompletedOutput({ app, state, owner, projectId: project.id, jobId: completedJobId });
  requireControl(canonicalJson(completedBefore) === canonicalJson(completedAfter), 'completion_prior_output_not_retained');
  observation.actual.physicallyJoined = true;
  observation.actual.retainedCompletedOutput = completedAfter;
  return observation;
}

/** File/byte limits are shared across roots, not reset for each subtree. Values
 * never leave this scanner; matches expose relative names and content digests.
 */
export async function scanBoundedCanaryFiles({ root, roots, canary, maxFiles = 20000, maxBytes = 128 * 1024 * 1024, maxEntries = 20000, maxDepth = 64 }) {
  requireControl(typeof canary === 'string' && Buffer.byteLength(canary) >= 16 && Buffer.byteLength(canary) <= 256, 'completion_canary_refused');
  requireControl(Number.isSafeInteger(maxFiles) && maxFiles > 0 && maxFiles <= 20000
    && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 256 * 1024 * 1024
    && Number.isSafeInteger(maxEntries) && maxEntries > 0 && maxEntries <= 20000
    && Number.isSafeInteger(maxDepth) && maxDepth > 0 && maxDepth <= 128, 'completion_scan_limit_refused');
  const canonical = await fs.realpath(root);
  requireControl(canonical === root && Array.isArray(roots) && roots.length > 0 && roots.length <= 32, 'completion_scan_root_refused');
  const needle = Buffer.from(canary), visited = new Set(), matches = [], skippedSymlinks = [];
  let files = 0, bytes = 0, entries = 0;
  const walk = async name => {
    requireControl(name === root || name.startsWith(root + path.sep), 'completion_scan_scope_refused');
    if (visited.has(name)) return;
    const depth = path.relative(root, name).split(path.sep).filter(Boolean).length;
    requireControl(depth <= maxDepth && ++entries <= maxEntries, 'completion_scan_unbounded');
    visited.add(name);
    const stat = await fs.lstat(name);
    if (stat.isSymbolicLink()) { skippedSymlinks.push(path.relative(root, name)); return; }
    if (stat.isDirectory()) {
      const directory = await openScopedDirectoryNoFollow(root, name);
      try {
        // Streaming inventory does not allocate an unbounded readdir array
        // before the entry budget can refuse a directory full of empty names.
        for await (const entry of await fs.opendir(directory.path, { bufferSize: 8 })) await walk(path.join(name, entry.name));
      } finally { await directory.handle.close(); }
      return;
    }
    if (!stat.isFile()) return;
    requireControl(++files <= maxFiles && bytes + stat.size <= maxBytes, 'completion_scan_unbounded');
    const opened = await openScopedFileNoFollow(root, name);
    let content; try {
      requireControl(bytes + opened.stat.size <= maxBytes, 'completion_scan_unbounded');
      content = await readStableFileHandle(opened.handle, opened.stat);
    } finally { await opened.handle.close(); }
    bytes += content.length;
    requireControl(bytes <= maxBytes, 'completion_scan_unbounded');
    if (content.includes(needle)) matches.push({ path: path.relative(root, name), contentDigest: digest(content) });
  };
  for (const selected of roots) { requireControl(typeof selected === 'string' && path.isAbsolute(selected), 'completion_scan_scope_refused'); await walk(path.resolve(selected)); }
  return { files, bytes, entries, matches, skippedSymlinks, scannedRoots: roots.map(name => path.relative(root, name)) };
}

/** SAAS-06 scan actual caller-selected writable library/cache and captured log
 * files in the owned campaign root. No host-global log or secret directory read.
 * Symlink targets and missing log surfaces remain explicit coverage gaps.
 */
export async function runCanaryScan({ app, state, canary, roots }) {
  await assertCompletionFixture({ app, state });
  const protectedRoots = [state.admission?.root, state.qualificationRoot, app.config.extensionQualificationRoot].filter(value => typeof value === 'string');
  requireControl(Array.isArray(roots) && roots.every(selected => typeof selected === 'string'
    && path.resolve(selected) !== state.root && !/\.(?:key|env)$/.test(path.basename(selected))
    && protectedRoots.every(protectedRoot => {
      const target = path.resolve(selected), protectedPath = path.resolve(protectedRoot);
      return target !== protectedPath && !target.startsWith(protectedPath + path.sep) && !protectedPath.startsWith(target + path.sep);
    })), 'completion_secret_material_scan_refused');
  const scan = await scanBoundedCanaryFiles({ root: state.root, roots, canary });
  requireControl(scan.matches.length === 0, 'completion_plaintext_canary_found');
  return { caseId: 'SAAS-06', scope: 'actual-bounded-owned-library-cache-log-canary-scan', actual: { ...scan,
    canaryDigest: digest(canary), coverageRemaining: scan.skippedSymlinks.length ? ['Immutable symlink targets require their independent image/projection inventory bond.'] : [] } };
}

/** Pure summarizer, NOT a measured control. Its live caller hydrates native run
 * records and all usage rows from PostgreSQL plus authenticated public reads.
 */
export function summarizeAttributedUsage(rows, scopes) {
  requireControl(Array.isArray(rows) && rows.length > 0 && rows.length <= 256 && Array.isArray(scopes) && scopes.length === 2
    && new Set(scopes.map(scope => scope.userId)).size === 2, 'completion_two_usage_actors_required');
  requireControl(new Set(rows.map(row => row.id)).size === rows.length, 'completion_duplicate_usage_request');
  const result = [];
  for (const scope of scopes) {
    const owned = rows.filter(row => scope.runKeys.includes(row.run_id));
    requireControl(owned.length > 0 && owned.every(row => row.user_id === scope.userId && row.project_id === scope.projectId
      && row.status === 'settled' && typeof row.request_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.request_fingerprint)
      && row.settled_at && Number(row.revision) >= 1), 'completion_usage_scope_mismatch');
    result.push({ userId: scope.userId, projectId: scope.projectId, runId: scope.runId, requests: owned.length,
      requestIds: owned.map(row => row.id), providerIdDigests: owned.map(row => evidenceDigest(row.provider_request_id)),
      usageRowsDigest: evidenceDigest(owned), measuredThrough: 'controlled-model-gateway' });
  }
  requireControl(result.reduce((sum, item) => sum + item.requests, 0) === rows.length, 'completion_usage_extra_scope');
  return result;
}

/** SAAS-14: ONLY real native runs with settled model-gateway reservations are
 * accepted. Does not manufacture reserve/settle calls or provider usage counts.
 */
export async function runUsageAttribution({ app, state, baseUrl, runs, signal }) {
  await assertCompletionFixture({ app, state });
  requireControl(Array.isArray(runs) && runs.length === 2, 'completion_two_usage_actors_required');
  const scopes = [], requests = [];
  for (const ref of runs) {
    const user = await actualActor(app, ref.actor), project = await app.store.requireProject(user, id(ref.projectId));
    const run = (await app.agentRuns.list(project)).find(item => item.id === id(ref.runId));
    requireControl(run, 'completion_actual_native_run_required');
    scopes.push({ userId: user.id, projectId: project.id, runId: run.id, runKeys: runUsageKeys(run) });
    requests.push((await request(baseUrl, ref.actor, `/api/runs/${run.id}/usage`, { signal, projectId: project.id })).receipt);
  }
  const keys = scopes.flatMap(scope => scope.runKeys);
  requireControl(keys.length > 0 && keys.length <= 128 && new Set(keys).size === keys.length, 'completion_usage_run_collision');
  const rows = (await app.store.database.query(`SELECT id,user_id,project_id,run_id,status,revision,request_fingerprint,provider_request_id,settled_at
    FROM evimed_usage.model_requests WHERE run_id=ANY($1::text[]) ORDER BY id LIMIT 257`, [keys])).rows;
  const attributed = summarizeAttributedUsage(rows, scopes);
  for (let index = 0; index < 2; index++) {
    const foreign = runs[1 - index];
    const denied = await request(baseUrl, foreign.actor, `/api/runs/${scopes[index].runId}/usage`,
      { signal, projectId: foreign.projectId, expected: [403, 404] });
    requireControl(['agent_run_not_found', 'project_not_found'].includes(denied.receipt.code), 'completion_foreign_usage_refusal_mismatch');
    requests.push(denied.receipt);
  }
  return { caseId: 'SAAS-14', scope: 'actual-native-two-account-request-id-usage-attribution', actual: { attributed, requests,
    scopeDigest: evidenceDigest(scopes), artifactDigest: state.descriptor.artifactDigest,
    furtherControlsRequired: ['Actual retry/deduplication, rolling cap and cancellation are separate native journey controls.'] },
    expected: 'Both actual native runs have settled requests under their original account/project; foreign usage reads are refused.' };
}
