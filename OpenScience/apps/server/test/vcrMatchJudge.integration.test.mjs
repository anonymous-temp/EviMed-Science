// The saved judgments on the real table: one record per pair for given inputs and what
// happens to the rows when a person withdraws, a document is erased or changes, and when a study, a project or an account is deleted. PostgreSQL.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { VCR_TABLES } from "../src/vcrPersistence.mjs";
import { VcrMatchJudgmentStore } from "../src/vcrMatchJudgmentStore.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { deleteVcrProjectRows, deleteVcrUserRows } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { streamOf } from "./helpers/vcrIntakeData.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, directory, vcr, studies, judgments;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrjudge");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-judge-"));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: directory, deepseekBaseUrl: "https://api.example.org", vcrProviderAgreements: true }, productDatabase: database });
  await vcr.store.ready();
  studies = new VcrStore({ database }); judgments = new VcrMatchJudgmentStore({ database });
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

let sequence = 0;
const head = (studyId, extra = {}) => ({ studyId, userId: "owner", subjectKey: "P-1", targetKind: "candidate_trial", targetId: "NCT00000001", targetHash: "t1", documentHash: "d1", mode: "fit",
  promptVersion: "fit-3", model: "deepseek-flash", thinking: "high", producer: "job", status: "done", fit: 70, confidence: 0.5, verdict: "possible", answer: { reasons: { eligible: ["x"] } }, usage: { calls: 1 }, documentIds: ["doc_1"], ...extra });
const newStudy = (userId = "owner", projectId = `prj_${++sequence}`) => studies.createStudy({ userId, projectId, name: `Judge ${sequence}`, question: "q", dataTier: "T0" });
const count = async (studyId) => Number((await studies.one("SELECT count(*)::int AS n FROM evimed_vcr.match_judgments WHERE study_id=$1", [studyId])).n);

test("the table is declared, its vocabularies are held, and a pair is judged once for given inputs", options, async () => {
  assert.ok(VCR_TABLES.includes("match_judgments"));
  const study = await newStudy();
  const first = await judgments.save(head(study.id));
  assert.match(first.id, /^mjd_/);
  assert.deepEqual([first.subjectKey, first.fit, first.confidence, first.verdict, first.answer.reasons.eligible, first.documentIds], ["P-1", 70, 0.5, "possible", ["x"], ["doc_1"]]);
  // A job writing the same key again finds the first row: what was paid for is not overwritten.
  const again = await judgments.save(head(study.id, { fit: 10 }));
  assert.deepEqual([again.id, again.fit], [first.id, 70]);
  assert.equal(await count(study.id), 1);
  // Anything in the key that differs is another judgment: the text on either side, the mode, the prompt, the model, the thinking, the producer.
  for (const [index, extra] of [{ targetHash: "t2" }, { documentHash: "d2" }, { mode: "criteria" }, { promptVersion: "fit-other" }, { model: "other" }, { thinking: "off" }, { producer: "conversation" }].entries()) {
    await judgments.save(head(study.id, extra));
    assert.equal(await count(study.id), 2 + index);
  }
  await assert.rejects(() => judgments.save(head(study.id, { targetKind: "nonsense" })), { code: "23514" });
  await assert.rejects(() => judgments.save(head(study.id, { targetHash: "t9", fit: 101 })), { code: "23514" });
  await assert.rejects(() => judgments.save(head(study.id, { targetHash: "t9", verdict: "maybe" })), { code: "23514" });
});

test("a failed row is replaced by the next try, a conversation's later answer replaces its earlier one, and a job never overwrites a finished row", options, async () => {
  const study = await newStudy();
  const failed = await judgments.save(head(study.id, { status: "failed", errorCode: "model_gateway_upstream_error", fit: null, confidence: null, verdict: null }));
  assert.deepEqual([failed.status, failed.errorCode, failed.fit], ["failed", "model_gateway_upstream_error", null]);
  const done = await judgments.save(head(study.id));
  assert.deepEqual([done.id, done.status, done.errorCode, done.fit], [failed.id, "done", null, 70]);
  const spoken = await judgments.save(head(study.id, { producer: "conversation", promptVersion: "conversation", model: "", thinking: "", fit: 40 }));
  const changed = await judgments.save(head(study.id, { producer: "conversation", promptVersion: "conversation", model: "", thinking: "", fit: 20 }));
  assert.deepEqual([changed.id, changed.fit], [spoken.id, 20]);
  const found = await judgments.doneFor({ studyId: study.id, promptVersions: ["fit-3"], model: "deepseek-flash", thinking: "high" });
  assert.equal(found.size, 1, "the ledger a job resumes from is its own rows under these settings");
  assert.equal([...found.values()][0].fit, 70);
});

test("a study's rows answer by person and by target, newest first, and leave out who withdrew", options, async () => {
  const study = await newStudy();
  await judgments.save(head(study.id));
  await judgments.save(head(study.id, { subjectKey: "P-2", targetKind: "protocol_version", targetId: "pv_1" }));
  assert.deepEqual((await judgments.list({ studyId: study.id, subjectKey: "P-1" })).map((row) => row.targetId), ["NCT00000001"]);
  assert.deepEqual((await judgments.list({ studyId: study.id, targetKind: "protocol_version", targetId: "pv_1" })).map((row) => row.subjectKey), ["P-2"]);
  assert.equal((await judgments.list({ studyId: study.id })).length, 2);
});

/** A study on the composed module with two people, and judgments of each. */
async function people() {
  const target = await vcr.store.createStudy({ userId: "owner", projectId: `prj_${++sequence}`, name: `Synthetic judgments ${sequence}`, question: "q", dataTier: "T0" });
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: target.id, name: "Synthetic notes" });
  const upload = async (text, subject) => (await vcr.dataPlane.storeUpload({ actor: "owner", studyId: target.id, sourceId: source.id, name: "note.txt", role: "document", subject, stream: streamOf(text) })).file;
  const one = await upload("年龄 62 岁。肌酐 1.2 mg/dL。", "WITHDRAWN-REAL-ID");
  const second = await upload("复查：肌酐 1.4 mg/dL。", "WITHDRAWN-REAL-ID");
  const other = await upload("年龄 44 岁。", "KEPT-REAL-ID");
  const s1 = one.detail.subjectKey, s2 = other.detail.subjectKey;
  const row = (subjectKey, documentId, extra = {}) => head(target.id, { subjectKey, documentIds: [documentId], answer: { rows: [{ evidence: [{ text: "年龄 62 岁。", documentId }] }] }, ...extra });
  await vcr.matchJudgments.save(row(s1, one.id, { targetId: "NCT00000001" }));
  await vcr.matchJudgments.save(row(s1, second.id, { targetId: "NCT00000002" }));
  await vcr.matchJudgments.save(row(s2, other.id, { targetId: "NCT00000001" }));
  return { target, source, one, second, other, s1, s2 };
}

test("a withdrawal takes every judgment of the person, keeps the others, and nothing in flight can put one back", options, async () => {
  const f = await people();
  assert.equal(await count(f.target.id), 3);
  await vcr.dataPlane.withdrawSubject({ studyId: f.target.id, actor: "owner", subjectKey: f.s1, reason: "consent withdrawn" });
  assert.deepEqual((await vcr.matchJudgments.list({ studyId: f.target.id })).map((row) => row.subjectKey), [f.s2]);
  const late = await vcr.matchJudgments.save(head(f.target.id, { subjectKey: f.s1, targetId: "NCT00000003" }));
  assert.equal(late, null, "a job that was already holding the text saves nothing");
  assert.equal(await count(f.target.id), 1);
});

test("a person known only by a judgment can withdraw", options, async () => {
  const study = await vcr.store.createStudy({ userId: "owner", projectId: `prj_${++sequence}`, name: `Judgment only ${sequence}`, question: "q", dataTier: "T0" });
  await vcr.matchJudgments.save(head(study.id, { subjectKey: "ONLY-JUDGED" }));
  const withdrawn = await vcr.erasure.withdrawSubject({ studyId: study.id, userId: "owner", actor: "owner", subjectKey: "ONLY-JUDGED" });
  assert.equal(withdrawn.counts.matchJudgmentsRemoved, 1);
  assert.equal(await count(study.id), 0);
});

test("a document's erasure takes the judgments that read it, and only those", options, async () => {
  const f = await people();
  await vcr.erasure.eraseDocuments({ studyId: f.target.id, userId: "owner", actor: "owner", fileIds: [f.one.id] });
  assert.deepEqual((await vcr.matchJudgments.list({ studyId: f.target.id })).map((row) => row.targetId).sort(), ["NCT00000001", "NCT00000002"].sort());
  assert.ok((await vcr.matchJudgments.list({ studyId: f.target.id })).every((row) => !row.documentIds.includes(f.one.id)));
});

test("a document nobody froze, deleted, takes its judgments with it", options, async () => {
  const f = await people();
  const removed = await vcr.dataStore.deleteSourceFile({ studyId: f.target.id, fileId: f.second.id, actor: "owner" });
  assert.equal(removed.frozen, false);
  assert.deepEqual((await vcr.matchJudgments.list({ studyId: f.target.id, subjectKey: f.s1 })).map((row) => row.targetId), ["NCT00000001"]);
});

test("a changed document or permission labels the judgments that read it, and blocks nothing", options, async () => {
  const f = await people();
  await vcr.erasure.markBasisChanged({ studyId: f.target.id, cause: "permission", causeId: f.source.id, documentIds: [f.one.id] });
  const rows = await vcr.matchJudgments.list({ studyId: f.target.id, subjectKey: f.s1 });
  assert.equal(rows.find((row) => row.targetId === "NCT00000001").basisChanged, "permission");
  assert.equal(rows.find((row) => row.targetId === "NCT00000002").basisChanged, null);
  await vcr.erasure.markSubjectChanged({ studyId: f.target.id, subjectKey: f.s2, cause: "document", causeId: "doc_new" });
  assert.equal((await vcr.matchJudgments.list({ studyId: f.target.id, subjectKey: f.s2 }))[0].basisChanged, "document");
  // A new judgment of the same text clears nothing it did not replace; a finished row's label stays until it is judged again.
  const relabelled = await vcr.matchJudgmentReads.forSubject(f.target, f.s2);
  assert.match(relabelled.ranking[0].restsOnOlder, /病历在判定之后有更新/u);
  assert.equal(relabelled.ranking[0].basisChanged, undefined, "the stored cause word is not what a conversation reads");
});

test("a study's deletion hides its judgments from every reader, as it hides its facts; the rows stay with the soft-deleted study", options, async () => {
  const f = await people();
  await vcr.store.softDeleteStudy(f.target.id, "owner");
  assert.equal(await count(f.target.id), 3);
  assert.equal(await vcr.store.studyById(f.target.id), null);
});

test("a project's deletion takes its judgments in the same transaction", options, async () => {
  const study = await newStudy("owner_p");
  await judgments.save(head(study.id, { userId: "owner_p" }));
  assert.equal(await count(study.id), 1);
  const { deleted } = await database.transaction((client) => deleteVcrProjectRows(client, "owner_p", study.projectId));
  assert.equal(deleted, true);
  assert.equal(await count(study.id), 0);
});

test("an account's deletion takes its judgments in the same transaction", options, async () => {
  const study = await newStudy("owner_a");
  await judgments.save(head(study.id, { userId: "owner_a" }));
  const { deleted } = await database.transaction((client) => deleteVcrUserRows(client, "owner_a"));
  assert.equal(deleted, true);
  assert.equal(await count(study.id), 0);
});

test("a study that holds only judgments reads as a matching study", options, async () => {
  const study = await vcr.store.createStudy({ userId: "owner", projectId: `prj_${++sequence}`, name: `Held ${sequence}`, question: "q", dataTier: "T0" });
  await vcr.matchJudgments.save(head(study.id));
  assert.deepEqual(await vcr.store.heldTabs(study.id), ["matching"]);
});

test("the model reads through the service: a person's ranking, a protocol's people, numbered sentences and clauses, and today's answer where nothing was judged", options, async () => {
  const f = await people();
  const context = { ...f.target, cloudContext: { runId: "run_judge", sessionId: "session_judge" } };
  const sentences = await vcr.service.runtimeRead(context, "subject_document", { subjectKey: f.s2, kind: "sentences" });
  assert.deepEqual(sentences.sentences.map((row) => row.text), ["年龄 44 岁。"]);
  assert.match(sentences.documentHash, /^[a-f0-9]{64}$/);
  const read = await vcr.service.runtimeRead(context, "candidate_trials", { subjectKey: f.s2 });
  assert.deepEqual(read.ranking.map((row) => row.target.id), ["NCT00000001"]);
  assert.deepEqual([read.ranking[0].verdict, read.ranking[0].verdictLabel, read.ranking[0].fit], ["possible", "可能符合", 70]);
  const nobody = await vcr.service.runtimeRead(context, "candidate_trials", { subjectKey: "NO-ONE" });
  assert.deepEqual(nobody.ranking, [], "a person with no judgment reads today's answer");
  assert.equal("requests" in nobody, false, "no write can answer a language request, so none is offered");
  await vcr.matchJudgments.save(head(f.target.id, { subjectKey: f.s1, targetKind: "protocol_version", targetId: "prt_x", documentIds: [f.one.id] }));
  const protocol = await vcr.service.runtimeRead(context, "matching", { protocolVersionId: "prt_x" });
  assert.deepEqual(protocol.ranking.map((row) => [row.subjectKey, row.target.kind]), [[f.s1, "protocol_version"]]);
  assert.deepEqual(protocol.clauses, []);
});
