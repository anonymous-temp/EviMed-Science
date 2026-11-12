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
import { createMatchJudgmentReads, judgeSelection, judgmentTargets, planMatchJudge, readSubjectNote } from "../src/vcrMatchJudge.mjs";
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

function fixture({ roster = ROSTER, registry = null, withdrawn = new Set(), text = TEXT, tableCells = null } = {}) {
  const judgments = judgmentsDouble();
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
  const targets = judgmentTargets({ evidence, matchStore });
  const subjectTable = tableCells ? { async read() { return { available: true, snapshotId: "snp_1", header: ["USUBJID", ...Object.keys(tableCells)], rows: [["P-1", ...Object.values(tableCells)]], columns: Object.keys(tableCells).map((name) => ({ name })) }; } } : null;
  const reads_ = createMatchJudgmentReads({ judgments, documents, subjectTable, targets, matchStore });
  const toA = { direction: "patient_to_trial", subjects: ["P-1"], trials: ["NCT00000001", "NCT00000002", "NCT00000003"].map((registryId) => ({ registry: "clinicaltrials.gov", registryId })), fit: true, topK: 2, thinking: "high", model: "deepseek-flash", promptVersions: { fit: "fit-3", criteria: "criteria-5" }, estimate: { pairs: 3 }, chain: "c1" };
  return { judgments, reported, reads, documents, matchStore, subjectTable, targets, reads_, toA };
}


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



