// Definition cards of a trial's clauses (built, off until measured): written once per trial text, shared by every pair, never failing a pair, and
// read by the clause-level calls of a judging job that asked for them. The model is a double; whether the cards help is for the measurement.
import assert from "node:assert/strict";
import test from "node:test";

import { VCR_DEFINITION_PROMPT_VERSION } from "@evimed/domain";
import { createClauseDefinitionCounters, createClauseDefinitions } from "../src/vcrClauseDefinitions.mjs";
import { createMatchJudgeCounters, createMatchJudgeExecutor, createPairJudge, judgeSelection, judgmentTargets, planMatchJudge } from "../src/vcrMatchJudge.mjs";

const TARGET = { hash: "t".repeat(16), title: "Lung trial", summary: "S", conditions: ["NSCLC"], interventions: ["Drug A"],
  clauses: [{ number: 1, kind: "inclusion", text: "Adequate organ function" }, { number: 2, kind: "exclusion", text: "Active infection" }] };
const cardJson = JSON.stringify({ 1: { counts: "ECOG 0-1 and normal marrow, liver and kidney function", does_not_count: "one normal lab" }, 2: { counts: "an infection needing treatment", does_not_count: "a healed one", source: "knowledge" } });

/** A store double with the real key: one row per study scope, text hash, version and model; the first row stays. */
function storeDouble() {
  const rows = new Map();
  const key = ({ studyId, targetHash, promptVersion, model }) => [studyId ?? "", targetHash, promptVersion, model].join("|");
  return { rows, async get(entry) { return rows.get(key(entry)) ?? null; }, async save(entry) { if (!rows.has(key(entry))) rows.set(key(entry), entry.definitions); return rows.get(key(entry)); } };
}
const answered = (content, usage = { inputTokens: 100, outputTokens: 50 }) => ({ content, usage, cost: 0.001, currency: "CNY" });

test("the cards of a trial are written by one call, kept by the trial's text, and read from the cache by every later pair", async () => {
  const store = storeDouble();
  const calls = [];
  const judge = { model: "deepseek-flash", async call(input) { calls.push(input); return answered(cardJson); } };
  const counters = createClauseDefinitionCounters();
  const cards = createClauseDefinitions({ store, judge, counters });
  const study = { id: "std_1", userId: "u" };
  // Eight pairs of one trial arrive together: one call, and only the first is handed its bill.
  const arrived = await Promise.all(Array.from({ length: 8 }, () => cards.forTarget({ study, jobId: "job_1", target: TARGET, targetKind: "candidate_trial" })));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].thinking, "off");
  assert.deepEqual(arrived.map((entry) => entry.definitions.length), Array(8).fill(2));
  assert.deepEqual(arrived.map((entry) => entry.calls.length), [1, 0, 0, 0, 0, 0, 0, 0], "a pair that waited for the cards is not billed for them");
  const later = await cards.forTarget({ study, jobId: "job_2", target: TARGET, targetKind: "candidate_trial" });
  assert.deepEqual([later.cached, later.calls.length, calls.length], [true, 0, 1]);
  assert.deepEqual(later.definitions.map((card) => card.number), [1, 2]);
  assert.deepEqual({ ...counters }, { written: 1, fromCache: 1, failed: 0, clausesCarded: 2 });
  // The key is the registry text's, shared by every account; a protocol's is its study's.
  assert.deepEqual([...store.rows.keys()], [`|${TARGET.hash}|${VCR_DEFINITION_PROMPT_VERSION}|deepseek-flash`]);
  await cards.forTarget({ study, jobId: "job_3", target: TARGET, targetKind: "protocol_version" });
  assert.equal(calls.length, 2, "the same words as a study's protocol are the study's own cards");
  assert.ok(store.rows.has(`std_1|${TARGET.hash}|${VCR_DEFINITION_PROMPT_VERSION}|deepseek-flash`));
});

test("a guideline passage retrieved for a clause goes into the call; a retriever that fails is the model's knowledge alone", async () => {
  const seen = [];
  const judge = { model: "deepseek-flash", async call(input) { seen.push(input.messages[1].content); return answered(cardJson); } };
  const withPassage = createClauseDefinitions({ store: storeDouble(), judge, passages: async ({ clauses }) => ({ [clauses[0].number]: { source: "ASCO 2026", text: "Adequate organ function: ANC >= 1.5, platelets >= 100, creatinine clearance >= 50." } }) });
  await withPassage.forTarget({ study: { id: "s" }, jobId: "j", target: TARGET, targetKind: "candidate_trial" });
  assert.match(seen[0], /Guideline passage for criterion 1 \(ASCO 2026\): Adequate organ function: ANC >= 1\.5/);
  const broken = createClauseDefinitions({ store: storeDouble(), judge, passages: async () => { throw new Error("guideline service down"); } });
  const answer = await broken.forTarget({ study: { id: "s" }, jobId: "j", target: TARGET, targetKind: "candidate_trial" });
  assert.equal(answer.definitions.length, 2);
  assert.equal(/Guideline passage/.test(seen[1]), false);
});

test("a model that fails or answers nothing readable is no cards and a code, never an error, and nothing is kept for the next pair to find", async () => {
  const store = storeDouble();
  let mode = "throw";
  const reported = [];
  const judge = { model: "deepseek-flash", async call() {
    if (mode === "throw") throw Object.assign(new Error("down"), { code: "vcr_match_judge_network" });
    return answered(mode === "junk" ? "I cannot do this" : cardJson);
  } };
  const counters = createClauseDefinitionCounters();
  const cards = createClauseDefinitions({ store, judge, counters, report: (code) => reported.push(code) });
  const ask = () => cards.forTarget({ study: { id: "s" }, jobId: "j", target: TARGET, targetKind: "candidate_trial" });
  const failed = await ask();
  assert.deepEqual([failed.definitions, failed.failed], [[], "vcr_match_judge_network"]);
  mode = "junk";
  const junk = await ask();
  assert.deepEqual([junk.definitions, junk.unreadable, junk.calls.length], [[], true, 1], "the call was paid for and is accounted");
  assert.equal(store.rows.size, 0);
  mode = "ok";
  assert.equal((await ask()).definitions.length, 2, "the next pair asks again and is served");
  assert.deepEqual([counters.failed, reported], [1, ["vcr_match_judge_network"]]);
  // A trial with no clause has nothing to define and costs no call.
  assert.deepEqual((await cards.forTarget({ study: { id: "s" }, jobId: "j", target: { ...TARGET, hash: "x".repeat(16), clauses: [] }, targetKind: "candidate_trial" })).definitions, []);
});

test("the selection and the plan: definitions is a boolean, adds one call a trial to the estimate, and changes the prompt version of the clause-level rows", async () => {
  assert.equal(judgeSelection({ subjectKey: "P-1", registryIds: ["NCT00000001"], definitions: true }).definitions, true);
  assert.throws(() => judgeSelection({ subjectKey: "P-1", registryIds: ["NCT00000001"], definitions: "yes" }), { code: "vcr_matching_selection_invalid" });
  const matchStore = { async withdrawnSubjects() { return new Set(); } };
  const documents = { async roster() { return [{ id: "d1", subjectKey: "P-1", chars: 100 }]; } };
  const base = { study: { id: "std_1", userId: "u" }, matchStore, documents, config: { deepseekModel: "deepseek-flash" } };
  const without = await planMatchJudge({ ...base, selection: { subjectKey: "P-1", registryIds: ["NCT00000001", "NCT00000002"], topK: 1 } });
  const withCards = await planMatchJudge({ ...base, selection: { subjectKey: "P-1", registryIds: ["NCT00000001", "NCT00000002"], topK: 1, definitions: true } });
  assert.equal(without.scenario.definitions, undefined);
  assert.deepEqual(without.scenario.promptVersions, { fit: "fit-1", criteria: "criteria-1" }, "off, nothing about a job changes");
  assert.equal(withCards.scenario.definitions, true);
  assert.equal(withCards.scenario.promptVersions.criteria, `criteria-1+${VCR_DEFINITION_PROMPT_VERSION}`);
  assert.equal(withCards.scenario.estimate.calls, without.scenario.estimate.calls + 2, "one card call for each of the two trials");
  assert.notEqual(withCards.scenario.chain, without.scenario.chain, "another job");
});

test("a job asked for definitions writes each trial's cards once, its clause-level calls read them, and a job not asked reads none", async () => {
  const TRIALS = { NCT00000001: { title: "Lung trial", summary: "S1", eligibility: "Inclusion Criteria:\n* Adequate organ function\nExclusion Criteria:\n* Active infection" },
    NCT00000002: { title: "Other trial", summary: "S2", eligibility: "Inclusion Criteria:\n* Adequate organ function\nExclusion Criteria:\n* Active infection" } };
  const rows = new Map();
  const judgments = {
    async save(entry) { const row = { thinking: "", model: "", targetHash: "", documentHash: "", ...entry, id: `mjd_${rows.size + 1}`, updatedAt: new Date().toISOString() }; rows.set(`${entry.mode}|${entry.targetId}|${entry.promptVersion}`, row); return row; },
    async doneFor() { return new Map(); },
  };
  const requests = [];
  const callModel = async (_deps, call) => {
    const system = call.body.messages[0].content;
    const user = call.body.messages[1].content;
    requests.push({ kind: system.includes("definition card") ? "cards" : system.includes("criterion level") ? "criteria" : "fit", user });
    const content = system.includes("definition card") ? cardJson
      : system.includes("criterion level") ? JSON.stringify({ 1: ["ok", [0], "included"], 2: ["ok", [0], "not excluded"] })
        : JSON.stringify({ score: 80, confidence: 0.7, eligible_reasons: "1. a", ineligible_reasons: "", missing_information: "", rationale: "1. b" });
    return { choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } };
  };
  const counters = createMatchJudgeCounters();
  const judge = createPairJudge({ config: { deepseekModel: "deepseek-flash" }, callModel, sleep: async () => {}, counters });
  const evidence = { async judgmentRecord({ registryId }) { return { status: "ok", trial: { registry: "clinicaltrials.gov", registryId, conditions: [], interventions: [], ...TRIALS[registryId] } }; } };
  const matchStore = { async withdrawnSubjects() { return new Set(); }, async listCriteria() { return []; }, async latestProtocol() { return null; }, async protocols() { return []; } };
  const documents = { async roster() { return [{ id: "d1", subjectKey: "P-1", chars: 20 }, { id: "d2", subjectKey: "P-2", chars: 20 }]; },
    async runtimeRead(_study, { documentId }) { return { id: documentId, text: "男性，70 岁。肺腺癌。", subjectKey: documentId === "d1" ? "P-1" : "P-2", sourceHash: `h_${documentId}` }; } };
  const store = storeDouble();
  const clauseDefinitions = createClauseDefinitions({ store, judge });
  const run = createMatchJudgeExecutor({ store: { async studyById() { return { id: "std_1", userId: "u_1", projectId: "p_1" }; }, async one() { return { checkpoint: {} }; } },
    matchStore, judgments, documents, targets: judgmentTargets({ evidence, matchStore }), judge, clauseDefinitions, config: {}, counters });
  const scenario = (extra = {}) => ({ direction: "patient_to_trial", subjects: ["P-1", "P-2"], trials: Object.keys(TRIALS).map((registryId) => ({ registry: "clinicaltrials.gov", registryId })), fit: false, topK: "all", thinking: "off", model: "deepseek-flash",
    promptVersions: { fit: "fit-1", criteria: "criteria-1" }, estimate: { pairs: 4 }, chain: "c1", ...extra });
  const start = (extra) => run({ job: { id: "job_1", jobId: "job_1", studyId: "std_1", scenario: scenario(extra), scenarioHash: "a".repeat(64), seed: 0 }, async onProgress() {}, isCanceled: async () => false });

  const plain = await start();
  assert.equal(plain.status, "succeeded");
  assert.equal(requests.filter((request) => request.kind === "cards").length, 0);
  assert.equal(requests.filter((request) => request.kind === "criteria").every((request) => !/Background notes/.test(request.user)), true);
  assert.equal(plain.diagnostics.used.calls, 4);
  requests.length = 0;
  rows.clear();

  const asked = await start({ definitions: true, promptVersions: { fit: "fit-1", criteria: `criteria-1+${VCR_DEFINITION_PROMPT_VERSION}` } });
  assert.equal(asked.status, "succeeded", JSON.stringify(asked.diagnostics));
  // Two trials, four pairs: two card calls and four clause-level calls, every one of which carries its trial's cards.
  assert.equal(requests.filter((request) => request.kind === "cards").length, 2);
  const clauseCalls = requests.filter((request) => request.kind === "criteria");
  assert.equal(clauseCalls.length, 4);
  assert.ok(clauseCalls.every((request) => /Background notes on some of the criteria above[\s\S]*1\. Counts: ECOG 0-1 and normal marrow/.test(request.user)));
  assert.equal(asked.diagnostics.used.calls, 6, "the bill counts the card calls once");
  const row = [...rows.values()].find((entry) => entry.mode === "criteria");
  assert.equal(row.promptVersion, `criteria-1+${VCR_DEFINITION_PROMPT_VERSION}`);
  assert.deepEqual(row.answer.definitions, { version: VCR_DEFINITION_PROMPT_VERSION, used: 2 });
  assert.equal(store.rows.size, 2);

  // The cards fail: the pairs are judged without them and say so.
  requests.length = 0; rows.clear(); store.rows.clear();
  const down = createClauseDefinitions({ store, judge: { model: "deepseek-flash", async call() { throw Object.assign(new Error("x"), { code: "vcr_match_judge_network" }); } } });
  const degraded = await createMatchJudgeExecutor({ store: { async studyById() { return { id: "std_1", userId: "u_1", projectId: "p_1" }; }, async one() { return { checkpoint: {} }; } },
    matchStore, judgments, documents, targets: judgmentTargets({ evidence, matchStore }), judge, clauseDefinitions: down, config: {}, counters })({
    job: { id: "job_2", jobId: "job_2", studyId: "std_1", scenario: scenario({ definitions: true }), scenarioHash: "b".repeat(64), seed: 0 }, async onProgress() {}, isCanceled: async () => false });
  assert.equal(degraded.status, "succeeded", "a card that could not be written fails no pair");
  assert.equal(requests.filter((request) => request.kind === "criteria").every((request) => !/Background notes/.test(request.user)), true);
  const noted = [...rows.values()].find((entry) => entry.mode === "criteria");
  assert.deepEqual(noted.answer.definitions, { version: VCR_DEFINITION_PROMPT_VERSION, used: 0, failed: "vcr_match_judge_network" });
});
