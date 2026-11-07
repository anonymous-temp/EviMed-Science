import { catalogue } from "@evimed/research-plugin-runtime/catalogue";
import type { VcrWorkspaceArea } from "@/lib/vcrWorkspaceNavigation";

/** Task entry metadata is independent of installation state. The extension
 * centre owns actual installation/activation; a draft never starts a job.
 * Keyed by the canonical entrance; `capability` is the package that stays
 * under its old id (package ids do not change with the entrance's name). */
const copy: Record<string, { capability: string; label: string; draft: string; summary: string; requirement: string; badge: string; examples: string[] }> = {
  "virtual-population": {
    capability: "virtual-cohort", label: "虚拟人群",
    draft: "建立可复用的研究人群。目标和已有资料是：",
    summary: "建立并查看可复用的研究人群：只描述人群，或绑定到某个反应模型。",
    requirement: "可按文献中的分布或设定开始，无需上传。用真实患者数据构建需要患者数据集；要在人群上做干预研究，还需要适用的反应模型。",
    badge: "文献可先开始",
    examples: ["根据文献中的年龄、性别和疾病分布构建一个研究人群", "按入排标准从现有病历中筛选并整理一个研究人群"],
  },
  "patient-trajectory": {
    capability: "virtual-patient", label: "患者轨迹预测",
    draft: "预测一批患者在未来一段时间的变化。患者资料和问题是：",
    summary: "一次提交一批患者（例如 100 人），得到每位患者的轨迹预测和整个人群的汇总。",
    requirement: "真实患者预测需要每位患者的基线或病史，以及适用的模型；只做情景推演时，可先用明确设定，结果会标明是情景。",
    badge: "需患者基线和适用模型",
    examples: ["预测这 100 位患者未来 12 个月的变化，并汇总整体趋势", "检查一个预后模型是否适用于这批患者"],
  },
  "virtual-lab": {
    capability: "virtual-trial", label: "虚拟实验室",
    draft: "比较不同干预或试验设计的结果。目标和已有参数是：",
    summary: "在设定的干预或设计下做计算实验，包括样本量、期中分析、无效终止和剂量爬坡的设计搜索。",
    requirement: "试验设计比较可从文献参数和明确假设开始；干预实验需要可运行的人群、适用的模型和干预定义。",
    badge: "设计比较可先用文献",
    examples: ["比较两种试验设计的样本量与把握度", "评估随访时长和脱落率变化对试验设计的影响"],
  },
  "synthetic-control": {
    capability: "synthetic-control", label: "合成对照臂",
    draft: "研究外部对照或合成对照臂的可行性与比较方法。问题和资料是：",
    summary: "评估外部对照的可比性，研究合适的比较方法。",
    requirement: "可先讨论可行性。效果分析需要适用的治疗、结局、时间和混杂变量。",
    badge: "效果分析需结局数据",
    examples: ["评估现有数据能否为单臂研究构建外部对照", "比较匹配和加权后的人群平衡与治疗效果"],
  },
};

export const PROFESSIONAL_RESEARCH_TASKS = Object.entries(copy).map(([id, { capability, ...task }]) => {
  if (!catalogue.some(plugin => plugin.id === capability)) throw new Error(`Unknown research capability: ${capability}`);
  return { id: id as VcrWorkspaceArea, ...task };
});
