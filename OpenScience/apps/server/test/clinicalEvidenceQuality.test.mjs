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

function deepResearchPackage() {
  const domains = [
    "pubmed.ncbi.nlm.nih.gov",
    "www.acc.org",
    "www.escardio.org",
    "www.cochrane.org",
  ];
  const sources = Array.from({ length: 12 }, (_, index) => {
    const referenceNumber = index + 1;
    return {
      referenceNumber,
      sourceUrl: `https://${domains[index % domains.length]}/evidence/source-${referenceNumber}`,
      sourceTitle: `Verified clinical source ${referenceNumber}`,
      artifactPath: `.evimed-sources/source-${referenceNumber}/content.md`,
      identifier: `PMID ${900000 + referenceNumber}`,
      supportQuote: `Verified source passage ${referenceNumber} directly supports the corresponding bounded clinical statement.`,
    };
  });
  const claims = Array.from({ length: 18 }, (_, index) => {
    const source = sources[index % sources.length];
    return {
      claimId: `CLM-${String(index + 1).padStart(3, "0")}`,
      claim: "This bounded clinical statement is supported by inspected evidence.",
      sourceUrl: source.sourceUrl,
      sourceTitle: source.sourceTitle,
      artifactPath: source.artifactPath,
      identifier: source.identifier,
      accessLevel: index % 3 === 0 ? "official_page" : "full_text",
      supportQuote: source.supportQuote,
      applicability: "The population, symptom context, and urgent-care setting are explicitly bounded.",
      uncertainty: "Residual indirectness and individual diagnostic uncertainty remain.",
      referenceNumber: source.referenceNumber,
    };
  });
  const claimLines = claims.map((item) => (
    `${item.claim} [${item.referenceNumber}](${item.sourceUrl}) <!-- claim:${item.claimId} -->`
  ));
  const reportText = [
    "# 急性胸部压迫感的鉴别与处置",
    "",
    "## 摘要",
    "急性胸部压迫感的学术判断必须同时处理时间敏感性、鉴别诊断的不确定性、检查路径的条件性和治疗建议的适用边界。本文以结构化临床问题为起点，将指南、诊断研究、系统证据与官方资料按主张逐项对应，并将可直接支持的结论与仍需临床评估的部分分开表述。",
    "",
    "## 临床问题与分析框架",
    claimLines.slice(0, 3).join("\n\n"),
    "",
    "## 检索与方法",
    "证据发现采用可复现的概念组合法，覆盖症状表型、急性冠脉事件、非心源性胸部不适、早期分层、诊断路径、院前处置与药物边界。来源按预设资格标准筛选，并以直接支持程度、适用人群、照护场景、方法学质量和证据新近性进行分层。只有已检查摘要、结构化记录、官方页面或全文的来源才能进入主张矩阵。",
    claimLines.slice(3, 6).join("\n\n"),
    "",
    "## 结果",
    "纳入证据共同支持一种安全优先、分层评估的分析路径：症状描述影响先验判断，但不能单独完成病因归类；紧急性由症状动态、生命体征、心电图、生物标志物及临床背景共同决定；药物相关结论必须服从具体适应证和证据层级。",
    claimLines.slice(6, 10).join("\n\n"),
    "",
    "## 诊断与鉴别",
    "胸部压迫感的诊断推理需要区分危险病因的及时排除与常见病因的后续确认。症状位置、性质、诱因和伴随表现可以调整可能性，却不能替代标准化评估。胃食管、肌骨和焦虑相关机制可以产生相似体验，因此早期判断应避免把单一症状或服药反应当成诊断试验。",
    claimLines.slice(10, 13).join("\n\n"),
    "",
    "## 证据综合与临床含义",
    "跨来源综合显示，高水平临床写作的关键不在于堆叠结论，而在于明确每个结论由何种证据支持、证据适用于谁、哪些变量可能改变结论，以及未被证据直接回答的问题。诊断性证据、治疗性证据与公共急救建议应分别解释，避免相互替代。",
    claimLines.slice(13, 15).join("\n\n"),
    "",
    "## 讨论",
    "现有证据形成了方向一致但层级不同的知识结构。指南提供决策路径和风险控制原则，诊断研究说明检查策略的性能边界，系统证据汇总干预研究的总体可信度，官方资料则界定公共处置和药品使用的规范语境。综合时应优先保留这些来源之间的一致核心，并对来源目的不同造成的表述差异进行解释。",
    "临床推理还应区分群体证据和个体决策。群体层面的关联不能直接确定个体病因，诊断阈值也依赖检测平台、症状时间和医疗环境。因而，规范报告应把确定性结论写得清楚，把条件性结论写出适用前提，把推断性内容标明不确定来源。这种表达方式能同时提高科学严谨性与临床可执行性。",
    "在药物问题上，证据边界尤为重要。某种药物在特定人群中的研究结果，不能自动外推为院前排除急症的工具，也不能用症状是否缓解反推病因。药物价值、用药安全与急诊分流属于不同的决策问题，需要分别由相应证据支持。",
    "为确保篇幅反映真实学术分析而非模板扩写，本节围绕证据层级、因果边界、诊断不确定性、外部适用性、临床后果和沟通方式展开论证。".repeat(120),
    claimLines.slice(15, 18).join("\n\n"),
    "",
    "## 局限与不确定性",
    "纳入来源的方法学质量与偏倚风险并不完全一致，部分诊断结论对人群谱和检测平台存在间接性。医疗体系、管辖权和院前资源差异限制了公共建议的直接适用性，个体层面的敏感度、特异度和似然比还需要结合具体检查路径解释。证据新近性也可能影响药物和诊断策略的外推，因此结论保留明确的条件边界。",
    "",
    "## 结论",
    "高质量结论应先回答危险性和决策顺序，再说明鉴别诊断与药物证据，最后明确哪些问题仍需现场检查。学术报告与实用处置可以共享证据基础，但必须保持用途和语气的区别。",
    "",
    "## 实际处置",
    `1. 先按时间敏感的胸痛情境进行风险判断并寻求规范评估。[1](${sources[0].sourceUrl}) <!-- claim:CLM-001 -->`,
    `2. 不以症状描述或服药后的主观变化自行排除危险病因。[2](${sources[1].sourceUrl}) <!-- claim:CLM-002 -->`,
    `3. 后续鉴别与治疗由现场检查结果、个体背景和适用指南共同决定。[3](${sources[2].sourceUrl}) <!-- claim:CLM-003 -->`,
    "",
    "## 参考文献",
    ...sources.map((source) => (
      `${source.referenceNumber}. Author group. ${source.sourceTitle}. Journal. DOI: example.${source.referenceNumber}. ${source.sourceUrl}`
    )),
  ].join("\n");
  const sourceArtifacts = Object.fromEntries(
    sources.map((source) => [source.artifactPath, source.supportQuote]),
  );
  const searchLogText = JSON.stringify({
    schemaVersion: 1,
    queries: Array.from({ length: 8 }, (_, index) => ({
      database: index % 2 === 0 ? "PubMed" : "Official guidelines",
      query: `distinct structured search concept ${index + 1}`,
    })),
    screening: {
      recordsIdentified: 42,
      recordsAfterDeduplication: 24,
      sourcesIncluded: 12,
    },
    sourceRecords: sources.map((source, index) => ({
      sourceUrl: source.sourceUrl,
      included: true,
      accessLevel: index < 10 ? "full_text" : "official_page",
    })),
  });
  const referencesText = sources.map((source) => [
    `@article{source${source.referenceNumber},`,
    `  title = {${source.sourceTitle}},`,
    `  doi = {10.1000/source.${source.referenceNumber}},`,
    `  pmid = {${900000 + source.referenceNumber}},`,
    `  url = {${source.sourceUrl}}`,
    "}",
  ].join("\n")).join("\n\n");
  const citationLedgerText = [
    "claimId,referenceNumber,supportQuote",
    ...claims.map((item) => `${item.claimId},${item.referenceNumber},"${item.supportQuote}"`),
  ].join("\n");
  const citationAuditText = [
    "# Citation audit",
    "Unresolved identifiers: none after DOI and PMID normalization.",
    "Duplicate detection: title, identifier, and URL fields were compared before inclusion.",
    "Correction and retraction checks: no correction or retraction notice was identified for the included records.",
    "Metadata-only exclusion: bibliographic metadata alone was not treated as support for a clinical claim.",
    "Claim mismatch review: each support passage was compared with the exact bounded proposition and context.",
    "The audit also reviewed source authority, publication type, population applicability, care setting, intervention identity, outcome meaning, conflicting interpretations, and the distinction between direct evidence and cautious inference. ".repeat(8),
  ].join("\n\n");
  return {
    reportText,
    matrix: { schemaVersion: 1, claims },
    searchLogText,
    referencesText,
    citationLedgerText,
    citationAuditText,
    runReceipt: {
      question: "胸口突然发闷发紧、像被压着一样，是心绞痛还是胃病？该先怎么办？",
      reportProfile: "academic_deep_research_v1",
      status: "succeeded",
      successfulSourceArtifacts: sources.map((source) => source.artifactPath),
      failedSources: [],
      stats: {
        totalSearches: 8,
        recordsIdentified: 42,
        recordsAfterDeduplication: 24,
        sourcesIncluded: 12,
        distinctPreservedSources: 12,
      },
      qualityChecks: {
        claimTraceability: true,
        contradictionAudit: true,
        arithmeticAudit: true,
        citationAudit: true,
      },
    },
    sourceArtifacts,
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

test("accepts a publication-grade deep-research package with reproducible searches and citation artifacts", () => {
  const input = deepResearchPackage();
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, true, result.issues.join("\n"));
  assert.equal(result.claimIds.length, 18);
  assert.equal(result.sourceDomains.length, 4);
});

test("rejects a shallow report that falsely claims the deep-research profile", () => {
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
  assert.match(issues, /at least 10000 characters/);
  assert.match(issues, /at least 18 material claims/);
  assert.match(issues, /at least eight distinct documented search queries/);
  assert.match(issues, /at least 30 identified records and 12 included sources/);
  assert.match(issues, /at least 12 complete numbered references/);
  assert.match(issues, /at least 12 bibliography entries/);
  assert.match(issues, /at least 18 claim rows/);
  assert.match(issues, /at least 8 distinct successful source artifacts/);
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
  assert.match(issues, /at least 8 distinct successful source artifacts/);
  assert.match(issues, /companion XML and Markdown files cannot be counted twice/);
});
