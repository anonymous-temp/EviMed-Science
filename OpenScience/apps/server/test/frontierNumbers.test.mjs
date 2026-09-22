import assert from "node:assert/strict";
import test from "node:test";
import { checkNumbers, normalizeNumberText, numberMentions, numberSource, parseChineseNumeral } from "../src/frontierNumbers.mjs";

/** @param {string} claim @param {string} source */
const passes = (claim, source) => checkNumbers({ summary_zh: claim }, source);
/** @param {string} text */
const raws = (text) => numberMentions(text).map((mention) => mention.raw);
/** @param {string} text @returns {number[]} */
const values = (text) => numberMentions(text).flatMap((mention) => mention.candidates.map((entry) => entry.value));

test("notation is normalised the same way on both sides: full-width, raised decimal points, thin-space and full-width thousands", () => {
  assert.equal(normalizeNumberText("３２．５％"), "32.5%");
  assert.equal(normalizeNumberText("HR 0·85 (95% CI 0·76–0·95)"), "HR 0.85 (95% CI 0.76–0.95)");
  assert.equal(normalizeNumberText(`32${String.fromCharCode(0x2009)}000`), "32000");
  assert.equal(normalizeNumberText(`10${String.fromCharCode(0x202f)}000${String.fromCharCode(0x202f)}000`), "10000000");
  assert.equal(normalizeNumberText("12，000 例"), "12,000 例");
  assert.equal(normalizeNumberText("分别为 3，4 级"), "分别为 3，4 级", "a full-width comma that is not a thousands group stays a comma");
  assert.equal(normalizeNumberText("10⁻⁸").trim(), "10 -8", "an exponent is set apart, never glued into 108");
  assert.equal(normalizeNumberText("Ⅲ期").trim(), "3 期");
  assert.equal(normalizeNumberText("H₂O"), "H2O");
});

test("Chinese numerals are read in positional order, or not at all", () => {
  const cases = [["十", 10], ["十五", 15], ["二十", 20], ["一百零五", 105], ["三千二百零五", 3205], ["两千", 2000], ["三万二千", 32000],
    ["一亿二千万", 120_000_000], ["三点二万", 32000], ["十二点五", 12.5], ["二〇二六", 2026], ["零", 0]];
  for (const [text, value] of cases) assert.equal(parseChineseNumeral(/** @type {string} */ (text)), value, String(text));
  for (const text of ["三四", "五六", "千百", "", "万", "点五"]) assert.equal(parseChineseNumeral(text), null, text);
});

test("a Chinese numeral counts only in the closed forms: 成, 倍, 分之, 万/亿, a classifier, 第 — never inside a word", () => {
  assert.deepEqual(raws("三成患者"), ["三成"]);
  assert.deepEqual(raws("近五成"), ["五成"]);
  assert.deepEqual(raws("风险降低两倍"), ["两倍"]);
  assert.deepEqual(raws("事件翻倍"), ["翻倍"]);
  assert.deepEqual(raws("百分之三十的患者"), ["百分之三十"]);
  assert.deepEqual(raws("三分之一"), ["三分之一"]);
  assert.deepEqual(raws("一半患者"), ["一半"]);
  assert.deepEqual(raws("三万二千人"), ["三万二千人"]);
  assert.deepEqual(raws("两项研究"), ["两项"]);
  assert.deepEqual(raws("第三季度"), ["第三"]);
  assert.deepEqual(raws("三成五"), ["三成五"]);
  for (const word of ["二甲双胍", "十二指肠", "三阴性乳腺癌", "一线治疗", "一致性评价", "统一标准", "万一出现", "十五"]) {
    assert.deepEqual(raws(word), [], `${word} is a word, not a number`);
  }
  // Vague quantities are not claims of a number.
  for (const vague of ["数十项研究", "十多项研究", "上万人", "几百例", "成千上万"]) assert.deepEqual(raws(vague), [], vague);
  // 「一项研究」 is the article "a study".
  assert.deepEqual(raws("一项研究显示"), []);
  assert.deepEqual(raws("一种新药"), []);
});

test("in what the model wrote, digits glued to letters are names; units glued to digits are measures", () => {
  for (const name of ["GLP-1 受体激动剂", "COVID-19", "HbA1c", "SGLT2 抑制剂", "BNT162b2", "IL-6", "PD-1", "KEYNOTE-189", "NCT01234567", "5-FU"]) {
    assert.deepEqual(raws(name), [], name);
  }
  assert.deepEqual(values("HbA1c 降低 1.2%"), [1.2, 0.012]);
  assert.deepEqual(raws("5mg 每日"), ["5"]);
  assert.deepEqual(raws("2x 风险"), ["2x"]);
  assert.deepEqual(raws("第 3rd 版"), ["3"]);
});

test("Arabic numbers: decimals, percent, thousands, ranges sharing their unit, bare decimals, fractions and scales", () => {
  assert.deepEqual(values("32,000 例"), [32000]);
  assert.deepEqual(values("1,234,567.89"), [1234567.89]);
  assert.deepEqual(values("P = .03"), [0.03]);
  assert.deepEqual(values("缓解率 10–20%"), [10, 0.1, 20, 0.2], "10–20% is 10% to 20%");
  assert.deepEqual(values("3 至 5 万人"), [30000, 50000], "3 至 5 万 is 30,000 to 50,000");
  assert.deepEqual(values("3.2 万例"), [32000]);
  assert.deepEqual(values("12 亿美元"), [1.2e9]);
  assert.deepEqual(values("$1.2B"), [1.2e9]);
  assert.deepEqual(values("−1.5%"), [1.5, 0.015], "signs are notation");
  const fraction = numberMentions("18/20 例")[0];
  assert.equal(fraction.raw, "18/20");
  assert.equal(fraction.parts?.length, 2, "a/b is also its two parts");
  assert.deepEqual(values("5 个百分点"), [5], "百分点 is not the scale 百");
});

test("a claim passes only when every number equals one in the source — no rounding", () => {
  const pass = [
    ["三成患者出现不良反应", "Adverse events occurred in 30% of patients."],
    ["近五成患者", "nearly half of participants"],
    ["风险降低两倍", "a twofold reduction in risk"],
    ["风险降低两倍", "a 2-fold reduction in risk"],
    ["事件发生率翻倍", "the event rate doubled"],
    ["百分之三十的患者", "30% of patients"],
    ["纳入 3.2 万名患者", "32,000 patients were enrolled"],
    ["纳入 3.2 万名患者", "32 thousand patients were enrolled"],
    ["纳入 3.2 万名患者", `enrolled 32${String.fromCharCode(0x2009)}000 patients`],
    ["一半患者", "50% of patients"],
    ["缓解率 10–20%", "response rates ranged from 10% to 20%"],
    ["HbA1c 降低 1.5%", "HbA1c change −1.5% (95% CI −1.8 to −1.2)"],
    ["共 1,234 例", "1234 patients"],
    ["共 ３２％", "32%"],
    ["FDA 于 9 月 20 日批准", "On September 20, 2026, the FDA approved"],
    ["3 期试验", "a phase III trial"],
    ["Ⅲ期试验", "a phase 3 trial"],
    ["2 型糖尿病患者", "adults with T2D"],
    ["风险比 0.85", "HR 0·85 (95% CI 0·76–0·95)"],
    ["P=0.03", "P = .03"],
    ["18/20 例缓解", "18 of 20 patients responded"],
    ["3 项试验", "three trials"],
    ["第 3 季度", "third-quarter revenue"],
    ["12 亿美元", "a $1.2 billion deal"],
    ["320 万美元", "$3.2M in funding"],
    ["三四成", "三四成患者"],
    ["三成", "约三成患者"],
    ["五分之一", "one-fifth of patients"],
    ["二十五名", "twenty-five patients"],
    ["第二十五名", "the twenty-fifth"],
    ["两项研究", "two studies"],
    ["95% 置信区间", "95% CI"],
    ["3 期", "Phase IIIb results"],
    ["1 期和 2 期", "a phase I/II study"],
  ];
  for (const [claim, source] of pass) {
    const result = passes(claim, source);
    assert.equal(result.ok, true, `${claim} ← ${source}: ${JSON.stringify(result.missing)}`);
    assert.ok(result.checked >= 1, `${claim} checked nothing`);
  }
});

test("a claim fails, naming the number, when the source does not state it", () => {
  const fail = [
    ["三成患者出现不良反应", "Adverse events occurred in 29.7% of patients.", "三成"],
    ["近五成患者", "48.7% of participants", "五成"],
    ["降至 25%", "fell to 24.6%", "25%"],
    ["增加 1 倍", "the rate doubled", "1 倍"],
    ["三四成", "30%-40% of patients", "三四成"],
    ["2026 年起", "from next year", "2026"],
    ["纳入 1.76 万名患者", "17,604 patients", "1.76 万"],
    ["共 3 项研究", "two studies", "3"],
  ];
  for (const [claim, source, raw] of fail) {
    const result = passes(claim, source);
    assert.equal(result.ok, false, `${claim} ← ${source} passed`);
    assert.deepEqual(result.missing, [{ field: "summary_zh", raw }]);
  }
});

test("words that only look like numbers never become one: a modal May is not a month, a word is not a digit", () => {
  assert.equal(passes("5 例", "Treatment may reduce risk. May be useful.").ok, false, "May without a date next to it is not 5");
  assert.equal(passes("5 月 3 日", "on May 3").ok, true);
  assert.equal(passes("3 例", "the third arm").ok, true, "an ordinal is a number of its own");
});

test("what is checked and what is not: identifiers and articles pass without a source; every field is checked", () => {
  const result = checkNumbers({
    title_zh: "GLP-1 受体激动剂一项研究：COVID-19 患者获益",
    summary_zh: "HbA1c 降低 1.2%，共 300 例。",
    reason_zh: "首个 3 期结果",
  }, "HbA1c fell by 1.2% among 300 participants in the first phase 3 trial.");
  assert.deepEqual(result, { ok: true, checked: 3, missing: [], unitMismatches: [] });
  const wrong = checkNumbers({ title_zh: "5 年随访", summary_zh: "300 例", reason_zh: "" }, "300 participants, followed for 4 years");
  assert.deepEqual(wrong.missing, [{ field: "title_zh", raw: "5" }]);
});

test("units are observed, not enforced: a percent matched only by a plain count passes and is reported", () => {
  const plain = passes("三成患者", "30 patients");
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.unitMismatches, [{ field: "summary_zh", raw: "三成" }]);
  const same = passes("30% 的患者", "30% of patients");
  assert.deepEqual(same.unitMismatches, []);
  const proportion = passes("30%", "a proportion of 0.30");
  assert.equal(proportion.ok, true, "30% equals the proportion 0.30");
  assert.deepEqual(proportion.unitMismatches, [{ field: "summary_zh", raw: "30%" }],
    "a bare 0.30 states no unit of its own, and that is what the metric reports");
});

test("the source offers every notation it states: Chinese quantities, words, dates, romans and scales", () => {
  const source = numberSource("约三成患者；two thirds; September 20; phase II; $450M; 1.2 million; 二〇二六年; 第三");
  for (const value of ["30", "0.3", "0.666666666667", "66.6666666667", "9", "20", "2", "450000000", "450", "1200000", "1.2", "2026", "3"]) {
    assert.ok(source.values.has(value), `${value} missing from ${JSON.stringify([...source.values.keys()])}`);
  }
});
