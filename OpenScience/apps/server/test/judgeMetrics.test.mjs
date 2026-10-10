// What the judge sites report on /api/ops/metrics. Every bound and every refusal in the Jev integration is only as
// good as the number an operator can read afterwards, so these go through the real exposition, not the service's
// internal counters.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createJudgeService } from "../src/judgeService.mjs";
import { createWebApiApp } from "../src/server.mjs";

const config = { reviewJevEnabled: true, typesafeApiKey: "test-not-secret", reviewJevModel: "jev-1.13.0", reviewJevSupportConfidence: 0.8 };

/** The exposition text of an app whose judge service is `judgeService`.
 * @param {any} judgeService */
async function metricsText(judgeService) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-judge-metrics-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple", operatorMetricsToken: "judge-metrics-token-0123456789", judgeService });
  const address = await app.listen(0, "127.0.0.1");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ops/metrics`, { headers: { Authorization: "Bearer judge-metrics-token-0123456789" } });
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("work a caller did not send to a site is counted by reason, never judged", async () => {
  const service = createJudgeService({ calibrationMode: true, config, callImpl: async () => { throw new Error("not called"); } });
  service.skipped("J4", "lines_over_cap", 7);
  service.skipped("J4", "lines_over_cap", 2);
  service.skipped("J4", "run_out_of_scope");
  service.skipped("not-a-site", "lines_over_cap", 1);
  service.skipped("J4", "Not A Reason", 1);
  service.skipped("J4", "lines_over_cap", 0);
  const text = await metricsText(service);
  assert.match(text, /^open_science_jev_skipped_total\{site="J4",reason="lines_over_cap"\} 9$/m);
  assert.match(text, /^open_science_jev_skipped_total\{site="J4",reason="run_out_of_scope"\} 1$/m);
  assert.equal((text.match(/^open_science_jev_skipped_total\{/gm) ?? []).length, 2, "an unknown site, a free-form reason and a zero count are not series");
  await service.close();
});

/** A database that holds no drift rows and accepts the writes. */
const quietDatabase = {
  transaction: async (/** @type {(client: any) => Promise<any>} */ fn) => fn({ query: async () => ({ rows: [] }) }),
  query: async () => ({ rows: [] }),
};
const yesLast = async (_deps, call) => ({
  model: config.reviewJevModel, cost: 0,
  answers: Object.fromEntries(Object.entries(call.questions).map(([id, question]) => {
    const keys = Object.keys(question.criteria);
    return [id, { type: "choice", choice: keys.at(-1), confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === keys.at(-1) ? 1 : 0])) }];
  })),
});

test("drift comparisons are counted and exported, not only recorded", async () => {
  const service = createJudgeService({ calibrationMode: true, config, callImpl: yesLast, database: quietDatabase, random: () => 0 });
  // J4's comparator is the frozen regex: every settled line is compared with it.
  await service.judge("J4", { line: "A backstage diary" }, { userId: "u", projectId: "p", regexBaseline: { leakage: true } });
  await service.judge("J4", { line: "Another line" }, { userId: "u", projectId: "p", regexBaseline: () => { throw new Error("comparator down"); } });
  await service.close();
  const text = await metricsText(service);
  assert.match(text, /^open_science_jev_drift_observations_total\{site="J4",outcome="compared"\} 1$/m);
  assert.match(text, /^open_science_jev_drift_observations_total\{site="J4",outcome="failed"\} 1$/m);
});

test("a site whose pin carries no baseline agreement says so: its drift alert cannot fire", async () => {
  const pinned = { ...config, jevSites: { J2: { calibration: "calibrated", promptFingerprint: "pin2", baselineAgreement: 0.94 }, J4: { calibration: "calibrated", promptFingerprint: "pin4" } } };
  const service = createJudgeService({ calibrationMode: true, config: pinned, callImpl: yesLast, database: quietDatabase });
  const families = await service.metricFamilies();
  const gauge = families.find((family) => family.name === "open_science_jev_drift_baseline_configured");
  assert.ok(gauge, "the family is exported");
  assert.deepEqual(gauge.series.map((row) => [row.labels.site, row.value]).sort(), [["J2", 1], ["J4", 0]]);
  await service.close();
});
