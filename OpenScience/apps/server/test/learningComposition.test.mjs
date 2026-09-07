// Built, tested, and actually wired.
//
// `runtimeManager.capsuleService` was never assigned in the composition root,
// so the capsule method mount was dark in every real deployment while its own
// tests stayed green — a whole feature that existed everywhere except in the
// one place that runs. Every service the learning loop adds is exposed to the
// same failure, and a unit test of a service cannot see it. So this file reads
// the composition root as text and asserts each piece is reachable from it.
//
// And then the same failure happened here anyway, one level in. Every learning
// service was imported, constructed, started, drained and closed — this file
// asserted all five — and `recordObservation` still had no caller, so the
// counters every promotion reads stayed at zero forever. Reachable is not fed.
// The last test in this file is the one that would have caught it, and it is
// written against the producers rather than the services.
//
// A source scan is a weak test in general and the right one here: the thing
// being asserted is *that a name appears in a list*, and the lists
// (`pauseRecurringWork`, `backgroundOperations`, the start and close blocks)
// are read by name at runtime too.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

test("every learning module the loop needs is imported by the composition root", () => {
  for (const module of [
    "./runTranscripts.mjs",
    "./learningService.mjs",
    "./learningRuntime.mjs",
    "./learningRoutes.mjs",
    "./methodDistillationRuns.mjs",
    "./methodConsolidation.mjs",
    "./learningWorker.mjs",
    "./recordedGateway.mjs",
  ]) {
    assert.match(serverSource, new RegExp(`from "${module.replace(".", "\\.")}"`), `${module} is never imported`);
  }
});

test("the learning worker is in all four lists that decide whether it runs", () => {
  // Constructed, started, drained for maintenance, closed on shutdown, and
  // counted as background work. Missing from the drain list, it keeps claiming
  // jobs straight through a maintenance window and nothing reports it; missing
  // from `backgroundOperations`, a drain believes the system is idle mid-job.
  assert.match(serverSource, /learningWorker = new LearningWorker\(\{/);
  assert.match(serverSource, /learningWorker\?\.start\(\);/);
  assert.match(serverSource, /await learningWorker\?\.close\(\);/);
  assert.match(serverSource, /learningWorker\?\.status\?\.\(\)\.running,/);
  const drain = /const pauseRecurringWork = \(\) => \{[\s\S]*?\n  \};/.exec(serverSource);
  assert.ok(drain, "pauseRecurringWork is gone; this test now checks nothing");
  const timerLists = [...drain[0].matchAll(/for \(const worker of \[([^\]]*)\]\)/g)].map((match) => match[1]);
  assert.equal(timerLists.length, 2, "the drain no longer clears two kinds of timer");
  for (const list of timerLists) {
    assert.match(list, /learningWorker/, `the drain list ${JSON.stringify(list)} omits the learning worker`);
  }
});

test("the transcript is captured before anything can decide not to", () => {
  const hook = /onRunFinished: async \(project, run\) => \{[\s\S]*?\n    \},/.exec(serverSource);
  assert.ok(hook, "onRunFinished is gone; this test now checks nothing");
  const capture = hook[0].indexOf("persistRunTranscript");
  const memosGuard = hook[0].indexOf("if (!memosClient.configured)");
  assert.ok(capture > 0, "the terminal hook no longer persists the transcript");
  assert.ok(memosGuard > 0, "the Memos early-return is gone");
  assert.ok(capture < memosGuard,
    "the transcript capture moved below the Memos early-return; a deployment without a memory service would stop recording runs");
});

test("the transcript capture and the distill enqueue each report their own failure", () => {
  const hook = /onRunFinished: async \(project, run\) => \{[\s\S]*?\n    \},/.exec(serverSource)[0];
  // A throw inside this callback is caught by finishInternal and then caught
  // again, so a step that does not audit for itself fails invisibly.
  assert.match(hook, /securityAudit\(config, "run\.transcript\.persist", "failed"/);
  assert.match(hook, /securityAudit\(config, "learning\.distill\.enqueue", "failed"/);
});

test("only a run worth learning from is queued, and only a complete record of it", () => {
  const hook = /onRunFinished: async \(project, run\) => \{[\s\S]*?\n    \},/.exec(serverSource)[0];
  const enqueue = /if \(learningWorker && productJobs && run\.status === "succeeded"\) \{[\s\S]*?\n      \}/.exec(hook);
  assert.ok(enqueue, "the distill producer is gone");
  assert.match(enqueue[0], /rounds >= 1/, "a run that needed no repair is not evidence of anything");
  assert.match(enqueue[0], /run\.transcript\?\.completeness === "complete"/,
    "a partial transcript would teach a lesson drawn from evidence the loop cannot see");
  assert.match(enqueue[0], /idempotencyKey: `distill:\$\{run\.id\}:repair_accepted`/);
});

test("the counters have a producer, which is the whole difference between wired and working", () => {
  // Each of these names is a counter movement no other code path can make.
  // Without the first two, `learning.counts` never leaves zero,
  // `evaluationEligible` is false forever, and a distillation loop that runs
  // every night can never promote anything it writes.
  assert.match(serverSource, /const recordMethodUse = async \(\{ project, run, sessions \}\) => \{/);
  assert.match(serverSource, /learningService\.recordObservation\(/, "no producer for the success counters");
  assert.match(serverSource, /learningService\.recordEligible\(/, "no producer for the denominator");
  assert.match(serverSource, /runMethodObservations\(\{ run, projection, methods, sessions \}\)/);
  assert.match(serverSource, /methodsLoaded: derived\.methodsLoaded/, "the ledger's mounted-method receipt has no writer");

  // Fed from the same terminal hook that captured the transcript, and inside
  // the tracked write: it reads the run's projection and the sessions, both of
  // which stop being readable once the container is released.
  const hook = /onRunFinished: async \(project, run\) => \{[\s\S]*?\n    \},/.exec(serverSource)[0];
  const capture = hook.indexOf("persistRunTranscript");
  const feed = hook.indexOf("await recordMethodUse(");
  assert.ok(feed > 0, "the terminal hook no longer feeds the counters");
  assert.ok(capture < feed, "the feed must follow the capture that proves the sessions were readable");
  assert.match(hook.slice(0, feed), /await trackLearningWrite\(/,
    "an untracked feed can outlive close and write into a store that has gone away");
});

test("the projection the feed attributes against is the run's own, not whatever is on disk", () => {
  // Attribution names deliverables. A projection belonging to a different run
  // holds different deliverable ids, and the failure would not be an error —
  // it would be confident credit assigned to the wrong work.
  assert.match(serverSource, /await agentRuns\.runWorkflowProjection\(project, run\)/);
  assert.match(serverSource, /if \(!projection\) return;/);
});

test("the retention knob has a caller, and it runs whether or not the loop is spending", async () => {
  // `TRANSCRIPT_RETENTION_DAYS` was configuration with no reader: a deployment
  // could set it and every project would still keep every conversation forever.
  assert.match(serverSource, /maintain: async \(\) => \{/);
  assert.match(serverSource, /pruneRunTranscripts\(project, \{ retentionDays: config\.transcriptRetentionDays \}\)/);
  const worker = await readFile(new URL("../src/learningWorker.mjs", import.meta.url), "utf8");
  // On the reconcile timer, not inside `tick` — `tick` returns early when the
  // loop is disabled or outside its spending window, and deleting old files is
  // not spending. A deployment that switched the loop off after trying it is
  // exactly the one whose transcripts nobody would otherwise prune.
  assert.match(worker, /\.then\(\(\) => this\.maintain\(\)\)/);
  const reconcile = /async reconcile\(\) \{[\s\S]*?\n  \}/.exec(worker);
  assert.ok(reconcile, "reconcile is gone; this test now checks nothing");
  assert.ok(!/claimBlockedReason/.test(reconcile[0]), "maintenance must not be gated on the spending window");
});

test("the library cap reaches the nightly proposals, not just the domain", async () => {
  const service = await readFile(new URL("../src/learningService.mjs", import.meta.url), "utf8");
  assert.match(service, /libraryEvictions\(/, "an unbounded library is the failure mode with no symptom");
  // Applied to what survives the per-method rules, so a method already proposed
  // is not proposed twice with two different reasons.
  assert.match(service, /const proposed = new Set\(proposals\.map/);
});

test("the method routes are dispatched, and there is no route that approves anything", async () => {
  assert.match(serverSource, /if \(await learningRoutes\(req, res\)\) return;/);
  const routes = await readFile(new URL("../src/learningRoutes.mjs", import.meta.url), "utf8");
  assert.ok(!/"approve"/.test(routes), "an approve route would be the approval queue the design refuses");
  assert.ok(!/service\.approve\(/.test(routes), "no route may call approve; promotion happens against evidence in the nightly job");
  for (const route of ["retire", "rollback"]) {
    assert.match(routes, new RegExp(`parts\\[1\\] === "${route}"`), `${route} is the reversal the design promises`);
  }
});

test("the public-source gateway can be pointed at fixtures without changing the gateway", () => {
  assert.match(serverSource, /resolveGatewayFetch\(process\.env, overrides\.publicSourceFetch \?\? globalThis\.fetch\)/);
  assert.match(serverSource, /fetchImpl: gatewayFetch,/);
});

test("the learning loop is off unless a deployment turns it on", async () => {
  const config = await readFile(new URL("../src/config.mjs", import.meta.url), "utf8");
  assert.match(config, /learningEnabled: overrides\.learningEnabled \?\? boolEnv\("OPEN_SCIENCE_LEARNING_ENABLED", false\)/,
    "every other subsystem defaults on in production; this one costs model calls nobody asked for");
  assert.match(serverSource, /if \(learningService && productJobs && config\.learningEnabled\)/);
});

test("a terminal write in flight is waited for before the store it writes into goes away", () => {
  // Found by a temp directory that would not remove: onRunFinished fires from
  // the run store's own monitor, so a transcript write can land after close was
  // asked for. In a test that races the directory removal; in production it
  // races the runtime teardown the write depends on.
  assert.match(serverSource, /const learningWrites = new Set\(\);/);
  assert.match(serverSource, /await trackLearningWrite\(\(async \(\) => \{/);
  const close = /async close\(\) \{[\s\S]*?\n    \},/.exec(serverSource);
  assert.ok(close, "close is gone; this test now checks nothing");
  const wait = close[0].indexOf("await Promise.allSettled([...learningWrites])");
  const runtimes = close[0].indexOf("await runtimeManager.closeAll()");
  assert.ok(wait > 0, "close no longer waits for terminal learning writes");
  assert.ok(wait < runtimes, "the wait moved after the runtimes it depends on");
});
