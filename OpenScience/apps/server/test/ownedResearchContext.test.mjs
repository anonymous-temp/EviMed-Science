import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createOwnedHandbookSelector, createOwnedResearchContext } from "../src/ownedResearchContext.mjs";
import { platformTrialContext } from "../src/capabilityHandbooks.mjs";
import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import { HandbookConsolidation } from "../src/handbookConsolidation.mjs";
import { fixture, registry } from "./helpers/handbookFixture.mjs";

async function setup(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-owned-context-"));
  const project = { id: "research", userId: "alice", baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await fs.mkdir(project.workspaceDir); await fs.mkdir(project.metaDir);
  const f = fixture(); await f.learning.recordHandbookCandidate("alice", f.input());
  await new HandbookConsolidation({ ...f, registry }).run({ job: f.queued[0] });
  const receipts = [], audits = [];
  const runtime = { mountedMethodPromptBytes: 0 };
  const config = { learningEnabled: true, maxFileBytes: 1048576, maxProjectBytes: 16777216, maxWorkspaceScanEntries: 100, mountedMethodPromptBytes: 8000 };
  const deps = { learning: f.learning, registry: Promise.resolve(registry), config,
    runtimeManager: { key: () => "key", runtimes: new Map([["key", runtime]]) },
    agentRuns: { recordLearning: async (...args) => receipts.push(args) },
    paused: async () => ({ learning: false, trial: false }), audit: async (...args) => audits.push(args) };
  const run = { id: "next-run", effectiveAgentId: "geo-content", dispatchId: "geo:research:one" };
  try { await fn({ f, project, deps, runtime, receipts, audits, run }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("owned GEO and autonomous research consume exactly the supplement recorded before dispatch", () => setup(async ({ project, deps, receipts, run }) => {
  const prepare = createOwnedResearchContext(deps);
  for (const dispatchId of ["geo:research:one", "autopilot:research:one", "chat-one"]) {
    const result = await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, { ...run, dispatchId });
    assert.equal(result.handbooks.length, 1);
    assert.match(result.system, /Keep denominators tied/);
    assert.deepEqual(receipts.at(-1), [project, run.id, { capabilityHandbooks: result.handbooks }]);
  }
}));

test("supplements share remaining mounted-method bytes and never assume an unknown runtime is empty", () => setup(async ({ project, deps, runtime, receipts, run }) => {
  const prepare = createOwnedResearchContext(deps);
  runtime.mountedMethodPromptBytes = 7999;
  assert.equal((await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, run)).handbooks.length, 0);
  deps.runtimeManager.runtimes.clear();
  assert.equal((await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, run)).handbooks.length, 0);
  assert.equal(receipts.length, 0);
}));

test("paused learning and foreign owners get no supplement", () => setup(async ({ project, deps, run }) => {
  let prepare = createOwnedResearchContext({ ...deps, paused: async () => ({ learning: true }) });
  assert.equal((await prepare(project, { mode: "specialist", agentId: "geo-content" }, {}, run)).handbooks.length, 0);
  prepare = createOwnedResearchContext(deps);
  assert.equal((await prepare({ ...project, userId: "bob" }, { mode: "specialist", agentId: "geo-content" }, {}, run)).handbooks.length, 0);
}));

test("supplement IO failure is audited without vetoing ordinary research", () => setup(async ({ project, deps, audits, run }) => {
  await fs.symlink(project.metaDir, path.join(project.workspaceDir, ".evimed-handbooks"));
  const result = await createOwnedResearchContext(deps)(project, { mode: "specialist", agentId: "geo-content" }, {}, run);
  assert.equal(result.handbooks.length, 0);
  assert.ok(result.system.length > 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0][0], "handbook.context");
}));

/* ---------------------------------------------------- the platform's entry on probation rides a sampled dispatch (review L-6) */

const TRIAL = { entryId: "entry-1", version: 1, capabilityId: "geo-content",
  text: { name: "denominator-check", description: "Check study denominators.", body: "Name the population every count refers to, and say so when the source gives none." } };
const SPECIALIST = { mode: "specialist", agentId: "geo-content" };

test("a dispatch the platform sampled carries its probation entry in the model's context and nowhere else: not the run's learning record, not the account's supplements, nothing of where it came from", () => setup(async ({ project, deps, receipts, run }) => {
  /** @type {any[]} */ const asked = [];
  const plain = await createOwnedResearchContext(deps)(project, SPECIALIST, {}, run);
  const result = await createOwnedResearchContext({ ...deps, platformTrial: async (input) => { asked.push(input); return TRIAL; } })(project, SPECIALIST, {}, run);
  assert.match(result.system, /<evimed-platform-handbook capability="geo-content">/);
  assert.match(result.system, /Name the population every count refers to/);
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].project, asked[0].run, asked[0].capabilityId], [project, run, "geo-content"]);
  // The account's own supplement and the run's record are what they were.
  assert.deepEqual(result.handbooks, plain.handbooks);
  assert.equal(result.handbooks.length, 1);
  assert.deepEqual(receipts.at(-1), [project, run.id, { capabilityHandbooks: result.handbooks }]);
  assert.equal(JSON.stringify([result.handbooks, receipts]).includes("entry-1"), false);
  assert.equal(result.system.includes("entry-1"), false, "the model is not told which entry it is");
  // Everything else of the prompt is the prompt it would have been.
  assert.equal(result.system.replace(`\n${platformTrialContext(TRIAL)}`, ""), plain.system);
  assert.equal(plain.system.includes("evimed-platform-handbook"), false);
}));

test("the platform's probation entry is asked for only on a researcher's own run the learning loop may touch: not paused, not with learning off, not in an internal project, not a harness's or the loop's own run", () => setup(async ({ project, deps, run }) => {
  /** @type {string[]} */ const asked = [];
  const platformTrial = async (/** @type {any} */ input) => { asked.push(input.run.id); return TRIAL; };
  const refused = [
    ["paused", createOwnedResearchContext({ ...deps, platformTrial, paused: async () => ({ learning: true, trial: false }) }), project, run],
    ["learning off", createOwnedResearchContext({ ...deps, platformTrial, config: { ...deps.config, learningEnabled: false } }), project, run],
    ["an internal project", createOwnedResearchContext({ ...deps, platformTrial }), { ...project, id: LEARNING_PROJECT_ID }, run],
    ["a harness's run", createOwnedResearchContext({ ...deps, platformTrial }), project, { ...run, automated: true }],
    ["the loop's own run", createOwnedResearchContext({ ...deps, platformTrial }), project, { ...run, effectiveAgentId: "method-distillation" }],
  ];
  for (const [label, prepare, scoped, scopedRun] of /** @type {any[]} */ (refused)) {
    assert.equal((await prepare(scoped, SPECIALIST, {}, scopedRun)).system.includes("evimed-platform-handbook"), false, label);
  }
  assert.deepEqual(asked, []);
  // A researcher's own run is asked, and so is managed research they commissioned.
  const prepare = createOwnedResearchContext({ ...deps, platformTrial });
  assert.match((await prepare(project, SPECIALIST, {}, run)).system, /evimed-platform-handbook/);
  assert.match((await prepare(project, SPECIALIST, {}, { ...run, id: "managed-run", automated: true, effectiveRouteReason: "autopilot:research:one" })).system, /evimed-platform-handbook/);
  assert.deepEqual(asked, [run.id, "managed-run"]);
  // A conversation typed in the kernel's own frame has no run to record an exposure against: its selector never asks.
  asked.length = 0;
  const selected = await createOwnedHandbookSelector({ ...deps, platformTrial })(project, SPECIALIST, {}, run);
  assert.equal(selected.context.includes("evimed-platform-handbook"), false);
  assert.deepEqual(asked, []);
}));

test("the entry takes only the prompt room the account's supplements left: the fit it is offered counts their bytes, to the byte, and an unknown runtime has no room", () => setup(async ({ project, deps, runtime, run }) => {
  /** @type {any[]} */ const fits = [];
  const prepare = createOwnedResearchContext({ ...deps, platformTrial: async (input) => { fits.push(input.fits); return null; } });
  const { selection } = await createOwnedHandbookSelector(deps)(project, SPECIALIST, {}, run);
  assert.ok(selection.bytes > 0, "the account's supplement is in the room");
  const room = deps.config.mountedMethodPromptBytes - selection.bytes;
  // The block a one-character body makes: any longer body adds one byte a character, and the fit counts a newline after the block.
  const overhead = Buffer.byteLength(platformTrialContext({ capabilityId: "geo-content", text: { body: "x" } }));
  const text = (/** @type {number} */ length) => ({ name: "", description: "", body: "x".repeat(length) });
  await prepare(project, SPECIALIST, {}, run);
  assert.equal(fits[0](text(room - overhead)), true, "exactly the room that is left fits");
  assert.equal(fits[0](text(room - overhead + 1)), false, "one byte more does not");
  assert.equal(fits[0](text(10)), true);
  // What the runtime has already mounted is gone from the room too, and an unknown runtime is not assumed empty.
  runtime.mountedMethodPromptBytes = deps.config.mountedMethodPromptBytes - 1;
  await prepare(project, SPECIALIST, {}, run);
  assert.equal(fits[1](text(10)), false);
  deps.runtimeManager.runtimes.clear();
  await prepare(project, SPECIALIST, {}, run);
  assert.equal(fits[2](text(10)), false);
}));

test("a probation lookup that fails costs the run nothing: the prompt is the ordinary one and the failure is audited", () => setup(async ({ project, deps, audits, run }) => {
  const plain = await createOwnedResearchContext(deps)(project, SPECIALIST, {}, run);
  const result = await createOwnedResearchContext({ ...deps, platformTrial: async () => { throw Object.assign(new Error("ledger down"), { code: "evolution_ledger_down" }); } })(project, SPECIALIST, {}, run);
  assert.equal(result.system, plain.system);
  assert.equal(result.handbooks.length, 1);
  assert.deepEqual(audits.map((entry) => [entry[0], entry[1], entry[2].code, entry[2].runId]), [["handbook.platform_trial", "failed", "evolution_ledger_down", run.id]]);
  const unnamed = await createOwnedResearchContext({ ...deps, platformTrial: async () => { throw new Error("down"); } })(project, SPECIALIST, {}, run);
  assert.equal(unnamed.system, plain.system);
  assert.equal(audits.at(-1)[2].code, "platform_trial_unavailable");
}));
