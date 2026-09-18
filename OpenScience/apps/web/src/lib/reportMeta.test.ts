import { describe, expect, it } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { parseClaimMatrixDocument } from "@/lib/claimCitations";
import { modelLabel, reportFacts, safetyClaimIds, sourceComposition } from "./reportMeta";

const matrix = parseClaimMatrixDocument(JSON.stringify({ claims: [
  { claimId: "CLM-001", claim: "a", claimType: "direct", sourceType: "rct", artifactPath: ".evimed-sources/PMC1/fulltext.md", supportQuote: "q" },
  { claimId: "CLM-002", claim: "b", claimType: "direct", sourceType: "rct", artifactPath: ".evimed-sources/PMC1/fulltext.md", supportQuote: "q2" },
  { claimId: "CLM-003", claim: "c", claimType: "synthesized", supportingSources: [
    { sourceType: "guideline", artifactPath: ".evimed-sources/g/page.md", supportQuote: "g" },
    { sourceType: "systematic-review", identifier: "doi:10.1/x", supportQuote: "s" },
  ] },
  { claimId: "CLM-004", claim: "d", claimType: "derived", derivedFrom: ["CLM-001"] },
] }));

describe("report facts", () => {
  it("counts distinct sources by kind, most authoritative form first", () => {
    expect(sourceComposition(matrix.claims.values())).toEqual([
      { type: "guideline", label: "指南", count: 1 },
      { type: "systematic-review", label: "系统综述", count: 1 },
      { type: "rct", label: "RCT", count: 1 },
    ]);
  });

  // Nothing is read out of the prose and nothing is assumed: a field the
  // package and the run do not state says 「未注明」.
  it("says 未注明 for every fact neither the package nor the run states", () => {
    const facts = reportFacts({ meta: null, claims: null, run: null });
    expect(facts.map((fact) => [fact.label, fact.value, fact.missing])).toEqual([
      ["检索截止日", "未注明", true],
      ["来源范围", "未注明", true],
      ["模型", "未注明", true],
      ["已知局限", "未注明", true],
    ]);
  });

  it("uses what the package and the run do state", () => {
    const run = { model: "deepseek/deepseek-flash", startedAt: "2026-09-17T02:00:00Z", finishedAt: "2026-09-17T02:30:00Z" } as WebAgentRun;
    const facts = reportFacts({ meta: { searchCutoff: "2026-09-01", limitations: ["仅英文文献"] }, claims: matrix.claims, run, limitationsTarget: "sec-9" });
    expect(Object.fromEntries(facts.map((fact) => [fact.label, fact.value]))).toEqual({
      检索截止日: "2026年9月1日",
      来源范围: "指南 1 · 系统综述 1 · RCT 1（共 3 个来源）",
      模型: "DeepSeek · deepseek-flash",
      已知局限: "仅英文文献",
      生成日期: "2026年9月17日",
    });
  });

  it("points at the report's own 局限性 section when the package lists no limits", () => {
    const facts = reportFacts({ meta: {}, claims: matrix.claims, run: null, limitationsTarget: "report-sec-7" });
    expect(facts.find((fact) => fact.label === "已知局限")).toEqual({ label: "已知局限", value: "见正文「局限性」一节", missing: false, target: "report-sec-7" });
  });

  it("names the model as the run recorded it", () => {
    expect(modelLabel("deepseek-flash")).toBe("DeepSeek · deepseek-flash");
    expect(modelLabel("qwen-plus")).toBe("qwen-plus");
    expect(modelLabel("")).toBeNull();
  });

  it("collects the claims a clinical-safety finding names, and only those", () => {
    expect([...safetyClaimIds([
      { severity: "safety", claimId: "CLM-003", code: "x", title: "t", text: "t" },
      { severity: "must-fix", claimId: "CLM-001", code: "x", title: "t", text: "t" },
      { severity: "safety", claimId: "not-a-claim", code: "x", title: "t", text: "t" },
      "SAFETY — legacy string",
    ])]).toEqual(["CLM-003"]);
  });
});
