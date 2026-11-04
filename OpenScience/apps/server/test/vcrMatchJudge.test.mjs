// Judging patients against trials, on doubles: the plan and what it says, the two stages in both directions, resume from the ledger, cancel between
// pairs, one pair failing, a budget and a run of upstream failures stopping the job, an answer cut off, a trial with no eligibility text, and the model call.
// The queue, the lane, the real table and erasure are PostgreSQL's (vcrMatchJudge.integration.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { validateMatchBatchScenario } from "@evimed/domain";
import { HttpError } from "../src/security.mjs";
import { ctgovPrecedent } from "../src/trialRegistryClient.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { createMatchJudge, createMatchJudgeCounters, createMatchJudgeExecutor, createMatchJudgmentReads, createPairJudge, judgmentChanges, judgeSelection, judgmentTargets, planMatchJudge, presentJudgment, readSubjectNote } from "../src/vcrMatchJudge.mjs";
import { judgmentKey } from "../src/vcrMatchJudgmentStore.mjs";

const STUDY = { id: "std_1", userId: "u_1", projectId: "p_1" };
const TEXT = { d1: "男性，70 岁。肺腺癌 IV 期。\nECOG 1。", d2: "女性，58 岁。乳腺癌。", d3: "男性，45 岁。高血压。" };
const ROSTER = [{ id: "d1", subjectKey: "P-1", chars: TEXT.d1.length }, { id: "d2", subjectKey: "P-2", chars: TEXT.d2.length }, { id: "d3", subjectKey: "P-3", chars: TEXT.d3.length }];
const TRIALS = {
  NCT00000001: { title: "Lung trial", summary: "S1", eligibility: "Inclusion Criteria:\n* Age >= 18\n* Stage IV NSCLC\nExclusion Criteria:\n* Pregnancy" },
  NCT00000002: { title: "Breast trial", summary: "S2", eligibility: "Inclusion Criteria:\n* Breast cancer\nExclusion Criteria:\n* Pregnancy" },
  NCT00000003: { title: "No text trial", summary: "S3", eligibility: "", conditions: ["Asthma"] },
};

/** An in-memory `match_judgments`, with the real key. */
function judgmentsDouble() {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  const withdrawn = new Set();
  let seq = 0;
  return {
    rows: byKey, withdrawn,
    async save(entry) {
      if (withdrawn.has(entry.subjectKey)) return null;
      const row = { thinking: "", model: "", targetHash: "", documentHash: "", ...entry };
      const key = judgmentKey(row);
      const held = byKey.get(key);
      if (held && held.status === "done" && row.producer !== "conversation") return held;
      const saved = { ...row, id: held?.id ?? `mjd_${++seq}`, updatedAt: new Date(2026, 10, 4, 0, 0, seq).toISOString() };
      byKey.set(key, saved);
      return saved;
    },
    async doneFor() { return new Map([...byKey].filter(([, row]) => row.status === "done" && row.producer === "job")); },
    async list({ subjectKey, targetKind, targetId }) {
      return [...byKey.values()].filter((row) => (!subjectKey || row.subjectKey === subjectKey) && (!targetKind || row.targetKind === targetKind) && (!targetId || row.targetId === targetId)).reverse()
        .map(({ answer, usage: _usage, ...row }) => ({ ...row, target: answer?.target ?? null, disqualified: (answer?.rows ?? []).some((entry) => entry.basis === "stated" && ["excluded", "not_included"].includes(entry.label)) }));
    },
    async byIds(_studyId, ids) { return [...byKey.values()].filter((row) => ids.includes(row.id)); },
  };
}

const fitJson = (score, extra = {}) => JSON.stringify({ score, confidence: 0.8, eligible_reasons: "1. 年龄符合", ineligible_reasons: "", missing_information: "", rationale: "1. 主要匹配", ...extra });

/** A provider: answers by the kind of call, and whatever `script` says for a call it is given first. */
function providerDouble(script = () => null) {
  /** @type {any[]} */ const calls = [];
  const callModel = async (_deps, call) => {
    const system = call.body.messages[0].content;
    const user = call.body.messages[1].content;
    const mode = system.includes("criterion level") ? "criteria" : "fit";
    calls.push({ mode, body: call.body, purpose: call.purpose, runId: call.runId, user });
    const scripted = await script({ mode, user, index: calls.length, body: call.body });
    if (scripted?.throw) throw scripted.throw;
    const content = scripted?.content ?? (mode === "fit" ? fitJson(/Lung trial/.test(user) ? 90 : /Breast trial/.test(user) ? 40 : 60)
      : JSON.stringify(Object.fromEntries([...user.matchAll(/^(\d+)\. (?:Age|Stage|Pregnancy|Breast)/gmu)].map((hit) => [hit[1], ["理由", [0], /Pregnancy/.test(hit[0]) ? "not excluded" : "included"]]))));
    return { choices: [{ finish_reason: scripted?.finish ?? "stop", message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 } };
  };
  return { calls, callModel };
}

function fixture({ script, config = {}, roster = ROSTER, registry = null, withdrawn = new Set(), text = TEXT, tableCells = null, scenario = null } = {}) {
  const provider = providerDouble(script);
  const judgments = judgmentsDouble();
  const counters = createMatchJudgeCounters();
  /** @type {string[]} */ const reported = [];
  /** @type {any[]} */ const reads = [];
  const documents = {
    async roster() { return roster; },
    async runtimeRead(study, { subjectKey, documentId }) {
      reads.push({ subjectKey, documentId, cloudContext: study.cloudContext });
      if (!Object.hasOwn(text, documentId)) throw Object.assign(new Error("no"), { code: "vcr_projection_unavailable" });
      return { id: documentId, text: text[documentId], subjectKey, sourceHash: `h_${documentId}` };
    },
    runtimeEvidence: async (_study, entries) => (tableCells ? entries.flatMap((entry) => (tableCells[entry.source?.field] ? [{ ...entry, quote: tableCells[entry.source.field] }] : [])) : entries),
  };
  const evidence = { async judgmentRecord({ registryId }) {
    if (registry) { const answer = await registry(registryId); if (answer) return answer; }
    const trial = TRIALS[registryId];
    return trial ? { status: "ok", trial: { registry: "clinicaltrials.gov", registryId, conditions: [], interventions: [], ...trial } } : { status: "registry_not_found", reason: "registry_not_found" };
  } };
  const criteria = [{ id: "c1", kind: "inclusion", sourceText: "Age >= 18" }, { id: "c2", kind: "exclusion", sourceText: "Pregnancy" }];
  const matchStore = { async withdrawnSubjects() { return withdrawn; }, async listCriteria() { return criteria; }, async latestProtocol() { return { id: "pv_1" }; }, async protocols() { return [{ id: "pv_1", version: 1, title: "Own protocol" }]; } };
  const judge = createPairJudge({ config: { deepseekModel: "deepseek-flash", ...config }, callModel: provider.callModel, sleep: async () => {}, counters });
  const targets = judgmentTargets({ evidence, matchStore });
  const subjectTable = tableCells ? { async read() { return { available: true, snapshotId: "snp_1", header: ["USUBJID", ...Object.keys(tableCells)], rows: [["P-1", ...Object.values(tableCells)]], columns: Object.keys(tableCells).map((name) => ({ name })) }; } } : null;
  const run = createMatchJudgeExecutor({ store: { async studyById() { return STUDY; }, async one() { return { checkpoint: {} }; } }, matchStore, judgments, documents, subjectTable, targets, judge, config, report: (code) => reported.push(code), counters });
  const reads_ = createMatchJudgmentReads({ judgments, documents, subjectTable, targets, matchStore });
  const toA = { direction: "patient_to_trial", subjects: ["P-1"], trials: ["NCT00000001", "NCT00000002", "NCT00000003"].map((registryId) => ({ registry: "clinicaltrials.gov", registryId })), fit: true, topK: 2, thinking: "high", model: "deepseek-flash", promptVersions: { fit: "fit-3", criteria: "criteria-5" }, estimate: { pairs: 3 }, chain: "c1" };
  const job = (extra = {}, isCanceled = async () => false) => ({ job: { id: "job_1", jobId: "job_1", studyId: STUDY.id, scenario: { ...(scenario ?? toA), ...extra }, scenarioHash: "a".repeat(64), seed: 0 }, async onProgress() {}, isCanceled });
  return { provider, judgments, counters, reported, reads, documents, matchStore, subjectTable, targets, judge, run, job, reads_, toA };
}

const toB = { direction: "trial_to_patient", protocolVersionId: "pv_1", subjects: ["P-1", "P-2", "P-3"], fit: true, topK: 20, thinking: "high", thinkingCriteria: "high", model: "deepseek-flash", promptVersions: { fit: "fit-3", criteria: "criteria-5" }, estimate: { pairs: 3 }, chain: "c2" };

test("a selection names one direction, and nothing else is accepted", () => {
  assert.equal(judgeSelection({ subjectKey: "P-1", registryIds: ["NCT00000001"] }).direction, "patient_to_trial");
  assert.equal(judgeSelection({ protocolVersionId: "pv_1" }).direction, "trial_to_patient");
  assert.equal(judgeSelection({}).direction, "trial_to_patient");
  assert.deepEqual(judgeSelection({ subjectKey: "P-1", registryIds: ["NCT00000001", "NCT00000001"], topK: "all", fit: false, thinking: "off" }).registryIds, ["NCT00000001"]);
  for (const bad of [{ subjectKey: "P-1" }, { registryIds: ["NCT00000001"] }, { direction: "x" }, { protocolVersionId: "pv", registryIds: ["NCT00000001"] }, { subjectKey: "P-1", registryIds: ["NCT00000001"], subjectKeys: ["P-2"] },
    { subjectKey: "P-1", registryIds: ["NCT00000001"], collection: "c" }, { topK: -1 }, { topK: "some" }, { fit: "yes" }, { fit: false, topK: 0 }, { thinking: "low" }, { scenario: {} }]) {
    assert.throws(() => judgeSelection(bad), (error) => error instanceof HttpError && error.code === "vcr_matching_selection_invalid", JSON.stringify(bad));
  }
});

test("the plan is frozen from the study, says what it will cost, and holds to the scenario's shape", async () => {
  const f = fixture();
  const a = await planMatchJudge({ study: STUDY, selection: { subjectKey: "P-1", registryIds: ["NCT00000001", "ChiCTR2400000001", "2024-513060-26-00"], topK: 1 }, matchStore: f.matchStore, documents: f.documents, config: { deepseekModel: "deepseek-flash" } });
  assert.equal(a.ok, true);
  assert.deepEqual(a.scenario.trials.map((row) => row.registry), ["clinicaltrials.gov", "chictr", "ctis"]);
  assert.equal(a.scenario.estimate.pairs, 3);
  assert.equal(a.scenario.estimate.calls, 4, "three trial-level calls and one clause-level");
  assert.ok(a.scenario.estimate.cost > 0);
  assert.match(a.statement, /判定 3 对/);
  assert.match(a.statement, /排名前 1 的/);
  assert.match(a.statement, /不用确认/);
  assert.deepEqual(validateMatchBatchScenario("matching.judge", a.scenario), []);
  const b = await planMatchJudge({ study: STUDY, selection: {}, matchStore: f.matchStore, documents: f.documents, config: { vcrMatchJudgeTopK: 0, vcrMatchJudgeThinking: "off" } });
  assert.deepEqual([b.scenario.protocolVersionId, b.scenario.subjects, b.scenario.topK, b.scenario.thinking], ["pv_1", ["P-1", "P-2", "P-3"], 0, "off"]);
  assert.deepEqual(validateMatchBatchScenario("matching.judge", b.scenario), []);
  const off = validateMatchBatchScenario("matching.judge", { ...a.scenario, subjects: ["P-1", "P-2"], extra: 1 });
  assert.deepEqual(off.map((issue) => issue.field).sort(), ["scenario.extra", "scenario.subjects"]);
});

test("the plan leaves out who withdrew and says so; nobody to read is a named answer, not a job", async () => {
  const f = fixture({ withdrawn: new Set(["P-2"]) });
  const plan = await planMatchJudge({ study: STUDY, selection: { subjectKeys: ["P-1", "P-2", "P-9"] }, matchStore: f.matchStore, documents: f.documents, config: {} });
  assert.deepEqual(plan.scenario.subjects, ["P-1", "P-9"]);
  assert.match(plan.statement, /1 位已撤回同意/);
  assert.match(plan.statement, /1 位没有病历/);
  const none = await planMatchJudge({ study: STUDY, selection: { subjectKey: "P-9", registryIds: ["NCT00000001"] }, matchStore: f.matchStore, documents: f.documents, config: {} });
  assert.equal(none.ok, false);
  assert.match(none.message, /没有可读的病历/);
});

test("patient to trial: every pair is judged at trial level, then the top K by rank clause by clause, and each pair's rows say what they are", async () => {
  const f = fixture();
  const result = await f.run(f.job());
  assert.equal(result.status, "succeeded");
  assert.equal(result.conclusion, "estimable");
  assert.equal(result.method, "matching.judge");
  const calls = f.provider.calls;
  assert.equal(calls.filter((call) => call.mode === "fit").length, 3);
  assert.deepEqual(calls.filter((call) => call.mode === "criteria").map((call) => /Lung trial|Breast trial/.exec(call.user)[0]).sort(), ["Breast trial", "Lung trial"],
    "the top two by fit that have clauses: the no-text trial ranks second and takes no one's place");
  assert.ok(calls.every((call) => call.purpose === "vcr" && call.runId === "job_1"));
  assert.deepEqual(result.measures.map((m) => [m.name, m.value]), [["pairs_finished", 3], ["pairs_total", 3], ["pairs_failed", 0], ["criteria_pairs_finished", 2], ["criteria_pairs_total", 2]]);
  assert.deepEqual(result.diagnostics.used.calls, 5);
  assert.equal(result.diagnostics.used.inputTokens, 500);
  assert.equal(result.diagnostics.used.outputTokens, 100);
  assert.ok(result.diagnostics.used.cost > 0);
  assert.equal(result.diagnostics.estimate.pairs, 3);
  assert.deepEqual(Object.keys(result.diagnostics.failures ?? {}), []);
  const rows = [...f.judgments.rows.values()];
  const lung = rows.filter((row) => row.targetId === "NCT00000001");
  assert.deepEqual(lung.map((row) => [row.mode, row.status, row.producer, row.model, row.thinking]).sort(), [["criteria", "done", "job", "deepseek-flash", "high"], ["fit", "done", "job", "deepseek-flash", "high"]]);
  const scored = lung.find((row) => row.mode === "fit");
  assert.deepEqual([scored.fit, scored.confidence, scored.verdict, scored.answer.reasons.eligible, scored.answer.eligibilitySource], [90, 0.8, "eligible", ["年龄符合"], "registry"]);
  assert.equal(scored.usage.settings.maxTokens, 32000);
  const clauses = lung.find((row) => row.mode === "criteria");
  assert.deepEqual(clauses.answer.rows.map((row) => [row.number, row.label, row.basis]), [[1, "included", "stated"], [2, "included", "stated"], [3, "not_excluded", "stated"]]);
  assert.deepEqual(clauses.answer.rows[0].evidence, [{ sentenceId: 0, text: "男性，70 岁。", start: 0, end: 8, documentId: "d1" }], "evidence resolved by code to the record's own words");
  assert.deepEqual(clauses.documentIds, ["d1"]);
});

test("the note leads each call, so one patient's trials share a prefix", async () => {
  const f = fixture();
  await f.run(f.job({ topK: 0 }));
  const users = f.provider.calls.map((call) => call.user);
  assert.ok(users.every((user) => user.startsWith(`Patient note/summary:\n${TEXT.d1}`)));
  assert.ok(f.provider.calls.every((call) => call.body.response_format.type === "json_object" && call.body.thinking.type === "enabled" && call.body.reasoning_effort === "high" && call.body.max_tokens === 32000));
});

test("protocol to patients: one protocol's clauses against each person, with its source text as the eligibility text", async () => {
  const f = fixture({ scenario: toB });
  const result = await f.run(f.job());
  assert.equal(result.conclusion, "estimable");
  assert.equal(result.measures.find((m) => m.name === "pairs_total").value, 3);
  assert.equal(result.diagnostics.direction, "trial_to_patient");
  assert.equal(f.provider.calls.filter((call) => call.mode === "criteria").length, 3, "top K is per person, and each person has one protocol");
  const row = [...f.judgments.rows.values()].find((entry) => entry.subjectKey === "P-2" && entry.mode === "fit");
  assert.deepEqual([row.targetKind, row.targetId, row.answer.eligibilitySource, row.answer.target.title], ["protocol_version", "pv_1", "protocol", "Own protocol"]);
  assert.match(f.provider.calls[0].user, /Inclusion Criteria:\n\* Age >= 18/);
  assert.match(f.provider.calls[0].user, /Exclusion Criteria:\n\* Pregnancy/);
});

test("topK all is every pair, topK 0 is none, and no stage one judges clauses in the order named", async () => {
  const all = fixture();
  await all.run(all.job({ topK: "all" }));
  assert.equal(all.provider.calls.filter((call) => call.mode === "criteria").length, 2, "the two trials that have clauses");
  const none = fixture();
  await none.run(none.job({ topK: 0 }));
  assert.equal(none.provider.calls.filter((call) => call.mode === "criteria").length, 0);
  const noFit = fixture();
  const result = await noFit.run(noFit.job({ fit: false, topK: 1 }));
  assert.deepEqual(noFit.provider.calls.map((call) => call.mode), ["criteria"]);
  assert.match(noFit.provider.calls[0].user, /Lung trial/);
  assert.equal(result.measures.find((m) => m.name === "pairs_finished").value, 1);
  assert.equal(result.conclusion, "limited", "two pairs were asked for and were not reached");
});

test("a job with no stage one still judges a trial with no text, on what it has", async () => {
  const f = fixture();
  await f.run(f.job({ fit: false, topK: "all" }));
  assert.deepEqual(f.provider.calls.map((call) => call.mode).sort(), ["criteria", "criteria", "fit"]);
});

test("a trial with no eligibility text is judged on its title and conditions and says so; it is neither unknown nor refused", async () => {
  const f = fixture();
  await f.run(f.job({ topK: 0 }));
  const call = f.provider.calls.find((entry) => /No text trial/.test(entry.user));
  assert.match(call.user, /carries none/);
  assert.match(call.user, /Target conditions: Asthma/);
  const row = [...f.judgments.rows.values()].find((entry) => entry.targetId === "NCT00000003");
  assert.deepEqual([row.status, row.answer.eligibilitySource, row.fit], ["done", "none", 60]);
});

test("resume is the ledger: a repeated job asks nothing again, and a failed pair is tried again", async () => {
  let failing = true;
  const f = fixture({ script: ({ mode, user }) => (failing && mode === "fit" && /Breast trial/.test(user) ? { content: "nonsense" } : null) });
  const first = await f.run(f.job({ topK: 0 }));
  assert.equal(first.conclusion, "limited");
  assert.deepEqual(first.diagnostics.failures, { vcr_match_answer_unreadable: 1 });
  assert.equal(f.provider.calls.length, 4, "an unreadable answer is asked again once before the pair fails");
  failing = false;
  const second = await f.run(f.job({ topK: 0 }));
  assert.equal(f.provider.calls.length, 5, "only the pair that failed is asked again");
  assert.equal(second.conclusion, "estimable");
  assert.deepEqual([second.diagnostics.stages.fit.done, second.diagnostics.stages.fit.already], [1, 2]);
  const third = await f.run(f.job({ topK: 0 }));
  assert.equal(f.provider.calls.length, 5);
  assert.equal(third.diagnostics.stages.fit.already, 3);
  assert.deepEqual(third.diagnostics.used.calls, 0);
});

test("a changed record is a new judgment, and an unchanged one is not", async () => {
  const text = { ...TEXT };
  const f = fixture({ text });
  await f.run(f.job({ topK: 0 }));
  assert.equal(f.provider.calls.length, 3);
  await f.run(f.job({ topK: 0 }));
  assert.equal(f.provider.calls.length, 3);
  f.documents.runtimeRead = async (_study, { documentId }) => ({ id: documentId, text: "男性，70 岁。肺腺癌 IV 期，已脑转移。", sourceHash: "h_changed" });
  await f.run(f.job({ topK: 0 }));
  assert.equal(f.provider.calls.length, 6);
});

test("a cancel stops before the next pair, keeps what was judged, and the next start judges the rest", async () => {
  let canceledAt = 0;
  const f = fixture({ config: { vcrMatchJudgeConcurrency: 1 } });
  const result = await f.run(f.job({ topK: 0 }, async () => { canceledAt += 1; return canceledAt > 1; }));
  assert.equal(f.provider.calls.length, 1);
  assert.equal(result.diagnostics.canceled, true);
  assert.equal(result.conclusion, "limited");
  assert.equal(f.counters.canceled, 1);
  await f.run(f.job({ topK: 0 }));
  assert.equal(f.provider.calls.length, 3, "nothing twice");
});

test("one pair failing is one failed row with its code, and the job goes on", async () => {
  const f = fixture({ registry: async (registryId) => (registryId === "NCT00000002" ? { status: "registry_unavailable", reason: "timeout" } : null) });
  const result = await f.run(f.job());
  assert.equal(result.status, "succeeded");
  assert.equal(result.conclusion, "limited");
  assert.deepEqual(result.diagnostics.failures, { registry_unavailable: 1 });
  assert.deepEqual([result.measures.find((m) => m.name === "pairs_finished").value, result.measures.find((m) => m.name === "pairs_failed").value], [2, 1]);
  const failed = [...f.judgments.rows.values()].find((row) => row.status === "failed");
  assert.deepEqual([failed.targetId, failed.errorCode, failed.fit, failed.answer.target.registryId], ["NCT00000002", "registry_unavailable", undefined, "NCT00000002"]);
  assert.deepEqual(f.reported, ["registry_unavailable"]);
  assert.equal(result.diagnostics.issues[0].code, "registry_unavailable");
});

test("a person whose documents the cloud may not have is a failed pair, by the plane's own code", async () => {
  const f = fixture({ scenario: toB, roster: [...ROSTER.slice(0, 2), { id: "gone", subjectKey: "P-3", chars: 10 }] });
  const result = await f.run(f.job({ topK: 0 }));
  assert.deepEqual(result.diagnostics.failures, { vcr_projection_unavailable: 1 });
  assert.equal(result.conclusion, "limited");
  assert.equal(f.provider.calls.length, 2);
});

test("a person named who has no record at all is a failed pair, with no model call", async () => {
  const f = fixture({ scenario: { ...toB, subjects: ["P-1", "P-9"] } });
  const result = await f.run(f.job({ topK: 0 }));
  assert.deepEqual(result.diagnostics.failures, { vcr_match_no_patient_text: 1 });
  assert.equal(f.provider.calls.length, 1);
});

test("a spent budget stops the job with limited and the reason; what was done stands", async () => {
  const quota = Object.assign(new Error("over"), { code: "usage_budget_exceeded", status: 402 });
  const f = fixture({ config: { vcrMatchJudgeConcurrency: 1 }, script: ({ index }) => (index === 2 ? { throw: quota } : null) });
  const result = await f.run(f.job());
  assert.equal(result.status, "succeeded");
  assert.equal(result.conclusion, "limited");
  assert.equal(f.provider.calls.length, 2, "the third pair is not asked");
  assert.deepEqual(result.diagnostics.stopped.code, "usage_budget_exceeded");
  assert.match(result.diagnostics.stopped.reason, /预算/);
  assert.equal(result.measures.find((m) => m.name === "pairs_finished").value, 1);
  assert.equal(result.diagnostics.remaining, 1);
  assert.equal(f.counters.stopped, 1);
});

test("nothing finished is not success: the job fails by the commonest reason and writes its rows", async () => {
  const quota = Object.assign(new Error("over"), { code: "insufficient_quota" });
  const f = fixture({ script: () => ({ throw: quota }) });
  const result = await f.run(f.job());
  assert.equal(result.status, "failed");
  assert.equal(result.conclusion, "not_estimable");
  assert.equal(result.diagnostics.issues[0].code, "insufficient_quota");
});

test("a provider's refusal of the request itself is not retried and does not count as the provider being down", async () => {
  const refused = Object.assign(new Error("400"), { code: "model_gateway_upstream_error", upstreamStatus: 400 });
  const f = fixture({ config: { vcrMatchJudgeConcurrency: 1, vcrMatchJudgeMaxUpstreamFailures: 1 }, script: ({ mode, user }) => (mode === "fit" && /Lung trial/.test(user) ? { throw: refused } : null) });
  const result = await f.run(f.job({ topK: 0 }));
  assert.equal(f.provider.calls.length, 3, "one try for that pair, and the others still run");
  assert.equal(f.counters.callsRetried, 0);
  assert.equal(result.diagnostics.stopped, undefined);
});

test("the network failing is a transient failure by its own code", async () => {
  const f = fixture({ config: { vcrMatchJudgeConcurrency: 1 }, script: ({ index }) => (index <= 3 ? { throw: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }) } : null) });
  const result = await f.run(f.job({ topK: 0, trials: [{ registry: "clinicaltrials.gov", registryId: "NCT00000001" }, { registry: "clinicaltrials.gov", registryId: "NCT00000002" }] }));
  assert.deepEqual(result.diagnostics.failures, { vcr_match_judge_network: 1 });
  assert.equal(f.counters.callsRetried, 2);
});

test("a transient upstream failure is retried at most twice, and the pair then fails with its code", async () => {
  const down = Object.assign(new Error("502"), { code: "model_gateway_upstream_error", upstreamStatus: 502 });
  let tries = 0;
  const f = fixture({ config: { vcrMatchJudgeConcurrency: 1 }, script: ({ mode, user }) => {
    if (mode === "fit" && /Breast trial/.test(user)) { tries += 1; return { throw: down }; }
    return null;
  } });
  const result = await f.run(f.job({ topK: 0 }));
  assert.equal(tries, 3, "the first try and two more");
  assert.equal(f.counters.callsRetried, 2);
  assert.deepEqual(result.diagnostics.failures, { model_gateway_upstream_error: 1 });
  const flaky = fixture({ script: ({ index }) => (index === 1 ? { throw: down } : null), config: { vcrMatchJudgeConcurrency: 1 } });
  const passed = await flaky.run(flaky.job({ topK: 0 }));
  assert.equal(passed.conclusion, "estimable", "a retry that succeeds leaves nothing behind");
});

test("a provider that is down stops the job after a configured run of failures, and a success resets the run", async () => {
  const down = Object.assign(new Error("502"), { code: "model_gateway_upstream_error" });
  const f = fixture({ scenario: { ...toB, subjects: Array.from({ length: 6 }, (_, i) => `P-${i}`) }, roster: Array.from({ length: 6 }, (_, i) => ({ id: "d1", subjectKey: `P-${i}`, chars: 5 })), config: { vcrMatchJudgeConcurrency: 1, vcrMatchJudgeMaxUpstreamFailures: 2 }, script: () => ({ throw: down }) });
  const result = await f.run(f.job({ topK: 0 }));
  assert.equal(f.provider.calls.length, 6, "two pairs of three tries each, then nothing more");
  assert.equal(result.diagnostics.stopped.code, "model_gateway_upstream_error");
  assert.match(result.diagnostics.stopped.reason, /连续 2 次/);
  assert.equal(result.status, "failed", "and it finished nothing");
});

test("output cut off by the allowance is a failed pair, never an empty answer, and its usage is counted", async () => {
  const f = fixture({ script: ({ mode, user }) => (mode === "fit" && /Lung trial/.test(user) ? { finish: "length", content: '{"score": 9' } : null) });
  const result = await f.run(f.job({ topK: 0 }));
  assert.deepEqual(result.diagnostics.failures, { vcr_match_judge_cut_off: 1 });
  const row = [...f.judgments.rows.values()].find((entry) => entry.status === "failed");
  assert.deepEqual([row.targetId, row.errorCode, row.fit], ["NCT00000001", "vcr_match_judge_cut_off", undefined]);
  assert.equal(result.diagnostics.used.outputTokens, 80, "the words it paid for are in the bill, both times");
  assert.equal(f.provider.calls.length, 4, "a cut-off answer is asked again once, then the pair fails");
});

test("an answer with no score or no clause is a failed pair; a partial clause answer is saved and names what is missing", async () => {
  const f = fixture({ script: ({ mode, user }) => (mode === "criteria" && /Lung trial/.test(user) ? { content: '{"1":["x",[0,99],"included"]}' } : mode === "criteria" ? { content: "{}" } : null) });
  const result = await f.run(f.job({ topK: "all" }));
  const row = [...f.judgments.rows.values()].find((entry) => entry.targetId === "NCT00000001" && entry.mode === "criteria");
  assert.deepEqual(row.answer.rows.map((entry) => entry.number), [1]);
  assert.deepEqual(row.answer.missing.map((entry) => entry.number), [2, 3]);
  assert.equal(row.answer.droppedSentenceIds, 1);
  assert.equal(row.verdict, "possible");
  assert.deepEqual(result.diagnostics.failures, { vcr_match_answer_unreadable: 1 });
});

test("an unreadable answer that reads fine when asked again costs one call and no failure", async () => {
  let garbled = 1;
  const f = fixture({ script: ({ mode, user }) => {
    if (mode === "fit" && /Breast trial/.test(user) && garbled > 0) { garbled -= 1; return { content: "nonsense" }; }
    return null;
  } });
  const result = await f.run(f.job({ topK: 0 }));
  assert.equal(result.diagnostics.failures, undefined);
  assert.equal(f.provider.calls.length, 4);
});

test("a withdrawal in flight: nothing of the person is put back", async () => {
  const f = fixture();
  f.judgments.withdrawn.add("P-1");
  const result = await f.run(f.job({ topK: 0 }));
  assert.equal([...f.judgments.rows.values()].length, 0);
  assert.equal(result.status, "failed", "nothing is saved, so nothing finished");
});

test("everyone on the frozen roster having withdrawn is a job that judged nobody", async () => {
  const f = fixture({ scenario: toB, withdrawn: new Set(["P-1", "P-2", "P-3"]) });
  const result = await f.run(f.job({ topK: 0 }));
  assert.deepEqual([result.status, result.conclusion, result.diagnostics.issues[0].code], ["failed", "not_estimable", "vcr_match_nothing_finished"]);
  assert.equal(f.provider.calls.length, 0);
});

test("a long record that fails on a later part still bills the parts it read", async () => {
  const down = Object.assign(new Error("400"), { code: "model_gateway_upstream_error", upstreamStatus: 400 });
  const long = `${"既往体健。".repeat(7000)}\n\n${"复查无异常。".repeat(7000)}`;
  const f = fixture({ text: { d1: long }, roster: [ROSTER[0]], script: ({ index }) => (index === 2 ? { throw: down } : null) });
  const result = await f.run(f.job({ topK: 0, trials: [{ registry: "clinicaltrials.gov", registryId: "NCT00000001" }] }));
  assert.equal(result.diagnostics.used.calls, 1);
  assert.equal(result.diagnostics.used.inputTokens, 100);
  assert.deepEqual(result.diagnostics.failures, { model_gateway_upstream_error: 1 });
});

test("a withdrawn person is not read at all", async () => {
  const f = fixture({ scenario: toB, withdrawn: new Set(["P-2"]) });
  const result = await f.run(f.job({ topK: 0 }));
  assert.ok(!f.reads.some((read) => read.subjectKey === "P-2"));
  assert.equal(result.diagnostics.skippedWithdrawn, 1);
  assert.equal(result.measures.find((m) => m.name === "pairs_total").value, 2);
});

test("the record reaches the model through the cloud reader under the job's own context", async () => {
  const f = fixture();
  await f.run(f.job({ topK: 0 }));
  assert.deepEqual(f.reads[0].cloudContext, { runId: "job_1", sessionId: "vcr-job:job_1" });
});

test("a record over the cap is split at its boundaries and judged per part; a stated conflict in one part is what stands", async () => {
  const long = `${"既往体健。".repeat(7000)}\n\n诊断：肺腺癌。\n\n${"复查无异常。".repeat(7000)}\n\n妊娠试验阳性。`;
  const f = fixture({ text: { d1: long }, roster: [ROSTER[0]], script: ({ mode, user }) => {
    if (mode !== "fit") return null;
    return /妊娠试验阳性/.test(user) ? { content: fitJson(3, { ineligible_reasons: "1. 妊娠" }) } : { content: fitJson(85) };
  } });
  await f.run(f.job({ topK: 0, trials: [{ registry: "clinicaltrials.gov", registryId: "NCT00000001" }] }));
  assert.ok(f.provider.calls.length >= 2, "more than one part");
  const row = [...f.judgments.rows.values()][0];
  assert.deepEqual([row.fit, row.answer.reasons.ineligible, row.verdict], [3, ["妊娠"], "ineligible"]);
  assert.equal(row.answer.parts, f.provider.calls.length);
  assert.equal(row.usage.calls, f.provider.calls.length);
});

test("a record's sentences run across its documents and its table cells; the hash follows them", async () => {
  const f = fixture({ tableCells: { AGE: "AGE = 70 year", SEX: "SEX = M" }, roster: [ROSTER[0], { id: "d2", subjectKey: "P-1", chars: 5, visibleAt: "2020-01-01" }] });
  const table = await (await import("../src/vcrMatchJudge.mjs")).tableFieldsOf(f.subjectTable, STUDY);
  assert.deepEqual([table.fields, table.subjects], [["AGE", "SEX"], ["P-1"]]);
  const note = await readSubjectNote({ study: STUDY, subjectKey: "P-1", documents: f.documents, roster: [ROSTER[0], { id: "d2", visibleAt: "2020-01-01" }], table });
  assert.deepEqual(note.records.map((record) => record.documentId), ["d1", "d2", null], "a record with no date first, then by date, then the table");
  assert.deepEqual(note.sentences.map((sentence) => sentence.id), note.sentences.map((_, index) => index));
  const cells = note.sentences.filter((sentence) => sentence.documentId === null);
  assert.deepEqual(cells.map((cell) => [cell.text, cell.source.field]), [["AGE = 70 year", "AGE"], ["SEX = M", "SEX"]]);
  const other = await readSubjectNote({ study: STUDY, subjectKey: "P-1", documents: f.documents, roster: [ROSTER[0]], table: null });
  assert.notEqual(note.hash, other.hash);
});

test("the people who have only a table row are on the roster, and are judged", async () => {
  const f = fixture({ tableCells: { AGE: "AGE = 70 year" }, roster: [] });
  const plan = await planMatchJudge({ study: STUDY, selection: {}, matchStore: f.matchStore, documents: f.documents, subjectTable: f.subjectTable, config: {} });
  assert.deepEqual(plan.scenario.subjects, ["P-1"]);
  const result = await f.run({ ...f.job({ ...plan.scenario, topK: 0 }) });
  assert.equal(result.conclusion, "estimable");
  assert.match(f.provider.calls[0].user, /AGE = 70 year/);
});

test("each stage keeps its own thinking: off for the trial-level call, high clause by clause, as measured", async () => {
  const f = fixture();
  await f.run(f.job({ topK: "all", thinking: "off", thinkingCriteria: "high" }));
  const byMode = { fit: new Set(), criteria: new Set() };
  for (const row of f.judgments.rows.values()) byMode[row.mode].add(row.thinking);
  assert.deepEqual([[...byMode.fit], [...byMode.criteria]], [["off"], ["high"]]);
  assert.ok(f.provider.calls.some((call) => call.body.thinking.type === "disabled") && f.provider.calls.some((call) => call.body.thinking.type === "enabled"));
  const asked = f.provider.calls.length;
  await f.run(f.job({ topK: "all", thinking: "off", thinkingCriteria: "high" }));
  assert.equal(f.provider.calls.length, asked, "a resume finds both stages in the ledger");
});

test("with thinking off the allowance is small: an answer that long has run away", async () => {
  const f = fixture();
  await f.run(f.job({ topK: 0, thinking: "off" }));
  assert.ok(f.provider.calls.every((call) => call.body.max_tokens === 6000));
});

test("thinking off is recorded on the row and is its own judgment", async () => {
  const f = fixture();
  await f.run(f.job({ topK: 0, thinking: "off" }));
  assert.ok(f.provider.calls.every((call) => call.body.thinking.type === "disabled" && call.body.temperature === 0 && call.body.reasoning_effort === undefined));
  assert.ok([...f.judgments.rows.values()].every((row) => row.thinking === "off"));
  await f.run(f.job({ topK: 0, thinking: "high" }));
  assert.equal(f.provider.calls.length, 6, "the other arm's rows are not this arm's");
});

test("starting says what it will do and queues one job; the same selection while it is out is that job", async () => {
  /** @type {any[]} */ const queued = [];
  const store = { async rows() { return queued.map((row) => ({ id: row.id, state: "queued" })); } };
  const jobs = { store, async enqueue(input) { const job = { id: `job_${queued.length + 1}`, state: "queued", input }; queued.push(job); return { job }; } };
  const f = fixture();
  const start = createMatchJudge({ jobs, matchStore: f.matchStore, documents: f.documents, config: {} });
  const first = await start.start({ ...STUDY, completionOrigin: { sessionId: "s" } }, { subjectKey: "P-1", registryIds: ["NCT00000001"] });
  assert.deepEqual([first.kind, first.state, first.jobId, first.direction, first.topK, first.thinking, first.thinkingCriteria], ["match_judge", "queued", "job_1", "patient_to_trial", 20, "off", "high"]);
  assert.match(first.statement, /不用确认/);
  assert.deepEqual(queued[0].input.detail.conversationOrigin, { sessionId: "s" });
  assert.equal(queued[0].input.internal, true);
  const again = await start.start(STUDY, { subjectKey: "P-1", registryIds: ["NCT00000001"] });
  assert.deepEqual([again.jobId, again.alreadyRunning], ["job_1", true]);
  const nothing = createMatchJudge({ jobs, matchStore: f.matchStore, documents: { async roster() { return []; } }, config: {} });
  await assert.rejects(() => nothing.start(STUDY, { subjectKey: "P-1", registryIds: ["NCT00000001"] }), { code: "vcr_match_judge_nothing_to_read" });
});

test("a reader sees each pair once, ranked: verdict from what is stored, plain labels, and what failed is named", async () => {
  const f = fixture({ registry: async (registryId) => (registryId === "NCT00000002" ? { status: "registry_unavailable" } : null) });
  await f.run(f.job({ topK: 5 }));
  const answer = await f.reads_.forSubject(STUDY, "P-1", {});
  assert.deepEqual(answer.ranking.map((row) => row.target.id), ["NCT00000001", "NCT00000003"]);
  const first = answer.ranking[0];
  assert.deepEqual([first.verdict, first.verdictLabel, first.fit, first.confidence, first.producer, first.eligibilitySource], ["eligible", "符合", 90, 0.8, "job", "registry"]);
  assert.deepEqual(first.criteria.map((row) => [row.number, row.display]), [[1, "符合"], [2, "符合"], [3, "未符合排除条件"]]);
  assert.equal(first.criteria[0].evidence[0].text, "男性，70 岁。");
  assert.deepEqual(answer.failed.map((row) => [row.target.id, row.code]), [["NCT00000002", "registry_unavailable"]]);
  assert.deepEqual([answer.finished, answer.failedPairs, answer.more], [2, 1, false]);
});

test("a stated disqualifier is the verdict and does not move a scored trial, and silence reads as silence", async () => {
  const f = fixture({ script: ({ mode, user }) => {
    if (mode === "fit") return { content: fitJson(/Lung trial/.test(user) ? 95 : 40) };
    return /Lung trial/.test(user) ? { content: '{"1":["x",[0],"included"],"2":["y",[0],"included"],"3":["妊娠",[1],"excluded"]}' } : { content: '{"1":["x",[],"included"],"2":["未提及",[],"not enough information"]}' };
  } });
  await f.run(f.job({ topK: 5 }));
  const { ranking } = await f.reads_.forSubject(STUDY, "P-1", {});
  assert.deepEqual(ranking.map((row) => [row.target.id, row.verdict]), [["NCT00000001", "ineligible"], ["NCT00000002", "insufficient"], ["NCT00000003", "insufficient"]], "an open clause at a score of 40 is a prerequisite open");
  const breast = ranking.find((row) => row.target.id === "NCT00000002");
  assert.deepEqual(breast.criteria.map((row) => row.display), ["未见记载，按符合", "未见记载，需确认"]);
});

test("evidence the cloud may no longer read is withheld from the model, and the label stands", async () => {
  const f = fixture();
  await f.run(f.job({ topK: 1 }));
  f.documents.runtimeEvidence = async () => [];
  const { ranking } = await f.reads_.forSubject(STUDY, "P-1", {});
  assert.deepEqual(ranking[0].criteria[0].evidence, []);
  assert.equal(ranking[0].criteria[0].evidenceWithheld, 1);
  assert.equal(ranking[0].criteria[0].label, "included");
});

test("a pair's verdict uses both rows; a person's list and a protocol's list read the same", async () => {
  const f = fixture({ scenario: toB });
  await f.run(f.job({ topK: 1 }));
  const answer = await f.reads_.forProtocol(STUDY, "pv_1", { limit: 2 });
  assert.deepEqual(answer.ranking.length, 2);
  assert.equal(answer.more, true);
  assert.deepEqual(answer.ranking[0].target.kind, "protocol_version");
  assert.deepEqual(new Set(answer.ranking.map((row) => row.subjectKey)).size, 2);
  const one = await f.reads_.forProtocol(STUDY, "pv_1", { subjectKey: "P-3" });
  assert.deepEqual(one.ranking.map((row) => row.subjectKey), ["P-3"]);
  assert.deepEqual(presentJudgment({ status: "failed", answer: {} }, null).fit, null);
});

test("numbered sentences: pages of the same numbers, with the hash a write names, and what a run was shown is recorded", async () => {
  const f = fixture();
  /** @type {any[]} */ const windows = [];
  f.documents.recordWindow = async (_study, documentId, _text, start, end) => { windows.push({ documentId, start, end }); };
  const page = await f.reads_.sentences(STUDY, { subjectKey: "P-1", limit: 2 });
  assert.deepEqual(page.sentences, [{ id: 0, text: "男性，70 岁。", documentId: "d1" }, { id: 1, text: "肺腺癌 IV 期。", documentId: "d1" }]);
  assert.deepEqual([page.more, page.nextOffset, page.sentencesTotal], [true, 2, 3]);
  assert.match(page.documentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(windows, [{ documentId: "d1", start: 0, end: 17 }]);
  const next = await f.reads_.sentences(STUDY, { subjectKey: "P-1", offset: 2 });
  assert.deepEqual([next.sentences[0].id, next.more], [2, false]);
  assert.equal(next.documentHash, page.documentHash);
  assert.equal((await f.reads_.sentences(STUDY, { subjectKey: "P-9" })).code, "vcr_match_no_patient_text");
  assert.equal((await f.reads_.sentences(STUDY, {})).code, "vcr_read_filter_invalid");
});

test("a conversation's own judgment is the same record: parsed by the same parsers, producer conversation, and read by the same reader", async () => {
  const f = fixture();
  const { documentHash } = await f.reads_.sentences(STUDY, { subjectKey: "P-1" });
  const written = await f.reads_.writeConversation(STUDY, { subjectKey: "P-1", registryId: "NCT00000001", fit: 72, confidence: 0.6, reasons: { eligible: ["a"], missing: ["b"], rationale: "c" },
    criteria: [{ number: 1, reason: "r", sentenceIds: [0, 99], label: "included" }, { number: 3, reason: "未提及", sentenceIds: [], label: "not excluded" }, { number: 42, reason: "?", sentenceIds: [], label: "included" }], documentHash });
  assert.deepEqual([written.verdict, written.verdictLabel], ["possible", "可能符合"]);
  assert.deepEqual(written.notices.map((notice) => notice.code).sort(), ["clauses_not_answered", "criterion_unknown", "sentence_ids_dropped"]);
  const rows = [...f.judgments.rows.values()];
  assert.deepEqual(rows.map((row) => [row.mode, row.producer, row.promptVersion]).sort(), [["criteria", "conversation", "conversation"], ["fit", "conversation", "conversation"]]);
  const { ranking } = await f.reads_.forSubject(STUDY, "P-1", {});
  assert.deepEqual(ranking[0].criteria.map((row) => [row.number, row.display]), [[1, "符合"], [3, "未见记载，按未排除"]]);
  assert.deepEqual(ranking[0].reasons.missing, ["b"]);
  // a second answer on the same inputs replaces the first, because it is the same producer changing its mind
  await f.reads_.writeConversation(STUDY, { subjectKey: "P-1", registryId: "NCT00000001", fit: 20, documentHash });
  assert.equal((await f.reads_.forSubject(STUDY, "P-1", {})).ranking[0].fit, 20);
  await assert.rejects(() => f.reads_.writeConversation(STUDY, { subjectKey: "P-1", registryId: "NCT00000001", fit: 20, documentHash: "b".repeat(64) }), { code: "vcr_match_note_changed" });
});

test("a conversation judges a protocol too, and a clinical answer of any kind is saved", async () => {
  const f = fixture();
  const written = await f.reads_.writeConversation(STUDY, { subjectKey: "P-2", protocolVersionId: "pv_1", criteria: [{ number: 1, reason: "58 岁", sentenceIds: [0], label: "included" }, { number: 2, reason: "妊娠", sentenceIds: [1], label: "excluded" }] });
  assert.equal(written.verdict, "ineligible");
  assert.deepEqual(await f.reads_.protocolClauses(STUDY, "pv_1"), [{ number: 1, kind: "inclusion", text: "Age >= 18" }, { number: 2, kind: "exclusion", text: "Pregnancy" }]);
});

test("a registry record reaches a judgment whole: its summary, conditions, interventions and every word of its eligibility text; a registry that cannot answer is a status", async () => {
  const eligibility = `Inclusion Criteria:\n* Age >= 18\n* ${"x".repeat(120_000)}`;
  const record = (id = "NCT00000001") => ctgovPrecedent({ protocolSection: { identificationModule: { nctId: id, briefTitle: "Lung trial" }, descriptionModule: { briefSummary: "A summary" }, statusModule: { overallStatus: "RECRUITING" },
    conditionsModule: { conditions: ["NSCLC"] }, designModule: { phases: ["PHASE2"] }, armsInterventionsModule: { interventions: [{ type: "DRUG", name: "Osimertinib" }] }, eligibilityModule: { eligibilityCriteria: eligibility } } }, { retrievedAt: "2026-11-04T00:00:00.000Z" });
  const registry = { async record(id) { return id === "NCT00000404" ? { status: "registry_not_found" } : id === "NCT00000500" ? { status: "registry_unavailable", reason: "timeout" } : { status: "ok", ...record(id) }; } };
  const pipeline = createVcrEvidencePipeline({ store: {}, registry, jobs: {} });
  const read = await pipeline.judgmentRecord({ registry: "clinicaltrials.gov", registryId: "NCT00000001" });
  assert.equal(read.status, "ok");
  assert.deepEqual([read.trial.title, read.trial.summary, read.trial.conditions, read.trial.interventions, read.trial.status, read.trial.phase], ["Lung trial", "A summary", ["NSCLC"], ["Osimertinib"], "RECRUITING", "PHASE2"]);
  assert.equal(read.trial.eligibility, eligibility, "a clause is never truncated");
  assert.equal((await pipeline.judgmentRecord({ registryId: "NCT00000404" })).status, "registry_not_found");
  assert.equal((await pipeline.judgmentRecord({ registryId: "NCT00000500" })).status, "registry_unavailable");
  const targets = judgmentTargets({ evidence: pipeline, matchStore: {} });
  const target = await targets.trial({ userId: "u", registry: "clinicaltrials.gov", registryId: "NCT00000001" });
  assert.deepEqual([target.kind, target.id, target.eligibilitySource, target.clauses.length, target.summaryOfTarget.registry, target.summaryOfTarget.title], ["candidate_trial", "NCT00000001", "registry", 2, "clinicaltrials.gov", "Lung trial"]);
  await assert.rejects(() => targets.trial({ userId: "u", registry: "clinicaltrials.gov", registryId: "NCT00000404" }), { code: "registry_not_found" });
  await assert.rejects(() => targets.trial({ userId: "u", registry: "clinicaltrials.gov", registryId: "NCT00000500" }), { code: "registry_unavailable" });
});

test("a registry read carries its numbered clauses, and a record with no eligibility text carries none", async () => {
  const read = async (text) => new VcrService({ store: {}, config: {}, evidence: { async registryRecord() { return { available: true, status: "ok", record: { registryId: "NCT00000001", eligibilityText: text } }; } } })
    .runtimeRead({ id: "std_1", userId: "u" }, "trial_registry_record", { registryId: "NCT00000001" });
  const answer = await read("Inclusion Criteria:\n* Age >= 18\nExclusion Criteria:\n* Pregnancy");
  assert.deepEqual(answer.clauses, [{ number: 1, kind: "inclusion", text: "Age >= 18" }, { number: 2, kind: "exclusion", text: "Pregnancy" }]);
  assert.equal((await read("")).clauses, undefined);
});

test("the numbered sentences and the ranking read through the service, and a study without the piece says so", async () => {
  const f = fixture();
  const service = new VcrService({ store: {}, config: {}, documents: { ...f.documents, async subjectDocuments() { return { available: true }; } }, patientTrials: { async runtimeRead() { return { trials: [], ranking: [], requests: [], today: true }; } } });
  const off = await service.runtimeRead({ id: "std_1", userId: "u" }, "subject_document", { subjectKey: "P-1", kind: "sentences" });
  assert.equal(off.code, "vcr_matching_unavailable");
  assert.equal((await service.runtimeRead({ id: "std_1", userId: "u" }, "candidate_trials", { subjectKey: "P-1" })).today, true);
  service.attach({ matchJudgments: f.reads_ });
  const on = await service.runtimeRead(STUDY, "subject_document", { subjectKey: "P-1", kind: "sentences" });
  assert.equal(on.sentences.length, 3);
  assert.equal((await service.runtimeRead(STUDY, "candidate_trials", { subjectKey: "P-1" })).today, true, "nothing judged yet: the answer it always gave");
  await f.run(f.job({ topK: 0 }));
  const ranked = await service.runtimeRead(STUDY, "candidate_trials", { subjectKey: "P-1" });
  assert.deepEqual(ranked.ranking.map((row) => row.target.id), ["NCT00000001", "NCT00000003", "NCT00000002"]);
  assert.equal(ranked.today, undefined);
});

test("a batch gives its turn back with what it needs and carries on from there; what failed for a passing reason is tried once more, and a provider that is down is waited out", async () => {
  const roster = Array.from({ length: 12 }, (_, index) => `P-${index}`);
  const scenario = { ...toB, subjects: roster, topK: 0 };
  let failingCalls = 0;
  /** @type {any} */ let checkpoint = {};
  const f = fixture({ scenario });
  const records = { ...f.documents, async roster() { return roster.map((subjectKey, index) => ({ id: `d${index}`, subjectKey, chars: 9 })); }, async runtimeRead(_s, { documentId }) { return { id: documentId, text: `记录 ${documentId}。`, projectionHash: documentId }; } };
  const store = { async studyById() { return STUDY; }, async one() { return { checkpoint }; } };
  const judge = { ...f.judge, maxTokens: 1000, timeoutMs: 1000, async call() {
    if (failingCalls > 0) { failingCalls -= 1; throw Object.assign(new Error("upstream"), { code: "model_gateway_upstream_error" }); }
    return { content: '{"score":70,"confidence":0.5,"eligible_reasons":"1. a","ineligible_reasons":"","missing_information":""}', usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, reasoningTokens: 0 }, cost: 0.01, currency: "CNY" };
  } };
  const run = createMatchJudgeExecutor({ store, matchStore: f.matchStore, judgments: f.judgments, documents: records, targets: f.targets, judge, config: { vcrMatchJudgeSlicePairs: 5, vcrMatchJudgeConcurrency: 2, vcrMatchJudgeMaxUpstreamFailures: 2, vcrMatchJudgeOutageWaits: 1 } });
  const step = () => run({ job: { id: "job_y", jobId: "job_y", studyId: STUDY.id, scenario: { ...scenario, chain: "c" }, scenarioHash: "a".repeat(64), seed: 0 }, onProgress: async () => {}, yieldable: true });
  const first = await step();
  assert.ok(first.yield, "a batch ended");
  assert.equal(first.yield.afterSeconds, 0);
  assert.match(first.yield.checkpoint.judge.marks.fit, /^d{5,6}\.+$/u);
  assert.equal(first.yield.checkpoint.judge.at.stage, "fit");
  assert.equal(first.yield.checkpoint.judge.used.calls >= 5, true);
  checkpoint = first.yield.checkpoint;

  // The provider goes down in the middle: two failures in a row is an outage here, and the job waits rather than ends.
  failingCalls = 2;
  const second = await step();
  assert.ok(second.yield);
  assert.equal(second.yield.afterSeconds, 120);
  assert.equal(second.yield.checkpoint.judge.waits, 1);
  assert.match(second.yield.checkpoint.judge.marks.fit, /t/u);
  checkpoint = second.yield.checkpoint;

  // Back again: the rest, then the second look at what failed for a reason that passes.
  let turn = second;
  for (let index = 0; index < 8 && turn.yield; index += 1) { checkpoint = turn.yield.checkpoint; turn = await step(); }
  assert.equal(turn.status, "succeeded");
  assert.equal(turn.conclusion, "estimable", JSON.stringify(turn.diagnostics.stages));
  assert.deepEqual([turn.diagnostics.finished, turn.diagnostics.total, turn.diagnostics.failed], [12, 12, 0]);
  assert.equal(turn.diagnostics.used.calls, 12, "the bill runs across batches, and a failed call pays for no words");
  assert.ok(turn.diagnostics.failures.model_gateway_upstream_error >= 1, "and it still says the provider failed");
});

test("what re-judging changed is said from the rows: the newest words against the words before them", async () => {
  const rows = [
    { subjectKey: "P", targetKind: "candidate_trial", targetId: "T1", documentHash: "new", targetHash: "h", mode: "fit", status: "done", verdict: "ineligible", updatedAt: "2026-11-04T02:00:00Z" },
    { subjectKey: "P", targetKind: "candidate_trial", targetId: "T1", documentHash: "old", targetHash: "h", mode: "fit", status: "done", verdict: "eligible", updatedAt: "2026-11-04T01:00:00Z" },
    { subjectKey: "P", targetKind: "candidate_trial", targetId: "T2", documentHash: "new", targetHash: "h", mode: "fit", status: "done", verdict: "possible", updatedAt: "2026-11-04T02:00:00Z" },
    { subjectKey: "P", targetKind: "candidate_trial", targetId: "T2", documentHash: "old", targetHash: "h", mode: "fit", status: "done", verdict: "possible", updatedAt: "2026-11-04T01:00:00Z" },
    { subjectKey: "P", targetKind: "candidate_trial", targetId: "T3", documentHash: "new", targetHash: "h", mode: "fit", status: "done", verdict: "possible", updatedAt: "2026-11-04T02:00:00Z" },
    { subjectKey: "P", targetKind: "candidate_trial", targetId: "T4", documentHash: "old", targetHash: "h", mode: "fit", status: "done", verdict: "eligible", updatedAt: "2026-11-04T01:00:00Z" },
    { subjectKey: "P", targetKind: "candidate_trial", targetId: "T4", documentHash: "new", targetHash: "h", mode: "criteria", status: "done", verdict: "ineligible", updatedAt: "2026-11-04T02:00:00Z" },
    { subjectKey: "P", targetKind: "candidate_trial", targetId: "T5", documentHash: "new", targetHash: "h", mode: "fit", status: "failed", verdict: null, updatedAt: "2026-11-04T02:00:00Z" },
  ];
  const changes = judgmentChanges(rows);
  assert.equal(changes.compared, 3, "T3 has nothing before it, and a failed row is no verdict");
  assert.deepEqual(changes.pairs.map((pair) => [pair.targetId, pair.from, pair.to]).sort(), [["T1", "符合", "不符合"], ["T4", "符合", "不符合"]]);
  assert.equal(changes.sentence, "重算后 2 个试验结论变化。");
  assert.equal(judgmentChanges([rows[2], rows[3]]).sentence, "重算了 1 个试验，结论都没有变化。");
  assert.equal(judgmentChanges([]).sentence, "");
});
