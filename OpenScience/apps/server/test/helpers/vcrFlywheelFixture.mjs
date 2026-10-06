// The composed 虚拟临研 module on a database of its own, the way `vcrEvidenceMatching.integration.test.mjs` composes it, for the
// flywheel suites (cards as candidates, the 「模拟研究」 column, frontier events, platform packs, prediction filing). Each suite
// brings its own config and its own ports; the registry answers FLAURA for NCT02296125 and nothing else.
import assert from "node:assert/strict";

import { ControlPlaneDatabase } from "../../src/controlPlaneDatabase.mjs";
import { migrateEvidenceZones } from "../../src/evidenceZonePersistence.mjs";
import { migrateFrontier } from "../../src/frontierPersistence.mjs";
import { migrateProductStore } from "../../src/productPersistence.mjs";
import { composeVcr } from "../../src/vcrComposition.mjs";
import { vcrRuntimeWrite } from "../../src/vcrGateway.mjs";
import { createGeoTestDatabase } from "./geoTestDatabase.mjs";
import { FLAURA } from "../vcrEvidenceFixtures.mjs";

export const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
export const skipWithoutDatabase = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/**
 * @param {{ label: string, config?: Record<string, any>, composeOptions?: Record<string, any>, withFrontier?: boolean, users?: string[] }} input
 *   `withFrontier` migrates the frontier schema, the evidence zones and the product ledger and creates the accounts named in `users`.
 * @returns {Promise<{ vcr: any, database: ControlPlaneDatabase, write: (study: any, what: string, items: any[], extra?: Record<string, any>) => Promise<any>, close: () => Promise<void> }>}
 */
export async function startVcr({ label, config = {}, composeOptions = {}, withFrontier = false, users = [] }) {
  const isolated = await createGeoTestDatabase(databaseUrl, label);
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  try {
    if (withFrontier) {
      await migrateFrontier(database, { dimension: 1024 });
      await migrateProductStore(database);
      await migrateEvidenceZones(database);
      for (const id of users) await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$2,'development') ON CONFLICT DO NOTHING", [id, id]);
    }
  } catch (error) {
    // A setup that failed must not leave its pool open: the process would not end and the failure would never be read.
    await database.close?.().catch(() => {});
    await isolated.drop().catch(() => {});
    throw error;
  }
  const registry = async (/** @type {string} */ url) => {
    if (!String(url).includes("NCT02296125")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(FLAURA), { status: 200 });
  };
  const vcr = composeVcr({
    config: { vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 100_000, vcrMaxConcurrentJobs: 2, vcrLeaseMs: 900_000,
      vcrDataPlaneDir: "", vcrEngineUrl: "", ...config },
    productDatabase: database, fetchImpl: registry, ...composeOptions,
  });
  await vcr.store.ready();
  return {
    vcr, database,
    write: (study, what, items, extra = {}) => vcrRuntimeWrite({
      store: vcr.store, service: vcr.service, orchestrator: null, study, what, items,
      evidence: vcr.evidence, evidenceStore: vcr.evidenceStore, matchStore: vcr.matchStore, matching: vcr.matching, seal: null,
      dataPlane: null, documents: null, report: () => {}, ...extra,
    }),
    close: async () => {
      await database.close?.().catch(() => {});
      await isolated.drop();
    },
  };
}

let jobNumber = 0;

/**
 * One finished engine run of a study — job, execution and result — the way the queue leaves it, for a suite that needs a report
 * model with measures and a receipt behind them.
 * @param {any} vcr @param {any} study
 * @param {{ kind?: string, subjectId?: string | null, measures?: any[], counts?: Record<string, any>, engineJobId?: string }} [input]
 */
export async function seedEngineResult(vcr, study, { kind = "trial_scenario", subjectId = null, measures = [], counts = {}, engineJobId = "engine-job-1" } = {}) {
  jobNumber += 1;
  const jobId = `job_fw_${jobNumber}`;
  await vcr.store.query(`INSERT INTO evimed_vcr.jobs (id, study_id, user_id, kind, method, method_version, state, scenario_hash, seed)
    VALUES ($1, $2, $3, 'design_simulation', 'design.simulate', '1.0.0', 'succeeded', $4, 5)`, [jobId, study.id, study.userId, `hash-${jobId}`]);
  const execution = await vcr.store.recordExecution({ jobId, studyId: study.id, userId: study.userId, method: "design.simulate", methodVersion: "1.0.0",
    scenarioHash: `hash-${jobId}`, seed: 5, replicates: 1000, receipt: { signed: true, status: "succeeded", engineJobId } });
  const result = await vcr.store.recordResult({ studyId: study.id, userId: study.userId, kind, subjectId, executionId: execution.id, conclusion: "estimable",
    counts, measures, diagnostics: {}, requestedUse: "exploratory" });
  return { jobId, execution, result };
}
