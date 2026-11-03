// Batch matching (remediation plan D4), on doubles: the plan and what it says, the reading of a roster record by record, resume from the
// ledger, cancel between records, a failing record, and the model call. The queue, the lane and the real ledger table are PostgreSQL's
// (vcrMatchBatch.integration.test.mjs); the real fact writer is held by the gateway's own tests.
import assert from "node:assert/strict";
import test from "node:test";
import { matchBatchUnitKey, planMatchExtraction } from "@evimed/domain";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import {
  createFactExtractor, createMatchBatch, createMatchBatchCounters, createMatchExtractExecutor, extractScenario, extractSelection, matchExtractBudget, matchExtractDigest, planBatch, recordView,
} from "../src/vcrMatchBatch.mjs";

const CRITERIA = [
  { id: "c1", kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18 years", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } },
  { id: "c2", kind: "exclusion", criterionType: "comorbidity", sourceText: "Active brain metastases", requirement: { op: "present", variable: "brain_metastasis" } },
  { id: "c3", kind: "exclusion", criterionType: "lab", sourceText: "Creatinine above 2 mg/dL", requirement: { op: "compare", variable: "creatinine", comparator: "gt", value: 2, unit: "mg/dL" } },
];
const RECORDS = {
  d1: "患者男性，63岁。头颅MRI：未见转移。肌酐 1.1 mg/dL。",
  d2: "患者女性，45岁。头颅MRI示多发脑转移灶。肌酐 1.4 mg/dL。",
  d3: "患者男性，71岁。既往体健。",
  d4: "患者女性，58岁。肌酐 2.6 mg/dL。",
};
const ROSTER = [
  { id: "d1", subjectKey: "P-001", chars: RECORDS.d1.length }, { id: "d2", subjectKey: "P-002", chars: RECORDS.d2.length },
  { id: "d3", subjectKey: "P-003", chars: RECORDS.d3.length }, { id: "d4", subjectKey: "P-004", chars: RECORDS.d4.length },
];

/** A ledger double with the real store's two methods. */
function ledger() {
  /** @type {Map<string, Set<string>>} */
  const byDigest = new Map();
  /** @type {any[]} */ const rows = [];
  return {
    rows,
    async extractionsRead(_studyId, digest) { return new Set(byDigest.get(digest) ?? []); },
    async recordExtraction(entry) {
      rows.push(entry);
      byDigest.set(entry.variablesDigest, new Set([...(byDigest.get(entry.variablesDigest) ?? []), matchBatchUnitKey(entry.subjectKey, entry.documentId)]));
    },
  };
}

function matchStoreDouble(overrides = {}) {
  return {
    async latestProtocol() { return { id: "pv_1" }; },
    async listCriteria() { return CRITERIA; },
    async withdrawnSubjects() { return new Set(); },
    ...ledger(),
    ...overrides,
  };
}

const STUDY = { id: "std_1", userId: "u1", projectId: "p1" };
const config = { vcrMatchBatchMaxSubjects: 300, vcrMatchExtractConcurrency: 1, deepseekModel: "deepseek-flash" };

function frozenReading(variables, roster = ROSTER) {
  const plan = planMatchExtraction({ roster: [...new Set(roster.map(row => row.subjectKey))].map(subjectKey => ({ subjectKey,
    documents: roster.filter(row => row.subjectKey === subjectKey).map(row => ({ id: row.id, chars: row.chars })) })),
    limit: 5000, reading: matchExtractBudget(CRITERIA, variables) });
  return { questionsDigest: matchExtractDigest(variables, CRITERIA, 'pv_1'), estimate: plan.estimate, model: 'deepseek-flash' };
}

test("D4: the selection takes a protocol, subjects, an instant and the prefilter, and nothing else", () => {
  assert.deepEqual(extractSelection({ protocolVersionId: "pv_1", subjectKeys: ["P-001", "P-001"], asOf: "2026-11-01", prefilter: false }),
    { protocolVersionId: "pv_1", subjectKeys: ["P-001"], asOf: "2026-11-01", prefilter: false });
  assert.deepEqual(extractSelection(undefined), {});
  for (const bad of [{ snapshotId: "x" }, { subjectKeys: [] }, { prefilter: "no" }, { asOf: "tomorrow" }, { protocolVersionId: "a b" }]) {
    assert.throws(() => extractSelection(bad), { code: "vcr_matching_selection_invalid" }, JSON.stringify(bad));
  }
});

test("D4: a short record is shown whole and a long one through the passages that carry the criteria's words", () => {
  assert.deepEqual(recordView("短病历", CRITERIA, 100), { text: "短病历", whole: true, shown: 3 });
  const filler = "患者今日一般情况可，无特殊不适，继续观察。".repeat(300);
  const long = `${filler}\n既往有活动性 brain metastases，已行放疗。\n${filler}`;
  const view = recordView(long, CRITERIA, 2000);
  assert.equal(view.whole, false);
  assert.ok(view.text.length <= 2000);
  assert.match(view.text, /brain metastases/);
  // nothing found: the head of the record, said as not whole
  const none = recordView("x".repeat(500), CRITERIA, 100);
  assert.deepEqual([none.whole, none.shown, none.text.length], [false, 100, 100]);
});

test("D4: the plan leaves unread the people the table decides against and the variables the table answers, and states the cost", async () => {
  const subjectTable = { async read() {
    return { available: true, snapshotId: "snap_1", header: ["USUBJID", "age"], rows: [["P-001", "63"], ["P-002", "45"], ["P-003", "17"], ["P-004", "58"]],
      columns: [{ name: "age", type: "integer", unit: "year" }] };
  } };
  const built = await planBatch({ study: STUDY, matchStore: matchStoreDouble(), documents: { roster: async () => ROSTER }, subjectTable, config });
  assert.equal(built.ok, true);
  assert.deepEqual(built.variables, ["brain_metastasis", "creatinine"], "the age column answers age: the record is asked about the rest");
  assert.deepEqual(built.plan.prefiltered, ["P-003"], "a 17-year-old is ineligible from the table alone: the record is not read");
  assert.deepEqual(built.plan.toRead.map((entry) => entry.subjectKey), ["P-001", "P-002", "P-004"]);
  assert.deepEqual(built.plan.answeredByTable, ["age"]);
  // Three to read and one decided against are head counts under the floor: the sentence a model reads does not print them.
  assert.match(built.statement, /这一批要读的病历（人数不显示）/);
  assert.doesNotMatch(built.statement, /\d+ 位|\d+ 份|已确定不符合/);
  assert.match(built.statement, /人数少的类别按小样本规则不显示具体人数/);
  assert.match(built.statement, /表格里已有的变量不再问病历：age/);
  // switched off, the prefilter reads everyone with a record
  const all = await planBatch({ study: STUDY, selection: { prefilter: false }, matchStore: matchStoreDouble(), documents: { roster: async () => ROSTER }, subjectTable, config });
  assert.equal(all.ok && all.plan.toRead.length, 4);
});

test("D4: with no table the people are all read, a record read before is not, and the size is bounded by the configured key", async () => {
  const store = matchStoreDouble();
  const first = await planBatch({ study: STUDY, matchStore: store, documents: { roster: async () => ROSTER }, config: { ...config, vcrMatchBatchMaxSubjects: 3 } });
  assert.equal(first.ok && first.plan.toRead.length, 3);
  assert.deepEqual(first.ok && first.plan.bounded, { limit: 3, deferred: 1 });
  assert.ok(first.ok && first.variables.includes("age"));
  await store.recordExtraction({ studyId: STUDY.id, subjectKey: "P-001", documentId: "d1", variablesDigest: matchExtractDigest(first.ok ? first.variables : [], CRITERIA, 'pv_1') });
  const second = await planBatch({ study: STUDY, matchStore: store, documents: { roster: async () => ROSTER }, config: { ...config, vcrMatchBatchMaxSubjects: 3 } });
  assert.deepEqual(second.ok && second.plan.alreadyRead, ["P-001"]);
  assert.deepEqual(second.ok && second.plan.toRead.map((entry) => entry.subjectKey), ["P-002", "P-003", "P-004"], "the next start takes the people the bound left out");
  // a withdrawn person has no record in the plan
  const withdrawn = await planBatch({ study: STUDY, matchStore: matchStoreDouble({ async withdrawnSubjects() { return new Set(["P-002"]); } }), documents: { roster: async () => ROSTER }, config });
  assert.equal(withdrawn.ok && withdrawn.plan.toRead.some((entry) => entry.subjectKey === "P-002"), false);
  // no criteria: a named refusal, not an empty plan
  const none = await planBatch({ study: STUDY, matchStore: matchStoreDouble({ async listCriteria() { return []; } }), documents: { roster: async () => ROSTER }, config });
  assert.deepEqual([none.ok, !none.ok && /入排条件/.test(none.message)], [false, true]);
});

/** A model double: reads the record out of the prompt and proposes the facts a careful reader would, one of them with a quote the record does not hold. */
function extractorDouble({ failOn = new Set(), calls = [] } = {}) {
  return {
    model: "deepseek-flash",
    calls,
    async extract({ text, variables }) {
      calls.push(text);
      if ([...failOn].some((needle) => text.includes(needle))) throw Object.assign(new Error("provider down"), { code: "vcr_extract_timeout" });
      const facts = [];
      const age = /(\d+)岁/.exec(text);
      if (age && variables.includes("age")) facts.push({ variable: "age", value: Number(age[1]), unit: "year", surface: `${age[1]}岁`, quote: age[0] });
      const cr = /肌酐 ([\d.]+) mg\/dL/.exec(text);
      if (cr) facts.push({ variable: "creatinine", value: Number(cr[1]), unit: "mg/dL", surface: cr[1], quote: cr[0] });
      if (/多发脑转移/.test(text)) facts.push({ variable: "brain_metastasis", polarity: "affirmed", surface: "脑转移", quote: "头颅MRI示多发脑转移灶" });
      // a quotation that is not in the record is proposed too
      if (text.includes("既往体健")) facts.push({ variable: "brain_metastasis", polarity: "negated", surface: "转移", quote: "否认脑转移" });
      return { answer: { facts }, inputTokens: 100, outputTokens: 20 };
    },
  };
}

function executorFixture({ extractor = extractorDouble(), store = matchStoreDouble(), withdrawn = new Set(), writeIssues = 0, concurrency = 1 } = {}) {
  /** @type {any[]} */ const written = [];
  /** @type {any[]} */ const reads = [];
  /** @type {string[]} */ const reported = [];
  const counters = createMatchBatchCounters();
  const documents = {
    async roster() { return ROSTER; },
    async runtimeRead(study, { subjectKey, documentId }) { reads.push({ subjectKey, documentId, cloudContext: study.cloudContext }); return { id: documentId, text: RECORDS[documentId], subjectKey, sourceHash: `h_${documentId}` }; },
  };
  const matchStore = { ...store, async withdrawnSubjects() { return withdrawn; } };
  const run = createMatchExtractExecutor({
    store: { async studyById() { return STUDY; }, async one() { return { checkpoint: {} }; } },
    matchStore, documents, extractor, config: { vcrMatchExtractConcurrency: concurrency }, report: (code) => reported.push(code), counters,
    async writeFacts({ items }) {
      written.push(...items);
      return { ids: items.slice(0, Math.max(0, items.length - writeIssues)).map((_, index) => `fact_${written.length}_${index}`), issues: Array.from({ length: Math.min(writeIssues, items.length) }, () => ({ code: "vcr_evidence_unverified" })) };
    },
  });
  const scenario = { protocolVersionId: "pv_1", asOf: "2026-11-01T00:00:00.000Z", subjects: ["P-001", "P-002", "P-003", "P-004"], variables: ["age", "brain_metastasis", "creatinine"],
    ...frozenReading(["age", "brain_metastasis", "creatinine"]), chain: "chain1", prefilter: true };
  const job = (extra = {}) => ({ job: { id: "job_1", jobId: "job_1", studyId: STUDY.id, scenario, scenarioHash: "a".repeat(64), seed: 7, ...extra }, async onProgress() {}, isCanceled: async () => false });
  return { run, job, written, reads, reported, counters, store, scenario, extractor };
}

test("D4: every record is read once for the criteria's variables, its facts go to the writer with positions, and the ledger remembers it", async () => {
  const f = executorFixture();
  /** @type {any[]} */ const progress = [];
  const result = await f.run({ ...f.job(), onProgress: async (p) => progress.push(p) });
  assert.equal(result.status, "succeeded");
  assert.equal(result.method, "matching.extract");
  assert.deepEqual(result.measures.map((m) => [m.name, m.value]), [["records_read", 4], ["facts_kept", 8], ["facts_refused", 1], ["records_failed", 0], ["records_already_read", 0]]);
  assert.equal(result.diagnostics.used.inputTokens, 400);
  assert.equal(result.diagnostics.used.outputTokens, 80);
  assert.equal(result.diagnostics.remaining, 0);
  assert.deepEqual(progress.at(-1), { done: 4, total: 4 });
  assert.equal(f.store.rows.length, 4);
  assert.ok(f.store.rows.every((row) => row.variablesDigest === matchExtractDigest(f.scenario.variables, CRITERIA, 'pv_1') && row.jobId === "job_1"));
  // each fact carries the record's own positions (the writer verifies them against the bytes)
  const age = f.written.find((fact) => fact.documentId === "d1" && fact.variable === "age");
  assert.equal(RECORDS.d1.slice(age.start, age.end), "63岁");
  // the quotation the record does not hold never reached the writer; it is counted as refused
  assert.equal(f.written.some((fact) => fact.quote === "否认脑转移"), false);
  assert.equal(f.counters.recordsRead, 4);
  // the records were read for the cloud under a context of the job's own when no conversation asked
  assert.deepEqual(f.reads[0].cloudContext, { runId: "job_1", sessionId: "vcr-job:job_1" });
});

test("D4: a repeated start reads nothing again; the result says so", async () => {
  const f = executorFixture();
  await f.run(f.job());
  const calls = f.extractor.calls.length;
  const again = await f.run(f.job({ jobId: "job_2" }));
  assert.equal(f.extractor.calls.length, calls, "the model was not called for a record already read");
  assert.deepEqual(again.measures.map((m) => [m.name, m.value]).filter(([name]) => ["records_read", "records_already_read"].includes(name)), [["records_read", 0], ["records_already_read", 4]]);
  // a changed set of questions is a different reading: the records are read again for it
  const changed = executorFixture({ store: f.store });
  const other = await changed.run({ ...changed.job(), job: { ...changed.job().job, scenario: { ...changed.scenario, variables: ["age", "creatinine"], ...frozenReading(["age", "creatinine"]) } } });
  assert.equal(other.measures[0].value, 4);
});

test("D4: a cancel stops before the next record, keeps every record read, and a new start reads only the rest", async () => {
  const f = executorFixture();
  let asked = 0;
  const result = await f.run({ ...f.job(), isCanceled: async () => (asked += 1) > 2 });
  assert.equal(result.diagnostics.canceled, true);
  assert.equal(result.diagnostics.recordsRead, 2);
  assert.equal(result.diagnostics.remaining, 2);
  assert.equal(f.store.rows.length, 2);
  assert.equal(f.counters.canceled, 1);
  const resumed = await f.run(f.job({ jobId: "job_2" }));
  assert.equal(resumed.diagnostics.recordsRead, 2, "only the two that were not read");
  assert.equal(resumed.diagnostics.recordsAlreadyRead, 2);
  assert.equal(f.store.rows.length, 4);
  assert.equal(f.extractor.calls.length, 4, "four calls in all, none twice");
});

test("D4: a record that fails is counted and read again next time; the others go on, and a spent budget stops the rest", async () => {
  const flaky = executorFixture({ extractor: extractorDouble({ failOn: new Set(["女性，45岁"]) }) });
  const result = await flaky.run(flaky.job());
  assert.equal(result.diagnostics.recordsRead, 3);
  assert.equal(result.diagnostics.recordsFailed, 1);
  assert.deepEqual(result.diagnostics.failures, { vcr_extract_timeout: 1 });
  assert.deepEqual(flaky.reported, ["vcr_extract_timeout"]);
  assert.equal(flaky.store.rows.some((row) => row.subjectKey === "P-002"), false, "a failed record has no ledger row");
  const retried = executorFixture({ store: flaky.store });
  const second = await retried.run(retried.job());
  assert.equal(second.diagnostics.recordsRead, 1, "only the failed one is read on the next start");

  const spent = { model: "deepseek-flash", calls: /** @type {string[]} */ ([]), async extract() { this.calls.push("x"); throw Object.assign(new Error("budget"), { code: "usage_budget_exceeded" }); } };
  const broke = executorFixture({ extractor: spent });
  const stopped = await broke.run(broke.job());
  assert.equal(spent.calls.length, 1, "one refusal ends the batch: no hundred more tries");
  assert.equal(stopped.diagnostics.canceled, true);
  assert.equal(stopped.diagnostics.remaining, 3);
});

test("D4: a withdrawn person is not read, and what the writer refuses is counted without stopping the record", async () => {
  const withdrawn = executorFixture({ withdrawn: new Set(["P-003"]) });
  const result = await withdrawn.run(withdrawn.job());
  assert.equal(result.diagnostics.recordsRead, 3);
  assert.equal(withdrawn.reads.some((read) => read.subjectKey === "P-003"), false);
  const refused = executorFixture({ writeIssues: 1 });
  const out = await refused.run(refused.job());
  assert.equal(out.diagnostics.recordsRead, 4);
  assert.ok(out.diagnostics.factsRefused > 1);
  assert.equal(refused.store.rows.length, 4, "a record whose fact was refused is still read");
});

test("D4: the conversation that asked is the context the reading is filed under", async () => {
  const f = executorFixture();
  const store = { async studyById() { return STUDY; }, async one() { return { checkpoint: { cloudContext: { runId: "run_9", sessionId: "ses_9" } } }; } };
  const reads = [];
  const run = createMatchExtractExecutor({ store, matchStore: f.store, documents: { async roster() { return ROSTER.slice(0, 1); },
    async runtimeRead(study, input) { reads.push(study.cloudContext); return { id: input.documentId, text: RECORDS.d1, subjectKey: input.subjectKey }; } },
  extractor: extractorDouble(), writeFacts: async () => ({ ids: [], issues: [] }), config: { vcrMatchExtractConcurrency: 1 } });
  await run(f.job());
  assert.deepEqual(reads[0], { runId: "run_9", sessionId: "ses_9" });
});

test("D4: the model call is the control plane's own client, in JSON mode under purpose vcr, and says what it used", async () => {
  /** @type {any[]} */ const calls = [];
  const extractor = createFactExtractor({ config: { deepseekModel: "deepseek-flash" }, usageLedger: { ledger: true }, fetchImpl: () => {},
    async callModel(deps, call) {
      calls.push({ deps, call });
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ facts: [{ variable: "age" }] }) } }], usage: { prompt_tokens: 321, completion_tokens: 45 } };
    } });
  const out = await extractor.extract({ study: STUDY, jobId: "job_1", text: "患者63岁", criteria: CRITERIA, variables: ["age", "creatinine"] });
  assert.deepEqual(out, { answer: { facts: [{ variable: "age" }] }, inputTokens: 321, outputTokens: 45 });
  const { call, deps } = calls[0];
  assert.equal(call.purpose, "vcr");
  assert.equal(call.runId, "job_1");
  assert.equal(call.body.model, "deepseek-flash");
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  assert.deepEqual(deps.usageLedger, { ledger: true });
  const [system, user] = call.body.messages;
  assert.match(system.content, /- age：Age >= 18 years/);
  assert.match(system.content, /- creatinine：Creatinine above 2 mg\/dL/);
  assert.match(system.content, /病历没提到的是未知，不是 negated/);
  assert.equal(user.content, "病历：\n患者63岁");
  // a cut-off or unreadable answer is a named failure, never a half fact
  const cut = createFactExtractor({ config: {}, async callModel() { return { choices: [{ finish_reason: "length", message: { content: "{" } }] }; } });
  await assert.rejects(() => cut.extract({ study: STUDY, jobId: "j", text: "x", criteria: CRITERIA, variables: ["age"] }), { code: "vcr_extract_incomplete" });
  const junk = createFactExtractor({ config: {}, async callModel() { return { choices: [{ finish_reason: "stop", message: { content: "not json" } }] }; } });
  await assert.rejects(() => junk.extract({ study: STUDY, jobId: "j", text: "x", criteria: CRITERIA, variables: ["age"] }), { code: "vcr_extract_unreadable" });
});

test("D4: starting states the cost and queues the reading with the conversation's origin; nothing to read queues nothing; no criteria is refused", async () => {
  /** @type {any[]} */ const queued = [];
  const jobs = { async enqueue(input) { queued.push(input); return { job: { id: "job_77", state: "queued" }, created: true }; } };
  const counters = createMatchBatchCounters();
  const batch = createMatchBatch({ jobs, matchStore: matchStoreDouble(), documents: { roster: async () => ROSTER }, config, counters });
  const study = { ...STUDY, cloudContext: { runId: "run_1", sessionId: "ses_1" }, completionOrigin: { runId: "run_1", sessionId: "ses_1" } };
  const started = await batch.start(study, {});
  assert.deepEqual([started.kind, started.state, started.jobId], ["match_extract", "queued", "job_77"]);
  // The sentence is a model's to read: four people are not printed in it (the gateway passes the rest of the answer through the same boundary).
  assert.match(started.statement, /这一批要读的病历（人数不显示），预计最多/);
  assert.doesNotMatch(started.statement, /4 位|4 份/);
  assert.equal(started.estimate.basis, "ceiling");
  assert.deepEqual(started.plan, { toRead: 4, alreadyRead: 0, prefiltered: 0, noDocuments: 0, deferred: 0 });
  const [input] = queued;
  assert.deepEqual([input.kind, input.internal, input.cpuSecondsLimit, input.inputs], ["match_extract", true, 60, []]);
  assert.match(input.idempotencyKey, /^vcr:std_1:extract:[a-f0-9]{16}:g0$/);
  assert.deepEqual(input.detail.cloudContext, { runId: "run_1", sessionId: "ses_1" });
  assert.deepEqual(input.detail.conversationOrigin, study.completionOrigin);
  assert.deepEqual(input.scenario.subjects, ["P-001", "P-002", "P-003", "P-004"]);
  assert.equal(counters.started, 1);
  // the same selection is the same reading (what it reads, the questions, the instructions), whoever asks and whenever; another set of records is another
  const again = extractScenario(await planBatch({ study, matchStore: matchStoreDouble(), documents: { roster: async () => ROSTER }, config }));
  assert.equal(again.chain, input.scenario.chain);
  assert.match(again.chain, /^[a-f0-9]{16}$/);
  const fewer = extractScenario(await planBatch({ study, selection: { subjectKeys: ["P-001", "P-002"] }, matchStore: matchStoreDouble(), documents: { roster: async () => ROSTER }, config }));
  assert.notEqual(fewer.chain, input.scenario.chain);
  // a start while that reading is out is that reading: no second job, no second continuation
  /** @type {any[]} */ const others = [];
  const open = createMatchBatch({ jobs: { async enqueue(input) { others.push(input); return { job: { id: "job_78", state: "queued" }, created: true }; },
    store: { async rows() { return [{ id: "job_77", state: "running" }]; } } }, matchStore: matchStoreDouble(), documents: { roster: async () => ROSTER }, config });
  const repeated = await open.start(study, {});
  assert.deepEqual([repeated.jobId, repeated.state, repeated.alreadyRunning], ["job_77", "running", true]);
  assert.equal(others.length, 0, "nothing was queued");
  // one that has ended is an attempt that can be made again, under a key of its own
  const ended = createMatchBatch({ jobs: { async enqueue(input) { others.push(input); return { job: { id: "job_79", state: "queued" }, created: true }; },
    store: { async rows() { return [{ id: "job_77", state: "failed" }, { id: "job_78", state: "canceled" }]; } } }, matchStore: matchStoreDouble(), documents: { roster: async () => ROSTER }, config });
  const retried = await ended.start(study, {});
  assert.deepEqual([retried.jobId, retried.alreadyRunning], ["job_79", undefined]);
  assert.match(others.at(-1).idempotencyKey, /:g2$/);

  // everything already read: nothing is queued and the answer says what to do instead
  const done = matchStoreDouble({ async extractionsRead() { return new Set(ROSTER.map((r) => matchBatchUnitKey(r.subjectKey, r.id))); } });
  const nothing = await createMatchBatch({ jobs, matchStore: done, documents: { roster: async () => ROSTER }, config }).start(study, {});
  assert.deepEqual([nothing.state, nothing.jobId, queued.length], ["nothing_to_read", null, 1]);
  assert.match(nothing.statement, /没有要读的病历/);
  await assert.rejects(() => createMatchBatch({ jobs, matchStore: matchStoreDouble({ async listCriteria() { return []; } }), documents: { roster: async () => ROSTER }, config }).start(study, {}),
    { code: "vcr_criteria_missing" });
});

test("D4: what the reading proposes goes through the ordinary fact writer: positions and quotations are checked against the record's own bytes", async () => {
  /** @type {any[]} */ const saved = [];
  const store = ledger();
  const matchStore = { ...matchStoreDouble(), ...store,
    async saveFact({ fact }) { saved.push(fact); return { id: `fact_${saved.length}` }; },
    async listFacts() { return []; }, async matchingFactsByIds() { return []; } };
  const documents = {
    async roster() { return ROSTER; },
    async runtimeRead(_study, { subjectKey, documentId }) { return { id: documentId, text: RECORDS[documentId], subjectKey, visibleAt: "2026-10-01T00:00:00.000Z", sourceHash: `h_${documentId}` }; },
  };
  // a model that proposes one fact the record supports and one whose number is not printed in the quotation it cites
  const extractor = { model: "deepseek-flash", async extract({ text }) {
    return { answer: { facts: [
      { variable: "creatinine", value: 1.1, unit: "mg/dL", surface: "1.1", quote: "肌酐 1.1 mg/dL" },
      { variable: "age", value: 99, unit: "year", surface: "63岁", quote: "63岁" },
    ].filter(() => text.includes("63岁")) }, inputTokens: 10, outputTokens: 5 };
  } };
  const reported = [];
  const run = createMatchExtractExecutor({
    store: { async studyById() { return STUDY; }, async one() { return { checkpoint: {} }; } }, matchStore, documents, extractor, config: { vcrMatchExtractConcurrency: 1 }, report: (c) => reported.push(c),
    writeFacts: ({ study, items, documents: held, caller }) => vcrRuntimeWrite({ store: {}, service: null, orchestrator: null, study, what: "fact", items, data: null, matchStore, documents: held, report: () => {}, caller }),
  });
  const scenario = { protocolVersionId: "pv_1", asOf: "2026-11-01T00:00:00.000Z", subjects: ["P-001"], variables: ["age", "creatinine"], ...frozenReading(["age", "creatinine"]), chain: "c" };
  const result = await run({ job: { id: "job_w", jobId: "job_w", studyId: STUDY.id, scenario, scenarioHash: "b".repeat(64), seed: 1 }, async onProgress() {}, isCanceled: async () => false });
  assert.equal(result.diagnostics.recordsRead, 1);
  assert.equal(saved.length, 1, "the fact the record supports is saved; the one whose number is not in its quotation is refused by the writer");
  assert.deepEqual([saved[0].variable, saved[0].value, saved[0].unit, saved[0].polarity, saved[0].extractedBy], ["creatinine", 1.1, "mg/dL", "affirmed", "model"]);
  assert.equal(RECORDS.d1.slice(saved[0].source.start, saved[0].source.end), "肌酐 1.1 mg/dL");
  assert.equal(saved[0].provenance.status, "batch_extraction");
  assert.equal(saved[0].visibleAt, "2026-10-01T00:00:00.000Z", "no earlier than the record entered the platform");
  assert.equal(result.diagnostics.factsKept, 1);
  assert.equal(result.diagnostics.factsRefused, 1);
  assert.equal(store.rows.length, 1, "the record is read even though one of its facts was refused");
});

test("D4 / V2: a date the record does not show costs the batch reading the date and not the fact; the fact takes the date of its record's header", async () => {
  const records = { d1: "记录日期：2100-03-01\n患者每日口服多种维生素。肌酐 1.1 mg/dL。" };
  /** @type {any[]} */
  const saved = [];
  const matchStore = matchStoreDouble({
    async matchingFactsByIds() { return []; },
    async saveFact({ fact }) { saved.push(fact); return { id: `fact_${saved.length}` }; },
  });
  const documents = {
    async roster() { return [{ id: "d1", subjectKey: "P-001", chars: records.d1.length }]; },
    async runtimeRead(_study, { subjectKey, documentId }) { return { id: documentId, text: records[documentId], subjectKey, visibleAt: "2100-03-02T00:00:00.000Z" }; },
  };
  const extractor = { model: "deepseek-flash", async extract() {
    return { answer: { facts: [
      // the date is printed by the second quotation: kept with its date
      { variable: "supplement", surface: "多种维生素", quote: "患者每日口服多种维生素。", occurredAt: "2100-03-01", dateSurface: "2100-03-01", dateQuote: "记录日期：2100-03-01" },
      // the second quotation is not in the record, and the quotation prints no date: kept, at the date of the record's header (2026-11-02 ruling)
      { variable: "creatinine", value: 1.1, unit: "mg/dL", surface: "1.1", quote: "肌酐 1.1 mg/dL", occurredAt: "2100-03-05", dateQuote: "记录日期：2100-03-05" },
    ] }, inputTokens: 10, outputTokens: 5 };
  } };
  const run = createMatchExtractExecutor({
    store: { async studyById() { return STUDY; }, async one() { return { checkpoint: {} }; } }, matchStore, documents, extractor, config: { vcrMatchExtractConcurrency: 1 },
    writeFacts: ({ study, items, documents: held, caller }) => vcrRuntimeWrite({ store: {}, service: null, orchestrator: null, study, what: "fact", items, data: null, matchStore, documents: held, report: () => {}, caller }),
  });
  const scenario = { protocolVersionId: "pv_1", asOf: "2100-03-05T00:00:00.000Z", subjects: ["P-001"], variables: ["supplement", "creatinine"], ...frozenReading(["supplement", "creatinine"]), chain: "c" };
  const result = await run({ job: { id: "job_d", jobId: "job_d", studyId: STUDY.id, scenario, scenarioHash: "c".repeat(64), seed: 1 }, async onProgress() {}, isCanceled: async () => false });
  assert.equal(result.diagnostics.factsKept, 2, "both facts are kept");
  assert.equal(result.diagnostics.factsRefused, 0);
  const [dated, undated] = saved;
  assert.deepEqual([dated.variable, dated.occurredAt, dated.source.dateQuote.quote], ["supplement", "2100-03-01", "记录日期：2100-03-01"]);
  assert.deepEqual([undated.variable, undated.value, undated.occurredAt, undated.source.dateQuote?.quote, undated.source.dateBasis], ["creatinine", 1.1, "2100-03-01", "记录日期：2100-03-01", "record_header"]);
  assert.equal(dated.source.dateBasis, undefined, "a date the fact's own quotations print is not said to come from a header");
});

test("D4 / 2026-11-02: a past event the model marks as historical takes the record header's date as the latest it could be, through the ordinary fact writer", async () => {
  const records = { d1: "Record date: 2100-03-01\n\nHistory of myocardial infarction.\nTakes aspirin daily.\nNo stroke." };
  /** @type {any[]} */
  const saved = [];
  const matchStore = matchStoreDouble({
    async matchingFactsByIds() { return []; },
    async saveFact({ fact }) { saved.push(fact); return { id: `fact_${saved.length}` }; },
  });
  const documents = {
    async roster() { return [{ id: "d1", subjectKey: "P-001", chars: records.d1.length }]; },
    async runtimeRead(_study, { subjectKey, documentId }) { return { id: documentId, text: records[documentId], subjectKey, visibleAt: "2100-03-02T00:00:00.000Z" }; },
  };
  const extractor = { model: "deepseek-flash", async extract() {
    return { answer: { facts: [
      { variable: "myocardial_infarction", surface: "myocardial infarction", quote: "History of myocardial infarction.", temporality: "historical" },
      { variable: "aspirin", surface: "aspirin", quote: "Takes aspirin daily." },
      // a negated finding is not an event that happened: the word is not carried
      { variable: "stroke", polarity: "negated", surface: "stroke", quote: "No stroke.", temporality: "historical" },
    ] }, inputTokens: 10, outputTokens: 5 };
  } };
  const run = createMatchExtractExecutor({
    store: { async studyById() { return STUDY; }, async one() { return { checkpoint: {} }; } }, matchStore, documents, extractor, config: { vcrMatchExtractConcurrency: 1 },
    writeFacts: ({ study, items, documents: held, caller }) => vcrRuntimeWrite({ store: {}, service: null, orchestrator: null, study, what: "fact", items, data: null, matchStore, documents: held, report: () => {}, caller }),
  });
  const scenario = { protocolVersionId: "pv_1", asOf: "2100-03-05T00:00:00.000Z", subjects: ["P-001"], variables: ["myocardial_infarction", "aspirin", "stroke"], ...frozenReading(["myocardial_infarction", "aspirin", "stroke"], [{ id: "d1", subjectKey: "P-001", chars: records.d1.length }]), chain: "c" };
  const result = await run({ job: { id: "job_h", jobId: "job_h", studyId: STUDY.id, scenario, scenarioHash: "d".repeat(64), seed: 1 }, async onProgress() {}, isCanceled: async () => false });
  assert.equal(result.diagnostics.factsKept, 3);
  const [past, current, denied] = saved;
  assert.deepEqual([past.occurredAt, past.source.dateBasis, past.source.dateBound, past.clinical.temporality, past.polarity], ["2100-03-01", "record_header", "no_later_than", "historical", "affirmed"]);
  assert.deepEqual([current.occurredAt, current.source.dateBasis, current.source.dateBound, current.clinical ?? null], ["2100-03-01", "record_header", undefined, null]);
  assert.deepEqual([denied.polarity, denied.source.dateBound, denied.clinical ?? null], ["negated", undefined, null]);
});
