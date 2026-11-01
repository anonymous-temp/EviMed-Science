import { randomUUID } from 'node:crypto'
import { migrateProductStore } from './productPersistence.mjs'
import { HttpError } from './security.mjs'

/** How long a job for a project with no runtime waits before it asks again. */
export const NO_RUNTIME_RECHECK_SECONDS = 60

/** How long to wait before asking again, one wait per extra ask. A probe that follows a kernel's readiness by a second can
 * find a plugin still composing, and the answer to a failed proof is a restart the person sits through: asked again first. */
export const PROOF_RETRY_WAITS_MS = [2000, 5000]

/** Whether a generation asks the runtime for anything an ordinary start would not do: a personal skill, a platform skill or
 * integration switched off. A runtime with no such choice has nothing a proof could find wrong (nothing to prove) and nothing a
 * restart could improve; its generation hash still moves with every image, which alone must not cost anyone a restart.
 * @param {any} generation */
export function carriesNoChoice(generation) {
  return !(generation?.pins ?? []).length && !(generation?.platformSkills?.disabled ?? []).length && !(generation?.platformSkills?.disabledPlugins ?? []).length
}

/** The stable code of a failed proof, never its message. @param {any} error @returns {string} */
const proofFailureCode = error => String(error?.code ?? error?.name ?? 'unknown').slice(0, 80)

/** Applies personal text/resources at the same exclusive project boundary as plugins.
 * No package manager, live edit, skill injection or second registry exists here. */
export class PersonalSkillGenerationWorker {
  /** @param {{service:any,runtime:any,resolveProject:(job:any)=>Promise<any>,ledgerBusy:(project:any)=>Promise<boolean>,pollMs?:number,leaseMs?:number,proofRetryWaitsMs?:number[]}} options */
  constructor({ service, runtime, resolveProject, ledgerBusy, pollMs = 1000, leaseMs = 300000, proofRetryWaitsMs = PROOF_RETRY_WAITS_MS }) {
    this.proofRetryWaitsMs = proofRetryWaitsMs
    this.service = service; this.jobs = service.jobs; this.database = service.database; this.runtime = runtime
    this.resolveProject = resolveProject; this.ledgerBusy = ledgerBusy; this.pollMs = pollMs; this.leaseMs = leaseMs
    this.workerId = `personal-skill-apply-${randomUUID()}`; this.kinds = ['personal-skill-apply']
    this.timer = null; this.running = null; this.lastError = null
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { void this.tick() }, this.pollMs); this.timer.unref(); void this.tick() } }
  async close() { clearInterval(this.timer); this.timer = null; await this.running }
  async tick() {
    if (this.running) return this.running
    this.running = this.run().catch(error => { this.lastError = error.code ?? 'personal_skill_apply_failed'; return null })
      .finally(() => { this.running = null })
    return this.running
  }
  /** @param {any} job @param {number} [seconds] when to ask again */
  defer(job, seconds = 5) {
    return this.jobs.withLease(job.userId, job.id, job.leaseToken, client => client.query(`UPDATE evimed_product.jobs SET status='queued',
      attempts=GREATEST(0,attempts-1),lease_token=NULL,lease_expires_at=NULL,run_after=clock_timestamp()+($2::integer*interval '1 second') WHERE id=$1`, [job.id, seconds]))
  }
  /** The proof, asked again after a short wait before its failure can cost a restart.
   * @param {any} project @param {any} candidate @param {()=>Promise<void>} guard */
  async proveWithRetry(project, candidate, guard) {
    for (const wait of this.proofRetryWaitsMs) {
      try { return await this.runtime.probePersonalSkillGeneration(project, candidate) }
      catch { await new Promise(resolve => setTimeout(resolve, wait)); await guard() }
    }
    return this.runtime.probePersonalSkillGeneration(project, candidate)
  }
  /** A failed proof says why, here and on the job: 43 failures in a fortnight left nothing but the generic code behind them.
   * @param {any} job @param {any} error */
  reportProofFailure(job, error) {
    process.stderr.write(`personal skill proof failed: project=${job.projectId} code=${proofFailureCode(error)}\n`)
  }
  async run() {
    await migrateProductStore(this.database)
    const job = await this.jobs.claim(this.kinds, this.workerId, { leaseMs: this.leaseMs })
    if (!job) return null
    let lost = false
    try {
      return await this.database.transaction(client => this.database.withTransactionClient(client, async () => {
        // Register inside the owned transaction context: guard holds the job row
        // until apply settles, so independent pool renewal would block on itself.
        let renewing = false
        let pendingRenewal = Promise.resolve()
        const renewal = setInterval(() => {
          if (renewing) return
          renewing = true
          pendingRenewal = this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
            .then(ok => { if (!ok) lost = true }).catch(() => { lost = true })
            .finally(() => { renewing = false })
        }, Math.floor(this.leaseMs / 3))
        renewal.unref()
        try {
          const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`plugin-project:${job.userId}:${job.projectId}`])
          if (!lock.rows[0].acquired) return this.defer(job)
          const project = await this.resolveProject(job)
          const scope = await this.service.plugins.scope(job.userId, project, client)
          if (scope.accountCreatedAt !== job.payload.accountCreatedAt || scope.projectCreatedAt !== job.payload.projectCreatedAt) throw new HttpError(409, 'plugin_generation_changed', 'Project ownership changed.')
          const current = await this.service.current(project)
          const candidate = current?.payload.desired
          if (job.payload.proofRuntimeGeneration && this.runtime.runtimeGeneration(project) !== job.payload.proofRuntimeGeneration) return this.jobs.finish(job.userId, job.id, job.leaseToken, { superseded: true })
          if (!candidate || (candidate.reference?.generationHash ?? null) !== job.payload.generationHash || candidate.selectionRevision !== job.payload.selectionRevision) {
            return this.jobs.finish(job.userId, job.id, job.leaseToken, { superseded: true })
          }
          const guard = async () => {
            if (lost || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) throw new HttpError(409, 'product_job_lease_lost', 'Generation ownership expired.')
            const latest = await this.service.current(project)
            const user = await this.service.resolveUser(project)
            const selected = await this.service.skills.projectSelections(user, project, { activation: false })
            if ((latest?.payload.desired?.reference?.generationHash ?? null) !== (candidate.reference?.generationHash ?? null) || selected.revision !== candidate.selectionRevision) {
              throw new HttpError(409, 'product_revision_conflict', 'Project skills changed.')
            }
            const liveScope = await this.service.plugins.scope(job.userId, project, client)
            if (liveScope.accountCreatedAt !== scope.accountCreatedAt || liveScope.projectCreatedAt !== scope.projectCreatedAt) throw new HttpError(409, 'plugin_generation_changed', 'Project ownership changed.')
          }
          await guard()
          // A project with no runtime has nothing to apply to until it is opened, which can be days: the start
          // itself mounts the desired generation and this job then proves it. Asked every five seconds, eleven
          // unopened projects of one account were claimed about two times a second for eighteen hours (2026-10-08).
          if (!this.runtime.runtimeGeneration(project)) return this.defer(job, NO_RUNTIME_RECHECK_SECONDS)
          if (await this.service.plugins.hasPendingPrompts(project)
            || await this.ledgerBusy(project) || await this.runtime.pluginRuntimeBusy(project)) return this.defer(job)
          if (!candidate.reference) {
            const prepared = await this.service.reconcile(await this.service.resolveUser(project), project)
            if (!prepared.reference) {
              if ((prepared.platformSkills?.disabled ?? []).length || (prepared.platformSkills?.disabledPlugins ?? []).length) return this.defer(job)
              // Remove stale optional bytes at this exclusive idle boundary even
              // when their replacement image cannot currently be prepared.
              const baseline = { reference: null, pins: [], selectionRevision: candidate.selectionRevision, findings: [] }
              if ((this.runtime.runtimePersonalSkillGeneration(project)?.pins ?? []).length) await this.runtime.replacePersonalSkillRuntime(project, baseline)
              await guard()
              await this.runtime.probePersonalSkillGeneration(project, baseline)
              const latest = await this.service.current(project)
              await this.service.documents.put(job.userId, 'extension-generation', latest.id, { ...latest.payload,
                effective: null, phase: 'waiting', error: 'runtime_image_unavailable' },
              { expectedRevision: latest.revision, projectId: project.id, transactionClient: client })
              return this.defer(job)
            }
            return this.jobs.finish(job.userId, job.id, job.leaseToken, { superseded: true, generationHash: prepared.reference.generationHash })
          }
          // Nothing chosen and nothing mounted: no restart and no proof (12 days of production to 2026-10-31: every proof of an
          // account with no choice failed and restarted the runtime the person was waiting for, 7–11 s on the first open after a release).
          // A plugin composite on this runtime is still its own proof, which never decides this.
          if (carriesNoChoice(candidate) && carriesNoChoice(this.runtime.runtimePersonalSkillGeneration(project))) {
            const generation = this.runtime.runtimeGeneration(project)
            const composite = await this.runtime.provePersonalComposite?.(project).catch((/** @type {any} */ error) => { this.reportProofFailure(job, error); return null })
            await guard()
            return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { phase: 'effective', generationHash: candidate.reference.generationHash, nothingToProve: true },
              async c => {
                await this.service.markEffective(project, candidate, generation, c)
                if (composite) await this.runtime.markPersonalCompositeEffective(project, composite.candidate, composite.proof, c)
              })
          }
          const captured = this.runtime.runtimePersonalSkillGeneration(project) ?? current.payload.effective ?? current.payload.lastGood ?? null
          const previous = captured && (captured.pins ?? []).every(pin => candidate.pins.some(wanted =>
            wanted.skillId === pin.skillId && wanted.revision === pin.revision && wanted.digest === pin.digest)) ? captured : null
          try {
            if (this.runtime.runtimePersonalSkillGeneration(project)?.reference?.generationHash !== candidate.reference.generationHash) {
              await this.runtime.replacePersonalSkillRuntime(project, candidate)
            }
            await guard()
            const proof = await this.proveWithRetry(project, candidate, guard)
            if (proof.pendingSession) return this.defer(job)
            await guard()
            return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { phase: 'effective', generationHash: candidate.reference.generationHash },
              async c => {
                await this.service.markEffective(project, candidate, proof.generation, c)
                if (proof.composite) await this.runtime.markPersonalCompositeEffective(project, proof.composite.candidate, proof.composite.proof, c)
              })
          } catch (error) {
            this.reportProofFailure(job, error)
            await guard()
            // Restore the exact prior immutable bytes, or the ordinary built-in
            // baseline. A failure of optional personal methods never stops it,
            // and neither does an optional preference (a platform skill or an
            // integration switched off) that could not be proven: the project
            // keeps serving and the state says the choice is not in effect
            // (owner rulings 2026-10-10).
            const baseline = { reference: null, pins: [], selectionRevision: 0, findings: [] }
            let restored = previous
            try { await this.runtime.replacePersonalSkillRuntime(project, restored ?? baseline) }
            catch (restoreError) {
              await guard()
              if (!restored) throw restoreError
              // A formerly valid generation may depend on a retired image.
              // One bounded ordinary-baseline recovery keeps optional methods
              // from making the entire project permanently unavailable.
              await this.runtime.replacePersonalSkillRuntime(project, baseline)
              restored = null
            }
            await guard()
            let restoredProof = null
            try {
              restoredProof = await this.runtime.probePersonalSkillGeneration(project, restored ?? baseline)
              if (restoredProof.pendingSession) throw new HttpError(502, 'personal_skill_apply_failed', 'The restored skill composition could not be verified.')
              if (restoredProof.composite) await this.runtime.markPersonalCompositeEffective(project, restoredProof.composite.candidate, restoredProof.composite.proof, client)
            } catch { restored = null; restoredProof = null }
            const latest = await this.service.current(project)
            await this.service.documents.put(job.userId, 'extension-generation', latest.id, { ...latest.payload,
              effective: restored, runtimeGeneration: restoredProof?.generation ?? null, phase: restored ? 'rolled-back' : 'failed', error: 'personal_skill_apply_failed' },
            { expectedRevision: latest.revision, projectId: project.id, transactionClient: client })
            return this.jobs.finish(job.userId, job.id, job.leaseToken, { phase: restored ? 'rolled-back' : 'failed', error: 'personal_skill_apply_failed', cause: proofFailureCode(error) })
          }
        } finally {
          clearInterval(renewal)
          await pendingRenewal
        }
      }))
    } catch (error) {
      if (!lost && error.code !== 'product_job_lease_lost') await this.jobs.fail(job.userId, job.id, job.leaseToken,
        { code: error.code ?? 'personal_skill_apply_failed', message: 'Personal skill activation did not complete.' },
        { retry: !['plugin_generation_changed', 'product_revision_conflict'].includes(error.code) })
      return null
    }
  }
}
