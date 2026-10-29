import { VCR_DEFAULT_TIME_UNIT, VCR_SCENARIO_SCHEMAS, vcrScenarioRows, vcrTimeUnitOf } from "@evimed/domain";

type Field = { unit?: string };
type Root = Record<string, unknown>;
export type MethodFieldText = { label: string; unit?: string; hint?: string };
const unitNames: Record<string, string> = { days: "天", weeks: "周", months: "月", years: "年" };
const rows = new Map<string, ReturnType<typeof vcrScenarioRows>["rows"]>();
const normalize = (path: string) => path.replace(/\[\d+\]/g, "[]");
function read(root: Root, path: string): unknown {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, root);
}
function canonicalUnit(method: string, path: string): string | undefined {
  if (!Object.hasOwn(VCR_SCENARIO_SCHEMAS, method)) return undefined;
  if (!rows.has(method)) rows.set(method, vcrScenarioRows(method).rows);
  return rows.get(method)?.find(row => row.path === normalize(path))?.unit;
}
function timeUnit(method: string, root: Root): string {
  if (method === "accrual.poisson_gamma") return "月";
  const declared = String(root.timeUnit ?? "").trim();
  if (declared) return unitNames[vcrTimeUnitOf(declared) ?? ""] ?? `${declared}（自定义单位，未换算）`;
  if (read(root, "endpoint.type") === "time_to_event" || method === "comparator.rmst" || method === "comparator.weighted_cox") return `${unitNames[VCR_DEFAULT_TIME_UNIT]}（方法默认）`;
  return "所设时间单位";
}
function translateUnit(unit: string | undefined, method: string, root: Root): string | undefined {
  if (!unit) return undefined;
  const time = timeUnit(method, root);
  return ({ "time units": time, "per time unit": `每${time}`, "outcome units": "结局原单位", "outcome units per time unit": `结局原单位／${time}`,
    "proportion per year": "每年比例", "probability of leaving before each follow-up visit": "每次随访前退出概率", "log hazard ratio": "对数 HR", "link scale": "链接函数尺度", "the outcome's own scale": "结局原尺度", proportion: "比例", "per month": "每月" } as Record<string, string>)[unit] ?? unit;
}
/** Presentation only: the domain remains the owner of units, ranges, defaults and validation.
 * Symbols get a scientific meaning only where the method and full field path establish it.
 */
export function methodFieldText(method: string, path: string, field: Field, root: Root, fallback: string, customLabel = false): MethodFieldText {
  const normalized = normalize(path);
  const key = normalized.split(".").at(-1)?.replace(/\[\]$/, "") ?? "";
  const result: MethodFieldText = { label: fallback, unit: translateUnit(field.unit ?? canonicalUnit(method, path), method, root) };
  if (customLabel) return result;
  let label: string | undefined;
  if (key === "alpha") label = "参数 α";
  if (key === "beta") label = "参数 β";
  if (key === "tau") label = "参数 τ";
  if (key === "sigma") label = "参数 σ";
  if (key === "gamma") label = "参数 γ";
  if (key === "lambda") label = "参数 λ";
  if (key === "target") label = "目标参数";
  if (/^(analysis|operatingCharacteristics)\.alpha$/.test(normalized)) { label = "检验显著性水平 α"; result.unit = "比例"; }
  if (normalized === "costs.sites") { label = "计费中心数"; result.unit = "个中心"; }
  if (normalized === "phAlpha") { label = "比例风险假设检验水平 α"; result.unit = "比例"; }
  if (method === "accrual.poisson_gamma") {
    if (normalized === "sites[].alpha") { label = "招募强度 Gamma 形状 α"; result.unit = "无量纲"; }
    if (normalized === "sites[].beta") { label = "招募强度 Gamma 速率 β"; result.unit = "月"; result.hint = "使用形状／速率参数化：平均每中心招募率为 α／β。β 不是尺度参数。"; }
    if (normalized === "screenFailure") label = "筛选失败率 Beta 先验";
    if (normalized === "screenFailure.alpha" || normalized === "screenFailure.beta") { label = `筛选失败率 Beta 先验形状 ${key === "alpha" ? "α" : "β"}`; result.unit = "无量纲"; }
    if (normalized === "target") { label = "累计目标入组人数"; result.unit = "人"; }
    if (normalized === "eventTarget") { label = "目标事件数"; result.unit = "个事件"; }
    if (normalized === "eventHazard") { label = "每位受试者事件危险率"; result.unit = "每月"; }
    if (normalized === "byTimes[]") { label = "招募预测评估时间点"; result.unit = "月"; }
    if (normalized === "sites[].exposureTime") { label = "中心已开放时长"; result.unit = "月"; }
    if (normalized === "sites[].startTime") { label = "中心启用时间偏移"; result.unit = "月"; }
  }
  if (/^population\.variables\[\]\./.test(normalized)) {
    const variablePath = path.slice(0, path.indexOf("]") + 1);
    const family = read(root, `${variablePath}.family`);
    if (["alpha", "beta"].includes(key) && family === "beta") { label = `Beta 分布形状参数 ${key === "alpha" ? "α" : "β"}`; result.unit = "无量纲"; }
    if (key === "rate") { label = family === "gamma" ? "Gamma 分布速率" : "指数分布速率"; result.unit = "每变量原单位"; }
    if (key === "shape") { label = "Gamma 分布形状"; result.unit = "无量纲"; }
    if (key === "mean" && family === "gamma") label = "Gamma 分布均值";
    if (key === "meanlog") label = "取对数后的均值";
    if (key === "sdlog") label = "取对数后的标准差";
  }
  if (/^population\.missing\[\]\.beta(?:\[\])?$/.test(normalized)) label = "缺失机制回归系数 β";
  if (normalized === "population.missing[].rate") { label = "缺失概率"; result.unit = "比例"; }
  if (/^baselineTable\[\]\.(mean|sd)$/.test(normalized)) label = key === "mean" ? "文献原尺度均值" : "文献原尺度标准差";
  if (normalized === "analyses[].target") label = "待评估回归系数的变量列";
  if (method === "design.assurance" && /^designPrior\.(mean|sd)$/.test(normalized)) {
    const endpoint = read(root, "endpoint.type");
    const parameter = endpoint === "time_to_event" ? "对数风险比" : endpoint === "binary" ? "风险差" : endpoint === "continuous" ? "均值差" : "效应量";
    label = `${parameter}先验${key === "mean" ? "均值" : "标准差"}`;
    result.unit = endpoint === "time_to_event" ? "对数 HR" : endpoint === "binary" ? "发生率差" : endpoint === "continuous" ? "结局原单位" : "效应量分析尺度";
  }
  if (method === "comparator.map_prior") {
    if (normalized === "tauPrior") label = "研究间异质性 τ 的先验";
    if (normalized === "tauPrior.scale") { label = read(root, "tauPrior.kind") === "uniform" ? "异质性 τ 均匀先验上限" : "异质性 τ 先验尺度"; result.unit = read(root, "historical.events") ? "logit 尺度" : "历史估计的分析尺度"; }
    if (/^(current|historical)\.(estimate|se)(?:\[\])?$/.test(normalized)) { label = `${normalized.startsWith("current") ? "当前" : "历史"}${key === "se" ? "标准误" : "效应估计"}`; result.unit = read(root, "historical.events") ? "logit 尺度" : "历史估计的分析尺度"; }
  }
  if (method === "design.procova" && normalized === "prognostic.lambda") { label = "相关性折减因子 λ"; result.unit = "无量纲"; }
  if (method === "design.procova" && normalized === "prognostic.gamma") { label = "对照组标准差膨胀因子 γ"; result.unit = "倍数"; }
  if (key === "tau" && (field.unit ?? canonicalUnit(method, path)) === "time units") label = "RMST 截断时间 τ";
  if (normalized === "truth.hazardRatio" || /^truths\[\]\.hazardRatio$/.test(normalized)) { label = "瞬时风险比 HR"; result.unit = "无量纲"; }
  if (method === "comparator.evalue" && normalized === "scale") label = "效应量类型";
  if (method === "evidence.pool" && normalized === "scale") label = "效应估计变换尺度";
  if (method === "comparator.tipping_point" && /^deltas(?:\[\])?$/.test(normalized)) { label = "删失后危险率倍数 δ"; result.unit = "倍数"; }
  if (method === "comparator.tipping_point" && normalized === "deltaApplies") label = "危险率倍数应用组";
  if (method === "evidence.pool" && normalized === "level") { label = "置信区间覆盖水平"; result.unit = "比例"; }
  if (method === "patients.longitudinal" && normalized === "truth.effect") label = "干预对结局变化速率的效应";
  if (method === "patients.longitudinal" && normalized === "truth.sd") label = "纵向结局残差标准差";
  if (normalized === "analysis.sd") label = "Z 检验所用已知总体标准差";
  if (label) result.label = `${label}${/\[(\d+)\]$/.test(path) ? ` ${Number(/\[(\d+)\]$/.exec(path)?.[1]) + 1}` : ""}`;
  return result;
}
