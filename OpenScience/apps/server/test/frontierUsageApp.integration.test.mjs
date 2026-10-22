// The operators' frontier figures in the real hosted app (fr-ops, 2026-10-22): the route behind the scrape token, the window it takes,
// the families in the scrape beside the module's other ones, and nothing at all while the frontier is off.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const TOKEN = "test-only-metrics-token";
/** @type {any} */ let context = null;
/** @type {any} */ let isolated = null;

/** @param {Record<string, any>} extra */
async function compose(extra) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-usage-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres",
    requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: TOKEN,
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: memoryPlugin({ sources: [pluginSource("nejm")] }).fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} }, ...extra,
  });
  const address = await app.listen(0, "127.0.0.1");
  return { app, base: `http://127.0.0.1:${address.port}`, dataDir };
}
const close = async (/** @type {any} */ running) => { await running.app.close(); await rm(running.dataDir, { recursive: true, force: true }); };
const ask = (/** @type {any} */ running, /** @type {string} */ route, /** @type {boolean} */ authorised = true) =>
  fetch(`${running.base}${route}`, { headers: authorised ? { authorization: `Bearer ${TOKEN}` } : {} });

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "frusageapp");
  context = await compose({ frontierEnabled: true, frontierAudience: "all" });
  await context.app.frontierWorker.close();
});
after(async () => {
  if (context) await close(context);
  await isolated?.drop();
});

test("the route answers the operator's token only, takes a window of days, and gives the figures and the plugin's blocks as they stand", options, async () => {
  assert.equal((await ask(context, "/api/ops/frontier-usage", false)).status, 401);
  const answer = await ask(context, "/api/ops/frontier-usage");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("cache-control"), "no-store");
  const { data } = await answer.json();
  assert.equal(data.days.length, 14, "two weeks by default");
  assert.deepEqual(Object.keys(data.days[0]).sort(), ["day", "eventReads", "follows", "itemReads", "model", "notices", "readers", "stars"]);
  assert.equal(data.timeZone, "Asia/Shanghai");
  assert.equal(data.providers.value, null, "a plugin that reports no providers is said not to, not shown as spending nothing");
  assert.match(data.providers.reason, /^plugin_/);
  assert.ok(data.sources.enabled >= 0 && typeof data.sources.byHealth === "object");
  assert.equal((await (await ask(context, "/api/ops/frontier-usage?days=3")).json()).data.days.length, 3);
  for (const days of ["0", "91", "abc", "1.5"]) {
    const refused = await ask(context, `/api/ops/frontier-usage?days=${days}`);
    assert.equal(refused.status, 400, days);
    assert.equal((await refused.json()).code, "usage_report_days_invalid");
  }
});

test("the scrape carries the usage families beside the module's own, without an account or a day in any label", options, async () => {
  const text = await (await ask(context, "/api/ops/metrics")).text();
  assert.match(text, /^open_science_frontier_usage_snapshot 1$/m);
  assert.match(text, /^open_science_frontier_usage_readers\{window="today"\} \d+$/m);
  assert.match(text, /^open_science_frontier_usage_readers\{window="yesterday"\} \d+$/m);
  assert.match(text, /^open_science_frontier_usage_sources\{state="enabled"\} \d+$/m);
  assert.match(text, /^open_science_frontier_plugin_state\{state="/m, "the module's existing families are still there");
  for (const line of text.split("\n").filter((entry) => entry.startsWith("open_science_frontier_usage_"))) assert.doesNotMatch(line, /user|account|day=/, line);
});

test("with the frontier off the route answers by name once the token is checked, and the scrape has no usage family", options, async () => {
  const off = await compose({ frontierEnabled: false });
  try {
    assert.equal((await ask(off, "/api/ops/frontier-usage", false)).status, 401);
    const refused = await ask(off, "/api/ops/frontier-usage");
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).code, "frontier_not_enabled");
    assert.doesNotMatch(await (await ask(off, "/api/ops/metrics")).text(), /open_science_frontier_usage_/);
  } finally {
    await close(off);
  }
});
