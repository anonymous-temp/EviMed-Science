import {
  VCR_SCENARIO_SCHEMAS, VCR_TRIAL_DESIGN_LABELS_ZH, VCR_ENDPOINT_TYPE_LABELS_ZH, VCR_ESTIMAND_LABELS_ZH,
  VCR_POOLING_METHOD_LABELS_ZH, VCR_SPENDING_FUNCTION_LABELS_ZH, VCR_PERFORMANCE_MEASURE_LABELS_ZH,
  VCR_CRITERION_TYPE_LABELS_ZH, VCR_CRITERION_STATE_LABELS_ZH, VCR_MISSING_REASON_LABELS_ZH,
  VCR_VALUE_SOURCE_LABELS_ZH, VCR_INTERVAL_KIND_LABELS_ZH,
} from "@evimed/domain";
import type { Schema } from "./VcrScenarioEditor";

// Closed protocol labels only. User categories, column names, source names and saved codes are never rewritten.
const labels: Record<string, string> = {
  ...VCR_TRIAL_DESIGN_LABELS_ZH, ...VCR_ENDPOINT_TYPE_LABELS_ZH, ...VCR_ESTIMAND_LABELS_ZH,
  ...VCR_POOLING_METHOD_LABELS_ZH, ...VCR_SPENDING_FUNCTION_LABELS_ZH, ...VCR_PERFORMANCE_MEASURE_LABELS_ZH,
  ...VCR_CRITERION_TYPE_LABELS_ZH, ...VCR_CRITERION_STATE_LABELS_ZH, ...VCR_MISSING_REASON_LABELS_ZH,
  ...VCR_VALUE_SOURCE_LABELS_ZH, ...VCR_INTERVAL_KIND_LABELS_ZH,
  MAR: "随机缺失（MAR）", MCAR: "完全随机缺失（MCAR）", against_treatment: "不利于干预", in_favour: "有利于干预",
  aipw: "增广逆概率加权（AIPW）", ancova: "协方差分析（ANCOVA）", approximate: "近似对应", exact: "完全对应", cannot: "无法对应",
  bernoulli: "伯努利分布", beta: "Beta 分布", binomial: "二项分布", gamma: "Gamma 分布", categorical: "分类分布",
  gaussian: "高斯分布", normal: "正态分布", lognormal: "对数正态分布", uniform: "均匀分布", exponential: "指数分布", weibull: "Weibull 分布", piecewise: "分段指数分布",
  half_normal: "半正态分布", half_cauchy: "半 Cauchy 分布", latent: "潜变量相关", spearman: "Spearman 秩相关",
  cited: "文献依据", complete_cases: "仅完整记录", non_responders: "缺失者按未应答处理", days: "天", weeks: "周", months: "月", years: "年",
  digitizer: "图像数字化", human_click: "人工取点", entropy_balance: "熵平衡", propensity: "倾向评分加权",
  efron: "Efron 并列值近似", breslow: "Breslow 并列值近似", exact_binomial: "精确二项检验", fisher_exact: "Fisher 精确检验",
  include: "纳入", exclude: "排除", inclusion: "纳入条件", exclusion: "排除条件", true: "是", false: "否",
  glm: "广义线性模型（GLM）", mean: "均值", greater: "大于", less: "小于", "two.sided": "双侧",
  identity: "原始尺度", log: "对数尺度", logit: "Logit 尺度", km: "Kaplan–Meier 变换", rank: "秩变换",
  hazard_ratio: "瞬时风险比（HR）", odds_ratio: "优势比（OR）", risk_ratio: "风险比值（RR）", risk_difference: "风险差",
  log_hazard_ratio: "对数瞬时风险比（log HR）", log_odds_ratio: "对数优势比（log OR）", log_risk_ratio: "对数风险比值（log RR）",
  logistic: "Logistic 回归", logrank: "Log-rank 检验", rmst: "限制平均生存时间（RMST）", ttest: "两样本 t 检验",
  one_sample_t: "单样本 t 检验", one_sample_z: "单样本 Z 检验", one_sample_logrank: "单样本 Log-rank 检验",
  simon_boundary: "Simon 两阶段界值", stratified_beta_binomial: "分层 Beta-二项模型", stratified_risk_difference: "分层风险差",
  both_opposite: "两组施加相反方向的倍数", two_arm: "两组比较",
};
const ruleLabels: Record<string, string> = {
  all: "满足全部条件", any: "至少满足一项", not: "不满足", compare: "比较", between: "处于范围内", in: "属于指定值", not_in: "不属于指定值", missing: "值缺失", present: "值存在",
  lt: "小于（<）", lte: "小于或等于（≤）", gt: "大于（>）", gte: "大于或等于（≥）", eq: "等于（=）", ne: "不等于（≠）",
};
const normalize = (path: string) => path.replace(/\[\d+\]/g, "[]");
const allowed = new Map<string, Set<string>>();
function collect(method: string, node: Schema, path = "") {
  const add = (at: string, values: string[]) => {
    const key = `${method}:${at}`;
    const held = allowed.get(key) ?? new Set<string>();
    for (const value of values) held.add(value);
    allowed.set(key, held);
  };
  if (node.t === "variant") add(path ? `${path}.${node.on ?? "type"}` : node.on ?? "type", Object.keys(node.variants ?? {}));
  if (Array.isArray(node.values)) add(path, node.values);
  if (node.valuesBy) add(path, [...new Set(Object.values(node.valuesBy.map).flat())]);
  if (node.t === "boolean") add(path, ["true", "false"]);
  for (const [key, child] of Object.entries(node.fields ?? {})) collect(method, child, path ? `${path}.${key}` : key);
  for (const fields of Object.values(node.variants ?? {})) for (const [key, child] of Object.entries(fields)) collect(method, child, path ? `${path}.${key}` : key);
  if (node.items) collect(method, node.items, `${path}[]`);
  if (node.values && !Array.isArray(node.values)) collect(method, node.values, `${path}.{key}`);
}
for (const [method, schema] of Object.entries(VCR_SCENARIO_SCHEMAS)) collect(method, schema as unknown as Schema);

export function methodChoiceLabel(method: string, path: string, value: string): string {
  const at = normalize(path);
  if (!allowed.get(`${method}:${at}`)?.has(value)) return value;
  if (at === "accrual.kind") return value === "uniform" ? "匀速入组" : value === "piecewise" ? "分段入组" : labels[value] ?? value;
  if (value === "identity") return at === "phTransform" ? "原始时间" : at === "link" ? "恒等链接" : "原始尺度";
  if (at === "link" && value === "log") return "对数链接";
  if (at === "link" && value === "logit") return "Logit 链接";
  if (method === "comparator.tipping_point" && at === "deltaApplies" && value === "treatment") return "仅干预组";
  return labels[value] ?? value;
}
export const ruleChoiceLabel = (value: string): string => ruleLabels[value] ?? value;

// Match the authored label, so reordering examples cannot attach a title to a different scenario.
const exampleLabels: Record<string, Record<string, string>> = {
  "profile.snapshot": {
    "nothing to state: the snapshot is the input": "使用已有数据快照"
  },
  "cohort.build": {
    "two inclusion steps on a subject table": "按两项纳入条件建立队列"
  },
  "population.scenario": {
    "three variables from stated distributions": "按三种声明分布生成人群"
  },
  "population.literature": {
    "a published baseline table": "按文献基线表构建参考人群"
  },
  "population.synthpop": {
    "a synthetic copy of the study table": "从研究数据合成记录"
  },
  "population.quality": {
    "a synthetic table against its training table": "对照训练数据检查合成人群"
  },
  "patients.continuous": {
    "a continuous endpoint": "连续结局模拟"
  },
  "patients.binary": {
    "a binary endpoint": "二分类结局模拟"
  },
  "patients.time_to_event": {
    "a time-to-event endpoint with uniform accrual": "生存结局与均匀入组"
  },
  "patients.longitudinal": {
    "a continuous trajectory over five visits, random intercept and slope, 10% leaving per visit": "五次访视与每次 10% 脱落"
  },
  "evidence.pool": {
    "three published log hazard ratios": "合并研究的对数 HR"
  },
  "evidence.reconstruct_km": {
    "one digitized arm and its risk table": "曲线取点与风险集表"
  },
  "comparator.entropy_balance": {
    "entropy balancing on three covariates": "平衡三个协变量"
  },
  "comparator.propensity_weight": {
    "propensity weights for a binary endpoint": "二分类结局的倾向评分加权"
  },
  "comparator.rmst": {
    "restricted mean survival time to 24 months": "比较 24 个月的 RMST"
  },
  "comparator.maic": {
    "an unanchored indirect comparison on a binary outcome: the aggregate trial's response rate is 0.42 (standard error 0.05), on the logit link": "非锚定二分类比较：应答率 0.42、标准误 0.05"
  },
  "comparator.evalue": {
    "the E-value of a hazard ratio": "风险比的 E-value"
  },
  "comparator.map_prior": {
    "a robust MAP prior from three historical control arms": "三个历史对照组的稳健 MAP 先验"
  },
  "design.analytic": {
    "two-arm time-to-event: accrual is an object of duration, followup and dropoutAnnual": "两组生存结局：入组、随访与脱落",
    "two-arm binary: no accrual": "两组二分类结局"
  },
  "design.simulate": {
    "two-arm time-to-event with uniform accrual": "两组生存结局与均匀入组",
    "two-arm binary: no accrual": "两组二分类结局",
    "single arm, continuous: 40 patients against a historical mean of 50, one-sample t": "单臂连续：40 人与历史均值 50",
    "single arm, time to event: 60 patients against a benchmark median of 12, one-sample log-rank": "单臂生存：60 人与中位时间 12"
  },
  "design.grid": {
    "two sample sizes against three true effects, binary": "两种样本量与三种二分类效应情景"
  },
  "design.assurance": {
    "assurance for a time-to-event design with a prior on the log hazard ratio": "生存设计与对数 HR 先验",
    "assurance of a group-sequential design: three looks, O'Brien-Fleming spending, 300 events at the end": "三次序贯分析：O'Brien-Fleming"
  },
  "design.procova": {
    "PROCOVA on a continuous endpoint": "连续结局的 PROCOVA 设计"
  },
  "accrual.poisson_gamma": {
    "two sites, a target and a horizon": "两个中心的目标入组预测"
  },
  "matching.evaluate": {
    "two criteria and their states": "两项入排条件及其判断状态"
  },
  "comparator.weighted_cox": {
    "a weighted Cox comparison to 24 months": "24 个月的加权 Cox 比较"
  },
  "comparator.maic_time_to_event": {
    "unanchored, against a reconstruction": "利用曲线重建结果进行非锚定比较"
  },
  "comparator.aipw": {
    "doubly robust, binary outcome": "二分类结局的双重稳健估计"
  },
  "comparator.covariate_sets": {
    "two covariate sets under entropy balancing": "两套协变量的熵平衡比较"
  },
  "comparator.negative_control": {
    "two negative-control outcomes that are columns": "用两项负对照结局检查偏倚"
  },
  "comparator.tipping_point": {
    "binary, two arms, from counts": "两组二分类计数的临界点分析",
    "time to event, delta-adjusted": "生存结局的 δ 调整"
  },
  "comparator.prognostic_adjustment": {
    "binary endpoint with a prognostic score column": "带预后评分的二分类结局调整"
  }
};
export const methodExampleLabel = (method: string, original: string): string => exampleLabels[method]?.[original] ?? original;
