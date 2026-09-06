import { randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
import { exportPluginPayload, projectPluginId } from "./pluginService.mjs";
import { migrateProductStore } from "./productPersistence.mjs";

/** Every startup is followed by an independent live probe, including rollback.
 * @param {any} runtime @param {any} project @param {any} candidate @param {any} previous @param {() => Promise<void>} guard */
export async function applyPluginCandidate(runtime, project, candidate, previous, guard) {
  try {
    await guard();
    await runtime.replacePluginRuntime(project, candidate);
    await guard();
    const proof = await runtime.probePlugin(project, candidate);
    await guard();
    return { phase: "effective", effective: candidate, generation: proof.generation, error: null };
  } catch {
    // Authority loss is not an apply failure. It cannot grant a stale worker a
    // second startup, nor let it shut down a newer worker's runtime.
    await guard();
    if (previous) {
      try {
        await runtime.replacePluginRuntime(project, previous);
        await guard();
        const proof = await runtime.probePlugin(project, previous);
        await guard();
        return { phase: "rolled_back", effective: previous, generation: proof.generation, error: "plugin_apply_failed" };
      } catch { await guard(); }
    }
    await guard();
    await runtime.stop(project);
    return { phase: "unavailable", effective: null, generation: null, error: "plugin_rollback_failed" };
  }
}

/** ProductJobs owns all retry/lease authority; the project lock fences admission. */
export class PluginApplyWorker {
  /** @param {{service:any,runtime:any,resolveProject:(job:any)=>Promise<any>,ledgerBusy:(project:any)=>Promise<boolean>,pollMs?:number,leaseMs?:number}} dependencies */
  constructor({ service, runtime, resolveProject, ledgerBusy, pollMs = 1000, leaseMs = 300000 }) {
    this.service = service; this.jobs = service.jobs; this.database = service.database;
    this.runtime = runtime; this.resolveProject = resolveProject; this.ledgerBusy = ledgerBusy;
    this.pollMs = pollMs; this.leaseMs = leaseMs; this.workerId = `plugin-apply-${randomUUID()}`;
    this.timer = null; this.running = null; this.lastError = null;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref(); void this.tick();
  }
  async close() { clearInterval(this.timer); this.timer = null; await this.running; }
  async tick() {
    if (this.running) return this.running;
    this.running = this.run().catch(error => { this.lastError = error?.code ?? "plugin_apply_failed"; return null; })
      .finally(() => { this.running = null; });
    return this.running;
  }
  /** @param {any} job @param {string} phase */
  async defer(job, phase = "pending") {
    return this.jobs.withLease(job.userId, job.id, job.leaseToken, async client => {
      await client.query(`UPDATE evimed_product.plugin_application_state SET phase=$4,error=NULL
        WHERE user_id=$1 AND id=$2 AND desired_revision=$3`, [job.userId, projectPluginId(job.projectId), job.payload.revision, phase]);
      // Waiting for user work or first launch is not a failed attempt.
      await client.query(`UPDATE evimed_product.jobs SET status='queued',attempts=GREATEST(0,attempts-1),
        lease_token=NULL,lease_expires_at=NULL,run_after=clock_timestamp()+interval '5 seconds' WHERE id=$1`, [job.id]);
    });
  }
  async run() {
    await migrateProductStore(this.database);
    const job = await this.jobs.claim(["plugin-apply"], this.workerId, { leaseMs: this.leaseMs });
    if (!job) return null;
    let lost = false;
    const renewal = setInterval(() => { void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
      .then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; }); }, Math.floor(this.leaseMs / 3));
    renewal.unref();
    try {
      return await this.database.transaction(async client => {
        const locked = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [`plugin-project:${job.userId}:${job.projectId}`]);
        if (!locked.rows[0].acquired) return this.defer(job);
        const project = await this.resolveProject(job);
        const scope = await this.service.scope(job.userId, project, client);
        if (scope.accountCreatedAt !== job.payload.accountCreatedAt || scope.projectCreatedAt !== job.payload.projectCreatedAt) {
          throw new HttpError(409, "plugin_generation_changed", "Project generation changed.");
        }
        const id = projectPluginId(project.id);
        const read = async () => (await client.query(`SELECT d.revision,d.payload,s.last_good FROM evimed_product.documents d
          JOIN evimed_product.plugin_application_state s ON s.user_id=d.user_id AND s.id=d.id
          WHERE d.user_id=$1 AND d.kind='plugin' AND d.id=$2 AND d.deleted_at IS NULL`, [job.userId, id])).rows[0];
        const current = await read();
        if (!current || current.revision !== job.payload.revision) return this.jobs.finish(job.userId, job.id, job.leaseToken, { superseded: true });
        const guard = async () => {
          if (lost || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) throw new HttpError(409, "product_job_lease_lost", "Apply ownership expired.");
          if ((await read())?.revision !== job.payload.revision) throw new HttpError(409, "plugin_revision_changed", "Saved configuration changed.");
        };
        await guard();
        if (!this.runtime.runtimeGeneration(project)) return this.defer(job, "saved");
        // Both are checked again after exclusive admission. Kernel proof must
        // include queued input and live children, not just a running bit.
        if (await this.service.hasPendingPrompts(project) || await this.ledgerBusy(project) || await this.runtime.pluginRuntimeBusy(project)) return this.defer(job);
        const payload = exportPluginPayload(current.payload);
        const candidate = { revision: current.revision, enabled: payload.enabled, settings: payload.settings };
        await this.jobs.withLease(job.userId, job.id, job.leaseToken, c => c.query(`UPDATE evimed_product.plugin_application_state SET phase='applying'
          WHERE user_id=$1 AND id=$2 AND desired_revision=$3`, [job.userId, id, current.revision]));
        let previous = current.last_good;
        if (!previous) {
          const baseline = this.runtime.runtimePluginConfig(project);
          if (baseline) {
            try {
              const proof = await this.runtime.probePlugin(project, baseline);
              await guard();
              previous = baseline;
              await this.jobs.withLease(job.userId, job.id, job.leaseToken, c => c.query(`UPDATE evimed_product.plugin_application_state
                SET last_good=$3::jsonb WHERE user_id=$1 AND id=$2`, [job.userId, id, JSON.stringify(baseline)]));
              if (this.runtime.runtimeGeneration(project) !== proof.generation) throw new HttpError(409, "plugin_revision_changed", "Runtime generation changed.");
            } catch { await guard(); }
          }
        }
        const applied = await applyPluginCandidate(this.runtime, project, candidate, previous, guard);
        await guard();
        return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { phase: applied.phase }, async c => {
          const latest = await c.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='plugin' AND id=$2 AND deleted_at IS NULL FOR UPDATE", [job.userId, id]);
          if (latest.rows[0]?.revision !== current.revision || (applied.generation && this.runtime.runtimeGeneration(project) !== applied.generation)) {
            throw new HttpError(409, "plugin_revision_changed", "Plugin application was superseded.");
          }
          await c.query(`UPDATE evimed_product.plugin_application_state SET phase=$3,effective=$4::jsonb,
            last_good=CASE WHEN $4::jsonb IS NOT NULL THEN $4::jsonb ELSE last_good END,
            runtime_generation=$5,error=$6,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2`,
          [job.userId, id, applied.phase, JSON.stringify(applied.effective), applied.generation, applied.error]);
        });
      });
    } catch (error) {
      if (!lost && error?.code !== "product_job_lease_lost") {
        await this.jobs.withLease(job.userId, job.id, job.leaseToken, c => c.query(`UPDATE evimed_product.plugin_application_state
          SET phase='failed',error='plugin_apply_failed' WHERE user_id=$1 AND id=$2 AND desired_revision=$3`,
        [job.userId, projectPluginId(job.projectId), job.payload.revision])).catch(() => {});
        await this.jobs.fail(job.userId, job.id, job.leaseToken,
          { code: "plugin_apply_failed", message: "Plugin application could not complete." },
          { retry: !["plugin_generation_changed", "plugin_revision_changed", "plugin_project_unavailable"].includes(error?.code) }).catch(() => {});
      }
      throw error;
    } finally { clearInterval(renewal); }
  }
}
