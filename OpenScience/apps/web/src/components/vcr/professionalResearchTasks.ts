import { catalogue } from "@evimed/research-plugin-runtime/catalogue";

/** Task entry metadata is independent of installation state. The extension
 * centre owns actual installation/activation; a draft never starts a job. */
const copy: Record<string, { label: string; draft: string; summary: string; requirement: string; examples: string[] }> = {
  "virtual-cohort": { label: "虚拟队列", draft: "建立研究队列或合成人群。目标和已有资料是：", summary: "筛选研究队列，或按研究条件构建合成人群。", requirement: "可从文献或设定开始。真实队列和数据驱动合成需要患者数据。", examples: ["按入排标准从现有病历中筛选研究队列", "根据文献中的年龄、性别和疾病分布构建合成人群"] },
  "virtual-patient": { label: "虚拟患者", draft: "查看患者历程或研究模型支持的个体轨迹。资料和问题是：", summary: "研究一位患者的病程与模型支持的个体轨迹。", requirement: "个体预测需要患者资料及适用模型；场景模拟可先用明确设定。", examples: ["检查一个预后模型是否适用于这位患者", "在明确假设下比较同一位虚拟患者的不同病程情景"] },
  "synthetic-control": { label: "合成对照臂", draft: "研究外部对照或合成对照臂的可行性与比较方法。问题和资料是：", summary: "评估外部对照的可比性，研究合适的比较方法。", requirement: "可先讨论可行性。效果分析需要适用的治疗、结局、时间和混杂变量。", examples: ["评估现有数据能否为单臂研究构建外部对照", "比较匹配和加权后的人群平衡与治疗效果"] },
  "virtual-trial": { label: "虚拟试验", draft: "比较试验设计的样本量、把握度或运行特征。目标和已有参数是：", summary: "模拟并比较试验设计的样本量、把握度与运行特征。", requirement: "可从文献参数与明确假设开始；已有数据可用于校准。", examples: ["比较两种试验设计的样本量与把握度", "评估随访时长和脱落率变化对试验设计的影响"] },
};

export const PROFESSIONAL_RESEARCH_TASKS = ["virtual-cohort", "virtual-patient", "synthetic-control", "virtual-trial"].map(id => {
  if (!catalogue.some(plugin => plugin.id === id)) throw new Error(`Unknown research capability: ${id}`);
  const badges: Record<string, string> = { "virtual-cohort": "真实队列需患者数据", "virtual-patient": "预测需适用模型", "synthetic-control": "效果分析需结局数据", "virtual-trial": "可先用文献" };
  return { id, ...copy[id], badge: badges[id] };
});
