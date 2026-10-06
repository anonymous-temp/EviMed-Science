// 「循证传播」's judge against the cards (flywheel F21): the verified card claims are what an answer is held to, the specified
// information (indication, dosage, contraindication, adverse reaction) is judged first, the three checks — beyond the label, safety
// left out, what a cited link says — are re-verified by what code can decide, and every verdict records the card revision it was judged
// against, from the claim and not from the model.
import assert from "node:assert/strict";
import test from "node:test";
import { geoSpecifiedInfoAccuracy } from "@evimed/domain";
import { GEO_JUDGE_INSTRUCTIONS, GEO_JUDGE_VERSION, GeoJudge, buildJudgeInput, checkCitationLinks, verifyJudgement } from "../src/geoJudge.mjs";

const product = { brandName: "信尔美", genericName: "玛仕度肽注射液", aliases: [], rx: "rx" };
const claims = [
  { id: "gcl_dose", key: "dose", statement: "起始剂量为每周一次 2.5 mg", quote: "成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg。", sourceKind: "label", inLabel: true, cardId: "ec_AbCd1234Ef", cardClaimId: "dose", cardRevision: 3 },
  { id: "gcl_contra", key: "contra", statement: "对本品过敏者禁用", quote: "对本品活性成分或辅料过敏者禁用。", sourceKind: "label", inLabel: true, cardId: "ec_AbCd1234Ef", cardClaimId: "contra", cardRevision: 3 },
  { id: "gcl_trial", key: "trial", statement: "第 48 周体重下降 14.1%", quote: "participants lost 14.1% of body weight at week 48", sourceKind: "trial", inLabel: false, cardId: "ec_Other56789", cardClaimId: "weight", cardRevision: 1 },
];
const input = (/** @type {string} */ answer, extra = {}) => ({
  owner: { userId: "u", projectId: "p" }, product, competitors: [], claims, careFlags: [],
  question: { text: "信尔美怎么用", pool: "P2", journeyStage: "治疗选择" }, answer,
  links: [{ url: "https://example.org/a", title: "某医学网" }, { url: "https://example.org/b", title: "另一页" }], ...extra,
});

test("the judge is told the order of importance: the specified information first, then the three checks, then visibility and coverage", () => {
  const text = GEO_JUDGE_INSTRUCTIONS;
  const at = (/** @type {string} */ word) => text.indexOf(word);
  assert.ok(at("1. statements") < at("2. offLabel") && at("2. offLabel") < at("3. omittedSafety") && at("3. omittedSafety") < at("4. citationClaims"));
  assert.ok(at("4. citationClaims") < at("5. refusal") && at("5. refusal") < at("6. entities") && at("6. entities") < at("7. recommendations"));
  for (const topic of ["indication", "dosage", "contraindication", "adverse_reaction"]) assert.match(text, new RegExp(topic));
  assert.match(GEO_JUDGE_VERSION, /^geo-judge-1\.[0-9a-f]{8}$/, "the version follows the instructions, so a verdict says which instructions made it");
});

test("a project's claims are shown with whether each is the label's, and the answer's links with ids", () => {
  const built = buildJudgeInput(input("信尔美每周一次。"));
  const shown = JSON.parse(built.prefix.slice(built.prefix.indexOf("{")));
  assert.deepEqual(shown.claims.map((claim) => [claim.id, claim.label]), [["C1", true], ["C2", true], ["C3", false]]);
  assert.deepEqual(built.links.map((link) => [link.id, link.url]), [["L1", "https://example.org/a"], ["L2", "https://example.org/b"]]);
  assert.ok(built.item.includes('"L1"'));
});

test("each verdict records the card, the card claim and the card revision it was judged against — from the claim, never from the model", () => {
  const answer = "信尔美起始剂量为每周一次 2.5 mg。信尔美对活性成分过敏者禁用。信尔美治疗后体重下降 14.1%。信尔美每天注射一次。";
  const built = buildJudgeInput(input(answer));
  const verdict = verifyJudgement({
    statements: [
      { text: "信尔美起始剂量为每周一次 2.5 mg", topic: "dosage", verdict: "correct", claim: "C1", evidence: "成人推荐起始剂量为每周一次 2.5 mg",
        cardRevision: 99, cardId: "ec_Invented" },
      { text: "信尔美对活性成分过敏者禁用", topic: "contraindication", verdict: "correct", claim: "C2", evidence: "对本品活性成分或辅料过敏者禁用" },
      { text: "信尔美治疗后体重下降 14.1%", topic: "nonsense", verdict: "correct", claim: "C3", evidence: "lost 14.1% of body weight" },
      { text: "信尔美每天注射一次", topic: "dosage", verdict: "wrong", claim: "C1", evidence: "每周一次 2.5 mg", errorType: "number", severity: "S3" },
    ],
  }, built, input(answer));
  assert.deepEqual(verdict.statements.map((statement) => [statement.topic, statement.verdict, statement.cardId, statement.cardClaimId, statement.cardRevision]), [
    ["dosage", "correct", "ec_AbCd1234Ef", "dose", 3],
    ["contraindication", "correct", "ec_AbCd1234Ef", "contra", 3],
    ["other", "correct", "ec_Other56789", "weight", 1],
    ["dosage", "wrong", "ec_AbCd1234Ef", "dose", 3],
  ], "a topic outside the closed list is 其他; the card fields are the claim's, whatever the model wrote");
});

test("指定信息正确率 is computed in code from the verdicts of the four specified topics, leaving out what could not be decided", () => {
  const accuracy = geoSpecifiedInfoAccuracy([
    { topic: "dosage", verdict: "correct" }, { topic: "dosage", verdict: "wrong" }, { topic: "indication", verdict: "correct" },
    { topic: "contraindication", verdict: "unverifiable" }, { topic: "other", verdict: "wrong" }, { topic: "adverse_reaction", verdict: "correct" },
  ]);
  assert.deepEqual([accuracy.correct, accuracy.wrong, accuracy.decided], [3, 1, 4]);
  assert.equal(accuracy.rate, 0.75);
  assert.deepEqual(accuracy.byTopic.dosage, { correct: 1, wrong: 1 });
  assert.equal(geoSpecifiedInfoAccuracy([{ topic: "contraindication", verdict: "unverifiable" }]).rate, null, "nothing decided is not a zero");
  assert.equal(geoSpecifiedInfoAccuracy([]).rate, null);
});

test("beyond-the-label sentences must be in the answer, omitted safety must be a label claim that was shown, a cited statement must be in the answer and name a listed link", () => {
  const answer = "信尔美也可以用于青少年减重。信尔美每周一次，来自某医学网。";
  const verdict = verifyJudgement({
    statements: [],
    offLabel: ["信尔美也可以用于青少年减重", "信尔美可以治疗脂肪肝"],
    omittedSafety: ["C2", "C3", "C9"],
    citationClaims: [
      { link: "L1", statement: "信尔美每周一次" },
      { link: "L7", statement: "信尔美每周一次" },
      { link: "L2", statement: "回答里没有的一句" },
    ],
  }, buildJudgeInput(input(answer)), input(answer));
  assert.deepEqual(verdict.checks.offLabel, ["信尔美也可以用于青少年减重"], "a sentence the answer does not contain is dropped");
  assert.deepEqual(verdict.checks.omittedSafety.map((entry) => [entry.claimId, entry.cardClaimId, entry.cardRevision]), [["gcl_contra", "contra", 3]],
    "C3 is a trial claim, not the label's; C9 was never shown");
  assert.deepEqual(verdict.checks.citations, [{ link: "L1", url: "https://example.org/a", statement: "信尔美每周一次", exists: null, supports: null, evidence: null }]);
  assert.deepEqual(verdict.dropped.map((entry) => `${entry.what}:${entry.reason}`).sort(), [
    "citation_claim:link_unknown", "citation_claim:statement_not_in_answer", "off_label:not_in_answer", "omitted_safety:claim_not_label", "omitted_safety:claim_unknown",
  ]);
});

/** A judge whose model answers what the test says. @param {(request: any) => any} reply */
function judgeWith(reply) {
  return new GeoJudge({ deepseekProviderEnabled: true, deepseekApiKey: "k" }, {
    callModel: async (_deps, request) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply(request)) } }] }),
  });
}

test("what a cited page says: the quotation must be in the page's text, or the verdict is dropped to unclear", async () => {
  const page = "本品为每周一次的皮下注射制剂，起始剂量为 2.5 mg。常见不良反应为恶心。";
  const supports = judgeWith(() => ({ supports: "yes", evidence: "每周一次的皮下注射制剂" }));
  assert.deepEqual(await supports.judgeCitation({ owner: { userId: "u", projectId: "p" }, statement: "信尔美每周一次", pageText: page }),
    { supports: "yes", evidence: "每周一次的皮下注射制剂", dropped: null });
  const invented = judgeWith(() => ({ supports: "no", evidence: "页面写的是每天一次" }));
  assert.deepEqual(await invented.judgeCitation({ owner: { userId: "u", projectId: "p" }, statement: "信尔美每周一次", pageText: page }),
    { supports: "unclear", evidence: null, dropped: "evidence_not_in_page" });
  const odd = judgeWith(() => ({ supports: "maybe", evidence: "" }));
  assert.equal((await odd.judgeCitation({ owner: { userId: "u", projectId: "p" }, statement: "x", pageText: page })).supports, "unclear");
});

test("a link that does not exist is recorded as missing, one nobody could read stays unchecked, and with no checker nothing is claimed", async () => {
  const make = () => ({ offLabel: [], omittedSafety: [], citations: [
    { link: "L1", url: "https://example.org/gone", statement: "信尔美每周一次", exists: null, supports: null, evidence: null },
    { link: "L2", url: "https://example.org/blocked", statement: "信尔美每周一次", exists: null, supports: null, evidence: null },
    { link: "L3", url: "https://example.org/page", statement: "信尔美每周一次", exists: null, supports: null, evidence: null },
  ] });
  const counts = { linkExists: 0, linkMissing: 0, linkUnreadable: 0, linkSupports: 0, linkContradicts: 0, linkUnclear: 0, linkJudgeFailed: 0 };
  const checks = make();
  const judge = judgeWith(() => ({ supports: "yes", evidence: "每周一次" }));
  await checkCitationLinks({ checks, judge, owner: { userId: "u", projectId: "p" }, counts,
    linkChecker: async (url) => {
      if (url.endsWith("gone")) return { exists: false };
      if (url.endsWith("blocked")) throw Object.assign(new Error("robots"), { code: "web_read_robots_disallowed" });
      return { exists: true, text: "本品每周一次皮下注射。" };
    } });
  assert.deepEqual(checks.citations.map((entry) => [entry.exists, entry.supports]), [[false, null], [null, null], [true, "yes"]]);
  assert.deepEqual(counts, { linkExists: 1, linkMissing: 1, linkUnreadable: 1, linkSupports: 1, linkContradicts: 0, linkUnclear: 0, linkJudgeFailed: 0 });
  const unchecked = make();
  await checkCitationLinks({ checks: unchecked, judge, linkChecker: null, owner: { userId: "u", projectId: "p" }, counts });
  assert.deepEqual(unchecked, make(), "without a checker no citation is called good or bad");
  // At most three links are followed for one answer, each a page read and a model call.
  const many = { offLabel: [], omittedSafety: [], citations: Array.from({ length: 5 }, (_u, index) => ({ link: `L${index + 1}`, url: `https://example.org/${index}`, statement: "s", exists: null, supports: null, evidence: null })) };
  let reads = 0;
  await checkCitationLinks({ checks: many, judge, owner: { userId: "u", projectId: "p" }, counts, linkChecker: async () => { reads += 1; return { exists: true }; } });
  assert.equal(reads, 3);
});
