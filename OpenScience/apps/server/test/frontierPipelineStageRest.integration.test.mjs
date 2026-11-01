/**
 * A pipeline stage that found nothing owed rests before it scans a month of texts again (`frontierIdleStageRecheckMs`).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {any} */ let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await migrateUsageLedger(database);
  await migrateFrontier(database, { dimension: 1024 });
});
after(async () => { await database?.close?.(); });

/** The pipeline with a clock it can be told, counting the scans of the 导读 stage. @param {Record<string, number>} extra */
function pipelineWith(extra) {
  let scans = 0;
  let time = new Date("2026-10-31T12:00:00Z").getTime();
  const counted = { ...database, query: (/** @type {string} */ sql, /** @type {any[]} */ params) => {
    if (/lead_basis IS DISTINCT FROM t\.reader_tidy/.test(sql)) scans += 1;
    return database.query(sql, params);
  }, transaction: (/** @type {any} */ work) => database.transaction(work), withTransactionClient: (/** @type {any} */ c, /** @type {any} */ w) => database.withTransactionClient(c, w) };
  const editor = { available: true, screen: async () => ({}), edit: async () => ({}), writeJson: async () => ({}), callJson: async () => ({}) };
  const pipeline = new FrontierPipeline({ database: counted, editor, plugin: { text: async () => ({ status: "pending" }) }, embedder: null, now: () => new Date(time),
    workerId: `test-${randomUUID()}`, glossary: new FrontierGlossary([]),
    config: { kbEmbeddingDimension: 1024, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300, frontierSelectThreshold: 80, ...extra } });
  return { pipeline, scans: () => scans, advance: (/** @type {number} */ ms) => { time += ms; } };
}

test("a stage with nothing owed is not asked again until its rest is over", options, async () => {
  const { pipeline, scans, advance } = pipelineWith({ frontierIdleStageRecheckMs: 120_000 });
  await pipeline.processBatch();
  assert.equal(scans(), 1);
  await pipeline.processBatch();
  advance(119_000);
  await pipeline.processBatch();
  assert.equal(scans(), 1, "rests while nothing can have become owed for long");
  advance(1_000);
  await pipeline.processBatch();
  assert.equal(scans(), 2, "looks again when the rest is over");
});

test("with no rest configured every round looks", options, async () => {
  const { pipeline, scans } = pipelineWith({});
  await pipeline.processBatch();
  await pipeline.processBatch();
  assert.equal(scans(), 2);
});
