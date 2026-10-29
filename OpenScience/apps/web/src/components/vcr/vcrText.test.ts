import {
  VCR_CONCLUSION_LABELS_ZH,
  VCR_COUNT_LABELS_ZH,
  VCR_INTERVAL_KINDS,
  VCR_VALUE_SOURCES,
  VCR_VALUE_SOURCE_LABELS_ZH,
} from "@evimed/domain";
import { describe, expect, it } from "vitest";
import type { VcrIntervalKind, VcrValueSource } from "@/lib/vcrClient";
import {
  conclusionLabel,
  countLabel,
  countText,
  factValueText,
  intervalText,
  engineIntervalForDisplay,
  isPlaceholder,
  mcseText,
  NO_VALUE,
  numberText,
  sourceLabel,
  staleSentence,
  valueSentence,
  valueText,
} from "./vcrText";

describe("the labels are the domain's, not a second copy", () => {
  it("names every one of the nine value sources exactly as the vocabulary does", () => {
    for (const source of VCR_VALUE_SOURCES as readonly VcrValueSource[]) {
      expect(sourceLabel(source)).toBe((VCR_VALUE_SOURCE_LABELS_ZH as Record<string, string>)[source]);
      expect(sourceLabel(source)).not.toBe("");
    }
  });

  it("names the three conclusions from the vocabulary", () => {
    expect(conclusionLabel("not_estimable")).toBe(VCR_CONCLUSION_LABELS_ZH.not_estimable);
    expect(countLabel("effectiveSampleSize")).toBe(VCR_COUNT_LABELS_ZH.effectiveSampleSize);
  });

  it("says nothing for a word it does not know, rather than printing the id", () => {
    expect(sourceLabel("made_up" as never)).toBe("");
  });
});

describe("an interval is always named", () => {
  it("writes each kind by its own name", () => {
    expect(intervalText({ kind: "confidence", low: 3.6, high: 4.6, level: 95 })).toBe("95% 置信区间 3.6–4.6");
    expect(intervalText({ kind: "prediction", low: 3.0, high: 5.6 })).toBe("预测区间 3.0–5.6");
    expect(intervalText({ kind: "monte_carlo", low: 0.806, high: 0.818 })).toContain("蒙特卡洛区间");
  });

  it("never writes a bare 「区间」 for a kind it cannot name", () => {
    expect(intervalText({ kind: "made_up" as never, low: 1, high: 2 })).toBe("");
  });

  it("has a name for every interval kind the domain knows", () => {
    for (const kind of VCR_INTERVAL_KINDS as readonly VcrIntervalKind[]) {
      expect(intervalText({ kind, low: 1, high: 2 })).not.toBe("");
    }
  });

  it("writes nothing when there is no range to write", () => {
    expect(intervalText({ kind: "confidence", low: null, high: null })).toBe("");
    expect(intervalText(null)).toBe("");
  });
});

describe("a number that does not exist", () => {
  it("is a word and never a zero", () => {
    expect(valueText({ value: null, source: "observed" })).toBe(NO_VALUE);
    expect(valueText({ value: null, text: "不可估计", source: "observed" })).toBe("不可估计");
    expect(isPlaceholder({ value: null, text: "不可估计", source: "observed" })).toBe(true);
    expect(isPlaceholder({ value: 0, source: "observed" })).toBe(false);
  });

  it("keeps a real zero: 「真实患者数 0」 at T0 is the truth", () => {
    expect(numberText(0)).toBe("0");
    expect(countText(0)).toBe("0");
  });
});

describe("a count", () => {
  it("rounds past ten thousand into 万, which is what a reader can hold", () => {
    expect(countText(6_480_000)).toContain("万");
    expect(countText(3412)).toBe("3,412");
  });

  it("is 「—」 when it was never measured", () => {
    expect(countText(null)).toBe(NO_VALUE);
  });
});

describe("the whole value as one sentence", () => {
  // R36, 2026-10-10: who set a number and whether a person has signed it are the module's bookkeeping; the sentence a screen reader gets for a number
  // is its value, its source, its interval, its simulation error and whether it is out of date.
  it("carries the source, the named interval and the simulation error, and says nothing of who set the number", () => {
    const sentence = valueSentence({
      value: 4.1, unit: "个月", source: "aggregate", review: "ai_set",
      interval: { kind: "prediction", low: 3.0, high: 5.6 },
      mcse: 0.4,
    });
    expect(sentence).toContain("4.1个月");
    expect(sentence).toContain("汇总");
    expect(sentence).toContain("预测区间 3.0–5.6");
    expect(sentence).toContain("±0.4");
    expect(sentence).not.toMatch(/AI 设定|已复核|复核后有变更/);
  });

  it("says a result is stale without dropping its number", () => {
    const sentence = valueSentence({ value: 71, source: "predicted", stale: true });
    expect(sentence).toContain("71");
    expect(sentence).toContain("已过期");
  });
});

// Numbers are printed to the precision they deserve (CW-14): a hazard ratio of
// 1.04 is 1.04 and never 1.0, and a Monte-Carlo error to two significant
// digits — the value to the decimal place of the error's first one.
describe("a number's precision", () => {
  it("keeps two decimals on a ratio and never rounds 1.04 to 1.0 or 1.96 to 2.0", () => {
    expect(numberText(1.04)).toBe("1.04");
    expect(numberText(1.96)).toBe("1.96");
    expect(numberText(0.6)).toBe("0.6");
  });

  it("keeps two significant digits below one: 0.0031 stays 0.0031", () => {
    expect(numberText(0.0031)).toBe("0.0031");
    expect(numberText(0.31)).toBe("0.31");
  });

  it("drops a zero the rule wrote and nobody measured: 5.9 is 5.9, not 5.90", () => {
    expect(numberText(5.9)).toBe("5.9");
    expect(numberText(4.1)).toBe("4.1");
    expect(numberText(180)).toBe("180");
    expect(numberText(71.25)).toBe("71.3");
  });

  it("writes a Monte-Carlo error to two significant digits", () => {
    expect(mcseText(0.0031)).toBe("±0.0031");
    expect(mcseText(0.4)).toBe("±0.40");
    expect(mcseText(0.31)).toBe("±0.31");
    expect(mcseText(1.04)).toBe("±1.0");
    expect(mcseText(13.4)).toBe("±13");
  });

  // power 0.712 ± 0.0031 → the value to the third decimal, the error to the fourth.
  it("prints a value to the decimal place of its own error's first digit", () => {
    const power = { value: 0.712, mcse: 0.0031, source: "predicted" as const };
    expect(valueText(power)).toBe("0.712");
    expect(mcseText(power.mcse)).toBe("±0.0031");
    expect(valueText({ value: 71.2345, mcse: 0.31, source: "predicted" })).toBe("71.2");
  });

  it("honours the precision the server sent, zeros included", () => {
    expect(valueText({ value: 72, precision: 1, source: "predicted" })).toBe("72.0");
    expect(valueText({ value: 0.5, precision: 3, source: "predicted" })).toBe("0.500");
  });

  it("prints both ends of an interval to the same decimals", () => {
    expect(intervalText({ kind: "prediction", low: 3, high: 5.6 })).toBe("预测区间 3.0–5.6");
    expect(intervalText({ kind: "confidence", low: 5.6, high: 6.25, level: 95 })).toBe("95% 置信区间 5.60–6.25");
  });
});

describe("a stale sentence", () => {
  it("promises a queue only when one exists", () => {
    expect(staleSentence(true)).toBe("输入已变更，排队重算中");
    expect(staleSentence(false)).not.toContain("排队重算中");
    expect(staleSentence(undefined)).not.toContain("排队重算中");
  });
});

describe("the Monte-Carlo standard error", () => {
  it("is written with its sign and nothing at all when it was not computed", () => {
    expect(mcseText(0.4)).toBe("±0.40");
    expect(mcseText(null)).toBe("");
  });
});

describe("a recorded value, read by a person", () => {
  it("says a yes or no as 是 or 否, and a value that was recorded without one as 未知", () => {
    expect(factValueText(true)).toBe("是");
    expect(factValueText(false)).toBe("否");
    for (const missing of [null, undefined, "", Number.NaN]) expect(factValueText(missing)).toBe("未知");
  });
  it("keeps a real zero and a string as they are", () => {
    expect(factValueText(0)).toBe("0");
    expect(factValueText(2.4)).toBe("2.4");
    expect(factValueText("1+")).toBe("1+");
  });
  it("lists a list with 、 and a record as name：value pairs, never [object Object]", () => {
    expect(factValueText(["青霉素", "磺胺"])).toBe("青霉素、磺胺");
    expect(factValueText({ systolic: 120, diastolic: 80 })).toBe("systolic：120；diastolic：80");
    expect(factValueText({ drug: { name: "二甲双胍", dose: 500 }, stopped: false })).toBe("drug：name：二甲双胍；dose：500；stopped：否");
    expect(factValueText([{ a: 1 }, { a: 2 }])).toBe("a：1、a：2");
  });
  it("hands a very deep value over as compact JSON rather than loop or print an object", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const text = factValueText(deep);
    expect(text).not.toContain("[object Object]");
    expect(text).toContain('{"d":1}');
  });
});


it("keeps page percentage units and fractional precision for every interval kind", () => {
  for (const kind of VCR_INTERVAL_KINDS as readonly VcrIntervalKind[]) {
    for (const level of [1, 90, 95, 99, 99.5]) expect(intervalText({ kind, low: 1, high: 2, level })).toMatch(new RegExp(`^${level}% `));
    for (const level of [undefined, null, 0, -1, 101, NaN, Infinity]) expect(intervalText({ kind, low: 1, high: 2, level })).not.toContain("%");
  }
});

it("adapts engine levels only at explicit display boundaries and preserves raw results", () => {
  for (const kind of VCR_INTERVAL_KINDS as readonly VcrIntervalKind[]) {
    for (const [level, expected] of [[0.95, 95], [0.9, 90], [0.99, 99], [0.995, 99.5], [0.01, 1], [1, 100], [95, 95], [99.5, 99.5], [undefined, null], [null, null], [Infinity, null], [-1, null], [101, null], [NaN, null]]) {
      const raw = { kind, level, low: 0.123456789, high: 0.987654321 };
      expect(engineIntervalForDisplay(raw)).toEqual({ ...raw, level: expected });
      expect(raw.level).toBe(level);
    }
  }
  expect(engineIntervalForDisplay(null)).toBeNull();
});
