import assert from "node:assert/strict";
import test from "node:test";
import { validateClinicalEvidencePackage } from "../src/clinicalEvidenceQuality.mjs";


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

test("rejects runtime-process prose, overlong titles, and combined claim markers in the academic report", () => {
  const input = validPackage();
  input.reportText = input.reportText
    .replace(/^# .+$/m, `# ${"过长的临床学术题目".repeat(6)}`)
    .replace("[claim:CLM-001]", "[claim:CLM-001, CLM-002]")
    + "\n本次依据 clinical-evidence-synthesis 契约完成白名单抓取和落盘核验。";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /no longer than 40/);
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

test("rejects access-failure limitations, uncited practical actions, and response-based diagnosis", () => {
  const input = validPackage();
  input.reportText = input.reportText
    .replace(/## 科学局限[\s\S]*?(?=\n## 结论与实际处置)/, "## 科学局限\n核心指南全文不可及。")
    .replace(
      /## 结论与实际处置[\s\S]*$/,
      "## 结论与实际处置\n1. 不要自行驾车。\n2. 胃药缓解不能排除心脏病。[claim:CLM-001]",
    );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /runtime or retrieval-process prose/);
  assert.match(result.issues.join("\n"), /Every numbered practical-action item/);
  assert.match(result.issues.join("\n"), /Medication response/);
  assert.match(result.issues.join("\n"), /Scientific limitations/);
});

test("rejects a report number absent from every cited claim proposition and source passage", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    "证据范围应被明确限定。[claim:CLM-004]",
    "证据来自 1776 名受试者。[claim:CLM-004]",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /numeric fact 1776/);
});

test("rejects an unreferenced numeric fact outside the reference list", () => {
  const input = validPackage();
  input.reportText = input.reportText.replace(
    "急性胸部压迫感需要优先排除时间敏感的心血管急症。",
    "现有分析纳入 15 项研究。",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /numeric fact 15 has no evidence-matrix claim reference/);
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
