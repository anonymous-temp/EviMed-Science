import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  briefCollapse,
  briefTermPresent,
  citationIntegrityIssues,
  clinicalEvidencePackageErrorCode,
  numberedReferenceCount,
  validateClinicalEvidencePackage as validatePackage,
} from "../src/clinicalEvidenceQuality.mjs";
import { deepResearchPackage, questionCoverageLedger, researchBrief } from "./fixtures/clinicalEvidencePackage.mjs";

/** The question-coverage ledger cites report line numbers, and almost every
 *  case below edits the report. Rebuild it against the report the case actually
 *  built, so a case about a quotation is not failed over a stale line number;
 *  a case whose subject is the ledger sets `keepCoverage` and supplies its own.
 *  @param {any} input */
function validateClinicalEvidencePackage(input) {
  return validatePackage(input?.keepCoverage
    ? input
    : { ...input, questionCoverageText: questionCoverageLedger(input?.reportText, input?.searchLogText) });
}


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
    {
      label: "the traceability device pasted into the body",
      write: "该说明书对给药途径有明确表述。原文：sublingual administration is preferred",
      expect: /line \d+ pastes a source quotation into the body behind a 原文： label/,
    },
    {
      label: "a paragraph of the source's own language",
      write: "the relief of chest pain by nitroglycerin should not be used as a diagnostic factor in the evaluation of undifferentiated chest pain",
      expect: /line \d+ carries \d+ consecutive words of untranslated source prose/,
    },
    {
      label: "a gap answered as a counter-finding",
      write: "未检索到该药在院外自救场景的直接证据，因此不推荐使用。",
      expect: /line \d+ turns absent evidence into a counter-finding/,
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

test("a paper does not announce whom it is written for", () => {
  // 本文以临床医师与药师为读者 opened a delivered report and no rule here saw it:
  // it is the same self-reference as 本报告检验……的学术化版本, in the one shape
  // the pattern did not cover. What a reader needs is which population and
  // setting the conclusions apply to, which is 资料与方法 and 讨论.
  const declared = validPackage();
  declared.reportText = declared.reportText.replace(
    "## 药物角色\n",
    "## 药物角色\n本文以临床医师与药师为读者，系统检索并评价上述问题所依赖的证据。\n",
  );
  const issues = validateClinicalEvidencePackage(declared).issues.join("\n");
  assert.match(issues, /line \d+ writes about itself rather than about the evidence/);
  assert.match(issues, /never announces whom it is written for/);

  // The same words describe a study population, studied material, and ordinary
  // methods prose. Rejecting those sends the run back to break something right.
  for (const write of [
    "本研究以急性胸痛患者为研究对象，以症状缓解时间为主要结局。",
    "该科普材料的受众对象为老年人，其阅读理解水平限制了信息传递效果。",
    "本文提示读者注意个体差异对结论外推的影响。",
    "本文面向未分化急性胸痛这一临床场景，讨论两种自救用药的证据位置。",
    "本文以内容正确性（指南符合度、误分诊率、漏诊比例）为评价终点。",
    "本文系统检索并评价上述问题所依赖的证据，并给出可支持的结论边界。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${write}\n`);
    assert.equal(validateClinicalEvidencePackage(input).valid, true, write);
  }
});

test("every door of the readership rule is anchored to the paper", () => {
  // 本文以临床医师与药师为读者 is the production line, rejected above. These are
  // the same declaration in the shapes a run reaches for once it is told to
  // delete that one — 面向, 写给, and the target-reader field a template leaves
  // behind. Each is a separate branch of the pattern; a branch that is missing
  // reads as "fixed" to the run and comes back in the next report.
  for (const write of [
    "本文面向临床医师与药师，说明两种院外自救用药的证据位置。",
    "本报告的目标读者为基层全科医师。",
    "本综述写给临床药师参考。",
    "本研究的受众对象为急诊科医师。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${write}\n`);
    const issues = validateClinicalEvidencePackage(input).issues.join("\n");
    assert.match(issues, /line \d+ writes about itself rather than about the evidence/, write);
    assert.match(issues, /never announces whom it is written for/, write);
  }

  // The same verbs with something other than this paper as their subject. Whom a
  // guideline was written for is a property of the guideline, and whom a leaflet
  // is aimed at is a finding about the leaflet — both are analysis, and both
  // would be destroyed by a rule that read the verb instead of the subject.
  for (const write of [
    "该指南面向基层医疗机构医师制定，其推荐强度与证据等级分列。",
    "该科普手册写给患者家属参考，其内容未经系统评价。",
    "该问卷的目标读者为门诊候诊患者，与本文纳入人群不一致。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${write}\n`);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, true, `${write}: ${result.issues.join("\n")}`);
  }
});

test("the pasted quotation is rejected under either label and either colon", () => {
  // The first line is verbatim from the returned report. Nine passages arrived
  // like this, three of them in one paragraph, and the label is what makes them
  // trivially repairable: 原句 and an ASCII colon are the two spellings a run
  // reaches for once it is told to stop writing 原文：, so the rule reads all of
  // them or the same paragraph comes back wearing a different label.
  for (const write of [
    "原文：the recommended doses of NTG include sublingual or spray (0.3 to 0.6 mg) every 5 minutes up to a maximum of 3 doses",
    "原句：sublingual administration is preferred",
    "该说明书对给药途径有明确表述。原文: sublingual administration is preferred",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${write}\n`);
    assert.match(
      validateClinicalEvidencePackage(input).issues.join("\n"),
      /pastes a source quotation into the body behind a 原文： label/,
      write,
    );
  }

  // The repair the skill prescribes for exactly these lines: the finding in the
  // paper's own voice with its citation, and the wording quoted only where the
  // wording is itself what is being analysed.
  for (const write of [
    "指南推荐对仍有缺血症状者舌下含服硝酸甘油。[claim:CLM-003]",
    "该说明书将适应症限定为“气滞血瘀型冠心病心绞痛”，未涵盖未分化急性胸痛。[claim:CLM-004]",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${write}\n`);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, true, `${write}: ${result.issues.join("\n")}`);
  }
});

test("a results paragraph keeps the Latin script the field writes in", () => {
  // The cases above test one construction per report. A real results paragraph
  // carries several at once — two appraisal instruments, a journal, an INN
  // beside its Chinese name, an abbreviation expanded at first use, a variant
  // identifier, and the statistics themselves — and a rule that counted Latin
  // words across the paragraph rather than within one uninterrupted run would
  // reject it. The figures cite the claim that states them, as any number in the
  // body must.
  const input = validPackage();
  const quote = "In this cohort the response rate was 50.6% among carriers and 79.4% among non-carriers "
    + "(RR 0.82, 95% CI 0.75-0.90, P < 0.01).";
  input.matrix.claims[0].supportQuote = quote;
  input.sourceArtifacts[".evimed-sources/a/page.md"] += `\n${quote}`;
  input.reportText = input.reportText.replace(
    "## 药物角色\n",
    "## 药物角色\n"
      + "证据体按 GRADE 判定证据确定性为低，不良反应因果关系采用 Naranjo 量表进行因果关系判定。\n"
      + "该研究发表于 Frontiers in Pharmacology，评价硝酸甘油（nitroglycerin, NTG）在急性冠脉综合征"
      + "（acute coronary syndrome, ACS）中的症状缓解。\n"
      + "携带 ALDH2 rs671 变异者的缓解率为 50.6%，非携带者为 79.4%（RR 0.82，95%CI 0.75–0.90，P < 0.01）。"
      + "[claim:CLM-001]\n",
  );
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
});

test("the reference list is untranslated by definition, and it is the only section that is", () => {
  // A bibliography is written in the sources' language; that is what a
  // bibliography is. The exemption is therefore the section and not the string —
  // the same title one section earlier is precisely the pasted source prose the
  // rule exists for, and exempting the words would leave no rule behind.
  const title = "Sublingual nitroglycerin versus placebo for the relief of ischaemic chest pain in the "
    + "prehospital setting: a multicentre randomised controlled trial";

  const listed = validPackage();
  listed.reportText += `\n\n## 参考文献\n1. Zhang L, Wang Y, et al. ${title}. Lancet. 2023. https://doi.org/10.1000/prehospital.ntg\n`;
  const cited = validateClinicalEvidencePackage(listed);
  assert.equal(cited.valid, true, cited.issues.join("\n"));

  const body = validPackage();
  body.reportText = body.reportText.replace("## 药物角色\n", `## 药物角色\n${title}。\n`);
  assert.match(
    validateClinicalEvidencePackage(body).issues.join("\n"),
    /carries \d+ consecutive words of untranslated source prose/,
  );
});

test("untranslated source prose is rejected; names, statistics and short quotations are not", () => {
  // A verbatim quote is checked against its artifact in the matrix and the
  // ledger. In the body nothing checks it, and nine of them stood in one
  // delivered report — three in a single paragraph, introduced by 原文：.
  //
  // The threshold is twelve consecutive Latin words. The longest strings a
  // Chinese manuscript legitimately carries untranslated are proper names and
  // their expansions (PRISMA and STROBE at eight words, a chest-pain guideline
  // title at nine), and those are exempt as Title Case as well.
  for (const write of [
    "该说明书将适应症限定为“气滞血瘀型冠心病心绞痛”，未涵盖未分化急性胸痛。",
    "主要终点为主要不良心血管事件（major adverse cardiovascular events, MACE）。",
    "报告规范遵循 Preferred Reporting Items for Systematic Reviews and Meta-Analyses (PRISMA) 流程。",
    "观察性研究报告遵循 Strengthening the Reporting of Observational Studies in Epidemiology (STROBE) 声明。",
    "2021 AHA/ACC/ASE/CHEST/SAEM/SCCT/SCMR Guideline for the Evaluation and Diagnosis of Chest Pain in the Emergency Department 将胸痛缓解排除在诊断依据之外。",
    "该研究发表于 New England Journal of Medicine，采用双盲设计。",
    "不良反应因果关系采用 Naranjo 量表与 WHO-UMC 标准评定。",
    "硝酸甘油（glyceryl trinitrate, nitroglycerin, GTN）经舌下黏膜吸收。",
    "ALDH2 rs671 变异在东亚人群中的携带率显著高于欧洲人群。",
    "原文报告 Jadad 评分较低，随机方法与分配隐藏均未描述。",
    "该指南原文为英文，本文按术语表统一译名后引用。",
    "检索式为 (\"acute chest pain\"[MeSH] OR \"chest discomfort\"[tiab]) AND (\"nitroglycerin\"[MeSH] OR \"prehospital\"[tiab]) NOT \"review\"[pt]。",
    "说明书适应症英文原句为 “for the treatment of angina pectoris due to coronary artery disease”，未涵盖未分化胸痛。",
    // Enumerations of technical terms run past twelve words without being a
    // sentence, and they are lowercase, so Title Case does not exempt them.
    // A drug class listed by INN, a signalling cascade named molecule by
    // molecule, and a list of endpoint definitions are all ordinary manuscript
    // content — the mechanism list especially, since the report is asked to
    // bridge from mechanism when direct evidence is thin.
    "硝酸酯类包括 isosorbide dinitrate, isosorbide mononitrate, nitroglycerin, glyceryl trinitrate, pentaerythritol tetranitrate, erythrityl tetranitrate, amyl nitrite, sodium nitroprusside 等。",
    "该通路依次涉及 nitric oxide, cyclic guanosine monophosphate, soluble guanylate cyclase, protein kinase G, myosin light chain phosphatase 等分子。",
    "结局指标包括 major adverse cardiovascular events, all-cause mortality, cardiovascular mortality, recurrent myocardial infarction, target-vessel revascularization。",
    "该制剂主要成分为 borneol, notoginseng total saponins, ginsenoside Rb1, ginsenoside Rg1, notoginsenoside R1, panax notoginseng extract 等。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${write}\n`);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, true, `${write}: ${result.issues.join("\n")}`);
  }

  // A quotation long enough to be a paragraph is not a short quotation, and
  // quotation marks do not make it one.
  const quoted = validPackage();
  quoted.reportText = quoted.reportText.replace(
    "## 药物角色\n",
    "## 药物角色\n说明书写道 “the recommended doses of nitroglycerin include sublingual or spray administration every five "
      + "minutes up to a maximum of three doses in patients with ongoing ischemic symptoms”。\n",
  );
  assert.match(
    validateClinicalEvidencePackage(quoted).issues.join("\n"),
    /carries \d+ consecutive words of untranslated source prose/,
  );
});

test("absent evidence may be written as a gap but never as a counter-finding", () => {
  // 未检索到直接证据 is insufficient evidence to judge. Summarised into 无效 or
  // 不推荐使用 it states a negative finding the report never made — and the
  // correct writing contains the same words, so the rule reads the sentence:
  // the failed search, then a causal connective, then a verdict on the drug.
  for (const write of [
    "未检索到支持其用于该场景的直接证据。",
    "未检索到在未分化急性胸痛院外自救场景中以临床结局为终点的随机对照研究，现有证据不足以判断其在该场景的效能。",
    "缺乏头对头比较研究，因此两药的相对效能尚不能判断。",
    "现有报告仅提供用药与症状的时间关联，缺少去激发与再激发观察及标准化因果关系评定，故不足以支持因果归因。",
    "未检索到证据表明该药在该场景无效，也未检索到证据支持其有效。",
    "该指南因缺乏随机对照证据，不推荐将其常规用于未分化胸痛。",
    "未检索到两者在该场景的头对头比较，因此本文不推荐读者据此排序两药。",
    // The repair the skill prescribes, verbatim: the failed search, then the
    // study that would answer the question. It contains every word the rejected
    // form contains, so a run that follows the instruction and is rejected for
    // it is sent back to write the same sentence again.
    "未检索到支持其用于该场景的直接随机对照证据；能够回答该问题的研究应为以院外未分化胸痛人群为对象、以临床结局为终点的随机对照试验。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${write}\n`);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, true, `${write}: ${result.issues.join("\n")}`);
  }
  for (const write of [
    "未检索到直接证据，故该药无效。",
    "未检索到该药在院外自救场景的直接证据，因此不推荐使用。",
    "缺乏头对头随机对照证据，因而不推荐将其用于急性胸痛自救。",
    // The flat form of the verdict, and one where the recommendation verb keeps
    // its object elsewhere in the clause: the error is the inference from an
    // empty search, not any single verb.
    "未检索到直接证据，所以该药无疗效。",
    "未检索到随机对照试验证据，故不应使用于院外自救。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${write}\n`);
    assert.match(
      validateClinicalEvidencePackage(input).issues.join("\n"),
      /turns absent evidence into a counter-finding/,
      write,
    );
  }
});

test("a comparison the title announces is carried out on fixed axes", () => {
  // The defect the commissioned report was returned for: the title promised a
  // comparison of two medicines, the body reviewed each one's literature in
  // turn, and the closing verdict came from whichever arm had the thinner file.
  // Only the absence of the matrix is decidable — which columns are the arms is
  // not readable from the text — so a table with an axis column and one column
  // per arm is what is required, and nothing is asserted about its rows.
  const missing = validPackage();
  missing.reportText = missing.reportText.replace(
    "# 急性胸部压迫感与速效救心丸的证据边界",
    "# 急性胸痛院外自救用药的证据评价：速效救心丸与含服硝酸酯的比较",
  );
  const result = validateClinicalEvidencePackage(missing);
  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /titled as a comparison .* but no table in the analysis body/s);
  assert.match(result.issues.join("\n"), /核准适用场景/);

  // The repair, in both layouts a comparison table is written in: axes as rows
  // with an arm per column, and the transposed form with the arms as rows.
  for (const table of [
    [
      "| 维度 | 速效救心丸 | 含服硝酸酯 | 该维度可支持的结论边界 |",
      "| --- | --- | --- | --- |",
      "| 核准适用场景 | 气滞血瘀型冠心病心绞痛 | 心绞痛发作的急性缓解 | 只能判断用法是否落在核准范围内 |",
      "| 急性按需使用证据 | 未检索到以急性缓解时间为结局的随机对照研究 | 已确诊心绞痛发作人群 | 可分别陈述，不足以排序 |",
      "| 是否存在直接比较研究 | 未检索到头对头研究 | 同上 | 该空缺本身是结果 |",
    ],
    [
      "| 干预 | 核准适用场景 | 急性按需使用证据 | 是否存在直接比较研究 |",
      "| --- | --- | --- | --- |",
      "| 速效救心丸 | 气滞血瘀型冠心病心绞痛 | 未检索到急性缓解时间的随机对照研究 | 未检索到头对头研究 |",
      "| 含服硝酸酯 | 心绞痛发作的急性缓解 | 已确诊心绞痛发作人群 | 同上 |",
    ],
  ]) {
    const filled = validPackage();
    filled.reportText = filled.reportText
      .replace("# 急性胸部压迫感与速效救心丸的证据边界", "# 急性胸痛院外自救用药的证据评价：速效救心丸与含服硝酸酯的比较")
      .replace("## 药物角色\n", `## 药物角色\n${table.join("\n")}\n`);
    const filledResult = validateClinicalEvidencePackage(filled);
    assert.equal(filledResult.valid, true, filledResult.issues.join("\n"));
  }

  // A title that compares nothing is not asked for a comparison matrix, and
  // 对比剂 is an ordinary pharmacology noun rather than an announcement.
  for (const write of [
    "# 急性胸部压迫感与速效救心丸的证据边界",
    "# 碘对比剂相关急性肾损伤的证据评价",
    "# 速效救心丸用于急性胸痛院外自救的证据评价",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("# 急性胸部压迫感与速效救心丸的证据边界", write);
    assert.equal(validateClinicalEvidencePackage(input).valid, true, write);
  }
});

test("a substitution claim the report says it has no comparison for is rejected", () => {
  // The bridge walked in silence: a variant lowers one arm's response,
  // therefore switch to the other — with the links in between (the other arm is
  // untouched by the same pathway, switching improves outcomes, it substitutes
  // at all) never established. An arm never tested for a mechanism is untested,
  // not immune.
  //
  // What is decidable is not how strong the evidence should have been, but that
  // the report states there is no direct comparison and concludes one anyway.
  const declared = "未检索到两者在该场景的头对头随机对照比较。";
  for (const write of [
    "此类人群可改用另一制剂。",
    "对低反应人群，另一制剂可能是更合适的选择。",
    "就院外自救而言后者更为可靠。",
    "在该场景中另一制剂优于含服硝酸酯。",
    "低反应者可用另一制剂取代原有用药。",
    // What is being compared is named a clause away, which is where a run puts
    // it once it is told not to write 后者更可靠.
    "两者相比，该制剂在该场景中更安全。",
    // The exemptions below must not become a way through. A link asserted
    // 已建立 is the conclusion itself; a source noun in front of the verb does
    // not make a claim about the medicines into a claim about the literature;
    // and an interrogative in a neighbouring clause licenses nothing.
    "低反应者改用另一制剂后结局更好，该环已建立。",
    "现有资料显示该制剂优于含服硝酸酯。",
    "现有研究表明该制剂优于含服硝酸酯。",
    "该制剂的疗效优于含服硝酸酯，证据充分。",
    "无论是否首诊，均可改用另一制剂。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${declared}\n${write}\n`);
    const issues = validateClinicalEvidencePackage(input).issues.join("\n");
    assert.match(issues, /concludes that one arm can take the other's place/, write);
    assert.match(issues, /已建立 or 未建立/, write);
  }

  // Each of these carries the words the rule reads, beside the same declared
  // absence. None is a substitution claim, and rejecting one would send the run
  // back to break a sentence the skill prescribes.
  for (const write of [
    "ALDH2 相关反应差异提示，院外心绞痛用药效果可能存在显著个体差异，不宜将含服硝酸酯视为对所有患者反应完全一致的单一标准。"
      + "另一药具有不同的药物组成和证据路径，但其在低反应人群中的相对价值仍需直接临床研究验证。",
    "两药在已确诊冠心病心绞痛患者中均有相应应用依据，但在首次发生或病因未明的院外急性胸痛中，现有证据不能支持患者自行选择药物替代专业评估。",
    "该试验中试验组的症状缓解率优于对照组。",
    "该指南建议含服无效者改用静脉给药。",
    "任何自救药物都不能替代及时呼救与心电图评估。",
    "两药的相对效能尚不能判断，缺乏可回答该问题的随机对照研究。",
    "该试验报告该制剂的缓解率优于另一制剂。",
    // A comparative adjective attached to a property of one population or one
    // formulation, which is what most 更好 in a manuscript is. Reading it as a
    // conclusion about the arms would reject ordinary results prose.
    "该人群的依从性更好，随访完成率更高。",
    "该缓释制剂的耐受性更好，不良反应报告较少。",
    // The bridge written out link by link, which is the repair this rule's own
    // notice asks for. The link that has not been shown is word for word the
    // sentence the rule reads as a conclusion, so the 未建立 mark has to
    // license it — in the same clause, a clause away, or as the short sentence
    // that follows it.
    "低反应者改用另一制剂后结局更好：未建立，未检索到以临床结局为终点的研究。",
    "第四环为低反应者改用另一制剂后结局更好，该环未建立。",
    "链条的第四环是低反应者改用另一制剂后结局更好。该环未建立。",
    // Asking the question this rule exists to keep open is not answering it.
    "低反应人群是否应换用其他制剂，目前尚无研究可以回答。",
    // Which evidence base is stronger is a statement about the literature, and
    // an axis may hold measured evidence on one arm and nothing on the other
    // without any head-to-head study existing.
    "该维度上含服硝酸酯的证据强度优于该制剂。",
    "在急性按需使用这一维度上，含服硝酸酯的证据更可靠。",
    "两者相比，含服硝酸酯在急性按需使用维度的证据更充分。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${declared}\n${write}\n`);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, true, `${write}: ${result.issues.join("\n")}`);
  }

  // Silence is not the contradiction. A substitution claim over a report that
  // never says whether a direct comparison exists is preflight advice, because
  // whether one exists in the literature is not decidable from the document —
  // and a rule that cannot be decided must not withhold a finished package.
  const silent = validPackage();
  silent.reportText = silent.reportText.replace("## 药物角色\n", "## 药物角色\n此类人群可改用另一制剂。\n");
  assert.equal(validateClinicalEvidencePackage(silent).valid, true);
});

test("a comparison is announced in more words than 比较, and in none of the words that merely contain one", () => {
  // The promise is made in the title, so that is where it is read — and a run
  // sent back for 比较 reaches for the next word before it reaches for the
  // table. Every spelling below announces the same duty and owes the same
  // matrix; if only one of them is read, the rule is a word filter rather than
  // a rule about comparisons.
  for (const title of [
    "# 速效救心丸与含服硝酸酯的优劣评价",
    "# 两种含服制剂孰优孰劣：院外自救用药的证据评价",
    "# 速效救心丸 versus 含服硝酸酯的证据评价",
    "# 速效救心丸 vs. 含服硝酸酯的证据评价",
    "# 两种含服制剂的头对头证据评价",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("# 急性胸部压迫感与速效救心丸的证据边界", title);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, false, `${title}: a comparative title was accepted with no matrix under it`);
    assert.match(result.issues.join("\n"), /titled as a comparison .* but no table in the analysis body/s, title);
  }

  // A word that merely contains one of those spellings promises nothing. 随机
  // 对照试验 is the design line of half the sources a review cites, and vs
  // inside a word is not the comparison operator — demanding a comparison
  // matrix from either would withhold a finished package over its vocabulary.
  for (const title of [
    "# 随机对照试验证据在院外胸痛处置中的适用边界",
    "# CVS 连锁药房处方数据中的胸痛用药证据评价",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("# 急性胸部压迫感与速效救心丸的证据边界", title);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, true, `${title}: ${result.issues.join("\n")}`);
  }
});

test("the table that answers a comparative title has to put the arms side by side", () => {
  // A run told to add a table adds a table. What the rule asks for is a matrix
  // — an axis column, one column per arm, more than one axis filled — and the
  // two shapes below are what a report writes when it complies with the letter:
  // one arm's column with the other's missing, and a single axis standing in
  // for the table. In neither does the reader see the two accounts meet, which
  // is the whole point of asking for the table. The shapes that do satisfy it,
  // in both layouts, are covered by the test above.
  for (const [shape, table] of [
    [
      "one arm's column, the other's missing",
      [
        "| 维度 | 速效救心丸 |",
        "| --- | --- |",
        "| 核准适用场景 | 气滞血瘀型冠心病心绞痛 |",
        "| 急性按需使用证据 | 未检索到以急性缓解时间为结局的随机对照研究 |",
      ],
    ],
    [
      "a single axis standing in for the table",
      [
        "| 维度 | 速效救心丸 | 含服硝酸酯 | 该维度可支持的结论边界 |",
        "| --- | --- | --- | --- |",
        "| 核准适用场景 | 气滞血瘀型冠心病心绞痛 | 心绞痛发作的急性缓解 | 只能判断用法是否落在核准范围内 |",
      ],
    ],
  ]) {
    const input = validPackage();
    input.reportText = input.reportText
      .replace("# 急性胸部压迫感与速效救心丸的证据边界", "# 速效救心丸与含服硝酸酯的优劣评价")
      .replace("## 药物角色\n", `## 药物角色\n${table.join("\n")}\n`);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, false, `${shape}: this was accepted as a comparison matrix`);
    assert.match(result.issues.join("\n"), /no table in the analysis body/, shape);
  }
});

test("a swap is a swap under every verb the report reaches for, and refusing one is not making one", () => {
  // 替代 and 改用 are exercised above; these are the words a run reaches for
  // once it has been sent back for those, and the rule has to read the move
  // rather than the wording. The last one carries no 前者/后者 anchor at all —
  // what makes it a claim about the arms is that the clause is choosing between
  // them.
  const declared = "未检索到两者在该场景的头对头随机对照比较。";
  for (const write of [
    "低反应者可换用另一制剂。",
    "该制剂可以代替含服硝酸酯用于院外自救。",
    "对低反应人群，该制剂是更好的首选方案。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${declared}\n${write}\n`);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, false, `${write}: a swap between the arms was accepted`);
    assert.match(result.issues.join("\n"), /concludes that one arm can take the other's place/, write);
  }

  // The reviewers' own sentences, verbatim where the fixture's question allows
  // the medicines to be named. Refusing the swap is the finding this rule
  // exists to protect, and it is written with the same verb the rule blocks;
  // rejecting it would leave a run no way to say what the evidence says.
  for (const write of [
    "尚无证据支持以速效救心丸替代硝酸甘油。",
    "其在 ALDH2 低反应人群中的相对价值仍需直接临床研究验证。",
    // Somebody else's comparison, under the two source nouns the attributed
    // pattern carries besides 指南 and 该试验.
    "该系统评价报告含服硝酸酯的缓解率优于该制剂。",
    "该 Meta 分析显示该制剂优于安慰剂。",
    // An indication is not a swap: naming what is first-line inside one
    // population says nothing about the other arm.
    "在已确诊心绞痛发作中，含服硝酸酯是发作期的首选用药。",
  ]) {
    const input = validPackage();
    input.reportText = input.reportText.replace("## 药物角色\n", `## 药物角色\n${declared}\n${write}\n`);
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, true, `${write}: ${result.issues.join("\n")}`);
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
  const source = await readFile(new URL("../../../packages/domain/src/clinicalEvidence.mjs", import.meta.url), "utf8");
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
  const rules = JSON.parse(await readFile(new URL("../../../packages/domain/src/clinical-safety-rules.json", import.meta.url), "utf8"));
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
  const rules = JSON.parse(await readFile(new URL("../../../packages/domain/src/clinical-safety-rules.json", import.meta.url), "utf8"));
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
  const rules = JSON.parse(await readFile(new URL("../../../packages/domain/src/clinical-safety-rules.json", import.meta.url), "utf8"));
  const rule = rules.rules.find((entry) => entry.id === "suxiao-must-not-delay-emergency");
  const pattern = new RegExp(rule.pattern, rule.flags ?? "");

  assert.ok(pattern.test("速效救心丸不适用于该场景的急救决策，服用速效救心丸不得延误呼叫 120"));
  assert.ok(pattern.test("服用任何自救药物均不得延误呼叫 120 急救"));
  assert.ok(pattern.test("不得因服用速效救心丸而延误就医"));
  // The verb list is where this rule fails, and it failed twice more on
  // 2026-08-26: two runs wrote the required sentence with 延迟 and 推迟 --
  // ordinary synonyms of 延误 -- and were rejected three submits each for a
  // sentence they had written. These are the runs' own words, verbatim.
  assert.ok(pattern.test("含服速效救心丸不得延迟急救照护：含服不是等待的理由，如需服用，应与呼叫急救（中国为 120）同时进行"), "rq09's sentence");
  assert.ok(pattern.test("速效救心丸不得作为延迟呼叫急救的理由：如需服用，应与呼叫 120 同时进行"), "rq02c's sentence");
  assert.ok(pattern.test("是否含服硝酸甘油或速效救心丸、含服后是否缓解，均不构成等待或推迟呼叫急救的理由"), "the 推迟 phrasing");
  // It must still be a requirement, not a formality.
  assert.ok(!pattern.test("立即呼叫 120，保持坐位"));
  assert.ok(!pattern.test("速效救心丸可用于气滞血瘀型心绞痛"));
});

// --- Emergency dispatch is never conditioned on a medicine's effect ---------
/** The package with one extra line inside the practical section, and the
 *  medication-conditioned-trigger notices it earns.
 *  @param {string} practicalLine
 */
function practicalTriggerIssues(practicalLine) {
  const input = deepResearchPackage();
  input.reportText = input.reportText.replace(
    "\n\n## 参考文献",
    `\n${practicalLine} <!-- claim:CLM-001 --> [1]\n\n## 参考文献`,
  );
  return validateClinicalEvidencePackage(input).issues.filter((issue) => /^临床实践要点第 \d+ 行把/.test(issue));
}

test("the section that satisfies the practical-answer requirement is the section that gets audited", () => {
  // The requirement used to be satisfied by 结论|处置|Conclusion|Practical while
  // every check on the section found it by a narrower expression, so a report
  // headed 「## 结论与处置建议」 or 「## 患者须知」 satisfied the requirement and had
  // its practical advice audited by nothing at all: 急救触发条件, the derived
  // ban, and 每条要点须挂 claim all ran over an empty string.
  for (const heading of ["结论与处置建议", "患者须知", "面向临床的处置建议"]) {
    const input = deepResearchPackage();
    input.reportText = input.reportText.replace("## 实际处置", `## ${heading}`);
    const issues = validateClinicalEvidencePackage(input).issues;
    assert.equal(
      issues.some((issue) => /missing the safety-first practical-answer section/.test(issue)),
      true,
      `a heading outside the practical vocabulary must not satisfy the requirement: ${heading}`,
    );
  }
  // 结论 and 临床实践要点 stay two sections: the conclusion requirement no longer
  // accepts a practical heading in its place either.
  const withoutConclusion = deepResearchPackage();
  withoutConclusion.reportText = withoutConclusion.reportText.replace("## 结论\n", "## 处置建议\n");
  assert.equal(
    validateClinicalEvidencePackage(withoutConclusion).issues
      .some((issue) => /missing a required section matching .*结论/.test(issue)),
    true,
  );
  // A heading with nothing under it is audited exactly like a missing one.
  const empty = deepResearchPackage();
  empty.reportText = empty.reportText.replace(
    /## 实际处置\n[\s\S]*?(?=\n## 参考文献)/,
    "## 实际处置\n",
  );
  assert.equal(
    validateClinicalEvidencePackage(empty).issues
      .some((issue) => /practical-answer section is empty/.test(issue)),
    true,
    validateClinicalEvidencePackage(empty).issues.join("\n"),
  );
  // Control: the fixture's own heading satisfies both the requirement and the
  // locator, so this test cannot pass by the requirement having been deleted.
  assert.deepEqual(
    validateClinicalEvidencePackage(deepResearchPackage()).issues
      .filter((issue) => /practical-answer section/.test(issue)),
    [],
  );
});

test("an emergency-call trigger conditioned on how the medicine performed is rejected", () => {
  // Verbatim from the delivered reports the read-through confirmed. Each also
  // carries the unconditional rule ("服药不是等待的理由"), which is why they read
  // as compliant and why no existing rule sees them: the required sentence is
  // present, and nothing checked that a contradicting one is absent.
  for (const line of [
    // RQ-06: 「急救底线被『含药不缓解』重新条件化」. The 均不得 sits in the
    // clause before the semicolon and licenses nothing after it.
    "1. 急救底线（不可弱化）：心绞痛发作时，无论含服速效救心丸还是复方丹参滴丸，均不得作为推迟呼叫 120 的理由；胸痛持续、伴大汗、气促、含药不缓解者应立即拨打急救电话并按现行急救指南处理。",
    // RQ-02 line 110, verbatim: dose once, wait five minutes, then call — the
    // report's own 结论 says self-medication comes *after* the call.
    "3. 已确诊冠心病、按既往医嘱使用者：若本次胸痛性质、程度或持续时间与既往不同，或含服 1 次后 5 分钟不缓解、加重，应立即呼叫 120，之后再决定是否追加。",
    // The timed-observation form of the same instruction.
    "2. 服药后观察 10 分钟无缓解者应拨打 120。",
    "含服后 20 分钟以上胸痛不缓解符合急性心肌梗死的警示特征，应立即呼叫 120 并接受心电图评估。",
  ]) {
    const issues = practicalTriggerIssues(line);
    assert.equal(issues.length >= 1, true, `a medication-conditioned dispatch trigger must be caught: ${line}`);
  }
});

test("a clause boundary bounds the trigger, and a rejection anywhere in the sentence licenses it", () => {
  // Every line here is verbatim from a delivered package and every one of them
  // was rejected by the first version of this rule. None is a defect.
  for (const line of [
    // RQ-02 line 111. The matched span was 「给药；未完全缓解」 — the clause after
    // the semicolon holds no medication word at all and points at calling 120
    // *sooner*, not later. The gap read ； as ordinary text while the exemption
    // lookup read it as a clause boundary: one function, two notions of clause.
    "4. 慢性稳定型心绞痛患者，症状经首次含服明显改善后，方可每间隔 5 分钟重复给药；未完全缓解即呼叫 120。",
    // 已服药者 is a population qualifier; the trigger is 晕厥与意识不清. Commas
    // and enumeration marks end a clause for the same reason semicolons do.
    "5. 已服药者，出现新发晕厥、意识不清且症状不缓解，立即呼叫 120。",
    // RQ-04 line 84. The rejection that licenses it — 不得因已服药而推迟 — is the
    // last clause of the sentence, and reading only what precedes the phrase
    // called this sentence the very thing it forbids.
    "3. 已确诊冠心病心绞痛的患者按既往医嘱使用属适应症内；若含服后心绞痛持续不缓解或性质改变，应立即呼叫急救，不得因已服药而推迟。",
    // RQ-15 line 136. 症状自觉缓解不等同于心肌缺血解除 denies that the medicine's
    // response settles anything — the same family as 不构成, and the inference
    // this rule exists to ban.
    "6. 含服后 20 分钟以上胸痛不缓解符合急性心肌梗死的警示特征，应立即呼叫 120 并接受心电图与高敏心肌肌钙蛋白评估，症状自觉缓解不等同于心肌缺血解除。",
  ]) {
    assert.deepEqual(practicalTriggerIssues(line), [], `this line is compliant and must be delivered: ${line}`);
  }
  // Control: strip the licensing clause off the last line and it is the
  // violation again, so this test cannot pass by the rule having been deleted.
  assert.equal(
    practicalTriggerIssues("6. 含服后 20 分钟以上胸痛不缓解符合急性心肌梗死的警示特征，应立即呼叫 120 并接受心电图评估。").length,
    1,
  );
});

test("writing the forbidden order in order to reject it stays legitimate", () => {
  // Every compliant report says the forbidden sequence out loud so it can
  // forbid it, so the rejection in the clause — not the vocabulary — is what
  // separates the two. These are verbatim from the delivered reports that got
  // it right; a rule without the tempered gap flags all of them.
  for (const line of [
    "1. 含服速效救心丸不是等待的理由：如需服用，应与呼叫 120 同时进行，而非先含服、无效再呼叫。 <!-- claim:CLM-002 -->",
    "2. 呼叫急救医疗服务（120）应与用药同时进行，而非服药后观察无效再呼叫。 <!-- claim:CLM-002 -->",
    "3. 服药与拨打 120 应同时进行，而非先服药、观察无效后再呼救。 <!-- claim:CLM-002 -->",
    // After a colon the enumeration's subject is the symptom, not the drug.
    "4. 心悸伴下列任一情形时应立即拨打 120 急救，而不宜先行自行含服任何药物：胸痛持续不缓解、放射至左臂或下颌、冷汗、晕厥。",
    "5. 心悸伴以下任一特征时应直接呼叫 120，而不宜先行自我用药：突发且不缓解的胸痛或压迫感、放射至颈或下颌的疼痛。",
    // A symptom that does not remit, with no medication word before it, is the
    // ordinary and correct way to state a dispatch trigger.
    "6. 首次发生、性质改变或持续不缓解的胸痛，应立即呼叫急救（在中国为 120）；服用速效救心丸不是等待的理由，应在服用同时呼叫急救。",
    "7. 服用速效救心丸不得延误呼叫急救：急救电话应与服药同时拨打，而非服药后观察再决定。",
  ]) {
    assert.deepEqual(practicalTriggerIssues(line), [], `a rejected sequence must not read as an instruction: ${line}`);
  }
});

test("a synonym, a full stop or a drug name does not turn the trigger into something else", () => {
  // Every line here is the same instruction as one the rule already rejected,
  // rewritten by one of the six moves the adversarial pass found: a comma
  // inside the condition, a non-relief synonym the phrase list did not hold,
  // a medication verb it did not hold, the drug named instead of the act of
  // taking it, the two halves split across a full stop, and a second sentence
  // that is safer still and used to license the first.
  for (const line of [
    // 「若含服硝酸甘油后，症状仍不缓解」: one comma, closing a temporal clause.
    "若含服硝酸甘油后，症状仍不缓解，应立即拨打 120。",
    // 未见效 / 无好转 / 症状持续存在 / 疼痛不减轻 / 未获缓解: the phrase list held
    // 不见效 and 不缓解 and nothing else.
    "若含服硝酸甘油 5 分钟未见效，应立即拨打 120。",
    "若含服硝酸甘油 5 分钟无好转，应立即拨打 120。",
    "若含服硝酸甘油 5 分钟后症状持续存在，应立即拨打 120。",
    "若含服硝酸甘油 5 分钟疼痛不减轻，应立即拨打 120。",
    "急救呼叫的启动条件为含服后 5 分钟症状未获缓解。",
    // 吃药 is a medication word; the list held 服药 and 用药.
    "若吃药后 5 分钟不缓解，应立即拨打 120。",
    // The drug named instead of the act: no medication verb anywhere, and an
    // efficacy predicate whose subject can only be a treatment.
    "若硝酸甘油未能奏效，应立即拨打 120。",
    // Two sentences, the anaphor carrying the medication act across the stop.
    "含服硝酸甘油一片后观察。仍不缓解者拨打 120。",
    // RQ-06 and RQ-02, rewritten.
    "胸痛持续、伴大汗、气促、含药后无好转者应立即拨打急救电话",
    "或含服 1 次后，5 分钟仍不缓解或加重，应立即呼叫 120",
    // The cheapest exemption there was: a negation about something else.
    "若含服硝酸甘油 5 分钟不缓解，应立即拨打 120，不要自行驾车前往医院。",
    "若含服硝酸甘油 5 分钟不缓解，应立即拨打 120，切勿自行前往。",
  ]) {
    assert.equal(
      practicalTriggerIssues(line).length >= 1,
      true,
      `a rewritten medication-conditioned trigger must still be caught: ${line}`,
    );
  }
});

test("a trigger conditions the call that follows it, not the waiting that does", () => {
  // Hardening the rule against synonyms made it read three compliant sentences
  // as violations. The first is the order this rule exists to produce -- call
  // first, then wait -- and forbidding it pushed the author toward the wrong
  // sequence, which is worse than missing a defect.
  for (const line of [
    "已含服硝酸甘油并拨打 120 后，若疼痛仍未缓解，保持静卧、不要走动。",
    "含服硝酸甘油的同时拨打 120；症状仍不缓解，继续静卧等待急救人员到达。",
    // The efficacy branch has no medication word to check, so it has to be told
    // that the thing which did not work is not the medicine.
    "自我判断不能有效区分心绞痛与急性心肌梗死，出现持续胸痛应立即拨打 120。",
    "早期呼救可显著改善预后，延迟呼救则效果不佳；出现持续胸痛请立即拨打 120。",
  ]) {
    assert.deepEqual(practicalTriggerIssues(line), [], `this line is compliant and must be delivered: ${line}`);
  }
  // Controls: the call after the trigger, and the nominalised frame that names
  // the call first and then states the condition for making it.
  // Count is not the assertion -- one sentence can match two branches. What
  // matters is that each is still refused.
  for (const line of [
    "含服 1 片后 5 分钟症状仍不缓解，立即呼叫 120。",
    "急救呼叫的启动条件为含服后 5 分钟症状未获缓解。",
    "若硝酸甘油未能奏效，应立即拨打 120。",
  ]) {
    assert.ok(practicalTriggerIssues(line).length >= 1, `this line is a violation and must be refused: ${line}`);
  }
});

test("a rejection licenses the trigger only when it is about the trigger", () => {
  // The licensing clause has to name the medication or the relief, because that
  // is what makes it a rejection of *this* condition. Both lines are verbatim
  // from delivered packages and both must keep being delivered.
  for (const line of [
    "3. 已确诊冠心病心绞痛的患者按既往医嘱使用属适应症内；若含服后心绞痛持续不缓解或性质改变，应立即呼叫急救，不得因已服药而推迟。",
    "6. 含服后 20 分钟以上胸痛不缓解符合急性心肌梗死的警示特征，应立即呼叫 120 并接受心电图与高敏心肌肌钙蛋白评估，症状自觉缓解不等同于心肌缺血解除。",
    "无论服药与否、无论症状是否缓解，出现上述征象即刻呼叫 120。",
    "服药不是等待的理由，应在服药的同时呼叫急救。",
  ]) {
    assert.deepEqual(practicalTriggerIssues(line), [], `this line is compliant and must be delivered: ${line}`);
  }
  // Control: swap the licensing clause for a negation about something else and
  // the same sentence is the violation again.
  assert.equal(
    practicalTriggerIssues(
      "3. 已确诊冠心病心绞痛的患者按既往医嘱使用属适应症内；若含服后心绞痛持续不缓解或性质改变，应立即呼叫急救，不要自行驾车前往医院。",
    ).length,
    1,
  );
});

test("the emergency-trigger rule runs only where the reader executes instructions", () => {
  // The same sentence shape in 摘要 or 引言 is the research question being
  // stated ("含服药物后等多久仍不缓解就必须呼叫急救"), which is required, not
  // forbidden. The section boundary is the rule's precondition.
  const input = deepResearchPackage();
  input.reportText = input.reportText.replace(
    "## 摘要\n",
    "## 摘要\n急性胸痛发作时，患者与家属需要一个可执行的时间界限：含服药物后等多久仍不缓解就必须呼叫急救。\n",
  );
  const issues = validateClinicalEvidencePackage(input).issues.filter((issue) => /^临床实践要点第 \d+ 行把/.test(issue));
  assert.deepEqual(issues, []);
});

// --- Article-level regulatory citations ------------------------------------
/** The package with one extra body line in 讨论, and the article-locator
 *  notices it earns.
 *  @param {string} bodyLine @param {(input: any) => void} [prepare]
 */
function regulatoryArticleIssuesFor(bodyLine, prepare) {
  const input = deepResearchPackage();
  input.reportText = input.reportText.replace("## 讨论\n", `## 讨论\n${bodyLine}\n`);
  if (prepare) prepare(input);
  return validateClinicalEvidencePackage(input).issues.filter((issue) => /^报告正文第 \d+ 行以条款级方式引用/.test(issue));
}

test("an article-level regulatory citation resting on a journal source is rejected", () => {
  // Verbatim from two delivered reports. [13] in RQ-30 is a law-school review
  // in Frontiers in Pharmacology; RQ-23's entries 1–4 have no matrix claim,
  // no preserved artifact and no quote at all — its own limitations section
  // admits the statutes were 「未以官方数据库原文逐字核验」.
  for (const line of [
    "《医师法》第 29 条第 2 款将超说明书用药的合法条件规定为四点：无有效或更优治疗手段、有循证医学证据支持、患者知情同意、医疗机构内部审查批准 [13]",
    "《药品管理法》第五十四条规定国家对药品实行处方药与非处方药分类管理 [1]。",
    "《处方药与非处方药分类管理办法（试行）》第四条将非处方药目录的遴选权授予国家药品监督管理局 [2]。",
    "《药品网络销售监督管理办法》（总局令第 58 号）第九条规定应当确保处方来源真实、可靠 [3][4]。",
    "《处方管理办法》第十九条规定处方一般不得超过七日用量 [3][4]。",
  ]) {
    assert.equal(regulatoryArticleIssuesFor(line).length, 1, `an unlicensed article locator must be caught: ${line}`);
  }
});

test("an article locator licensed by the issuing authority's own preserved text passes", () => {
  // The rule has to be satisfiable, and it is satisfied the way the skill says:
  // preserve the statute from the regulator's own site and quote the article.
  const licensed = regulatoryArticleIssuesFor(
    "《医师法》第二十九条第二款将超说明书用药的合法条件规定为四点 [1]。",
    (input) => {
      input.matrix.claims[0].sourceUrl = "https://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313166.html";
      input.matrix.claims[0].supportQuote = "第二十九条 医师应当坚持安全有效、经济合理的用药原则，遵循药品临床应用指导原则、临床诊疗指南和药品说明书中的用法用量使用药品。";
      input.sourceArtifacts[input.matrix.claims[0].artifactPath] = input.matrix.claims[0].supportQuote;
    },
  );
  assert.deepEqual(licensed, []);
  // The English wording of the same article is the same article.
  const english = regulatoryArticleIssuesFor(
    "《医师法》第 29 条第 2 款将超说明书用药的合法条件规定为四点 [1]。",
    (input) => {
      input.matrix.claims[0].sourceUrl = "https://www.npc.gov.cn/englishnpc/c23934/202108/statute.html";
      input.matrix.claims[0].supportQuote = "Article 29, Paragraph 2, of this law permits off-label use under four stated conditions.";
      input.sourceArtifacts[input.matrix.claims[0].artifactPath] = input.matrix.claims[0].supportQuote;
    },
  );
  assert.deepEqual(english, []);
});

test("naming a statute without a clause locator stays legitimate", () => {
  // Every one of these is a near miss from the delivered corpus: an ordinal
  // that is not an article, a statute paraphrased with no article number, a
  // limitation declaring the clauses were not verified, and the correct
  // downgrade — the fact that a document was issued, with its document number.
  for (const line of [
    "第一条线是机制的可解释性。第二条线是吸收与暴露。第三条线是临床终点。",
    "第一条是说明书与监管文本，它确定了适应症的边界；第二条是机制与观察性证据。",
    "我国《药品管理法》（2019 修订）将“超过有效期的药品”列为劣药情形之一；[13]",
    "药品管理法的劣药条款、说明书标签管理规定的现行文本未能核验，相关条款号与逐字原文须以官方公布文本为准。",
    "国家药监局综合司于 2026 年印发《处方药网络零售合规指南》（药监综药管函〔2026〕282 号）[18]，但其正文与具体条款未能获取核对。",
  ]) {
    assert.deepEqual(regulatoryArticleIssuesFor(line), [], `an ordinary statutory reference must not be flagged: ${line}`);
  }
});

test("a statute cited without its book-title marks, backwards, or by anaphor is the same citation", () => {
  // Three rewritings of one sentence, each of which used to clear the rule
  // while asserting exactly what it asserts: the 《》 dropped, the article
  // number put first, and the statute referred back to from a later clause.
  for (const line of [
    "医师法第 29 条第 2 款将超说明书用药的合法条件规定为四点 [13]",
    "《中华人民共和国医师法》确立了医师用药的基本原则；该法第 29 条第 2 款将其规定为四点 [13]",
    "第 29 条第 2 款是《医师法》为超说明书用药设定的合法条件 [13]",
  ]) {
    assert.equal(regulatoryArticleIssuesFor(line).length, 1, `an unlicensed article locator must be caught: ${line}`);
  }
});

test("a 法-compound that is not a statute is not a statute reference", () => {
  // 法 also ends 方法/用法/疗法/合法, and the bare-name branch reads the run of
  // characters standing against the article locator — so the compounds have to
  // be excluded by name, or every numbered step in a methods section becomes a
  // clause-level regulatory citation.
  for (const line of [
    "该药的含量测定方法第三条为高效液相色谱法。",
    "本文采用的分析法第二条为峰面积归一化。",
    "其用法第一条为舌下含服。",
  ]) {
    assert.deepEqual(regulatoryArticleIssuesFor(line), [], `an ordinary 法-compound must not be flagged: ${line}`);
  }
});

test("an article locator inside the reference list is not a body citation", () => {
  const input = deepResearchPackage();
  input.reportText = `${input.reportText}\n13. 全国人民代表大会常务委员会. 中华人民共和国药品管理法（2019 年修订），第五十四条. 2019.`;
  const issues = validateClinicalEvidencePackage(input).issues
    .filter((issue) => /^报告正文第 \d+ 行以条款级方式引用/.test(issue));
  assert.deepEqual(issues, []);
});

// --- An attributed position must be quoted, not inferred from data ---------
/** The package with one extra body line in 讨论 and the named claims' quotes
 *  replaced, and the attributed-stance notices it earns.
 *  @param {string} line @param {Record<string, string>} quotes
 */
function attributedStanceIssuesFor(line, quotes = {}) {
  const input = deepResearchPackage();
  for (const [claimId, quote] of Object.entries(quotes)) {
    const claim = input.matrix.claims.find((entry) => entry.claimId === claimId);
    claim.supportQuote = quote;
    input.sourceArtifacts[claim.artifactPath] = `${input.sourceArtifacts[claim.artifactPath]}\n${quote}`;
  }
  input.reportText = input.reportText.replace("## 讨论\n", `## 讨论\n${line}\n`);
  return validateClinicalEvidencePackage(input).issues.filter((issue) => /^报告第 \d+ 行以「/.test(issue));
}

test("a position attributed to a source that only reported measurements is rejected", () => {
  // RQ-27 as delivered: the stance ("a risk marker rather than a causal
  // factor", "residual confounding and publication bias") is in the claim's
  // uncertainty field — the agent's own words — and in none of the three
  // quotes, all of which are pure result sentences. Every figure on the line
  // is in the quotes, so the numeric audit is silent.
  const risk = attributedStanceIssuesFor(
    "作者将血管舒缩症状视为可能的心血管风险标记而非因果因素，并指出存在残余混杂与发表偏倚的可能 [1] <!-- claim:CLM-001 --> <!-- claim:CLM-002 -->",
    {
      "CLM-001": "Further adjustment for cardiovascular risk factors and potential mediators attenuated but did not abolish the associations of VMS (RR = 1.28; 95%CI = 1.08; 1.52) with CHD.",
      "CLM-002": "213,976 women with a total of 10,037 cardiovascular disease outcomes, based on 10 distinct studies, 5.3 to 15 years.",
    },
  );
  assert.equal(risk.length, 1, "a stance carried by no quote must be caught");
  assert.match(risk[0], /CLM-001、CLM-002/);

  // RQ-26 as delivered, the laundering path itself: the quoted sentence and the
  // ECG recommendation live in the claim's own `claim` field, which
  // claimEvidenceText counts as support and this check does not read.
  const laundered = attributedStanceIssuesFor(
    "女性以焦虑（校正 OR 2.9，95% CI 1.1–8.1）为表现者更多，作者指出这些症状常被误释为焦虑或惊恐障碍 [1] <!-- claim:CLM-001 -->",
    { "CLM-001": "278 were included; anxiety (OR 2.9 (95% CI 1.1 –8.1, p=0.031)) were more frequent in women when presenting in the ED." },
  );
  assert.equal(laundered.length, 1);

  // The obvious evasion: attribute a position and cite nothing at all.
  assert.equal(attributedStanceIssuesFor("研究团队认为该风险被系统性低估。").length, 1);
});

test("an attribution the quote does carry is left alone", () => {
  // RQ-08 as delivered, and the proof the rule is satisfiable: the same shape
  // as the rejected line above, with the attribution actually in the quote.
  assert.deepEqual(
    attributedStanceIssuesFor(
      "加热温度升至 70 ℃ 以上使龙脑的释放量下降，作者将其归因于升温下的挥发损失 [1] <!-- claim:CLM-001 -->",
      { "CLM-001": "Raising the temperature to 70 °C increased release to 32.08 mg. This decline was likely due to volatilization losses of L-borneol at elevated temperatures." },
    ),
    [],
  );
  // RQ-05 as delivered: the attribution is a translation of a quote that
  // states no measurement, so the "every cited claim is numeric" conjunct
  // spares it. Without that conjunct this legitimate restatement fails.
  assert.deepEqual(
    attributedStanceIssuesFor(
      "丹麦队列作者明确指出其机制推测为便秘导致排便用力 [1] <!-- claim:CLM-001 -->",
      { "CLM-001": "Constipation leads to straining at stool, which has been associated with transient increases in blood pressure." },
    ),
    [],
  );
  // RQ-10 as delivered: a numeric claim and a mechanism claim on one line is
  // ordinary writing, and the mechanism claim carries the attribution.
  assert.deepEqual(
    attributedStanceIssuesFor(
      "该研究将这一促进作用归因于对 CYP3A4 的激活 [1][2] <!-- claim:CLM-001 --> <!-- claim:CLM-002 -->",
      {
        "CLM-001": "AUC was 385.37 versus 851.64 μg/L*h in the pretreated group.",
        "CLM-002": "Ligustrazine promoted the metabolism of valsartan via activating CYP3A4.",
      },
    ),
    [],
  );
});

test("ordinary reporting verbs are not stance attribution", () => {
  // 报告/报道/说明/描述 report what was measured; only 认为/指出/强调/视为/归因
  // and their neighbours attribute a position. 本文/本研究 are excluded too —
  // the paper's own voice is not an attribution to anybody.
  for (const line of [
    "该文并报告舌下硝酸甘油在中国受试者中缺乏疗效 [1] <!-- claim:CLM-001 -->",
    "该研究报道了 12 例患者的随访结果 [1] <!-- claim:CLM-001 -->",
    "本研究认为该关联仍需前瞻性验证 [1] <!-- claim:CLM-001 -->",
  ]) {
    assert.deepEqual(
      attributedStanceIssuesFor(line, { "CLM-001": "The event rate was 12.4% (95% CI 9.1 to 16.2) over 24 months." }),
      [],
      `an ordinary reporting verb must not read as attribution: ${line}`,
    );
  }
});

test("a measure word, a demonstrative or a nominalised opinion is the same attribution", () => {
  // 该研究 used to be a listed string, so 「这项研究」 and 「该项研究」 — one measure
  // word inserted — were different subjects, and 「上述研究」 was a third. The
  // stance can also be written without any of the listed verbs: 提出/断言/归结/
  // 写道, the frame 「在…看来」, and the nominalisation 「…的核心观点是」.
  const numeric = { "CLM-001": "The event rate was 12.4% (95% CI 9.1 to 16.2) over 24 months." };
  for (const line of [
    "上述研究认为硝酸甘油反应不能用于鉴别心源性胸痛 [1] <!-- claim:CLM-001 -->",
    "这项研究认为该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
    "该项研究指出该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
    "课题组认为该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
    "作者提出该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
    "该研究提示该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
    "作者断言该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
    "在原作者看来，该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
    "作者的核心观点是该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
    "该现象被作者归结于安慰剂效应 [1] <!-- claim:CLM-001 -->",
    "作者写道：该关联被系统性低估 [1] <!-- claim:CLM-001 -->",
  ]) {
    assert.equal(
      attributedStanceIssuesFor(line, numeric).length,
      1,
      `a rewritten attribution must still be caught: ${line}`,
    );
  }
  // A subject and its predicate stand in one clause. Both lines are verbatim
  // from delivered packages: the first says where the conclusions came from,
  // the second predicates 提示 of an E value, not of the authors.
  for (const line of [
    "其结论引自摘要原文、未据标题推断，但效应量与偏倚风险的完整评定受限制 [1] <!-- claim:CLM-001 -->",
    "作者对心肌梗死估计的 E 值为 1.79，提示需相当强度的未测混杂才能解释该关联 [1] <!-- claim:CLM-001 -->",
  ]) {
    assert.deepEqual(attributedStanceIssuesFor(line, numeric), [], `a comma ends the window: ${line}`);
  }
});

test("the stance exemption asks for a predication, not for a word", () => {
  // The exemption used to be a flat vocabulary tested anywhere in the quote and
  // cleared 183 of the 578 claims in thirty delivered packages outright. The
  // four quotes below are verbatim from that corpus and carry no stance at all:
  // patient instruction, two methods sentences and a measurement with a
  // connective in front of it. Each of them used to clear this line.
  const attribution = "该研究指出该关联被系统性低估 [1] <!-- claim:CLM-001 -->";
  for (const quote of [
    "You could be having a heart attack. Call 999 straight away as you need immediate treatment in hospital. The event rate was 12.4% over 24 months.",
    "Forty-one trials involving 6276 patients were included in our analysis, with an event rate of 12.4% over 24 months.",
    "In this study, we included 417 patients aged 65 to 95 years; the event rate was 12.4% over 24 months.",
    "However, there was significant heterogeneity between studies, with an event rate of 12.4% over 24 months.",
  ]) {
    assert.equal(
      attributedStanceIssuesFor(attribution, { "CLM-001": quote }).length,
      1,
      `a token is not a position: ${quote}`,
    );
  }
  // And these five are the corpus lines the exemption exists for — each one a
  // quote that states a position, in the four shapes a source states one in.
  for (const quote of [
    // Authorial predication (RQ-16 CLM-010).
    "Our results do not support the findings of the previous study by Wang et al that employees with permanent night shifts increase the risk of incident AF.",
    // Hedged interpretation (RQ-08 CLM-004).
    "Raising the temperature to 70 °C increased release to 32.08 mg. This decline was likely due to volatilization losses of L-borneol at elevated temperatures.",
    // Deontic position (RQ-16 CLM-013, RQ-24 CLM-012).
    "the need to consider arrhythmia in the differential diagnosis and to obtain an electrocardiogram in patients presenting with palpitations",
    "The use of a single abnormal finding on electrocardiography is not recommended for stratifying the risk of cardiovascular events in low-risk general populations.",
    // Causal attribution anchored to a stated result (RQ-28 CLM-009).
    "Many patients initially fail to recognize myocardial infarction symptoms and misattribute their symptoms to other causes, which may lead to a longer decision delay.",
  ]) {
    assert.deepEqual(
      attributedStanceIssuesFor(attribution, { "CLM-001": quote }),
      [],
      `a quote that does carry the position must stay exempt: ${quote}`,
    );
  }
});

test("a source title is metadata the run types in, not something the source said", () => {
  // The notice tells the author the gate reads supportQuote alone. It also read
  // sourceTitle, so retitling one source cleared the line with the prose and
  // the quote untouched.
  const issues = attributedStanceIssuesFor(
    "作者指出这些症状常被误释为焦虑或惊恐障碍 [1] <!-- claim:CLM-001 -->",
    { "CLM-001": "278 were included; anxiety (OR 2.9, 95% CI 1.1-8.1) was more frequent in women presenting in the ED." },
  );
  assert.equal(issues.length, 1);
  const retitled = (() => {
    const input = deepResearchPackage();
    const claim = input.matrix.claims.find((entry) => entry.claimId === "CLM-001");
    claim.supportQuote = "278 were included; anxiety (OR 2.9, 95% CI 1.1-8.1) was more frequent in women presenting in the ED.";
    claim.sourceTitle = "Selection bias in emergency chest pain cohorts";
    input.sourceArtifacts[claim.artifactPath] = `${input.sourceArtifacts[claim.artifactPath]}\n${claim.supportQuote}`;
    input.reportText = input.reportText.replace(
      "## 讨论\n",
      "## 讨论\n作者指出这些症状常被误释为焦虑或惊恐障碍 [1] <!-- claim:CLM-001 -->\n",
    );
    return validateClinicalEvidencePackage(input).issues.filter((issue) => /^报告第 \d+ 行以「/.test(issue));
  })();
  assert.equal(retitled.length, 1, "a retitled source must not clear an attributed stance");
});

// --- Reference-table closure ------------------------------------------------
/** @param {(input: any) => void} prepare @param {RegExp} shape */
function closureIssues(prepare, shape) {
  const input = deepResearchPackage();
  prepare(input);
  return validateClinicalEvidencePackage(input).issues.filter((issue) => shape.test(issue));
}

test("a numbered reference nobody cites is an orphan entry", () => {
  // RQ-22 as delivered: a young-adult chest-pain cohort numbered 11, cited
  // nowhere, mentioned once in 局限性 as "full text unavailable" — and it is
  // exactly the cohort the report's own question needed. A zero-citation entry
  // almost always points at a question that was not finished.
  const issues = closureIssues((input) => {
    input.reportText = input.reportText.replace(
      "\n\n## 参考文献",
      "\n\n## 参考文献\n13. Walker NJ, Sites FD. Characteristics and outcomes of young adults who present with chest pain. Acad Emerg Med. 2001. PMID:11435184.",
    );
  }, /^参考文献 \[\d+\] 在正文中从未被引用/);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /\[13\]/);
});

test("a citation with no entry, and an identifier standing in for one, are both rejected", () => {
  // The dangling direction fires nowhere in the delivered corpus, and it is
  // what stops clause A's repair being gamed: deleting an entry without
  // renumbering now fails here instead of passing silently.
  const dangling = closureIssues((input) => {
    input.reportText = input.reportText.replace("## 讨论\n", "## 讨论\n该结论另见一项队列研究 [23]。\n");
  }, /^正文引用 \[23\] 在参考文献表中没有对应条目/);
  assert.equal(dangling.length, 1);

  // RQ-25 as delivered, on a sentence carrying a negative assertion.
  const identifiers = closureIssues((input) => {
    input.reportText = input.reportText.replace(
      "## 讨论\n",
      "## 讨论\n与此最接近的研究均属间接：中医诊断变量信度研究[题录，PMID 22897413，全文未获]；量表研究方案[题录，PMID 29721788，全文未获]。\n",
    );
  }, /^报告第 \d+ 行把书目标识符放进了引用位/);
  assert.equal(identifiers.length, 2);
});

test("citation harvesting reads compound brackets, table rows and chemical names", () => {
  // [6,10] must expand to both numbers or two entries are falsely orphaned; a
  // table row is the only citation of reference 6 in one delivered report; and
  // [2.2.1] is a von Baeyer ring descriptor inside a chemical name, not
  // citation 2 and not an identifier.
  const input = deepResearchPackage();
  input.reportText = input.reportText
    .replace("## 讨论\n", "## 讨论\n冰片（1,7,7-三甲基二环[2.2.1]庚-2-醇）的分子量为 154.25 [2]。\n")
    .replace(
      "\n\n## 参考文献",
      "\n\n## 参考文献\n13. Extra source A. Journal. 2020. https://example.org/a\n14. Extra source B. Journal. 2021. https://example.org/b",
    )
    .replace("## 结果\n", "## 结果\n| 项目 | 值 |\n| --- | --- |\n| 核准适用场景 | 心绞痛发作的急性缓解 [13] |\n\n合并结果一致 [14,13]。\n");
  const issues = validateClinicalEvidencePackage(input).issues.filter((issue) => (
    /^参考文献 \[\d+\] 在正文中从未被引用/.test(issue)
    || /^正文引用 \[\d+\] 在参考文献表中没有对应条目/.test(issue)
    || /把书目标识符放进了引用位/.test(issue)
  ));
  assert.deepEqual(issues, []);
});

test("a repeated claim marker must carry that claim's number on every line it appears on", () => {
  // RQ-13 as delivered: CLM-021 pairs correctly on line 66 and is repeated in
  // 临床实践要点 on a safety instruction citing [6], which the claim does not
  // carry. The existing per-claim check inspects only the first line the
  // marker appears on, so today this passes.
  const input = deepResearchPackage();
  input.reportText = input.reportText.replace(
    "\n\n## 参考文献",
    "\n4. 发作频率增加时及时就医评估而非自行调整剂量 [6]。<!-- claim:CLM-001 -->\n\n## 参考文献",
  );
  const issues = validateClinicalEvidencePackage(input).issues.filter((issue) => /anchors claim CLM-001/.test(issue));
  assert.equal(issues.length, 1);
  // Inside the practical section it is blocking: that is where the gate already
  // refuses derived claims and requires a marker on every action line.
  assert.match(issues[0], /^The practical section's report line \d+ anchors claim/);
  assert.equal(validateClinicalEvidencePackage(input).blockingIssues.includes(issues[0]), true);

  // The same defect in the analysis body is bookkeeping a reader can check.
  const body = deepResearchPackage();
  body.reportText = body.reportText.replace("## 讨论\n", "## 讨论\n该结论亦见于队列研究 [6]。<!-- claim:CLM-001 -->\n");
  const bodyIssues = validateClinicalEvidencePackage(body).issues.filter((issue) => /anchors claim CLM-001/.test(issue));
  assert.equal(bodyIssues.length, 1);
  assert.match(bodyIssues[0], /^Report line \d+ anchors claim/);
  assert.equal(validateClinicalEvidencePackage(body).blockingIssues.includes(bodyIssues[0]), false);
});

test("an excluded source record needs a reason and must leave the numbered list", () => {
  const issues = closureIssues((input) => {
    const log = JSON.parse(input.searchLogText);
    log.sourceRecords.push({
      sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/evidence/source-13",
      referenceNumber: 5,
      included: false,
      accessLevel: "bibliographic",
    });
    input.searchLogText = JSON.stringify(log);
  }, /sourceRecords\[12\]/);
  assert.equal(issues.length, 2, issues.join("\n"));
  assert.equal(issues.some((issue) => /没有 exclusionReason/.test(issue)), true);
  assert.equal(issues.some((issue) => /却仍以编号 \[5\] 留在参考文献表中/.test(issue)), true);
});

// --- Screening numbers and the source set are rendered, never restated -----
test("a stated flow number that disagrees with the search log is rejected, one number at a time", () => {
  // RQ-07 as delivered: 191/116/25 in the prose against 203/125/24 in the log
  // and in the run's own citation audit. Log and receipt agree perfectly, so
  // every existing check passes; nobody reads the prose.
  const input = deepResearchPackage();
  input.reportText = input.reportText.replace(
    "## 结果\n",
    "## 结果\n以 PMID、DOI 及规范化题名去重后，共获得 40 条记录，去重并剔除无关记录后余 24 条，最终纳入 12 个来源。\n",
  );
  const issues = validateClinicalEvidencePackage(input).issues.filter((issue) => /^检索流程数与纳入来源集合/.test(issue));
  // Only the disagreeing quantity: 24 and 12 are right and raise nothing.
  assert.equal(issues.length, 1);
  assert.match(issues[0], /命中记录数 40，检索记录 recordsIdentified = 42/);
});

test("a per-query hit count and a cited study's own count are not the run's flow", () => {
  // The two most dangerous look-alikes in the corpus. 「命中 0 条」 for one named
  // database is a result; 「纳入 46 篇系统评价」 and 「纳入 41 项随机对照试验」 are
  // a cited paper's own counts. Without the anchoring rule the first collides
  // with recordsIdentified and the second with sourcesIncluded.
  for (const line of [
    "临床试验注册库以“速效救心丸”检索命中 0 条。",
    "纳入的 46 篇系统评价中，结局多为心绞痛与心电图等次要终点。",
    "Ren 等的荟萃分析纳入 41 项随机对照试验、6276 例中国冠心病患者。",
    "该试验纳入 174 例对长效硝酸酯不耐受的慢性冠脉综合征患者。",
  ]) {
    const input = deepResearchPackage();
    input.reportText = input.reportText.replace("## 结果\n", `## 结果\n${line}\n`);
    const issues = validateClinicalEvidencePackage(input).issues.filter((issue) => /^检索流程数与纳入来源集合/.test(issue));
    assert.deepEqual(issues, [], `a per-study or per-query count must not read as the run's flow: ${line}`);
  }
  // And a complete, correct flow sentence stays silent, which is the shape the
  // rule is asking for.
  const correct = deepResearchPackage();
  correct.reportText = correct.reportText.replace(
    "## 结果\n",
    "## 结果\n共执行 8 条检索式，命中 42 条记录，去重后 24 条，纳入 12 份来源。\n",
  );
  assert.deepEqual(
    validateClinicalEvidencePackage(correct).issues.filter((issue) => /^检索流程数与纳入来源集合/.test(issue)),
    [],
  );
});

test("the numbered reference list must be exactly the included source set", () => {
  // RQ-24 as delivered: twelve numbered references, seven included records, and
  // the five it cites in the body sit in the log as
  // "accessLevel": "bibliographic", "included": false. sourcesIncluded ===
  // includedRecords.length still holds, so the existing check sees a
  // consistent log while the reader sees twelve numbered sources.
  const input = deepResearchPackage();
  const log = JSON.parse(input.searchLogText);
  log.sourceRecords[11].included = false;
  log.sourceRecords[11].accessLevel = "bibliographic";
  log.sourceRecords[11].exclusionReason = "题录层级，未获全文";
  log.screening.sourcesIncluded = 11;
  input.searchLogText = JSON.stringify(log);
  const issues = validateClinicalEvidencePackage(input).issues;
  assert.equal(issues.some((issue) => /^参考文献 \[12\] 在正文中被引用或列入参考文献表/.test(issue)), true, issues.join("\n"));
  assert.equal(issues.some((issue) => /^参考文献表共 12 条编号条目，screening\.sourcesIncluded = 11/.test(issue)), true);
});

test("the screening-ledger mismatch earns its own run-level error code", () => {
  // A repair loop told only "traceability failed" cannot hand the run the
  // numbers that disagree.
  assert.equal(
    clinicalEvidencePackageErrorCode(["参考文献表共 12 条编号条目，screening.sourcesIncluded = 11。"]),
    "specialist_screening_ledger_mismatch",
  );
  assert.equal(clinicalEvidencePackageErrorCode(["some other blocking issue"]), "specialist_evidence_traceability_failed");
});

// --- A named appraisal instrument is a promise, not a qualification --------
/** @param {string} methods @param {string} [results] */
function appraisalPackage(methods, results = "") {
  const input = deepResearchPackage();
  input.reportText = input.reportText
    .replace("## 检索与方法\n", `## 检索与方法\n${methods}\n`)
    .replace("## 结果\n", `## 结果\n${results}\n`);
  return validateClinicalEvidencePackage(input).issues.filter((issue) => (
    /^资料与方法声明了/.test(issue) || /^GRADE 等级与降级理由不自洽/.test(issue)
  ));
}

/** The same, but only what actually withholds delivery.
 *  @param {string} methods @param {string} [results]
 */
function appraisalBlocking(methods, results = "") {
  const input = deepResearchPackage();
  input.reportText = input.reportText
    .replace("## 检索与方法\n", `## 检索与方法\n${methods}\n`)
    .replace("## 结果\n", `## 结果\n${results}\n`);
  return validateClinicalEvidencePackage(input).blockingIssues.filter((issue) => (
    /^资料与方法声明了/.test(issue) || /^GRADE 等级与降级理由不自洽/.test(issue)
  ));
}

test("an instrument named in the methods must be applied once in the results", () => {
  // RQ-21 as delivered: seven instruments declared, each appearing zero times
  // after 资料与方法. The closed vocabulary already existed on both sides and
  // was used only to exempt sentences from the self-grading rule, so naming an
  // instrument made the gate more permissive and never more demanding.
  const declared = appraisalPackage(
    "鉴别要点的诊断效能用 QUADAS-2 评价；干预性研究用 Cochrane RoB 2，非随机干预研究用 ROBINS-I，系统评价用 AMSTAR 2，指南方法学质量用 AGREE II 说明。药物与不良事件的因果关系以 Naranjo 量表或 WHO-UMC 标准评定。",
  );
  assert.equal(declared.length, 7, declared.join("\n"));
  for (const instrument of ["QUADAS-2", "RoB 2", "ROBINS-I", "AMSTAR 2", "AGREE II", "Naranjo", "WHO-UMC"]) {
    assert.equal(declared.some((issue) => issue.includes(`声明了 ${instrument}`)), true, `${instrument} must be named`);
  }

  // RQ-06 as delivered: the hedged declaration, which the line itself admits.
  const hedged = appraisalPackage("干预性研究以 Cochrane RoB 2 / ROBINS-I 思路评估偏倚风险；指南与共识以 AGREE II 思路说明方法学质量。");
  assert.equal(hedged.length, 3);
  assert.equal(hedged.every((issue) => /等同于未使用/.test(issue)), true);

  // RQ-29 as delivered: the instrument surfaces for the first time in 局限性,
  // where it defends a grading that exists nowhere in 结果 or 讨论.
  const input = deepResearchPackage();
  input.reportText = input.reportText
    .replace("## 检索与方法\n", "## 检索与方法\n以 QUADAS-2 评估偏倚风险。\n")
    .replace("## 局限与不确定性\n", "## 局限与不确定性\nQUADAS-2 层面的患者选择偏倚普遍存在。\n");
  const result = validateClinicalEvidencePackage(input);
  const tailOnly = result.issues.filter((issue) => /^资料与方法声明了/.test(issue));
  assert.equal(tailOnly.length, 1);
  assert.match(tailOnly[0], /只在局限性或结论里出现/);
  // And none of it withholds the package. See the next test.
  assert.deepEqual(result.blockingIssues.filter((issue) => /^资料与方法声明了/.test(issue)), []);
});

test("a declared instrument that never rated anything is named for the reader, not blocked", () => {
  // Every one of the thirty delivered packages declares its instruments per
  // design stratum, which is the method section PRISMA asks for, and a stratum
  // this round's search returned nothing for owes no sentence retiring its
  // instrument. Prose does not distinguish "promised and skipped" from "came
  // back empty", so blocking on it rejected twenty-nine of twenty-nine — and
  // its cheapest remedy was to delete the instrument names from 资料与方法.
  //
  // The two lines below are the same claim about the same run, and differ only
  // in whether the sentence happens to name the instrument. Neither may block.
  const named = appraisalBlocking(
    "诊断准确性研究以 QUADAS-2 评价偏倚风险。",
    "本次检索未纳入任何诊断准确性研究，故不涉及诊断偏倚评价。研究甲 [1]。",
  );
  const unnamed = appraisalBlocking(
    "诊断准确性研究以 QUADAS-2 评价偏倚风险。",
    "未检索到可用 QUADAS-2 评定的研究。研究甲 [1]。",
  );
  assert.deepEqual(named, []);
  assert.deepEqual(unnamed, []);
  // The seven-instrument declaration of RQ-21 — the worst case in the corpus,
  // and a confirmed defect — is still reported, still degradable.
  const declared = appraisalPackage(
    "干预性研究用 Cochrane RoB 2，非随机干预研究用 ROBINS-I，系统评价用 AMSTAR 2，指南方法学质量用 AGREE II 说明。",
  );
  assert.equal(declared.length, 4, declared.join("\n"));
  assert.deepEqual(appraisalBlocking(
    "干预性研究用 Cochrane RoB 2，非随机干预研究用 ROBINS-I，系统评价用 AMSTAR 2，指南方法学质量用 AGREE II 说明。",
  ), []);
});

test("a certainty rating one paragraph below the studies it grades is the instrument being used", () => {
  // RQ-10 line 59, verbatim: 「综合而言，机制层面……按 GRADE 属低确定性，降级理由
  // 为间接性」 stands in 结果 and is exactly where GRADE was executed. It grades
  // a *body* of evidence, so it summarises studies cited in the paragraphs
  // above and carries no [n] of its own — and requiring a bracket in the same
  // paragraph declared it missing over a single newline.
  assert.deepEqual(
    appraisalPackage(
      "证据体确定性以 GRADE 表述。",
      "研究甲报告有效率 70% [1]。\n\n综合而言，机制层面可支持方向性结论，按 GRADE 属低确定性，降级理由为间接性（离体组织与动物而非目标人群）。",
    ),
    [],
  );
  // The same text with the newline removed passed before this change, which is
  // how the defect was found. It must still pass.
  assert.deepEqual(
    appraisalPackage(
      "证据体确定性以 GRADE 表述。",
      "研究甲报告有效率 70% [1]。综合而言，按 GRADE 属低确定性，降级理由为间接性。",
    ),
    [],
  );
  // Control: the same methods with a 结果 that never grades anything is still
  // reported, so this test cannot pass by the rule having been deleted.
  assert.equal(
    appraisalPackage("证据体确定性以 GRADE 表述。", "研究甲报告有效率 70% [1]。").length,
    1,
  );
});

test("an instrument that was executed, or had nothing to score, is left alone", () => {
  // RQ-26 as delivered: a genuine execution whose verdict is prose, not a
  // canonical level word. Requiring a rating vocabulary flags this line.
  assert.deepEqual(
    appraisalPackage(
      "诊断准确性研究用 QUADAS-2 评价。",
      "按 QUADAS-2，该研究排除了初始心电图明确心肌梗死者，存在选择偏倚风险，且随访期短 [6]。",
    ),
    [],
  );
  // RQ-25 as delivered: the grading sentence carries no [n] of its own; the
  // citations sit earlier in the same paragraph. Hence paragraph scope.
  assert.deepEqual(
    appraisalPackage(
      "队列研究以 Newcastle-Ottawa 量表评价。",
      "两项院前延迟研究报告了症状—到院时间 [5][6]。这些研究均按 Newcastle-Ottawa 量表评价并因间接性降级。",
    ),
    [],
  );
  // RQ-15 as delivered: the instrument was declared and the literature has
  // nothing to apply it to, which is executed by saying so — no citation.
  assert.deepEqual(
    appraisalPackage(
      "药物与不良事件的因果关系以 Naranjo 量表或 WHO-UMC 标准评定。",
      "未检索到针对本品的 Naranjo 或 WHO-UMC 因果关系评定，也未检索到去激发与再激发观察的个案。",
    ),
    [],
  );
  // eNOS-NO is nitric oxide synthase, not the Newcastle-Ottawa Scale, and bare
  // Cochrane is a publication rather than a versioned instrument.
  assert.deepEqual(
    appraisalPackage("偏倚风险按 Cochrane 相关工具评价。", "本品通过激活 eNOS-NO 通路诱导冠脉舒张 [5]。"),
    [],
  );
});

test("a GRADE level that reaches 高 beside a downgrade reason is rejected, and a baseline is not", () => {
  // RQ-25 as delivered: 方法学质量偏低 is a bias-risk downgrade and the level
  // still reaches 高, while the same report grades that body 低或极低 in 结果.
  const contradiction = appraisalBlocking(
    "证据体确定性以 GRADE 表述。",
    "纳入研究整体方法学质量偏低、多数为中文单中心小样本试验，按 GRADE 在中至高之间 [5]。",
  );
  assert.equal(contradiction.some((issue) => /^GRADE 等级与降级理由不自洽/.test(issue)), true, contradiction.join("\n"));

  // The flat form: a deficiency asserted beside a single-point 高.
  assert.equal(
    appraisalBlocking("证据体确定性以 GRADE 表述。", "纳入研究方法学质量偏低，按 GRADE 评为高确定性 [1]。")
      .some((issue) => /^GRADE 等级与降级理由不自洽/.test(issue)),
    true,
  );

  // RQ-03 as delivered: textbook-correct GRADE writing. 高 names the starting
  // point, and RoB 2 is executed with no citation because it could not be
  // scored — both traps in one sentence.
  assert.deepEqual(
    appraisalPackage(
      "证据体确定性以 GRADE 表述，干预性研究以 RoB 2 评估。",
      "按 GRADE 评估，该证据体从「高」起步，因偏倚风险（单个试验、结果仅为摘要层级，RoB 2 无法完整评估）降一级，因不精确再降一级，评为低确定性。",
    ),
    [],
  );
});

test("a full stop, a synonym or a word order does not separate a GRADE verdict from its reason", () => {
  // Eight rewritings of one paragraph, each of which used to clear the rule.
  // The first two split the judgement across a full stop in either order; the
  // next three swap the deficiency for a synonym; the last three write the
  // verdict the other way round, with a different noun, or without naming GRADE.
  for (const results of [
    "纳入研究方法学质量普遍偏低 [1]。按 GRADE 评为高确定性 [1]。",
    "按 GRADE 评为高确定性 [1]。理由：纳入研究方法学质量普遍偏低 [1]。",
    "因偏倚风险与不一致性下调一级，按 GRADE 评为高确定性 [1]。",
    "纳入研究方法学质量欠佳，按 GRADE 评为高确定性 [1]。",
    "纳入研究整体证据强度不足，按 GRADE 评为高确定性 [1]。",
    "纳入研究方法学质量普遍偏低，按 GRADE 属高级别证据 [1]。",
    "纳入研究方法学质量普遍偏低，GRADE 确定性高 [1]。",
    "纳入研究方法学质量普遍偏低，证据确定性评为高 [1]。",
  ]) {
    assert.equal(
      appraisalBlocking("证据体确定性以 GRADE 表述。", results)
        .some((issue) => /^GRADE 等级与降级理由不自洽/.test(issue)),
      true,
      `a rewritten GRADE contradiction must still be caught: ${results}`,
    );
  }
  // The two GRADE domains spelled with a negator must not read as a negation of
  // the downgrade standing next to them: 不因不一致性降级 rules one out,
  // 因不一致性下调一级 performs one.
  assert.deepEqual(
    appraisalPackage("证据体确定性以 GRADE 表述。", "未因不一致性降级，按 GRADE 评为高确定性 [1]。"),
    [],
  );
});

test("the standard wording of a GRADE high-certainty verdict is not a contradiction", () => {
  // The five GRADE domains are neutral nouns. Matching the bare noun made
  // these two — the textbook ways of writing 高 — self-contradictory, i.e. it
  // declared "high certainty" unwritable, and the whole point of naming the
  // domains is to say which of them you did *not* downgrade for.
  for (const results of [
    "两项大型随机对照试验偏倚风险低、结果一致、估计精确、无发表偏倚证据，按 GRADE 评为高确定性 [1]。",
    "未对任何领域降级，按 GRADE 评为高确定性 [1]。",
    "无需降级，按 GRADE 为高确定性 [1]。",
  ]) {
    assert.deepEqual(appraisalPackage("证据体确定性以 GRADE 表述。", results), [], results);
  }
  // And the one line in the same shape that is a real contradiction still is,
  // so this test cannot pass by the rule having been deleted.
  assert.equal(
    appraisalBlocking("证据体确定性以 GRADE 表述。", "纳入研究方法学质量偏低，按 GRADE 评为高确定性 [1]。").length,
    1,
  );
});

// --- The question-coverage ledger -------------------------------------------
//
// Two halves. The cases in this first block check the run's own account of the
// brief's questions against the artifacts the gate holds anyway — the report's
// lines, the claim anchors in them, the search log. The block further down
// checks that account against the brief itself.

/** A coverage-targeted package: the fixture, with the ledger the case supplies.
 *  @param {any} ledger @param {(input: any) => void} [edit] */
function coveragePackage(ledger, edit) {
  const input = deepResearchPackage();
  if (edit) edit(input);
  input.keepCoverage = true;
  input.questionCoverageText = typeof ledger === "string" ? ledger : JSON.stringify(ledger);
  return input;
}

/** The self-consistency findings only.
 *
 *  Cases in this block build ledgers whose question text is written for the
 *  case rather than transcribed from the fixture's brief, which the
 *  brief-derived rules correctly object to. Those objections belong to the
 *  block further down and would otherwise decide the error code here.
 *  @param {any} ledger @param {(input: any) => void} [edit] */
function coverageBlocking(ledger, edit) {
  const result = validateClinicalEvidencePackage(coveragePackage(ledger, edit));
  return result.blockingIssues.filter((issue) => (
    /^question-coverage\.json /.test(issue) && !issue.includes("题面第")
  ));
}

/** The ledger the fixture is valid under, as an object to edit. */
function coverageLedgerObject() {
  const input = deepResearchPackage();
  return JSON.parse(input.questionCoverageText);
}

test("the coverage ledger is a required deliverable, and its absence is stated as such", () => {
  for (const absent of ["", "   ", undefined]) {
    const input = deepResearchPackage();
    input.keepCoverage = true;
    input.questionCoverageText = absent;
    const result = validateClinicalEvidencePackage(input);
    assert.equal(result.valid, false, `an absent coverage ledger must block: ${JSON.stringify(absent)}`);
    assert.match(result.blockingIssues.join("\n"), /^question-coverage\.json 台账格式无效：文件缺失或为空/m);
    assert.equal(clinicalEvidencePackageErrorCode(result.blockingIssues), "specialist_question_coverage_invalid");
  }
  // And the fixture with its ledger passes, so this cannot pass by the whole
  // family having been deleted.
  assert.equal(validateClinicalEvidencePackage(deepResearchPackage()).valid, true);
});

test("a malformed coverage ledger names the field that is wrong", () => {
  const cases = [
    ["[]", /顶层必须是对象/],
    ["{", /不是合法 JSON/],
    ['{"schemaVersion":2,"entries":[]}', /必须写 "schemaVersion": 1/],
    ['{"schemaVersion":1,"entries":[]}', /entries 必须是非空数组/],
    ['{"schemaVersion":1,"entries":[{"question":"胸口发闷是心绞痛还是胃病","status":"answered","reportLines":[1]}]}', /\.id 必须是题面编号/],
    ['{"schemaVersion":1,"entries":[{"id":"1.1","question":"短","status":"answered","reportLines":[1]}]}', /\.question 必须转录子问原文/],
    ['{"schemaVersion":1,"entries":[{"id":"1.1","question":"胸口发闷是心绞痛还是胃病","status":"partial"}]}', /\.status 必须是/],
  ];
  for (const [ledger, expected] of cases) {
    const issues = coverageBlocking(ledger);
    assert.ok(issues.length > 0, `a malformed ledger must block: ${ledger}`);
    assert.match(issues.join("\n"), expected);
  }
  // A repeated id, and a claim the matrix does not have.
  const duplicate = coverageLedgerObject();
  duplicate.entries[1].id = duplicate.entries[0].id;
  assert.match(coverageBlocking(duplicate).join("\n"), /条目编号 1\.1 出现了两次/);
  const invented = coverageLedgerObject();
  invented.entries[0].claimIds = ["CLM-777"];
  assert.match(coverageBlocking(invented).join("\n"), /证据矩阵里没有这个 claim/);
});

test("an answered sub-question must land on a report line that carries evidence", () => {
  const beyond = coverageLedgerObject();
  beyond.entries[0].reportLines = [9999];
  assert.match(
    coverageBlocking(beyond).join("\n"),
    /条目 1\.1（「胸口突然发闷发紧、像被压着一样，是心绞痛还是胃病」）声明 answered，但指向报告第 9999 行/,
  );

  // Pointing at the reference list, at the limitations, and at a blank line.
  const input = deepResearchPackage();
  const lines = input.reportText.split("\n");
  const lineIn = (heading) => {
    let current = "";
    for (const [index, line] of lines.entries()) {
      const found = /^##\s+(.*)$/.exec(line);
      if (found) current = found[1];
      if (new RegExp(heading).test(current) && !/^##/.test(line) && line.trim()) return index + 1;
    }
    return 0;
  };
  for (const [line, expected] of [
    [lineIn("参考文献"), /那一行在「参考文献」一节里/],
    [lineIn("局限"), /那一行在「局限与不确定性」一节里/],
    [lines.findIndex((value) => !value.trim()) + 1, /那一行是空行或只有标记/],
  ]) {
    const ledger = coverageLedgerObject();
    ledger.entries[0].reportLines = [line];
    ledger.entries[1].reportLines = [line];
    assert.match(coverageBlocking(ledger).join("\n"), expected, `line ${line}`);
  }

  // A real prose line that carries no claim anchor anywhere in its paragraph.
  const unanchored = lines.findIndex((line) => (
    line.trim() && !/^#/.test(line) && !/claim:CLM/.test(line)
  )) + 1;
  const bare = coverageLedgerObject();
  bare.entries[0].reportLines = [unanchored];
  bare.entries[1].reportLines = [unanchored];
  assert.match(coverageBlocking(bare).join("\n"), /所在段落都没有 claim 锚点/);

  // The unedited ledger clears all of it.
  assert.deepEqual(coverageBlocking(coverageLedgerObject()), []);
});

test("a declared gap must be backed by a search the retrieval tools really ran", () => {
  const invented = coverageLedgerObject();
  invented.entries[2].searches = [{
    query: "a search that was never run in this session",
    database: "PubMed",
    searchedAt: "2026-02-11",
  }];
  assert.match(
    coverageBlocking(invented).join("\n"),
    /条目 2\.1（[^）]*）声明 gap，其检索式「a search that was never run in this session」在 clinical-evidence-search\.json 的 queries 中没有对应记录/,
  );

  const wrongDatabase = coverageLedgerObject();
  wrongDatabase.entries[2].searches[0].database = "Embase";
  assert.match(coverageBlocking(wrongDatabase).join("\n"), /声明的数据源是「Embase」/);

  const wrongDate = coverageLedgerObject();
  wrongDate.entries[2].searches[0].searchedAt = "2020-01-01";
  assert.match(coverageBlocking(wrongDate).join("\n"), /声明的检索日期是 2020-01-01/);

  for (const searches of [[], undefined, [{ query: "x" }]]) {
    const missing = coverageLedgerObject();
    missing.entries[2].searches = searches;
    assert.ok(coverageBlocking(missing).length > 0, `a gap without a real search must block: ${JSON.stringify(searches)}`);
  }

  // Transcription differences in the query — spacing, quotes, case — are not a
  // search that never ran.
  const retyped = coverageLedgerObject();
  retyped.entries[2].searches[0].query = ` "Distinct   Structured" search CONCEPT 1 `;
  assert.deepEqual(coverageBlocking(retyped), []);
});

test("a registered gap may not be written as an answer where the reader takes the answer away", () => {
  // One sentence per family, each carrying the gap's own subject, inserted into
  // each of the three sections a reader reads for the answer.
  const subject = "本品在夜间低血压人群中的院外自救";
  const families = [
    `${subject}最常见的表现形式是无症状低灌注 [1] <!-- claim:CLM-001 -->。`,
    `${subject}的有效率为 62%，优于对照 [1] <!-- claim:CLM-001 -->。`,
    `${subject}推荐在症状出现后即刻含服 [1] <!-- claim:CLM-001 -->。`,
    `${subject}无相关证据，文献中没有任何记载 [1] <!-- claim:CLM-001 -->。`,
  ];
  const sections = [["## 摘要\n", "摘要"], ["## 结论\n", "结论"], ["## 实际处置\n", "临床实践要点"]];
  for (const sentence of families) {
    for (const [heading, name] of sections) {
      const ledger = coverageLedgerObject();
      ledger.entries[2].question = `${subject}有无以临床结局为终点的直接研究`;
      const issues = coverageBlocking(ledger, (input) => {
        input.reportText = input.reportText.replace(heading, `${heading}${sentence}\n`);
      });
      assert.ok(
        issues.some((issue) => new RegExp(`条目 2\\.1[^\\n]*登记为 gap，${name}第 \\d+ 行`).test(issue)),
        `${name} / ${sentence}: ${issues.join("\n") || "no finding"}`,
      );
      assert.equal(
        clinicalEvidencePackageErrorCode(issues),
        "specialist_question_coverage_gap_overstated",
      );
    }
  }
});

test("admitting a gap is not asserting one, and the sentences the corpus wrote for it stay writable", () => {
  // Verbatim from delivered packages. A rule that punished these would teach
  // runs to stop writing them, which is the opposite of what the ledger is for.
  // Each is placed in 结论 beside a gap entry whose question is that same
  // sentence, which is the largest topic overlap the rule can ever see.
  for (const sentence of [
    "在“气滞血瘀型冠心病心绞痛”之外，未检索到速效救心丸适应症内的直接临床证据。",
    "速效救心丸说明书与相关共识未检索到任何时间界限或再次给药间隔 [7]。",
    "超出说明书适应症的长期“保养”或“预防”性服用，未检索到适应症内直接证据。",
    "排便姿势与通便措施仅具排便力学与血流动力学终点，未检索到以心血管事件为终点的研究。",
    "出院后自备、按需含服这一用法未检索到以临床结局为终点的直接研究。",
    "未检索到以睡眠不足人群为对象、以本品为干预的临床研究，此为证据空缺，非已证实无效。",
    "指南对体检报告该所见后各后续检查的推荐强度与证据等级未获核验，不逐条给出。",
  ]) {
    const ledger = coverageLedgerObject();
    ledger.entries[2].question = sentence;
    const issues = coverageBlocking(ledger, (input) => {
      input.reportText = input.reportText.replace("## 结论\n", `## 结论\n${sentence}\n`);
    });
    assert.deepEqual(issues, [], `a compliant admission of a gap was flagged: ${sentence}`);
  }
  // And the sentence that turns the same admission into a finding about the
  // literature still blocks, so this cannot pass by the rule being gone.
  const asserted = coverageLedgerObject();
  asserted.entries[2].question = "本品在该人群中的院外自救有无以临床结局为终点的直接研究";
  assert.ok(coverageBlocking(asserted, (input) => {
    input.reportText = input.reportText.replace(
      "## 结论\n",
      "## 结论\n本品在该人群中的院外自救无相关证据 [1] <!-- claim:CLM-001 -->。\n",
    );
  }).length > 0);
});



test("naming a quantity as an objective is not reporting one", () => {
  // The abstract's 目的 sentence says what the paper set out to count. Reading
  // it as a proportion told the author to rewrite a statement of intent as a
  // gap declaration, which is not a thing an abstract can say.
  const ledger = coverageLedgerObject();
  ledger.entries = [{
    id: "1.1",
    question: "胸痛心源性与常见非心源性病因的构成比",
    status: "gap",
    searches: ledger.entries.find((entry) => entry.status === "gap")?.searches
      ?? [{ query: "chest pain aetiology proportion", database: "PubMed", searchedAt: "2026-08-13" }],
  }];
  const issues = coverageBlocking(ledger, (input) => {
    input.reportText = input.reportText.replace(
      "## 摘要\n",
      "## 摘要\n**目的** 清点胸痛心源性与常见非心源性病因的构成比。\n",
    );
  });
  assert.deepEqual(issues.filter((issue) => /给出了排序或构成比/.test(issue)), []);
});

// --- The ledger against the brief -------------------------------------------
//
// These replace the one heuristic this section used to end with: the abstract
// was read for a sentence restating the study's scope, the questions it named
// were counted, and that number was compared to the ledger's. Both numbers were
// written by the run, so the only defect it could reach was the run disagreeing
// with itself — and the red-team construction below (register three of five and
// mark all three answered) was completely silent, while over the 30 delivered
// packages one of the two notices it raised was a false one.

/** @param {any} ledger @param {(input: any) => void} [edit] */
function coverageIssues(ledger, edit) {
  const result = validateClinicalEvidencePackage(coveragePackage(ledger, edit));
  return result.blockingIssues.filter((issue) => (
    /^question-coverage\.json /.test(issue) || /^题面第 \d+ 问在/.test(issue) || /^工作区里的题面/.test(issue)
  ));
}

test("a brief question the ledger does not register at all is named", () => {
  // The construction the old scope heuristic could not see: the brief asks two
  // questions, the ledger registers one of them, every entry says "answered",
  // and the report never mentions the other. Nothing in the package contradicts
  // anything else in the package.
  const ledger = coverageLedgerObject();
  ledger.entries = ledger.entries.filter((entry) => !entry.id.startsWith("2."));
  const issues = coverageIssues(ledger);
  assert.ok(
    issues.some((issue) => /^题面第 2 问在 question-coverage\.json 中没有任何条目/.test(issue)),
    issues.join("\n") || "no finding",
  );
  assert.match(issues.join("\n"), /题面共 2 问/);
  assert.equal(clinicalEvidencePackageErrorCode(issues), "specialist_question_coverage_understated");
});

test("an entry standing in for a question it does not transcribe is named, and so is the question it does", () => {
  // Merging: one sub-question registered twice under two numbers, so the count
  // comes out right and one of the brief's questions is never addressed.
  const merged = coverageLedgerObject();
  merged.entries = merged.entries.map((entry) => (
    entry.id.startsWith("2.")
      ? { ...entry, question: merged.entries[0].question }
      : entry
  ));
  const issues = coverageIssues(merged);
  assert.ok(
    issues.some((issue) => (
      /条目 2\.1 的 question 不是题面第 2 问的原文/.test(issue) && /这一条转录的是题面第 1 问/.test(issue)
    )),
    issues.join("\n") || "no finding",
  );
  assert.equal(clinicalEvidencePackageErrorCode(issues), "specialist_question_coverage_invalid");

  // Invention: text that came from neither question.
  const invented = coverageLedgerObject();
  invented.entries[0].question = "本报告自拟的一条概括性子问，与题面任何一问都无关";
  assert.match(
    coverageIssues(invented).join("\n"),
    /条目 1\.1 的 question 不是题面第 1 问的原文.*台账条目必须逐字转录/s,
  );

  // A sub-question split off a shared stem still transcribes its question: 579
  // of the corpus's 611 entries are an exact substring and the other 32 look
  // like this. None of them may be called an invention.
  const split = coverageLedgerObject();
  split.entries[0].question = "胸口突然发闷发紧、像被压着一样，是心绞痛";
  assert.deepEqual(coverageIssues(split), []);
});

test("an id outside the brief's numbering is named as a ledger defect", () => {
  const ledger = coverageLedgerObject();
  ledger.entries.push({ ...ledger.entries[0], id: "7.1" });
  const issues = coverageIssues(ledger);
  assert.ok(
    issues.some((issue) => /条目 7\.1 的编号指向题面第 7 问，而题面只有 2 问/.test(issue)),
    issues.join("\n") || "no finding",
  );
});

test("an item the brief names that the report never uses is named, item by item", () => {
  // The largest confirmed class: the brief spells out seven measured effects,
  // the report works through three of them, and the other four leave without a
  // word. The report is not self-contradictory anywhere.
  const brief = researchBrief().replace(
    "1. 胸口突然发闷发紧",
    "1. 请给出心率、血压、心率变异性、儿茶酚胺水平、房性期前收缩负荷、炎症指标、随访时长各自的实测数据。胸口突然发闷发紧",
  );
  const issues = coverageIssues(coverageLedgerObject(), (input) => {
    input.briefText = brief;
    input.reportText = input.reportText.replace(
      "## 讨论\n",
      "## 讨论\n本节给出心率、血压与心率变异性的实测数据。\n",
    );
  });
  const named = issues.find((issue) => /把题面第 1 问登记为 answered/.test(issue));
  assert.ok(named, issues.join("\n") || "no finding");
  for (const term of ["儿茶酚胺水平", "房性期前收缩负荷", "炎症指标"]) {
    assert.ok(named.includes(term), `${term} is absent from the report and must be named: ${named}`);
  }
  // Items that are on the page are not named.
  for (const term of ["心率变异性", "血压"]) {
    assert.ok(!named.includes(`「${term}」`), `${term} is on the page and must not be named: ${named}`);
  }
  assert.equal(clinicalEvidencePackageErrorCode(issues), "specialist_question_coverage_unsupported");
});

test("a term the report writes differently is not a term the report dropped", () => {
  // Sixteen single-item alerts from the corpus were read back by hand: three
  // were real and nine were the brief and the report spelling one thing two
  // ways. The claim this check makes is that a subject is absent, not that a
  // phrase is, so it holds when the report says 硝酸酯 for 硝酸酯类, 心绞痛发作
  // for 心绞痛终点, and 适应症 for 适应证.
  const report = briefCollapse("本节说明适应症范围与辨症分型标准，比较硝酸酯药物与心绞痛发作频率。");
  for (const written of ["适应证范围", "辨证分型标准", "硝酸酯类药物", "心绞痛终点"]) {
    assert.equal(briefTermPresent(written, report), true, `${written} is on the page in another spelling`);
  }
  // A subject the report genuinely never raises is still absent.
  for (const missing of ["儿茶酚胺水平", "房性期前收缩负荷", "肿瘤坏死因子"]) {
    assert.equal(briefTermPresent(missing, report), false, `${missing} is nowhere on the page`);
  }
  // And a term too short to carry the claim is never called absent: 终点 is
  // "missing" from a report that says 结局 throughout.
  assert.equal(briefTermPresent("终点", briefCollapse("本文以结局为准")), false);
  assert.equal(briefCollapse("适应证"), briefCollapse("适应症"));
});

test("two of a list on the page settles that the list is the subject", () => {
  // A ratio gate used to require a third of a list to be present before any
  // absence counted, and it read the strongest case backwards: six of RQ-16's
  // eight measured effects are missing, which scores 0.25 and was discarded
  // whole. Two present is what says the list belongs to this report.
  const brief = researchBrief().replace(
    "1. 胸口突然发闷发紧",
    "1. 请给出研究设计、心率变异性、心房颤动发作、儿茶酚胺水平、房性期前收缩负荷、炎症与内皮功能、皮质醇节律水平、压力反射敏感性、血浆去甲肾上腺素、清晨皮质醇峰值、夜间血压下降率、白细胞介素六、肿瘤坏死因子、随访时长各自的实测效应。胸口突然发闷发紧",
  );
  const issues = coverageIssues(coverageLedgerObject(), (input) => {
    input.briefText = brief;
    input.reportText = input.reportText.replace(
      "## 讨论\n",
      "## 讨论\n本节给出心率变异性与心房颤动发作的实测数据。\n",
    );
  });
  const named = issues.find((issue) => /把题面第 1 问登记为 answered/.test(issue));
  assert.ok(named, issues.join("\n") || "no finding");
  assert.ok(named.includes("儿茶酚胺水平"), named);
});

test("an enumeration the report is not working through at all is not read as dropped items", () => {
  // The other side of the same rule. When none of a list is on the page, the
  // list is off this report's topic (or the brief sentence was cut badly);
  // reading that as six dropped items is how a term check turns into noise.
  // Measured over the delivered corpus, this bar removes 93 of 244 flagged
  // items and every run where nothing matched.
  const brief = researchBrief().replace(
    "1. 胸口突然发闷发紧",
    "1. 请给出甲状腺功能亢进、嗜铬细胞瘤、原发性醛固酮增多症、肢端肥大症各自的患病率。胸口突然发闷发紧",
  );
  assert.deepEqual(coverageIssues(coverageLedgerObject(), (input) => { input.briefText = brief; }), []);
});

test("a long list of which nothing is on the page is the question going missing", () => {
  // The worst case was the one the item rule could not see. Requiring some of
  // a list to be present kept the noise down, and a question dropped whole has
  // nothing present by definition -- on the corpus, RQ-16's second question
  // names eight measured effects, the report contains none of them, and the
  // family stayed quiet. Length is what separates the two readings: a short
  // list that misses entirely is more likely a badly cut sentence, a long one
  // is a question nobody answered.
  const brief = researchBrief().replace(
    "1. 胸口突然发闷发紧",
    "1. 请给出心率与血压、儿茶酚胺、期前收缩负荷、炎症与内皮、皮质醇节律、压力反射敏感性各自的实测效应。胸口突然发闷发紧",
  );
  const issues = coverageIssues(coverageLedgerObject(), (input) => { input.briefText = brief; });
  const named = issues.find((issue) => /一项都没有出现/.test(issue));
  assert.ok(named, issues.join("\n") || "no finding");
  assert.ok(/题面第 1 问/.test(named), named);
  assert.equal(clinicalEvidencePackageErrorCode(issues), "specialist_question_coverage_unsupported");
  // And it is reported once at the question, not once per item: the extraction
  // is the thing in doubt, so the items are evidence, not separate claims.
  assert.equal(issues.filter((issue) => /一项都没有出现/.test(issue)).length, 1);
});

test("a brief pasted with Windows line endings is still parsed", () => {
  // $ in the heading pattern matches only at end of input, so a trailing \r
  // made every heading fail and the whole brief-derived family went quiet --
  // on exactly the briefs a person is most likely to paste out of Word.
  const brief = researchBrief().replace(
    "2. 长期随访中血脂谱变化与再入院率的关联有无直接研究？",
    "2. 这一问被删掉了，台账里不会有它。",
  );
  const ledger = coverageLedgerObject();
  ledger.entries = ledger.entries.filter((entry) => !entry.id.startsWith("2."));
  const missing = /题面第 2 问/;
  for (const [label, text] of [["LF", brief], ["CRLF", brief.replace(/\n/g, "\r\n")]]) {
    const issues = coverageIssues(ledger, (input) => { input.briefText = text; });
    assert.ok(issues.some((issue) => missing.test(issue)), `${label}: ${issues.join("\n") || "no finding"}`);
  }
});

test("a question registered wholly as a gap is not also held to its named items", () => {
  // A run that says "I searched for this and found nothing", with a search the
  // log confirms, has already answered for the whole question. Naming its items
  // as well would tell it to write the very sentences it just declared absent.
  const ledger = coverageLedgerObject();
  const gapEntry = ledger.entries.find((entry) => entry.status === "gap");
  ledger.entries = [
    ...ledger.entries.filter((entry) => entry.status !== "gap"),
    { ...gapEntry, id: "1.9", question: ledger.entries[0].question },
  ].map((entry) => (entry.id.startsWith("1.") ? entry : entry));
  const brief = researchBrief().replace(
    "2. 长期随访中血脂谱变化与再入院率的关联有无直接研究？",
    "2. 长期随访中血脂谱变化与再入院率的关联有无直接研究？请给出总胆固醇、甘油三酯、载脂蛋白B、脂蛋白a的随访数据。",
  );
  const onlyGap = coverageLedgerObject();
  onlyGap.entries = onlyGap.entries.filter((entry) => entry.status === "gap");
  const issues = coverageIssues(onlyGap, (input) => { input.briefText = brief; });
  assert.deepEqual(issues.filter((issue) => /把题面第 2 问登记为 answered/.test(issue)), []);
});

test("without the brief the coverage check degrades in the open rather than silently", () => {
  // A server restart loses the brief for an in-flight run. What must not happen
  // is a package delivered as though it had been checked against one.
  const missing = coverageLedgerObject();
  missing.entries = missing.entries.filter((entry) => !entry.id.startsWith("2."));
  for (const briefText of [null, undefined, "什么都没有的一段自由文本，没有编号问题清单"]) {
    const result = validateClinicalEvidencePackage(coveragePackage(missing, (input) => {
      input.briefText = briefText;
    }));
    assert.deepEqual(
      result.issues.filter((issue) => /^题面第 \d+ 问在/.test(issue)),
      [],
      `${briefText}: the brief-derived rules must not run without a brief`,
    );
    assert.match(String(result.coverageDegradedNotice), /未按题面逐问核对覆盖/);
    // Still a check, not a waiver: the self-consistency half is unaffected.
    assert.deepEqual(
      validateClinicalEvidencePackage(coveragePackage("not json", (input) => {
        input.briefText = briefText;
      })).blockingIssues.filter((issue) => /^question-coverage\.json 台账格式无效/.test(issue)).length,
      1,
    );
  }
  // With a usable brief there is nothing to disclose.
  assert.equal(validateClinicalEvidencePackage(deepResearchPackage()).coverageDegradedNotice, null);
});

test("a workspace brief the run has rewritten is reported, and never used", () => {
  const rewritten = researchBrief().replace("2. 长期随访中血脂谱变化与再入院率的关联有无直接研究？", "");
  const result = validateClinicalEvidencePackage(coveragePackage(coverageLedgerObject(), (input) => {
    input.workspaceBriefText = rewritten;
  }));
  assert.ok(
    result.blockingIssues.some((issue) => /^工作区里的题面只读副本/.test(issue)),
    result.blockingIssues.join("\n") || "no finding",
  );
  assert.equal(clinicalEvidencePackageErrorCode(result.blockingIssues), "specialist_question_coverage_invalid");
  // The gate judged the server's brief, not the rewritten one: dropping the
  // second question from the workspace copy did not excuse the ledger from it.
  assert.deepEqual(result.issues.filter((issue) => /^题面第 2 问在/.test(issue)), []);
  // An identical copy, and a copy with only whitespace differences, are silent.
  for (const copy of [researchBrief(), `${researchBrief()}\n\n`]) {
    assert.deepEqual(
      validateClinicalEvidencePackage(coveragePackage(coverageLedgerObject(), (input) => {
        input.workspaceBriefText = copy;
      })).issues.filter((issue) => /^工作区里的题面/.test(issue)),
      [],
    );
  }
});

test("an absent evidence matrix is one problem, not one per claim marker in the report", () => {
  // Observed on a real run (rq01, 2026-08-26): the run wrote the report and
  // never wrote `clinical-evidence-matrix.json`. The verdict came back with 23
  // blocking issues, 14 of them naming a different CLM id that "does not
  // resolve to the evidence matrix" — fourteen ids to chase, and not one of
  // them the problem. Same shape as the absent-report case, one file over.
  const input = deepResearchPackage();
  input.matrix = null;

  const result = validateClinicalEvidencePackage(input);
  const unresolved = result.issues.filter((issue) => /does not resolve to the evidence matrix/.test(issue));

  assert.deepEqual(unresolved, [], "the missing file must not be restated once per claim marker");
  assert.ok(
    result.issues.some((issue) => /evidence matrix must contain the report's material claims/.test(issue)),
    "and it must still be reported once",
  );
});

test("a matrix that exists and lacks a cited claim still names that claim", () => {
  // The control for the case above: suppressing the per-claim finding when
  // there is no matrix must not suppress it when there is one. Without this,
  // the fix above would silently retire a real rule and every package missing a
  // single claim would pass.
  const input = deepResearchPackage();
  const citedByReport = [...String(input.reportText).matchAll(/claim:(CLM-\d+)/g)].map((m) => m[1]);
  assert.ok(citedByReport.length >= 2, "fixture must cite at least two claims for this control to mean anything");
  const dropped = citedByReport[citedByReport.length - 1];
  input.matrix = { ...input.matrix, claims: input.matrix.claims.filter((c) => (c.claimId ?? c.id) !== dropped) };
  assert.ok(input.matrix.claims.length > 0, "the matrix must still be non-empty, or this tests the other branch");

  const result = validateClinicalEvidencePackage(input);

  assert.ok(
    result.issues.some((issue) => issue.includes(`Report claim reference ${dropped} does not resolve`)),
    `${dropped} was dropped from a non-empty matrix and must still be reported`,
  );
});

test("an empty matrix is one problem in the coverage ledger too, not one per claim id it names", () => {
  // Third location of the absent-matrix cascade. The report side was fixed
  // earlier today; this one then cost a real run (rq03b) its last repair
  // attempt: the matrix was momentarily empty at the third gate, the coverage
  // ledger still named its claims, and the verdict came back with 114 issues
  // of which ~78 were this one sentence with a different id in it. Three real
  // problems were in there somewhere and the run never saw them.
  const input = deepResearchPackage();
  const cited = [...String(input.reportText).matchAll(/claim:(CLM-\d+)/g)].map((m) => m[1]);
  assert.ok(cited.length >= 2, "the fixture must cite claims for this to mean anything");
  input.matrix = { ...input.matrix, claims: [] };
  input.keepCoverage = true;
  input.questionCoverageText = JSON.stringify({
    schemaVersion: 1,
    entries: cited.map((id, index) => ({
      id: `1.${index + 1}`,
      question: `这是第 ${index + 1} 个需要回答的原子子问，长度足够通过形状检查。`,
      status: "answered",
      reportLines: [10 + index],
      claimIds: [id],
    })),
  });

  const dangling = validateClinicalEvidencePackage(input).issues.filter((issue) => /claimIds 提到/.test(issue));

  assert.deepEqual(dangling, [], "an absent matrix must not be restated once per id the ledger names");
});

test("a matrix that exists and lacks an id the ledger names still reports that id", () => {
  // The control. Suppressing the cascade for an empty matrix must not retire
  // the rule for a populated one, or a ledger could name anything it liked.
  const input = deepResearchPackage();
  const real = input.matrix.claims[0]?.claimId;
  assert.ok(real, "fixture must have at least one claim");
  input.keepCoverage = true;
  input.questionCoverageText = JSON.stringify({
    schemaVersion: 1,
    entries: [{
      id: "1.1",
      question: "这是一个长度足够通过形状检查的原子子问原文转录。",
      status: "answered",
      reportLines: [10],
      claimIds: [real, "CLM-999"],
    }],
  });

  const issues = validateClinicalEvidencePackage(input).issues;

  assert.ok(issues.some((issue) => /claimIds 提到 "CLM-999"/.test(issue)), "a dangling id against a real matrix must still be named");
  assert.ok(!issues.some((issue) => new RegExp(`claimIds 提到 "${real}"`).test(issue)), "and a resolvable id must not be");
});

test("every file the capability manifest requires is named by the run-side gate when it is absent", async () => {
  // The invariant the tree states in prose: whatever the server gate rejects,
  // the run-side gate must already catch. It was asserted in a comment and
  // enforced by nothing, and it was false for three of the eight required
  // outputs — with citation-ledger.csv, references.bib or citation-audit.md
  // absent, the run-side gate returned ok=true with zero required issues while
  // the server failed the run with specialist_required_output_missing.
  //
  // Two gates, one package, opposite verdicts. It cost RQ-03 two full runs:
  // both spent all three repair attempts on citation binding, were told
  // nothing about the two files they had never created, and died at the server
  // boundary with the attempts gone.
  //
  // Derived from the manifest, not from a list here, so a file added to
  // `produces.outputs` tomorrow is covered without anyone remembering to.
  const { runGate } = await import("@evimed/domain");
  const manifest = await readFile(
    new URL("../../../capabilities/clinical-evidence-synthesis/capability.yaml", import.meta.url),
    "utf8",
  );
  const produces = manifest.slice(manifest.indexOf("- contractKind: clinical-evidence-report"));
  const required = [...produces.matchAll(/- path:\s*(\S+)\s*\n\s*required:\s*true/g)].map((match) => match[1]);
  assert.ok(required.length >= 8, `expected the manifest's required outputs, found ${required.length}`);

  const input = deepResearchPackage();
  const complete = new Map([
    ["clinical-evidence-report.md", input.reportText],
    ["clinical-evidence-matrix.json", JSON.stringify(input.matrix)],
    ["clinical-evidence-run.json", JSON.stringify(input.runReceipt)],
    ["clinical-evidence-search.json", input.searchLogText ?? "{}"],
    ["citation-ledger.csv", input.citationLedgerText ?? "claimId,referenceNumber,supportQuote\n"],
    ["references.bib", input.referencesText ?? "@article{a,title={x}}\n"],
    ["citation-audit.md", input.citationAuditText ?? "# audit\n"],
    ["question-coverage.json", input.questionCoverageText ?? "{}"],
  ]);
  const expectedOutputs = required.map((relative) => ({ path: relative, required: true }));

  for (const relative of required) {
    const files = new Map(complete);
    files.delete(relative);
    const verdict = runGate({
      contractKind: "clinical-evidence-report",
      files,
      expectedOutputs,
      sourceArtifacts: input.sourceArtifacts ?? {},
    });

    assert.equal(verdict.ok, false, `${relative} is required and its absence must fail the gate`);
    assert.ok(
      verdict.issues.some((entry) => String(entry.message).includes(relative)),
      `${relative} is missing and no issue names it — the run cannot fix what it is not told about`,
    );
  }
});

test("a matrix written to a different schema is one problem, not one per field per claim", () => {
  // Fourth appearance of this family today. A real run (rq03d) wrote 25 claims
  // shaped {id, claim, evidence, certainty} instead of the contract's, and the
  // verdict came back with 386 required issues — roughly fifteen field errors
  // for each of twenty-five claims, and not one of them saying "you used the
  // wrong shape". The run has to infer the schema from the wreckage, with two
  // repair attempts left.
  const input = deepResearchPackage();
  input.matrix = {
    schemaVersion: 1,
    claims: Array.from({ length: 25 }, (_, index) => ({
      id: `CLM-${String(index + 1).padStart(3, "0")}`,
      claim: `命题 ${index + 1}`,
      evidence: ["[1]"],
      certainty: "high",
      certaintyFramework: "GRADE",
    })),
  };

  const result = validateClinicalEvidencePackage(input);

  assert.equal(result.blockingIssues.length, 1, `one shape mismatch is one problem, got ${result.blockingIssues.length}`);
  const message = result.blockingIssues[0];
  assert.match(message, /different claim shape/);
  assert.match(message, /25 claims/, "the run should know this is systematic, not one bad entry");
  assert.match(message, /claimId/, "and what the contract actually asks for");
  assert.match(message, /id, claim, evidence/, "and what it wrote instead, so it can see the mismatch");
});

test("one malformed claim among good ones is still reported field by field", () => {
  // The control, and the reason the test above is narrow. Collapsing on any
  // missing claimId would hide a single bad entry behind a schema complaint
  // that is not true of the other twenty-four — there the field list IS the
  // useful answer.
  const input = deepResearchPackage();
  const good = input.matrix.claims;
  assert.ok(good.length >= 1, "fixture must have a well-formed claim to keep");
  input.matrix = { ...input.matrix, claims: [...good, { claim: "缺了几乎所有字段的一条" }] };

  const result = validateClinicalEvidencePackage(input);

  assert.ok(
    !result.blockingIssues.some((entry) => /different claim shape/.test(entry)),
    "a matrix with valid claims must not be called a schema mismatch",
  );
  assert.ok(
    result.issues.some((entry) => new RegExp(`claims\\[${good.length}\\]\\.claimId`).test(entry)),
    "the bad entry must still be named field by field",
  );
});
