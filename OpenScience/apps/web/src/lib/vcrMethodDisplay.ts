import { VCR_ENGINE_METHODS, VCR_SCENARIO_SCHEMAS, VCR_JOB_METHODS, VCR_LONGITUDINAL_METHODS, VCR_PATIENT_LEVEL_JOB_KINDS } from "@evimed/domain";
import type { VcrModels } from "@/lib/vcrClient";

export type VcrMethod = VcrModels["methods"][number];
export const METHOD_FAMILIES = ["查看数据与构建人群", "模拟患者结局", "从证据整理参数", "外部对照与效应", "样本量与试验设计", "稳健性分析", "招募与匹配"] as const;
export const FAMILY_PURPOSES = ["描述数据、应用队列条件或构建人群", "二分类、连续、生存与纵向结局模拟", "汇总研究参数与重建文献曲线", "加权、调整和比较研究效应", "解析计算、模拟与设计方案比较", "偏倚、缺失与预测验证", "中心招募预测与入排标准匹配"];
const PATIENT_MODES = ["patients.binary", "patients.continuous", "patients.time_to_event", "patients.longitudinal"];
const ROBUSTNESS = ["comparator.evalue", "comparator.covariate_sets", "comparator.negative_control", "comparator.tipping_point", "forecast.evaluate", "forecast.compare", "forecast.trial_benchmark"];
export function methodTask(method: string): string {
  if (/^(profile|cohort|population)\./.test(method)) return METHOD_FAMILIES[0];
  if (method.startsWith("patients.") || method === "forecast.trajectories") return METHOD_FAMILIES[1];
  if (method.startsWith("evidence.")) return METHOD_FAMILIES[2];
  if (/^(accrual|matching)\./.test(method)) return METHOD_FAMILIES[6];
  if (ROBUSTNESS.includes(method)) return METHOD_FAMILIES[5];
  if (method.startsWith("comparator.")) return METHOD_FAMILIES[3];
  if (method.startsWith("design.")) return METHOD_FAMILIES[4];
  return "其他方法";
}
export function methodKind(method: string): string | null {
  if (["matching.evaluate", "evidence.reconstruct_km"].includes(method)) return null;
  return Object.entries(VCR_JOB_METHODS).find(([, value]) => value === method)?.[0] ?? null;
}
export function methodEntryId(method: VcrMethod): string { return PATIENT_MODES.includes(method.method ?? method.id) ? "patient-outcomes" : method.id; }
export function methodEntries(methods: VcrMethod[]): VcrMethod[] {
  const seen = new Set<string>();
  return methods.filter(method => { const id = methodEntryId(method); if (seen.has(id)) return false; seen.add(id); return true; });
}
export function methodTitle(method: VcrMethod): string { return methodEntryId(method) === "patient-outcomes" ? "模拟患者结局" : method.name; }
export function patientModes(methods: VcrMethod[]): VcrMethod[] { return methods.filter(method => PATIENT_MODES.includes(method.method ?? method.id)); }
const FORECAST_TITLES: Record<string, string> = { "forecast.trajectories": "预测后续轨迹", "forecast.evaluate": "验证预测与后续结局", "forecast.compare": "比较预测版本", "forecast.trial_benchmark": "验证试验效果预测" };
/** The domain owns these four protocols; an older server catalogue can omit rows, never their identity. Availability is checked against each study's actual inputs. */
export function completeMethodCatalogue(methods: VcrMethod[]): VcrMethod[] {
  return [...methods, ...Object.entries(VCR_LONGITUDINAL_METHODS).filter(([id]) => !methods.some(row => (row.method ?? row.id) === id)).map(([id, protocol]) => ({ id, method: id, name: FORECAST_TITLES[id], version: protocol.version }))];
}
// Display wording only: parameter types, examples, validation and execution remain the domain's.
const TASKS: Record<string, [string, string, string]> = {
  "profile.snapshot": ["查看数据的分布、缺失与基本特征。", "已保存数据快照", "列分布与缺失概况"],
  "cohort.build": ["按明确条件建立研究队列，保留未知值的处理。", "数据快照、筛选条件与未知值策略", "纳入、排除与未知记录的计数"],
  "population.scenario": ["按声明的分布与相关性生成研究人群。", "人数、变量分布、相关性与约束", "合成人群与分布检查"],
  "population.literature": ["用文献基线汇总表构建参考人群。", "基线表、目标人数与分布假设", "参考人群及基线对照"],
  "population.synthpop": ["从已有真实数据经验合成新的研究记录。", "真实数据快照、变量与合成设置", "合成记录及其质量检查"],
  "population.quality": ["检查已有合成人群的保真度与披露风险。", "已保存合成人群版本与参考数据", "质量与隐私风险指标"],
  "patients.binary": ["按发生概率模拟患者的二分类结局。", "两组人数、发生率与效应假设", "二分类模拟记录及发生率对照"],
  "patients.continuous": ["按效应和离散程度模拟连续结局。", "两组人数、均值差与标准差", "连续结局记录及分布"],
  "patients.time_to_event": ["按时间分布模拟事件与删失。", "两组人数、事件分布、效应与随访", "事件记录、生存曲线与删失情况"],
  "patients.longitudinal": ["按访视与个体差异模拟重复测量结局。", "人数、访视时间、随机效应与脱落假设", "纵向记录与结局轨迹"],
  "evidence.pool": ["汇总多项研究的效应与不确定性。", "研究估计值、标准误与合并尺度", "合并效应与异质性"],
  "evidence.reconstruct_km": ["从文献生存曲线重建可追溯参考数据。", "原始曲线、风险集与来源位置", "重建曲线、伪个体记录及局限"],
  "comparator.entropy_balance": ["按目标分布平衡外部对照的协变量。", "对照数据、目标分布与结局列", "权重、有效样本量与平衡性"],
  "comparator.propensity_weight": ["按倾向评分加权比较治疗组。", "患者数据、治疗、协变量与结局列", "加权效应与组间平衡"],
  "comparator.maic": ["使个体数据匹配外部研究的汇总基线。", "个体数据与外部研究基线、效应信息", "匹配调整效应与有效样本量"],
  "comparator.rmst": ["在共同随访时限内比较限制平均生存时间。", "时间、事件、组别与限制时限", "限制平均生存时间及组间差异"],
  "comparator.map_prior": ["从历史研究构建可借用的先验分布。", "历史效应、标准误与先验设置", "先验分布、异质性与借用信息量"],
  "comparator.weighted_cox": ["按现有权重拟合时间结局的组间效应。", "患者时间、事件、治疗与权重列", "加权风险比及不确定性"],
  "comparator.maic_time_to_event": ["将外部生存证据用于匹配调整比较。", "个体生存数据、外部基线与生存效应", "调整生存效应与平衡性"],
  "comparator.aipw": ["结合治疗和结局模型估计双重稳健效应。", "患者数据、治疗、结局与协变量", "调整效应及诊断"],
  "comparator.prognostic_adjustment": ["用预后信息调整现有研究的组间比较。", "患者结局、治疗与预后变量或评分", "预后调整效应与诊断"],
  "comparator.evalue": ["估计未测量混杂需多强才可解释观察关联。", "风险比或效应比值及可用置信限", "效应点与置信限的 E-value"],
  "comparator.covariate_sets": ["比较不同协变量集合下的效应稳健性。", "患者数据、结局与多套协变量", "各调整集的效应与变化"],
  "comparator.negative_control": ["用负对照检查分析中残留的系统偏倚。", "主要分析与已声明负对照", "负对照效应与偏倚检查"],
  "comparator.tipping_point": ["改变缺失或漂移假设，寻找结论改变的边界。", "原分析、缺失机制与敏感性范围", "临界点与敏感性结果"],
  "design.analytic": ["按解析方法计算所需样本或事件数。", "终点、效应、显著性水平与把握度", "样本量或所需事件数"],
  "design.simulate": ["在给定效应下模拟试验的运行特性。", "试验设计、终点、效应与分析规则", "把握度、错误率与模拟误差"],
  "design.grid": ["比较多种设计与真实效应情景。", "多套设计、效应情景与性能目标", "设计网格与方案权衡"],
  "design.assurance": ["将效应先验的不确定性纳入试验成功把握。", "试验设计、效应先验与成功标准", "先验预测成功把握"],
  "design.procova": ["评估预后协变量调整对试验设计的影响。", "设计、终点与预后信息假设", "调整后的设计性能与样本需求"],
  "accrual.poisson_gamma": ["按中心既往招募预测入组与目标事件时间。", "中心招募、目标人数、随访与事件假设", "完成时间及其预测区间"],
  "matching.evaluate": ["逐条核对患者记录是否满足入排标准。", "患者记录、入排标准与可核对证据", "符合、不符合与信息不足的记录"],
  "forecast.trajectories": ["用可调用模型预测既有人群的后续轨迹。", "历史记录、预测终点与可用模型", "预测轨迹与可用区间"],
  "forecast.evaluate": ["将先前预测与后来观察到的结局比较。", "预测版本与后续结局历史", "预测性能与结局覆盖范围"],
  "forecast.compare": ["按比较目的核对两个保留的预测版本。", "两个预测版本与比较目的", "成对差异及其不确定性"],
  "forecast.trial_benchmark": ["对照试验结果核对已登记的效果预测。", "试验预测基准与保留的试验证据", "预测误差与可比较性"],
};
export function methodPurpose(method: VcrMethod): { purpose: string; inputs: string; outputs: string; action: string } {
  const id = method.method ?? method.id;
  const [purpose, inputs, outputs] = TASKS[id] ?? ["配置此方法并保留计算结果。", "此方法声明的参数", "此方法的计算结果"];
  return { purpose, inputs, outputs, action: id === "matching.evaluate" ? "选择研究进行匹配" : id === "evidence.reconstruct_km" ? "进入研究证据流程" : "配置并计算" };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** The domain supports both aggregate and column modes; this only describes their data prerequisite. */
export function methodNeedsSnapshot(method: string, scenario: Record<string, unknown> = {}): boolean {
  if (method === "comparator.negative_control") return Boolean(object(scenario.primary).column) || (Array.isArray(scenario.controls) && scenario.controls.some(value => Boolean(object(value).column)));
  if (method === "comparator.tipping_point") return object(scenario.endpoint).type === "time_to_event" || Boolean(scenario.outcomeColumn);
  const kind = methodKind(method);
  return kind !== null && (VCR_PATIENT_LEVEL_JOB_KINDS as readonly string[]).includes(kind);
}
export function stripMethodScopeRefs(value: unknown): unknown {
  return Array.isArray(value) ? value.map(stripMethodScopeRefs) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !/InputId$|^(historyId|outcomeHistoryId|providerId|predictionId|otherPredictionId|benchmarkId)$/.test(key)).map(([key, child]) => [key, stripMethodScopeRefs(child)])) : value;
}
export function methodHasOwnedReferences(method: string, scenario: Record<string, unknown>): boolean {
  return methodNeedsSnapshot(method, scenario) || method.startsWith("forecast.") || JSON.stringify(stripMethodScopeRefs(scenario)) !== JSON.stringify(scenario);
}

/** Browser scenarios never contain the platform's bound pseudo-patient input address. */
export function unboundMethodScenario(method: string, scenario: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(scenario);
  if (method === "comparator.maic_time_to_event") delete copy.pseudoIpdInputId;
  return copy;
}

/** A new form may fill only a method's single declared endpoint; numeric assumptions stay empty. */
export function initialMethodScenario(method: string, scenario: Record<string, unknown> = {}): Record<string, unknown> {
  const copy = unboundMethodScenario(method, scenario);
  const fixed = fixedMethodEndpoint(method);
  const endpoint = object(copy.endpoint);
  if (fixed && endpoint.type === undefined) copy.endpoint = { ...endpoint, type: fixed };
  return copy;
}
export function fixedMethodEndpoint(method: string): string | null {
  const endpoints = (VCR_ENGINE_METHODS as Record<string, { endpoints: readonly string[] }>)[method]?.endpoints;
  const declaresEndpoint = object((VCR_SCENARIO_SCHEMAS as Record<string, unknown>)[method]).fields;
  return object(declaresEndpoint).endpoint && endpoints?.length === 1 ? endpoints[0] : null;
}
export function knownJobProgress(raw: unknown): { done: number; total: number } | null {
  const value = object(raw), done = value.done, total = value.total;
  return typeof done === "number" && Number.isInteger(done) && done >= 0 && typeof total === "number" && Number.isInteger(total) && total > 0 && done <= total ? { done, total } : null;
}
