import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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

test("extractor artefacts in the artifact do not hide a quote that is really there", () => {
  const input = validPackage();
  // A PDF extractor spaces out CJK runs and leaves soft hyphens behind; both are
  // invisible to the agent reading the artifact, so a faithful quote must match.
  input.matrix.claims[0].supportQuote = "The randomized cohort was followed for 12 months.";
  input.sourceArtifacts[".evimed-sources/a/page.md"] +=
    "\nThe random­ized cohort was followed for 12 months.";
  input.matrix.claims[1].supportQuote = "速效救心丸用于缓解胸闷症状。";
  input.sourceArtifacts[".evimed-sources/b/fulltext.md"] += "\n速 效 救 心 丸 用 于 缓 解 胸 闷 症 状 。";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("separator noise inside a preserved sentence does not hide a quote that is really there", () => {
  // All three shapes are from real preserved artifacts: a PDF line break split
  // a word, a markdown list marker landed mid-sentence, and the extractor left
  // a space before the full stop.
  const input = validPackage();
  input.matrix.claims[0].supportQuote = "The positive likelihood ratio for coronary artery disease was 1.1.";
  input.sourceArtifacts[".evimed-sources/a/page.md"] +=
    "\nThe positive likelihood ratio for coronary artery dis - ease was 1.1 .";
  input.matrix.claims[1].supportQuote = "Call 999 if: you get sudden pain in your chest that does not go away.";
  input.sourceArtifacts[".evimed-sources/b/fulltext.md"] +=
    "\nCall 999 if:\n- you get sudden pain in your chest that does not go away.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("an elided quote is verified segment by segment, in the order written", () => {
  const input = validPackage();
  input.sourceArtifacts[".evimed-sources/a/page.md"] +=
    "\nCarriers were at higher risk (OR 1.242). Age and smoking were also recorded."
    + " The genotype frequencies were 48.72, 42.67 and 8.6% in patients.";
  input.matrix.claims[0].supportQuote =
    "Carriers were at higher risk (OR 1.242). ... The genotype frequencies were 48.72, 42.67 and 8.6% in patients.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("an elision cannot reorder the source or invent a segment", () => {
  const base = validPackage();
  base.sourceArtifacts[".evimed-sources/a/page.md"] +=
    "\nCarriers were at higher risk (OR 1.242). The genotype frequencies were 48.72% in patients.";

  const reordered = validPackage();
  reordered.sourceArtifacts = { ...base.sourceArtifacts };
  reordered.matrix.claims[0].supportQuote =
    "The genotype frequencies were 48.72% in patients. ... Carriers were at higher risk (OR 1.242).";
  assert.equal(validateClinicalEvidencePackage(reordered).valid, false, "segments out of source order must fail");

  const invented = validPackage();
  invented.sourceArtifacts = { ...base.sourceArtifacts };
  invented.matrix.claims[0].supportQuote =
    "Carriers were at higher risk (OR 1.242). ... Mortality fell by half in the treated arm.";
  assert.equal(validateClinicalEvidencePackage(invented).valid, false, "a segment absent from the source must fail");
});

test("dropping a comparison operator is not a formatting difference", () => {
  const input = validPackage();
  input.sourceArtifacts[".evimed-sources/a/page.md"] += "\nRisk was reduced by >50% in the treated arm.";
  input.matrix.claims[0].supportQuote = "Risk was reduced by 50% in the treated arm.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false, "\">50%\" and \"50%\" are different findings");
});

test("a quote may omit an inline citation marker the extractor left in the sentence", () => {
  const input = validPackage();
  input.sourceArtifacts[".evimed-sources/a/page.md"] +=
    "\nGTN tolerance was exacerbated in coronary spasm patients.23 Li Jin et al reported the same effect.";
  input.matrix.claims[0].supportQuote =
    "GTN tolerance was exacerbated in coronary spasm patients. Li Jin et al reported the same effect.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("an unmarked join is reported as a join, not as a missing quote", () => {
  // A real run spliced two passages of one paper at "borneol" with no gap mark.
  // Both halves are in the document; the repair is to mark the elision, which
  // "not found in its preserved source artifact" does not tell anyone.
  const input = validPackage();
  input.sourceArtifacts[".evimed-sources/a/page.md"] +=
    "\nCalcium measurement revealed that borneol activated the TRPM8 channel in a dose-dependent manner."
    + " Tear production rose in the treated animals over the following week."
    + " Borneol at micromolar concentrations did not affect the viability of the cultured corneal cells.";
  input.matrix.claims[0].supportQuote =
    "Calcium measurement revealed that borneol activated the TRPM8 channel in a dose-dependent manner."
    + " Borneol at micromolar concentrations did not affect the viability of the cultured corneal cells.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /joins two passages that are not adjacent in the source/);

  // Marking the gap makes the same quotation acceptable.
  input.matrix.claims[0].supportQuote =
    "Calcium measurement revealed that borneol activated the TRPM8 channel in a dose-dependent manner."
    + " … Borneol at micromolar concentrations did not affect the viability of the cultured corneal cells.";
  assert.equal(validateClinicalEvidencePackage(input).valid, true);
});

test("a quote the source does not contain still fails, however it is spaced", () => {
  const input = validPackage();
  // Same words as the artifact except one the source never states.
  input.matrix.claims[0].supportQuote = "The positive likelihood ratio for coronary artery disease was 9.7.";
  input.sourceArtifacts[".evimed-sources/a/page.md"] +=
    "\nThe positive likelihood ratio for coronary artery dis - ease was 1.1 .";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /supportQuote was not found in its preserved source artifact/);
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

test("each register rule reports its own reason and names the sentence to fix", () => {
  // A run repairs the sentence a notice names; "this report is written in the
  // wrong register" is not a repairable instruction, and each of these rules is
  // repaired differently. So each has to fire on its own reason and on nobody
  // else's — if one broadens until it swallows a neighbour, the run is told to
  // rename a heading when what it must do is rewrite a verdict.
  const cases = [
    {
      label: "the brief's vocabulary",
      write: "该问题取自题库，目标答案为可自行常备。",
      expect: /line \d+ uses commissioning vocabulary "题库"/,
    },
    {
      label: "a section named after a pass/fail condition",
      write: "## 论点与判定条件\n证据门槛见下。",
      expect: /line \d+ names a section after an acceptance condition/,
    },
    {
      label: "the acceptance form itself, as a list",
      write: "- 命题 A（可定量）：需分母明确的前瞻性研究。\n- 命题 B（可归因）：需去激发与再激发观察。",
      expect: /lettered propositions with their own pass\/fail conditions at lines \d+, \d+/,
    },
    {
      label: "a verdict on the report's own proposition",
      write: "该角度判定为不足以支持因果归因。",
      expect: /line \d+ delivers a verdict on its own proposition/,
    },
    {
      label: "the report as its own subject",
      write: "本报告检验该问题的学术化版本。",
      expect: /line \d+ writes about itself rather than about the evidence/,
    },
    {
      label: "the runtime's vocabulary",
      write: "该来源的访问层级为摘要，相关工件已保存于本环境。",
      expect: /runtime or retrieval-process prose .*line \d+ reads/,
    },
  ];

  const clean = validateClinicalEvidencePackage(validPackage()).issues.join("\n");
  for (const scenario of cases) {
    assert.doesNotMatch(clean, scenario.expect, `${scenario.label}: fired on a report that is in register`);

    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${scenario.write}\n`);
    const issues = validateClinicalEvidencePackage(input).issues.join("\n");
    assert.match(issues, scenario.expect, scenario.label);
    for (const other of cases) {
      if (other === scenario) continue;
      assert.doesNotMatch(issues, other.expect, `${scenario.label} was also reported as ${other.label}`);
    }
  }
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
      // "胃药缓解不能排除心脏病" states that antacid relief CANNOT rule out a
      // cardiac cause, which is the correct finding — and it was asserted here
      // as something the rule must reject. The rule matched the subject matter
      // rather than the claim, and this test held that mistake in place. Use
      // advice that genuinely tells a reader to self-triage on the response.
      "## 结论与实际处置\n1. 不要自行驾车。\n2. 胃药缓解说明不是心脏病。[claim:CLM-001]",
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

test("accepts a citation ledger whose required columns are present in any order", () => {
  // The header four consecutive production runs were failed for. Nothing stated
  // that the first three columns had to be claimId, referenceNumber,
  // supportQuote positionally, and the preflight the run is told to satisfy
  // never looked — so one run rewrote its header three times, got the first two
  // right, and could not guess the third. Column order carries no meaning here.
  const input = deepResearchPackage();
  const rows = input.citationLedgerText.trim().split("\n");
  input.citationLedgerText = [
    "claimId,referenceNumber,claimType,supportQuoteVerified",
    ...rows.slice(1).map((row) => {
      const [claimId, referenceNumber, ...rest] = row.split(",");
      return [claimId, referenceNumber, "direct", rest.join(" ").replace(/,/g, " ")].join(",");
    }),
  ].join("\n");
  const result = validateClinicalEvidencePackage(input);
  assert.doesNotMatch(result.issues.join("\n"), /citation-ledger\.csv must have a header naming/);
});

test("rejects a citation ledger that never names the columns the cross-check reads", () => {
  const input = deepResearchPackage();
  input.citationLedgerText = input.citationLedgerText.replace(
    "claimId,referenceNumber,supportQuote",
    "claim,source,quote",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  // The message names every column it wants, so the run can act on it.
  assert.match(result.issues.join("\n"), /must have a header naming claimId, referenceNumber and supportQuote/);
});

test("counts ledger records, not lines, when a support quote spans newlines", () => {
  // A csv writer quotes an embedded newline rather than losing it. Counting
  // lines then counted one claim as two, or split a row in half.
  const input = deepResearchPackage();
  const rows = input.citationLedgerText.trim().split("\n");
  input.citationLedgerText = [
    rows[0],
    rows[1].replace(/,([^,]*)$/, ',"first line\nsecond line"'),
    ...rows.slice(2),
  ].join("\n");
  const result = validateClinicalEvidencePackage(input);
  assert.doesNotMatch(result.issues.join("\n"), /citation-ledger\.csv must have a header naming/);
});

test("numeric-audit line numbers point at the line the report actually has there", () => {
  // The audited copy collapsed each removed section to a single newline, so
  // every later line moved up: a 125-line production report was audited as 99
  // lines and "Report line 68" named a blank line in the real file.
  // deepResearchPackage has a 检索与方法 section, which the audit strips, ahead
  // of the line injected below — so a drifting count shows up here.
  const input = deepResearchPackage();
  input.reportText = input.reportText.replace(
    "## 讨论",
    "## 讨论\n\n该疗法使风险增加2.71倍。\n",
  );
  const result = validateClinicalEvidencePackage(input);
  const flagged = result.issues.find((issue) => /^Report line \d+ numeric facts/.test(issue));
  assert.ok(flagged, `expected a numeric-fact issue, got: ${result.issues.join(" | ")}`);
  const lineNumber = Number(/^Report line (\d+)/.exec(flagged)[1]);
  assert.match(input.reportText.split("\n")[lineNumber - 1], /2\.71/);
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
  // The rule forbids ADDING this advice. Its earlier fixture said 不要尝试抗酸药
  // 并等待症状变化 — a prohibition, the same shape as 不可等待观察症状变化, which a
  // real run was flagged for writing. The recommendation is what must be caught.
  const advice = (line) => {
    const input = validPackage();
    input.reportText = input.reportText.replace(
      /## 结论与实际处置[\s\S]*$/,
      [
        "## 结论与实际处置",
        "速效救心丸不应延误急诊评估。[claim:CLM-003]",
        `${line}[claim:CLM-003] ` + "结论必须同时保留临床紧迫性、适用边界和不确定性。".repeat(30),
      ].join("\n"),
    );
    return validateClinicalEvidencePackage(input);
  };

  const recommended = advice("可以先尝试抗酸药并等待症状变化。");
  assert.equal(recommended.valid, false);
  assert.match(recommended.issues.join("\n"), /unsupported advice about antacids or waiting/);

  const forbidden = advice("不要尝试抗酸药并等待症状变化。");
  assert.doesNotMatch(
    forbidden.issues.join("\n"),
    /unsupported advice about antacids or waiting/,
    "telling the reader not to do it is not advising them to",
  );
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

// A package carrying one derived result: the analyst's own estimate, reasoned
// from two quote-anchored claims, stated with its method, assumptions and
// sensitivity, and marked in the report so no reader mistakes it for a measurement.
function packageWithDerivedClaim(overrides = {}) {
  const input = deepResearchPackage();
  const derived = {
    claimId: "CLM-101",
    claimType: "derived",
    claim: "在开盖频率与顶空条件给定时，冰片残余量在 6 个月约为初始值的 78%。",
    method: "以来源报告的室温蒸汽压与密封体系 730 天损失曲线为输入，按一级逸散近似 ln(C/C0) = -k·t 反解 k，再以 6 个月代入，得残余 78%。",
    assumptions: "假设温度恒定 20 ℃、每日开盖 2 次、顶空体积不变、基质不改变逸散路径。",
    sensitivity: "开盖频率翻倍时残余降至约 61%；温度升至 30 ℃ 时该值再降约 9 个百分点。",
    applicability: "仅适用于同类滴丸的密闭玻璃瓶包装，不外推至泡罩包装。",
    uncertainty: "输入曲线来自密封体系，开封后气相边界条件不同，估计值为量级判断而非测定值。",
    derivedFrom: ["CLM-001", "CLM-002"],
    ...overrides,
  };
  input.matrix.claims = [...input.matrix.claims, derived];
  input.reportText = input.reportText.replace(
    "## 讨论\n",
    "## 讨论\n〔推导〕在上述输入下，6 个月冰片残余约为 78%，开盖频率翻倍时约 61%。"
      + " <!-- claim:CLM-101 -->\n",
  );
  return input;
}

test("holds a claim's figures to the same standard as the report's, not a stricter one", () => {
  // The report lines were audited for figures carrying a unit or a statistic,
  // with publication years excluded; the claim text was audited for every
  // integer in it. So "2022年发表的网络meta分析" was reported as the
  // unsupported numeric fact 2022 — a year its citation already carries, and
  // one the report-line audit deliberately ignores.
  const input = validPackage();
  input.matrix.claims[0].claim = "2022年发表的网络meta分析纳入179项随机对照试验。";
  input.matrix.claims[0].supportQuote = "A total of 179 randomized controlled trials were included in this network meta-analysis.";
  input.sourceArtifacts[".evimed-sources/a/page.md"] = input.matrix.claims
    .filter((item) => item.artifactPath.endsWith("page.md"))
    .map((item) => item.supportQuote)
    .join("\n");
  const result = validateClinicalEvidencePackage(input);
  assert.doesNotMatch(result.issues.join("\n"), /numeric fact 2022/);
  // The trial count is a finding and still has to be in the quote.
  assert.doesNotMatch(result.issues.join("\n"), /numeric fact 179/);
});

test("reads a Chinese dosing line as a dose, not as the quantity one", () => {
  // 一次10丸、一日3次 says ten pills, three times a day. The 一 is "per", but
  // against the units 次 and 日 it read as the CJK numeral one, so a faithfully
  // quoted dosing line reported an unsupported numeric fact 1 — three times in
  // one production report.
  const input = validPackage();
  input.matrix.claims[0].claim = "说明书用法为一次10丸、一日3次。";
  input.matrix.claims[0].supportQuote = "The label directs 10 pills per dose, 3 times daily.";
  input.sourceArtifacts[".evimed-sources/a/page.md"] = input.matrix.claims
    .filter((item) => item.artifactPath.endsWith("page.md"))
    .map((item) => item.supportQuote)
    .join("\n");
  const result = validateClinicalEvidencePackage(input);
  assert.doesNotMatch(result.issues.join("\n"), /numeric fact 1\b/);
  // The dose itself is still audited: both figures are in the quote.
  assert.doesNotMatch(result.issues.join("\n"), /numeric fact 10\b/);
  assert.doesNotMatch(result.issues.join("\n"), /numeric fact 3\b/);
});

test("a reference the reader can find resolves, even when another entry cites the same source", () => {
  // De-duplication is how padding is detected, and it was also the denominator
  // for resolution — so a report listing 29 numbered entries, two citing one
  // source, was told its reference 29 "must resolve to a numbered report
  // reference" while entry 29 sat in the list. Two finished production reports
  // were marked unverified for it: 29 entries counted as 28, and 18 as 15.
  const input = deepResearchPackage();
  const lines = input.reportText.split("\n");
  const numbered = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*\d+[.、]\s+\S/.test(line));
  const firstUrl = /https?:\/\/\S+/.exec(lines[numbered[0].index])[0];
  // The last entry now points at the same document as the first: one source,
  // two numbers.
  lines[numbered.at(-1).index] = lines[numbered.at(-1).index].replace(/https?:\/\/\S+/, firstUrl);
  input.reportText = lines.join("\n");

  const result = validateClinicalEvidencePackage(input);
  // Every matrix reference still points at an entry the reader can find.
  assert.doesNotMatch(result.issues.join("\n"), /must resolve to a numbered report reference/);
  assert.doesNotMatch(result.issues.join("\n"), /has no entry for reference/);
  // The padding is still reported — as itself, not as a phantom broken link.
  assert.match(result.issues.join("\n"), /the same source is listed under more than one number/);
});

test("names the reference a claim points at when the list really has no such entry", () => {
  const input = deepResearchPackage();
  input.matrix.claims[0].referenceNumber = 97;
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /has no entry for reference 97/);
});

test("refuses subject labels that are record numbers from the source data", () => {
  // A production analysis of an uploaded hospital extract wrote P90000001,
  // P90000002 and P9000003 through its report and evidence matrix — real
  // PATIENT_IDs with a P stuck on the front, which reads like a pseudonym and
  // is not one. Nobody reading the report can tell, and the person exposed is
  // not the reader.
  const input = validPackage();
  input.reportText = input.reportText.replace(
    "症状不能单独完成病因归类。",
    "P90000001 的浓度高于参考区间上限。",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.blockingIssues.join("\n"), /record numbers \(P90000001\)/);
  assert.match(result.issues.join("\n"), /Assign your own sequential pseudonyms/);
});

test("leaves bibliographic identifiers and short pseudonyms alone", () => {
  const input = validPackage();
  input.reportText = input.reportText
    .replace("症状不能单独完成病因归类。", "P3 与 P12 的浓度可比。")
    + "\n\n综述编号 CD004473 与 PMC9584998 见参考文献。\n";
  const result = validateClinicalEvidencePackage(input);
  assert.doesNotMatch(result.issues.join("\n"), /record numbers/);
});

test("accepts a derived result that shows its inputs, method and sensitivity", () => {
  // The move the gate used to make impossible. A report holding a vapour
  // pressure and a sealed-system loss curve could not put them together,
  // because the estimate's numbers appear in no source — so every run learned
  // to restate sources, declare the gap and stop.
  const result = validateClinicalEvidencePackage(packageWithDerivedClaim());
  assert.equal(result.valid, true, result.issues.join("\n"));
  assert.ok(result.claimIds.includes("CLM-101"));
});

test("requires a derived result to be marked as derived wherever it is asserted", () => {
  const input = packageWithDerivedClaim();
  input.reportText = input.reportText.replace("〔推导〕", "");
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  // Blocking: an estimate a reader takes for a measurement is exactly what they
  // cannot discount for themselves.
  assert.match(result.blockingIssues.join("\n"), /without marking it as derived/);
});

test("keeps derived results out of the practical safety advice", () => {
  const input = packageWithDerivedClaim();
  input.reportText = input.reportText
    .replace(" <!-- claim:CLM-101 -->\n", "\n")
    .replace(
      "## 实际处置",
      "## 实际处置\n〔推导〕按估算 6 个月后残余约 78%，可据此更换。 <!-- claim:CLM-101 -->",
    );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.blockingIssues.join("\n"), /practical advice must rest on measured evidence/);
});

test("the practical section keeps its audits under every name it is written with", () => {
  // The rename is the dangerous kind of change: 临床实践要点 shares no substring
  // with the old 实际处置|实用|怎么办|Practical, so the section would not have
  // failed to match — it would have been absent, and a section that is absent
  // has nothing in it to audit. The derived-result ban is the check to watch,
  // because it is the one that stops an estimate being read as an instruction.
  for (const heading of ["## 安全优先的实际处置", "## 临床实践要点", "## 临床要点"]) {
    const input = packageWithDerivedClaim();
    input.reportText = input.reportText
      .replace(" <!-- claim:CLM-101 -->\n", "\n")
      .replace(
        "## 实际处置",
        `${heading}\n〔推导〕按估算 6 个月后残余约 78%，可据此更换。 <!-- claim:CLM-101 -->`,
      );
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, false, heading);
    assert.match(result.blockingIssues.join("\n"), /practical advice must rest on measured evidence/, heading);
  }
});

test("refuses a derivation that never reaches measured evidence", () => {
  const input = packageWithDerivedClaim({ derivedFrom: ["CLM-102"] });
  input.matrix.claims = [...input.matrix.claims, {
    ...input.matrix.claims.at(-1),
    claimId: "CLM-102",
    derivedFrom: ["CLM-101"],
  }];
  input.reportText = input.reportText.replace(
    "<!-- claim:CLM-101 -->",
    "<!-- claim:CLM-101 --> <!-- claim:CLM-102 -->",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /derived only from other derived claims/);
});

test("audits a derived number against the derivation rather than against a source", () => {
  // The number is in the working, so it passes. Change the prose to a figure
  // the derivation never produces and it is flagged — the discipline moves from
  // "quotable" to "shown", it does not disappear.
  const clean = validateClinicalEvidencePackage(packageWithDerivedClaim());
  assert.doesNotMatch(clean.issues.join("\n"), /numeric facts/);

  const input = packageWithDerivedClaim();
  input.reportText = input.reportText.replace("6 个月冰片残余约为 78%", "6 个月冰片残余约为 43%");
  const result = validateClinicalEvidencePackage(input);
  assert.match(result.issues.join("\n"), /numeric facts .*43/);
});

test("requires a derived claim's method to show the step, not name it", () => {
  const result = validateClinicalEvidencePackage(packageWithDerivedClaim({ method: "按一级动力学估算。" }));
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /method must state the reasoning or calculation/);
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

test("a search retyped into the log without its phrase quotes is the same search", () => {
  const input = deepResearchPackage();
  const executed = JSON.parse(input.searchLogText).queries.map((entry) => entry.query);
  // The run executed a phrase search; the log records the same terms unquoted
  // and respaced. That is transcription, not a search the agent never ran.
  input.executedSearchQueries = executed.map((query, index) =>
    index === 0 ? `"${query.split(" ").join('" "')}"  ` : query,
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
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

test("rejects one document posing as two sources when it was fetched two ways", () => {
  const result = validateClinicalEvidencePackage(
    withSynthesizedClaim((claim) => ({
      ...claim,
      supportingSources: [
        claim.supportingSources[0],
        // Same paper, fetched again by another identifier: a second artifact
        // directory, but the same document behind it.
        { ...claim.supportingSources[1], sourceUrl: claim.supportingSources[0].sourceUrl },
      ],
    })),
  );
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /sourceUrl duplicates another supporting source/);
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

test("every bookkeeping pattern still matches a message the module actually emits", async () => {
  // The classification is by message shape, so rewording a message silently
  // stops it being classified — which is what happened when the gate messages
  // gained an instruction and two patterns were still anchored to the old ends.
  const source = await readFile(new URL("../src/clinicalEvidenceQuality.mjs", import.meta.url), "utf8");
  const block = /const bookkeepingIssuePatterns = Object\.freeze\(\[([\s\S]*?)\n\]\);/.exec(source);
  assert.ok(block, "the pattern list moved");

  // Message templates as the module writes them, with interpolations filled in.
  const emitted = [
    ...[...source.matchAll(/`([^`]*\$\{[^`]*)`/g)].map(([, template]) => template),
    // Messages with nothing to interpolate are plain string literals.
    ...[...source.matchAll(/"([A-Z][^"]{25,200})"/g)].map(([, literal]) => literal),
  ]
    .map((template) => template
      .replaceAll(/\$\{label\}/g, "claims[1]")
      .replaceAll(/\$\{sourceLabel\}/g, "claims[1].supportingSources[0]")
      .replaceAll(/\$\{lineIndex \+ 1\}/g, "26")
      .replaceAll(/\$\{[^}]*\}/g, "459"));

  const patterns = [...block[1].matchAll(/^\s*\/(.+)\/,\s*$/gm)].map(([, body]) => new RegExp(body));
  assert.ok(patterns.length >= 5, `expected the real pattern list, found ${patterns.length}`);

  const dead = patterns.filter((pattern) => !emitted.some((message) => pattern.test(message)));
  assert.deepEqual(dead.map(String), [], "these patterns match no message the module emits");
});

test("the medication-response rule judges the advice, not the discussion of it", async () => {
  // A keyword-proximity rule cannot tell an assertion from its refutation: a
  // report concluding "three studies found relief cannot distinguish cardiac
  // from non-cardiac pain" puts the drug, "relief" and "diagnose" in one
  // sentence exactly as advice recommending it would. Eight production runs
  // were flagged for making precisely the finding the analysis exists to make,
  // and deleting the passage was the cheapest way to comply. The harm lives in
  // the practical answer, so that is what the rule reads.
  const rules = JSON.parse(await readFile(new URL("../src/clinical-safety-rules.json", import.meta.url), "utf8"));
  const rule = rules.rules.find((entry) => entry.id === "medication-response-not-diagnostic");
  assert.equal(rule.kind, "practical_forbidden", "the analysis body must be free to examine the question");
  const pattern = new RegExp(rule.pattern, rule.flags ?? "");

  for (const advice of [
    "先含服硝酸甘油，如果缓解说明是心绞痛，可以先在家观察",
    "若速效救心丸能缓解疼痛，则基本可以排除心梗",
    "通过含服后的反应判断是否需要去医院",
    "含服硝酸甘油后缓解即为心源性，可暂不就医",
  ]) {
    assert.ok(pattern.test(advice), `unsafe self-triage advice must be caught: ${advice}`);
  }

  for (const safe of [
    "不要凭服药反应判断是否需要就医——缓解与否均不能排除或确认心脏病",
    "立即呼叫 120，不要等待观察服药效果",
    "已确诊冠心病者可在呼叫 120 后按说明书含服硝酸甘油，服药不改变呼叫决策",
    // 不得 is the formal prohibition of clinical Chinese and the wording a real
    // run produced. It was absent from the rule's negation vocabulary, so the
    // report was flagged for stating the very rule the gate exists to enforce.
    "不得以服药后胸痛是否缓解来判断是否严重或是否需要去医院",
    "禁止用含服后的缓解情况区分心源性与非心源性胸痛",
    "勿以服药反应判断是否就医",
    // The negation sits between the relief and the inference, not before the
    // drug, so only a guard that reads the span between them exonerates this.
    "含服药物后胸痛是否缓解不能用于判断是否为心脏病或是否需要就医",
    "服药后症状缓解与否不足以判断是否需要去医院",
  ]) {
    assert.ok(!pattern.test(safe), `correct advice must not be flagged: ${safe}`);
  }
});

test("the self-care rule reads a prohibition as a prohibition", async () => {
  // 可 lives inside 不可, 建议 inside 不建议, 先 inside 不要先. Matching the
  // recommendation word inside its own negation turned "不可等待观察症状变化" —
  // the instruction the rule exists to require — into the advice it forbids.
  const rules = JSON.parse(await readFile(new URL("../src/clinical-safety-rules.json", import.meta.url), "utf8"));
  const rule = rules.rules.find((entry) => entry.id === "unsupported-self-care");
  const pattern = new RegExp(rule.pattern, rule.flags ?? "");

  for (const advice of [
    "可以先吃点胃药，观察一下症状",
    "建议先服用抗酸药后再观察症状变化",
    "不妨先等待观察症状是否缓解",
  ]) {
    assert.ok(pattern.test(advice), `unsupported self-care must be caught: ${advice}`);
  }
  for (const safe of [
    "不可等待观察症状变化，应立即拨打 120",
    "不要等待症状缓解，不要自己驾车",
    "不建议等待观察症状变化",
    "切勿先观察症状变化，立即呼叫急救",
  ]) {
    assert.ok(!pattern.test(safe), `a prohibition must not read as advice: ${safe}`);
  }
});

test("the emergency-delay rule accepts the emergency number the skill asks for", async () => {
  // The skill instructs the report to localise the emergency number to 120, and
  // the rule demanded 呼救/急救/就医/评估 — so "不得延误呼叫 120", which is what
  // the skill asked for, failed the check that exists to require it.
  const rules = JSON.parse(await readFile(new URL("../src/clinical-safety-rules.json", import.meta.url), "utf8"));
  const rule = rules.rules.find((entry) => entry.id === "suxiao-must-not-delay-emergency");
  const pattern = new RegExp(rule.pattern, rule.flags ?? "");

  assert.ok(pattern.test("速效救心丸不适用于该场景的急救决策，服用速效救心丸不得延误呼叫 120"));
  assert.ok(pattern.test("服用任何自救药物均不得延误呼叫 120 急救"));
  assert.ok(pattern.test("不得因服用速效救心丸而延误就医"));
  // It must still be a requirement, not a formality.
  assert.ok(!pattern.test("立即呼叫 120，保持坐位"));
  assert.ok(!pattern.test("速效救心丸可用于气滞血瘀型心绞痛"));
});
