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

/**
 * The formats a researcher opens as a document. A run writes its helper scripts, intermediate tables and logs into the same
 * folder as its report, and a list of every file that survived put `build_final.py` beside the report (2026-10-07 audit). This is
 * the closed list of formats worth a link; the chat's file cards rank by the same extensions (`fileTypeOf`, harness-port) — copied
 * here because the web does not import the port. A JSON file is a document only when it is the evidence matrix.
 */
const READABLE_EXTENSIONS: ReadonlySet<string> = new Set(["md", "docx", "pdf", "pptx", "html", "xlsx", "csv", "tsv", "png", "jpg", "jpeg", "svg", "txt"]);
const SHEET_EXTENSIONS: ReadonlySet<string> = new Set(["xlsx", "csv", "tsv"]);
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "svg"]);

function nameAndExtension(path: string): { lower: string; extension: string } {
  const lower = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return { lower, extension: lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "" };
}

/** Whether a delivered file is one a researcher reads (see above); the rest of a run's files are its working material. */
export function isReadableArtifact(path: string): boolean {
  const { lower, extension } = nameAndExtension(path);
  if (extension === "json") return /matrix.*\.json$/.test(lower);
  // A run's own bookkeeping is not a delivery, whatever its extension: the revision notes are a backstage genre (the chat's cards skip them too).
  if (/^revision-notes?\.md$/.test(lower)) return false;
  return READABLE_EXTENSIONS.has(extension);
}

/** Where a readable file sorts: the report, then its evidence matrix, then documents, sheets, pictures; a delivery summary last. */
function readableRank(path: string): number {
  const { lower, extension } = nameAndExtension(path);
  if (extension === "json") return 1;
  if (lower === "delivery-summary.md") return 5;
  if (/report/.test(lower) && lower !== "reporting-checklist.md" && !SHEET_EXTENSIONS.has(extension) && !IMAGE_EXTENSIONS.has(extension)) return 0;
  return SHEET_EXTENSIONS.has(extension) ? 3 : IMAGE_EXTENSIONS.has(extension) ? 4 : 2;
}

/**
 * A run's files as a researcher sees them: the documents in reading order, and the rest (scripts, intermediate data, logs) kept
 * apart rather than dropped — nothing is deleted from the record, it is only not offered first.
 */
export function splitArtifacts<T extends { path: string }>(refs: readonly T[]): { readable: T[]; other: T[] } {
  const readable = refs.filter(ref => isReadableArtifact(ref.path))
    .map((ref, index) => ({ ref, index })).sort((a, b) => readableRank(a.ref.path) - readableRank(b.ref.path) || a.index - b.index).map(entry => entry.ref);
  return { readable, other: refs.filter(ref => !isReadableArtifact(ref.path)) };
}
