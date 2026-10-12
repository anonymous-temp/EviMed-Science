// The 2026-10-12 incident case "the learning loop taught the delivery gate", held against the code it was written for.
//
// evals/method-quality/incidents/2026-10-12-learning-taught-the-delivery-gate.json records what the live audit found -- three quarters of the
// lessons were the gate's bookkeeping, the researcher's corrections queued nothing, the merging pass inflated the library with rewordings
// that nobody opened -- and the scenarios that must now come out otherwise. The trigger and library scenarios are decidable and are held
// here; the distillation scenarios ask a model to judge and are evaluation data for a live run, so what is held here is that they are
// well formed and cover the three things the capability is now told (principle 6: an incident becomes a case, not a keyword).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { emptyLearning, foldCarried, foldRead, retirementProposal } from "@evimed/domain";

import { LearningTriggers } from "../src/learningTriggers.mjs";
import { unprovenMerge } from "../src/methodConsolidation.mjs";

const incident = JSON.parse(await readFile(new URL("../../../evals/method-quality/incidents/2026-10-12-learning-taught-the-delivery-gate.json", import.meta.url), "utf8"));

const project = { id: "project_1", userId: "user_1" };

/** @param {any} scenario @param {number} index */
function ledgerRun(scenario, index) {
  return {
    id: `run_incident_${index}`, sessionId: "session_1", status: "succeeded", effectiveAgentId: "clinical-evidence-synthesis",
    artifacts: scenario.run.artifacts, transcript: { completeness: "complete" },
    startedAt: "2026-10-12T01:00:00.000Z", finishedAt: "2026-10-12T01:30:00.000Z",
    ...(scenario.run.corrections ? { corrections: scenario.run.corrections } : {}),
  };
}

test("each trigger scenario comes out as the case says: the gate's repairs queue nothing by default, the researcher's corrections always queue", async () => {
  assert.ok(incident.scenarios.triggers.length >= 4);
  for (const [index, scenario] of incident.scenarios.triggers.entries()) {
    const run = ledgerRun(scenario, index);
    const jobs = { enqueue: async () => ({ id: "job" }) };
    const triggers = new LearningTriggers({
      jobs, deliveryShare: scenario.shares.delivery, repairShare: scenario.shares.repair,
      agentRuns: { list: async () => [run], runWorkflowProjection: async () => ({ plan: { items: [{ id: "d1", attempts: scenario.run.inRunAttempts }] } }) },
    });
    const result = await triggers.afterRun(project, run, scenario.memoryCorrections ? { corrections: scenario.memoryCorrections } : null);
    assert.deepEqual([...result.queued].sort(), [...scenario.expect.queued].sort(), `${scenario.name}: queued`);
    assert.deepEqual(result.sampledOut ?? [], scenario.expect.sampledOut, `${scenario.name}: sampled out`);
  }
});

test("the library scenario: every reworded card nobody opened is stopped on its own count, the one that is opened stays, and merges nobody used are not built on", () => {
  const [scenario] = incident.scenarios.library;
  assert.equal(scenario.unused.length, 22, "the case names the 22 the audit counted");
  assert.equal(new Set(scenario.unused).size, 22);
  const nowMs = Date.parse("2026-10-12T00:00:00.000Z");
  /** @param {string} name @param {{ opened?: boolean, carried?: number }} [options] */
  const record = (name, { opened = false, carried = scenario.carried } = {}) => {
    let learning = emptyLearning("sha256:" + "a".repeat(64));
    for (let load = 0; load < carried; load += 1) learning = foldCarried(learning);
    if (opened) learning = foldRead(learning, "2026-10-11T00:00:00.000Z");
    return { id: `method:learned:${name}`, name, digest: "sha256:" + "a".repeat(64), status: "approved", dependencies: [], learning, provenance: { origin: "inferred" } };
  };
  for (const name of scenario.unused) {
    const proposal = retirementProposal(record(name), { nowMs });
    assert.deepEqual({ name, code: proposal.code, immediate: proposal.immediate }, { name, code: scenario.expect.stopped, immediate: true });
  }
  for (const name of scenario.expect.kept) {
    assert.notEqual(retirementProposal(record(name, { opened: true, carried: 55 }), { nowMs }).code, "never_opened", name);
  }
  // A merge the passes wrote and no run has used is not a base for another; a method a run taught is.
  for (const name of scenario.consolidationBuilt) {
    const merged = { payload: { status: "approved", contentDigest: "sha256:" + "a".repeat(64), learning: record(name).learning, provenance: { origin: "inferred", consolidatedBy: "consolidate:job_1" } } };
    assert.equal(unprovenMerge(merged), true, name);
  }
  const taught = { payload: { status: "approved", contentDigest: "sha256:" + "a".repeat(64), learning: record("taught").learning, provenance: { origin: "inferred", runId: "run_1", trigger: "correction" } } };
  assert.equal(unprovenMerge(taught), false);
});

test("the distillation scenarios are well formed and cover what the capability is now told: bookkeeping is no_change, a correction is a practice, a handbook fits", () => {
  const scenarios = incident.scenarios.distillation;
  assert.equal(new Set(scenarios.map((/** @type {any} */ item) => item.name)).size, scenarios.length);
  for (const item of scenarios) {
    assert.ok(["repair_accepted", "correction", "delivered", "routine"].includes(item.trigger), item.name);
    assert.ok(["researcher", "reviewer", "run"].includes(item.signal), item.name);
    assert.ok(item.lesson.length > 40, item.name);
    assert.ok(item.expect && typeof item.expect === "object", item.name);
  }
  assert.ok(scenarios.some((/** @type {any} */ item) => item.signal === "reviewer" && item.expect.operation === "no_change"), "the gate's bookkeeping");
  assert.ok(scenarios.some((/** @type {any} */ item) => item.signal === "researcher" && item.trigger === "correction" && item.expect.operation === "create"), "a correction");
  assert.ok(scenarios.some((/** @type {any} */ item) => item.expect.maxHandbookChars === 6000), "a handbook that fits the platform's length");
  assert.match(String(incident.liveCheck), /method-distillation 1\.2\.0/);
});
