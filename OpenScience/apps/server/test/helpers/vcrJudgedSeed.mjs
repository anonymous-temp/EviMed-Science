// A small, deterministic study of judged pairs the matching page's tests and walks share: one patient with a real record, judged against seven trials by a
// job that is still out (three trials done in three different ways, one that is a score and nothing else, two that failed, one not yet tried), and the
// study's own protocol judged for thirteen people by a job that is out too. The model is not here: the rows are written the way the judging job writes them.
import { Readable } from "node:stream";
import { segmentSentences } from "@evimed/domain";

export const NOTE = [
  "患者男，62岁，2025年3月确诊肺腺癌，EGFR 19del 阳性。",
  "ECOG 评分 1 分。",
  "2026年9月复查：肌酐 1.2 mg/dL，肝功能正常。",
  "既往无糖尿病史，无药物过敏史。",
  "2025年4月起口服奥希替尼至今。",
].join("\n");

/** The sentences of the note with their ids and offsets, as the judging job numbers them. */
export const sentencesOf = () => segmentSentences(NOTE);

const TRIALS = {
  1: { title: "EGFR 19del 阳性晚期非小细胞肺癌一线治疗", status: "RECRUITING", phase: "PHASE3" },
  2: { title: "既往未用过 EGFR-TKI 的晚期肺腺癌", status: "RECRUITING", phase: "PHASE2" },
  3: { title: "晚期肺癌的观察性研究", status: "NOT_YET_RECRUITING", phase: "NA" },
  4: { title: "PD-1 联合化疗的随机对照研究", status: "RECRUITING", phase: "PHASE3" },
  5: { title: "已撤销登记的试验", status: "WITHDRAWN", phase: "PHASE2" },
  6: { title: "靶向治疗耐药后的新方案", status: "RECRUITING", phase: "PHASE2" },
  7: { title: "晚期肺腺癌的真实世界研究", status: "ACTIVE_NOT_RECRUITING", phase: "NA" },
};
export const trialId = (n) => `NCT0500000${n}`;
const target = (n, extra = {}) => ({ kind: "candidate_trial", id: trialId(n), registry: "clinicaltrials.gov", registryId: trialId(n), title: TRIALS[n].title, url: `https://clinicaltrials.gov/study/${trialId(n)}`, status: TRIALS[n].status, phase: TRIALS[n].phase, ...extra });

const clause = (number, kind, text, label, basis, reason, sentenceIds = []) => {
  const sentences = sentencesOf();
  const evidence = sentenceIds.map((id) => ({ sentenceId: id, text: sentences[id].text, start: sentences[id].start, end: sentences[id].end, documentId: "DOCUMENT" }));
  return { number, kind, clause: text, label, reason, sentenceIds, evidence, basis };
};

/**
 * @param {{ app: any, call: (who: string, method: string, route: string, body?: unknown) => Promise<{ status: number, body: any }>, owner: string }} context
 * @param {string} [name]
 */
export async function seedJudged({ app, call, owner }, name = "患者匹配结果") {
  const created = await call("owner", "POST", "/api/vcr/studies", { name, question: "在 ITT 人群中 X 相对 Y 的总生存期", dataTier: "T0", intendedUse: "exploratory" });
  if (created.status !== 201) throw new Error(`study not created: ${JSON.stringify(created.body)}`);
  const study = created.body.data;
  const plane = app.vcr.dataPlane;
  const source = await plane.registerSource({ userId: owner, studyId: study.id, name: "合成病历" });
  const uploaded = await plane.storeUpload({ actor: owner, studyId: study.id, sourceId: source.id, name: "note.txt", role: "document", subject: "SYNTHETIC-0192", stream: Readable.from([Buffer.from(NOTE)]) });
  const patient = String(uploaded.file.detail.subjectKey);
  const document = String(uploaded.file.id);
  const db = app.vcr.store.database;
  const save = (entry) => app.vcr.matchJudgments.save({ studyId: study.id, userId: owner, targetHash: "t", documentHash: "d", promptVersion: entry.mode === "fit" ? "fit-2" : "criteria-4", model: "deepseek-flash", thinking: "high", producer: "job", status: "done",
    documentIds: [document], ...entry, answer: JSON.parse(JSON.stringify(entry.answer ?? {}).replaceAll("DOCUMENT", document)) });
  const job = async (scenario, state) => {
    const id = `job_${Math.random().toString(36).slice(2, 12)}`;
    await db.query(`INSERT INTO evimed_vcr.jobs (id, study_id, user_id, kind, method, state, scenario) VALUES ($1, $2, $3, 'match_judge', 'matching.judge', $4, $5::jsonb)`, [id, study.id, owner, state, JSON.stringify(scenario)]);
    return id;
  };

  // ---- one patient, seven trials ---------------------------------------------------------------------------------------------------------
  const asked = [1, 2, 3, 4, 5, 6, 7];
  const patientJob = await job({ direction: "patient_to_trial", subjects: [patient], trials: asked.map((n) => ({ registry: "clinicaltrials.gov", registryId: trialId(n) })), fit: true, topK: 20, thinking: "high", estimate: { cost: 1.5, currency: "CNY", pairs: 7 } }, "running");
  const pair = { subjectKey: patient, targetKind: "candidate_trial", jobId: patientJob };
  // 1: promising, with a clause the record is silent on and one it needs confirmed.
  await save({ ...pair, targetId: trialId(1), mode: "fit", fit: 92, confidence: 0.85, verdict: "possible", usage: { cost: 0.0125 },
    answer: { target: target(1), eligibilitySource: "registry", reasons: { eligible: ["确诊 EGFR 19del 阳性的肺腺癌，ECOG 1 分", "肌酐和肝功能正常"], ineligible: [], missing: ["近 4 周内是否接受过化疗"] } } });
  await save({ ...pair, targetId: trialId(1), mode: "criteria", fit: 92, confidence: 0.85, verdict: "possible", usage: { cost: 0.0225 }, answer: { target: target(1), eligibilitySource: "registry", missing: [], rows: [
    clause(1, "inclusion", "病理确诊的非小细胞肺癌", "included", "stated", "病历记录为肺腺癌", [0]),
    clause(2, "inclusion", "EGFR 19del 或 L858R 突变", "included", "stated", "EGFR 19del 阳性", [0]),
    clause(3, "inclusion", "ECOG 评分 0–1 分", "included", "stated", "ECOG 1 分", [1]),
    clause(4, "exclusion", "未控制的糖尿病", "not_excluded", "stated", "既往无糖尿病史", [3]),
    clause(5, "exclusion", "间质性肺病史", "not_excluded", "silent", "病历没有间质性肺病的记载，按未排除"),
    clause(6, "exclusion", "近 4 周内接受过化疗", "not_enough_information", "silent", "病历没有写近期是否化疗，需要确认"),
    clause(7, "exclusion", "妊娠或哺乳期", "not_applicable", "silent", "62 岁男性，不适用"),
  ] } });
  // 2: a stated disqualifier.
  await save({ ...pair, targetId: trialId(2), mode: "fit", fit: 12, confidence: 0.9, verdict: "ineligible", usage: { cost: 0.0125 },
    answer: { target: target(2), eligibilitySource: "registry", reasons: { eligible: ["确诊 EGFR 突变的肺腺癌"], ineligible: ["已经用过奥希替尼，试验要求未用过 EGFR-TKI"], missing: [] } } });
  await save({ ...pair, targetId: trialId(2), mode: "criteria", fit: 12, confidence: 0.9, verdict: "ineligible", usage: { cost: 0.02 }, answer: { target: target(2), eligibilitySource: "registry", missing: [], rows: [
    clause(1, "inclusion", "确诊的肺腺癌", "included", "stated", "病历记录为肺腺癌", [0]),
    clause(2, "exclusion", "既往接受过 EGFR-TKI 治疗", "excluded", "stated", "2025 年 4 月起服用奥希替尼", [4]),
  ] } });
  // 3: a score and nothing else — the record of the trial had no eligibility text.
  await save({ ...pair, targetId: trialId(3), mode: "fit", fit: 61, confidence: 0.4, verdict: "possible", usage: { cost: 0.0125 },
    answer: { target: target(3), eligibilitySource: "none", reasons: { eligible: [], ineligible: [], missing: [], rationale: "题目和疾病方向相合，但没有入排原文可核对。" } } });
  // 7: everything stated in the patient's favour.
  await save({ ...pair, targetId: trialId(7), mode: "fit", fit: 88, confidence: 0.8, verdict: "eligible", usage: { cost: 0.0125 },
    answer: { target: target(7), eligibilitySource: "registry", reasons: { eligible: ["晚期肺腺癌，年龄和体能状态符合"], ineligible: [], missing: [] } } });
  await save({ ...pair, targetId: trialId(7), mode: "criteria", fit: 88, confidence: 0.8, verdict: "eligible", usage: { cost: 0.0225 }, answer: { target: target(7), eligibilitySource: "registry", missing: [], rows: [
    clause(1, "inclusion", "年龄 18 岁及以上", "included", "stated", "62 岁", [0]),
    clause(2, "inclusion", "晚期肺腺癌", "included", "stated", "确诊肺腺癌", [0]),
    clause(3, "exclusion", "对试验用药过敏", "not_excluded", "stated", "无药物过敏史", [3]),
  ] } });
  // 4 and 5 failed; 6 has not been tried.
  await save({ ...pair, targetId: trialId(4), mode: "fit", status: "failed", errorCode: "vcr_match_judge_timeout", usage: { cost: 0.01 }, answer: { target: target(4) } });
  await save({ ...pair, targetId: trialId(5), mode: "fit", status: "failed", errorCode: "registry_not_found", usage: {}, answer: { target: { kind: "candidate_trial", id: trialId(5), registry: "clinicaltrials.gov", registryId: trialId(5) } } });

  // ---- a protocol, thirteen people judged, three more asked --------------------------------------------------------------------------------
  const criteriaTexts = ["年龄 18 岁及以上", "组织学确诊的非小细胞肺癌", "ECOG 评分 0–1 分", "至少一个可测量病灶", "活动性脑转移", "间质性肺病史", "妊娠或哺乳期", "近 4 周内接受过化疗"];
  const version = await app.vcr.matchStore.saveProtocolVersion({ studyId: study.id, userId: owner, title: "EV-201 方案 v1",
    criteria: criteriaTexts.map((sourceText, at) => ({ kind: at < 4 ? "inclusion" : "exclusion", criterionType: "other", sourceText })) });
  const protocolId = String(version.id);
  const people = Array.from({ length: 12 }, (_, at) => `P-${String(301 + at).padStart(4, "0")}`);
  const protocolJob = await job({ direction: "trial_to_patient", protocolVersionId: protocolId, subjects: [...people, patient, "P-0313", "P-0314", "P-0315"], fit: true, topK: "all", thinking: "high", estimate: { cost: 12.5, currency: "CNY", pairs: 16 } }, "running");
  const protocolTarget = { kind: "protocol_version", id: protocolId, title: "EV-201 方案 v1", version: 1 };
  const rowsOf = (at) => {
    const label = (number, kind, text) => ({ number, kind, clause: text, label: kind === "inclusion" ? "included" : "not_excluded", basis: "stated", reason: "病历有记载", sentenceIds: [], evidence: [] });
    const rows = [
      label(1, "inclusion", "年龄 18 岁及以上"), label(2, "inclusion", "组织学确诊的非小细胞肺癌"), label(3, "inclusion", "ECOG 评分 0–1 分"), label(4, "inclusion", "至少一个可测量病灶"),
      label(5, "exclusion", "活动性脑转移"), label(6, "exclusion", "间质性肺病史"), label(7, "exclusion", "妊娠或哺乳期"), label(8, "exclusion", "近 4 周内接受过化疗"),
    ];
    const set = (index, patch) => { rows[index] = { ...rows[index], ...patch }; };
    if ([0, 4, 8].includes(at)) set(4, { label: "excluded", reason: "头颅 MRI 提示活动性脑转移" });
    if (at === 5) set(7, { label: "excluded", reason: "2 周前刚完成化疗" });
    if ([1, 2, 6, 9].includes(at)) set(5, { basis: "silent", reason: "病历没有间质性肺病的记载，按未排除" });
    if ([2, 10].includes(at)) set(7, { label: "not_enough_information", basis: "silent", reason: "没有写近期是否化疗" });
    if (at === 3) { set(3, { label: "not_enough_information", basis: "silent", reason: "没有影像报告，可测量病灶不明" }); set(6, { label: "not_applicable", basis: "silent", reason: "男性，不适用" }); }
    return rows;
  };
  const fits = [20, 94, 90, 40, 18, 30, 86, 80, 15, 82, 35, 85];
  for (const [at, key] of people.entries()) {
    const rows = rowsOf(at);
    await save({ subjectKey: key, targetKind: "protocol_version", targetId: protocolId, mode: "criteria", fit: fits[at], confidence: 0.7, verdict: "possible", jobId: protocolJob, usage: { cost: 0.021 },
      documentIds: [], answer: { target: protocolTarget, eligibilitySource: "protocol", rows, missing: [] } });
  }
  // The patient with the real record is one of the thirteen, so her clauses can be opened at their sentences.
  await save({ subjectKey: patient, targetKind: "protocol_version", targetId: protocolId, mode: "fit", fit: 91, confidence: 0.8, verdict: "possible", jobId: protocolJob, usage: { cost: 0.0125 },
    answer: { target: protocolTarget, eligibilitySource: "protocol", reasons: { eligible: ["肺腺癌、EGFR 阳性、ECOG 1 分，符合方案的入选条件"], ineligible: [], missing: ["近 4 周内是否化疗"] } } });
  await save({ subjectKey: patient, targetKind: "protocol_version", targetId: protocolId, mode: "criteria", fit: 91, confidence: 0.8, verdict: "possible", jobId: protocolJob, usage: { cost: 0.021 }, answer: { target: protocolTarget, eligibilitySource: "protocol", missing: [], rows: [
    clause(1, "inclusion", "年龄 18 岁及以上", "included", "stated", "62 岁", [0]),
    clause(2, "inclusion", "组织学确诊的非小细胞肺癌", "included", "stated", "肺腺癌", [0]),
    clause(3, "inclusion", "ECOG 评分 0–1 分", "included", "stated", "ECOG 1 分", [1]),
    clause(4, "inclusion", "至少一个可测量病灶", "included", "silent", "病历没有写病灶，按符合"),
    clause(5, "exclusion", "活动性脑转移", "not_excluded", "silent", "病历没有脑转移的记载，按未排除"),
    clause(6, "exclusion", "间质性肺病史", "not_excluded", "silent", "病历没有间质性肺病的记载，按未排除"),
    clause(7, "exclusion", "妊娠或哺乳期", "not_applicable", "silent", "男性，不适用"),
    clause(8, "exclusion", "近 4 周内接受过化疗", "not_enough_information", "silent", "没有写近期是否化疗"),
  ] } });
  await save({ subjectKey: "P-0313", targetKind: "protocol_version", targetId: protocolId, mode: "criteria", status: "failed", errorCode: "vcr_match_judge_timeout", jobId: protocolJob, usage: { cost: 0.01 }, documentIds: [], answer: { target: protocolTarget } });

  return { study, patient, document, protocolId, patientJob, protocolJob, people };
}
