// What a run of thousands looks like: thousands of people imported through the job, judged by the job, in batches on the queue, surviving a worker that dies, not keeping the account's other work
// waiting, with memory that does not grow with the roster. Real PostgreSQL, the real plane and queue; the model is a double. VCR_SCALE_PEOPLE sets the size (the recorded proof is 5,000), and the
// default is small enough for an ordinary run of the suite. Times and peak memory are printed so a run can be recorded.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { mergeCriteriaAnswers, segmentCriteria, segmentSentences, splitNoteParts } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { createVcrDataIntake } from "../src/vcrDataIntake.mjs";
import { createVcrUploadReceipts } from "../src/vcrUploadReceipts.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const PEOPLE = Number(process.env.VCR_SCALE_PEOPLE ?? 300);
const MODEL_MS = Number(process.env.VCR_SCALE_MODEL_MS ?? 0);
const options = { skip: !url && "An isolated PostgreSQL is required", timeout: 3_600_000 };
let isolated, database, directory, vcr, intake, receipts, project, study;
let calls = 0, inFlight = 0, peakInFlight = 0, failing = 0;
const origin = { userId: "owner", projectId: "project", rootSessionId: "root", runId: "run", callId: "call" };

/** A reader of peak memory while something runs: the heap the process keeps and all it holds. */
function watch() {
  let heap = 0, rss = 0;
  const look = () => { const { heapUsed, rss: held } = process.memoryUsage(); heap = Math.max(heap, heapUsed); rss = Math.max(rss, held); };
  const timer = setInterval(look, 250);
  timer.unref();
  look();
  const started = Date.now();
  return () => { clearInterval(timer); look(); return { seconds: Math.round((Date.now() - started) / 100) / 10, peakHeapMb: Math.round(heap / 1048576), peakRssMb: Math.round(rss / 1048576) }; };
}

const answer = (body) => {
  const system = body.messages[0].content;
  const content = system.includes("criterion level") ? '{"1":["理由",[0],"included"]}' : system.includes("sample of what a researcher") ? JSON.stringify({ tables: [{ input: 0, role: "notes", subject: "PID", text: ["NOTE"], date: "VISIT", context: [] }], files: null })
    : '{"score":70,"confidence":0.6,"eligible_reasons":"1. a","ineligible_reasons":"","missing_information":""}';
  return new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const compose = () => composeVcr({ productDatabase: database, fetchImpl: async (address, init) => {
  calls += 1; inFlight += 1; peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    if (MODEL_MS) await new Promise((resolve) => { setTimeout(resolve, MODEL_MS); });
    if (failing > 0) { failing -= 1; return new Response("upstream", { status: 503 }); }
    return answer(JSON.parse(init.body));
  } finally { inFlight -= 1; }
}, config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: path.join(directory, "plane"), deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true,
  vcrMatchJudgeConcurrency: 8, vcrMatchJudgeSlicePairs: 200, vcrMatchJudgeTopK: 0, vcrMatchJudgeThinking: "off", vcrRecordsImportSliceEntries: 400, vcrLocalConcurrency: 2, vcrMatchJudgeMaxUpstreamFailures: 8, vcrMatchJudgeOutageWaits: 2 } });

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrscale");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',100000000000)");
  directory = await fs.mkdtemp(path.join(process.env.VCR_SCALE_TMP || os.tmpdir(), "vcr-scale-"));
  project = { userId: "owner", id: "project", baseDir: path.join(directory, "project") };
  await fs.mkdir(project.baseDir);
  vcr = compose();
  await vcr.store.ready();
  receipts = createVcrUploadReceipts({ documents: new ProductDocuments(database), sources: null, resolveProject: async () => project });
  vcr.recordsOriginals.receipts = receipts;
  intake = createVcrDataIntake({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, sources: receipts, resolveProject: async () => project, recordsImport: vcr.recordsImport });
  study = await vcr.store.createStudy({ userId: "owner", projectId: "project", name: "Scale", question: "q", dataTier: "T0" });
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

const worker = async (composed = vcr, { limit = 100_000, stopAfter = null } = {}) => {
  let turns = 0;
  for (; turns < limit; turns += 1) {
    const claimed = await composed.jobs.claim({ lane: "slow" });
    if (!claimed.length) {
      const waiting = await composed.store.one("SELECT count(*)::int AS n FROM evimed_vcr.jobs WHERE state='queued' AND study_id=$1", [study.id]);
      if (!waiting.n) return turns;
      await composed.store.query("UPDATE evimed_vcr.jobs SET run_after=now() WHERE state='queued' AND study_id=$1", [study.id]);
      continue;
    }
    for (const job of claimed) await composed.jobs.advance(job, { mayYield: true });
    if (stopAfter != null && turns + 1 >= stopAfter) return turns + 1;
  }
  assert.fail("did not finish");
};
const resultOf = (jobId) => vcr.store.one("SELECT r.conclusion, r.diagnostics FROM evimed_vcr.results r JOIN evimed_vcr.executions e ON e.id = r.execution_id WHERE e.job_id=$1 ORDER BY r.created_at DESC LIMIT 1", [jobId]);

test(`${PEOPLE} people: imported through the job, judged by the job without anyone restarting it, through a worker that dies and a provider that goes down, with bounded memory`, options, async () => {
  const rows = ["PID,VISIT,NOTE"];
  for (let person = 0; person < PEOPLE; person += 1) rows.push(`S${person},2024-01-${String((person % 28) + 1).padStart(2, "0")},"合成记录 ${person}。年龄 ${40 + (person % 40)} 岁。${"随访稳定。".repeat(40)}"`);
  const handle = await receipts.record(project, { name: "people.csv", bytes: Buffer.from(rows.join("\n")), sessionId: "root" });
  const importing = watch();
  const started = await intake(study, { action: "import_documents", ...handle }, origin);
  const importTurns = await worker();
  const importDone = importing();
  const imported = await resultOf(started.jobId);
  assert.deepEqual([imported.diagnostics.stored, imported.diagnostics.people], [PEOPLE, PEOPLE]);
  console.error(`SCALE import ${PEOPLE} people: ${JSON.stringify(importDone)} turns=${importTurns}`);

  const roster = [...new Set((await vcr.documents.roster(study)).map((row) => row.subjectKey))];
  assert.equal(roster.length, PEOPLE);
  const protocol = await vcr.matchStore.saveProtocolVersion({ studyId: study.id, userId: "owner", title: "Scale", criteria: [{ id: "c1", kind: "inclusion", label: "成年", sourceText: "Age >= 18", requirement: { op: "language", question: "Is the person an adult?" } }] });
  const judging = watch();
  // Everyone against one protocol: the pairs are the people. Stage one, on the real queue.
  const judged = await vcr.matchJudge.start(study, { direction: "trial_to_patient", protocolVersionId: protocol.id, fit: true, topK: 0, thinking: "off" });
  assert.match(judged.statement, new RegExp(`判定 ${PEOPLE} 对`));
  // The worker dies a few batches in: the lease lapses, a new worker takes it from the checkpoint and nothing is paid twice.
  const before_ = calls;
  await worker(vcr, { stopAfter: 3 });
  const afterThree = calls;
  assert.ok(afterThree - before_ >= 200, "three batches were judged");
  await vcr.store.query("UPDATE evimed_vcr.jobs SET state='running', lease_owner='dead-worker', lease_until=now() - interval '1 second', attempts=attempts+1 WHERE id=$1", [judged.jobId]);
  const reborn = compose();
  reborn.recordsOriginals.receipts = receipts;
  // A one-patient job asked for meanwhile runs between the long job's batches, not after the long job.
  const small = await reborn.matchJudge.start(study, { direction: "trial_to_patient", protocolVersionId: protocol.id, subjectKeys: [roster[0]], fit: true, topK: 0, thinking: "high" });
  const between = await worker(reborn, { stopAfter: 2 });
  assert.equal((await vcr.store.one("SELECT state FROM evimed_vcr.jobs WHERE id=$1", [small.jobId])).state, "succeeded", "it did not wait for thousands of people");
  if (PEOPLE > 800) assert.equal((await vcr.store.one("SELECT state FROM evimed_vcr.jobs WHERE id=$1", [judged.jobId])).state, "queued", "the long job is still going");
  // The provider goes down for a while: the job waits it out, tries again what failed and goes on by itself.
  failing = 40;
  const turns = between + await worker(reborn);
  const judgedDone = judging();
  const job = await vcr.store.one("SELECT state, attempts, progress FROM evimed_vcr.jobs WHERE id=$1", [judged.jobId]);
  assert.equal(job.state, "succeeded");
  const result = await resultOf(judged.jobId);
  assert.equal(result.diagnostics.total, PEOPLE);
  assert.equal(result.diagnostics.finished, PEOPLE, JSON.stringify({ ...result.diagnostics, estimate: undefined }));
  assert.equal(result.conclusion, "estimable");
  assert.equal(Number((await vcr.store.one("SELECT count(*)::int AS n FROM evimed_vcr.match_judgments WHERE study_id=$1 AND status='done' AND thinking='off'", [study.id])).n), PEOPLE, "one row a person, paid once");
  assert.ok(result.diagnostics.used.calls >= PEOPLE - 600, "the bill is the whole job's, across its batches");
  console.error(`SCALE judge ${PEOPLE} people: ${JSON.stringify(judgedDone)} turns=${turns} modelCalls=${calls - before_} peakInFlight=${peakInFlight} attempts=${job.attempts} failures=${JSON.stringify(result.diagnostics.failures ?? {})}`);
  // Memory is what the roster's books need, not what the notes weigh.
  const notesMb = rows.join("\n").length * 3 / 1048576;
  if (PEOPLE >= 2000) assert.ok(judgedDone.peakHeapMb < 1500, `peak heap ${judgedDone.peakHeapMb} MB with ${Math.round(notesMb)} MB of notes`);
});

test("a note of 200,000 characters is split at its records, each part judged, and evidence resolves across the whole of it", options, async () => {
  const records = [];
  for (let visit = 0; records.join("\n").length < 200_000; visit += 1) records.push(`2024-${String((visit % 12) + 1).padStart(2, "0")}-15 第 ${visit} 次住院记录\n${"主诉：胸闷。查体：无异常。治疗：继续用药。".repeat(120)}`);
  const text = records.join("\n");
  assert.ok(text.length >= 200_000);
  const sentences = segmentSentences(text);
  const started = Date.now();
  const parts = splitNoteParts([{ text, sentences }], 60_000);
  assert.ok(parts.length >= 4);
  assert.ok(parts.every((part) => part.text.length <= 60_000), "every part fits a call");
  assert.ok(parts.every((part) => /^\d{4}-\d{2}-\d{2} 第 \d+ 次住院记录/u.test(part.text)), "every part starts at a record's own first line, never in the middle of a visit");
  assert.equal(parts.flatMap((part) => part.sentences).length, sentences.length, "nothing is lost");
  assert.deepEqual(parts.flatMap((part) => part.sentences).map((sentence) => sentence.id), sentences.map((sentence) => sentence.id));
  assert.ok(Date.now() - started < 10_000);
  // Part by part as the job does: a clause stated only in the last part is what the merge keeps.
  const criteria = segmentCriteria("Inclusion Criteria:\n* Adult\nExclusion Criteria:\n* Pregnant");
  const merged = mergeCriteriaAnswers(parts.map((part, index) => ({ rows: [{ number: 1, kind: "inclusion", label: "not_enough_information", basis: "silent", evidence: [], sentenceIds: [], reason: "" }, { number: 2, kind: "exclusion", label: index === parts.length - 1 ? "excluded" : "not_excluded", basis: index === parts.length - 1 ? "stated" : "silent", evidence: index === parts.length - 1 ? [{ sentenceId: part.sentences[0].id, text: part.sentences[0].text }] : [], sentenceIds: index === parts.length - 1 ? [part.sentences[0].id] : [], reason: "" }], missing: [], issues: [], droppedSentenceIds: [] })));
  assert.equal(criteria.length, 2);
  assert.equal(merged.rows.find((row) => row.number === 2).label, "excluded", "a part that states it is not averaged away by the parts that never mention it");
  assert.equal(merged.rows.find((row) => row.number === 2).evidence[0].sentenceId, parts.at(-1).sentences[0].id);
});
