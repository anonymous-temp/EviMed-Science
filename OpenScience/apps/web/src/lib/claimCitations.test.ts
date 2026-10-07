import { describe, expect, it } from "vitest";
import { claimEvidenceSources, claimVerification } from "@evimed/domain/clinical-evidence";
import {
  CLAIM_STATUS_TEXT, claimCheckMark, claimGuidance, claimIdsFromHref, claimMatrixPathFor, claimMatrixSearchText, claimNeedsReview, claimSources, claimStatuses,
  claimTypeLabel, claimVerificationSummary, isClaimMatrixPath, linkClaimMarkers, parseClaimMatrix, parseClaimMatrixDocument, reportPathForMatrix, safeWorkspacePath, sourceCheckMark, sourceLocationText,
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

  // A tally only when something needs checking (2026-09-23 plan §4).
  it("says once, above the report, how many claims need checking — and nothing when none do", () => {
    const claim = (claimId: string, status: string) => ({ claimId, claimType: "direct", status, sources: [] });
    expect(claimVerificationSummary(null)).toBeNull();
    expect(claimVerificationSummary({ claims: [], counts: {} })).toBeNull();
    expect(claimVerificationSummary({
      claims: [claim("CLM-001", "verified"), claim("CLM-002", "verified")],
      counts: { verified: 2 },
    })).toBeNull();
    const mixed = claimVerificationSummary({
      claims: [claim("CLM-001", "verified"), claim("CLM-002", "quote_not_found"), claim("CLM-003", "source_unavailable"), claim("CLM-004", "derived")],
      counts: { verified: 1, quote_not_found: 1, source_unavailable: 1, derived: 1 },
    });
    expect(mixed?.attention).toBe(true);
    expect(mixed?.text).toBe("⚠ 2 条待核对");
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

  it("reads each source's kind from the domain, keeps a preserved path only when it is a workspace path", () => {
    const { claims, meta } = parseClaimMatrixDocument(JSON.stringify({
      searchCutoff: "2026-09-01",
      limitations: ["仅纳入英文文献", "  "],
      claims: [
        { claimId: "CLM-001", claim: "a", claimType: "direct", referenceNumber: 3, sourceUrl: "https://www.nice.org.uk/guidance/ng196",
          artifactPath: ".evimed-sources/official-pages/abc/page.md", supportQuote: "q" },
        { claimId: "CLM-002", claim: "b", claimType: "direct", sourceType: "rct", artifactPath: "../../etc/passwd", supportQuote: "q" },
        { claimId: "CLM-003", claim: "c", claimType: "direct", artifactPath: "/abs/path.md" },
      ],
    }));
    expect(meta).toEqual({ searchCutoff: "2026-09-01", limitations: ["仅纳入英文文献"] });
    expect(claims.get("CLM-001")).toMatchObject({ sourceType: "guideline", referenceNumber: 3, artifactPath: ".evimed-sources/official-pages/abc/page.md" });
    expect(claims.get("CLM-002")).toMatchObject({ sourceType: "rct" });
    expect(claims.get("CLM-002")?.artifactPath).toBeUndefined();
    expect(claims.get("CLM-003")?.artifactPath).toBeUndefined();
    expect(claims.get("CLM-003")?.sourceType).toBe("other");
  });

  it("knows a matrix file and the report it belongs to", () => {
    expect(isClaimMatrixPath("deliverables/d1/clinical-evidence-matrix.json")).toBe(true);
    expect(isClaimMatrixPath("deliverables/d1/clinical-evidence-report.md")).toBe(false);
    expect(reportPathForMatrix("deliverables/d1/clinical-evidence-matrix.json")).toBe("deliverables/d1/clinical-evidence-report.md");
    expect(safeWorkspacePath("a/./b")).toBeUndefined();
    expect(safeWorkspacePath("a//b")).toBeUndefined();
    expect(safeWorkspacePath("a\\b")).toBeUndefined();
  });

  it("says which quotation to check, by position, when a claim rests on several", () => {
    const [claim] = parseClaimMatrixDocument(JSON.stringify({ claims: [
      { claimId: "CLM-010", claim: "x", claimType: "synthesized", supportingSources: [{ supportQuote: "a" }, { supportQuote: "b" }] },
    ] })).claims.values();
    const verified = { claimId: "CLM-010", claimType: "synthesized", status: "quote_not_found",
      sources: [{ artifactPath: "a.md", status: "verified" }, { artifactPath: "b.md", status: "quote_not_found" }] };
    expect(claimGuidance(claim, verified)).toBe("第 2 段引文没有在保存的原文中找到：请打开原文核对措辞与数字。");
    expect(claimGuidance(claim, { ...verified, status: "verified", sources: [] })).toBeNull();
    const single = { claimId: "CLM-011", claimType: "direct", status: "source_unavailable", sources: [{ artifactPath: null, status: "source_unavailable" }] };
    expect(claimGuidance(undefined, single)).toBe("这段引文的原文没有保存，无法自动核对：请到原始来源核实。");
  });

  it("shows an explicit top-level synthesized quotation in the verification's order and points to its failure", () => {
    const [claim] = parseClaimMatrix(JSON.stringify({ claims: [{
      claimId: "CLM-053", claim: "Two reviews.", claimType: "synthesized",
      artifactPath: ".evimed-sources/a/fulltext.md", supportQuote: "The search ended in June 2019.", sourceTitle: "Earlier review",
      supportingSources: [
        { artifactPath: ".evimed-sources/a/fulltext.md", supportQuote: "The search ended in December 2014.", sourceTitle: "Earlier review" },
        { artifactPath: ".evimed-sources/b/fulltext.md", supportQuote: "Randomized studies were included.", sourceTitle: "Later review" },
      ],
    }] })).values();
    const displayed = claimSources(claim);
    expect(displayed.map((source) => source.supportQuote)).toEqual([
      "The search ended in December 2014.", "Randomized studies were included.", "The search ended in June 2019.",
    ]);
    const verification = claimVerification({ matrix: { claims: [claim] }, sourceArtifacts: {
      ".evimed-sources/a/fulltext.md": "The search ended in December 2014.",
      ".evimed-sources/b/fulltext.md": "Randomized studies were included.",
    } });
    const verdict = verification.claims[0];
    expect(verdict.sources.map((source) => source.artifactPath)).toEqual(displayed.map((source) => source.artifactPath));
    expect(claimGuidance(claim, verdict)).toBe("第 3 段引文没有在保存的原文中找到：请打开原文核对措辞与数字。");
    expect(claimStatuses(verification).get(claim.claimId)).toBe("quote_not_found");
    expect(CLAIM_STATUS_TEXT[verdict.status].tone).toBe("warn");
    expect(claimSources({ ...claim, supportQuote: claim.supportingSources?.[0].supportQuote })).toEqual(claim.supportingSources);
  });

  it.each([
    "./.evimed-sources/a/fulltext.md",
    ".evimed-sources/a/../a/fulltext.md",
    ".evimed-sources/../../outside.md",
  ])("keeps the raw bond at %s visible without making it a file-opening path", (artifactPath) => {
    const raw = {
      claimId: "CLM-053", claim: "Two reviews.", claimType: "synthesized",
      artifactPath, supportQuote: "The search ended in June 2019.", sourceTitle: "Top-level review", identifier: "DOI:10.1000/top",
      supportingSources: [
        { artifactPath: ".evimed-sources/a/fulltext.md", supportQuote: "The search ended in December 2014.", sourceTitle: "Earlier review" },
        { artifactPath: ".evimed-sources/b/fulltext.md", supportQuote: "Randomized studies were included.", sourceTitle: "Later review" },
      ],
    };
    const sourceArtifacts = {
      ".evimed-sources/a/fulltext.md": "The search ended in December 2014.",
      ".evimed-sources/b/fulltext.md": "Randomized studies were included.",
    };
    const verification = claimVerification({ matrix: { claims: [raw] }, sourceArtifacts });
    const [parsed] = parseClaimMatrix(JSON.stringify({ claims: [raw] })).values();
    const displayed = claimSources(parsed);
    expect(displayed.map((source) => source.sourceTitle)).toEqual(claimEvidenceSources(raw).map((source) => source.sourceTitle));
    expect(displayed.map((source) => source.supportQuote)).toEqual(claimEvidenceSources(raw).map((source) => source.supportQuote));
    expect(displayed).toHaveLength(3);
    expect(displayed[2].artifactPath).toBeUndefined();
    expect(displayed[2].identifier).toBe("DOI:10.1000/top");
    expect(verification.claims[0].sources.map((source) => source.status)).toEqual(["verified", "verified", "no_quote"]);
    expect(verification.claims[0].sources[2].artifactPath).toBeNull();
    expect(claimVerification({ matrix: { claims: [parsed] }, sourceArtifacts })).toEqual(verification);
    expect(claimVerificationSummary(verification)?.text).toBe("⚠ 1 条待核对");
    expect(claimGuidance(parsed, verification.claims[0])).toMatch(/^第 3 段引文缺少/);

    const identical = { ...raw, supportQuote: raw.supportingSources[0].supportQuote };
    const [parsedIdentical] = parseClaimMatrix(JSON.stringify({ claims: [identical] })).values();
    expect(claimSources(parsedIdentical)).toHaveLength(claimEvidenceSources(identical).length);
    expect(claimSources({ ...parsed, supportQuote: undefined })).toHaveLength(2);
    const noPath = { ...raw, artifactPath: undefined };
    const [parsedNoPath] = parseClaimMatrix(JSON.stringify({ claims: [noPath] })).values();
    expect(claimSources(parsedNoPath)).toHaveLength(2);
  });
});

describe("where a quotation sits in its source", () => {
  it("says table, row and column, and the page when the text has one", () => {
    expect(sourceLocationText({ status: "located", table: { id: "tbl-1", index: 1, label: "Table 2" }, row: 3, cell: { row: 3, column: 2 }, page: { status: "located", pages: [7] } }))
      .toBe("Table 2 第 3 行第 2 列 · 第 7 页");
    expect(sourceLocationText({ status: "located", table: { id: "tbl-1", index: 1, label: "Table 2" }, row: 3, page: { status: "located", pages: [7, 8] } }))
      .toBe("Table 2 第 3 行 · 第 7、8 页");
    expect(sourceLocationText({ status: "located", table: { id: "sheet-1", index: 1, name: "Table S2" }, cell: { row: 2, column: 3, address: "C2" }, page: { status: "unknown", reason: "no_page_markers" } }))
      .toBe("工作表 Table S2 第 2 行第 3 列 · 页码未知");
  });

  it("says a page is undecided, a table is one of several, and a place is unknown, each as what it is", () => {
    expect(sourceLocationText({ status: "located", table: { id: "tbl-2", index: 2 }, page: { status: "ambiguous", candidates: [3, 9] } })).toBe("第 2 张表 · 页码待定（第 3、9 页之一）");
    expect(sourceLocationText({ status: "ambiguous", candidates: [{ id: "tbl-1", index: 1, label: "Table 2" }, { id: "tbl-4", index: 4 }], page: { status: "unknown" } }))
      .toBe("可能在 Table 2、第 4 张表 · 页码未知");
    // A quotation in prose with a page marker has a page and no table.
    expect(sourceLocationText({ status: "located", page: { status: "located", pages: [3] }, reason: "not_in_a_table" })).toBe("第 3 页");
    expect(sourceLocationText({ status: "unknown", page: { status: "unknown", reason: "no_page_markers" }, reason: "not_in_a_table" })).toBe("位置未知");
    expect(sourceLocationText({ status: "unknown", page: { status: "unknown", reason: "quote_not_verified" }, reason: "quote_not_found" })).toBe("位置未知");
  });

  it("says nothing when no location was computed: an older verification asked nothing, and an unknown it never looked for is not claimed", () => {
    expect(sourceLocationText(undefined)).toBeNull();
    expect(sourceLocationText(null)).toBeNull();
  });
});

describe("the matrix's check mark", () => {
  const direct = { claimType: "direct" };
  const check = (status: string) => ({ claimId: "CLM-001", claimType: "direct", status, sources: [] });

  it("lets a check speak for itself, in any state", () => {
    for (const state of ["loading", "ready", "unavailable"] as const) {
      expect(claimCheckMark(direct, check("verified"), state)).toMatchObject({ kind: "verified", text: "✓ 已核对", tone: "ok" });
    }
    expect(claimCheckMark(direct, check("quote_not_found"))).toMatchObject({ kind: "attention", text: "⚠ 原文中未找到", tone: "warn" });
    expect(claimCheckMark(direct, check("source_unavailable"))).toMatchObject({ kind: "attention", text: "⚠ 原文未保存" });
    expect(claimCheckMark(direct, check("no_quote"))).toMatchObject({ kind: "attention", text: "⚠ 无引文" });
  });

  // 「未核对」 is a statement about the report: it may be made only once the checks were read and this claim is not among them.
  it("says 未核对 only when the checks were read and this claim is not among them", () => {
    expect(claimCheckMark(direct, undefined, "loading").text).toBe("核对中");
    expect(claimCheckMark(direct, undefined, "unavailable").text).toBe("暂无核对结果");
    expect(claimCheckMark(direct, undefined, "ready")).toMatchObject({ kind: "unchecked", text: "未核对" });
    // A status this table does not know reads as unchecked, never as verified.
    expect(claimCheckMark(direct, check("something_new"))).toMatchObject({ kind: "unchecked", text: "未核对" });
  });

  it("knows a derived claim has no quotation to check, whatever the state", () => {
    for (const state of ["loading", "ready", "unavailable"] as const) {
      expect(claimCheckMark({ claimType: "derived" }, undefined, state)).toMatchObject({ kind: "derived", text: "推导，无引文" });
    }
  });

  it("sends everything but a verified or derived claim to review", () => {
    expect(claimNeedsReview(claimCheckMark(direct, check("verified")))).toBe(false);
    expect(claimNeedsReview(claimCheckMark({ claimType: "derived" }, check("derived")))).toBe(false);
    expect(claimNeedsReview(claimCheckMark(direct, check("quote_not_found")))).toBe(true);
    expect(claimNeedsReview(claimCheckMark(direct, undefined, "ready"))).toBe(true);
    expect(sourceCheckMark(undefined).text).toBe("未核对");
  });

  it("names the kind of claim, and folds everything a reader might type into one lower-case string", () => {
    expect(claimTypeLabel("synthesized")).toBe("综合结论");
    expect(claimTypeLabel("something_else")).toBe("结论");
    const claim = parseClaimMatrix(JSON.stringify({ claims: [
      { claimId: "CLM-007", claim: "不降低 MACE。", claimType: "synthesized", supportingSources: [
        { sourceTitle: "ASPREE Trial", identifier: "doi:10.1056/X", supportQuote: "Did Not Result" }, { sourceTitle: "ARRIVE", supportQuote: "event rate" },
      ] },
    ] })).get("CLM-007")!;
    const text = claimMatrixSearchText(claim);
    for (const part of ["clm-007", "mace", "aspree trial", "doi:10.1056/x", "did not result", "arrive", "event rate"]) expect(text).toContain(part);
  });
});
