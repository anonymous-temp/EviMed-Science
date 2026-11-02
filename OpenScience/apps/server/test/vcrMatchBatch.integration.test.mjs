// Batch matching on the real queue and the real ledger table (remediation plan D4): the job is internal to the platform, validated
// against its frozen shape, claimed by the slow lane and by no other, resumed from the ledger, and stopped by a cancel with what was
// read kept. PostgreSQL; the records, the model and the fact writer are doubles.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { VCR_TABLES } from "../src/vcrPersistence.mjs";
import { createMatchBatch, createMatchBatchCounters, createMatchExtractExecutor, matchExtractDigest } from "../src/vcrMatchBatch.mjs";
import { createVcrWorkerLoops } from "../src/vcrWorker.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, studies, matchStore;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrbatch");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  studies = new VcrStore({ database }); matchStore = new VcrMatchStore({ database });
});
after(async () => { await database?.close(); await isolated?.drop(); });

const CRITERIA = [
  { id: "c1", kind: "inclusion", criterionType: "lab", sourceText: "Creatinine <= 2", requirement: { op: "compare", variable: "creatinine", comparator: "lte", value: 2, unit: "mg/dL" } },
];
const TEXT = { d1: "肌酐 1.1 mg/dL。", d2: "肌酐 1.4 mg/dL。", d3: "肌酐 1.8 mg/dL。" };
const ROSTER = Object.keys(TEXT).map((id, index) => ({ id, subjectKey: `P-00${index + 1}`, chars: TEXT[id].length }));

let sequence = 0;
async function fixture(extractorOverride) {
  sequence += 1;
  const study = await studies.createStudy({ userId: `u_fix${sequence}`, projectId: `p_fix${sequence}`, name: `Batch reading ${sequence}`, question: "q", dataTier: "T0" });
  const stored = { ...study };
  const config = { vcrJobCpuSeconds: 60, vcrStudyCpuBudget: 1000, vcrMaxConcurrentJobs: 1, vcrLocalConcurrency: 2, vcrMatchBatchMaxSubjects: 300, vcrMatchExtractConcurrency: 1 };
  const records = {
    async roster() { return ROSTER; },
    async runtimeRead(_study, { subjectKey, documentId }) { return { id: documentId, text: TEXT[documentId], subjectKey }; },
  };
  const matching = {
    latestProtocol: async () => ({ id: "pv_1" }), listCriteria: async () => CRITERIA, withdrawnSubjects: async () => new Set(),
    extractionsRead: (studyId, digest) => matchStore.extractionsRead(studyId, digest),
    recordExtraction: (entry) => matchStore.recordExtraction(entry),
  };
  const counters = createMatchBatchCounters();
  const extractor = extractorOverride ?? { model: "deepseek-flash", calls: [], async extract({ text }) {
    this.calls.push(text);
    return { answer: { facts: [{ variable: "creatinine", value: Number(/([\d.]+) mg/.exec(text)[1]), unit: "mg/dL", surface: /([\d.]+)/.exec(text)[1], quote: /肌酐 [\d.]+ mg\/dL/.exec(text)[0] }] }, inputTokens: 50, outputTokens: 10 };
  } };
  /** @type {any[]} */ const written = [];
  const jobs = new VcrJobs({ store: studies, config });
  jobs.localExecutors["matching.extract"] = createMatchExtractExecutor({
    store: studies, matchStore: matching, documents: records, extractor, config, counters,
    async writeFacts({ items }) { written.push(...items); return { ids: items.map((_, index) => `fact_${written.length}_${index}`), issues: [] }; },
  });
  const batch = createMatchBatch({ jobs, matchStore: matching, documents: records, config, counters });
  return { study: stored, jobs, batch, extractor, written, counters };
}

test("the ledger table is declared with the module's tables and remembers a record once, per set of questions", options, async () => {
  assert.ok(VCR_TABLES.includes("matching_extractions"));
  const study = await studies.createStudy({ userId: "u_b", projectId: "p_b2", name: "Ledger", question: "q", dataTier: "T0" });
  const digest = matchExtractDigest(["creatinine"]);
  await matchStore.recordExtraction({ studyId: study.id, subjectKey: "P-001", documentId: "d1", variablesDigest: digest, documentHash: "h1", facts: 2, rejected: 1, inputTokens: 90, outputTokens: 20, model: "m", jobId: "job_x" });
  await matchStore.recordExtraction({ studyId: study.id, subjectKey: "P-001", documentId: "d1", variablesDigest: digest, facts: 9 });
  assert.deepEqual([...await matchStore.extractionsRead(study.id, digest)], ["P-001\u0000d1"]);
  assert.deepEqual([...await matchStore.extractionsRead(study.id, matchExtractDigest(["age"]))], [], "another set of questions is another reading");
  const row = await studies.one("SELECT facts,rejected,input_tokens FROM evimed_vcr.matching_extractions WHERE study_id=$1", [study.id]);
  assert.deepEqual([row.facts, row.rejected, row.input_tokens], [2, 1, 90], "the first reading stands: the same record read twice is one row");
});

test("a reading is queued by the platform alone, held to its frozen shape, and taken by the slow lane and no other", options, async () => {
  const f = await fixture();
  const scenario = { protocolVersionId: "pv_1", asOf: "2026-11-01T00:00:00.000Z", subjects: ["P-001"], variables: ["creatinine"], estimate: { people: 1 }, chain: "c1" };
  // a caller outside the platform cannot queue one, and a scenario of another shape is refused by name
  await assert.rejects(() => f.jobs.enqueue({ studyId: f.study.id, userId: f.study.userId, kind: "match_extract", scenario, cpuSecondsLimit: 60 }), { code: "vcr_job_scenario_invalid" });
  await assert.rejects(() => f.jobs.enqueue({ studyId: f.study.id, userId: f.study.userId, kind: "match_extract", scenario: { ...scenario, text: "a record" }, internal: true, cpuSecondsLimit: 60 }), { code: "vcr_job_scenario_invalid" });

  const started = await f.batch.start(f.study, {});
  assert.equal(started.state, "queued");
  const row = await studies.one("SELECT method,method_version,state,cpu_seconds_limit,max_attempts,checkpoint FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.deepEqual([row.method, row.method_version, row.state, Number(row.cpu_seconds_limit), row.max_attempts], ["matching.extract", "1.0.0", "queued", 60, 3]);
  assert.equal(row.checkpoint.protocolVersionId, "pv_1");

  assert.deepEqual(await f.jobs.claim({ lane: "local" }), [], "the short local lane does not take it");
  assert.deepEqual(await f.jobs.claim({ lane: "engine" }), [], "the engine lane never takes a local method");
  const claimed = await f.jobs.claim({ lane: "slow" });
  assert.deepEqual(claimed.map((job) => job.id), [started.jobId]);
});

test("a reading runs on the queue, writes the ledger, and a second start finds nothing left to read", options, async () => {
  const f = await fixture();
  const started = await f.batch.start(f.study, {});
  const [claimed] = await f.jobs.claim({ lane: "slow" });
  const done = await f.jobs.advance(claimed);
  assert.equal(done.action, "finished");
  const row = await studies.one("SELECT state FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.equal(row.state, "succeeded");
  assert.equal(f.extractor.calls.length, 3);
  assert.equal(f.written.length, 3);
  const ledger = await studies.rows("SELECT subject_key,document_id,facts,input_tokens FROM evimed_vcr.matching_extractions WHERE study_id=$1 ORDER BY subject_key", [f.study.id]);
  assert.deepEqual(ledger.map((entry) => [entry.subject_key, entry.document_id, entry.facts, entry.input_tokens]), [["P-001", "d1", 1, 50], ["P-002", "d2", 1, 50], ["P-003", "d3", 1, 50]]);

  const again = await f.batch.start(f.study, {});
  assert.deepEqual([again.state, again.jobId], ["nothing_to_read", null]);
  assert.match(again.statement, /没有要读的病历/);
});

test("a cancel stops the reading between records, keeps what was read, and the next start reads the rest and nothing twice", options, async () => {
  let calls = 0;
  const cancelling = { model: "deepseek-flash", texts: /** @type {string[]} */ ([]), async extract({ text }) {
    this.texts.push(text);
    calls += 1;
    // the person cancels while the second record is being read
    if (calls === 2) await g.jobs.cancel(g.study.id, started.jobId, { actor: g.study.userId });
    return { answer: { facts: [{ variable: "creatinine", value: 1, unit: "mg/dL", surface: "1", quote: /肌酐 [\d.]+ mg\/dL/.exec(text)[0] }] }, inputTokens: 40, outputTokens: 8 };
  } };
  const g = await fixture(cancelling);
  var started = await g.batch.start(g.study, {});
  const [claimed] = await g.jobs.claim({ lane: "slow" });
  await g.jobs.advance(claimed);
  const job = await studies.one("SELECT state FROM evimed_vcr.jobs WHERE id=$1", [started.jobId]);
  assert.equal(job.state, "canceled");
  const kept = await studies.rows("SELECT document_id FROM evimed_vcr.matching_extractions WHERE study_id=$1 ORDER BY document_id", [g.study.id]);
  assert.deepEqual(kept.map((entry) => entry.document_id), ["d1", "d2"], "the record in flight when the cancel came was finished and kept; the third was never taken");
  assert.equal(cancelling.texts.length, 2);

  const resumed = await g.batch.start(g.study, {});
  assert.equal(resumed.plan.toRead, 1);
  assert.equal(resumed.plan.alreadyRead, 2);
  const [next] = await g.jobs.claim({ lane: "slow" });
  await g.jobs.advance(next);
  assert.equal(cancelling.texts.length, 3, "three calls in all: nothing was read twice");
  const all = await studies.rows("SELECT document_id FROM evimed_vcr.matching_extractions WHERE study_id=$1 ORDER BY document_id", [g.study.id]);
  assert.deepEqual(all.map((entry) => entry.document_id), ["d1", "d2", "d3"]);
});

test("a fact written with a second quotation for its date and a unit read by convention is stored, read back and judged from the stored row", options, async () => {
  const { vcrRuntimeWrite } = await import("../src/vcrGateway.mjs");
  const { assessSubject } = await import("../src/vcrMatching.mjs");
  const study = await studies.createStudy({ userId: "u_dq", projectId: "p_dq", name: "Date quotation", question: "q", dataTier: "T0" });
  const text = "Record date: 2100-03-01\n\nHgbA1c 7.4 last month.\nTakes a multivitamin daily.\n";
  const documents = { async runtimeRead(_study, { subjectKey, documentId }) { return documentId === "d1" ? { id: "d1", text, subjectKey, visibleAt: "2100-03-02T00:00:00.000Z" } : null; } };
  const caller = { provenance: { schema: 1, status: "batch_extraction", runId: "job_dq", association: "matching.extract", skillDigest: null, requests: [] }, runtimeRunId: "job_dq" };
  const write = (items) => vcrRuntimeWrite({ store: {}, service: null, orchestrator: null, study, what: "fact", items, data: null, matchStore, documents, report: () => {}, caller });
  const head = { subjectKey: "P-001", documentId: "d1" };
  const done = await write([
    { ...head, variable: "hba1c", value: 7.4, unit: "%", surface: "7.4", quote: "HgbA1c 7.4 last month.", occurredAt: "2100-03-01", dateSurface: "2100-03-01", dateQuote: "Record date: 2100-03-01" },
    { ...head, variable: "dietary_supplement", surface: "multivitamin", quote: "Takes a multivitamin daily.", occurredAt: "2100-03-01", dateQuote: "Record date: 2100-03-01" },
    { ...head, variable: "dietary_supplement", surface: "multivitamin", quote: "Takes a multivitamin daily.", occurredAt: "2100-03-02", dateQuote: "Record date: 2100-03-01" },
  ]);
  assert.equal(done.issues.length, 0, "the date nobody printed is dropped, not the fact");
  assert.equal(done.ids.length, 3);

  const stored = await matchStore.listFacts({ studyId: study.id, subjectKey: "P-001" });
  const supplements = stored.filter((fact) => fact.variable === "dietary_supplement");
  assert.deepEqual(supplements.map((fact) => fact.occurredAt).sort((a, b) => String(a).localeCompare(String(b))), ["2100-03-01T00:00:00.000Z", null], "the second row is stored without the date nobody printed");
  assert.equal(supplements.find((fact) => fact.occurredAt === null).source.dateQuote, undefined);
  const a1c = stored.find((fact) => fact.variable === "hba1c");
  assert.deepEqual([a1c.unit, a1c.value, a1c.source.unitBasis, a1c.source.dateQuote.quote, a1c.occurredAt], ["%", 7.4, "conventional", "Record date: 2100-03-01", "2100-03-01T00:00:00.000Z"]);
  assert.equal(text.slice(a1c.source.dateQuote.start, a1c.source.dateQuote.end), "Record date: 2100-03-01", "the row holds where the date was read, in the document's own bytes");

  const criteria = [
    { id: "c1", kind: "inclusion", criterionType: "lab", sourceText: "HbA1c 6.5-9.5%", requirement: { op: "compare", variable: "hba1c", comparator: "between", value: 6.5, highValue: 9.5, unit: "%", aggregate: "any" } },
    { id: "c2", kind: "inclusion", criterionType: "concomitant_medication", sourceText: "Supplement in the past 2 months", requirement: { op: "present", variable: "dietary_supplement", window: { months: 2 } } },
  ];
  const assessment = assessSubject({ subjectKey: "P-001", criteria, facts: stored, documents: { d1: { text } }, asOf: "2100-03-05" });
  assert.deepEqual(assessment.judgments.map((judgment) => judgment.state), ["satisfied", "satisfied"], "re-read from the stored rows, the unit and the date stand");
  assert.deepEqual(assessment.voidedFacts, []);
  // Without the document the quotations cannot be re-read: the stored date does not stand on its own.
  assert.equal(assessSubject({ subjectKey: "P-001", criteria, facts: stored, documents: { d1: { text: "other" } }, asOf: "2100-03-05" }).judgments[1].state, "unknown");
});

test("P2-8 the same selection started twice while it is out is one job; after a cancel it is a new one, and the ledger keeps both honest", options, async () => {
  const g = await fixture();
  const first = await g.batch.start(g.study, {});
  const second = await g.batch.start(g.study, {});
  assert.equal(second.jobId, first.jobId, "the second start finds the reading that is out");
  assert.equal(second.alreadyRunning, true);
  assert.equal((await studies.rows("SELECT 1 FROM evimed_vcr.jobs WHERE study_id=$1 AND kind='match_extract'", [g.study.id])).length, 1, "one job, so one continuation");
  // a person's cancel ends it; the same selection asked again is a new attempt, not the old job back
  await g.jobs.cancel(g.study.id, first.jobId, { actor: "owner" });
  const third = await g.batch.start(g.study, {});
  assert.notEqual(third.jobId, first.jobId);
  assert.equal(third.alreadyRunning, undefined);
  assert.equal((await studies.rows("SELECT 1 FROM evimed_vcr.jobs WHERE study_id=$1 AND kind='match_extract'", [g.study.id])).length, 2);
  // and the reading that ran is the ledger's: it has read each record once
  const [claimed] = await g.jobs.claim({ lane: "slow" });
  await g.jobs.advance(claimed);
  assert.equal(g.extractor.calls.length, 3);
});

test("P2-9 the slow lane's tick does not wait for a batch: two accounts' batches run together, one account's second batch waits for its first, and the lane keeps ticking", options, async () => {
  /** @type {() => void} */ let open = () => {};
  const gate = new Promise((resolve) => { open = () => resolve(null); });
  const blocking = { model: "deepseek-flash", calls: /** @type {string[]} */ ([]), async extract({ text }) {
    this.calls.push(text);
    await gate;
    return { answer: { facts: [] }, inputTokens: 5, outputTokens: 1 };
  } };
  // what earlier cases left out is not this lane's to count
  await studies.query("UPDATE evimed_vcr.jobs SET state='canceled', lease_owner=NULL, lease_until=NULL, finished_at=now() WHERE kind='match_extract' AND state IN ('queued','running')");
  const x = await fixture(blocking);
  const y = await fixture(blocking);
  // the executors are the first fixture's: the roster and the records are the same doubles for both studies
  const firstX = await x.batch.start(x.study, {});
  const secondX = await x.batch.start(x.study, { subjectKeys: ["P-001", "P-002"] });
  const onlyY = await y.batch.start(y.study, {});
  assert.notEqual(firstX.jobId, secondX.jobId);
  const loops = createVcrWorkerLoops({ jobs: x.jobs, orchestrator: null, store: studies });
  const tick = /** @type {() => Promise<any>} */ (loops.slowJobs);
  const started = await tick();
  // the tick returned while the batches were still out (they wait at the gate), with one batch of each account claimed
  assert.deepEqual([started.claimed, started.inFlight], [2, 2]);
  const states = Object.fromEntries((await studies.rows("SELECT id, state FROM evimed_vcr.jobs WHERE kind='match_extract'")).map((row) => [row.id, row.state]));
  assert.equal(states[firstX.jobId], "running");
  assert.equal(states[onlyY.jobId], "running", "another account's batch did not wait behind the first account's");
  assert.equal(states[secondX.jobId], "queued", "an account's second batch waits for its first");
  const again = await tick();
  assert.deepEqual([again.claimed, again.advanced, again.inFlight], [0, 0, 2], "the lane ticks while they run, and starts nothing twice");
  open();
  for (let n = 0; n < 200 && (await studies.rows("SELECT 1 FROM evimed_vcr.jobs WHERE kind='match_extract' AND state NOT IN ('succeeded','failed','canceled')")).length > 1; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const last = await tick();
  assert.equal(last.claimed, 1, "once the first is done the account's second batch is taken");
  for (let n = 0; n < 200 && (await studies.rows("SELECT 1 FROM evimed_vcr.jobs WHERE kind='match_extract' AND state NOT IN ('succeeded','failed','canceled')")).length; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const ended = Object.fromEntries((await studies.rows("SELECT id, state FROM evimed_vcr.jobs WHERE kind='match_extract'")).map((row) => [row.id, row.state]));
  assert.deepEqual([ended[firstX.jobId], ended[secondX.jobId], ended[onlyY.jobId]], ["succeeded", "succeeded", "succeeded"]);
});
