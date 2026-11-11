// The training camp's lesson and two-stage distillation (plan 2026-11-04 §5.2, §5.3), both behind lab switches that default to today's loop:
// `OPEN_SCIENCE_LEARNING_CAMP_ENABLED` and `OPEN_SCIENCE_METHOD_TWO_STAGE_DISTILLATION_ENABLED`.
//
// The first block pins the "off" side byte for byte: the frozen input, the dispatch question and the dispatch identity of four fixed lessons,
// and the skill text, are exactly what they were before either switch existed (digests computed from the pre-change code with the same
// fixtures, `helpers/distillationFixtures.mjs`).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, parseSkillFrontmatter, runGate } from "@evimed/domain";

import { loadConfig } from "../src/config.mjs";
import { campLessonFor } from "../src/learningTriggers.mjs";
import { LearningService, learnedMethodId } from "../src/learningService.mjs";
import {
  CAMP_TRIGGER, DISTILLATION_TRIGGERS, METHOD_FRAME_CONTRACT, MethodDistillationRuns, buildDistillationInput, distillationSkillVariants, evidenceCorpus,
  verifiedEvidence,
} from "../src/methodDistillationRuns.mjs";
import { dispatchedFor, identityFixtures, inputArguments, projectFor } from "./helpers/distillationFixtures.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = (/** @type {unknown} */ value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const repoRoot = path.resolve(import.meta.dirname, "../../..");

/** What each fixed lesson was before the switches: input, question, dispatched input, dispatch identity and contract. */
const PINNED = {
  routine: { input: "a832dd384098fcfcf76497a62b5f06b253cd1370b45c81493e480565f4eaab3d", question: "9d937db6503f737de6441f4b0b9f7b10e82975b40d8410d231b11b9a58b6756f",
    dispatched: "c1b00d086a76625a9bbe46d471e32329116901aaaed884d06fd47a2dbd8ecd45", identity: "e776e1ebdfcd5b58c7a0537aff7360a7b5a9593648e9125a0b608f2afdf4530e" },
  correction: { input: "e93f467deaeec9b5b48008a8ae57e6b8e3cbbdd875e21c1f002039dbd455f414", question: "a12063d8366ea6ca6aacd7149d82444e3b30da46e4144cb00c1712e0c185e247",
    dispatched: "d7b01a6cd6108e24a01d891ad48e55491b45f958b828388c7d1aec22a3fffd69", identity: "1e99a16672acfafedbce2b0ffac6b01450919409d8fb6ed3c096026ff1e9fe1e" },
  adopted: { input: "485b39902964826b29f063c188b94994efcb1164e7423050ca069828a6bcc50f", question: "a12063d8366ea6ca6aacd7149d82444e3b30da46e4144cb00c1712e0c185e247",
    dispatched: "75d4fa18e4a4fc8ee67c562a6e365edaf44475fcdc3c8c7aa69fdabf4ddafe94", identity: "f6d770a1ec3f337b231541dda13972f299d6ec1dcbc0effeb0e169e4bf01c977" },
  edit: { input: "f23d742547f6375c2ce23c48771899bbc5840d2ba6a6f6f0cd71015baedc3f00", question: "a12063d8366ea6ca6aacd7149d82444e3b30da46e4144cb00c1712e0c185e247",
    dispatched: "ad7f9f54cd685f06b07cf45282ebb7ad5c5800c8f6bf4fecb4011bed0e17cc6e", identity: "0bc578048184082e3fc2113d37d75cf3fb4427a859907e56f342339a53f55452" },
};
/** The method-distillation SKILL.md before the switches (both copies). */
const SKILL_SHA256 = "7ae51ed377416bd6a526360d7224417786893a80baedfac6ed3bbad270beb161";

/* ------------------------------------------------------------------------------------------------------------- off: byte-identical */

test("with both switches off, every fixed lesson's input, question and dispatch identity are byte-identical to before", async () => {
  for (const fixture of identityFixtures()) {
    const pinned = PINNED[/** @type {keyof typeof PINNED} */ (fixture.label)];
    assert.equal(sha(buildDistillationInput(inputArguments(fixture))), pinned.input, `${fixture.label}: input`);
    const dir = await mkdtemp(path.join(tmpdir(), "distill-identity-"));
    try {
      // Constructed with the switches named and off, and with them absent: both are today's loop.
      for (const options of [{}, { camp: false, twoStage: false }]) {
        const requests = await dispatchedFor(MethodDistillationRuns, dir, fixture, options);
        assert.equal(requests.length, 1, `${fixture.label}: one step`);
        assert.equal(sha(requests.map((request) => request.question)), pinned.question, `${fixture.label}: question`);
        assert.equal(sha(requests.map((request) => request.input)), pinned.dispatched, `${fixture.label}: dispatched input`);
        assert.equal(sha(requests.map((request) => [request.dispatchId, request.contractKind])), pinned.identity, `${fixture.label}: identity`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("the skill text is unchanged: SKILL.md and its shipped copy are the pre-switch bytes, and no section is selected when none is on", async () => {
  const authored = await readFile(path.join(repoRoot, "capabilities/method-distillation/SKILL.md"), "utf8");
  const shipped = await readFile(path.join(repoRoot, "capability-skills/method-distillation/SKILL.md"), "utf8");
  assert.equal(sha(authored), SKILL_SHA256);
  assert.equal(shipped, authored);
  assert.equal(await distillationSkillVariants([]), "");
  await assert.rejects(distillationSkillVariants(["three-stage"]), /Unknown method-distillation skill variant/);
});

/** @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try {
    return loadConfig({ rootDir: repoRoot });
  } finally {
    process.env = saved;
  }
}

test("both switches are off by default and read from their environment variables", () => {
  const off = configUnder({});
  assert.equal(off.learningCampEnabled, false);
  assert.equal(off.methodTwoStageDistillationEnabled, false);
  const on = configUnder({ OPEN_SCIENCE_LEARNING_CAMP_ENABLED: "true", OPEN_SCIENCE_METHOD_TWO_STAGE_DISTILLATION_ENABLED: "true" });
  assert.equal(on.learningCampEnabled, true);
  assert.equal(on.methodTwoStageDistillationEnabled, true);
});

/* ------------------------------------------------------------------------------------------------------------------ the camp lesson */

const ROOT = "ses_game";
/** A finished game-like run: the request, then one assistant message per step (reasoning text and one tool call). */
function campRun({ success, steps = 30, longOutput = 0 }) {
  const runId = success ? "run_camp_won" : "run_camp_lost";
  const messages = [{ sessionId: ROOT, seq: 0, turnStartSeq: 0, sourceRequestId: "req_g", role: "user", source: "user",
    parts: [{ type: "text", text: "Your task is to: put a clean mug on the shelf." }] }];
  for (let step = 1; step <= steps; step += 1) {
    messages.push({ sessionId: ROOT, seq: step, turnStartSeq: 0, role: "assistant", source: "system", parts: [
      { type: "text", text: `Thought: step ${step}, I should check the sink before carrying the mug.\nAction: go to place ${step}` },
      { type: "tool", tool: "go to", callID: `call-${step}`, input: { command: `go to place ${step}` }, output: `You arrive at place ${step}.${" On it you see a mug, a plate and a towel.".repeat(Math.ceil(longOutput / 42))}` },
    ] });
  }
  const transcript = { header: { schemaVersion: 1, runId, capturedAt: "2026-11-10T00:00:00.000Z", completeness: "complete",
    sessions: [{ sessionId: ROOT, parentSessionId: null, seedEndSeq: -1 }], missing: [] }, messages };
  const run = { id: runId, sessionId: ROOT, kernelRequestIds: ["req_g"], status: success ? "succeeded" : "failed", effectiveAgentId: "alfworld" };
  return { run, transcript };
}

test("campLessonFor raises a lesson only with the switch on, for a finished run whose outcome a checker decided", () => {
  const { run } = campRun({ success: false });
  const outcome = { success: false, score: 0, verdict: "Not completed." };
  assert.equal(campLessonFor({ run, outcome, enabled: false }), null);
  assert.equal(campLessonFor({ run, outcome }), null, "off by default");
  assert.equal(campLessonFor({ run: { ...run, status: "running" }, outcome, enabled: true }), null);
  assert.equal(campLessonFor({ run, outcome: { score: 3 }, enabled: true }), null, "no machine-checked outcome, no lesson");
  const lesson = campLessonFor({ run, outcome, anchors: [{ seq: 4 }, { seq: -1 }, { seq: 9, kind: "decisive" }], enabled: true });
  assert.equal(lesson?.trigger, CAMP_TRIGGER);
  assert.equal(lesson?.idempotencyKey, `distill:${run.id}:camp`);
  assert.deepEqual(lesson?.payload.outcome, { success: false, score: 0, verdict: "Not completed." });
  assert.deepEqual(lesson?.payload.anchors, [{ seq: 4, kind: "decisive" }, { seq: 9, kind: "decisive" }]);
  assert.equal(lesson?.payload.scope, "alfworld");
  assert.equal(DISTILLATION_TRIGGERS.includes(CAMP_TRIGGER), false, "not one of the product's own triggers");
});

test("a camp lesson is refused with the switch off, exactly as an unknown trigger is", () => {
  const { run, transcript } = campRun({ success: true });
  assert.throws(() => buildDistillationInput({ run, trigger: CAMP_TRIGGER, transcript }), (error) => /** @type {any} */ (error).code === "distillation_trigger_invalid");
  assert.throws(() => buildDistillationInput(/** @type {any} */ ({ run, trigger: CAMP_TRIGGER, transcript, campEnabled: false, camp: {} })),
    (error) => /** @type {any} */ (error).code === "distillation_trigger_invalid");
});

test("a success is read around its decisive steps; a failure adds its closing steps and the checker's verdict", () => {
  const won = campRun({ success: true });
  const lessonWon = /** @type {any} */ (campLessonFor({ run: won.run, outcome: { success: true, score: 1, verdict: "Completed." }, anchors: [{ seq: 5 }, { seq: 30 }], enabled: true }));
  const input = buildDistillationInput(/** @type {any} */ ({ run: won.run, trigger: CAMP_TRIGGER, transcript: won.transcript, campEnabled: true, camp: lessonWon.payload }));
  assert.equal(input.trigger, "camp");
  assert.equal(input.signal, "run");
  assert.deepEqual(input.camp, { outcome: { success: true, score: 1, verdict: "Completed." } });
  assert.deepEqual(input.transcriptExcerpts.map((/** @type {any} */ excerpt) => [excerpt.anchor.kind, excerpt.seqRange]), [["decisive", [2, 8]], ["decisive", [27, 30]]]);

  const lost = campRun({ success: false });
  const lessonLost = /** @type {any} */ (campLessonFor({ run: lost.run, outcome: { success: false, score: 0, verdict: "Not completed in 30 steps." }, anchors: [{ seq: 5 }], enabled: true }));
  const failed = buildDistillationInput(/** @type {any} */ ({ run: lost.run, trigger: CAMP_TRIGGER, transcript: lost.transcript, campEnabled: true, camp: lessonLost.payload }));
  assert.deepEqual(failed.transcriptExcerpts.map((/** @type {any} */ excerpt) => [excerpt.anchor.kind, excerpt.seqRange]), [["decisive", [2, 8]], ["closing", [23, 30]]]);
  assert.equal(failed.camp.outcome.verdict, "Not completed in 30 steps.");
  // Its reasoning can be quoted; the stored quotation is checked against what the lesson was shown.
  const kept = verifiedEvidence([{ runId: lost.run.id, seqRange: [29, 29], quote: "step 29, I should check the sink before carrying the mug." }], evidenceCorpus(failed));
  assert.equal(kept.kept.length, 1);
});

test("a camp lesson's excerpts are bounded in bytes, a long step clipped head and tail, and what does not fit counted", () => {
  const { run, transcript } = campRun({ success: false, steps: 60, longOutput: 5_000 });
  const anchors = Array.from({ length: 12 }, (_, index) => ({ seq: 4 + index * 5 }));
  const lesson = /** @type {any} */ (campLessonFor({ run, outcome: { success: false, score: 0, verdict: "" }, anchors, enabled: true }));
  const input = buildDistillationInput(/** @type {any} */ ({ run, trigger: CAMP_TRIGGER, transcript, campEnabled: true, camp: lesson.payload }));
  const bytes = input.transcriptExcerpts.reduce((/** @type {number} */ sum, /** @type {any} */ excerpt) => sum + excerpt.messages.reduce((/** @type {number} */ total, /** @type {any} */ message) => total + Buffer.byteLength(JSON.stringify(message)), 0), 0);
  assert.ok(bytes <= 24_000, `excerpts hold ${bytes} bytes`);
  assert.ok(input.transcriptExcerpts.length <= 5, "at most four decisive windows and the closing one");
  assert.ok(input.excerptDropped.bounded > 0);
  const output = input.transcriptExcerpts[0].messages[0].parts.find((/** @type {any} */ part) => part.type === "tool").output;
  assert.ok(output.length <= 1_210 && output.includes(" … "), "a long tool output is clipped head and tail");
});

/** A method package the contract and the store accept. @param {{ name: string, role: string, dependsOn?: string[], runId: string, quote: string }} spec */
function methodPackage({ name, role, dependsOn = [], runId, quote }) {
  const skill = [
    "---", `name: ${name}`, `description: "Does ${name} the way the camp's runs did it."`, `whenToUse: "When ${name} is needed."`, "metadata:",
    `  role: "${role}"`, `  applies_when: "A task needs ${name}."`, '  not_when: "The task needs something else."',
    ...(dependsOn.length ? [`  depends_on: "${dependsOn.join(", ")}"`] : []), `  derived_from: "run:${runId}"`, `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`, "---", "",
    "## Purpose", `Do ${name}.`, "", "## When to Use", "When it is needed.", "", "## Inputs", "The task.", "", "## Workflow", "1. Look, then act.", "",
    "## Verification", "- It was done.", "", "## Constraints", "- Only what the task names.", "", "## Output", "The task done.", "",
  ].join("\n");
  const candidate = { schemaVersion: 1, signal: "run", operation: "create", baseDigest: null, evidence: [{ runId, seqRange: [1, 1], quote }],
    applicability: `A task needs ${name}.`, counterexamples: ["The task needs something else."], risk: { touchesSafety: false, widensTools: false },
    testScenarios: [1, 2, 3].map((n) => ({ id: `t${n}`, runId, situation: "The same task.", expected: "Done." })) };
  return { "SKILL.md": skill, "method-candidate.json": JSON.stringify(candidate) };
}

test("a camp lesson's candidate passes the same method-candidate contract as any other", () => {
  const files = methodPackage({ name: "check-sink-before-carrying", role: "atomic", runId: "run_camp_lost", quote: "I should check the sink before carrying the mug." });
  const verdict = runGate({ contractKind: "method-candidate", files: new Map(Object.entries(files)),
    expectedOutputs: [{ path: "SKILL.md", required: true }, { path: "method-candidate.json", required: true }], checks: ["requiredOutputsExist"] });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
});

test("with the camp switch on, the camp lesson's question carries the camp section of the skill", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "distill-camp-"));
  try {
    const { run, transcript } = campRun({ success: false });
    const project = await projectFor(dir, { transcript, peers: [] });
    /** @type {any[]} */
    const requests = [];
    const runs = new MethodDistillationRuns({ camp: true,
      learning: { async listMethods() { return { items: [], nextCursor: null }; }, async getMethod() { return null; } },
      dispatch: async (/** @type {any} */ request) => { requests.push(request); return { runId: "lr", sessionId: "ls", dispatchId: request.dispatchId }; },
      readResult: async () => ({ status: "failed" }) });
    const lesson = /** @type {any} */ (campLessonFor({ run, outcome: { success: false, score: 0, verdict: "Lost." }, anchors: [], enabled: true }));
    await assert.rejects(runs.execute({ job: { id: "j", userId: project.userId, projectId: project.id, payload: lesson.payload }, project, run }), /did not succeed/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].contractKind, "method-candidate");
    assert.ok(requests[0].question.startsWith("Distil at most one reusable method from the finished run described in distillation-input.json"));
    assert.ok(requests[0].question.includes("## Variant: a training-camp lesson (`trigger: camp`)"));
    assert.ok(!requests[0].question.includes("two-stage"));
    assert.equal(requests[0].input.camp.outcome.verdict, "Lost.");
    // The same lesson with the switch off is refused before anything is dispatched.
    const off = new MethodDistillationRuns({ learning: { async listMethods() { return { items: [], nextCursor: null }; } },
      dispatch: async () => assert.fail("nothing is dispatched"), readResult: async () => ({ status: "failed" }) });
    await assert.rejects(off.execute({ job: { id: "j", userId: project.userId, projectId: project.id, payload: lesson.payload }, project, run }), /Unknown distillation trigger/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------------------------------------------------- the frame contract */

/** @param {any} frame */
const frameVerdict = (frame) => runGate({ contractKind: METHOD_FRAME_CONTRACT, files: new Map(frame === null ? [] : [["method-frame.json", JSON.stringify(frame)]]),
  expectedOutputs: [{ path: "method-frame.json", required: true }], checks: ["requiredOutputsExist"] });

test("the method-frame contract accepts a frame and names what is wrong with a bad one", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(frameVerdict({ schemaVersion: 1, reuses: [{ methodId: "method:learned:x", digest, why: "Same search." }],
    newSkills: [{ name: "check-totals", role: "atomic", summary: "Check the totals." }, { name: "summarise-plan", role: "abstract", summary: "The plan.", buildsOn: ["check-totals"] }],
    amend: [] }).ok, true);
  assert.equal(frameVerdict({ schemaVersion: 1, reuses: [], newSkills: [], amend: [], reason: "Already on file." }).ok, true);
  const issues = (/** @type {any} */ frame) => frameVerdict(frame).issues.map((issue) => issue.message).join(" | ");
  assert.match(issues({ schemaVersion: 1, newSkills: [], amend: [] }), /must say why in reason/);
  assert.match(issues({ schemaVersion: 1, newSkills: [{ name: "Bad Name", role: "atomic", summary: "x" }] }), /kebab-case/);
  assert.match(issues({ schemaVersion: 1, newSkills: [{ name: "ok-name", role: "helper", summary: "x" }] }), /role must be one of atomic, functional, abstract/);
  assert.match(issues({ schemaVersion: 1, newSkills: Array.from({ length: 6 }, (_, index) => ({ name: `skill-${index}`, role: "atomic", summary: "x" })) }), /at most 5/);
  assert.match(issues({ schemaVersion: 1, reuses: [{ methodId: "m", digest: "nope", why: "x" }], reason: "r" }), /pins its digest/);
  assert.match(issues({ schemaVersion: 1, reason: "r", status: "approved" }), /carries no status/);
  assert.equal(frameVerdict(null).ok, false);
});

/* ---------------------------------------------------------------------------------------------------------------- the two-stage path */

test("two-stage: the frame first, then one method per new sub-skill, atomic before abstract, each pinning what it builds on; a retry writes nothing twice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "distill-two-stage-"));
  try {
    const documents = productDocumentsDouble();
    const learning = new LearningService({ documents, now: () => new Date("2026-11-10T00:00:00.000Z") });
    const userId = "u_fixture";
    // One method on file the lesson reuses.
    const parsed = parseSkillFrontmatter(methodPackage({ name: "find-object-first", role: "functional", runId: "r0", quote: "unused" })["SKILL.md"]);
    const onFile = await learning.createCandidate(userId, { projectId: "p_fixture", frontmatter: parsed.frontmatter, body: parsed.body,
      provenance: { origin: "inferred", runId: "r0" } });
    const reusedDoc = await learning.getMethod(userId, onFile.id);

    const { run, transcript } = campRun({ success: true });
    const project = await projectFor(dir, { transcript, peers: [] });
    /** @type {any[]} */
    const requests = [];
    const quote = "I should check the sink before carrying the mug.";
    const dispatch = async (/** @type {any} */ request) => {
      requests.push(request);
      return { runId: `lr-${requests.length}`, sessionId: "ls", dispatchId: request.dispatchId };
    };
    const readResult = async (/** @type {any} */ identity) => {
      const request = requests.find((entry) => entry.dispatchId === identity.dispatchId);
      if (request.contractKind === METHOD_FRAME_CONTRACT) {
        return { status: "succeeded", output: { "method-frame.json": { schemaVersion: 1,
          reuses: [{ methodId: reusedDoc.id, digest: reusedDoc.payload.contentDigest, why: "Find the object first." }, { methodId: "method:learned:never-shown", digest: `sha256:${"e".repeat(64)}`, why: "x" }],
          // Listed abstract first: the control plane writes the atomic one first so the abstract one can pin it.
          newSkills: [{ name: "clean-then-place-plan", role: "abstract", summary: "The plan.", buildsOn: ["check-sink-first", "find-object-first"] },
            { name: "check-sink-first", role: "atomic", summary: "Check the sink first." }],
          amend: [{ methodId: "method:learned:never-shown", digest: `sha256:${"e".repeat(64)}`, why: "Not shown, so ignored." }] } } };
      }
      const focus = request.input.focus;
      const pins = request.input.relatedMethods.filter((/** @type {any} */ method) => (focus.buildsOn ?? []).includes(method.frontmatter.name))
        .map((/** @type {any} */ method) => `${method.frontmatter.name}@${method.digest}`);
      const files = methodPackage({ name: focus.name, role: focus.role, dependsOn: pins, runId: run.id, quote });
      return { status: "succeeded", output: { skill: files["SKILL.md"], candidate: JSON.parse(files["method-candidate.json"]) } };
    };
    const runs = new MethodDistillationRuns({ camp: true, twoStage: true, learning, dispatch, readResult });
    const lesson = /** @type {any} */ (campLessonFor({ run, outcome: { success: true, score: 1, verdict: "Won." }, anchors: [{ seq: 30 }], enabled: true }));
    const job = { id: "j_two", userId, projectId: project.id, payload: lesson.payload };
    const result = await runs.execute({ job, project, run });

    assert.deepEqual(requests.map((request) => [request.contractKind, request.input.stage, request.input.focus?.name ?? null]),
      [[METHOD_FRAME_CONTRACT, "frame", null], ["method-candidate", "detail", "check-sink-first"], ["method-candidate", "detail", "clean-then-place-plan"]]);
    assert.ok(requests[0].question.startsWith("Step one of a two-stage distillation"));
    assert.ok(requests[0].question.includes("## Variant: two-stage creation") && requests[0].question.includes("## Variant: a training-camp lesson"));
    // What the frame named but the lesson was never shown is not read on its word.
    assert.deepEqual(requests[1].input.frame.reuses.map((/** @type {any} */ entry) => entry.methodId), [reusedDoc.id]);
    assert.deepEqual(requests[1].input.frame.amend, []);
    assert.equal(result.state, "complete");
    assert.equal(result.operation, "create");
    assert.deepEqual(result.twoStage.steps.map((/** @type {any} */ step) => [step.focus, step.role, step.operation]),
      [["check-sink-first", "atomic", "create"], ["clean-then-place-plan", "abstract", "create"]]);

    const atomic = await learning.getMethod(userId, learnedMethodId("check-sink-first"));
    const abstract = await learning.getMethod(userId, learnedMethodId("clean-then-place-plan"));
    assert.equal(abstract.payload.frontmatter.metadata.role, "abstract");
    assert.deepEqual(abstract.payload.dependencies.map((/** @type {any} */ dependency) => dependency.name).sort(), ["check-sink-first", "find-object-first"]);
    assert.equal(abstract.payload.dependencies.find((/** @type {any} */ dependency) => dependency.name === "check-sink-first").digest, atomic.payload.contentDigest);
    assert.ok(String(atomic.payload.provenance.distillationStep).startsWith("method-distillation-"));
    assert.equal(atomic.payload.provenance.trigger, "camp");
    assert.equal(atomic.payload.provenance.evidence?.[0]?.quote, quote);

    // The retried lesson adopts every step and writes nothing twice.
    const before = { atomic: atomic.revision, abstract: abstract.revision };
    const again = await runs.execute({ job, project, run });
    assert.deepEqual(again.twoStage.steps.map((/** @type {any} */ step) => step.operation), ["already_applied", "already_applied"]);
    assert.equal((await learning.getMethod(userId, atomic.id)).revision, before.atomic);
    assert.equal((await learning.getMethod(userId, abstract.id)).revision, before.abstract);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two-stage: an empty frame writes nothing, and a lesson in a one-step deployment is the one step it was", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "distill-two-stage-empty-"));
  try {
    const { run, transcript } = campRun({ success: true });
    const project = await projectFor(dir, { transcript, peers: [] });
    /** @type {any[]} */
    const requests = [];
    const runs = new MethodDistillationRuns({ camp: true, twoStage: true,
      learning: { async listMethods() { return { items: [], nextCursor: null }; }, async getMethod() { return null; } },
      dispatch: async (/** @type {any} */ request) => { requests.push(request); return { runId: "lr", sessionId: "ls", dispatchId: request.dispatchId }; },
      readResult: async () => ({ status: "succeeded", output: { "method-frame.json": { schemaVersion: 1, reuses: [], newSkills: [], amend: [], reason: "Nothing recurs." } } }) });
    const lesson = /** @type {any} */ (campLessonFor({ run, outcome: { success: true, score: 1, verdict: "Won." }, enabled: true }));
    const result = await runs.execute({ job: { id: "j", userId: project.userId, projectId: project.id, payload: lesson.payload }, project, run });
    assert.equal(requests.length, 1);
    assert.equal(result.operation, "no_change");
    assert.deepEqual(result.twoStage.steps, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
