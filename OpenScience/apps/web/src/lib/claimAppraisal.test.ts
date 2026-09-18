import { describe, expect, it } from "vitest";
import { claimAppraisalDisplay } from "./claimAppraisal";
import { parseClaimMatrix, type ClaimVerification } from "./claimCitations";

const SOURCE = ".evimed-sources/aspree/fulltext.md";

function claimWith(fields: Record<string, unknown>) {
  const claims = parseClaimMatrix(JSON.stringify({ claims: [{
    claimId: "CLM-001", claim: "大出血风险升高。", claimType: "direct", artifactPath: SOURCE, supportQuote: "q", ...fields,
  }] }));
  return claims.get("CLM-001")!;
}

function verifiedAs(sourceType: string): ClaimVerification["claims"][number] {
  return { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: SOURCE, status: "verified", sourceType }] };
}

describe("claimAppraisalDisplay", () => {
  it("says nothing about a claim that carries no appraisal", () => {
    expect(claimAppraisalDisplay(claimWith({}))).toBeNull();
  });

  it("names the PICO parts in the reader's words, an exposure as an exposure", () => {
    const display = claimAppraisalDisplay(claimWith({ pico: {
      population: { text: "≥70 岁社区成人", quote: "70 years of age or older" },
      intervention: "阿司匹林 100 mg/d",
      comparator: "安慰剂",
      outcomes: ["大出血", { text: "全因死亡" }],
      timeframe: "中位 4.7 年",
    } }));
    expect(display?.pico).toEqual([
      { label: "人群", value: "≥70 岁社区成人" },
      { label: "干预", value: "阿司匹林 100 mg/d" },
      { label: "对照", value: "安慰剂" },
      { label: "结局", value: "大出血、全因死亡" },
      { label: "时间", value: "中位 4.7 年" },
    ]);
    // The shape the skill taught first reads as it stands.
    expect(claimAppraisalDisplay(claimWith({ pico: { population: "成人", exposure: "吸烟", outcome: "肺癌" } }))?.pico)
      .toEqual([{ label: "人群", value: "成人" }, { label: "暴露", value: "吸烟" }, { label: "结局", value: "肺癌" }]);
  });

  it("shows the stated certainty, and a quiet note when its parts give another", () => {
    const certainty = { start: "high", riskOfBias: -1, imprecision: -1, rationale: "见正文", label: "moderate" };
    expect(claimAppraisalDisplay(claimWith({ certainty }))?.certainty).toEqual([
      { outcome: null, label: "中", note: "标注为“中”，按各分项计算为“低”", disagrees: true },
    ]);
    expect(claimAppraisalDisplay(claimWith({ certainty: { ...certainty, label: "low" } }))?.certainty).toEqual([
      { outcome: null, label: "低", note: null, disagrees: false },
    ]);
  });

  it("with no stated level, shows the level the parts give and says so; a bare level is shown as stated", () => {
    expect(claimAppraisalDisplay(claimWith({ certainty: { start: "low" } }))?.certainty).toEqual([
      { outcome: null, label: "低", note: "按各分项计算", disagrees: false },
    ]);
    expect(claimAppraisalDisplay(claimWith({ certainty: "very-low" }))?.certainty).toEqual([
      { outcome: null, label: "极低", note: null, disagrees: false },
    ]);
    expect(claimAppraisalDisplay(claimWith({ certainty: [
      { outcome: "大出血", start: "high", label: "high" },
      { outcome: "全因死亡", start: "high", imprecision: -2, rationale: "宽置信区间", label: "low" },
    ] }))?.certainty.map((badge) => [badge.outcome, badge.label])).toEqual([["大出血", "高"], ["全因死亡", "低"]]);
  });

  it("reads the design from the type stamped beside the source, as the gate does", () => {
    // Observational evidence rated from a high start (ROBINS-I style) and
    // rated up for a large effect: the upgrade counts only when the source is
    // known to be observational.
    const certainty = { start: "high", riskOfBias: -2, upgrades: { largeEffect: 1 }, rationale: "见正文", label: "moderate" };
    expect(claimAppraisalDisplay(claimWith({ certainty }), verifiedAs("observational"))?.certainty[0])
      .toEqual({ outcome: null, label: "中", note: null, disagrees: false });
    expect(claimAppraisalDisplay(claimWith({ certainty }), verifiedAs("rct"))?.certainty[0])
      .toEqual({ outcome: null, label: "中", note: "标注为“中”，按各分项计算为“低”", disagrees: true });
  });

  it("shows a risk-of-bias judgement under its tool, and a quiet note when the domains give another", () => {
    const display = claimAppraisalDisplay(claimWith({
      riskOfBias: { tool: "RoB 2", domains: { D1: "low", D2: "low", D3: "some concerns", D4: "low", D5: "low" }, overall: "low" },
    }));
    expect(display?.riskOfBias).toEqual([
      { source: null, heading: "偏倚风险 · RoB 2", label: "低", note: "标注为“低”，按各领域判断应为“存在一定风险”", disagrees: true },
    ]);
    const amstar = claimAppraisalDisplay(claimWith({ riskOfBias: { tool: "AMSTAR 2", domains: { 2: "no" }, overall: "low" } }));
    expect(amstar?.riskOfBias[0]).toMatchObject({ heading: "结果可信度 · AMSTAR 2", label: "低", disagrees: false });
    const unknownTool = claimAppraisalDisplay(claimWith({ riskOfBias: { tool: "Newcastle-Ottawa", overall: "7 stars" } }));
    expect(unknownTool?.riskOfBias[0]).toMatchObject({ heading: "偏倚风险 · Newcastle-Ottawa", label: "7 stars", note: null });
  });

  it("keeps each supporting source's risk of bias with that source", () => {
    const claims = parseClaimMatrix(JSON.stringify({ claims: [{
      claimId: "CLM-003", claim: "两项试验综合。", claimType: "synthesized", supportingSources: [
        { artifactPath: ".evimed-sources/a/fulltext.md", supportQuote: "a", riskOfBias: { tool: "rob2", domains: { D1: "high" }, overall: "high" } },
        { artifactPath: ".evimed-sources/b/fulltext.md", supportQuote: "b" },
      ],
    }] }));
    expect(claimAppraisalDisplay(claims.get("CLM-003")!)?.riskOfBias).toEqual([
      { source: 0, heading: "偏倚风险 · RoB 2", label: "高", note: null, disagrees: false },
    ]);
  });
});
