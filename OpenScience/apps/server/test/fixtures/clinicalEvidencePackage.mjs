// Shared, known-valid deep-research clinical evidence package fixture, used by
// both the clinicalEvidenceQuality unit tests and the agentRuns integration
// tests. Keep it valid: tests derive their broken variants from it.
export function deepResearchPackage() {
  const domains = [
    "pubmed.ncbi.nlm.nih.gov",
    "www.acc.org",
    "www.escardio.org",
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
      // The report body is Chinese, as a manuscript for these readers is; the
      // English support quote stays in the matrix and the ledger, which is
      // exactly where a verbatim quote belongs and where it is checked.
      claim: "该有界临床结论由已检查的证据支持。",
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
    "篇幅由临床问题与可用证据决定，不通过重复段落或拆分微小主张制造表面深度。",
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
    // referenceNumber is what makes the numbered reference list checkable
    // against the included source set: the list a reader sees must be exactly
    // the records this run read.
    sourceRecords: sources.map((source, index) => ({
      sourceUrl: source.sourceUrl,
      referenceNumber: source.referenceNumber,
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
    "Metadata-only exclusion: bibliographic metadata alone (for example PMID 900001) was not treated as support for a clinical claim.",
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
