// The tracker facts (frontierTrackFacts.mjs): what the model's answer becomes once code has looked every quotation up in the text it
// was shown — approvals and guidelines — and what is never stored.
import assert from "node:assert/strict";
import test from "node:test";
import {
  FRONTIER_TRACK_FACTS_VERSION,
  buildTrackInput,
  frontierExtractTrackFacts,
  frontierQuoteSaysDate,
  frontierTrackFactsView,
  frontierTrackInstructions,
  verifyApprovalFacts,
  verifyGuidelineFacts,
} from "../src/frontierTrackFacts.mjs";

const BASIS = "a".repeat(64);

/** What the model is shown for a text. @param {string} text @param {Record<string, any>} [extra] */
function shown(text, extra = {}) {
  return buildTrackInput({ sourceName: "Merck news", date: "2026-10-21", titleRaw: "European Commission Approves KEYTRUDA", text, kind: "excerpt", ...extra });
}

const KEYTRUDA = "European Commission Approves KEYTRUDA (pembrolizumab) Plus Padcev. October 21, 2026 6:45 am EDT. The European Commission (EC) has approved KEYTRUDA in combination with Padcev as neoadjuvant treatment for adults with resectable muscle-invasive bladder cancer (MIBC). In the trial 397 patients were enrolled.";

/** @param {Record<string, any>} [overrides] */
const approvalAnswer = (overrides = {}) => ({
  decision: true, approval: "new-indication",
  agency: { key: "ec", quote: "The European Commission (EC) has approved KEYTRUDA" },
  drug: { text: "KEYTRUDA（pembrolizumab）", quote: "KEYTRUDA (pembrolizumab) Plus Padcev" },
  indication: { text: "可切除肌层浸润性膀胱癌成人的围手术期治疗", quote: "adults with resectable muscle-invasive bladder cancer (MIBC)" },
  date: { value: "2026-10-21", quote: "October 21, 2026 6:45 am EDT" },
  ...overrides,
});

test("an approval answer whose quotations are all in the text is stored with each field anchored", () => {
  const { facts, dropped } = verifyApprovalFacts(approvalAnswer(), { input: shown(KEYTRUDA), publishedDay: "2026-10-21", basis: BASIS });
  assert.deepEqual(dropped, []);
  assert.equal(facts.kind, "approval");
  assert.equal(facts.approval, "new-indication");
  assert.equal(facts.basis, BASIS);
  assert.equal(facts.version, FRONTIER_TRACK_FACTS_VERSION);
  assert.deepEqual(facts.agency, { key: "ec", label: "欧盟委员会", from: "text", quote: "The European Commission (EC) has approved KEYTRUDA" });
  assert.equal(facts.drug.quote, "KEYTRUDA (pembrolizumab) Plus Padcev");
  assert.equal(facts.date.value, "2026-10-21");
});

test("a text that is no decision is stored as none, so it is not asked again; a decision on no named product is none too", () => {
  const input = shown(KEYTRUDA);
  assert.equal(verifyApprovalFacts({ decision: false }, { input, basis: BASIS }).facts.none, true);
  assert.equal(verifyApprovalFacts(null, { input, basis: BASIS }).facts.none, true);
  const noDrug = verifyApprovalFacts(approvalAnswer({ drug: { text: "Imaginarium", quote: "Imaginarium was approved" } }), { input, basis: BASIS });
  assert.equal(noDrug.facts.none, true);
  assert.deepEqual(noDrug.dropped, [{ key: "drug", reason: "verbatim" }]);
});

test("a field whose quotation is not in the text is null and the rest of the record stands", () => {
  const { facts, dropped } = verifyApprovalFacts(approvalAnswer({ indication: { text: "成人尿路上皮癌", quote: "adults with urothelial carcinoma" } }), { input: shown(KEYTRUDA), publishedDay: "2026-10-21", basis: BASIS });
  assert.equal(facts.indication, null);
  assert.ok(facts.drug);
  assert.deepEqual(dropped, [{ key: "indication", reason: "verbatim" }]);
});

test("a quotation is compared after white space and notation are made one, so a wrapped or full-width quotation is found", () => {
  const { facts } = verifyApprovalFacts(approvalAnswer({ drug: { text: "KEYTRUDA", quote: "KEYTRUDA （pembrolizumab）  Plus\nPadcev" } }), { input: shown(KEYTRUDA), publishedDay: "2026-10-21", basis: BASIS });
  assert.ok(facts.drug);
});

test("a number in the Chinese words that the text does not have drops the field", () => {
  const { facts, dropped } = verifyApprovalFacts(approvalAnswer({ indication: { text: "成人 500 例可切除肌层浸润性膀胱癌", quote: "adults with resectable muscle-invasive bladder cancer (MIBC)" } }),
    { input: shown(KEYTRUDA), publishedDay: "2026-10-21", basis: BASIS });
  assert.equal(facts.indication, null);
  assert.deepEqual(dropped, [{ key: "indication", reason: "number" }]);
  // A number the text has passes.
  const kept = verifyApprovalFacts(approvalAnswer({ indication: { text: "397 例成人可切除肌层浸润性膀胱癌", quote: "In the trial 397 patients were enrolled" } }),
    { input: shown(KEYTRUDA), publishedDay: "2026-10-21", basis: BASIS });
  assert.ok(kept.facts.indication);
});

test("a link or English prose where Chinese is asked drops the field", () => {
  const input = shown(KEYTRUDA);
  const link = verifyApprovalFacts(approvalAnswer({ indication: { text: "见 https://example.org/x 的适应症", quote: "adults with resectable muscle-invasive bladder cancer (MIBC)" } }), { input, publishedDay: "2026-10-21", basis: BASIS });
  assert.deepEqual(link.dropped, [{ key: "indication", reason: "link" }]);
  const english = verifyApprovalFacts(approvalAnswer({ indication: { text: "adults with resectable bladder cancer", quote: "adults with resectable muscle-invasive bladder cancer (MIBC)" } }), { input, publishedDay: "2026-10-21", basis: BASIS });
  assert.deepEqual(english.dropped, [{ key: "indication", reason: "language" }]);
});

test("a regulator's own feed names its agency in code and the model's answer for it is not used", () => {
  const { facts } = verifyApprovalFacts(approvalAnswer({ agency: { key: "ema", quote: "nothing" } }),
    { input: shown(KEYTRUDA), owner: "U.S. Food and Drug Administration", publishedDay: "2026-10-21", basis: BASIS });
  assert.deepEqual(facts.agency, { key: "fda", label: "FDA", from: "source" });
});

test("an agency named from the text must be named in its quotation: 「approved in the USA」 does not make it the FDA", () => {
  const text = "Zidesamtinib is a ROS1 inhibitor. In July 2026, zidesamtinib was approved in the USA for adults with ROS1-positive NSCLC.";
  const answer = approvalAnswer({ approval: "new-drug", agency: { key: "fda", quote: "In July 2026, zidesamtinib was approved in the USA" },
    drug: { text: "Zidesamtinib", quote: "Zidesamtinib is a ROS1 inhibitor" }, indication: null, date: null });
  const { facts, dropped } = verifyApprovalFacts(answer, { input: shown(text), publishedDay: "2026-10-23", basis: BASIS });
  assert.equal(facts.agency, null);
  assert.deepEqual(dropped, [{ key: "agency", reason: "alias" }]);
  // An agency outside the table is kept as the words the text says.
  const other = verifyApprovalFacts({ ...answer, agency: { key: "other", quote: "was approved in the USA" } }, { input: shown(text), publishedDay: "2026-10-23", basis: BASIS });
  assert.deepEqual(other.facts.agency, { key: "other", label: "其他监管机构", from: "text", quote: "was approved in the USA" });
  // A key outside the closed list is no agency.
  const unknown = verifyApprovalFacts({ ...answer, agency: { key: "who-knows", quote: "was approved in the USA" } }, { input: shown(text), publishedDay: "2026-10-23", basis: BASIS });
  assert.equal(unknown.facts.agency, null);
});

test("an approval kind outside the closed list is `other`", () => {
  const { facts, dropped } = verifyApprovalFacts(approvalAnswer({ approval: "breakthrough" }), { input: shown(KEYTRUDA), publishedDay: "2026-10-21", basis: BASIS });
  assert.equal(facts.approval, "other");
  assert.deepEqual(dropped, [{ key: "approval", reason: "unknown" }]);
});

test("a date is the decision's own: it must say its digits, exist, and not be in the future of its item", () => {
  const input = shown(KEYTRUDA);
  const at = (/** @type {any} */ date) => verifyApprovalFacts(approvalAnswer({ date }), { input, publishedDay: "2026-10-21", basis: BASIS });
  assert.equal(at({ value: "2026-10-21", quote: "October 21, 2026 6:45 am EDT" }).facts.date.value, "2026-10-21");
  // The quotation says another day.
  assert.deepEqual(at({ value: "2026-10-22", quote: "October 21, 2026 6:45 am EDT" }).dropped, [{ key: "date", reason: "date-quote" }]);
  // A day that does not exist (JavaScript would roll 31 February into March).
  assert.deepEqual(at({ value: "2026-02-31", quote: "October 21, 2026 6:45 am EDT" }).dropped, [{ key: "date", reason: "format" }]);
  // A day later than the item's own.
  const future = verifyApprovalFacts(approvalAnswer({ date: { value: "2026-10-21", quote: "October 21, 2026 6:45 am EDT" } }), { input, publishedDay: "2026-10-10", basis: BASIS });
  assert.deepEqual(future.dropped, [{ key: "date", reason: "future" }]);
  // No date is not an error: the item's own day stands.
  const none = at({ value: null, quote: null });
  assert.deepEqual(none.dropped, []);
  assert.equal(none.facts.date, null);
});

test("a decision dated long before its item is not this window's news: a revised record of an old authorisation reads as `other`", () => {
  const text = "Ximluci (ranibizumab). Date of authorisation: 09/11/2022. This medicine is authorised for use in the European Union to treat macular degeneration.";
  const answer = approvalAnswer({ approval: "generic-biosimilar", agency: null, drug: { text: "Ximluci", quote: "Ximluci (ranibizumab)" }, indication: null,
    date: { value: "2022-11-09", quote: "Date of authorisation: 09/11/2022" } });
  const { facts, dropped } = verifyApprovalFacts(answer, { input: shown(text), owner: "European Medicines Agency", publishedDay: "2026-09-30", basis: BASIS });
  assert.equal(facts.approval, "other");
  assert.equal(facts.date, null);
  assert.deepEqual(dropped, [{ key: "date", reason: "stale" }]);
});

test("a date quotation without a year is held by the item's year and range; with another year it is refused", () => {
  assert.equal(frontierQuoteSaysDate("2026-10-21", "on October 21"), true);
  assert.equal(frontierQuoteSaysDate("2026-10-21", "21/10/2026"), true);
  assert.equal(frontierQuoteSaysDate("2026-10-21", "于2026年10月21日批准"), true);
  assert.equal(frontierQuoteSaysDate("2026-10-21", "October 21, 2025"), false);
  assert.equal(frontierQuoteSaysDate("2026-10-21", "September 21"), false);
  assert.equal(frontierQuoteSaysDate("2026-10", "October"), false);
});

const GUIDELINE = "The American College of Physicians (ACP) issued guidance for menopausal vasomotor symptoms. The guidance applies to perimenopausal and postmenopausal females. ACP recommends estrogen in combination with progestogen for females with a uterus (strong recommendation; moderate-certainty evidence). ACP suggests against compounded hormone preparations. Treatment duration should be reviewed every 12 months.";

/** @param {Record<string, any>} [overrides] */
const guidelineAnswer = (overrides = {}) => ({
  guideline: true,
  body: { text: "美国内科医师学会（ACP）", quote: "The American College of Physicians (ACP)" },
  scope: { text: "围绝经期和绝经后女性的绝经血管舒缩症状", quote: "perimenopausal and postmenopausal females" },
  recommendations: [
    { text: "有子宫的女性使用雌激素联合孕激素", grade: "strong recommendation", quote: "ACP recommends estrogen in combination with progestogen for females with a uterus" },
    { text: "不建议使用复方激素制剂", grade: null, quote: "ACP suggests against compounded hormone preparations" },
  ],
  ...overrides,
});

test("a guideline answer keeps the recommendations whose quotation is in the text and the grade the text says", () => {
  const { facts, dropped } = verifyGuidelineFacts(guidelineAnswer(), { input: shown(GUIDELINE, { titleRaw: "ACP guidance" }), basis: BASIS });
  assert.deepEqual(dropped, []);
  assert.equal(facts.kind, "guideline");
  assert.equal(facts.recommendations.length, 2);
  assert.equal(facts.recommendations[0].grade, "strong recommendation");
  assert.equal(facts.recommendations[1].grade, null);
  assert.equal(facts.body.text, "美国内科医师学会（ACP）");
});

test("a recommendation whose quotation is not in the text is dropped; a grade the text does not say is not claimed", () => {
  const answer = guidelineAnswer({ recommendations: [
    { text: "所有女性都应使用激素治疗", grade: "strong recommendation", quote: "all women should use hormone therapy for hot flashes" },
    { text: "不建议使用复方激素制剂", grade: "1A", quote: "ACP suggests against compounded hormone preparations" },
  ] });
  const { facts, dropped } = verifyGuidelineFacts(answer, { input: shown(GUIDELINE), basis: BASIS });
  assert.equal(facts.recommendations.length, 1);
  assert.equal(facts.recommendations[0].grade, null);
  assert.deepEqual(dropped.map((entry) => `${entry.key}:${entry.reason}`).sort(), ["recommendations.grade:verbatim", "recommendations:verbatim"]);
});

test("a recommendation's quotation is longer than a heading, its Chinese words hold the text's numbers, and at most five are kept", () => {
  const input = shown(GUIDELINE);
  const short = verifyGuidelineFacts(guidelineAnswer({ recommendations: [{ text: "使用雌激素", grade: null, quote: "estrogen" }] }), { input, basis: BASIS });
  assert.deepEqual(short.facts.recommendations, []);
  assert.deepEqual(short.dropped, [{ key: "recommendations", reason: "quote-short" }]);
  const number = verifyGuidelineFacts(guidelineAnswer({ recommendations: [{ text: "每 6 个月复查一次治疗", grade: null, quote: "Treatment duration should be reviewed every 12 months" }] }), { input, basis: BASIS });
  assert.deepEqual(number.dropped, [{ key: "recommendations", reason: "number" }]);
  const many = verifyGuidelineFacts(guidelineAnswer({ recommendations: Array.from({ length: 7 }, () => ({ text: "有子宫的女性使用雌激素联合孕激素", grade: null,
    quote: "ACP recommends estrogen in combination with progestogen for females with a uterus" })) }), { input, basis: BASIS });
  assert.equal(many.facts.recommendations.length, 5);
});

test("a guideline text with no verified body, scope or recommendation is stored as none; so is one the model says is not a guideline", () => {
  const input = shown(GUIDELINE);
  const nothing = verifyGuidelineFacts({ guideline: true, body: { text: "某学会", quote: "not in the text" }, scope: null, recommendations: [] }, { input, basis: BASIS });
  assert.equal(nothing.facts.none, true);
  assert.equal(verifyGuidelineFacts({ guideline: false }, { input, basis: BASIS }).facts.none, true);
  // A guideline with only its body still stands: the row can say who issued it.
  const bodyOnly = verifyGuidelineFacts({ guideline: true, body: guidelineAnswer().body, scope: null, recommendations: [] }, { input, basis: BASIS });
  assert.equal(bodyOnly.facts.none, undefined);
  assert.deepEqual(bodyOnly.facts.recommendations, []);
});

test("the view of a stored record re-bounds it, shows nothing of a none record and nothing of another kind", () => {
  const approval = verifyApprovalFacts(approvalAnswer(), { input: shown(KEYTRUDA), publishedDay: "2026-10-21", basis: BASIS }).facts;
  const view = frontierTrackFactsView(approval, "approval");
  assert.equal(view?.approval, "new-indication");
  assert.deepEqual(view?.agency, { key: "ec", label: "欧盟委员会" });
  assert.equal(view?.date, "2026-10-21");
  assert.equal(frontierTrackFactsView(approval, "guideline"), null);
  assert.equal(frontierTrackFactsView({ ...approval, none: true }, "approval"), null);
  assert.equal(frontierTrackFactsView({ kind: "approval", approval: "new-drug", drug: null }, "approval"), null);
  assert.equal(frontierTrackFactsView(null, "approval"), null);
  const guideline = verifyGuidelineFacts(guidelineAnswer(), { input: shown(GUIDELINE), basis: BASIS }).facts;
  assert.equal(frontierTrackFactsView(guideline, "guideline")?.recommendations.length, 2);
});

test("the instructions are one per genre, and the version moves when they do", () => {
  assert.match(frontierTrackInstructions("approval") ?? "", /decision/);
  assert.match(frontierTrackInstructions("guideline") ?? "", /guideline/);
  assert.equal(frontierTrackInstructions("paper"), null);
  assert.match(FRONTIER_TRACK_FACTS_VERSION, /^track-\d+\.[0-9a-f]{8}$/);
});

test("an extraction asks once with the genre's instructions, and a failed call records nothing", async () => {
  const calls = /** @type {any[]} */ ([]);
  const editor = { callJson: async (/** @type {any} */ messages) => { calls.push(messages); return approvalAnswer(); } };
  const result = await frontierExtractTrackFacts(editor, { genre: "approval", basis: BASIS, owner: null, publishedDay: "2026-10-21", sourceName: "Merck news", date: "2026-10-21",
    titleRaw: "European Commission Approves KEYTRUDA", titleZh: null, text: KEYTRUDA, kind: "excerpt" });
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].content, /正文（网页节选）/);
  assert.equal(result.facts?.approval, "new-indication");
  const failing = await frontierExtractTrackFacts({ callJson: async () => { throw Object.assign(new Error("x"), { code: "model_gateway_timeout" }); } },
    { genre: "approval", basis: BASIS, sourceName: "s", titleRaw: "t", text: KEYTRUDA, kind: "excerpt" });
  assert.equal(failing.facts, null);
  assert.equal(failing.error, "model_gateway_timeout");
  const unreadable = await frontierExtractTrackFacts({ callJson: async () => null }, { genre: "guideline", basis: BASIS, sourceName: "s", titleRaw: "t", text: GUIDELINE, kind: "abstract" });
  assert.equal(unreadable.facts, null);
  assert.equal(unreadable.error, "frontier_track_unreadable");
  const other = await frontierExtractTrackFacts({ callJson: async () => { throw new Error("must not be asked"); } }, { genre: "paper", basis: BASIS, sourceName: "s", titleRaw: "t", text: "x", kind: "abstract" });
  assert.equal(other.asked, false);
});
