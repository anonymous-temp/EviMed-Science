// The monthly page's question-bank section in the real hosted app (flywheel review 2026-10-06): composed exactly as a deployment composes it,
// the section is there only where 循证传播 and its question-bank lever are on, and it reads the module the server made — not a double handed to
// the router. One app each, on a database of its own.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
/** @type {Array<() => Promise<void>>} */
const cleanups = [];
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

/** @param {boolean} questionBank */
async function boot(questionBank) {
  const isolated = await createGeoTestDatabase(databaseUrl, questionBank ? "metbankon" : "metbankoff");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-metrics-sections-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    frontierEnabled: true, frontierAudience: "all", evidencePublicWebEnabled: true, publicUrl: "https://www.evimed.test",
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: memoryPlugin({ sources: [pluginSource("nejm")] }).fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
    geoEnabled: questionBank, geoAudience: "all", geoQuestionBankEnabled: questionBank });
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.close();
  if (app.geo) await app.geo.worker.close();
  cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); await isolated.drop(); });
  return { app, base: `http://127.0.0.1:${address.port}` };
}
/** @param {string} base */
const metricsPage = async (base) => (await fetch(`${base}/evidence/metrics`, { headers: { "user-agent": BROWSER } })).text();

test("with 循证传播 and its question bank composed the page shows the bank's month the module reads; without them there is no section", options, async () => {
  const on = await boot(true);
  assert.ok(on.app.geo.questionBank, "composed with its lever on");
  const asked = /** @type {any[]} */ ([]);
  // The server's reader calls the module's own summary at the time of the request, so a month the module reports is the month the page shows.
  on.app.geo.questionBank.summary = async (/** @type {{ month: string }} */ query) => {
    asked.push(query);
    return { month: query.month, available: true, bankVersion: 1, coverage: {}, classes: [{ class: "dose", label: "用法用量", answers: 3, judged: 3, decided: 2, correct: 1, wrong: 1, cited: 1, citedEviMed: 1, rate: 0.5, eviMedCitedShare: 1 }],
      overall: { answers: 3, judged: 3, decided: 2, correct: 1, wrong: 1, cited: 1, citedEviMed: 1, rate: 0.5, eviMedCitedShare: 1 } };
  };
  const page = await metricsPage(on.base);
  assert.ok(page.includes("AI 助手回答常见用药问题"), "the section");
  assert.match(page, /<tr><td>用法用量<\/td><td class="num">3<\/td><td class="num">2<\/td><td class="num">1<\/td><td class="num">50%<\/td><\/tr>/);
  assert.match(asked[0].month, /^\d{4}-\d{2}$/);
  assert.equal(page.includes("预测的校准"), false, "no registry composed: no calibration section");

  const off = await boot(false);
  assert.equal(off.app.geo?.questionBank, undefined);
  const bare = await metricsPage(off.base);
  assert.ok(bare.includes("按月公开的数"));
  assert.equal(bare.includes("AI 助手回答常见用药问题") || bare.includes("预测的校准"), false);
});
