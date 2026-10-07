/**
 * What a researcher calls the documents a capability delivers.
 *
 * The reader's title said 「≥70岁阿司匹林一级预防指南与不良反应 ·
 * clinical-evidence-report.md」 (2026-09-19 walk): the file name is the
 * contract's identifier, not the document's name. Only the human-facing
 * documents are named here; a machine file (a run record, a JSON table) keeps
 * its file name, which is what anyone who opens it needs.
 */
const DOCUMENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "clinical-evidence-report.md": "证据分析报告",
  "clinical-evidence-matrix.json": "证据矩阵",
  "safety-report.md": "安全性分析报告",
  "signals.csv": "信号数据表",
  "revision-notes.md": "修订说明",
  "reporting-checklist.md": "报告规范清单",
  "delivery-summary.md": "交付摘要",
  "comprehensive-evaluation-report.md": "综合评价报告",
  "drug-selection-report.md": "遴选评价报告",
  "off-label-report.md": "超说明书用药分析报告",
  "meta-analysis-report.md": "Meta 分析报告",
  "mendelian-randomization-report.md": "孟德尔随机化报告",
  "bibliometric-analysis-report.md": "文献计量分析报告",
  "peer-review-report.md": "审稿报告",
  "research-topic-report.md": "科研选题报告",
  "research-portfolio.md": "研究选题组合",
  "manuscript-section.md": "论文章节",
  "specific-aims.md": "具体目标",
  "proposal-outline.md": "申报书大纲",
  "grant-audit.md": "申报书自查",
  "study-protocol.md": "研究方案",
  "feasibility-matrix.md": "可行性矩阵",
  "data-profile.md": "数据剖析",
  "data-quality.md": "数据质量说明",
  "evidence-map.md": "证据图谱",
  "appraisal-table.md": "证据评价表",
  "geo-content-pack.md": "内容包",
  "geo-measurement.md": "答案引擎测量",
  // 「循证 GEO」 (2026-09-25): the reader's document of each step.
  "geo-insight.md": "证据与问题地图",
  "journey.md": "患者旅程矩阵",
  "geo-strategy.md": "信源与目标",
  "geo-content.md": "稿件清单",
  "geo-proposal.md": "提案资料包说明",
});

/** The document's name for a workspace path, or its file name when it has none. */
export function artifactDisplayName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return DOCUMENT_NAMES[name] ?? name;
}
