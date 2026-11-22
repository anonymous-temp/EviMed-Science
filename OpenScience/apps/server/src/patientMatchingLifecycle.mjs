/** Deployment-owned native code, applied only by the existing exclusive idle-runtime fence.
 * HTTP adapters authorize through `access`; they cannot provide release bytes or runtime descriptors.
 * `reconcile(user, projectId, {action, releaseId?, expectedRevision})` queues preparation/apply.
 * RuntimeManager reads `selectForRuntime(project)` at creation; the host gateway uses `resolveTool(project,name)`.
 */
import { canonicalJson } from '@evimed/domain';
import { randomUUID } from 'node:crypto';
import { ProductDocuments, ProductJobs } from './productStore.mjs';
import { migrateProductStore, productInteger } from './productPersistence.mjs';
import { HttpError } from './security.mjs';
import { patientMatchingCatalogue, preparePatientMatchingGeneration, verifyPatientMatchingGeneration, PATIENT_MATCHING_TOOLS } from './patientMatchingLifecycleArtifacts.mjs';

export const PATIENT_MATCHING_LIFECYCLE_JOB = 'patient-matching-lifecycle-apply';
const KIND = 'patient-matching-lifecycle';
/** What the project's state keeps of a generation: everything but its file list. A full manifest names every file of the bundle
 * (about 136 KB for 804 files), and the state carried two of them on success (`effective` and `lastGood`), past the 256 KiB a
 * product record may be (2026-11-10, the first production install that loaded). The files stay in the generation's own manifest
 * on disk and in its generation record; whoever mounts or restores a generation reads that, verified.
 * @param {any} manifest */
const statePointer = manifest => { if (!manifest) return null; const { files: _files, ...pointer } = manifest; return pointer; };
const stateId = project => `patient-matching:state:${project.id}`;
const unavailable = () => new HttpError(503, 'patient_matching_unavailable', 'Patient matching is temporarily unavailable.');
const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

const REFRESH_ATTEMPTS = 3;
const refreshDelay = attempt => 30_000 * 2 ** (attempt - 1);
const lockState = (client, project) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
  [`patient-matching-state:${project.userId}:${project.id}`]);
async function tryProjectLock(client, project) {
  const { rows } = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
    [`plugin-project:${project.userId}:${project.id}`]);
  return rows[0]?.acquired === true;
}
function ownsState(job, state) {
  return job.payload.action === 'refresh' ? state?.payload.refresh?.jobId === job.id : state?.revision === job.payload.stateRevision;
}

export class PatientMatchingLifecycleService {
  /** `catalogue` is read from deployment configuration, never a request or product document.
   * @param {any} database @param {{config:any,catalogue:any[],access:any,runtime:any,plugins:any,ledgerBusy:any,workerImageIdentity:()=>Promise<string>}} options */
  constructor(database, { config, catalogue, access, runtime, plugins, ledgerBusy, workerImageIdentity }) {
    this.database = database; this.config = config; this.catalogue = patientMatchingCatalogue(catalogue);
    this.access = access; this.runtime = runtime; this.plugins = plugins; this.ledgerBusy = ledgerBusy; this.workerImageIdentity = workerImageIdentity;
    this.documents = new ProductDocuments(database); this.jobs = new ProductJobs(database);
    // The release a project gets when its owner never chose (owner, 2026-10-10: every 虚拟临床研究 feature takes effect by default):
    // `OPEN_SCIENCE_PATIENT_MATCHING_DEFAULT_RELEASE` names one, `none` turns the default off, and unset is the catalogue's only release.
    const named = String(config?.patientMatchingDefaultRelease ?? '').trim();
    this.defaultReleaseId = named === 'none' ? null : named || (this.catalogue.size === 1 ? [...this.catalogue.keys()][0] : null);
  }
  /** The default release reaches a project whose owner never chose (no settings document at all): queued as the owner's install and
   * applied by the worker at the project's next idle moment, through the same preparation, proof and rollback as a chosen one. An
   * owner's disable or uninstall is a document, so it stands; an internal project gets nothing. Answers whether an install was queued.
   * @param {any} project @param {{ internal?: (project:any) => boolean }} [options] */
  async ensureDefault(project, { internal = () => false } = {}) {
    const releaseId = this.defaultReleaseId;
    if (!releaseId || !this.catalogue.has(releaseId) || !project?.id || !project?.userId || internal(project)) return false;
    if (await this.current(project)) return false;
    try {
      await this.reconcile({ id: project.userId }, project.id, { action: 'install', releaseId, expectedRevision: 0 });
      return true;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'product_revision_conflict') return false;
      throw error;
    }
  }
  /** @param {any} project */
  current(project) { return this.documents.get(project.userId, KIND, stateId(project)); }
  /** Owner/project incarnation is authoritative even when a previously authorized actor is removed.
   * @param {any} project @param {any} client */
  async scope(project, client) {
    // Outside a transaction (a runtime's start, the gateway's tool proof) the pool answers the one read; the first production tool
    // call (2026-11-10) passed none, and the read threw on `client.query`.
    const owner = await this.plugins.scope(project.userId, project, client ?? this.database);
    return { ownerId: project.userId, projectId: project.id, ownerAccountCreatedAt: owner.accountCreatedAt, projectCreatedAt: owner.projectCreatedAt };
  }
  /** @param {any} user @param {string} projectId @param {any} input */
  async reconcile(user, projectId, input) {
    if (!input || Object.keys(input).some(key => !['action', 'releaseId', 'expectedRevision'].includes(key))
      || !['install', 'enable', 'disable', 'uninstall', 'rollback'].includes(input.action)) throw new HttpError(400, 'patient_matching_action_invalid', 'Invalid patient matching action.');
    productInteger(input.expectedRevision, 0, 2147483646);
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const project = await this.access(user, projectId, { manage: true, client }), scope = await this.scope(project, client);
      await lockState(client, project);
      const prior = await this.current(project);
      if ((prior?.revision ?? 0) !== input.expectedRevision) throw new HttpError(409, 'product_revision_conflict', 'Patient matching settings changed.');
      let selected = prior?.payload.selected ?? null;
      if (['install', 'enable'].includes(input.action)) {
        const releaseId = input.releaseId ?? selected?.releaseId;
        if (!this.catalogue.has(releaseId)) throw new HttpError(400, 'patient_matching_release_unavailable', 'The patient matching release is unavailable.');
        selected = { releaseId, enabled: true };
      } else if (input.action === 'disable') selected = selected ? { ...selected, enabled: false } : null;
      else if (input.action === 'uninstall') selected = null;
      else {
        const lastGood = prior?.payload.lastGood;
        if (!lastGood || !this.catalogue.has(lastGood.release.releaseId)) throw unavailable();
        selected = { releaseId: lastGood.release.releaseId, enabled: true };
      }
      const row = await this.documents.put(project.userId, KIND, stateId(project), { scope, selected, effective: prior?.payload.effective ?? null,
        lastGood: prior?.payload.lastGood ?? null, runtimeGeneration: prior?.payload.runtimeGeneration ?? null, phase: 'waiting',
        actorId: user.id, actorMembershipEpoch: project.extensionMembershipEpoch ?? null },
      { expectedRevision: prior?.revision ?? 0, projectId, transactionClient: client });
      await this.jobs.enqueue(project.userId, PATIENT_MATCHING_LIFECYCLE_JOB, { stateRevision: row.revision, scope, actorId: user.id, actorMembershipEpoch: project.extensionMembershipEpoch ?? null, action: input.action },
        { idempotencyKey: `patient-matching-apply:${project.id}:${row.revision}`, projectId, maxAttempts: 10, transactionClient: client });
      return row;
    }));
  }
  refreshReason(payload, imageId) {
    if (!imageId || !payload?.selected?.enabled) return null;
    if (!this.catalogue.has(payload.selected.releaseId)) {
      return this.catalogue.has(this.defaultReleaseId) ? 'patient_matching_release_unavailable' : null;
    }
    if (payload.phase === 'waiting' || (!payload.refresh && !payload.effective)) return null;
    const boundImage = payload.refresh?.imageId ?? payload.effective?.runtimeImageDigest;
    return boundImage !== imageId ? 'patient_matching_runtime_image_changed' : null;
  }
  /** Recheck the owner's choice and the deployment default under the HTTP action lock.
   * The selection, its refresh job and the job pointer commit together. */
  async queueRefresh(project, revision, imageId) {
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const ownedProject = await this.access({ id: project.userId }, project.id, { manage: true, client });
      if (ownedProject.userId !== project.userId) return;
      const scope = await this.scope(ownedProject, client);
      await lockState(client, ownedProject);
      const state = await this.current(ownedProject);
      if (!state || state.revision !== revision || !same(scope, state.payload.scope)) return;
      const reason = this.refreshReason(state.payload, imageId);
      if (!reason) return;
      const selected = reason === 'patient_matching_release_unavailable'
        ? { ...state.payload.selected, releaseId: this.defaultReleaseId, upgradedFrom: state.payload.selected.releaseId }
        : state.payload.selected;
      const job = await this.jobs.enqueue(ownedProject.userId, PATIENT_MATCHING_LIFECYCLE_JOB, {
        action: 'refresh', scope, actorId: ownedProject.userId, actorMembershipEpoch: ownedProject.extensionMembershipEpoch ?? null,
      }, { projectId: ownedProject.id, idempotencyKey: `patient-matching-apply:${ownedProject.id}:${revision + 1}`, maxAttempts: REFRESH_ATTEMPTS, transactionClient: client });
      await this.documents.put(ownedProject.userId, KIND, state.id, { ...state.payload, selected, phase: 'refreshing', failure: null, refresh: { imageId, jobId: job.id, reason } },
        { expectedRevision: revision, projectId: ownedProject.id, transactionClient: client });
    }));
  }

  /** A keyset walk over saved choices, including opt-ins on internal projects. Two concurrent admissions,
   * one ordinary lifecycle worker for the expensive preparation and runtime replacement. */
  async refreshAfterStartup() {
    if (!this.catalogue.size) return;
    await migrateProductStore(this.database);
    const imageId = (await this.runtime.inspectRuntimeImage())?.imageId;
    if (!imageId) return;
    let user = '', id = '', firstError = null;
    for (;;) {
      const { rows } = await this.database.query(`SELECT user_id,id,project_id,revision,payload FROM evimed_product.documents
        WHERE kind=$1 AND deleted_at IS NULL AND id='patient-matching:state:' || project_id
          AND payload @> '{"selected":{"enabled":true}}' AND (user_id,id)>($2,$3)
        ORDER BY user_id,id LIMIT 32`, [KIND, user, id]);
      if (!rows.length) break;
      const stale = rows.filter(row => this.refreshReason(row.payload, imageId));
      for (let index = 0; index < stale.length; index += 2) {
        const results = await Promise.allSettled(stale.slice(index, index + 2).map(row =>
          this.queueRefresh({ userId: row.user_id, id: row.project_id }, row.revision, imageId)));
        for (const result of results) if (result.status === 'rejected') firstError ??= result.reason;
      }
      ({ user_id: user, id } = rows.at(-1));
    }
    if (firstError) throw firstError;
  }

  /** GET is observational, including before the startup sweep or while an owner action is pending. */
  async status(project) {
    const row = await this.current(project);
    if (!row) return null;
    const { payload } = row;
    let { effective, phase, failure } = payload;
    let reason = null;
    const withdrawn = payload.selected?.enabled && !this.catalogue.has(payload.selected.releaseId);
    if (withdrawn) {
      effective = null;
      reason = 'patient_matching_release_unavailable';
      if (this.catalogue.has(this.defaultReleaseId)) { phase = 'stale'; failure = null; }
      else { phase = 'refresh-failed'; failure = reason; }
    } else if (effective || payload.refresh) {
      const image = await this.runtime.inspectRuntimeImage().catch(() => null);
      if (!image?.imageId || effective?.runtimeImageDigest !== image.imageId || (effective && !this.catalogue.has(effective.release.releaseId))) effective = null;
      reason = this.refreshReason(payload, image?.imageId);
      if (reason) { phase = 'stale'; failure = null; }
      // The final lease can expire in a process crash before the worker can publish its failure.
      if (payload.refresh && ['refreshing', 'retrying'].includes(phase)) {
        const job = await this.jobs.get(project.userId, payload.refresh.jobId);
        if (job?.status === 'failed') { phase = 'refresh-failed'; failure = job.error?.code ?? 'patient_matching_apply_failed'; }
      }
    }
    if (phase === 'effective' && !effective) phase = 'unconfirmed';
    if (phase === 'refreshing') reason = payload.refresh?.reason ?? 'patient_matching_runtime_image_changed';
    if (phase === 'unconfirmed') reason = 'patient_matching_generation_unavailable';
    reason ??= failure ?? null;
    return { ...row, payload: { ...payload, effective, phase, failure, reason } };
  }

  /** New runtimes mount only a previously proven selection. A broken optional release keeps general work available.
   * An explicit disable/remove is effective on the next runtime; an active turn retains its captured generation.
   * @param {any} project */
  async selectForRuntime(project) {
    const state = await this.current(project), manifest = state?.payload.effective;
    if (!state?.payload.selected?.enabled) return null;
    try {
      const imageId = (await this.runtime.inspectRuntimeImage())?.imageId;
      if (this.refreshReason(state.payload, imageId)) {
        await this.queueRefresh(project, state.revision, imageId);
        return null;
      }
      if (!imageId || !manifest || manifest.runtimeImageDigest !== imageId || state.payload.selected.releaseId !== manifest.release.releaseId) return null;
      const entry = this.catalogue.get(manifest.release.releaseId), { artifactPath: _path, ...release } = entry ?? {};
      if (!entry || !same(release, manifest.release) || !same(await this.scope(project), manifest.scope) || await this.workerImageIdentity() !== entry.workerImageDigest) return null;
      return await verifyPatientMatchingGeneration(this.config, project, manifest.reference);
    } catch { return null; }
  }
  /** Used only by the first-party gateway after workload authentication. The body cannot supply a descriptor.
   * A pending disable leaves the already-running turn's generation usable until the idle apply fence.
   * @param {any} project @param {string} name */
  async resolveTool(project, name) {
    if (!PATIENT_MATCHING_TOOLS.includes(name)) return null;
    const state = await this.current(project), manifest = state?.payload.effective;
    const runtimeGeneration = this.runtime.runtimeGeneration(project), current = this.runtime.currentPatientMatchingGeneration(project);
    if (!manifest || !runtimeGeneration || !same(current?.reference, manifest.reference)
      || !same(await this.scope(project), manifest.scope)) return null;
    const entry = this.catalogue.get(manifest.release.releaseId), { artifactPath: _path, ...release } = entry ?? {};
    if (!entry || !same(release, manifest.release) || await this.workerImageIdentity() !== entry.workerImageDigest) return null;
    // RuntimeManager exposed this reference only after byte, mount and native registry proof at boot.
    // No package install/HMR is allowed in that runtime; a fresh epoch is checked again.
    if (this.runtime.runtimeGeneration(project) !== runtimeGeneration) return null;
    return { pluginId: 'patient-matching', name, generation: manifest.reference.generationHash };
  }
}

/** A separate leased kind, the same project lock used by every native prompt admission and extension apply.
 * Preparation is done here, never by an HTTP handler or serving runtime package manager. */
export class PatientMatchingLifecycleWorker {
  /** @param {{service:PatientMatchingLifecycleService,workerId?:string,leaseMs?:number,pollMs?:number}} options */
  constructor({ service, workerId = `patient-matching-lifecycle-${randomUUID()}`, leaseMs = 300000, pollMs = 1000 }) {
    this.service = service; this.database = service.database; this.jobs = service.jobs; this.runtime = service.runtime;
    this.workerId = workerId; this.leaseMs = leaseMs; this.pollMs = pollMs;
    this.running = null; this.timer = null; this.lastError = null; this.scanDue = Infinity; this.scanAttempts = 0;
  }
  start() {
    if (this.timer) return;
    this.scanDue = 0; this.scanAttempts = 0;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs); this.timer.unref(); void this.tick();
  }
  async close() { clearInterval(this.timer); this.timer = null; await this.running; }
  async tick() {
    if (this.running) return this.running;
    this.running = this.run().catch(error => { this.lastError = error?.code ?? 'patient_matching_apply_failed'; return null; }).finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    if (Date.now() >= this.scanDue) {
      this.scanDue = Infinity;
      try { await this.service.refreshAfterStartup(); }
      catch (error) {
        this.lastError = error.code ?? 'patient_matching_apply_failed';
        process.stderr.write(`patient matching: startup refresh ${this.lastError}\n`);
        if (++this.scanAttempts < REFRESH_ATTEMPTS) this.scanDue = Date.now() + refreshDelay(this.scanAttempts);
      }
    }
    const job = await this.jobs.claim([PATIENT_MATCHING_LIFECYCLE_JOB], this.workerId, { leaseMs: this.leaseMs });
    return job ? this.runClaimed(job) : null;
  }
  async busy(project, { ignoreStopping = false } = {}) {
    const values = await Promise.all([this.runtime.pluginRuntimeBusy(project, { ignoreStopping }),
      this.service.ledgerBusy(project), this.service.plugins.hasPendingPrompts(project)]);
    return values.some(value => value !== false);
  }

  /** The outcome has committed. Reacquire the admission fence and check activity again inside the stop. */
  async releaseProofRuntime(project, generation) {
    await this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      if (!await tryProjectLock(client, project)) return;
      const idle = async (ignoreStopping = false) => {
        if (this.runtime.runtimeGeneration(project) !== generation || await this.runtime.idleVerdict(project) !== 'idle'
          || await this.busy(project, { ignoreStopping })) return false;
        return this.runtime.activeProxyCountForProject(project) === 0 && this.runtime.runtimeGeneration(project) === generation;
      };
      if (await idle()) await this.runtime.stopIdleRuntime(project, { event: 'patient_matching_proof_finished', guard: () => idle(true) });
    }));
  }
  /** @param {any} job */
  async runClaimed(job) {
    if (job.kind !== PATIENT_MATCHING_LIFECYCLE_JOB) throw unavailable();
    let proofProject = null, proofGeneration = null;
    let lost = false, renewal = Promise.resolve();
    const renew = async () => { if (lost || !await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)) { lost = true; throw new HttpError(409, 'product_job_lease_lost', 'Apply ownership changed.'); } };
    const timer = setInterval(() => { renewal = renewal.then(renew).catch(() => { lost = true; }); }, Math.floor(this.leaseMs / 3)); timer.unref();
    const defer = () => this.jobs.fail(job.userId, job.id, job.leaseToken, { code: 'plugin_runtime_busy', message: 'Waiting for current work to finish.' }, { retry: true, refundAttempt: true });
    try {
      return await this.database.transaction(client => this.database.withTransactionClient(client, async () => {
        if (!await tryProjectLock(client, { userId: job.userId, id: job.projectId })) return defer();
        const project = await this.service.access({ id: job.payload.actorId }, job.projectId, { manage: true, client });
        if (project.userId !== job.userId || !same(await this.service.scope(project, client), job.payload.scope)
          || (project.extensionMembershipEpoch ?? null) !== job.payload.actorMembershipEpoch) throw unavailable();
        const state = await this.service.current(project);
        if (!ownsState(job, state)) return this.jobs.finish(job.userId, job.id, job.leaseToken, { superseded: true });
        if (!this.runtime.runtimeGeneration(project)) proofProject = project;
        const replace = async candidate => {
          // A runtime already there, including one started during preparation, belongs to its caller.
          const result = await this.runtime.replacePatientMatchingGeneration(project, candidate);
          if (!result.runtimeGeneration || (result.replacedGeneration && result.replacedGeneration !== proofGeneration)) proofProject = null;
          proofGeneration = result.runtimeGeneration;
        };
        if (await this.busy(project)) return defer();
        const selected = state.payload.selected, previous = state.payload.effective;
        let candidate = null;
        if (selected?.enabled) {
          const entry = this.service.catalogue.get(selected.releaseId);
          if (!entry) throw new HttpError(503, 'patient_matching_release_unavailable', 'The selected patient matching release is unavailable.');
          if (await this.service.workerImageIdentity() !== entry.workerImageDigest) throw new HttpError(503, 'patient_matching_worker_unavailable', 'The patient matching worker image does not match the release.');
          candidate = await preparePatientMatchingGeneration(this.service.config, project, state.payload.scope, entry, (await this.runtime.inspectRuntimeImage())?.imageId);
          const id = `patient-matching:generation:${candidate.reference.generationHash}`, existing = await this.service.documents.get(project.userId, KIND, id);
          if (existing && !same(existing.payload, candidate)) throw unavailable();
          if (!existing) await this.service.documents.put(project.userId, KIND, id, candidate, { expectedRevision: 0, projectId: project.id, transactionClient: client });
        }
        await renew(); if (await this.busy(project)) return defer();
        const guard = async () => {
          await renew();
          const authorized = await this.service.access({ id: job.payload.actorId }, job.projectId, { manage: true, client });
          if (authorized.userId !== job.userId || !same(await this.service.scope(authorized, client), job.payload.scope)
            || (authorized.extensionMembershipEpoch ?? null) !== job.payload.actorMembershipEpoch) throw unavailable();
          if ((await this.service.current(project))?.revision !== state.revision) throw new HttpError(409, 'product_revision_conflict', 'Patient matching settings changed.');
        };
        let proof, phase = selected ? selected.enabled ? 'effective' : 'disabled' : 'uninstalled', failure = null;
        try {
          await replace(candidate);
          await guard(); proof = await this.runtime.probePatientMatchingGeneration(project, candidate); await guard();
        } catch (error) {
          if (lost || error.code === 'product_job_lease_lost') throw error;
          if (job.payload.action === 'refresh' && error.code === 'plugin_runtime_busy') return defer();
          failure = error.code ?? 'patient_matching_apply_failed';
          // Restore only the exact previous admitted code; fall back to the ordinary assistant when it cannot load.
          let restore = previous;
          if (restore) {
            try {
              const admitted = this.service.catalogue.get(restore.release.releaseId), { artifactPath: _path, ...release } = admitted ?? {};
              if (!admitted || !same(release, restore.release) || await this.service.workerImageIdentity() !== admitted.workerImageDigest || (await this.runtime.inspectRuntimeImage())?.imageId !== restore.runtimeImageDigest) throw unavailable();
              restore = await verifyPatientMatchingGeneration(this.service.config, project, restore.reference);
            }
            catch { restore = null; }
          }
          try {
            await replace(restore);
            proof = await this.runtime.probePatientMatchingGeneration(project, restore);
          } catch {
            restore = null;
            await replace(null);
            proof = await this.runtime.probePatientMatchingGeneration(project, null);
          }
          await guard();
          candidate = restore; phase = 'rolled-back';
        }
        if (!proof || proof.runtimeGeneration !== this.runtime.runtimeGeneration(project) || !same(proof.reference, candidate?.reference)) throw unavailable();
        if (failure && job.payload.action === 'refresh') {
          return this.failRefresh(job, project, state, statePointer(candidate), proof.runtimeGeneration, failure, client);
        }
        return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { phase, reference: candidate?.reference ?? null, failure }, async transactionClient => {
          await guard(); await this.service.documents.put(project.userId, KIND, state.id, { ...state.payload, phase, refresh: null, effective: statePointer(candidate),
            lastGood: phase === 'effective' ? previous ?? statePointer(candidate) : state.payload.lastGood, runtimeGeneration: proof.runtimeGeneration, failure },
          { expectedRevision: state.revision, projectId: project.id, transactionClient });
        });
      }));
    } catch (error) {
      if (lost || error.code === 'product_job_lease_lost') return null;
      return await this.jobs.withLease(job.userId, job.id, job.leaseToken, client => this.database.withTransactionClient(client, async () => {
        // Only record failure against the original owner, scope and still-current job.
        const project = job.payload.action === 'refresh' ? { userId: job.userId, id: job.projectId }
          : await this.service.access({ id: job.payload.actorId }, job.projectId, { manage: true, client });
        const state = await this.service.current(project);
        if (ownsState(job, state) && same(await this.service.scope(project, client), job.payload.scope)) {
          const actual = this.runtime.currentPatientMatchingGeneration(project);
          const retained = same(actual?.reference, state.payload.effective?.reference) ? state.payload.effective : null;
          if (job.payload.action === 'refresh') {
            return this.failRefresh(job, project, state, retained, retained ? this.runtime.runtimeGeneration(project) : null,
              error.code ?? 'patient_matching_apply_failed', client);
          }
          await this.service.documents.put(project.userId, KIND, state.id, { ...state.payload, phase: 'failed', effective: retained,
            runtimeGeneration: retained ? this.runtime.runtimeGeneration(project) : null, failure: error.code ?? 'patient_matching_apply_failed' },
          { expectedRevision: state.revision, projectId: project.id, transactionClient: client });
        }
        return this.jobs.fail(job.userId, job.id, job.leaseToken, { code: error.code ?? 'patient_matching_apply_failed', message: 'Patient matching was not applied.' }, { retry: false });
      }));
    } finally {
      clearInterval(timer); await renewal;
      if (proofProject && proofGeneration) {
        try { await this.releaseProofRuntime(proofProject, proofGeneration); }
        catch (error) { process.stderr.write(`patient matching: proof runtime cleanup for ${job.projectId} (${error.code ?? 'failed'})\n`); }
      }
    }
  }
  /** Retry the same lease-backed job. A new owner decision clears its pointer and supersedes every remaining attempt. */
  async failRefresh(job, project, state, effective, runtimeGeneration, failure, client) {
    const retry = job.attempts < job.maxAttempts && failure !== 'patient_matching_release_unavailable';
    const phase = retry ? 'retrying' : 'refresh-failed';
    await this.service.documents.put(project.userId, KIND, state.id, { ...state.payload, effective, runtimeGeneration, phase, failure },
      { expectedRevision: state.revision, projectId: project.id, transactionClient: client });
    return this.jobs.fail(job.userId, job.id, job.leaseToken, { code: failure, message: 'Patient matching could not be updated.' },
      { retry, delayMs: retry ? refreshDelay(job.attempts) : 0 });
  }
}
