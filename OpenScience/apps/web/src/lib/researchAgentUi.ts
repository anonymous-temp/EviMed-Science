import { CAPABILITY_DISPLAY, capabilityTitle as domainCapabilityTitle } from "@evimed/domain";
import type { WebResearchAgent } from "./apiClient";

/**
 * The display table moved to `@evimed/domain` on 2026-09-15.
 *
 * Two surfaces outside this bundle need it: the run ledger names the
 * capability that produced a row, and the kernel's own hero renders the
 * capability cards inside an iframe on another origin, from a catalogue the
 * server hands it. A second copy here is how the two would drift into
 * disagreeing about what a capability is called.
 */
const translations = CAPABILITY_DISPLAY;

export function researchAgentUi(agent: WebResearchAgent): WebResearchAgent & { code: string } {
  const translation = translations[agent.id];
  return translation ? { ...agent, ...translation } : { ...agent, code: agent.title.slice(0, 2).toUpperCase() };
}

/**
 * The product name of a capability, from its id alone.
 *
 * The catalog is fetched, and the run ledger is not: a run row names the
 * capability that produced it and has no title to show for it, which is why
 * the ledger, the sidebar and the run panel each displayed
 * `clinical-evidence-synthesis` — and `CLINICAL-EVIDENCE-SYNTHESIS` upper-cased
 * beside it — where a reader expected 「临床证据深度分析」 (2026-09-15 walk,
 * D1/D2). Re-exported rather than reimplemented: one table, one answer.
 *
 * Returns null for an id this build has no name for, so the caller decides
 * whether an untranslated id is better shown raw or hidden — an id silently
 * rendered as a title is the failure being fixed here.
 */
export function capabilityTitle(id: string | null | undefined): string | null {
  return domainCapabilityTitle(id);
}

export function researchInputLabel(value: string): string {
  const labels: Record<string, string> = {
    drug: "药品",
    product: "具体产品或厂家",
    drugs: "候选药品",
    indication: "适应证",
    proposedUse: "拟评价用途",
    population: "目标人群",
    adverseEvent: "关注不良事件",
    dateRange: "时间范围",
    uploadedFiles: "知识库或上传资料",
    evaluationGoal: "评价目标",
    comparator: "对照药品",
    jurisdiction: "适用国家或地区",
    candidateDrugs: "候选药品",
    selectionCriteria: "遴选标准",
    budgetContext: "预算背景",
    selectionDomains: "评价维度",
    scoringRubric: "评分量表、权重与缺失值规则",
    scoringPolicyVersion: "评分量表版本",
    economicContext: "经济性数据口径",
    productSpecifications: "产品规格",
    careSetting: "使用场景",
    timeHorizon: "评价时间范围",
    decisionDate: "评价基准日期",
    quantitativeScoringRequested: "是否需要量化评分",
    evaluationDomains: "综合评价维度",
    dose: "剂量",
    route: "给药途径",
    frequency: "给药频次",
    duration: "疗程",
    formulation: "剂型或制剂",
    topic: "研究问题",
    outcomes: "结局指标",
    studyDesign: "研究设计",
    analysisType: "分析类型",
    ipdData: "个体参与者数据",
    exposure: "暴露因素",
    outcome: "结局变量",
    analysisDirection: "分析方向",
    outputLanguage: "输出语言",
    dateFrom: "起始年份",
    dateTo: "结束年份",
    maxRecords: "最大文献数",
    researchDirection: "研究方向",
    manuscript: "待审稿件",
    articleType: "文章类型",
  };
  return labels[value] ?? value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}
