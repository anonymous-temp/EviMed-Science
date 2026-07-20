import type { WebResearchAgent } from "./apiClient";

interface AgentTranslation {
  code: string;
  title: string;
  category: string;
  description: string;
  starterPrompts: string[];
}

const translations: Record<string, AgentTranslation> = {
  "adr-analysis": {
    code: "SA",
    title: "药品安全性分析",
    category: "药物警戒",
    description: "开展不良事件信号挖掘、说明书比对与安全性证据汇总。",
    starterPrompts: ["分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。"],
  },
  "off-label-analysis": {
    code: "OL",
    title: "超说明书用药分析",
    category: "循证评价",
    description: "逐项比对属地说明书，辅助评价证据支持度；缺失信息会先集中提示补充。",
    starterPrompts: ["按适应证、人群、剂量和给药方案逐项比对属地说明书，并辅助评价证据支持度。"],
  },
  "comprehensive-drug-evaluation": {
    code: "CE",
    title: "综合药品评价",
    category: "综合评价",
    description: "从有效性、安全性、适用性、经济性与可及性等维度完成可追溯评价；提供量表时可辅助计分。",
    starterPrompts: ["围绕一个药品及适应证完成综合评价；先提示缺项，提供量表时辅助计分。"],
  },
  "drug-selection": {
    code: "DS",
    title: "药品遴选评价",
    category: "药品遴选",
    description: "结合 EviMed 证据与用户提供的量表辅助药品遴选；缺项不计零，仅在数据可比时排名。",
    starterPrompts: ["比较候选药品，先提示我补齐量表和关键数据，再生成可追溯评分与敏感性分析。"],
  },
  "meta-analysis": {
    code: "MA",
    title: "自动化 Meta 分析",
    category: "证据综合",
    description: "自动完成系统评价、统计合并、偏倚风险、GRADE、图表、论文与发布质量门。",
    starterPrompts: ["围绕一个明确的 PICO 问题完成系统评价和 Meta 分析，并生成可追溯的完整研究包。"],
  },
  "mendelian-randomization": {
    code: "MR",
    title: "孟德尔随机化",
    category: "因果推断",
    description: "基于 GWAS 工具变量完成因果推断、敏感性分析与 STROBE-MR 研究报告。",
    starterPrompts: ["评估体重指数对冠心病的因果效应，并完成双向孟德尔随机化分析。"],
  },
  "bibliometric-analysis": {
    code: "BA",
    title: "文献计量分析",
    category: "研究全景",
    description: "分析发文趋势、合作网络、主题演化、突现词和研究前沿。",
    starterPrompts: ["分析 GLP-1 受体激动剂治疗肥胖的研究全景、热点演化和新兴前沿。"],
  },
  "research-topic-selection": {
    code: "RT",
    title: "科研选题",
    category: "研究规划",
    description: "从宽泛方向中识别证据空白、科学矛盾与可执行的高价值研究问题。",
    starterPrompts: ["围绕重症患者抗菌药精准给药，提出有证据依据且可落地的科研选题。"],
  },
  "peer-review": {
    code: "PR",
    title: "论文审稿",
    category: "研究质量",
    description: "按研究类型审查方法学、统计、报告规范、完整性并给出可执行修改建议。",
    starterPrompts: ["审查我上传的论文，定位方法学、统计学、报告规范和完整性问题。"],
  },
};

export function researchAgentUi(agent: WebResearchAgent): WebResearchAgent & { code: string } {
  const translation = translations[agent.id];
  return translation ? { ...agent, ...translation } : { ...agent, code: agent.title.slice(0, 2).toUpperCase() };
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
