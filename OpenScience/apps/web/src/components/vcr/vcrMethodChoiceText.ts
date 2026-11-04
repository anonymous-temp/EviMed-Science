import {
  VCR_SCENARIO_SCHEMAS, VCR_TRIAL_DESIGN_LABELS_ZH, VCR_ENDPOINT_TYPE_LABELS_ZH, VCR_ESTIMAND_LABELS_ZH,
  VCR_POOLING_METHOD_LABELS_ZH, VCR_SPENDING_FUNCTION_LABELS_ZH, VCR_PERFORMANCE_MEASURE_LABELS_ZH,
  VCR_CRITERION_TYPE_LABELS_ZH, VCR_CRITERION_STATE_LABELS_ZH, VCR_MISSING_REASON_LABELS_ZH,
  VCR_VALUE_SOURCE_LABELS_ZH, VCR_INTERVAL_KIND_LABELS_ZH, VCR_TURNER_COMPARISON_LABELS_ZH, VCR_TURNER_OUTCOME_LABELS_ZH,
} from "@evimed/domain";
import type { Schema } from "./vcrScenarioFieldLabels";

// Closed protocol labels only. User categories, column names, source names and saved codes are never rewritten.
const labels: Record<string, string> = {
  ...VCR_TRIAL_DESIGN_LABELS_ZH, ...VCR_ENDPOINT_TYPE_LABELS_ZH, ...VCR_ESTIMAND_LABELS_ZH,
  ...VCR_POOLING_METHOD_LABELS_ZH, ...VCR_SPENDING_FUNCTION_LABELS_ZH, ...VCR_PERFORMANCE_MEASURE_LABELS_ZH,
  ...VCR_CRITERION_TYPE_LABELS_ZH, ...VCR_CRITERION_STATE_LABELS_ZH, ...VCR_MISSING_REASON_LABELS_ZH,
  ...VCR_VALUE_SOURCE_LABELS_ZH, ...VCR_INTERVAL_KIND_LABELS_ZH, ...VCR_TURNER_COMPARISON_LABELS_ZH, ...VCR_TURNER_OUTCOME_LABELS_ZH,
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
  logistic: "Logistic 回归", logrank: "Log-rank 检验", maxcombo: "MaxCombo 检验（四个加权 Log-rank 取最大）", modestly_weighted: "改良加权 Log-rank 检验（延迟起效时的折中选择）", rmst: "限制平均生存时间（RMST）", ttest: "两样本 t 检验",
  one_sample_t: "单样本 t 检验", one_sample_z: "单样本 Z 检验", one_sample_logrank: "单样本 Log-rank 检验",
  simon_boundary: "Simon 两阶段界值", stratified_beta_binomial: "分层 Beta-二项模型", stratified_risk_difference: "分层风险差",
  both_opposite: "两组施加相反方向的倍数", two_arm: "两组比较", subject: "每人一行",
  // propensity trimming, the time-to-event doubly robust summary, the bias analysis (algorithm round C14, C8, C1, C2)
  fixed: "固定界值", crump: "Crump 最优规则", survival: "某一时点的生存率", difference: "差值", constant: "固定值", triangular: "三角分布",
  // the hypothesis of a design (T1) and the confirmatory designs (T2-T6)
  superiority: "优效性", non_inferiority: "非劣效", futility_group_sequential: "中期无效性停止的成组序贯", sample_size_reestimation: "样本量再估计",
  multi_arm_selection: "多臂中期选择", enrichment: "人群富集", count_endpoint: "计数终点", hwang_shih_decani: "Hwang-Shih-DeCani 消耗函数", kim_demets: "Kim-DeMets 消耗函数",
  simes: "Simes 检验", bonferroni: "Bonferroni 检验", dunnett: "Dunnett 检验",
  // target-trial emulation (algorithm round C3, C4): the two strategies and the estimands of a sequence of trials
  sequential: "一串模拟试验（每个符合条件的期开一个）", clone_censor_weight: "克隆—删失—加权（有宽限期的策略）", itt: "意向治疗", per_protocol: "按方案", both: "意向治疗和按方案都给",
  // the heterogeneity prior of a pooling, the network, the dose-response and the shrinkage (algorithm round E7, C5, C6, E8)
  log_normal: "对数正态分布（τ² 的先验）", inverse_gamma: "逆 Gamma 分布（τ 的先验）", log_t: "对数 t 分布（τ² 的先验）", turner_2015: "Turner 等（2015）按结局和比较类型给出的先验", turner_2015_generic: "Turner 等（2015）的总体先验",
  bartos_2023: "Bartoš 等（2023）的先验", mean_difference: "均值差", log_ratio: "对数比值（如对数风险比）", lower_better: "数值越小越好", higher_better: "数值越大越好",
  random: "随机效应", common: "共同效应", relative_risk: "相对危险度（RR）", cc: "病例对照研究", ci: "累积发病率", ir: "发病率（按人时）", linear: "线性", spline: "限制性立方样条",
  gl: "Greenland–Longnecker 法（用病例数还原相关性）", h: "Hamling 法", indep: "各水平按相互独立处理",
  // dose-finding designs and Bayesian designs without MCMC (algorithm round T7, T15, T8, T10): the names are the cards' own words
  three_plus_three: "3+3", boin: "BOIN", keyboard: "Keyboard", crm: "CRM", randomized_selection: "随机分组的剂量选择",
  bop2: "贝叶斯最优 II 期设计（BOP2）", predictive_monitoring: "预测概率监测", threshold_calibration: "成功阈值的校准",
  max_power: "功效最大", min_expected_n: "期望样本量最少",
  // survival analyses declared on a synthetic population (population.synthpop / population.quality 1.1.0) and the progression simulator (algorithm round P1, P4)
  cox: "Cox 回归（对数风险比）", change: "基线到所选随访的变化", slope: "每个人的进展斜率", emax: "Emax（逐渐饱和）", literature: "文献", data: "你自己的数据",
};
/** The selection rule of a multi-arm design: its words are short and ordinary, so they are read only at that path. */
const selectionRules: Record<string, string> = { best: "只留中期估计最好的臂", rbest: "留最好的几个臂", epsilon: "留与最好的相差不大的臂", all: "全部保留" };
const ruleLabels: Record<string, string> = {
  all: "满足全部条件", any: "至少满足一项", not: "不满足", compare: "比较", between: "处于范围内", in: "属于指定值", not_in: "不属于指定值", missing: "值缺失", present: "值存在",
  lt: "小于（<）", lte: "小于或等于（≤）", gt: "大于（>）", gte: "大于或等于（≥）", eq: "等于（=）", ne: "不等于（≠）",
};
/** Words read only at their own path, because the same short word means something else elsewhere: the shape of a mean curve, and which value a dropout looks at. */
const pathLabels: Record<string, Record<string, string>> = {
  "comparator.borrowing:prior.kind": { power: "固定折扣（幂先验）", sam: "自适应混合先验（SAM）", elastic: "弹性先验" },
  "comparator.borrowing:prior.function": { logistic: "逻辑斯蒂函数", step: "阶梯函数" },
  "patients.progression:model.family": { linear: "线性", exponential: "指数", logistic: "逻辑斯蒂（S 形）", emax: "Emax（逐渐饱和）" },
  "patients.longitudinal:trajectory.kind": { plateau: "逐渐趋平", quadratic: "二次曲线" },
  "patients.longitudinal:dropoutModel.mechanism": { mar: "随机缺失（看上一次的值）", mnar: "非随机缺失（看这次的值）" },
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
  const own = pathLabels[`${method}:${at}`]?.[value];
  if (own) return own;
  if (at === "accrual.kind") return value === "uniform" ? "匀速入组" : value === "piecewise" ? "分段入组" : labels[value] ?? value;
  if (value === "identity") return at === "phTransform" ? "原始时间" : at === "link" ? "恒等链接" : "原始尺度";
  if (at === "link" && value === "log") return "对数链接";
  if (at === "link" && value === "logit") return "Logit 链接";
  if (method === "comparator.tipping_point" && at === "deltaApplies" && value === "treatment") return "仅干预组";
  if (method === "design.confirmatory" && at === "design.selection.rule") return selectionRules[value] ?? value;
  if (method === "evidence.dose_response" && at === "method") return ({ reml: "限制性最大似然（REML）", ml: "最大似然（ML）", fixed: "固定效应" } as Record<string, string>)[value] ?? value;
  if (method === "evidence.dose_response" && at === "stage") return value === "one" ? "一步法（所有研究放进一个模型）" : "两步法（先各研究分别拟合，再合并）";
  if (method === "evidence.dose_response" && at === "ratioKind" && value === "odds_ratio") return "比值比（OR）";
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
    "a synthetic copy of the study table": "从研究数据合成记录",
    "a synthetic copy that is asked how often its hazard ratio is a false positive, and which records are easiest to recognise": "合成副本：风险比的假阳性率，以及哪些记录最容易被认出来"
  },
  "population.quality": {
    "a synthetic table against its training table": "对照训练数据检查合成人群",
    "a synthetic table with a survival analysis combined over its copies, and the per-record privacy": "合成表：生存分析按各份合并，并逐条看隐私风险"
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
    "a continuous trajectory over five visits, random intercept and slope, 10% leaving per visit": "五次访视与每次 10% 脱落",
    "the same, with dropout that depends on the previous value (people doing worse leave sooner), a rescue medication that 6% start before each visit and a trajectory that levels off": "同样的五次访视，再加上与上一次的值有关的脱落（越差越早退出）、每次访视前 6% 的人开始救援用药、病程逐渐趋平"
  },
  "evidence.pool": {
    "two published log hazard ratios": "合并研究的对数 HR",
    "the same two studies with the Cochrane reference for how much trials of one comparison differ (all-cause mortality, drug against placebo): a prediction interval from two studies": "只有两项研究，用 Cochrane 里同类比较的差异作参照（全因死亡，药物对安慰剂），得到预测区间"
  },
  "evidence.network": {
    "three treatments compared by odds ratio from arm counts, one three-arm study; a higher response is better": "三种治疗按各组事件数比较比值比，含一项三臂研究；应答越高越好",
    "hazard ratios published as comparisons: a three-arm trial states every pair of its arms": "按已发表的两两比较合并风险比；三臂试验写出每一对"
  },
  "evidence.dose_response": {
    "a log-linear dose-response of two cohorts reporting incidence rates (the reference level states an effect of 0 and no standard error)": "两个队列的发病率，对数线性的剂量反应（参照水平的效应写 0、不写标准误）",
    "a restricted cubic spline with knots at the 10th, 50th and 90th percentiles of the doses, and the ratios at chosen doses against a dose of 0": "限制性立方样条，节点取剂量的第 10、50、90 百分位，给出各剂量相对 0 的比值"
  },
  "evidence.shrinkage": {
    "a phase 2 hazard ratio of 0.66 (the standard error of its log is 0.19), and a phase 3 that will measure the effect with a standard error of 0.12": "二期风险比 0.66（对数的标准误 0.19），三期的标准误预计 0.12"
  },
  "evidence.reconstruct_km": {
    "one digitized arm and its risk table": "曲线取点与风险集表"
  },
  "comparator.entropy_balance": {
    "entropy balancing on three covariates": "平衡三个协变量"
  },
  "comparator.propensity_weight": {
    "propensity weights for a binary endpoint": "二分类结局的倾向评分加权",
    "the same weights after removing the people with no comparable counterpart (Crump's rule: no bound to choose)": "去掉没有可比对象的人之后再加权（Crump 规则，不必选界值）",
    "the same weights when some covariates are missing: impute them 20 times and read the answer by Rubin's rules, the complete-case answer beside it": "有协变量缺失时：补齐 20 次，按 Rubin 规则合并，旁边是只用完整病例的结果"
  },
  "comparator.target_trial": {
    "a sequence of emulated trials from a person-period table: the intention-to-treat and per-protocol risk difference after 24 months, with stabilised weights for the treatment received": "由人-期表模拟一串试验：24 个月后意向治疗和按方案的风险差，按实际接受的治疗做稳定化加权",
    "clone-censor-weight for starting treatment within three periods of diagnosis against never starting, after twelve periods": "克隆—删失—加权：确诊后三期内开始治疗，对比始终不开始，十二期后的风险差"
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
    "two-arm binary: no accrual": "两组二分类结局",
    "non-inferiority: the treatment is expected to be as good as the control (hazard ratio 1) and must not be worse than a hazard ratio of 1.3": "非劣效：预期与对照相当（风险比 1），不能比对照差过 1.3"
  },
  "design.confirmatory": {
    "stop for futility: three looks, efficacy and futility boundaries for a mean difference of 0.4 standard deviations": "中期无效性停止：三次分析，均值差 0.4 个标准差",
    "re-estimate the sample size at an interim look when the effect is uncertain: planned for a hazard ratio of 0.7, reported at 0.8 and 0.7 (the null is added)": "效应没把握，中期再估计样本量：计划风险比 0.7，报告 0.8 和 0.7（另加无效应）",
    "the same re-estimation with a promising zone: enlarge only when the conditional power at the interim is between 36% and 80% (the null is added)": "带“有希望区间”的再估计：中期条件功效在 36% 到 80% 之间才加样（另加无效应）",
    "three doses against one control, the best dose kept at the interim (80 patients per arm planned)": "三个剂量对一个对照，中期只留最好的（每臂计划 80 人）",
    "three doses against one control for an event-time endpoint: hazard ratios 0.9, 0.75 and 0.6, the best dose kept at the interim (240 events planned in all, no accrual or control median needed)": "事件时间终点的三个剂量对一个对照：风险比 0.9、0.75、0.6，中期只留最好的（共计划 240 个事件）",
    "a biomarker-positive subset of 40% for an event-time endpoint: hazard ratio 0.6 in the subset and 0.9 outside it (240 events planned)": "事件时间终点，标志物阳性占 40%：亚组风险比 0.6，其余 0.9（计划 240 个事件）",
    "a biomarker-positive subset of 40%: enrol everyone, keep the subset or everyone at the interim (200 patients planned)": "标志物阳性占 40%：全部入组，中期留亚组或留全人群（计划 200 人）",
    "a count endpoint (attacks per patient-year): rate ratio 0.67 on a control rate of 0.6, overdispersion 0.5": "计数终点（每患者年发作次数）：对照率 0.6，率比 0.67，过度离散 0.5"
  },
  "design.dose": {
    "BOIN against 3+3 on a six-dose toxicity curve, target 0.30, 30 patients in cohorts of 3 (the same curve and the same random numbers for both)": "BOIN 与 3+3 在六个剂量的毒性曲线上对比：目标毒性率 30%，30 人、每组 3 人（两者用同一条曲线和同一批随机数）",
    "four designs side by side on one curve: CRM with a stated skeleton, BOIN, the keyboard design and 3+3": "四种设计在同一条曲线上并排比较：给定先验骨架的 CRM、BOIN、Keyboard 和 3+3",
    "how many patients per dose to choose the lower of two doses with probability 0.9 when it is not worse (the higher dose must look 10 points better to be chosen)": "每个剂量需要多少患者，才有 90% 的把握在较低剂量不差时选中它（较高剂量要好出 10 个百分点才会被选）"
  },
  "design.bayesian": {
    "Bayesian optimal phase II: a look every 10 patients up to 40, response rate 0.1 against 0.3, searched for the largest power at one-sided 0.05; Simon's design is the baseline": "贝叶斯最优 II 期设计：每 10 人分析一次、最多 40 人，有效率 10% 对 30%，在单侧 5% 下搜索功效最大的设计，以 Simon 设计为基准",
    "the same trial searched for the fewest expected patients under the null among the designs that keep alpha and reach 80% power": "同一个试验，改为在保住 I 类错误且功效达到 80% 的设计里，找无效应时期望样本量最少的",
    "predictive-probability monitoring: stop when the chance of a successful final analysis is below 5%": "预测概率监测：预测最终分析成功的概率低于 5% 时停止",
    "the type I error and power of a posterior-probability success rule (0.975) for a mean difference under a normal prior, and the threshold that gives 0.025": "均值差在正态先验下，后验概率成功规则（阈值 0.975）的 I 类错误和功效，以及把 I 类错误校到 0.025 的阈值",
    "the same for a hazard ratio from 200 events (the log hazard ratio under a normal prior)": "同样的问题，用于 200 个事件的风险比（对数风险比取正态先验）",
    "the same for two beta-binomial arms of 60 and a non-inferiority margin of 10 points on the risk difference": "同样的问题，用于两组各 60 人的 Beta-二项模型，风险差的非劣效界值为 10 个百分点"
  },
  "design.win_ratio": {
    "death, then hospitalisations, then a score (KCCQ-like, 5 points matter, SD 20): 300 patients per arm followed for 24 months, the power of the win-ratio test": "先比死亡，再比住院次数，最后比评分（类似 KCCQ，相差不到 5 分算平局，标准差 20）：每组 300 人随访 24 个月，求胜率比检验的功效",
    "the same hierarchy: how many patients per arm for 90% power": "同样的三层比较：功效要达到 90%，每组需要多少人",
    "death, then a score only, with no treatment effect on death or the score (the type I error)": "先比死亡，再只比评分，治疗对死亡和评分都没有效应（看 I 类错误）"
  },
  "design.simulate": {
    "two-arm time-to-event with uniform accrual": "两组生存结局与均匀入组",
    "two-arm binary: no accrual": "两组二分类结局",
    "a delayed treatment effect (hazard ratio 1 for 6 months, 0.6 after) analysed by MaxCombo: simulation only": "延迟起效（前 6 个月 HR 为 1，之后 0.6）用 MaxCombo 分析，仅仿真",
    "a delayed treatment effect analysed by MaxCombo at three looks (O'Brien-Fleming spending): the boundaries are found by simulation under no effect": "延迟起效、分三次中期分析，用 MaxCombo 检验（边界用无效应情形的模拟得到）",
    "a delayed treatment effect (hazard ratio 1 for 6 months, 0.6 after) analysed by the modestly weighted test, the log-rank power reported beside it": "延迟起效（前 6 个月 HR 为 1，之后 0.6）用改良加权 Log-rank 检验分析，并列出普通 Log-rank 的功效",
    "single arm, continuous: 40 patients against a historical mean of 50, one-sample t": "单臂连续：40 人与历史均值 50",
    "single arm, time to event: 60 patients against a benchmark median of 12, one-sample log-rank": "单臂生存：60 人与中位时间 12"
  },
  "model.prognostic_train": {
    "a survival prognostic model trained on the historical control arm of a table, five folds": "用历史对照组训练生存预后模型（五折）",
    "a continuous change score, with the discounts the savings table is computed under": "连续的变化分，并给出样本量节省的折扣设定"
  },
  "patients.progression": {
    "linear progression of a score, 25% slower under treatment, power of the change at 18 months (every number says where it came from)": "线性进展的评分：治疗减慢 25%，18 个月变化的功效（每个数字都写明来源）",
    "a saturating (Emax) progression, tested by the per-person slope": "逐渐饱和（Emax）的进展，用每个人的斜率检验"
  },
  "population.check": {
    "a generated population against a second, independent baseline table (the platform fills `generated` from the population subjectId names)": "生成的人群与第二份基线表对照"
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
    "doubly robust, binary outcome": "二分类结局的双重稳健估计",
    "doubly robust, restricted mean survival time to 24 months": "24 个月限制平均生存时间的双重稳健估计"
  },
  "comparator.bias_analysis": {
    "how large a bias, and what confounder, turns a hazard ratio of 0.70 (95% interval 0.50 to 0.98): the tipping bias and the tipping confounder": "风险比 0.70（95% 区间 0.50–0.98）要多大的偏倚、什么样的混杂才会翻转",
    "the same estimate tested against stated biases (the shifted null), with a probabilistic analysis of a confounder that is twice as common in the treated": "设定偏倚后的检验，并按混杂因素在试验组更常见做概率性分析"
  },
  "comparator.borrowing": {
    "the external control counts for 0.3 of a patient each: a power prior on a response rate (90 of 300 historically, 40 of 150 now, 100 of 300 on treatment)": "外部对照每人只算 0.3 人：应答率的幂先验（历史 90/300，现在 40/150，试验组 100/300）",
    "borrowing decided by the data: a self-adapting mixture prior, a difference of 0.1 in the response rate being too much to borrow across, and what it does to the type I error and power if the true control rate drifts": "借用多少由数据决定：自适应混合先验，应答率差 0.1 就不再借用，以及对照组真实应答率偏离时 I 类错误和功效的变化",
    "how a conflict becomes a level of borrowing: an elastic prior on a mean (historical mean 10, sd 4, 120 patients; 60 now, mean 11), a difference of 2 being a conflict": "冲突怎样换算成借用程度：均值的弹性先验（历史均值 10、标准差 4、120 例；现在 60 例、均值 11），差 2 就算冲突"
  },
  "comparator.stc": {
    "an anchored comparison on a binary outcome: the aggregate trial's log odds ratio against the common comparator is -0.35 (standard error 0.12)": "锚定的二分类比较：对方试验相对共同对照的对数优势比为 -0.35（标准误 0.12）"
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
