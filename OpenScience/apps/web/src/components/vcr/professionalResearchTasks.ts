import { catalogue } from "@evimed/research-plugin-runtime/catalogue";

/** Task entry metadata is independent of installation state. The extension
 * centre owns actual installation/activation; a draft never starts a job. */
const copy: Record<string, { label: string; draft: string; requirement: string }> = {
  "virtual-cohort": { label: "虚拟队列", draft: "建立研究队列或合成人群。目标和已有资料是：", requirement: "可从文献或设定开始。真实队列和数据驱动合成需要患者数据。" },
  "virtual-patient": { label: "虚拟患者", draft: "查看患者历程或研究模型支持的个体轨迹。资料和问题是：", requirement: "个体预测需要患者资料及适用模型；场景模拟可先用明确设定。" },
  "synthetic-control": { label: "合成对照臂", draft: "研究外部对照或合成对照的可行性与比较方法。问题和资料是：", requirement: "可先讨论可行性。效果分析需要适用的治疗、结局、时间和混杂变量。" },
  "virtual-trial": { label: "虚拟试验", draft: "比较试验设计的样本量、把握度或运行特征。目标和已有参数是：", requirement: "可从文献参数与明确假设开始；已有数据可用于校准。" },
};

export const PROFESSIONAL_RESEARCH_TASKS = ["virtual-cohort", "virtual-patient", "synthetic-control", "virtual-trial"].map(id => {
  if (!catalogue.some(plugin => plugin.id === id)) throw new Error(`Unknown research capability: ${id}`);
  const badges: Record<string, string> = { "virtual-cohort": "真实队列需患者数据", "virtual-patient": "预测需适用模型", "synthetic-control": "效果分析需结局数据", "virtual-trial": "可先用文献" };
  return { id, ...copy[id], badge: badges[id] };
});
