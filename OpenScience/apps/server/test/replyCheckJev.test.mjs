// The reply check's first pass (replyCheckJev.mjs): what is put to Jev, what
// Jev may settle, and that everything else — and everything, when Jev is off
// or fails — reaches the reviewer model exactly as before.
import assert from "node:assert/strict";
import test from "node:test";
import { replyCitedSentences } from "@evimed/domain";
import { JEV_RELATION_CRITERIA, jevDecisions, jevReplyRequest, judgeCitedSentences } from "../src/replyCheckJev.mjs";
import { replyMessage } from "../src/reviewService.mjs";

const REPLY = [
  "二甲双胍可使 HbA1c 较安慰剂降低约 0.9 个百分点 [1]。",
  "心电图是胸痛评估的最佳初始检查 [2]。",
  "高敏肌钙蛋白提高了心肌梗死的早期诊断率 [2][3]。",
  "睡眠不足与认知下降相关 [4]。",
  "",
  "参考文献：",
  "1. Smith J. Metformin versus placebo. PMID: 12345678",
  "2. ECG in chest pain. doi:10.1000/ecg",
  "3. High-sensitivity troponin. doi:10.1000/tn",
  "4. Sleep and cognition. https://example.org/sleep",
].join("\n");

const { sentences, references } = replyCitedSentences(REPLY);
/** Sources 1–3 could be read; 4 could not. */
const readable = new Map([
  [1, "Metformin versus placebo. Metformin lowered HbA1c by 0.9 percentage points compared with placebo."],
  [2, "ECG in chest pain. The electrocardiogram remains the best initial test for chest pain evaluation."],
  [3, "High-sensitivity troponin. hs-cTn assays allow earlier diagnosis of myocardial infarction."],
]);

/** A choice answer the way Jev writes one: confidence from its own probabilities. @param {Record<string, number>} probabilities */
function choice(probabilities) {
  const entries = Object.entries(probabilities);
  const [top, p] = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return { type: "choice", choice: top, confidence: Math.round(((3 * p - 1) / 2) * 100) / 100, probabilities };
}
const SURE = choice({ supports: 0.98, contradicts: 0.01, says_nothing: 0.01 });
const UNSURE = choice({ supports: 0.76, contradicts: 0.02, says_nothing: 0.22 });
const AGAINST = choice({ supports: 0.02, contradicts: 0.97, says_nothing: 0.01 });

/** A reviewer that records what it was asked and supports every sentence with a located quote. */
function reviewerSpy() {
  /** @type {any[]} */
  const asked = [];
  return {
    asked,
    reviewer: async (/** @type {{ sentences: any[], references: any[] }} */ input) => {
      asked.push(input);
      return {
        model: "qwen3.8-max-0902", cost: 0.01,
        value: { verdicts: input.sentences.map((sentence) => ({
          sentence: sentence.index, verdict: "supported", reason: "来源如此", safety: sentence.medicines.length ? "consistent" : "none",
          evidence: readable.get(sentence.numbers.find((/** @type {number} */ number) => readable.has(number)))?.slice(-40) ?? "",
        })) },
      };
    },
  };
}

/** @param {Record<string, any>} answers */
function jevAnswering(answers) {
  /** @type {any[]} */
  const requests = [];
  return {
    requests,
    jev: async (/** @type {any} */ request) => {
      requests.push(request);
      return { model: "jev-1.13.0", cost: 0.0001, answers };
    },
  };
}

test("the reply parses into the sentences this suite is about", () => {
  assert.deepEqual(sentences.map((sentence) => [sentence.index, sentence.numbers, sentence.medicines.length > 0]),
    [[0, [1], true], [1, [2], false], [2, [2, 3], false], [3, [4], false]]);
});

test("each sentence Jev may settle travels with its own readable sources, and its question names them by path", () => {
  const request = jevReplyRequest({ sentences, readable });
  assert.deepEqual(request.asked, [1, 2], "S0 names a medicine; S3 cites nothing readable");
  assert.deepEqual(request.medicine, [0]);
  assert.deepEqual(Object.keys(request.state.items), ["S1", "S2"]);
  assert.deepEqual(request.state.items.S2, { sentence: sentences[2].sentence, sources: { "[2]": readable.get(2), "[3]": readable.get(3) } });
  assert.deepEqual(Object.keys(request.questions), ["S1", "S2"]);
  const question = request.questions.S2;
  assert.equal(question.type, "choice");
  assert.match(question.instructions, /`items\.S2\.sources`.*`items\.S2\.sentence`/);
  assert.match(question.instructions, /judge meaning, not wording/);
  // The measured criteria: every number in the sentence must be stated.
  assert.deepEqual(Object.keys(question.criteria), ["supports", "contradicts", "says_nothing"]);
  assert.match(JEV_RELATION_CRITERIA.supports, /including every number/);
  assert.match(JEV_RELATION_CRITERIA.contradicts, /different number, direction or recommendation/);
});

test("when Jev is sure of every sentence it may settle, the reviewer sees only the one naming a medicine", async () => {
  const spy = reviewerSpy();
  const { jev, requests } = jevAnswering({ S1: SURE, S2: SURE });
  const judged = await judgeCitedSentences({ sentences, references, readable, threshold: 0.8, jev, reviewer: spy.reviewer });
  assert.equal(requests.length, 1, "one Jev request per reply");
  assert.deepEqual(spy.asked.map((input) => input.sentences.map((/** @type {any} */ sentence) => sentence.index)), [[0, 3]]);
  const bySentence = new Map(judged.verdicts.map((verdict) => [verdict.sentence, verdict]));
  assert.deepEqual(bySentence.get(1), { sentence: 1, verdict: "supported", reason: "", evidence: "", safety: "none", by: "jev", confidence: 0.97 });
  assert.equal(bySentence.get(2).by, "jev");
  assert.equal(bySentence.get(0).by, undefined, "the medicine sentence is the reviewer's");
  assert.equal(bySentence.get(0).safety, "consistent");
  assert.equal(bySentence.get(3).verdict, "unresolvable");
  assert.deepEqual(judged.verdicts.map((verdict) => verdict.sentence), [0, 1, 2, 3]);
  assert.deepEqual(judged.models, ["jev-1.13.0", "qwen3.8-max-0902"]);
  assert.equal(judged.cost, 0.0101);
  assert.deepEqual(judged.jev, { outcome: "answered", code: null, asked: 2, decided: 2, escalated: 0, medicine: 1 });
});

test("with no medicine and every sentence settled by Jev, the reviewer is not called at all", async () => {
  const plain = sentences.filter((sentence) => sentence.index === 1 || sentence.index === 2);
  const spy = reviewerSpy();
  const judged = await judgeCitedSentences({ sentences: plain, references, readable, threshold: 0.8, jev: jevAnswering({ S1: SURE, S2: SURE }).jev, reviewer: spy.reviewer });
  assert.equal(spy.asked.length, 0);
  assert.deepEqual(judged.verdicts.map((verdict) => [verdict.sentence, verdict.verdict, verdict.by]), [[1, "supported", "jev"], [2, "supported", "jev"]]);
  assert.deepEqual(judged.models, ["jev-1.13.0"]);
});

test("a sentence Jev is unsure of, or thinks unsupported, goes to the reviewer, and only those sentences do", async () => {
  const spy = reviewerSpy();
  const judged = await judgeCitedSentences({ sentences, references, readable, threshold: 0.8, jev: jevAnswering({ S1: UNSURE, S2: SURE }).jev, reviewer: spy.reviewer });
  assert.deepEqual(spy.asked[0].sentences.map((/** @type {any} */ sentence) => sentence.index), [0, 1, 3]);
  assert.deepEqual(spy.asked[0].references.map((/** @type {any} */ reference) => reference.number), [1, 2, 4], "the sources those sentences cite, and no others");
  // The reviewer's message names only its own sentences, under their own numbers.
  const message = replyMessage({ sentences: spy.asked[0].sentences, references: spy.asked[0].references, readable });
  assert.match(message, /S0（涉药） 引用 \[1\]/);
  assert.match(message, /S1 引用 \[2\]/);
  assert.doesNotMatch(message, /S2 /);
  assert.doesNotMatch(message, /hs-cTn/, "a source only the settled sentence cites is not sent");
  assert.equal(judged.verdicts.find((verdict) => verdict.sentence === 1).by, undefined);
  assert.equal(judged.verdicts.find((verdict) => verdict.sentence === 2).by, "jev");
  assert.deepEqual(judged.jev, { outcome: "answered", code: null, asked: 2, decided: 1, escalated: 1, medicine: 1 });

  const against = reviewerSpy();
  await judgeCitedSentences({ sentences, references, readable, threshold: 0.8, jev: jevAnswering({ S1: AGAINST, S2: SURE }).jev, reviewer: against.reviewer });
  assert.deepEqual(against.asked[0].sentences.map((/** @type {any} */ sentence) => sentence.index), [0, 1, 3], "a ⚠ needs the reviewer's quote; Jev gives none");
});

test("a medicine sentence is never put to Jev, whatever it would have said", async () => {
  const { jev, requests } = jevAnswering({ S0: SURE, S1: SURE, S2: SURE });
  const spy = reviewerSpy();
  const judged = await judgeCitedSentences({ sentences, references, readable, threshold: 0.8, jev, reviewer: spy.reviewer });
  assert.equal("S0" in requests[0].questions, false);
  assert.equal("S0" in requests[0].state.items, false);
  assert.deepEqual(spy.asked[0].sentences.map((/** @type {any} */ sentence) => sentence.index), [0, 3]);
  assert.equal(judged.verdicts[0].by, undefined);
});

test("Jev failing, refusing or over its ceiling hands every sentence to the reviewer, as before Jev", async () => {
  for (const [code, outcome] of [["jev_rate_limited", "failed"], ["jev_auth_failed", "failed"], ["jev_request_too_large", "too_large"]]) {
    const spy = reviewerSpy();
    const judged = await judgeCitedSentences({
      sentences, references, readable, threshold: 0.8,
      jev: async () => { throw Object.assign(new Error("no"), { code }); },
      reviewer: spy.reviewer,
    });
    assert.deepEqual(spy.asked[0].sentences.map((/** @type {any} */ sentence) => sentence.index), [0, 1, 2, 3], code);
    assert.equal(judged.verdicts.every((verdict) => verdict.by === undefined), true);
    assert.deepEqual(judged.jev, { outcome, code, asked: 2, decided: 0, escalated: 0, medicine: 1 });
    assert.deepEqual(judged.models, ["qwen3.8-max-0902"]);
  }
  // Switched off: the reviewer judges everything and Jev is not mentioned.
  const off = reviewerSpy();
  const judged = await judgeCitedSentences({ sentences, references, readable, threshold: 0.8, jev: null, reviewer: off.reviewer });
  assert.deepEqual(off.asked[0].sentences.map((/** @type {any} */ sentence) => sentence.index), [0, 1, 2, 3]);
  assert.equal(judged.jev.outcome, "off");
});

test("the gate: confident support at the threshold settles, below it escalates, and an answer that disagrees with itself decides nothing", () => {
  const asked = [1, 2, 3, 4, 5, 6];
  const answers = {
    S1: choice({ supports: 0.8667, contradicts: 0.0667, says_nothing: 0.0666 }), // confidence 0.80
    S2: choice({ supports: 0.86, contradicts: 0.07, says_nothing: 0.07 }), // 0.79
    // Reported 0.99, but its own probabilities give 0.64: code believes the probabilities.
    S3: { type: "choice", choice: "supports", confidence: 0.99, probabilities: { supports: 0.76, contradicts: 0.02, says_nothing: 0.22 } },
    // Reported choice is not the probabilities' maximum.
    S4: { type: "choice", choice: "supports", confidence: 0.96, probabilities: { supports: 0.02, contradicts: 0.97, says_nothing: 0.01 } },
    // A score or a noul is not the question that was asked.
    S5: { type: "noul", noul: 0.99 },
    // Missing entirely.
  };
  const { decided, escalated } = jevDecisions(answers, { asked, threshold: 0.8 });
  assert.deepEqual([...decided.keys()], [1]);
  assert.equal(decided.get(1), 0.8);
  assert.deepEqual(escalated, [2, 3, 4, 5, 6]);
  // A gate of zero or nonsense settles nothing rather than everything.
  assert.equal(jevDecisions({ S1: SURE }, { asked: [1], threshold: Number.NaN }).decided.size, 0);
  assert.equal(jevDecisions({ S1: SURE }, { asked: [1], threshold: 0 }).decided.size, 0);
});

test("nothing Jev may settle means no Jev request", async () => {
  const onlyMedicine = sentences.filter((sentence) => sentence.index === 0);
  const { jev, requests } = jevAnswering({});
  const spy = reviewerSpy();
  const judged = await judgeCitedSentences({ sentences: onlyMedicine, references, readable, threshold: 0.8, jev, reviewer: spy.reviewer });
  assert.equal(requests.length, 0);
  assert.equal(spy.asked.length, 1);
  assert.equal(judged.jev.outcome, "none");
  // Nothing readable at all: neither model is called; code says unresolvable.
  const unreadable = sentences.filter((sentence) => sentence.index === 3);
  const none = reviewerSpy();
  const quiet = await judgeCitedSentences({ sentences: unreadable, references, readable, threshold: 0.8, jev: jevAnswering({}).jev, reviewer: none.reviewer });
  assert.equal(none.asked.length, 0);
  assert.deepEqual(quiet.verdicts.map((verdict) => verdict.verdict), ["unresolvable"]);
});

test("the first pass is counted as soon as it ends, even when the reviewer then fails", async () => {
  /** @type {any[]} */
  const heard = [];
  await assert.rejects(judgeCitedSentences({
    sentences, references, readable, threshold: 0.8,
    jev: jevAnswering({ S1: SURE, S2: UNSURE }).jev,
    reviewer: async () => { throw Object.assign(new Error("reviewer down"), { code: "review_model_unreachable" }); },
    onJev: (summary) => heard.push(summary),
  }), (error) => /** @type {any} */ (error).code === "review_model_unreachable", "a reviewer failure is still the check's failure");
  assert.deepEqual(heard, [{ outcome: "answered", code: null, asked: 2, decided: 1, escalated: 1, medicine: 1 }], "the Jev call was spent and is counted");
  // Off: nothing to hear.
  const quiet = [];
  await judgeCitedSentences({ sentences, references, readable, threshold: 0.8, jev: null, reviewer: reviewerSpy().reviewer, onJev: (summary) => quiet.push(summary) });
  assert.deepEqual(quiet, []);
});

