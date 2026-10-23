import assert from "node:assert/strict";
import test from "node:test";
import { computeGeoMetrics } from "@evimed/domain";
import { brandRegistry, failureMode, parseAnswer } from "../src/geoParse.mjs";
import { buildJudgeInput, GEO_JUDGE_ANSWER_CHARS, readQuantities, recountedFacts, verifyJudgement } from "../src/geoJudge.mjs";

const product = { brandName: "康舒宁", genericName: "示例成分片", genericAliases: ["示例成分"], singleSource: true };
const competitors = [{ brandName: "康舒安", genericName: "另一成分片" }];
const registry = brandRegistry(product, competitors);
const complete = { status: "complete", reasons: [], answerChars: 20, assessedChars: 20 };
const inputOf = (answer) => ({
  owner: { userId: "u", projectId: "p" }, product, competitors, careFlags: [], question: { text: "如何选择？", pool: "P2" }, answer,
  claims: [{ id: "c1", statement: "用于成人患者", quote: "本品用于成人患者。" }],
});
const correct = { text: "康舒宁用于成人患者。", verdict: "correct", claim: "C1", evidence: "本品用于成人患者。" };
const judged = (answer, extra = {}) => {
  const input = inputOf(answer);
  return verifyJudgement({ assessmentComplete: true, statements: [], recommendations: [], ...extra }, buildJudgeInput(input), input);
};
const metric = (rows, id) => computeGeoMetrics(rows, { scopes: ["project"] }).cells.find((cell) => cell.metricId === id && cell.variant === null);
const row = (facts, i = 0) => ({ snapshotId: `s${i}`, questionId: `q${i}`, engine: "deepseek", status: "valid", pool: "P2", facts });

test("list structure never creates a recommendation from negative, conditional, comparison or care-seeking text", () => {
  for (const answer of [
    "1. 不推荐使用康舒宁，必须由医生评估。",
    "- 康舒宁并非所有人都适用。",
    "1. 如果医生确认适用，再评估是否使用康舒宁。",
    "1. 康舒宁与康舒安的适用条件不同。",
    "1. 对康舒宁成分过敏者禁用。",
    "1. 使用康舒宁后若出现不适，应及时就医。",
  ]) {
    const facts = parseAnswer({ answer, registry });
    assert.equal(facts.mentionsOurs, true, answer);
    assert.equal(facts.positionOurs, 1, answer);
    assert.equal(facts.recommendedOurs, false, answer);
  }
});

test("semantic recommendation entities anchor only the recommended product in a comparison sentence", () => {
  const answer = "1. 对符合条件的患者可考虑康舒安，不建议自行使用康舒宁。";
  const reading = judged(answer, { recommendations: [{ text: answer, entities: ["康舒安"] }] });
  const facts = parseAnswer({ answer, registry, recommendations: reading.recommendations });
  assert.equal(facts.recommendedOurs, false);
  assert.equal(facts.brands.find((brand) => brand.competitor)?.inRecommendation, true);
  const positive = "医生评估符合条件后可考虑康舒宁。";
  assert.equal(parseAnswer({ answer: positive, registry, recommendations: judged(positive, { recommendations: [{ text: positive, entities: ["康舒宁"] }] }).recommendations }).recommendedOurs, true);
});

test("recommendations must have an actual span and a referenced registered or extracted entity", () => {
  const answer = "康舒宁用于成人患者。";
  const reading = judged(answer, { recommendations: [
    { text: "推荐康舒宁", entities: ["康舒宁"] },
    { text: answer, entities: ["康舒安"] },
    { text: answer, entities: ["成人患者"] },
  ] });
  assert.deepEqual(reading.recommendations, []);
  assert.equal(parseAnswer({ answer, registry, recommendations: [{ text: "推荐康舒宁", entities: ["康舒宁"] }] }).recommendedOurs, false);
});

test("single-source generic presence and product attribution never become literal brand presence", () => {
  const facts = parseAnswer({ answer: "示例成分片含有示例成分。", registry });
  assert.equal(facts.mentionsOurs, false);
  assert.equal(facts.brands.length, 0);
  assert.deepEqual(facts.genericMentions, [{ name: "康舒宁", ours: true, competitor: false, count: 2, matchedNames: ["示例成分片", "示例成分"], productAttributed: true }]);
  const multi = parseAnswer({ answer: "示例成分片。", registry: brandRegistry({ ...product, singleSource: false }, competitors) });
  assert.equal(multi.mentionsOurs, false);
  assert.equal(multi.genericMentions[0].productAttributed, false);
  const both = parseAnswer({ answer: "康舒宁（示例成分片）", registry });
  assert.equal(both.brands[0].count, 1);
  assert.equal(both.genericMentions[0].count, 1);
  const coverage = metric([row({ ...facts, checks: { judgementCoverage: complete }, judgeExtract: { entityMentions: facts.entityMentions } })], "M-04C");
  assert.deepEqual([coverage.numerator, coverage.denominator, coverage.value], [0, 2, 0], "generics remain identifiable drug entities");
  const shared = parseAnswer({ answer: "示例成分片。", registry: brandRegistry({ ...product, singleSource: false }, [{ brandName: "竞例牌", genericName: "示例成分片" }]) });
  assert.equal(shared.entityMentions, 1, "shared generic attribution must not double-count one occurrence");
});

test("accuracy requires all applicable statements and complete coverage; known wrong takes priority", () => {
  const classify = (statements, checks = { judgementCoverage: complete }) => failureMode({ status: "valid", mentionsOurs: true, statements, checks });
  assert.equal(classify([]), "unknown");
  assert.equal(classify([{ verdict: "unverifiable" }]), "unknown");
  assert.equal(classify([{ verdict: "correct" }, { verdict: "unverifiable" }]), "partial");
  assert.equal(classify([{ verdict: "correct" }, {}]), "partial");
  assert.equal(classify([{ verdict: "correct" }], {}), "unknown");
  assert.equal(classify([{ verdict: "correct" }], { answerCut: { chars: 9000, shown: 8000 } }), "partial");
  assert.equal(classify([{ verdict: "wrong" }, { verdict: "unverifiable" }], {}), "wrong_ours");
  assert.equal(classify([{ verdict: "correct" }]), "correct");
});

test("M-06 counts answers rather than statements and does not inflate mixed known and unknown answers", () => {
  const facts = (statements, checks = { judgementCoverage: complete }) => ({ statements, checks });
  const cases = [facts([correct]), facts([correct, correct, { text: "unknown", verdict: "unverifiable" }]),
    facts([{ text: "wrong", verdict: "wrong" }, { text: "unknown", verdict: "unverifiable" }]), facts([correct], {})];
  const cell = metric(cases.map(row), "M-06");
  assert.deepEqual([cell.numerator, cell.denominator, cell.value], [1, 2, 50]);
  assert.deepEqual(cell.assessment, { methodVersion: "geo-measurement-2", completeAnswers: 3, partialAnswers: 0, unknownAnswers: 1, decidableAnswers: 2 });
  const onlyMixed = metric([row(cases[1])], "M-06");
  assert.equal(onlyMixed.value, null);
  assert.equal(onlyMixed.reason, "not_adjudicated");
});

test("a verified wrong answer remains decidable while its unassessed tail remains partial coverage", () => {
  const cell = metric([row({ statements: [{ text: "Known error.", verdict: "wrong" }],
    checks: { judgementCoverage: { status: "partial", reasons: ["answer_truncated"], answerChars: 9000, assessedChars: 8000 } } })], "M-06");
  assert.deepEqual([cell.numerator, cell.denominator, cell.value], [0, 1, 0]);
  assert.deepEqual(cell.assessment, { methodVersion: "geo-measurement-2", completeAnswers: 0, partialAnswers: 1, unknownAnswers: 0, decidableAnswers: 1 });
});

test("a cut answer retains complete literal counts but cannot claim complete judgement or accuracy", () => {
  const answer = `${correct.text}${"正文。".repeat(GEO_JUDGE_ANSWER_CHARS)}康舒安可用于所有人。`;
  const reading = judged(answer, { statements: [correct] });
  assert.deepEqual(reading.checks.judgementCoverage, { status: "partial", reasons: ["answer_truncated"], answerChars: answer.length, assessedChars: GEO_JUDGE_ANSWER_CHARS });
  const facts = { ...parseAnswer({ answer, registry }), statements: reading.statements, checks: reading.checks };
  assert.equal(facts.brands.length, 2);
  assert.equal(metric([row(facts)], "M-06").value, null);
  assert.equal(metric([row(facts)], "M-03").value, null);
  assert.equal(metric([row(facts)], "M-01").value, 100);
});

test("partial entity extraction cannot certify complete brand registry coverage or share of voice", () => {
  const answer = `${correct.text}${"背景".repeat(4500)}末尾还提及未登记的其他产品。`;
  const reading = judged(answer, { statements: [correct], entities: [] });
  const parsed = parseAnswer({ answer, registry, entities: reading.entities });
  const facts = { ...parsed, checks: reading.checks, statements: reading.statements, judgeExtract: { entityMentions: parsed.entityMentions } };
  assert.equal(metric([row(facts)], "M-01").value, 100);
  for (const id of ["M-04C", "M-04"]) {
    const cell = metric([row(facts)], id);
    assert.equal(cell.value, null, id);
    assert.equal(cell.reason, "entity_extraction_incomplete", id);
    assert.deepEqual([cell.numerator, cell.denominator], [1, 1], "observed counts survive without claiming full coverage");
    assert.deepEqual(cell.assessment, { methodVersion: "geo-measurement-2", completeAnswers: 0, partialAnswers: 1, unknownAnswers: 0 });
  }
});

test("dropped statements, missing completeness, or a reached extraction limit never claim complete coverage", () => {
  assert.equal(judged(correct.text, { statements: [correct] }).checks.judgementCoverage.status, "complete");
  assert.equal(judged(correct.text, { assessmentComplete: undefined, statements: [correct] }).checks.judgementCoverage.status, "unknown");
  assert.equal(judged(correct.text, { statements: [correct, { ...correct, text: "not in answer" }] }).checks.judgementCoverage.status, "partial");
  assert.equal(judged(correct.text, { statements: Array.from({ length: 30 }, () => correct) }).checks.judgementCoverage.status, "partial");
});

test("list numbering is structural, while decimal doses remain clinical quantities", () => {
  for (const marker of ["1. ", "２、", "(3) ", "四、", "- "]) {
    const text = `${marker}${correct.text}`;
    const reading = judged(text, { statements: [{ ...correct, text }] });
    assert.equal(reading.statements[0]?.verdict, "correct", marker);
    assert.equal(reading.checks.judgementCoverage.status, "complete", marker);
  }
  assert.deepEqual([...readQuantities("1.5 mg").tokens], ["1.5mg"]);
  assert.deepEqual([...readQuantities("1. 1.5 mg").tokens], ["1.5mg"]);
});

test("legacy recommendation booleans and correct statements are preserved as history, never upgraded to new complete facts", () => {
  const old = { answerText: "1. 不推荐康舒宁。", citations: [], status: "valid", statements: [correct], judgeExtract: null,
    parserVersion: "geo-parse-1+geo-judge-1.old", brands: [{ name: "康舒宁", ours: true, inRecommendation: true, count: 1 }] };
  const recounted = recountedFacts(old, registry, {});
  assert.equal(recounted.recommendedOurs, false);
  assert.equal(recounted.failureMode, "unknown");
  assert.equal(recounted.checks.judgementCoverage.status, "unknown");
  assert.equal(recounted.parserVersion, "geo-parse-2+geo-judge-1.old");
  assert.equal(recounted.judgeExtract.sourceParserVersion, old.parserVersion);
});
