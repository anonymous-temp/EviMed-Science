import assert from "node:assert/strict";
import test from "node:test";

import { cleanLearningEvidence, learningRunOutcome } from "@evimed/domain";
import { LearningEvidence } from "../src/learningEvidence.mjs";
import { loadConfig } from "../src/config.mjs";
import { createMethodSimilarity } from "../src/methodSimilarity.mjs";
import { toolchainFingerprint, toolchainsMatch } from "../src/toolExecutionEdges.mjs";

const fingerprint = (...tools) => toolchainFingerprint([{ steps: tools.map(tool => ({ tool })) }]);
const chain = fingerprint("web_search", "web_read");

test("fingerprints remove support tools, normalize MCP names, fold repeats and retain order", () => {
  const value = fingerprint("skill", "mcp__openviking__search", "mcp__evimed__web_search", "web_search",
    "ask-user", "memory_read", "evimed_submit_deliverable", "web_read", "web_read");
  assert.deepEqual(value, chain);
  assert.deepEqual(value.tools, ["web_search", "web_read"]);
  assert.deepEqual(value.bigrams, [JSON.stringify(["web_search", "web_read"])]);
  assert.equal(fingerprint("web_search", "skill", "web_search"), null);
  assert.equal(fingerprint("skill", "ask_user_question"), null);
  assert.equal(toolchainsMatch(value, fingerprint("web_read", "web_search")), false);
  assert.equal(toolchainsMatch(null, null), false);
  const longer = fingerprint("a", "b", "c", "d", "e", "f");
  assert.equal(toolchainsMatch(fingerprint("a", "b", "c", "d", "e"), longer), true, "Jaccard 4/5 meets 0.8");
  assert.equal(toolchainsMatch(fingerprint("a", "b", "c", "d", "e"), longer, { minSimilarity: 0.81 }), false);
});

test("toolchains survive evidence cleaning separately from formats, within the evidence byte limit", () => {
  const base = { evidence: "silent", at: "2026-11-10T10:00:00Z", toolchain: chain };
  assert.deepEqual(cleanLearningEvidence(base).toolchain, chain);
  assert.equal(cleanLearningEvidence(base).shape, undefined);
  assert.equal(cleanLearningEvidence({ ...base, shape: [{ format: "docx", labels: [] }] }).toolchain, undefined);
  assert.equal(fingerprint(...Array.from({ length: 300 }, (_, i) => `long_tool_name_${i}`)), null);
  const bounded = cleanLearningEvidence({ ...base, quote: "汉".repeat(600), rule: "汉".repeat(300),
    concerns: Array.from({ length: 8 }, (_, i) => ({ id: `method_${i}_${"x".repeat(180)}`, digest: "x".repeat(80) })) });
  assert.ok(bounded === null || Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
});

test("the experiment defaults off and configures a finite Jaccard threshold", () => {
  const previous = process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED;
  const similarity = process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_MIN_SIMILARITY;
  delete process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED;
  delete process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_MIN_SIMILARITY;
  try {
    assert.equal(loadConfig().learningToolchainRoutineEnabled, false);
    assert.equal(loadConfig().learningToolchainMinSimilarity, 0.8);
    process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED = "true";
    process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_MIN_SIMILARITY = "0.9";
    assert.equal(loadConfig().learningToolchainRoutineEnabled, true);
    assert.equal(loadConfig().learningToolchainMinSimilarity, 0.9);
    assert.throws(() => loadConfig({ learningToolchainMinSimilarity: 1.01 }), /MIN_SIMILARITY/);
    assert.throws(() => loadConfig({ learningToolchainMinSimilarity: "NaN" }), /MIN_SIMILARITY/);
  } finally {
    if (previous === undefined) delete process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED;
    else process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED = previous;
    if (similarity === undefined) delete process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_MIN_SIMILARITY;
    else process.env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_MIN_SIMILARITY = similarity;
  }
});

/** Small ledger with the same clean/unknown/corrected policy; SQL is exercised in learningEvidence.integration. */
function setup({ enabled = true, similarity = createMethodSimilarity(), readTraces = async () => [{ steps: chain.tools.map(tool => ({ tool })) }] } = {}) {
  const rows = [], runs = [], lessons = [], enqueued = [];
  const project = { id: "p", userId: "owner" };
  const feedback = {
    async recordLearningEvidence(_owner, { runId, detail, key }) {
      const id = `${runId}:${key}`;
      const held = rows.find(row => row.id === id);
      if (held) return { event: held, created: false };
      const event = { id, runId, detail: cleanLearningEvidence(detail) };
      rows.push(event);
      return { event, created: true };
    },
    async learningEvidenceOf(_owner, id) { return rows.filter(row => row.runId === id); },
    async cleanSettledRuns(_owner, { toolchainEnabled }) {
      return runs.flatMap(run => {
        const events = rows.filter(row => row.runId === run.id);
        const evidence = events.find(row => row.detail.shape || (toolchainEnabled && row.detail.toolchain));
        return evidence && learningRunOutcome(events.map(row => row.detail)) === "clean"
          ? [{ runId: run.id, projectId: project.id, shape: evidence.detail.shape ?? [], toolchain: evidence.detail.toolchain }] : [];
      });
    },
  };
  const evidence = new LearningEvidence({ feedback, jobs: { enqueue: async (...args) => enqueued.push(args) },
    agentRuns: { list: async () => runs }, triggers: { refusalFor: async () => null, queue: async (_project, _run, lesson) => {
      if (lessons.some(held => held.idempotencyKey === lesson.idempotencyKey)) return false;
      lessons.push(lesson); return true;
    } }, resolveProject: async () => project, toolchainEnabled: enabled, similarity, readTraces,
    now: () => new Date("2026-11-10T12:00:00Z") });
  async function settle(question, verdict = "accept") {
    const run = { id: `run_${runs.length}`, sessionId: `session_${runs.length}`, question, status: "succeeded",
      effectiveAgentId: "open-domain-answer", finishedAt: "2026-11-10T11:00:00Z" };
    runs.push(run);
    if (verdict !== null) await feedback.recordLearningEvidence(project.userId, { runId: run.id, key: "reaction",
      detail: { evidence: "follow-up", verdict, at: run.finishedAt } });
    await evidence.afterRun(project, run);
    await evidence.settle({ job: { userId: project.userId, projectId: project.id, payload: { runId: run.id } } });
    return run;
  }
  return { evidence, project, rows, runs, lessons, enqueued, settle };
}

test("four matching requests and two same-chain look-alikes produce exactly one routine per family", async () => {
  // Use the existing cosine service with a deterministic embedder: near-identical wording can have different intent.
  const requests = [
    ["Compare warehouse stock discrepancies", "Reconcile depot inventory differences", "Check stock balance mismatches", "Audit warehouse inventory variance",
      "Explain warehouse stock photography", "Locate warehouse stock market listings"],
    ["Summarize weekly supplier delivery delays", "Review vendor shipment lateness", "Compare supplier shipping delays", "Audit vendor delivery slippage",
      "Find supplier delivery address labels", "Explain supplier delivery drone patents"],
  ];
  const vectors = new Map(requests.flatMap((family, i) => family.map((request, j) => [request,
    Array.from({ length: 6 }, (_, k) => k === (j < 4 ? i : 2 + i * 2 + j - 4) ? 1 : 0)])));
  const similarity = createMethodSimilarity({ embed: async texts => texts.map(text => vectors.get(text)) });
  for (const enabled of [false, true]) {
    const state = setup({ enabled, similarity });
    for (const family of requests) for (const i of [0, 4, 1, 5, 2, 3]) await state.settle(family[i]);
    assert.equal(state.lessons.length, enabled ? 2 : 0);
    assert.equal(state.enqueued.length, enabled ? 12 : 0, "file-free work gets settling jobs only with the switch on");
    if (enabled) {
      assert.ok(state.lessons.every(lesson => lesson.payload.shapeKind === "toolchain"));
      assert.deepEqual(state.lessons.map(lesson => lesson.payload.peers.map(peer => peer.runId)), [["run_0", "run_2"], ["run_6", "run_8"]]);
      assert.ok(state.rows.some(row => row.detail.toolchain));
      assert.ok(state.rows.every(row => !row.detail.shape));
    } else assert.ok(state.rows.every(row => !row.detail.toolchain));
  }
});

test("silence, corrections, missing traces and single-tool searches never establish a routine", async () => {
  for (const options of [{ verdict: null }, { verdict: "correction" }, { readTraces: async () => [] },
    { readTraces: async () => [{ steps: [{ tool: "web_search" }] }] }]) {
    const state = setup(options);
    for (let i = 0; i < 3; i++) await state.settle("Compare weekly warehouse inventory discrepancies", options.verdict === undefined ? "accept" : options.verdict);
    assert.equal(state.lessons.length, 0);
  }
});

test("lexical fallback uses the existing normalized score and its floor", async () => {
  const state = setup();
  for (const request of ["Compare weekly warehouse inventory discrepancies", "Review weekly warehouse inventory discrepancies",
    "Audit weekly warehouse inventory discrepancies"]) await state.settle(request);
  assert.equal(state.lessons.length, 1);
  await state.evidence.settle({ job: { userId: "owner", projectId: "p", payload: { runId: state.runs.at(-1).id } } });
  assert.equal(state.lessons.length, 1, "settling twice queues once");
});

test("missing or ineligible peer requests cannot establish similarity", async () => {
  for (const missing of [false, true]) {
    const state = setup();
    const request = "Compare weekly warehouse inventory discrepancies";
    await state.settle(request);
    await state.settle(request);
    if (missing) state.runs[0].question = "";
    else state.evidence.triggers.refusalFor = async (_project, run) => run.id === "run_0" ? "clinical_context" : null;
    await state.settle(request);
    assert.equal(state.lessons.length, 0);
  }
});
