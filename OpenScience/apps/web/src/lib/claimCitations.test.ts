import { describe, expect, it } from "vitest";
import {
  CLAIM_STATUS_TEXT, claimIdsFromHref, claimMatrixPathFor, claimStatuses, claimVerificationSummary, linkClaimMarkers, parseClaimMatrix,
} from "./claimCitations";

// Marker and matrix shapes copied from a production report (2026-09-16,
// deliverables/mimic-sepsis-prognosis-scoping).
const REPORT_LINE = "其 v2.2 版本报告 73,181 次 ICU 住院与 50,920 名唯一患者 [1]<!-- claim:CLM-001 --><!-- claim:CLM-005 -->。";

describe("claim citations", () => {
  it("finds a report's matrix beside it, and only a report's", () => {
    expect(claimMatrixPathFor("deliverables/d1/clinical-evidence-report.md")).toBe("deliverables/d1/clinical-evidence-matrix.json");
    expect(claimMatrixPathFor("clinical-evidence-report.md")).toBe("clinical-evidence-matrix.json");
    expect(claimMatrixPathFor("deliverables/d1/notes.md")).toBeNull();
  });

  it("turns each run of markers into one citation, leaving code and the sentence alone", () => {
    const linked = linkClaimMarkers(`${REPORT_LINE}\n\n\`<!-- claim:CLM-009 -->\`\n\n\`\`\`\n<!-- claim:CLM-010 -->\n\`\`\``);
    expect(linked).toContain("50,920 名唯一患者 [1][依据](#evimed-claims=CLM-001,CLM-005)。");
    expect(linked).toContain("`<!-- claim:CLM-009 -->`");
    expect(linked).toContain("<!-- claim:CLM-010 -->");
    expect(linkClaimMarkers("x<!-- claim:CLM-002 --><!-- claim:CLM-002 -->")).toBe("x[依据](#evimed-claims=CLM-002)");
  });

  it("says once, above the report, how much of it was checked against a preserved source", () => {
    const claim = (claimId: string, status: string) => ({ claimId, claimType: "direct", status, sources: [] });
    expect(claimVerificationSummary(null)).toBeNull();
    expect(claimVerificationSummary({ claims: [], counts: {} })).toBeNull();
    expect(claimVerificationSummary({
      claims: [claim("CLM-001", "verified"), claim("CLM-002", "verified")],
      counts: { verified: 2 },
    })).toEqual({ text: "本报告 2 条主张：2 条引文已在保存的原文中核对。点句末的「依据」看每一条。", attention: false });
    const mixed = claimVerificationSummary({
      claims: [claim("CLM-001", "verified"), claim("CLM-002", "quote_not_found"), claim("CLM-003", "source_unavailable"), claim("CLM-004", "derived")],
      counts: { verified: 1, quote_not_found: 1, source_unavailable: 1, derived: 1 },
    });
    expect(mixed?.attention).toBe(true);
    expect(mixed?.text).toBe("本报告 4 条主张：1 条引文已在保存的原文中核对，1 条未在原文中找到，1 条无法核对，1 条为推导结果。点句末的「依据」看每一条。");
    expect(claimStatuses({ claims: [claim("CLM-001", "verified")], counts: {} }).get("CLM-001")).toBe("verified");
    // Every status the control plane can answer has words for a reader.
    for (const status of ["verified", "quote_not_found", "source_unavailable", "no_quote", "derived"]) {
      expect(CLAIM_STATUS_TEXT[status]?.label).toBeTruthy();
    }
  });

  it("reads the claim ids back from a citation link, and nothing from any other link", () => {
    expect(claimIdsFromHref("#evimed-claims=CLM-001,CLM-005")).toEqual(["CLM-001", "CLM-005"]);
    expect(claimIdsFromHref("#evimed-claims=javascript:alert(1)")).toBeNull();
    expect(claimIdsFromHref("https://example.org")).toBeNull();
  });

  it("reads direct, synthesized and derived claims, and treats a broken matrix as empty", () => {
    const claims = parseClaimMatrix(JSON.stringify({ claims: [
      { claimId: "CLM-001", claim: "MIMIC-IV 是单一机构数据库。", claimType: "direct", accessLevel: "full_text",
        sourceUrl: "https://europepmc.org/articles/PMC9810617", sourceTitle: "MIMIC-IV", identifier: "PMCID:PMC9810617", supportQuote: "covering a decade" },
      { claimId: "CLM-020", claim: "两项研究结论一致。", claimType: "synthesized", confidence: "moderate",
        supportingSources: [{ sourceTitle: "A", supportQuote: "q1" }, { sourceTitle: "B", supportQuote: "q2" }] },
      { claimId: "CLM-030", claim: "估算重叠比例约 40%。", claimType: "derived", derivedFrom: ["CLM-001", "CLM-020"], method: "按纳入年份相减" },
      { claim: "no id" },
    ] }));
    expect([...claims.keys()]).toEqual(["CLM-001", "CLM-020", "CLM-030"]);
    expect(claims.get("CLM-001")).toMatchObject({ accessLevel: "full_text", identifier: "PMCID:PMC9810617" });
    expect(claims.get("CLM-020")?.supportingSources).toHaveLength(2);
    expect(claims.get("CLM-030")).toMatchObject({ derivedFrom: ["CLM-001", "CLM-020"], method: "按纳入年份相减" });
    expect(parseClaimMatrix("{not json").size).toBe(0);
  });
});
