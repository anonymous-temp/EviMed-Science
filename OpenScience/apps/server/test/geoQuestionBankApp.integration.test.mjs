// The question bank in the real hosted app: with its lever on, the module's worker has its daily pass wired and the operator metrics count
// it; with the lever off the loop is absent and that is not a missing loop. One app each, on a database of its own.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {Array<() => Promise<void>>} */
const cleanups = [];
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

/** @param {boolean} questionBank */
async function boot(questionBank) {
  const isolated = await createGeoTestDatabase(databaseUrl, questionBank ? "geobankon" : "geobankoff");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-geo-bank-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    geoEnabled: true, geoAudience: "all", geoQuestionBankEnabled: questionBank });
  const address = await app.listen(0, "127.0.0.1");
  await app.geo.worker.close();
  cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); await isolated.drop(); });
  return { app, base: `http://127.0.0.1:${address.port}` };
}

test("with the lever on the daily pass is wired and counted; with it off the loop is absent and nothing is reported missing", options, async () => {
  const on = await boot(true);
  assert.ok(on.app.geo.questionBank, "composed with its lever on");
  assert.equal(on.app.geo.worker.status().loops.questionBank.wired, true);
  assert.deepEqual(on.app.geo.worker.status().missing, []);
  const text = await (await fetch(`${on.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  // The worker may have made its first pass already (it starts with the app); the family is there either way.
  assert.match(text, /open_science_geo_question_bank_total\{event="rounds"\} \d+/);
  const off = await boot(false);
  assert.equal(off.app.geo.questionBank, undefined, "nothing of it exists with the lever off");
  assert.equal(off.app.geo.worker.status().loops.questionBank.wired, false);
  assert.ok(!off.app.geo.worker.status().missing.includes("questionBank"), "an optional loop is not a missing one");
  const offText = await (await fetch(`${off.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.doesNotMatch(offText, /open_science_geo_question_bank_total/);
});
