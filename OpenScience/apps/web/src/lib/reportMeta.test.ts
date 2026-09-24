import { describe, expect, it } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { parseClaimMatrixDocument } from "@/lib/claimCitations";
import { modelLabel, reportFacts, safetyClaimIds, sourceComposition, verifiedSourceTypes } from "./reportMeta";

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
  it("takes a source's kind from the control plane's verification over the matrix's silence", () => {
    // The first live aspirin report said 「指南 1 · 其他 25」 while the
    // verification typed its sources; the verification's kind wins.
    const plain = parseClaimMatrixDocument(JSON.stringify({ claims: [
      { claimId: "CLM-001", claim: "a", claimType: "direct", artifactPath: ".evimed-sources/PMC1/fulltext.md", supportQuote: "q" },
      { claimId: "CLM-002", claim: "b", claimType: "direct", artifactPath: ".evimed-sources/g/page.md", supportQuote: "g" },
    ] }));
    const verification = { claims: [
      { claimId: "CLM-001", status: "verified", sources: [{ artifactPath: ".evimed-sources/PMC1/fulltext.md", status: "verified", sourceType: "rct" }] },
      { claimId: "CLM-002", status: "verified", sources: [{ artifactPath: ".evimed-sources/g/page.md", status: "verified", sourceType: "guideline" }] },
    ], counts: {} } as never;
    expect(sourceComposition(plain.claims.values(), verifiedSourceTypes(verification)).map((entry) => [entry.label, entry.count])).toEqual([["指南", 1], ["RCT", 1]]);
    expect(sourceComposition(plain.claims.values()).map((entry) => entry.label)).toEqual(["其他"]);
  });

  it("dates the search by the run that did it when the package states no cutoff", () => {
    // Midday UTC is the same calendar day in every zone a test machine runs in.
    const run = { model: "deepseek/deepseek-flash", startedAt: "2026-09-18T06:01:56Z", finishedAt: "2026-09-18T06:25:53Z" } as WebAgentRun;
    const facts = reportFacts({ meta: null, run });
    expect(facts[0]).toEqual({ label: "检索截止日", value: "2026年9月18日", missing: false });
  });

  it("counts distinct sources by kind, most authoritative form first", () => {
    expect(sourceComposition(matrix.claims.values())).toEqual([
      { type: "guideline", label: "指南", count: 1 },
      { type: "systematic-review", label: "系统综述", count: 1 },
      { type: "rct", label: "RCT", count: 1 },
    ]);
  });

  // Two dates and nothing else (2026-09-23 inventory §1.11): no model name,
  // no tally, and no row that only says 「未注明」.
  it("states the search cutoff and the date written, and leaves out what is not known", () => {
    expect(reportFacts({ meta: null, run: null })).toEqual([]);
    const run = { model: "deepseek/deepseek-flash", startedAt: "2026-09-17T02:00:00Z", finishedAt: "2026-09-17T02:30:00Z" } as WebAgentRun;
    const facts = reportFacts({ meta: { searchCutoff: "2026-09-01", limitations: ["仅英文文献"] }, run });
    expect(Object.fromEntries(facts.map((fact) => [fact.label, fact.value]))).toEqual({
      检索截止日: "2026年9月1日",
      生成日期: "2026年9月17日",
    });
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
