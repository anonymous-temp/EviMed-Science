// What a judging job says of its two stages, and what stands behind a verdict once a person has more than one reading: the second stage's rows after a batch, a stage that failed or never
// ran, a later note with K below the trials, a record read in part, and a database that stalls at the start of a batch. On doubles for the model, the ledger and the record.
import assert from "node:assert/strict";
import test from "node:test";
import { createMatchJudgeExecutor, createMatchJudgmentReads, createPairJudge, judgmentChanges, judgmentTargets, presentJudgment, readSubjectNote } from "../src/vcrMatchJudge.mjs";
import { judgmentKey } from "../src/vcrMatchJudgmentStore.mjs";
import { vcrJobNoticeText } from "../src/vcrNotify.mjs";
import { VCR_JUDGMENT_PROMPT_VERSIONS } from "@evimed/domain";

const STUDY = { id: "std_1", userId: "u_1", projectId: "p_1" };
const TRIALS = {
  NCT00000001: { title: "T1", summary: "S", eligibility: "Inclusion Criteria:\n* Age >= 18\nExclusion Criteria:\n* Pregnancy" },
  NCT00000002: { title: "T2", summary: "S", eligibility: "Inclusion Criteria:\n* Lung\nExclusion Criteria:\n* Pregnancy" },
  NCT00000003: { title: "T3", summary: "S", eligibility: "Inclusion Criteria:\n* Heart\nExclusion Criteria:\n* Pregnancy" },
};

function judgmentsDouble() {
  const byKey = new Map();
  let seq = 0;
  /** @type {any[]} */
  const jobs = [];
  return {
    rows: byKey, jobs,
    async save(entry) {
      const row = { thinking: "", model: "", targetHash: "", documentHash: "", answer: {}, ...entry };
      const key = judgmentKey(row);
      const held = byKey.get(key);
      if (held && held.status === "done") return held;
      seq += 1;
      const saved = { ...row, id: `j${seq}`, createdAt: `2026-11-04T00:00:${String(seq).padStart(2, "0")}Z`, updatedAt: `2026-11-04T00:00:${String(seq).padStart(2, "0")}Z`, disqualified: false, target: row.answer?.target ?? null, eligibilitySource: row.answer?.eligibilitySource ?? null };
      byKey.set(key, saved);
      return saved;
    },
    async doneFor({ promptVersions, model, thinking }) {
      const wanted = Array.isArray(thinking) ? thinking : [thinking];
      return new Map([...byKey].filter(([, row]) => row.status === "done" && row.producer === "job" && promptVersions.includes(row.promptVersion) && row.model === model && wanted.includes(row.thinking)));
    },
    async list({ subjectKey = null, targetKind = null, targetId = null }) {
      return [...byKey.values()].filter((row) => (!subjectKey || row.subjectKey === subjectKey) && (!targetKind || row.targetKind === targetKind) && (!targetId || row.targetId === targetId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async byIds(_study, ids) { return [...byKey.values()].filter((row) => ids.includes(row.id)); },
    async jobsOf() { return jobs; },
  };
}

const matchStore = { async withdrawnSubjects() { return new Set(); }, async listCriteria() { return []; }, async latestProtocol() { return null; } };
const evidence = { async judgmentRecord({ registryId }) { return { status: "ok", trial: { registry: "clinicaltrials.gov", registryId, conditions: [], interventions: [], ...TRIALS[registryId] } }; } };

function setup({ fitScore = () => 70, clauseAnswer, text = "男性，70岁。肺癌。", config = {}, documents: documentsGiven = null } = {}) {
  const state = { text };
  const documents = documentsGiven ?? { async roster() { return [{ id: "d1", subjectKey: "P-1", chars: state.text.length }]; }, async runtimeRead(_study, { documentId }) { return { id: documentId, text: state.text, subjectKey: "P-1", sourceHash: `h${state.text.length}` }; }, runtimeEvidence: async (_study, items) => items };
  const callModel = async (_deps, call) => {
    const system = call.body.messages[0].content, user = call.body.messages[1].content;
    const trial = (/Title: (T\d)/u.exec(user) ?? [])[1];
    const content = system.includes("criterion level") ? clauseAnswer(user, trial, state)
      : JSON.stringify({ score: fitScore(trial, state), confidence: 0.8, eligible_reasons: "1. a", ineligible_reasons: "", missing_information: "1. m", rationale: "r" });
    return { choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 } };
  };
  const judge = createPairJudge({ config: { deepseekModel: "deepseek-flash" }, callModel, sleep: async () => {} });
  const judgments = judgmentsDouble();
  const targets = judgmentTargets({ evidence, matchStore });
  /** @type {{ checkpoint: Record<string, any> }} */
  const held = { checkpoint: {} };
  const store = { async studyById() { return STUDY; }, async one() { return { checkpoint: held.checkpoint }; } };
  let canceled = false;
  const run = createMatchJudgeExecutor({ store, matchStore, judgments, documents, targets, judge, config: { vcrMatchJudgeConcurrency: 1, ...config } });
  const scenario = (extra = {}) => ({ direction: "patient_to_trial", subjects: ["P-1"], trials: Object.keys(TRIALS).map((registryId) => ({ registry: "clinicaltrials.gov", registryId })), fit: true, topK: "all", thinking: "off", thinkingCriteria: "high", model: "deepseek-flash", promptVersions: VCR_JUDGMENT_PROMPT_VERSIONS, chain: "c1", ...extra });
  const step = async (extra = {}, options = {}) => {
    const answer = await run({ job: { id: "j", jobId: "j", studyId: STUDY.id, scenario: scenario(extra), scenarioHash: "a".repeat(64), seed: 0 }, onProgress: async () => {}, yieldable: true, isCanceled: async () => canceled, ...options });
    if (answer.yield) held.checkpoint = answer.yield.checkpoint;
    return answer;
  };
  const toEnd = async (extra = {}) => {
    held.checkpoint = {};
    for (let turn = 0; turn < 40; turn += 1) { const answer = await step(extra); if (!answer.yield) return answer; }
    throw new Error("the job did not end");
  };
  const cancelAfter = (count) => { let asked = 0; return async () => { asked += 1; return asked > count; }; };
  return { state, judgments, documents, targets, step, toEnd, store, cancelAfter, cancel: () => { canceled = true; }, scenario };
}

const answered = (labels) => (user) => JSON.stringify(Object.fromEntries([...user.matchAll(/^(\d+)\. (Age|Lung|Heart|Pregnancy)/gmu)].map((hit) => [hit[1], ["r", [0], labels(hit[2])]])));
const open = answered((clause) => (clause === "Pregnancy" ? "not excluded" : "not enough information"));
const clauseRows = (f) => [...f.judgments.rows.values()].filter((row) => row.mode === "criteria").map((row) => ({ target: row.targetId, fit: row.fit, verdict: row.verdict, thinking: row.thinking }));
const clauseEvery = (rows, wanted) => rows.every((row) => Object.entries(wanted).every(([key, value]) => row[key] === value));

test("stage two's rows keep their pair's score after a batch ended, whichever setting each stage ran under", async () => {
  const f = setup({ fitScore: () => 40, clauseAnswer: open, config: { vcrMatchJudgeSlicePairs: 1 } });
  await f.toEnd();
  const rows = clauseRows(f);
  assert.equal(rows.length, 3);
  assert.ok(clauseEvery(rows, { fit: 40, verdict: "insufficient", thinking: "high" }), JSON.stringify(rows));
  const together = setup({ fitScore: () => 40, clauseAnswer: open });
  await together.toEnd();
  assert.deepEqual(clauseRows(together).map((row) => [row.fit, row.verdict]), rows.map((row) => [row.fit, row.verdict]), "the same job in one batch writes the same rows");
});

test("every clause call failing is a job that says so: not finished in its result, its notice or its read, and the read names what is left", async () => {
  const f = setup({ clauseAnswer: () => "no json here" });
  const result = await f.toEnd({ topK: 2 });
  assert.equal(result.conclusion, "limited");
  assert.deepEqual(result.measures.filter((row) => /criteria/u.test(row.name)).map((row) => row.value), [0, 2]);
  assert.match(result.diagnostics.issues[0].message, /3 对里判定完 3 对/u);
  assert.match(result.diagnostics.issues[0].message, /逐条判了 0\/2 对/u);
  assert.doesNotMatch(result.diagnostics.issues[0].message, /没判定成/u, "every pair has a verdict, from its score");
  assert.equal(vcrJobNoticeText({ resultKind: "match_judge", state: "succeeded", result })?.title, "患者与试验判定没有做完：判定了 3/3 对，逐条判了 0/2 对");
  f.judgments.jobs.push({ id: "j", state: "succeeded", scenario: f.scenario({ topK: 2 }) });
  const reads = createMatchJudgmentReads({ judgments: f.judgments, documents: f.documents, targets: f.targets, matchStore });
  const read = await reads.forSubject(STUDY, "P-1");
  assert.deepEqual([read.finished, read.total, read.state], [3, 3, "stopped"]);
  assert.deepEqual(read.clauses, { wanted: 2, done: 0, left: 2 });
  assert.equal(read.clausesFailed.length, 2);
  assert.equal(read.job.id, "j");
  assert.equal(read.job.state, "succeeded");
  const flagged = read.ranking.filter((row) => row.clausesFailed);
  assert.equal(flagged.length, 2);
  assert.match(flagged[0].clausesFailed.reason, /./u);
});

test("a job stopped before stage two began says that stage has not run, and one stopped as it began says none was done", async () => {
  const g = setup({ clauseAnswer: open });
  // Cancelled in stage one: the walk asks before each pair.
  const stopped = await g.step({ topK: 2 }, { isCanceled: g.cancelAfter(2), yieldable: false });
  assert.equal(stopped.conclusion, "limited");
  assert.equal(stopped.diagnostics.clausesNotReached, true);
  assert.match(stopped.diagnostics.issues[0].message, /逐条判定没有开始/u);
  assert.equal(vcrJobNoticeText({ resultKind: "match_judge", state: "succeeded", result: stopped })?.title, "患者与试验判定没有做完：判定了 2/3 对，逐条判定没有开始");
  g.judgments.jobs.push({ id: "j", state: "canceled", scenario: g.scenario({ topK: 2 }) });
  const read = await createMatchJudgmentReads({ judgments: g.judgments, documents: g.documents, targets: g.targets, matchStore }).forSubject(STUDY, "P-1");
  assert.equal(read.state, "stopped");
  assert.deepEqual(read.clauses, { wanted: 2, done: 0, left: 2 });
  // Every score in hand, and cancelled before the first clause.
  const h = setup({ clauseAnswer: open });
  const between = await h.step({ topK: 2 }, { isCanceled: h.cancelAfter(3), yieldable: false });
  assert.equal(between.conclusion, "limited");
  assert.equal(vcrJobNoticeText({ resultKind: "match_judge", state: "succeeded", result: between })?.title, "患者与试验判定没有做完：判定了 3/3 对，逐条判了 0/2 对");
  h.judgments.jobs.push({ id: "j", state: "canceled", scenario: h.scenario({ topK: 2 }) });
  const after = await createMatchJudgmentReads({ judgments: h.judgments, documents: h.documents, targets: h.targets, matchStore }).forSubject(STUDY, "P-1");
  assert.deepEqual([after.finished, after.total, after.state, after.left], [3, 3, "stopped", 2], "what a continuation would start");
});

test("while a job is out its read says so, with how far it is; a whole job reads done", async () => {
  const f = setup({ clauseAnswer: open });
  await f.toEnd({ topK: 1 });
  f.judgments.jobs.push({ id: "j", state: "running", scenario: f.scenario({ topK: 1, trials: [...Object.keys(TRIALS), "NCT00000009"].map((registryId) => ({ registry: "clinicaltrials.gov", registryId })) }) });
  const reads = createMatchJudgmentReads({ judgments: f.judgments, documents: f.documents, targets: f.targets, matchStore });
  const running = await reads.forSubject(STUDY, "P-1");
  assert.deepEqual([running.finished, running.total, running.state, running.left], [3, 4, "running", 1]);
  f.judgments.jobs[0] = { id: "j", state: "succeeded", scenario: f.scenario({ topK: 1 }) };
  const whole = await reads.forSubject(STUDY, "P-1");
  assert.deepEqual([whole.finished, whole.total, whole.state, whole.left], [3, 3, "done", 0]);
  assert.deepEqual(whole.clauses, { wanted: 1, done: 1, left: 0 });
});

test("a later note with K below the trials: an old clause row counts for nothing beside a score of the new words, and is said to be older", async () => {
  const f = setup({ fitScore: (trial, state) => (state.text.includes("脑转移") ? { T1: 5, T2: 90, T3: 60 }[trial] : { T1: 90, T2: 60, T3: 30 }[trial]),
    clauseAnswer: answered((clause) => (clause === "Pregnancy" ? "not excluded" : "included")) });
  await f.toEnd({ topK: 1 });
  f.state.text = "男性，70岁。肺癌。新发脑转移。";
  await f.toEnd({ topK: 1, chain: "c2", followUp: { reason: "follow_up" } });
  const all = await f.judgments.list({ subjectKey: "P-1" });
  const newestOf = (target, mode) => all.find((row) => row.targetId === target && row.mode === mode) ?? null;
  const first = presentJudgment(newestOf("NCT00000001", "fit"), newestOf("NCT00000001", "criteria"));
  assert.equal(first.fit, 5);
  assert.equal(first.verdict, "ineligible", "the new note's score, not the old clauses");
  assert.deepEqual(first.criteria, [], "the old clause rows are not this verdict's");
  assert.equal(first.clausesOutdated, true);
  const best = presentJudgment(newestOf("NCT00000002", "fit"), newestOf("NCT00000002", "criteria"));
  assert.equal(best.criteria.length, 2, "the new best has clauses of the new words");
  assert.equal(best.clausesOutdated, undefined);
  // The sentence that says what changed agrees with the page.
  const changes = judgmentChanges(all);
  const moved = changes.pairs.find((pair) => pair.targetId === "NCT00000001");
  assert.ok(moved);
  assert.equal(moved.to, first.verdictLabel);
  // The read ranks and draws by the same rule.
  f.judgments.jobs.push({ id: "j2", state: "succeeded", scenario: f.scenario({ topK: 1 }) });
  const read = await createMatchJudgmentReads({ judgments: f.judgments, documents: f.documents, targets: f.targets, matchStore }).forSubject(STUDY, "P-1");
  const row = read.ranking.find((entry) => entry.target.id === "NCT00000001");
  assert.equal(row.verdict, "ineligible");
  assert.equal(read.state, "done", "the clause row that is older is not wanted once its trial left the top K");
});

test("clauses judged of newer words leave an older score out of their verdict", () => {
  const fit = { id: "a", status: "done", mode: "fit", subjectKey: "P-1", targetKind: "candidate_trial", targetId: "T", documentHash: "old", targetHash: "t", fit: 90, confidence: 0.9, updatedAt: "2026-11-04T00:00:01Z", answer: { reasons: { eligible: ["e"], ineligible: [], missing: [], rationale: "" } } };
  const criteria = { id: "b", status: "done", mode: "criteria", subjectKey: "P-1", targetKind: "candidate_trial", targetId: "T", documentHash: "new", targetHash: "t", fit: null, confidence: null, updatedAt: "2026-11-04T00:00:02Z", answer: { rows: [{ number: 1, kind: "inclusion", label: "included", basis: "stated" }], missing: [] } };
  const row = presentJudgment(fit, criteria);
  assert.equal(row.fit, null);
  assert.equal(row.verdict, "eligible");
  assert.equal(row.scoreOutdated, true);
  assert.equal(presentJudgment({ ...fit, documentHash: "new" }, criteria).fit, 90, "the same reading stands together");
});

test("a record read in part says so on the row and in the read; a stall is a failed pair, not a verdict on what was left", async () => {
  const documents = {
    async roster() { return [{ id: "d1", subjectKey: "P-1", chars: 10 }, { id: "d2", subjectKey: "P-1", chars: 10 }]; },
    async runtimeRead(_study, { documentId }) { if (documentId === "d2") throw Object.assign(new Error("no"), { code: "vcr_projection_unavailable" }); return { id: documentId, text: "男性。", subjectKey: "P-1", sourceHash: "h" }; },
    runtimeEvidence: async () => [],
  };
  const f = setup({ documents, clauseAnswer: open });
  await f.toEnd({ topK: 0 });
  const saved = [...f.judgments.rows.values()][0];
  assert.equal(saved.answer.unreadableDocuments, 1);
  const read = await createMatchJudgmentReads({ judgments: f.judgments, documents, targets: f.targets, matchStore }).forSubject(STUDY, "P-1");
  assert.match(read.ranking[0].recordGap, /1 份病历没能读取/u);
  assert.match(presentJudgment({ ...saved, answer: { ...saved.answer, leftOut: { rows: 3, earliest: null }, documentsLeftOut: 2 } }, null).recordGap, /3 行/u);
  // A database that stalls while a document is read says nothing about the record.
  await assert.rejects(() => readSubjectNote({ study: STUDY, subjectKey: "P-1", documents: { runtimeRead: async () => { throw Object.assign(new Error("slow"), { code: "57014" }); } }, roster: [{ id: "d1" }] }), { code: "57014" });
  // A failure of the table or the long tables is said, and a stall is the same as above.
  const table = { snapshotId: "s", fields: ["AGE"], subjects: [] };
  const docs = { runtimeRead: async () => ({ id: "d1", text: "男性。" }), runtimeEvidence: async () => { throw Object.assign(new Error("gone"), { code: "vcr_snapshot_unavailable" }); } };
  const note = await readSubjectNote({ study: STUDY, subjectKey: "P-1", documents: docs, roster: [{ id: "d1" }], table });
  assert.equal(note.tableUnread, true);
  const long = { linesFor: async () => { throw Object.assign(new Error("gone"), { code: "vcr_snapshot_unavailable" }); } };
  assert.equal((await readSubjectNote({ study: STUDY, subjectKey: "P-1", documents: { runtimeRead: docs.runtimeRead }, roster: [{ id: "d1" }], long })).longUnread, true);
  await assert.rejects(() => readSubjectNote({ study: STUDY, subjectKey: "P-1", documents: { runtimeRead: docs.runtimeRead, runtimeEvidence: async () => { throw Object.assign(new Error("slow"), { code: "57014" }); } }, roster: [{ id: "d1" }], table }), { code: "57014" });
  assert.match(presentJudgment({ ...saved, answer: { tableUnread: true, longUnread: true } }, null).recordGap, /表格/u);
});

test("a database that stalls at the start of a batch sends the job back to the queue, and anything else stays what it was", async () => {
  const stalled = setup({ clauseAnswer: open, documents: { async roster() { throw Object.assign(new Error("canceling statement"), { code: "57014" }); }, async runtimeRead() { return null; } } });
  await assert.rejects(() => stalled.step(), (error) => error.retryable === true && error.code === "57014");
  const broken = setup({ clauseAnswer: open, documents: { async roster() { throw Object.assign(new Error("a bug"), { code: "vcr_bug" }); }, async runtimeRead() { return null; } } });
  await assert.rejects(() => broken.step(), (error) => error.retryable !== true);
});

test("a criterion with no words is reported: the target counts it, the row carries it, and the clauses that have words are numbered without it", async () => {
  const targets = judgmentTargets({ matchStore: { async listCriteria() { return [{ id: "c1", kind: "inclusion", sourceText: "Age >= 18" }, { id: "c2", kind: "exclusion", requirement: { op: "present", variable: "pregnancy" }, sourceText: "" }]; }, async protocols() { return []; } } });
  const target = await targets.protocol({ study: STUDY, protocolVersionId: "pv" });
  assert.deepEqual(target.clauses.map((clause) => clause.text), ["Age >= 18"]);
  assert.equal(target.clausesWithoutWords, 1);
  assert.doesNotMatch(target.eligibility, /Exclusion Criteria/u, "no heading is left over a section with no words");
  assert.match(presentJudgment({ id: "a", status: "done", mode: "fit", subjectKey: "P-1", targetKind: "protocol_version", targetId: "pv", answer: { clausesWithoutWords: 1 } }, null).recordGap, /1 条条件没有原文/u);
});

test("fit off: a pair that failed is counted once, in words that add up", async () => {
  const f = setup({ clauseAnswer: (user, trial) => (trial === "T2" ? "no json here" : open(user)) });
  const result = await f.toEnd({ fit: false, topK: "all" });
  assert.equal(result.conclusion, "limited");
  assert.match(result.diagnostics.issues[0].message, /3 对里判定完 2 对，1 对没判定成/u);
});
