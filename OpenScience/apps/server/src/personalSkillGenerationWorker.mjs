import { randomUUID } from 'node:crypto'
import { migrateProductStore } from './productPersistence.mjs'
import { HttpError } from './security.mjs'

/** Applies personal text/resources at the same exclusive project boundary as plugins.
 * No package manager, live edit, skill injection or second registry exists here. */
export class PersonalSkillGenerationWorker {
  /** @param {{service:any,runtime:any,resolveProject:(job:any)=>Promise<any>,ledgerBusy:(project:any)=>Promise<boolean>,pollMs?:number,leaseMs?:number}} options */
  constructor({ service, runtime, resolveProject, ledgerBusy, pollMs = 1000, leaseMs = 300000 }) {
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
  /** @param {any} job */
  defer(job) {
    return this.jobs.withLease(job.userId, job.id, job.leaseToken, client => client.query(`UPDATE evimed_product.jobs SET status='queued',
      attempts=GREATEST(0,attempts-1),lease_token=NULL,lease_expires_at=NULL,run_after=clock_timestamp()+interval '5 seconds' WHERE id=$1`, [job.id]))
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
          if (!candidate || (candidate.reference?.generationHash ?? null) !== job.payload.generationHash || candidate.selectionRevision !== job.payload.selectionRevision) {
            return this.jobs.finish(job.userId, job.id, job.leaseToken, { superseded: true })
          }
          const guard = async () => {
            if (lost || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) throw new HttpError(409, 'product_job_lease_lost', 'Generation ownership expired.')
            const latest = await this.service.current(project)
            const user = await this.service.resolveUser(project)
            const selected = await this.service.skills.projectSelections(user, project)
            if ((latest?.payload.desired?.reference?.generationHash ?? null) !== (candidate.reference?.generationHash ?? null) || selected.revision !== candidate.selectionRevision) {
              throw new HttpError(409, 'product_revision_conflict', 'Project skills changed.')
            }
            const liveScope = await this.service.plugins.scope(job.userId, project, client)
            if (liveScope.accountCreatedAt !== scope.accountCreatedAt || liveScope.projectCreatedAt !== scope.projectCreatedAt) throw new HttpError(409, 'plugin_generation_changed', 'Project ownership changed.')
          }
          await guard()
          if (!this.runtime.runtimeGeneration(project) || await this.service.plugins.hasPendingPrompts(project)
            || await this.ledgerBusy(project) || await this.runtime.pluginRuntimeBusy(project)) return this.defer(job)
          if (!candidate.reference) {
            const prepared = await this.service.reconcile(await this.service.resolveUser(project), project)
            if (!prepared.reference) {
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
          const captured = this.runtime.runtimePersonalSkillGeneration(project) ?? current.payload.effective ?? current.payload.lastGood ?? null
          const previous = captured && (captured.pins ?? []).every(pin => candidate.pins.some(wanted =>
            wanted.skillId === pin.skillId && wanted.revision === pin.revision && wanted.digest === pin.digest)) ? captured : null
          try {
            if (this.runtime.runtimePersonalSkillGeneration(project)?.reference?.generationHash !== candidate.reference.generationHash) {
              await this.runtime.replacePersonalSkillRuntime(project, candidate)
            }
            await guard()
            const proof = await this.runtime.probePersonalSkillGeneration(project, candidate)
            if (proof.pendingSession) return this.defer(job)
            await guard()
            return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { phase: 'effective', generationHash: candidate.reference.generationHash },
              c => this.service.markEffective(project, candidate, proof.generation, c))
          } catch (error) {
            await guard()
            // Restore the exact prior immutable bytes, or the ordinary built-in
            // baseline. A failure of optional personal methods never stops it.
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
            const latest = await this.service.current(project)
            await this.service.documents.put(job.userId, 'extension-generation', latest.id, { ...latest.payload,
              effective: restored, phase: restored ? 'rolled-back' : 'failed', error: 'personal_skill_apply_failed' },
            { expectedRevision: latest.revision, projectId: project.id, transactionClient: client })
            return this.jobs.finish(job.userId, job.id, job.leaseToken, { phase: restored ? 'rolled-back' : 'failed', error: 'personal_skill_apply_failed' })
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
