// Run outcomes on /api/ops/metrics.
//
// Counted by the control plane as each run ends, never read back from a
// project's run ledger (a file that can be wiped), and labelled only with
// closed sets so no run can grow the series without bound.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { RUN_COST_BUCKETS_CNY, RUN_DURATION_BUCKETS_SECONDS, RunMetrics, runCapabilityLabel } from "../src/runMetrics.mjs";

const installed = new Set(["clinical-evidence-synthesis", "meta-analysis"]);
const label = (id) => runCapabilityLabel(id, (candidate) => installed.has(candidate));

/** @param {string} text @param {string} line */
function has(text, line) {
  return text.split("\n").includes(line);
}

test("labels come from closed sets, so no run can grow the series without bound", () => {
  assert.equal(label("clinical-evidence-synthesis"), "clinical-evidence-synthesis");
  assert.equal(label("made-up-capability"), "other");
  assert.equal(label(null), "none");
  const metrics = new RunMetrics();
  metrics.observe({ capability: label("made-up-capability"), status: "exploded", errorCode: "not_a_registered_code" });
  metrics.observe({ capability: label(undefined), status: "succeeded", errorCode: null });
  metrics.observe({ capability: label("meta-analysis"), status: "failed", errorCode: "runtime_session_error" });
  const text = metrics.lines().join("\n");
  assert.ok(has(text, 'evimed_runs_finished_total{capability="other",status="other",error_code="other"} 1'));
  assert.ok(has(text, 'evimed_runs_finished_total{capability="none",status="succeeded",error_code="none"} 1'));
  assert.ok(has(text, 'evimed_runs_finished_total{capability="meta-analysis",status="failed",error_code="runtime_session_error"} 1'));
});

test("duration and cost are histograms a percentile can be read from, up to two hours", () => {
  assert.equal(RUN_DURATION_BUCKETS_SECONDS.at(-1), 7200);
  assert.ok(RUN_COST_BUCKETS_CNY.includes(4), "a deep report costs about ¥4");
  const metrics = new RunMetrics();
  for (const [seconds, cost] of [[45, 0.018], [1500, 3.6], [9000, 0.4]]) {
    metrics.observe({ capability: "clinical-evidence-synthesis", status: "succeeded", durationMs: seconds * 1000, costCny: cost });
  }
  const text = metrics.lines().join("\n");
  const labels = 'capability="clinical-evidence-synthesis",status="succeeded"';
  assert.ok(has(text, `evimed_run_duration_seconds_bucket{${labels},le="60"} 1`));
  assert.ok(has(text, `evimed_run_duration_seconds_bucket{${labels},le="1800"} 2`));
  assert.ok(has(text, `evimed_run_duration_seconds_bucket{${labels},le="7200"} 2`), "longer than the last bucket is only in +Inf");
  assert.ok(has(text, `evimed_run_duration_seconds_bucket{${labels},le="+Inf"} 3`));
  assert.ok(has(text, `evimed_run_duration_seconds_sum{${labels}} 10545`));
  assert.ok(has(text, 'evimed_run_cost_cny_total{capability="clinical-evidence-synthesis"} 4.018'));
  assert.ok(has(text, 'evimed_run_cost_cny_bucket{capability="clinical-evidence-synthesis",le="0.02"} 1'));
  assert.ok(has(text, 'evimed_run_cost_cny_count{capability="clinical-evidence-synthesis"} 3'));
  assert.match(text, /^# TYPE evimed_run_duration_seconds histogram$/m);
  assert.match(text, /^# TYPE evimed_run_cost_cny_total counter$/m);
});

test("claims and preserved sources are counted, and one run cannot flood a counter", () => {
  const metrics = new RunMetrics();
  metrics.observe({ capability: "clinical-evidence-synthesis", status: "succeeded",
    claims: { verified: 18, unverified: 2 }, sources: { resolved: 11 } });
  metrics.observe({ capability: "clinical-evidence-synthesis", status: "succeeded",
    claims: { verified: 1e12, unverified: -5 }, sources: { resolved: 0 } });
  const text = metrics.lines().join("\n");
  assert.ok(has(text, 'evimed_run_claims_total{capability="clinical-evidence-synthesis",verification="verified"} 10018'));
  assert.ok(has(text, 'evimed_run_claims_total{capability="clinical-evidence-synthesis",verification="unverified"} 2'));
  assert.ok(has(text, 'evimed_run_sources_total{capability="clinical-evidence-synthesis",resolvable="yes"} 11'));
  assert.equal(text.includes('resolvable="no"'), false, "nothing is known to be unresolvable until a link check exists");
  metrics.failed();
  assert.ok(has(metrics.lines().join("\n"), "evimed_run_metric_failures_total 1"));
});

test("a run that ends is on /api/ops/metrics, counted by the control plane", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-run-metrics-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, operatorMetricsToken: "run-metrics-token" });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const user = await app.store.createUser("metricsowner", "test-only-metrics-password", "Metrics owner");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const agent = (await app.agentRegistry).get("clinical-evidence-synthesis");
    assert.ok(agent, "the bundled registry carries the capability this test dispatches");
    await app.researchSessions.put(project, "ses_metrics", { mode: "specialist", agentId: agent.id, agentVersion: agent.version });
    app.agentRuns.scheduleMonitor = () => {};
    const run = await app.agentRuns.dispatch(project, {
      sessionId: "ses_metrics", dispatchId: "turn_metrics", question: "阿司匹林一级预防的证据",
      effectiveAgentId: agent.id, effectiveAgentVersion: agent.version, effectiveRuntimeAgent: agent.runtimeAgent,
    }, async () => ({ accepted: true }));
    await app.agentRuns.finishInternal(project, run.id, { status: "failed", errorCode: "runtime_session_error", artifacts: [] });

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ops/metrics`, {
      headers: { Authorization: "Bearer run-metrics-token" },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(has(text, 'evimed_runs_finished_total{capability="clinical-evidence-synthesis",status="failed",error_code="runtime_session_error"} 1'), text);
    assert.ok(has(text, 'evimed_run_duration_seconds_count{capability="clinical-evidence-synthesis",status="failed"} 1'));
    assert.ok(has(text, "evimed_run_metric_failures_total 0"));
    // No usage ledger on a file-state deployment, so no cost is claimed.
    assert.equal(text.includes("evimed_run_cost_cny_count{"), false);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
