// The passages of a long patient record that bear on a criterion (M4): found by words the criterion, its variables and the deployment's
// terminology share with the record, returned with the characters they stand at. A retrieval hint, never a verdict: a passage that is not
// found leaves the fact unknown. Synthetic records only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { clinicalTerminologyContext } from "@evimed/domain";

import { vcrDocumentsSeam } from "../src/vcrComposition.mjs";
import { assessSubject } from "../src/vcrMatching.mjs";
import { PASSAGES_CHARS_MAX, PASSAGES_MAX, locatePassages, passageTerms, passageTokens, passageUnits, passageWindow } from "../src/vcrPassages.mjs";
import { VcrService } from "../src/vcrService.mjs";

/** Ordinary chart sentences: none of them shares a word with the criteria below. */
const FILLER = [
  "患者今日精神可，饮食睡眠正常。", "血压 126/78 mmHg，脉搏 72 次/分。", "继续口服二甲双胍 0.5 g，每日两次。", "嘱低盐低脂饮食，适量运动。",
  "无发热，无咳嗽咳痰，二便正常。", "查体：双肺呼吸音清，腹软，无压痛。", "复查血常规未见明显异常。", "患者家属陪同就诊，沟通顺畅。",
];
const MI_SENTENCE = "2026-06-28 因急性心梗入院，行 PCI 治疗，术后恢复可。";
const ECOG_SENTENCE = "入院评估：ECOG 评分 1 分。";
const T2DM_SENTENCE = "既往 T2DM 病史 8 年，规律服药。";

/** A long record with three planted sentences at known places. @param {number} sentences */
function longRecord(sentences = 3200) {
  const parts = [];
  for (let at = 0; at < sentences; at += 1) {
    parts.push(`第 ${at + 1} 次随访：${FILLER[at % FILLER.length]}`);
    if (at === Math.floor(sentences * 0.31)) parts.push(MI_SENTENCE);
    if (at === Math.floor(sentences * 0.62)) parts.push(ECOG_SENTENCE);
    if (at === Math.floor(sentences * 0.88)) parts.push(T2DM_SENTENCE);
  }
  return parts.join("\n");
}

const MI = { sourceText: "近 6 个月内发生过心肌梗死者除外", kind: "exclusion",
  requirement: { op: "absent", variable: "myocardial_infarction", window: { months: 6 } } };
const MI_TERMINOLOGY = { terms: [{ concept: "myocardial_infarction", label: "Myocardial infarction", labelZh: "心肌梗死", synonyms: ["MI", "心梗", "急性心梗"] }], mappings: [] };

test("the tokens of a text are its Latin words and numbers and the character pairs of its Chinese runs", () => {
  assert.deepEqual([...passageTokens("ECOG 评分 1 分, creatinine 2.4 mg/dL")].sort(), ["2.4", "creatinine", "ecog", "mg/dl", "评分"].sort());
  assert.deepEqual([...passageTokens("心肌梗死")].sort(), ["心肌", "肌梗", "梗死"].sort());
  assert.deepEqual([...passageTokens("近 6 个月，者")].sort(), ["个月"], "a Han character between other characters would match every sentence: it is not a token");
  assert.deepEqual([...passageTokens("")], []);
});

test("a record is cut into sentences with the characters each stands at, and a very long one is cut where it is long", () => {
  const record = "第一句。第二句！\nSecond sentence. Third one; fourth?\n\n尾巴";
  const units = passageUnits(record);
  assert.deepEqual(units.map((unit) => record.slice(unit.start, unit.end)), ["第一句。", "第二句！", "Second sentence.", " Third one;", " fourth?", "尾巴"]);
  const run = "字".repeat(1500);
  assert.deepEqual(passageUnits(run).map((unit) => unit.end - unit.start), [600, 600, 300]);
  assert.deepEqual(passageUnits("   \n  "), []);
});

test("the words to look for are the criterion's own, its variables' and the terminology's; the variable's and the terminology's weigh double", () => {
  const terms = passageTerms(MI, MI_TERMINOLOGY);
  assert.deepEqual(terms.variables, ["myocardial_infarction"]);
  assert.equal(terms.fromTerminology, 5, "a label, a Chinese label and three synonyms");
  assert.equal(terms.weights.get("梗死"), 2, "in the terminology and in the wording: the larger weight");
  assert.equal(terms.weights.get("发生"), 1, "only in the wording");
  assert.ok(terms.weights.has("心梗") && terms.weights.has("myocardial") && terms.weights.has("infarction"));
  // The sex vocabulary the evaluator reads codes through is words for a record too.
  const sex = passageTerms({ sourceText: "仅女性", requirement: { op: "compare", variable: "sex", comparator: "eq", value: "female" } });
  assert.ok(sex.weights.has("女性") && sex.weights.has("woman") && sex.weights.has("male"));
  // Words the run asked for are its own.
  assert.equal(passageTerms(null, null, "ecog").weights.get("ecog"), 2);
  assert.equal(passageTerms(null, null, null).weights.size, 0);
});

test("a long record gives the passage that carries the criterion, with the place it stands, however far in it is (M4)", () => {
  const record = longRecord();
  assert.ok(record.length > 60_000, `a long record (${record.length})`);
  const { passages, units, queryTokens } = locatePassages(record, passageTerms(MI, MI_TERMINOLOGY));
  assert.ok(units > 3000 && queryTokens >= 1, "the words of the query that the record has");
  assert.ok(passages.length >= 1 && passages.length <= PASSAGES_MAX);
  const hit = passages.find((passage) => passage.text.includes(MI_SENTENCE));
  assert.ok(hit, "the planted sentence is among the passages");
  assert.equal(record.slice(hit.start, hit.end), hit.text, "the position is the passage's own characters, as a quotation's span is");
  assert.equal(hit.start, record.indexOf(MI_SENTENCE) - (hit.text.indexOf(MI_SENTENCE)));
  assert.ok(hit.matched.some((word) => word === "心梗" || word === "急性" || word === "梗死" || word === "心肌"), "and what matched is said");
  assert.ok(passages.reduce((sum, passage) => sum + (passage.end - passage.start), 0) <= PASSAGES_CHARS_MAX);
  assert.ok(passages.every((passage, at) => at === 0 || passage.start >= passages[at - 1].end), "in the order of the record, none overlapping");
  assert.ok(!passages.some((passage) => passage.text.includes(ECOG_SENTENCE)), "and not the sentences about something else");
  // The terminology reaches a sentence the criterion's own wording does not: 'T2DM' is not in 确诊2型糖尿病.
  const t2dm = { sourceText: "确诊2型糖尿病", requirement: { op: "present", variable: "type_2_diabetes" } };
  const withoutPack = locatePassages(record, passageTerms(t2dm));
  assert.ok(!withoutPack.passages.some((passage) => passage.text.includes(T2DM_SENTENCE)), "the wording alone does not reach it");
  const pack = { terms: [{ concept: "type_2_diabetes", label: "Type 2 diabetes mellitus", labelZh: "2型糖尿病", synonyms: ["T2DM"] }], mappings: [] };
  const withPack = locatePassages(record, passageTerms(t2dm, pack));
  assert.ok(withPack.passages.some((passage) => passage.text.includes(T2DM_SENTENCE)), "the deployment's own terminology does");
});

test("the deployment's real disease pack gives a criterion the words a record uses (M4)", async () => {
  const pack = JSON.parse(await readFile(new URL("../../../packages/domain/src/vcr-packs/type_2_diabetes.json", import.meta.url), "utf8"));
  const criterion = { sourceText: "确诊 2 型糖尿病", requirement: { op: "present", variable: "type_2_diabetes" } };
  const terminology = clinicalTerminologyContext(pack, [criterion]);
  const terms = passageTerms(criterion, terminology);
  assert.ok(terms.fromTerminology > 0 && terms.weights.has("t2dm"));
  const found = locatePassages(longRecord(1200), terms);
  assert.ok(found.passages.some((passage) => passage.text.includes(T2DM_SENTENCE)));
});

test("words that are not in the record give no passage - which says the words were not found, and writes no verdict: the criterion stays unknown", () => {
  const record = longRecord(800);
  const pregnancy = { sourceText: "妊娠期或哺乳期女性", kind: "exclusion", requirement: { op: "absent", variable: "pregnancy" } };
  const found = locatePassages(record, passageTerms(pregnancy));
  assert.deepEqual(found.passages, []);
  assert.deepEqual(locatePassages("", passageTerms(pregnancy)).passages, []);
  assert.deepEqual(locatePassages(record, passageTerms(null)).passages, []);
  // With no fact written, the evaluator's answer is unknown - never not_satisfied or satisfied.
  const assessment = assessSubject({ studyId: "std_1", protocolVersionId: "prt_1", subjectKey: "P-1", asOf: "2026-11-01T00:00:00Z",
    criteria: [{ id: "c1", kind: "exclusion", criterionType: "comorbidity", requirement: { op: "not", operand: pregnancy.requirement }, applicability: null }], facts: [] });
  assert.equal(assessment.judgments[0].state, "unknown");
  assert.equal(assessment.summary, "insufficient_evidence");
});

test("passages that touch are one passage, and a passage is cut at the characters a run is given", () => {
  const near = `${"无关的句子。".repeat(30)}曾因心梗住院。\n复查心肌酶。\n${"无关的句子。".repeat(30)}`;
  const { passages } = locatePassages(near, passageTerms(MI, MI_TERMINOLOGY));
  assert.equal(passages.length, 1, "two adjacent matching sentences make one passage with their context");
  assert.ok(passages[0].text.includes("曾因心梗住院。") && passages[0].text.includes("复查心肌酶。"));
  const crowded = Array.from({ length: 200 }, (_, at) => `第 ${at} 年：心梗史${"，无特殊".repeat(40)}。\n`).join("");
  const found = locatePassages(crowded, passageTerms(MI, MI_TERMINOLOGY));
  assert.ok(found.passages.length <= PASSAGES_MAX);
  assert.ok(found.passages.reduce((sum, passage) => sum + (passage.end - passage.start), 0) <= PASSAGES_CHARS_MAX);
});

test("a passage is recorded as a window served, like any window", () => {
  const record = longRecord(400);
  const [passage] = locatePassages(record, passageTerms(MI, MI_TERMINOLOGY)).passages;
  const window = passageWindow(passage, record.length);
  assert.match(window.windowHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(window.coverage.served, [passage.start, passage.end]);
  assert.equal(window.coverage.after, record.length - passage.end);
  assert.equal(window.coverage.extraction, "unknown", "served is not extracted");
});

// --- the read: the documents seam and the service ------------------------------------------------------

/** A data plane double holding one document, recording the windows it was told were served. @param {string} text */
function planeWith(text) {
  /** @type {any[]} */
  const served = [];
  const dataPlane = /** @type {any} */ ({
    async projectionText() { return { id: "doc_1", subjectKey: "P-1", text, visibleAt: "2026-09-01T00:00:00.000Z", projectionHash: "h".repeat(64) }; },
    async recordDocumentWindow(_study, _document, _context, window) { served.push(window); },
    async recordDocumentWindows(_study, _document, _context, windows) { served.push(...windows); },
  });
  return { dataPlane, served };
}
const STUDY = { id: "std_1", userId: "u1", cloudContext: { runId: "run_1", sessionId: "ses_1" } };

test("a long record read for a criterion answers its passages and records each as served; a plain read of it says how to ask (M4)", async () => {
  const record = longRecord();
  const { dataPlane, served } = planeWith(record);
  const documents = vcrDocumentsSeam({ dataPlane, passagesMinChars: 40_000 });
  const terms = passageTerms(MI, MI_TERMINOLOGY);

  const answer = await documents.subjectDocuments(STUDY, { subjectKey: "P-1", documentId: "doc_1", passages: { terms, criterionId: "crt_1" } });
  assert.equal(answer.available, true);
  assert.equal(answer.document.chars, record.length);
  assert.equal(answer.document.text, undefined, "the passages are what is sent, not the first window");
  assert.ok(answer.passages.some((passage) => passage.text.includes(MI_SENTENCE)));
  assert.deepEqual([answer.passageSearch.criterionId, answer.passageSearch.variables, answer.passageSearch.searchedChars], ["crt_1", ["myocardial_infarction"], record.length]);
  assert.match(answer.note, /检索线索，不是判断/);
  assert.match(answer.note, /不能写成 negated/);
  assert.equal(served.length, answer.passages.length, "every passage sent is a window served");
  assert.deepEqual(served.map((window) => window.coverage.served), answer.passages.map((passage) => [passage.start, passage.end]));

  // No criterion and no words: the first window as always, and the way to ask for the part that matters.
  served.length = 0;
  const plain = await documents.subjectDocuments(STUDY, { subjectKey: "P-1", documentId: "doc_1" });
  assert.equal(plain.document.text.length, 20_000);
  assert.equal(plain.document.more, true);
  assert.equal(plain.long.chars, record.length);
  assert.match(plain.long.how, /id.*query/);
  assert.equal(served.length, 1);
  // A later window is not told again.
  assert.equal((await documents.subjectDocuments(STUDY, { subjectKey: "P-1", documentId: "doc_1", offset: 19_500 })).long, undefined);
});

test("a record under the threshold is read as it always was, and asking for passages of it says so", async () => {
  const { dataPlane, served } = planeWith(longRecord(120));
  const documents = vcrDocumentsSeam({ dataPlane, passagesMinChars: 40_000 });
  const plain = await documents.subjectDocuments(STUDY, { subjectKey: "P-1", documentId: "doc_1" });
  assert.equal(plain.long, undefined);
  assert.equal(plain.document.more, false);
  const asked = await documents.subjectDocuments(STUDY, { subjectKey: "P-1", documentId: "doc_1", passages: { terms: passageTerms(MI, MI_TERMINOLOGY), criterionId: "crt_1" } });
  assert.ok(asked.document.text.includes(MI_SENTENCE), "the whole short record is the window");
  assert.deepEqual(asked.passages, []);
  assert.match(asked.passageSearch.note, /直接读窗口/);
  assert.equal(served.length, 2);
  // The threshold is the deployment's.
  assert.equal(vcrDocumentsSeam({ dataPlane: null }).passagesMinChars, 40_000);
  assert.equal(vcrDocumentsSeam({ dataPlane: null, passagesMinChars: 5_000 }).passagesMinChars, 5_000);
});

test("the service resolves the criterion a read names, with the terminology the pack holds, and refuses one that is not the study's", async () => {
  const record = longRecord();
  const { dataPlane } = planeWith(record);
  const documents = vcrDocumentsSeam({ dataPlane, passagesMinChars: 40_000 });
  /** @type {any[]} */
  const asked = [];
  const matching = {
    async criterionById(_study, id) { asked.push(["criterion", id]); return id === "crt_1" ? { id, ...MI } : null; },
    async passageTerminology(_study, criterion) { asked.push(["terminology", criterion.id]); return MI_TERMINOLOGY; },
  };
  const service = new VcrService({ store: {}, config: {}, documents, matching });
  const read = (filter) => service.runtimeRead(STUDY, "subject_document", { subjectKey: "P-1", documentId: "doc_1", ...filter });

  const found = await read({ id: "crt_1" });
  assert.ok(found.passages.some((passage) => passage.text.includes(MI_SENTENCE)));
  assert.deepEqual(found.passageSearch.variables, ["myocardial_infarction"]);
  assert.equal(found.passageSearch.terminologyTerms, 5);
  assert.deepEqual(asked, [["criterion", "crt_1"], ["terminology", "crt_1"]]);

  // Words of the run's own need no criterion.
  asked.length = 0;
  const words = await read({ query: "ECOG 评分" });
  assert.ok(words.passages.some((passage) => passage.text.includes(ECOG_SENTENCE)));
  assert.equal(words.passageSearch.criterionId, null);
  assert.deepEqual(asked, []);

  // A criterion of another study (or none): named, and not an empty answer that would read as a record that says nothing.
  const missing = await read({ id: "crt_other" });
  assert.deepEqual([missing.available, missing.code], [false, "vcr_read_filter_invalid"]);
  assert.deepEqual(asked.map((entry) => entry[0]), ["criterion"], "the protocol's criteria are the only ones");
  assert.equal(missing.passages, undefined);
});
