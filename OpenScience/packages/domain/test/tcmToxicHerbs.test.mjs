import assert from "node:assert/strict";
import test from "node:test";

import {
  TCM_TOXIC_HERBS,
  compileTcmToxicHerbs,
  matchedTcmToxicHerbs,
  medicationSafetyIn,
  tcmDoseFindings,
} from "../index.mjs";

// The herbs the 2026-09-26 audit (M-13) named as missing from every
// checkpoint, each with where its toxicity and dose come from.

test("every herb the audit named is a row, and every row cites a source", () => {
  const names = TCM_TOXIC_HERBS.map((row) => row.nameZh);
  for (const herb of ["附子", "川乌", "草乌", "马钱子", "细辛", "朱砂", "雄黄", "关木通", "广防己", "青木香"]) {
    assert.ok(names.includes(herb), `${herb} has no row`);
  }
  for (const row of TCM_TOXIC_HERBS) {
    assert.ok(row.evidence.length > 0 && row.evidence.every((entry) => /^https:\/\//.test(entry.url) && entry.authority), row.id);
    assert.ok(row.toxicity.length > 0, row.id);
  }
  // A dose range is the Pharmacopoeia's: every herb it still lists has one.
  for (const id of ["fuzi", "chuanwu", "caowu", "maqianzi", "xixin", "zhusha", "xionghuang"]) {
    const row = TCM_TOXIC_HERBS.find((entry) => entry.id === id);
    assert.ok(row?.doseRangeG && row.evidence.some((entry) => entry.year === 2020), `${id} carries its 2020 Pharmacopoeia dose`);
  }
});

test("a herb is named by any of its names, longest first, so 白附子 is not 附子", () => {
  assert.deepEqual(matchedTcmToxicHerbs("白附子 6 g，天南星 3 g"), ["白附子"]);
  assert.deepEqual(matchedTcmToxicHerbs("制附子与干姜同煎"), ["附子"]);
  assert.deepEqual(matchedTcmToxicHerbs("方中黑顺片、制川乌各少量"), ["附子", "川乌"]);
  assert.deepEqual(matchedTcmToxicHerbs("木通、防己为药典收载品种"), [], "the Pharmacopoeia's own 木通 and 防己 are not the withdrawn herbs");
  assert.deepEqual(matchedTcmToxicHerbs("关木通含马兜铃酸"), ["关木通"]);
  assert.deepEqual(matchedTcmToxicHerbs(""), []);
});

test("a stated dose above the source's upper bound is found, in grams or milligrams, a range read at its top", () => {
  assert.deepEqual(tcmDoseFindings("附子 30 g，先煎").map(({ herb, statedG, maxG }) => [herb, statedG, maxG]), [["附子", 30, 15]]);
  assert.deepEqual(tcmDoseFindings("附子（先煎）15～60 克").map((finding) => finding.statedG), [60]);
  assert.deepEqual(tcmDoseFindings("马钱子 900mg 入丸").map((finding) => finding.statedG), [0.9]);
  assert.deepEqual(tcmDoseFindings("雄黄 0.2g").map((finding) => finding.herb), ["雄黄"]);
  // Within the range, or a dose that belongs to the next herb, is no finding.
  assert.deepEqual(tcmDoseFindings("附子 10 g，细辛 3 g，马钱子 0.3 g"), []);
  assert.deepEqual(tcmDoseFindings("附子、干姜各 30 g"), [], "a clause separator ends the herb's reach");
  assert.deepEqual(tcmDoseFindings("白附子 6 g"), [], "白附子's own bound, never 附子's");
  assert.deepEqual(tcmDoseFindings("关木通 10 g"), [], "a withdrawn herb has no range to check against, and is named instead");
});

test("the shared reading names every medicine the checkpoint is about", () => {
  assert.deepEqual(medicationSafetyIn("华法林与附子 30 g 同用"), {
    medicines: ["华法林", "附子"],
    overDose: [{ herb: "附子", statedG: 30, maxG: 15, text: "附子 30 g" }],
  });
  assert.deepEqual(medicationSafetyIn("报告先写结论再写证据"), { medicines: [], overDose: [] });
});

test("a malformed herb row is refused at load, naming the row", () => {
  const valid = { id: "x-herb", nameZh: "某药", names: ["某药"], toxicity: "有毒", doseRangeG: [1, 3],
    evidence: [{ authority: "A", url: "https://example.org/a" }] };
  /** @param {Record<string, any>} overrides */
  const load = (overrides) => compileTcmToxicHerbs({ tcmToxicHerbs: [{ ...valid, ...overrides }] });
  assert.equal(load({}).length, 1);
  assert.throws(() => load({ doseRangeG: [3, 1] }), /doseRangeG/);
  assert.throws(() => load({ names: [] }), /names/);
  assert.throws(() => load({ evidence: [{ authority: "A", url: "http://example.org" }] }), /https url/);
  assert.throws(() => compileTcmToxicHerbs({ tcmToxicHerbs: [valid, { ...valid, id: "y-herb" }] }), /repeats the name/);
});
