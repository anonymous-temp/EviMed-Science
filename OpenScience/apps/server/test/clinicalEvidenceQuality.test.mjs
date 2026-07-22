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
    "药物讨论不能延误急诊评估。[claim:CLM-003] 证据范围应被明确限定。[claim:CLM-004]",
    "",
    "## 科学局限",
    "现有证据对个体诊断存在间接性，且不同地区急救路径存在差异。".repeat(8),
    "",
    "## 结论与实际处置",
    "结论必须同时保留临床紧迫性、适用边界和不确定性。".repeat(30),
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
