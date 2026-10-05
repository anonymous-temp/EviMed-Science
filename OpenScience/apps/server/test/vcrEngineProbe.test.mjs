import assert from "node:assert/strict";
import test from "node:test";

import { createVcrEngineProbe } from "../src/vcrEngineProbe.mjs";
import { vcrReadiness } from "../src/vcrService.mjs";
import { jobView, jobWaitsOnEngine } from "../src/vcrViews.mjs";

/** An engine whose `/health` answers as the test says, and counts how often it was asked. */
function engineDouble(answer) {
  const engine = { asked: 0, configured: () => true, async health() { engine.asked += 1; return answer(); } };
  return engine;
}
const down = () => { throw Object.assign(new Error("down"), { code: "vcr_engine_unreachable" }); };

test("configured, answering and not answering are three readings, and a reading nobody has taken is not one of them", async () => {
  assert.equal(createVcrEngineProbe({ engine: null }).snapshot().state, "not_configured");
  assert.equal(createVcrEngineProbe({ engine: { configured: () => false } }).snapshot().state, "not_configured");

  const clock = 1_000_000;
  const up = engineDouble(() => ({ ok: true }));
  const probe = createVcrEngineProbe({ engine: up, ttlMs: 15_000, now: () => clock });
  assert.equal(probe.snapshot().state, "unknown", "before anyone has asked, the answer is that it is not known");
  await probe.refresh();
  assert.deepEqual({ ...probe.snapshot(), checkedAt: null }, { state: "answering", code: null, checkedAt: null });
  assert.equal(up.asked, 1, "the first snapshot started the one refresh, and asking again while it ran joined it");
});

test("a stopped engine reads not answering with the reason, and the next answer reads answering again", async () => {
  let clock = 1_000_000;
  let alive = false;
  const engine = engineDouble(() => (alive ? { ok: true } : down()));
  const probe = createVcrEngineProbe({ engine, ttlMs: 15_000, now: () => clock });
  assert.equal((await probe.refresh()).state, "not_answering");
  assert.equal(probe.snapshot().code, "vcr_engine_unreachable");
  // Fresh: reading it asks nothing more.
  const asked = engine.asked;
  probe.snapshot(); probe.snapshot();
  assert.equal(engine.asked, asked);
  // Stale: a read answers at once from memory and refreshes behind it.
  alive = true; clock += 20_000;
  assert.equal(probe.snapshot().state, "not_answering");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probe.snapshot().state, "answering");
  // An engine that answers but says it is not ok is not answering for this purpose.
  const sick = createVcrEngineProbe({ engine: engineDouble(() => ({ ok: false })) });
  assert.equal((await sick.refresh()).state, "not_answering");
});

test("what the job queue saw is a reading: a failed poll and a good one move it without a health call", () => {
  const engine = engineDouble(() => ({ ok: true }));
  const probe = createVcrEngineProbe({ engine });
  probe.observe(false, "vcr_engine_timeout");
  assert.deepEqual({ state: probe.snapshot().state, code: probe.snapshot().code }, { state: "not_answering", code: "vcr_engine_timeout" });
  probe.observe(true);
  assert.equal(probe.snapshot().state, "answering");
  assert.equal(engine.asked, 0);
  // With no engine composed there is nothing to observe.
  const none = createVcrEngineProbe({ engine: null });
  none.observe(false, "vcr_engine_unreachable");
  assert.equal(none.snapshot().state, "not_configured");
});

test("readiness tells composed from answering, and an engine that is not answering is a warning on a green check", async () => {
  const base = { config: { vcrEnabled: true, vcrAudience: "operators", vcrDataPlaneDir: "/plane" }, database: {} };
  const service = { async ready() { return true; }, engineMismatch: null };
  const ask = async (probe) => vcrReadiness({ ...base, vcr: { service, engine: { configured: () => true }, engineProbe: probe } });

  // Nobody has asked: the engine is composed, and that is all that is known.
  const unknown = await ask(createVcrEngineProbe({ engine: engineDouble(() => ({ ok: true })), ttlMs: 1e9, now: () => 0 }));
  assert.equal(unknown.engine, "wired");
  assert.equal(unknown.warnings, undefined);

  const answering = createVcrEngineProbe({ engine: engineDouble(() => ({ ok: true })) });
  answering.observe(true);
  const upReady = await ask(answering);
  assert.equal(upReady.engine, "answering");
  assert.equal(upReady.warnings, undefined);

  const silent = createVcrEngineProbe({ engine: engineDouble(down) });
  silent.observe(false, "vcr_engine_unreachable");
  const downReady = await ask(silent);
  assert.equal(downReady.status, "ok", "the platform stays ready: an engine down is that capability's to report, not the platform's");
  assert.equal(downReady.engine, "not_answering");
  assert.deepEqual(downReady.warnings, ["vcr_engine_not_answering"]);
  assert.ok(typeof downReady.engineCheckedAt === "string");

  // Not composed at all keeps its own word and its own warning.
  const missing = await vcrReadiness({ ...base, vcr: { service, engine: { configured: () => false }, engineProbe: createVcrEngineProbe({ engine: null }) } });
  assert.equal(missing.engine, "missing");
  assert.deepEqual(missing.warnings, ["vcr_engine_not_composed"]);
});

const NOW = new Date("2026-10-05T08:00:00.000Z");
const row = (patch) => ({ id: "job_1", kind: "design_simulation", state: "running", checkpoint: {}, error: null, progress: {}, updatedAt: NOW.toISOString(), ...patch });

test("a job says it waits on the engine only when its own last contact failed, and only while it is live", () => {
  assert.equal("waitingOn" in jobView(row({}), NOW), false, "a job the engine is working on says nothing");
  assert.equal(jobView(row({ checkpoint: { engineJobId: "job_1", transportError: "vcr_engine_unreachable" } }), NOW).waitingOn, "engine");
  assert.equal(jobView(row({ checkpoint: { engineJobId: "job_1", transportError: "vcr_engine_timeout" } }), NOW).waitingOn, "engine");
  assert.equal(jobView(row({ checkpoint: { engineJobId: "job_1", submissionError: "vcr_engine_unreachable" } }), NOW).waitingOn, "engine",
    "a submit whose reply never came is the same wait");
  // Cleared by the next answer (`vcrJobs.mjs` writes null), so the line goes when the engine is back.
  assert.equal(jobView(row({ checkpoint: { engineJobId: "job_1", transportError: null, submissionError: null } }), NOW).waitingOn, undefined);
  // A refusal is an answer, not silence; and a job that is not live carries no wait whatever its row remembers.
  assert.equal(jobView(row({ checkpoint: { submissionError: "vcr_engine_rejected" } }), NOW).waitingOn, undefined);
  assert.equal(jobView(row({ state: "failed", checkpoint: { transportError: "vcr_engine_unreachable" } }), NOW).waitingOn, undefined);
  assert.equal(jobView(row({ state: "awaiting_budget", checkpoint: { transportError: "vcr_engine_unreachable" } }), NOW).waitingOn, undefined);
  // A job the queue put back for another try after the engine did not answer.
  assert.equal(jobWaitsOnEngine({ state: "queued", error: { code: "vcr_engine_unreachable" }, checkpoint: {} }), true);
  assert.equal(jobWaitsOnEngine({ state: "queued", error: { code: "vcr_job_failed" }, checkpoint: {} }), false);
});
