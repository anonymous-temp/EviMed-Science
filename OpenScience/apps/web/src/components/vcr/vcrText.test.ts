import {
  VCR_CONCLUSION_LABELS_ZH,
  VCR_COUNT_LABELS_ZH,
  VCR_INTERVAL_KINDS,
  VCR_REVIEW_STATE_LABELS_ZH,
  VCR_VALUE_SOURCES,
  VCR_VALUE_SOURCE_LABELS_ZH,
} from "@evimed/domain";
import { describe, expect, it } from "vitest";
import type { VcrIntervalKind, VcrValueSource } from "@/lib/vcrClient";
import {
  conclusionLabel,
  countLabel,
  countText,
  intervalText,
  isPlaceholder,
  mcseText,
  NO_VALUE,
  numberText,
  reviewLabel,
  sourceLabel,
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

  it("names the three conclusions and the three review states from the vocabulary", () => {
    expect(conclusionLabel("not_estimable")).toBe(VCR_CONCLUSION_LABELS_ZH.not_estimable);
    expect(reviewLabel("ai_set")).toBe(VCR_REVIEW_STATE_LABELS_ZH.ai_set);
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
  it("carries the source, the named interval, the simulation error and the review state", () => {
    const sentence = valueSentence({
      value: 4.1, unit: "个月", source: "aggregate", review: "ai_set",
      interval: { kind: "prediction", low: 3.0, high: 5.6 },
      mcse: 0.4,
    });
    expect(sentence).toContain("4.1个月");
    expect(sentence).toContain("汇总");
    expect(sentence).toContain("预测区间 3.0–5.6");
    expect(sentence).toContain("±0.4");
    expect(sentence).toContain("AI 设定");
  });

  it("says a result is stale without dropping its number", () => {
    const sentence = valueSentence({ value: 71, source: "predicted", stale: true });
    expect(sentence).toContain("71");
    expect(sentence).toContain("已过期");
  });
});

describe("the Monte-Carlo standard error", () => {
  it("is written with its sign and nothing at all when it was not computed", () => {
    expect(mcseText(0.4)).toBe("±0.40");
    expect(mcseText(null)).toBe("");
  });
});
