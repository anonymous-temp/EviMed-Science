import assert from "node:assert/strict";
import test from "node:test";
import { citationIntegrityIssues, numberedReferenceCount, validateClinicalEvidencePackage } from "../src/clinicalEvidenceQuality.mjs";
import { deepResearchPackage } from "./fixtures/clinicalEvidencePackage.mjs";


function claim(index, domain) {
  return {
    claimId: `CLM-00${index}`,
    claim: `Material clinical proposition ${index}`,
    sourceUrl: `https://${domain}/evidence/${index}`,
    sourceTitle: `Authoritative source ${index}`,
    artifactPath: index % 2 ? ".evimed-sources/a/page.md" : ".evimed-sources/b/fulltext.md",
    identifier: `DOC-${index}`,
    accessLevel: index % 2 ? "official_page" : "full_text",
    supportQuote: `This directly observed source passage supports material clinical proposition number ${index}.`,
    applicability: "The population and emergency-care setting match the question.",
    uncertainty: "Indirectness remains for individual diagnosis.",
  };
}

function validPackage() {
  const claims = [
    claim(1, "professional.heart.org"),
    claim(2, "www.cochrane.org"),
    claim(3, "professional.heart.org"),
    claim(4, "www.cochrane.org"),
  ];
  const reportText = [
    "# 急性胸部压迫感与速效救心丸的证据边界",
    "",
    "## 摘要",
    "急性胸部压迫感需要优先排除时间敏感的心血管急症。".repeat(12),
    "",
    "## 临床问题与鉴别",
    "症状不能单独完成病因归类。[claim:CLM-001] 诊断需要规范评估。[claim:CLM-002]",
    "",
    "## 药物角色",
    "速效救心丸不应延误急诊评估。[claim:CLM-003] 证据范围应被明确限定。[claim:CLM-004]",
    "",
    "## 科学局限",
    "现有证据对个体诊断存在间接性，且不同地区急救路径存在适用性差异。".repeat(8),
    "",
    "## 结论与实际处置",
    "速效救心丸不应延误急诊评估。[claim:CLM-003] "
      + "结论必须同时保留临床紧迫性、适用边界和不确定性。".repeat(30),
  ].join("\n");
  return {
    reportText,
    matrix: { schemaVersion: 1, claims },
    runReceipt: {
      question: "胸部压迫感与速效救心丸应如何处置？",
      status: "succeeded",
      successfulSourceArtifacts: [".evimed-sources/a/page.md", ".evimed-sources/b/fulltext.md"],
      failedSources: [],
      qualityChecks: { claimTraceability: true, contradictionAudit: true, arithmeticAudit: true },
    },
    sourceArtifacts: {
      ".evimed-sources/a/page.md": claims.filter((item) => item.artifactPath.endsWith("page.md")).map((item) => item.supportQuote).join("\n"),
      ".evimed-sources/b/fulltext.md": claims.filter((item) => item.artifactPath.endsWith("fulltext.md")).map((item) => item.supportQuote).join("\n"),
    },
  };
}

test("citation integrity catches what URL hygiene cannot see", () => {
  // Every case here was produced by a real run whose citations all passed the
  // URL check: two entries for one paper under different identifier schemes, an
  // entry declaring itself a copy of another, a marker with no entry, an entry
  // nobody cites, and a claim resting on a source that predates it.
  const report = [
    "WHO 2021 分类已将 IDH 突变列为核心标志 [3]。",
    "另有研究支持这一点 [1][2]，并被后续工作引用 [9]。",
    "",
    "## 参考文献",
    "",
    "[1] Cancer Genome Atlas. N Engl J Med. 2015. https://doi.org/10.1056/NEJMoa1402121",
    "[2] 同 [1] — 同一项分析",
    "[3] Albacker LA, et al. J Clin Oncol. 2018;36(15_suppl):2035. https://doi.org/10.1200/jco.2018.36",
    "[4] Draaisma K, et al. 2015. https://pubmed.ncbi.nlm.nih.gov/26699864/",
    "[5] Draaisma K, et al. Acta Neuropathol Commun. 2015;3:88. PMID: 26699864",
  ].join("\n");

  const issues = citationIntegrityIssues(report);
  const joined = issues.join(" | ");
  assert.match(joined, /\[9\] has no matching entry/);
  assert.match(joined, /Reference \[2\] states that it is the same as another entry/);
  assert.match(joined, /\[4\] and \[5\] are the same work/);
  assert.match(joined, /claim dated 2021 cites only \[3\]/);
  // 2035 is a page number, not a year, and must not be read as one.
  assert.ok(!/2035/.test(joined), `a page number was read as a year: ${joined}`);
});

test("citation integrity stays quiet on a sound bibliography", () => {
  const report = [
    "阿司匹林可降低心血管事件风险 [1]。",
    "一项 2018 年的分析支持这一结论 [2]。",
    "",
    "## 参考文献",
    "",
    "[1] Baigent C, et al. Lancet. 2009;373:1849. https://doi.org/10.1016/S0140-6736(09)60503-1",
    "[2] Zheng SL, Roddick AJ. JAMA. 2019;321(3):277. https://pubmed.ncbi.nlm.nih.gov/30667501/",
  ].join("\n");
  assert.deepEqual(citationIntegrityIssues(report), []);
});

test("a reference floor counts sources, not cross-references to other entries", () => {
  const report = [
    "## 参考文献",
    "",
    "1. Cancer Genome Atlas Research Network. N Engl J Med. 2015. https://doi.org/10.1056/NEJMoa1402121",
    "2. Draaisma K, et al. Acta Neuropathol Commun. 2015;3:88. https://pubmed.ncbi.nlm.nih.gov/26699864/",
    "3. Sanson M, et al. J Clin Oncol. 2009. https://pubmed.ncbi.nlm.nih.gov/19636000/",
    "4. 同 [1] — TCGA LGG 多平台分析",
    "5. See [2] for the cohort detail",
    "6. Ibid. 3",
    "7. 同一篇的重复条目. https://doi.org/10.1056/NEJMoa1402121",
    "8. Mellinghoff IK, et al. N Engl J Med. 2023. https://doi.org/10.1056/NEJMoa2304194",
  ].join("\n");
  // Eight numbered lines, four real sources: three are cross-references to an
  // earlier entry and one repeats entry 1's DOI under different wording.
  assert.equal(numberedReferenceCount(report), 4);
});

test("accepts an academic report only when every material claim is source traceable", () => {
  const result = validateClinicalEvidencePackage(validPackage());
  assert.equal(result.valid, true, result.issues.join("\n"));
  assert.deepEqual(result.claimIds, ["CLM-001", "CLM-002", "CLM-003", "CLM-004"]);
  assert.equal(result.sourceDomains.length, 2);
});

test("rejects metadata inference, generic API citations, missing quotes, and process-log prose", () => {
  const input = validPackage();
  input.matrix.claims[0].accessLevel = "bibliographic_only";
  input.matrix.claims[1].supportQuote = "title only";
  input.matrix.claims[2].sourceUrl = "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/guide";
  input.reportText += "\n## 证据局限与不确定性\nTransport error (GET official source).";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /accessLevel/);
  assert.match(result.issues.join("\n"), /supportQuote/);
  assert.match(result.issues.join("\n"), /public evidence citation/);
  assert.match(result.issues.join("\n"), /operational failure prose/);
});

test("rejects a report whose claim references do not resolve to the evidence matrix", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace("[claim:CLM-004]", "[claim:CLM-999]");
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /CLM-999/);
  assert.match(result.issues.join("\n"), /CLM-004/);
});

test("rejects a support quote that is not present in the claimed source artifact", () => {
  const input = validPackage();
  input.matrix.claims[0].supportQuote = "This passage was invented after retrieval and is absent from the preserved source.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /not found in its preserved source artifact/);
});

test("matches source quotes across typographic quote styles and accepts a complete short official field", () => {
  const input = validPackage();
  input.matrix.claims[0].supportQuote =
    "These pathways allow safe exclusion ('rule out') of myocardial infarction within 1-2 hours.";
  input.sourceArtifacts[".evimed-sources/a/page.md"] +=
    "\nThese pathways allow safe exclusion (“rule out”) of myocardial infarction within 1–2 hours.";
  input.matrix.claims[1].supportQuote = "最近的检索日期：2005年11月。";
  input.sourceArtifacts[".evimed-sources/b/fulltext.md"] += "\n最近的检索日期：2005年11月。";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("rejects runtime-process prose and combined claim markers in the academic report", () => {
  const input = validPackage();
  input.reportText = input.reportText
    .replace("[claim:CLM-001]", "[claim:CLM-001, CLM-002]")
    + "\n本次依据 clinical-evidence-synthesis 契约完成白名单抓取和落盘核验。";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /runtime or retrieval-process prose/);
  assert.match(result.issues.join("\n"), /exactly one claim ID/);
});

test("rejects explanatory objects where the run receipt requires path strings and boolean checks", () => {
  const input = validPackage();
  input.runReceipt.successfulSourceArtifacts = [
    { path: ".evimed-sources/a/page.md" },
    { path: ".evimed-sources/b/fulltext.md" },
  ];
  input.runReceipt.qualityChecks = {
    claimTraceability: { status: "passed" },
    contradictionAudit: { status: "passed" },
    arithmeticAudit: { status: "passed" },
  };
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /Every successful source artifact/);
  assert.match(result.issues.join("\n"), /quality checks must pass/);
});

test("permits an evidence-accessibility limitation but still rejects uncited practical actions and response-based diagnosis", () => {
  const input = validPackage();
  input.reportText = input.reportText
    .replace(/## 科学局限[\s\S]*?(?=\n## 结论与实际处置)/, "## 科学局限\n核心指南全文不可及。")
    .replace(
      /## 结论与实际处置[\s\S]*$/,
      "## 结论与实际处置\n1. 不要自行驾车。\n2. 胃药缓解不能排除心脏病。[claim:CLM-001]",
    );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  // A material evidence-accessibility limit inside the Limitations section is
  // legitimate scientific content, not banned retrieval-process prose.
  assert.doesNotMatch(result.issues.join("\n"), /runtime or retrieval-process prose/);
  assert.match(result.issues.join("\n"), /Every numbered practical-action item/);
  assert.match(result.issues.join("\n"), /Medication response/);
});

test("still bans an evidence-accessibility statement outside the Limitations section", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    "## 药物角色\n速效救心丸不应延误急诊评估。[claim:CLM-003]",
    "## 药物角色\n核心指南全文不可及。速效救心丸不应延误急诊评估。[claim:CLM-003]",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /runtime or retrieval-process prose/);
});

test("rejects a report number absent from every cited claim proposition and source passage", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    "证据范围应被明确限定。[claim:CLM-004]",
    "证据来自 1776 名受试者。[claim:CLM-004]",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /numeric facts? 1776/);
});

test("rejects an unreferenced numeric fact outside the reference list", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    "急性胸部压迫感需要优先排除时间敏感的心血管急症。",
    "现有分析纳入 15 项研究。",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /numeric facts? 15 .*no evidence-matrix claim reference/);
});

test("accepts source years and identifiers in headings and does not confuse adverse reactions with diagnostic response", () => {
  const input = validPackage();
  input.reportText = input.reportText
    .replace("## 药物角色", "## ACC 2022 与 Cochrane CD004473 的药物角色")
    .replace(
      "速效救心丸不应延误急诊评估。[claim:CLM-003]",
      "监管机构基于药品不良反应评估修订了安全信息，不能据此判断胸痛病因。[claim:CLM-003]",
    )
    .replace(
      "证据范围应被明确限定。[claim:CLM-004]",
      "证据边界包括（1）适用人群与（2）照护场景。[claim:CLM-004]",
    );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("rejects a numeric proposition not present in its direct support", () => {
  const input = validPackage();
  input.matrix.claims[0].claim = "The source enrolled 1776 participants.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /claims\[0\]\.claim numeric fact 1776/);
});

test("keeps decimal estimates and confidence intervals atomic during numeric traceability checks", () => {
  const input = validPackage();
  input.matrix.claims[0].claim = "Sensitivity was 99.3% (95% CI 98.5%-99.7%).";
  input.matrix.claims[0].supportQuote = "Sensitivity was 99.3% (95% CI 98.5–99.7%).";
  input.sourceArtifacts[".evimed-sources/a/page.md"] = input.matrix.claims
    .filter((item) => item.artifactPath.endsWith("page.md"))
    .map((item) => item.supportQuote)
    .join("\n");
  input.reportText = input.reportText.replace(
    "症状不能单独完成病因归类。[claim:CLM-001]",
    "Sensitivity was 99.3% (95% CI 98.5%-99.7%). [claim:CLM-001]",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("does not treat table ordinals or parenthesized enumeration as clinical numeric facts", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    "症状不能单独完成病因归类。[claim:CLM-001]",
    [
      "证据边界包括（1）适用人群、（2）照护场景与（3）结局定义。[claim:CLM-001]",
      "| 1 | 立即完成结构化评估 | [claim:CLM-001] |",
    ].join("\n"),
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("resolves Chinese numerals in the report against Arabic numbers in the cited support", () => {
  const input = validPackage();
  input.matrix.claims[0].claim = "The pooled analysis enrolled 1776 participants.";
  input.matrix.claims[0].supportQuote = "A total of 1776 participants were enrolled across the included trials.";
  input.sourceArtifacts[".evimed-sources/a/page.md"] = input.matrix.claims
    .filter((item) => item.artifactPath.endsWith("page.md"))
    .map((item) => item.supportQuote)
    .join("\n");
  input.reportText = input.reportText.replace(
    "症状不能单独完成病因归类。[claim:CLM-001]",
    "该分析共纳入一千七百七十六名受试者。[claim:CLM-001]",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("flags a Chinese-numeral quantity absent from the cited evidence", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    "症状不能单独完成病因归类。[claim:CLM-001]",
    "该分析共纳入一千七百七十六名受试者。[claim:CLM-001]",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /numeric facts? 1776/);
});

test("audits an effect size written with an equals sign or Chinese connective", () => {
  for (const proposition of ["该药显著增加风险（OR=4.2）。[claim:CLM-002]", "风险比为3.8。[claim:CLM-002]"]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("诊断需要规范评估。[claim:CLM-002]", proposition);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, false, proposition);
    assert.match(result.issues.join("\n"), /numeric facts?\s+(?:4\.2|3\.8)/);
  }
});

test("audits a Chinese-unit dose as a conclusory quantity", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace("诊断需要规范评估。[claim:CLM-002]", "推荐每次口服100毫克。[claim:CLM-002]");
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /numeric facts?\s+100/);
});

test("does not let a structural English number-word in the source mask a fabricated report quantity", () => {
  const input = validPackage();
  input.matrix.claims[0].claim = "The review searched multiple electronic databases.";
  input.matrix.claims[0].supportQuote = "We searched three electronic databases without language restriction.";
  input.sourceArtifacts[".evimed-sources/a/page.md"] = input.matrix.claims
    .filter((item) => item.artifactPath.endsWith("page.md"))
    .map((item) => item.supportQuote)
    .join("\n");
  input.reportText = input.reportText.replace(
    "症状不能单独完成病因归类。[claim:CLM-001]",
    "该疗法使风险增加3倍。[claim:CLM-001]",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  // The source's "three databases" is structural (not unit-adjacent) so it must
  // not supply a "3" that would mask the fabricated 3-fold effect.
  assert.match(result.issues.join("\n"), /numeric facts?\s+3\b/);
});

test("rejects a citation ledger whose columns are not in the required positional order", () => {
  const input = deepResearchPackage();
  input.citationLedgerText = input.citationLedgerText.replace(
    "claimId,referenceNumber,supportQuote",
    "claimId,sourceUrl,referenceNumber,supportQuote",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /citation-ledger\.csv must contain a traceability header/);
});

test("does not audit structural numbers that carry no unit or statistic", () => {
  const input = validPackage();
  // A bare enumeration in a line with no claim reference: previously every
  // integer was audited; now only conclusory quantities are.
  input.reportText = input.reportText.replace(
    "## 摘要\n",
    "## 摘要\n本文覆盖 3 个方面并分为两组，共 2 个部分。\n",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("rejects an emergency-call recommendation when the quote only describes symptoms", () => {
  const input = validPackage();
  input.matrix.claims[0].claim = "突发压迫性胸部不适应立即拨打 999 呼叫急救。";
  input.matrix.claims[0].supportQuote = "the pain can feel like squeezing or pressure inside your chest";
  input.matrix.claims[0].identifier = "NHS 999 guidance";
  input.sourceArtifacts[".evimed-sources/a/page.md"] = input.matrix.claims
    .filter((item) => item.artifactPath.endsWith("page.md"))
    .map((item) => item.supportQuote)
    .join("\n");
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /emergency-call action is not present in its direct support/);
});

test("rejects authored retrieval excuses and uncited Chinese practical steps or bullets", () => {
  const input = validPackage();
  input.reportText = input.reportText
    .replace(
      "## 科学局限\n",
      "## 科学局限\n本分析仅基于摘要页面，未触及完整文件。\n",
    )
    .replace(
      /## 结论与实际处置[\s\S]*$/,
      [
        "## 结论与实际处置",
        "**第一步：立即呼叫急救。** [claim:CLM-001]",
        "**第二步：自行驾车前往医院。**",
        "- 服用速效救心丸后继续观察。",
        "不得因服用速效救心丸而延误呼救或急诊评估。[claim:CLM-003]",
      ].join("\n"),
    );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /runtime or retrieval-process prose/);
  assert.match(result.issues.join("\n"), /Every practical-action step or bullet/);
});

test("rejects unsupported antacid or wait-and-see advice in the practical answer", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    /## 结论与实际处置[\s\S]*$/,
    [
      "## 结论与实际处置",
      "速效救心丸不应延误急诊评估。[claim:CLM-003]",
      "不要尝试抗酸药并等待症状变化。[claim:CLM-003] "
        + "结论必须同时保留临床紧迫性、适用边界和不确定性。".repeat(30),
    ].join("\n"),
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /unsupported advice about antacids or waiting/);
});

test("rejects an unrequested medicine and exclusive safety language", () => {
  const input = validPackage();
  input.runReceipt.question = "胸口突然发闷发紧，该先怎么办？";
  input.reportText += "\n这是唯一正确的处置策略。";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /medicine-free question/);
  assert.match(result.issues.join("\n"), /exclusive safety claim/);
});

test("recognizes diagnostic-accuracy and jurisdiction language as limitation dimensions", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    /## 科学局限[\s\S]*?(?=\n## 结论与实际处置)/,
    "## 科学局限\n公共页面未报告症状鉴别的敏感度、特异度或似然比；医疗体系与管辖权差异也限制直接适用性。",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("matches ordinal suffixes and zero-padded dates in direct numeric support", () => {
  const input = validPackage();
  input.matrix.claims[0].claim = "Serial assessment should not rely only on the 99 percentile threshold.";
  input.matrix.claims[0].supportQuote = "Serial measurements rather than use of the 99th percentile threshold are essential.";
  input.matrix.claims[1].claim = "The page review date was 8 August 2023.";
  input.matrix.claims[1].supportQuote = "Page last reviewed: 08 August 2023";
  input.sourceArtifacts[".evimed-sources/a/page.md"] = input.matrix.claims
    .filter((item) => item.artifactPath.endsWith("page.md"))
    .map((item) => item.supportQuote)
    .join("\n");
  input.sourceArtifacts[".evimed-sources/b/fulltext.md"] = input.matrix.claims
    .filter((item) => item.artifactPath.endsWith("fulltext.md"))
    .map((item) => item.supportQuote)
    .join("\n");
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("accepts a traceable deep-research package without editorial count quotas", () => {
  const input = deepResearchPackage();
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
  assert.equal(result.claimIds.length, 18);
  assert.equal(result.sourceDomains.length, 3);
});

test("rejects documented deep-research queries that were not successfully executed in the same run", () => {
  const input = deepResearchPackage();
  input.executedSearchQueries = JSON.parse(input.searchLogText).queries
    .slice(0, 7)
    .map((entry) => entry.query);
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /must exactly match successful evidence-search calls/);
});

test("allows the same query text to be run against different source classes", () => {
  const input = deepResearchPackage();
  const search = JSON.parse(input.searchLogText);
  search.queries[1].query = search.queries[0].query;
  input.searchLogText = JSON.stringify(search);
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("accepts compound numbered citations when each hidden claim resolves on the same line", () => {
  const input = deepResearchPackage();
  const first = input.matrix.claims[0];
  const second = input.matrix.claims[1];
  const firstLine = `${first.claim} [${first.referenceNumber}](${first.sourceUrl}) <!-- claim:${first.claimId} -->`;
  const secondLine = `${second.claim} [${second.referenceNumber}](${second.sourceUrl}) <!-- claim:${second.claimId} -->`;
  input.reportText = input.reportText.replace(
    `${firstLine}\n\n${secondLine}`,
    `${first.claim} ${second.claim} [1,2] <!-- claim:${first.claimId} --><!-- claim:${second.claimId} -->`,
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("rejects a report that puts its practical answer after the reference list", () => {
  const input = deepResearchPackage();
  const practicalStart = input.reportText.indexOf("## 实际处置");
  const referencesStart = input.reportText.indexOf("## 参考文献");
  const practical = input.reportText.slice(practicalStart, referencesStart).trim();
  const references = input.reportText.slice(referencesStart).trim();
  input.reportText = `${input.reportText.slice(0, practicalStart).trim()}\n\n${references}\n\n${practical}`;
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /reference list must follow/);
});

test("rejects an internally inconsistent package that falsely claims the deep-research profile", () => {
  const input = deepResearchPackage();
  input.reportText = validPackage().reportText;
  input.matrix.claims = input.matrix.claims.slice(0, 4);
  input.searchLogText = JSON.stringify({
    schemaVersion: 1,
    queries: [{ database: "PubMed", query: "chest pain" }],
    screening: { recordsIdentified: 4, recordsAfterDeduplication: 2, sourcesIncluded: 2 },
    sourceRecords: [],
  });
  input.referencesText = "@article{one, pmid = {1}}";
  input.citationLedgerText = "claimId,referenceNumber,supportQuote";
  input.citationAuditText = "No audit.";
  input.runReceipt.successfulSourceArtifacts = input.runReceipt.successfulSourceArtifacts.slice(0, 2);
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  const issues = result.issues.join("\n");
  assert.match(issues, /at least two distinct evidence databases or source classes/);
  assert.match(issues, /internally consistent screening flow/);
  assert.match(issues, /reference list must follow/);
  assert.match(issues, /one row per evidence-matrix claim/);
  assert.match(issues, /citation-audit.md must document/);
});

test("does not count companion Markdown and XML files as distinct preserved sources", () => {
  const input = deepResearchPackage();
  const duplicated = input.runReceipt.successfulSourceArtifacts.slice(0, 4).flatMap((path) => {
    const root = path.replace(/\/content\.md$/, "");
    return [`${root}/fulltext.md`, `${root}/fulltext.xml`];
  });
  input.runReceipt.successfulSourceArtifacts = duplicated;
  input.runReceipt.stats.distinctPreservedSources = 4;
  input.sourceArtifacts = Object.fromEntries(duplicated.map((path, index) => [
    path,
    `Distinct source passage ${index + 1} with enough supporting text.`,
  ]));
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  const issues = result.issues.join("\n");
  assert.match(issues, /companion XML and Markdown files cannot be counted twice/);
});

test("classifies a citation-audit-documentation-only failure as degradable, not blocking", () => {
  const input = deepResearchPackage();
  // Drop only the correction/retraction line, so the sole failure is the
  // citation-audit documentation-completeness check — a process-documentation
  // gap that cannot mask a clinical error.
  input.citationAuditText = input.citationAuditText.replace(
    "Correction and retraction checks: no correction or retraction notice was identified for the included records.\n\n",
    "",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /citation-audit\.md must document/);
  assert.deepEqual([...result.blockingIssues], []);
});

test("classifies a fabricated support quote as a blocking failure", () => {
  const input = deepResearchPackage();
  input.matrix.claims[0].supportQuote = "This passage was never present in any preserved source artifact.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.ok(result.blockingIssues.length > 0);
  assert.match(result.blockingIssues.join("\n"), /was not found in its preserved source artifact/);
});

test("cross-checks the citation ledger's reference numbers against the matrix", () => {
  const input = deepResearchPackage();
  // Corrupt one ledger row's reference number so it disagrees with the matrix.
  input.citationLedgerText = input.citationLedgerText.replace("CLM-001,1,", "CLM-001,99,");
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /citation-ledger\.csv rows must match each evidence-matrix claim/);
  assert.deepEqual([...result.blockingIssues], []); // supporting-doc gap stays degradable
});

test("cross-checks references.bib against every cited source URL", () => {
  const input = deepResearchPackage();
  // Blank one entry's URL so a cited source has no bibliography URL match.
  input.referencesText = input.referencesText.replace(
    "  url = {https://pubmed.ncbi.nlm.nih.gov/evidence/source-1}",
    "  url = {}",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /references\.bib must contain a bibliography entry for every cited source URL/);
  assert.deepEqual([...result.blockingIssues], []);
});

test("requires the citation audit to name a real audited source identifier", () => {
  const input = deepResearchPackage();
  input.citationAuditText = input.citationAuditText.replace("(for example PMID 900001) ", "");
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /citation-audit\.md must reference at least one real audited source identifier/);
  assert.deepEqual([...result.blockingIssues], []);
});


// --- Synthesized (cross-source) claims ---------------------------------------

function withSynthesizedClaim(mutate = (claim) => claim) {
  const input = deepResearchPackage();
  const claim = mutate({
    claimId: "CLM-019",
    claimType: "synthesized",
    claim: "跨来源综合显示，2 项独立来源一致支持安全优先的分层评估路径。",
    confidence: "moderate",
    applicability: "适用于急性胸部压迫感的院前分层语境。",
    uncertainty: "综合方向受纳入来源数量限制。",
    referenceNumber: 1,
    referenceNumbers: [1, 2],
    supportingSources: [
      {
        sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/evidence/source-1",
        sourceTitle: "Verified clinical source 1",
        artifactPath: ".evimed-sources/source-1/content.md",
        accessLevel: "full_text",
        supportQuote: "Verified source passage 1 directly supports the corresponding bounded clinical statement.",
      },
      {
        sourceUrl: "https://www.acc.org/evidence/source-2",
        sourceTitle: "Verified clinical source 2",
        artifactPath: ".evimed-sources/source-2/content.md",
        accessLevel: "full_text",
        supportQuote: "Verified source passage 2 directly supports the corresponding bounded clinical statement.",
      },
    ],
  });
  input.matrix.claims.push(claim);
  input.reportText = input.reportText.replace(
    "## 讨论",
    "跨来源综合显示，2 项独立来源一致支持安全优先的分层评估路径。[1](https://pubmed.ncbi.nlm.nih.gov/evidence/source-1) <!-- claim:CLM-019 -->\n\n## 讨论",
  );
  input.citationLedgerText += `\nCLM-019,1,"${claim.supportingSources[0].supportQuote}"`;
  return input;
}

test("accepts a synthesized cross-source claim with a verifiable source count", () => {
  const result = validateClinicalEvidencePackage(withSynthesizedClaim());
  assert.equal(result.valid, true, result.issues.join("\n"));
  assert.ok(result.claimIds.includes("CLM-019"));
});

test("rejects a synthesized claim resting on a single source", () => {
  const result = validateClinicalEvidencePackage(
    withSynthesizedClaim((claim) => ({ ...claim, referenceNumbers: [1, 2], supportingSources: [claim.supportingSources[0]] })),
  );
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /supportingSources must name at least two distinct sources/);
});

test("rejects a synthesized claim whose source count exceeds its sources", () => {
  const result = validateClinicalEvidencePackage(
    withSynthesizedClaim((claim) => ({ ...claim, claim: "跨来源综合显示，5 项研究一致支持该路径。" })),
  );
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /not a verifiable source count/);
});

test("rejects a synthesized claim without a confidence label", () => {
  const result = validateClinicalEvidencePackage(
    withSynthesizedClaim((claim) => {
      const { confidence: _confidence, ...rest } = claim;
      return rest;
    }),
  );
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /confidence must be one of high, moderate, low/);
});

test("rejects a synthesized claim when a supporting quote is absent from its artifact", () => {
  const result = validateClinicalEvidencePackage(
    withSynthesizedClaim((claim) => ({
      ...claim,
      supportingSources: [
        claim.supportingSources[0],
        { ...claim.supportingSources[1], supportQuote: "A passage invented after retrieval that the source never stated." },
      ],
    })),
  );
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /supportingSources\[1\]\.supportQuote was not found in its preserved source artifact/);
});

test("rejects a synthesized claim whose primary reference is not among its referenceNumbers", () => {
  const result = validateClinicalEvidencePackage(
    withSynthesizedClaim((claim) => ({ ...claim, referenceNumber: 3 })),
  );
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /referenceNumber must be one of its referenceNumbers/);
});
