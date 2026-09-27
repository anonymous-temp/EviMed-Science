import { randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
import { PLUGIN_ID, defaultConfiguration, exportPluginPayload, pluginEntry, projectPluginId } from "./pluginService.mjs";
import { migrateProductStore } from "./productPersistence.mjs";

/**
 * The plugin one queued job is about.
 *
 * `PluginService.enqueue` writes `pluginId` into the payload only when the
 * plugin is not the default one. So dsh-cite's payload -- and with it the
 * idempotency key derived from it -- is byte-identical to what this queue has
 * always carried, and a job enqueued before the field existed still means
 * dsh-cite rather than nothing.
 *
 * An absent field is the only thing that means dsh-cite. A field that is
 * present but not a usable name -- a number, a null, an empty string -- is
 * refused instead: `enqueue` writes a validated registry id, so such a payload
 * is corruption, and reading it as the default would apply dsh-cite's document
 * for a job that named something else. That is precisely the failure this
 * function exists to prevent; arriving at it through a corrupt payload rather
 * than a missing field does not make it better. `plugin_not_supported` is the
 * code an unregistered name already raises, and the failure path below does
 * not retry it.
 *
 * @param {any} job @returns {string}
 */
export function jobPluginId(job) {
  const declared = job?.payload?.pluginId;
  if (declared === undefined) return PLUGIN_ID;
  if (typeof declared !== "string" || !declared) {
    throw new HttpError(404, "plugin_not_supported", "The queued job does not name a plugin this runtime image approves.");
  }
  return declared;
}

/** The one document a job applies. Addressed by the plugin the job names, not
 *  by the default id: applying a second bundle's saved configuration out of
 *  dsh-cite's document is the failure this worker used to be one line from.
 *  The registry is the service's own, so the worker and the route that
 *  enqueued the job resolve the same id from the same approved set.
 *  @param {any} job @param {string} projectId @param {Map<string,any>} [registry] */
function jobDocumentId(job, projectId, registry) {
  return projectPluginId(projectId, jobPluginId(job), registry);
}

/**
 * The application-state row a job's own plugin owns, named without asking
 * whether that plugin is still registered.
 *
 * The failure path has to reach this row for the one job that can never
 * succeed -- a job naming a bundle this image no longer carries -- and
 * `projectPluginId` refuses an unregistered id by design, because everywhere
 * else naming an unapproved plugin is the bug. So the id rule stays
 * pluginService's, applied to a one-entry registry standing for "this row was
 * written while the plugin was registered". Without it the row the product
 * itself wrote stays `pending` while the job is failed permanently, and the
 * browser shows an apply that is never coming.
 *
 * A payload whose `pluginId` is not a usable name is the one case with no row
 * to name: `jobPluginId` refuses it, the caller's `.catch` swallows that, and
 * the job is still failed. Nothing else could be marked failed honestly --
 * dsh-cite's row belongs to dsh-cite.
 *
 * @param {any} job @returns {string}
 */
function jobStateId(job) {
  const pluginId = jobPluginId(job);
  return projectPluginId(job.projectId, pluginId, new Map([[pluginId, { id: pluginId }]]));
}

/**
 * One failed step, kept: the code a reader groups by and the message that says
 * why, on one line and bounded.
 *
 * Every step of an apply used to end in a bare `catch {}`. The first production
 * apply of a project configuration (2026-09-27, dsh-cite in a probe project)
 * finished `unavailable` / `plugin_rollback_failed` with nothing anywhere to
 * say what had failed -- not the row, not the job, not a ledger line -- and a
 * rollback that the code never attempted. Whatever the next failure is, it
 * arrives with its reason.
 *
 * The messages are this control plane's own, the kernel's (a probe failure
 * names its check and the citation tools' own error codes, never an address or
 * a token) and the runtime launcher's; bounded, because they land on a row and
 * in a ledger line.
 * @param {any} error @returns {{code: string, message: string}}
 */
export function pluginFailure(error) {
  const code = typeof error?.code === "string" && error.code ? error.code : "plugin_step_failed";
  // eslint-disable-next-line no-control-regex
  const message = String(error?.message ?? error ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 300);
  return { code, message };
}

/**
 * The source's health a proof reported, when it was not healthy: a warning on
 * the row and in the ledger, never the outcome. The configuration proved; the
 * source behind the gateway (Crossref, a quarter of requests timing out from
 * the production host on 2026-09-26) is not the configuration's to answer for.
 * @param {any} proof @returns {{ upstream: { ok: false, code: string | null } } | null}
 */
function upstreamWarning(proof) {
  return proof?.upstream && proof.upstream.ok === false ? { upstream: { ok: false, code: proof.upstream.code ?? null } } : null;
}

/**
 * Every startup is followed by an independent live probe, including the one
 * that restores.
 *
 * When the candidate does not prove, what happens next depends on whether
 * there is anything proven to go back to, and the outcome says which:
 *
 * - A proven previous configuration: it is restarted and probed. `rolled_back`
 *   with `plugin_apply_failed`; if the rollback does not prove either, the
 *   runtime is stopped: `unavailable` with `plugin_rollback_failed`, which now
 *   only ever means a rollback was attempted and failed.
 * - Nothing proven (a project's first configuration): the runtime is restarted
 *   on `fallback`, the configuration every project that never saved one runs.
 *   `rolled_back` when that proves; `failed` when it starts but does not prove,
 *   and it is left running -- it is what an unconfigured project runs
 *   unverified anyway, and stopping it protects nothing, because the next start
 *   of this project runs the saved configuration again and re-verifies it;
 *   `unavailable` only when it cannot start. The error is `plugin_apply_failed`
 *   in all three: nothing was rolled back. This case used to stop the runtime
 *   and report `plugin_rollback_failed`, which is what production showed.
 *
 * `detail` carries the failure of each step that failed, and `upstream` when
 * the proof that decided the outcome found the source unhealthy -- an
 * `effective` apply can carry that warning and nothing else. It is recorded,
 * never shown to the researcher.
 *
 * @param {any} runtime @param {any} project @param {any} candidate @param {any} previous
 * @param {() => Promise<void>} guard @param {string} pluginId @param {any} [fallback]
 */
export async function applyPluginCandidate(runtime, project, candidate, previous, guard, pluginId = PLUGIN_ID, fallback = null) {
  let apply;
  try {
    await guard();
    await runtime.replacePluginRuntime(project, candidate);
    await guard();
    const proof = await runtime.probePlugin(project, candidate, pluginId);
    await guard();
    return { phase: "effective", effective: candidate, generation: proof.generation, error: null, detail: upstreamWarning(proof) };
  } catch (error) {
    // Authority loss is not an apply failure. It cannot grant a stale worker a
    // second startup, nor let it shut down a newer worker's runtime.
    await guard();
    apply = pluginFailure(error);
  }
  const restore = previous ?? fallback;
  if (!restore) {
    await runtime.stop(project);
    return { phase: "unavailable", effective: null, generation: null, error: "plugin_apply_failed", detail: { apply, restored: null } };
  }
  const restored = previous ? "previous" : "default";
  let started = false;
  try {
    await runtime.replacePluginRuntime(project, restore);
    started = true;
    await guard();
    const proof = await runtime.probePlugin(project, restore, pluginId);
    await guard();
    return { phase: "rolled_back", effective: restore, generation: proof.generation, error: "plugin_apply_failed", detail: { apply, restored, ...upstreamWarning(proof) } };
  } catch (error) {
    await guard();
    const failure = pluginFailure(error);
    if (previous) {
      await runtime.stop(project);
      return { phase: "unavailable", effective: null, generation: null, error: "plugin_rollback_failed", detail: { apply, restored, rollback: failure } };
    }
    if (!started) await runtime.stop(project);
    return { phase: started ? "failed" : "unavailable", effective: null, generation: null, error: "plugin_apply_failed", detail: { apply, restored, restore: failure } };
  }
}

/**
 * The ledger line of one apply: which project, plugin and revision, how it
 * ended, and every failed step with its reason -- the apply first, because the
 * security ledger keeps 300 characters of it.
 * @param {any} project @param {string} pluginId @param {number} revision @param {any} detail
 */
export function pluginApplyAuditDetail(project, pluginId, revision, detail) {
  const step = (/** @type {string} */ label, /** @type {any} */ failure) => failure
    ? ` ${label}=${failure.code}${failure.message ? `: ${String(failure.message).slice(0, 120)}` : ""}` : "";
  return `project=${project?.id ?? ""} plugin=${pluginId} revision=${revision}${detail?.restored ? ` restored=${detail.restored}` : ""}`
    + `${detail?.upstream ? ` upstream=${detail.upstream.code ?? "unhealthy"}` : ""}`
    + `${step("apply", detail?.apply)}${step("rollback", detail?.rollback)}${step("restore", detail?.restore)}${step("baseline", detail?.baseline)}`;
}

/** ProductJobs owns all retry/lease authority; the project lock fences admission. */
export class PluginApplyWorker {
  /**
   * `audit(event, status, details)` is the security ledger (`securityAudit`):
   * one `plugin.apply` line per finished apply, whatever its outcome, so an
   * apply that changed a project's runtime is never invisible.
   * @param {{service:any,runtime:any,resolveProject:(job:any)=>Promise<any>,ledgerBusy:(project:any)=>Promise<boolean>,pollMs?:number,leaseMs?:number,
   *   audit?:((event:string,status:string,details:Record<string,any>)=>unknown)|null}} dependencies */
  constructor({ service, runtime, resolveProject, ledgerBusy, pollMs = 1000, leaseMs = 300000, audit = null }) {
    this.service = service; this.jobs = service.jobs; this.database = service.database;
    this.runtime = runtime; this.resolveProject = resolveProject; this.ledgerBusy = ledgerBusy;
    this.pollMs = pollMs; this.leaseMs = leaseMs; this.workerId = `plugin-apply-${randomUUID()}`;
    this.kinds = ["plugin-apply"];
    this.timer = null; this.running = null; this.lastError = null;
    this.audit = audit;
  }
  /** One ledger line; a ledger that cannot be written must not fail the apply
   *  it describes, and says so on stderr instead of vanishing.
   *  @param {string} status @param {any} job @param {string|null} code @param {string} detail */
  async record(status, job, code, detail) {
    if (!this.audit) return;
    try { await this.audit("plugin.apply", status, { userId: job.userId, code, detail }); }
    catch (error) { process.stderr.write(`plugin.apply audit line not written (${status}): ${error?.code ?? error?.message ?? error}\n`); }
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
      await client.query(`UPDATE evimed_product.plugin_application_state SET phase=$4,error=NULL,error_detail=NULL
        WHERE user_id=$1 AND id=$2 AND desired_revision=$3`, [job.userId, jobDocumentId(job, job.projectId, this.service.registry), job.payload.revision, phase]);
      // Waiting for user work or first launch is not a failed attempt.
      await client.query(`UPDATE evimed_product.jobs SET status='queued',attempts=GREATEST(0,attempts-1),
        lease_token=NULL,lease_expires_at=NULL,run_after=clock_timestamp()+interval '5 seconds' WHERE id=$1`, [job.id]);
    });
  }
  async run() {
    await migrateProductStore(this.database);
    const job = await this.jobs.claim(this.kinds, this.workerId, { leaseMs: this.leaseMs });
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
        const id = jobDocumentId(job, project.id, this.service.registry);
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
        const payload = exportPluginPayload(current.payload, this.service.registry);
        const candidate = { revision: current.revision, enabled: payload.enabled, settings: payload.settings };
        await this.jobs.withLease(job.userId, job.id, job.leaseToken, c => c.query(`UPDATE evimed_product.plugin_application_state SET phase='applying'
          WHERE user_id=$1 AND id=$2 AND desired_revision=$3`, [job.userId, id, current.revision]));
        const pluginId = jobPluginId(job);
        let previous = current.last_good;
        /** Why the configuration the runtime was already running did not prove, when it did not. */
        let baselineFailure = null;
        if (!previous) {
          const baseline = this.runtime.runtimePluginConfig(project);
          if (baseline) {
            try {
              const proof = await this.runtime.probePlugin(project, baseline, pluginId);
              await guard();
              previous = baseline;
              await this.jobs.withLease(job.userId, job.id, job.leaseToken, c => c.query(`UPDATE evimed_product.plugin_application_state
                SET last_good=$3::jsonb WHERE user_id=$1 AND id=$2`, [job.userId, id, JSON.stringify(baseline)]));
              if (this.runtime.runtimeGeneration(project) !== proof.generation) throw new HttpError(409, "plugin_revision_changed", "Runtime generation changed.");
            } catch (error) {
              await guard();
              baselineFailure = pluginFailure(error);
            }
          }
        }
        // What an unconfigured project runs: revision 0 at the entry's
        // defaults, exactly what `startKernel` launches when no document exists.
        const fallback = { revision: 0, ...defaultConfiguration(pluginEntry(pluginId, this.service.registry), this.service.maxTimeoutMs ?? 15000) };
        const applied = await applyPluginCandidate(this.runtime, project, candidate, previous, guard, pluginId, fallback);
        await guard();
        /** @type {Record<string, any> | null} */
        const detail = applied.detail || baselineFailure ? { ...applied.detail, ...(baselineFailure ? { baseline: baselineFailure } : {}) } : null;
        const finished = await this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { phase: applied.phase, error: applied.error, detail }, async c => {
          const latest = await c.query("SELECT revision FROM evimed_product.documents WHERE user_id=$1 AND kind='plugin' AND id=$2 AND deleted_at IS NULL FOR UPDATE", [job.userId, id]);
          if (latest.rows[0]?.revision !== current.revision || (applied.generation && this.runtime.runtimeGeneration(project) !== applied.generation)) {
            throw new HttpError(409, "plugin_revision_changed", "Plugin application was superseded.");
          }
          // SQL NULL, not the JSON `null` `JSON.stringify(null)` produces:
          // `'null'::jsonb IS NOT NULL` is true, so an outcome with nothing
          // effective used to overwrite the proven `last_good` with a JSON
          // null, and the next apply had nothing to roll back to.
          await c.query(`UPDATE evimed_product.plugin_application_state SET phase=$3,effective=$4::jsonb,
            last_good=CASE WHEN $4::jsonb IS NOT NULL THEN $4::jsonb ELSE last_good END,
            runtime_generation=$5,error=$6,error_detail=$7::jsonb,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2`,
          [job.userId, id, applied.phase, applied.effective ? JSON.stringify(applied.effective) : null, applied.generation, applied.error,
            detail ? JSON.stringify(detail) : null]);
        });
        // An effective apply whose source was unhealthy is a warning line: the
        // outcome stands, the code says what to keep an eye on.
        await this.record(applied.phase, job, applied.error ?? (detail?.upstream ? "plugin_upstream_unhealthy" : null),
          pluginApplyAuditDetail(project, pluginId, current.revision, detail));
        return finished;
      });
    } catch (error) {
      if (!lost && error?.code !== "product_job_lease_lost") {
        const failure = pluginFailure(error);
        await this.jobs.withLease(job.userId, job.id, job.leaseToken, c => c.query(`UPDATE evimed_product.plugin_application_state
          SET phase='failed',error='plugin_apply_failed',error_detail=$4::jsonb WHERE user_id=$1 AND id=$2 AND desired_revision=$3`,
        // `jobStateId`, not the registry-checked id: the job that most needs
        // its row marked failed is the one whose plugin the registry no longer
        // carries, and resolving that through the registry threw here, leaving
        // the row `pending` forever.
        [job.userId, jobStateId(job), job.payload.revision, JSON.stringify({ apply: failure })]))
          // The one job with no row to name (`jobStateId` refuses a payload
          // whose plugin id is not a name) lands here too; the ledger line
          // below still says what failed.
          .catch(stateError => this.record("failed", job, "plugin_apply_state_unwritten", `project=${job.projectId} ${pluginFailure(stateError).code}`));
        await this.jobs.fail(job.userId, job.id, job.leaseToken,
          { code: "plugin_apply_failed", message: `${failure.code}: ${failure.message}` },
          // `plugin_not_supported` joins them because addressing the job's own
          // plugin made it reachable: a job naming a bundle this image's
          // registry no longer carries has no document to apply and no amount
          // of retrying finds one.
          { retry: !["plugin_generation_changed", "plugin_revision_changed", "plugin_project_unavailable", "plugin_not_supported"].includes(error?.code) })
          .catch(failError => this.record("failed", job, "plugin_apply_job_unfailed", `project=${job.projectId} ${pluginFailure(failError).code}`));
        await this.record("failed", job, "plugin_apply_failed",
          pluginApplyAuditDetail({ id: job.projectId }, String(job.payload?.pluginId ?? PLUGIN_ID), job.payload?.revision, { apply: failure }));
      }
      throw error;
    } finally { clearInterval(renewal); }
  }
}
