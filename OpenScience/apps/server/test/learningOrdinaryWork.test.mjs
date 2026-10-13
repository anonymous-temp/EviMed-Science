// The 2026-10-13 incident case "the learning loop ignored ordinary work" (GA21), held against the code it was written for.
//
// evals/method-quality/incidents/2026-10-13-learning-ignored-ordinary-work.json records the two blind spots -- a turn of an ordinary
// conversation left its files where the trigger did not look, and a method was only ever a research method -- and the scenarios that must
// now come out otherwise. The trigger scenarios are decidable and are held here; the distillation scenarios ask a model to judge and are
// evaluation data for a live run, so what is held here is that they are well formed and cover the three things the capability is now
// told (principle 6: an incident becomes a case, not a keyword).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LearningTriggers } from "../src/learningTriggers.mjs";
import { DISTILLATION_EXTRACTOR_VERSION } from "../src/methodDistillationRuns.mjs";

const incident = JSON.parse(await readFile(new URL("../../../evals/method-quality/incidents/2026-10-13-learning-ignored-ordinary-work.json", import.meta.url), "utf8"));
const skill = await readFile(new URL("../../../capabilities/method-distillation/SKILL.md", import.meta.url), "utf8");
const copy = await readFile(new URL("../../../capability-skills/method-distillation/SKILL.md", import.meta.url), "utf8");

const manifest = await readFile(new URL("../../../capabilities/method-distillation/capability.yaml", import.meta.url), "utf8");

const project = { id: "project_1", userId: "user_1" };

test("each trigger scenario comes out as the case says: what the turn left, or what the researcher corrected, queues a lesson in an ordinary conversation", async () => {
  assert.ok(incident.scenarios.triggers.length >= 5);
  for (const [index, scenario] of incident.scenarios.triggers.entries()) {
    const run = {
      id: `run_ordinary_${index}`, sessionId: "session_1", status: "succeeded", effectiveAgentId: "open-domain-answer",
      effectiveRouteReason: "unrouted:open-domain", transcript: { completeness: "complete" },
      startedAt: "2026-10-13T01:00:00.000Z", finishedAt: "2026-10-13T01:05:00.000Z",
      ...scenario.run,
    };
    const triggers = new LearningTriggers({
      jobs: { enqueue: async () => ({ id: "job" }) },
      agentRuns: { list: async () => [run], runWorkflowProjection: async () => null },
    });
    const result = await triggers.afterRun(project, run);
    assert.deepEqual([...result.queued].sort(), [...scenario.expect.queued].sort(), scenario.name);
  }
});

test("the distillation scenarios are well formed and cover what the capability is now told: a way of working is a method, a one-off wish and a task's figure are not, bookkeeping is still no_change", () => {
  const scenarios = incident.scenarios.distillation;
  assert.equal(new Set(scenarios.map((/** @type {any} */ item) => item.name)).size, scenarios.length);
  for (const item of scenarios) {
    assert.ok(["repair_accepted", "correction", "delivered", "routine"].includes(item.trigger), item.name);
    assert.ok(["researcher", "reviewer", "run"].includes(item.signal), item.name);
    assert.ok(item.lesson.length > 40, item.name);
    assert.ok(item.expect && typeof item.expect === "object", item.name);
  }
  assert.ok(scenarios.filter((/** @type {any} */ item) => item.expect.operation === "create" && item.expect.namesAWayOfWorking).length >= 2, "a report's shape and a script's conventions");
  assert.ok(scenarios.some((/** @type {any} */ item) => item.expect.operation === "no_change" && /one-off/.test(item.expect.reason)), "a one-off wish");
  assert.ok(scenarios.some((/** @type {any} */ item) => item.expect.operation === "no_change" && /bookkeeping/.test(item.expect.reason)), "the gate's bookkeeping");
});

test("the skill says what the case says it must, in the capability and in its copy, and a lesson read under the old definition is a new dispatch", () => {
  assert.equal(copy, skill, "capability-skills/ carries the same bytes");
  assert.match(skill, /how this\s+person does this kind of work/);
  assert.match(skill, /weekly report/);
  assert.match(skill, /conventions a\s+script is held to/);
  assert.match(skill, /a one-off wish/);
  assert.match(skill, /EviMed's own delivery bookkeeping/, "the 2026-10-12 ruling stands");
  assert.match(String(incident.liveCheck), /method-distillation 1\.3\.0/);
  assert.match(manifest, /^version: 1\.3\.0$/m);
  assert.equal(DISTILLATION_EXTRACTOR_VERSION, "7");
});
