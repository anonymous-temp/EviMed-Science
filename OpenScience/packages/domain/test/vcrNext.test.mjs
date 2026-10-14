import assert from "node:assert/strict";
import test from "node:test";

import {
  VCR_JOB_KINDS, VCR_JOB_KIND_STEPS, VCR_NEXT_REASONS, VCR_NEXT_REASON_LABELS_ZH, VCR_STEPS, VCR_STEP_ACTION_LABELS_ZH, VCR_STEP_NEEDS,
  VCR_EXPORT_KINDS, vcrNext, vcrVisibleQuestion,
} from "../index.mjs";

/** A study's steps from a short map; every step not named is `none`. @param {Record<string, string>} statuses */
const steps = (statuses) => Object.fromEntries(Object.entries(statuses).map(([step, status]) => [step, { status }]));
const ALL_DONE = Object.fromEntries(VCR_STEPS.map((step) => [step, "done"]));

test("the first unfinished step in the study's own order is next, with the person's verb and object", () => {
  assert.deepEqual(vcrNext({ steps: steps({}) }), { step: "definition", label: "整理研究定义", reason: "start", reasonText: "" });
  assert.equal(vcrNext({ steps: steps({ definition: "done" }) })?.step, "evidence");
  assert.equal(vcrNext({ steps: steps({ definition: "done", evidence: "done" }) })?.step, "population");
  const patients = vcrNext({ steps: steps({ definition: "done", evidence: "done", population: "done" }) });
  assert.deepEqual([patients?.step, patients?.label], ["patients", "生成虚拟患者"]);
  assert.equal(vcrNext({ steps: steps(ALL_DONE) }), null, "everything done: nothing to propose");
  // A deliberate minimal version is finished too: the step is not asked again for it.
  assert.equal(vcrNext({ steps: steps({ ...ALL_DONE, evidence: "minimal" }) }), null);
});

test("a step in flight is not next, and neither is one whose input is still being made", () => {
  // Definition is running: every step needs it, so nothing is proposed — not the evidence that waits on it, not the trial.
  assert.equal(vcrNext({ steps: steps({ definition: "running" }) }), null);
  assert.equal(vcrNext({ steps: steps({ definition: "queued" }) }), null);
  // Population is running: patients needs it (not proposed); the comparator needs only the definition (proposed).
  const state = steps({ definition: "done", evidence: "done", population: "running" });
  assert.equal(vcrNext({ steps: state })?.step, "comparator");
  // The comparator and the trial are in flight with it: the only step left that needs nothing in flight is the matching.
  assert.equal(vcrNext({ steps: steps({ definition: "done", evidence: "done", population: "running", patients: "queued", comparator: "running", trial: "running" }) })?.step, "matching");
  // A step that is queued is never proposed again, whatever its position.
  assert.equal(vcrNext({ steps: steps({ definition: "done", evidence: "queued" }) })?.step, "population");
});

test("a failed or stale step comes by its place in the order and says why", () => {
  const failed = vcrNext({ steps: steps({ definition: "done", evidence: "done", population: "failed" }) });
  assert.deepEqual([failed?.step, failed?.reason, failed?.reasonText], ["population", "retry", "上次没有做完"]);
  const stale = vcrNext({ steps: steps({ definition: "done", evidence: "stale" }) });
  assert.deepEqual([stale?.step, stale?.reason, stale?.reasonText], ["evidence", "refresh", "输入已变更，结果已过期"]);
  // The earlier step wins over a later one that failed: the order is the one the person sees on the step bar.
  assert.equal(vcrNext({ steps: steps({ definition: "done", evidence: "none", trial: "failed" }) })?.step, "evidence");
  // A stale step whose own input is not finished is not offered ahead of it.
  assert.equal(vcrNext({ steps: steps({ definition: "done", population: "failed", patients: "stale" }) })?.step, "evidence");
  assert.equal(vcrNext({ steps: steps({ ...ALL_DONE, patients: "stale" }) })?.step, "patients");
});

test("a study nobody has described has no next step, and the dependency table is the one every step reads", () => {
  assert.equal(vcrNext({ steps: steps({}), described: false }), null);
  assert.equal(vcrNext({ steps: steps({ definition: "done" }), described: false }), null);
  assert.deepEqual(vcrNext({ steps: null }), vcrNext({ steps: {} }), "a missing steps record is a study with nothing done");
  assert.deepEqual(vcrNext(), vcrNext({ steps: {} }));
  // Every permutation of statuses over the seven steps: whatever is proposed is open, not in flight, and has every need finished.
  const statuses = ["none", "queued", "running", "done", "minimal", "stale", "failed"];
  const keys = [...VCR_STEPS];
  let proposals = 0;
  for (let code = 0; code < statuses.length ** 3; code += 1) {
    // Three steps vary, the rest rotate with the code: 343 states of 7 steps is more than enough to walk every dependency edge.
    const state = Object.fromEntries(keys.map((step, index) => [step, statuses[Math.floor(code / statuses.length ** (index % 3)) % statuses.length]]));
    const next = vcrNext({ steps: steps(state) });
    if (!next) continue;
    proposals += 1;
    assert.ok(["none", "stale", "failed"].includes(state[next.step]), `${next.step} proposed from ${state[next.step]}`);
    for (const need of /** @type {Record<string, readonly string[]>} */ (VCR_STEP_NEEDS)[next.step]) {
      assert.ok(["done", "minimal"].includes(state[need]), `${next.step} proposed with ${need} ${state[need]}`);
    }
    assert.ok(VCR_NEXT_REASONS.includes(next.reason));
    assert.equal(next.reasonText, VCR_NEXT_REASON_LABELS_ZH[next.reason]);
  }
  assert.ok(proposals > 50, "the walk proposed steps");
});

test("the visible question of a run is the person's verb and object, and the machine's words never appear in it", () => {
  const words = /** @type {Record<string, string>} */ (VCR_STEP_ACTION_LABELS_ZH);
  for (const step of VCR_STEPS) {
    assert.equal(vcrVisibleQuestion({ purpose: step, steps: [step] }), words[step]);
    assert.ok(words[step].length >= 4 && !/vcr_|exploratory|T0|run/.test(words[step]));
  }
  // One run for the four analysis steps reads as the four, in the study's order, whatever order they were given in.
  assert.equal(vcrVisibleQuestion({ purpose: "analysis", steps: ["trial", "population"] }), "构建人群、模拟试验方案");
  assert.equal(vcrVisibleQuestion({ purpose: "analysis", steps: ["patients"] }), "生成虚拟患者");
  for (const kind of VCR_EXPORT_KINDS) {
    const asked = vcrVisibleQuestion({ purpose: "export", exportKind: kind });
    assert.match(asked, /^生成/, kind);
    assert.doesNotMatch(asked, /_/, "no kind identifier");
  }
  assert.equal(vcrVisibleQuestion({ purpose: "export", exportKind: "simulation_report", revision: true }), "按复核意见修订模拟报告");
  assert.equal(vcrVisibleQuestion({ purpose: "trial_search", subjectKey: "P-0192" }), "为 P-0192 找试验");
  assert.equal(vcrVisibleQuestion({ purpose: "trial_search" }), "为患者找试验");
  assert.equal(vcrVisibleQuestion({ purpose: "evidence_refresh" }), "把新证据纳入假设卡");
  assert.equal(vcrVisibleQuestion({}), "推进研究", "a run that names nothing is the study's work, in no machine words");
});

test("every engine job kind the module can queue says which step it belongs to or is knowingly without one", () => {
  for (const [kind, step] of Object.entries(VCR_JOB_KIND_STEPS)) {
    assert.ok(VCR_JOB_KINDS.includes(kind), `${kind} is a job kind`);
    assert.ok(VCR_STEPS.includes(step), `${kind} → ${step}`);
  }
  // The kinds without a step are the ones a conversation asks for on its own account.
  const without = VCR_JOB_KINDS.filter((kind) => !(kind in VCR_JOB_KIND_STEPS)).sort();
  assert.deepEqual(without, ["benchmark_trial_effect", "compare_forecasts", "evaluate_forecast", "forecast_trajectories"]);
});
