/**
 * Truthful capability availability, composed as one feature module.
 *
 * The shape every module here has: a service (`availabilityService.mjs`), routes
 * (`availabilityRoutes.mjs`), a leased worker (`availabilityCollector.mjs`), one
 * toggle in `config.mjs` (`OPEN_SCIENCE_AVAILABILITY_ENABLED`) and its own
 * migration (in `productPersistence.mjs`, beside the product ledger it joins).
 * `createWebApiApp` composes it with one call and hooks it in four places: the
 * run-finish hook, the route chain, the recurring-work start and the operators'
 * metrics.
 *
 * With the toggle off, or with no database to keep records in, the projection
 * is still served — from the deployment's composition alone, every label that
 * would need a record reading `unverified` — and nothing is collected. The
 * module never sits on a path a researcher is waiting on.
 *
 * @module availabilityModule
 */

import { createHash } from "node:crypto";
import { collectableProject, AvailabilityCollector, AvailabilityWorker } from "./availabilityCollector.mjs";
import { EngineHealthProbe } from "./availabilityEngineProbe.mjs";
import { createAvailabilityRoutes } from "./availabilityRoutes.mjs";
import { AvailabilityService } from "./availabilityService.mjs";
import { AVAILABILITY_JOB_KIND, AvailabilityStore } from "./availabilityStore.mjs";
import { readRunTranscript } from "./runTranscripts.mjs";
import { runUsageKeys } from "./runUsage.mjs";

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

/**
 * @param {{
 *   config: Record<string, any>,
 *   authStore: any,
 *   registry: Promise<any> | any,
 *   database: any,
 *   jobs: any,
 *   documents: any,
 *   agentRuns: () => any,
 *   usageLedger: any,
 *   connectorCredentials: any,
 *   methodValidation: (() => Promise<{ status: string, reason?: string } | null>) | null,
 *   vcrEngine?: (() => import("./vcrEngineProbe.mjs").VcrEngineReading | null) | null,
 *   extensionService: any,
 *   mutation: (operation: () => Promise<any>) => Promise<any>,
 *   canRun?: () => boolean,
 *   fetchImpl?: typeof fetch,
 *   report?: (code: string) => void,
 *   skillSupply?: import("./skillSupplyService.mjs").SkillSupply | null,
 * }} dependencies
 */
export function createAvailability({
  config, authStore, registry, database, jobs, documents, agentRuns, usageLedger, connectorCredentials, methodValidation, vcrEngine = null,
  extensionService, mutation, canRun = () => true, fetchImpl = globalThis.fetch, report = () => {}, skillSupply = null,
}) {
  const collecting = Boolean(database && jobs) && config.availabilityEnabled !== false && config.runtimeMode !== "mock";
  const records = database && config.availabilityEnabled !== false ? new AvailabilityStore(database) : null;
  const engineProbe = new EngineHealthProbe({ config, fetchImpl });

  const service = new AvailabilityService({
    config, registry, store: records, engineProbe, skillSupply, vcrEngine,
    connectorStatus: connectorCredentials ? (userId) => connectorCredentials.status(userId) : null,
    methodValidation,
    extensionViews: extensionService ? async (user) => {
      const [installations, catalogue] = await Promise.all([extensionService.list(user), extensionService.catalogue()]);
      const byId = new Map(catalogue.items.map((/** @type {any} */ item) => [item.id, item]));
      return installations.items.map((/** @type {any} */ item) => ({
        ...item, executionClass: byId.get(item.catalogueId)?.executionClass ?? null, policyState: catalogue.policyState ?? null,
      }));
    } : null,
  });

  /** @param {string} userId @param {string} projectId */
  const resolveProject = async (userId, projectId) => {
    try {
      const user = await authStore.userById(userId);
      return user ? await authStore.requireProject(user, projectId) : null;
    } catch { return null; }
  };

  const collector = collecting && records ? new AvailabilityCollector({
    jobs, store: records, documents, resolveProject,
    readRuns: (project) => agentRuns().list(project),
    readTranscript: (project, runId) => readRunTranscript(project, runId),
    costOf: async (project, run) => {
      if (!usageLedger) return null;
      const spent = await usageLedger.summaryRuns(project.userId, runUsageKeys(run));
      return [...spent.values()].reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + Number(row.costCny ?? 0), 0);
    },
    listFinishedRuns: async (userId) => {
      const user = await authStore.userById(userId);
      if (!user) return [];
      const rows = (await database.query("SELECT id FROM evimed_control.projects WHERE user_id=$1 ORDER BY id LIMIT 2000", [userId])).rows;
      /** @type {{ projectId: string, runId: string }[]} */
      const found = [];
      for (const row of rows) {
        if (!collectableProject(row.id)) continue;
        const project = await authStore.requireProject(user, row.id).catch(() => null);
        if (!project) continue;
        for (const run of await agentRuns().list(project).catch(() => [])) {
          if (TERMINAL.has(String(run?.status))) found.push({ projectId: project.id, runId: run.id });
        }
      }
      return found;
    },
    manifestOf: async (id) => {
      const entry = (await registry)?.getPackage?.(id);
      if (!entry) return null;
      return { manifest: entry.manifest, bodyDigest: entry.skillText ? `sha256:${createHash("sha256").update(entry.skillText).digest("hex")}` : null };
    },
    runtimeMode: config.runtimeMode, report,
  }) : null;

  const worker = collector ? new AvailabilityWorker({ jobs, collector, canRun, report }) : null;

  const sweepIntervalMs = Math.max(60_000, Number(config.availabilitySweepIntervalMs) || 3_600_000);
  /** @type {ReturnType<typeof setInterval> | null} */
  let sweepTimer = null;
  /** @type {Promise<unknown> | null} */
  let sweeping = null;

  /**
   * Queue one sweep per account for this period, and give the run jobs that
   * gave up another go. One sweep per account per period however often this
   * fires, and the jobs it queues are the run jobs' own — nothing here counts.
   */
  const schedule = () => {
    if (!collector || !database || sweeping) return sweeping;
    sweeping = mutation(async () => {
      const period = String(Math.floor(Date.now() / sweepIntervalMs));
      const users = await database.query("SELECT DISTINCT user_id FROM evimed_control.projects ORDER BY user_id LIMIT 500");
      for (const row of users.rows) {
        try { await collector.enqueueSweep(row.user_id, period); } catch (error) { report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "availability_sweep_enqueue_failed"); }
      }
      await jobs.rearm(AVAILABILITY_JOB_KIND, { limit: 25 });
    }).catch((/** @type {any} */ error) => {
      if (error?.code !== "maintenance_active") report(typeof error?.code === "string" ? error.code : "availability_schedule_failed");
    }).finally(() => { sweeping = null; });
    return sweeping;
  };

  return {
    service,
    collector,
    worker,
    engineProbe,
    routes: createAvailabilityRoutes({ store: authStore, service }),
    schedule,
    /** Start the worker and the sweep timer; both are no-ops where nothing is collected. */
    start() {
      worker?.start();
      if (collector && !sweepTimer) {
        sweepTimer = setInterval(() => { void schedule(); }, sweepIntervalMs);
        sweepTimer.unref?.();
        void schedule();
      }
    },
    /** Stop waking: maintenance holds claims, and a timer left running would only queue more. */
    pause() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    },
    async close() {
      this.pause();
      await worker?.close();
    },
  };
}
