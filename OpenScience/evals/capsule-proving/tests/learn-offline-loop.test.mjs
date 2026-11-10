// The offline learning loop (learn/offlineLoop.mjs) with the fake model: the product's distillation, consolidation and selection run end to
// end without a server, the library survives a restart, and each policy changes only what it says it changes.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OfflineLoop, selectCards, libraryDocuments } from "../learn/offlineLoop.mjs";
import { createModelSteps, fakeLearningModel, filesOfReply } from "../learn/modelSteps.mjs";
import { episodeAsRun, toolNameOf } from "../learn/gameTranscript.mjs";
import { buildDistillationInput } from "../../../apps/server/src/methodDistillationRuns.mjs";
import { createMethodSimilarity } from "../../../apps/server/src/methodSimilarity.mjs";
import { learnFrom } from "../c1/build_library.mjs";

/** A C1 trajectory record as run_c1.py writes it. @param {string} taskId @param {string} task @param {string[]} actions @param {boolean} [success] */
function episode(taskId, task, actions, success = true) {
  return {
    env: "alfworld", fold: "train", taskId, task, success, score: success ? 1 : 0,
    initialObservation: `You are in the middle of a room. Looking quickly around you, you see a fridge 1, a microwave 1 and a countertop 1.\n\nYour task is to: ${task}`,
    steps: actions.map((action, index) => ({ step: index + 1, reply: { text: `Thought: next.\nAction: ${action}` }, action, observation: `You did ${action}.` })),
  };
}

/** A fake model that remembers the inputs it was given. */
function recordingModel() {
  const inner = fakeLearningModel();
  /** @type {any[]} */
  const inputs = [];
  return { inputs, async complete(/** @type {any} */ request) {
    const text = String(request.messages.find((/** @type {any} */ message) => message.role === "user")?.content ?? "");
    const match = text.match(/```json\n([\s\S]*?)\n```/);
    if (match) inputs.push(JSON.parse(match[1]));
    return inner.complete(request);
  } };
}

const HEAT = ["go to countertop 1", "take apple 1 from countertop 1", "go to microwave 1", "heat apple 1 with microwave 1", "go to fridge 1", "put apple 1 in/on fridge 1"];

test("a game episode is a product run: one request, game commands as tool calls by verb, nothing the game says read as a correction", () => {
  assert.equal(toolNameOf("go to fridge 1"), "go to");
  assert.equal(toolNameOf("take apple 1 from countertop 1"), "take");
  assert.equal(toolNameOf("focus on substance in metal pot"), "focus on");
  const record = episode("train/a", "heat some apple and put it in fridge.", HEAT);
  const { run, transcript } = episodeAsRun(record, { finishedAt: "2026-11-10T00:00:00.000Z" });
  const input = buildDistillationInput({ run, trigger: "routine", transcript });
  assert.equal(input.trajectory.requests.length, 1);
  assert.match(input.trajectory.requests[0].text, /Your task is to: heat some apple/);
  assert.deepEqual(input.trajectory.tools, ["go to", "take", "go to", "heat", "go to", "put"]);
  assert.deepEqual(input.trajectory.interventions, []);
  assert.deepEqual(input.corrections, []);
  assert.equal(input.signal, "run");
  assert.equal(input.scope, "alfworld");
  assert.equal(input.trajectory.outcome.status, "succeeded");
});

test("distill, consolidate and select run the product's code; the library and its steps survive a restart", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "c1-offline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const model = recordingModel();
  const loop = await OfflineLoop.open({ dir, env: "alfworld", variant: "pyramid", model });
  const records = [
    episode("train/a", "heat some apple and put it in fridge.", HEAT),
    episode("train/b", "heat some egg and put it in countertop.", HEAT.map((action) => action.replace(/apple/g, "egg"))),
    episode("train/c", "cool some lettuce and put it in countertop.", HEAT.map((action) => action.replace(/apple/g, "lettuce").replace("heat", "cool"))),
  ];
  const first = await loop.distill({ record: records[0], peers: [records[1], records[2]], stepId: "distill:a" });
  assert.equal(first.state, "complete");
  assert.equal(first.operation, "create");
  assert.equal(model.inputs[0].trigger, "routine");
  assert.equal(model.inputs[0].peerRuns.length, 2, "the peers are read from their stored transcripts");
  assert.ok(model.inputs[0].peerRuns.every((/** @type {any} */ peer) => peer.transcriptCompleteness === "complete"));
  await loop.distill({ record: records[1], peers: [records[0], records[2]], stepId: "distill:b" });
  await loop.distill({ record: records[2], peers: [records[0], records[1]], stepId: "distill:c" });
  assert.ok(model.inputs.some((input) => input.trigger === "routine" && input.relatedMethods.length >= 1), "a later lesson is shown the library");
  const sleep = await loop.consolidate({ stepId: "sleep:1" });
  assert.equal(sleep.kind, "sleep");
  const stats = await loop.stats();
  assert.equal(stats.byRole.abstract, 1, "the builder wrote the abstract parent DECIDE named");
  assert.equal(stats.byRole.functional, 3);
  assert.ok(stats.relationsByType.abstract_pattern >= 3);
  assert.equal(stats.byLevel["1"], 1, "with the pyramid on, the abstract method sits one level above its members");

  const pyramid = await loop.select({ taskText: "Your task is to: heat some bread, the same kind of text game task.", mode: "pyramid" });
  assert.equal(pyramid.skills[0].role, "abstract", "the pyramid lists the frame first");
  assert.equal(pyramid.skills[0].level, "abstract");
  for (const skill of pyramid.skills) {
    assert.equal(typeof skill.body, "string");
    assert.ok(Array.isArray(skill.depends_on));
    assert.ok(["similarity", "dependency", "explore", "recent", "abstraction"].includes(skill.reason));
  }
  const without = await loop.select({ taskText: "Your task is to: heat some bread, the same kind of text game task.", mode: "pyramid", removeRoles: ["abstract"] });
  assert.ok(without.skills.every((/** @type {any} */ skill) => skill.role !== "abstract"));

  const status = await readFile(path.join(dir, "STATUS"), "utf8");
  assert.equal(status.trim().split("\n").length, 4);
  const calls = (await readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.every((call) => call.cached || Number.isFinite(call.promptTokens)));

  const reopened = await OfflineLoop.open({ dir, env: "alfworld", variant: "pyramid", model: fakeLearningModel() });
  assert.ok(reopened.done("distill:a") && reopened.done("sleep:1"));
  assert.equal((await reopened.methods()).length, 4);
  const again = await reopened.distill({ record: records[0], stepId: "distill:a" });
  assert.deepEqual(again, first, "a finished step is skipped on resume");
  await assert.rejects(OfflineLoop.open({ dir, env: "alfworld", variant: "pyramid", policy: { consolidate: "none" }, model: fakeLearningModel() }), /another environment or policy/);

  // The export is what an arm reads; selecting from it is the same selection.
  const exported = await reopened.exportTo(path.join(dir, "export.json"));
  const flat = await selectCards({ library: libraryDocuments(exported), taskText: "Your task is to: heat some bread, the same kind of text game task.", mode: "flat", similarity: createMethodSimilarity() });
  assert.ok(flat.skills.every((/** @type {any} */ skill) => skill.reason !== "abstraction"));
  assert.equal(flat.skills.length, 4);
});

test("from-zero shows every lesson an empty related pool; add-only never consolidates", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "c1-offline-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = ["apple", "egg", "bread"].map((food) => episode(`train/${food}`, `heat some ${food} and put it in fridge.`, HEAT.map((action) => action.replace(/apple/g, food))));
  const model = recordingModel();
  const scratch = await OfflineLoop.open({ dir: path.join(dir, "scratch"), env: "alfworld", variant: "from-scratch", policy: { related: "empty" }, model });
  for (const [index, record] of records.entries()) await scratch.distill({ record, peers: records.filter((other) => other !== record), stepId: `distill:${index}` });
  assert.deepEqual(model.inputs.filter((input) => input.trigger === "routine").map((input) => input.relatedMethods.length), [0, 0, 0]);
  assert.equal((await scratch.methods()).length, 3, "the methods are written to the library all the same");

  const addOnly = await OfflineLoop.open({ dir: path.join(dir, "add-only"), env: "alfworld", variant: "add-only", policy: { consolidate: "none" }, model: recordingModel() });
  for (const [index, record] of records.entries()) await addOnly.distill({ record, peers: records.filter((other) => other !== record), stepId: `distill:${index}` });
  assert.equal(await addOnly.consolidate({ stepId: "sleep:1" }), null);
  const stats = await addOnly.stats();
  assert.equal(stats.counters["integrate:runs"] ?? 0, 0);
  assert.ok((stats.counters["skipped:integrate"] ?? 0) >= 3);
  assert.equal(stats.byRole.abstract ?? 0, 0);
});

test("the product's routine gate is read beside the lesson: three clean runs with matching tool chains and similar requests", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "c1-offline-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loop = await OfflineLoop.open({ dir, env: "alfworld", model: fakeLearningModel() });
  const make = (/** @type {string} */ food) => episode(`train/${food}`, `heat some ${food} and put it in fridge.`, HEAT.map((action) => action.replace(/apple/g, food)));
  const one = await loop.lessonFor(make("apple"), []);
  assert.equal(one.productGate, false);
  const third = await loop.lessonFor(make("bread"), [make("apple"), make("egg")]);
  assert.equal(third.productGate, true);
  assert.equal(third.productPeers.length, 2);
  assert.equal(third.nearestPeers.length, 2);
  const odd = episode("train/look", "look at bowl under the desklamp.", ["go to desk 1", "use desklamp 1", "examine bowl 1"]);
  assert.equal((await loop.lessonFor(odd, [make("apple"), make("egg")])).productGate, false, "a different tool chain is not the same routine");
});

test("a package the contract rejects is handed back with the gate's issues and repaired; every call is logged", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "c1-steps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inner = fakeLearningModel();
  let calls = 0;
  /** @type {any[]} */
  const seen = [];
  const model = { async complete(/** @type {any} */ request) {
    calls += 1;
    seen.push(request.messages.length);
    if (calls === 1) return { message: { content: JSON.stringify({ "method-relations.json": JSON.stringify({ schemaVersion: 1, action: "decide" }) }) }, usage: { promptTokens: 5, completionTokens: 2 } };
    return inner.complete(request);
  } };
  const steps = createModelSteps({ model, cacheDir: path.join(dir, "cache"), callsLog: path.join(dir, "calls.jsonl") });
  const request = { dispatchId: "d1", capabilityId: "method-relations", contractKind: "method-relations", question: "Decide.", input: { schemaVersion: 1, action: "decide", methods: [] } };
  await steps.dispatch(request);
  const result = await steps.readResult({ dispatchId: "d1" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.attempts, 2);
  assert.deepEqual(seen, [2, 4], "the rejected reply and the verdict ride in the second attempt");
  assert.deepEqual(result.output.assignments, []);
  const lines = (await readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ok, false);
  assert.ok(lines[0].issues.length > 0);
  // The same prompt again reads the cached answer and asks nothing.
  await steps.dispatch({ ...request, dispatchId: "d2" });
  assert.equal(calls, 2);
  assert.equal(steps.usage.cacheHits, 1);
  assert.deepEqual(filesOfReply("Here:\n```json\n{\"a.json\": {\"x\": 1}}\n```"), { "a.json": JSON.stringify({ x: 1 }, null, 2) });
});

test("the library build teaches successes only, waits for two earlier clean runs, and consolidates on its cadence", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "c1-learn-from-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const foods = ["apple", "egg", "bread", "potato", "tomato"];
  const episodes = foods.map((food, index) => episode(`train/${food}`, `heat some ${food} and put it in fridge.`, HEAT.map((action) => action.replace(/apple/g, food)), index !== 3));
  const loop = await OfflineLoop.open({ dir: path.join(dir, "every"), env: "alfworld", model: fakeLearningModel() });
  const tally = await learnFrom(loop, episodes, { gate: "every-success", sleepEvery: 2, prefix: "" });
  assert.deepEqual([tally.episodes, tally.successes, tally.failures, tally.distilled, tally.sleeps], [5, 4, 1, 2, 2],
    "the first two successes are only peers; the failure teaches nothing; a pass after every second episode");
  assert.ok(tally.productGate >= 1, "the product's own gate is counted beside");
  const gated = await OfflineLoop.open({ dir: path.join(dir, "product"), env: "alfworld", model: fakeLearningModel() });
  const strict = await learnFrom(gated, episodes, { gate: "product", sleepEvery: 0, prefix: "" });
  assert.equal(strict.distilled, strict.productGate);
});
