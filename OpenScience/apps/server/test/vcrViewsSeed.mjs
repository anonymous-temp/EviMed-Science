// A 「虚拟临研」 study furnished the way the platform furnishes one — through the
// real stores, with results shaped exactly as the engine returns them — so the
// presenter is proven on rows the module actually writes, not on a shape this
// test made up. Not a `*.test.mjs` file on purpose: `pnpm test:server` globs
// `test/*.test.mjs`, and a helper that lived in one would re-run that suite in
// every file importing it.
//
// The study is the mockups' own (docs/superpowers/specs/2026-09-28-virtual-
// clinical-research-assets/mockups/SPEC.md): EV-201 in second-line NSCLC, four
// designs, a literature control, an external control that cannot be estimated,
// and a partner's candidates for the matching tab. Every timestamp is set to a
// fixed instant after seeding (`fixClock`), so the fixture the web renders is
// byte-stable.
import { createHash } from "node:crypto";

import { lineageNode } from "@evimed/domain";

import { assessSubject } from "../src/vcrMatching.mjs";
import { assumptionFromPooling, readPoolResult } from "../src/vcrEvidence.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";
import { seedVcrCatalogue } from "../src/vcrService.mjs";

/** The clock every seeded row is set to, and the clock the service under test reads. */
export const SEED_NOW = new Date("2026-09-28T09:00:00.000Z");

const OWNER = "u_owner";

/** @param {number} value */
const iso = (value) => new Date(value).toISOString();

/**
 * Give every timestamped row a fixed instant: earlier objects on the 27th,
 * runs and packages on the 28th. Order within a table is kept; only the
 * values are made deterministic.
 * @param {any} store
 */
export async function fixClock(store) {
  const early = Date.parse("2026-09-27T01:00:00.000Z");
  const late = Date.parse("2026-09-28T01:00:00.000Z");
  const tables = [
    ["studies", "created_at", early, "id"], ["study_definitions", "created_at", early, "id"], ["protocol_versions", "created_at", early, "id"],
    ["criteria", "created_at", early, "id"], ["precedents", "created_at", early, "id"], ["evidence_items", "created_at", early, "id"],
    ["assumptions", "created_at", early, "id"], ["models", "created_at", early, "id"], ["model_assessments", "created_at", early, "id"], ["populations", "created_at", early, "id"],
    ["patient_sets", "created_at", early, "id"], ["comparator_designs", "created_at", early, "id"], ["trial_scenarios", "created_at", early, "id"],
    ["design_grids", "created_at", early, "id"], ["reviews", "created_at", early, "id"], ["sites", "created_at", early, "id"],
    ["jobs", "created_at", late, "id"], ["executions", "created_at", late, "id"], ["results", "created_at", late, "id"],
    ["decisions", "created_at", late, "id"], ["exports", "created_at", late, "id"], ["forecasts", "created_at", late, "id"],
    ["matching_assessments", "created_at", late, "id"], ["referrals", "created_at", late, "id"], ["followup_episodes", "created_at", late, "id"],
  ];
  for (const [table, column, base, key] of tables) {
    await store.query(`WITH r AS (SELECT ${key} AS k, row_number() OVER (ORDER BY ${column}, ${key}) AS n FROM evimed_vcr.${table})
      UPDATE evimed_vcr.${table} t SET ${column} = $1::timestamptz + r.n * interval '7 minutes' FROM r WHERE t.${key} = r.k`, [iso(base)]);
  }
  await store.query(`WITH r AS (SELECT id AS k, row_number() OVER (ORDER BY updated_at, id) AS n FROM evimed_vcr.studies)
    UPDATE evimed_vcr.studies t SET updated_at = $1::timestamptz + r.n * interval '9 minutes' FROM r WHERE t.id = r.k`, [iso(late)]);
  await store.query(`UPDATE evimed_vcr.studies SET steps = COALESCE((SELECT jsonb_object_agg(k,
      CASE WHEN v ? 'updatedAt' AND v->>'updatedAt' IS NOT NULL THEN jsonb_set(v, '{updatedAt}', to_jsonb($1::text)) ELSE v END)
    FROM jsonb_each(steps) AS t(k, v)), steps)`, [iso(late + 3_600_000)]);
  await store.query("UPDATE evimed_vcr.jobs SET updated_at = created_at + interval '2 minutes', finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE created_at + interval '2 minutes' END");
  await store.query("UPDATE evimed_vcr.exports SET updated_at = created_at + interval '3 minutes'");
  await store.query("UPDATE evimed_vcr.referrals SET updated_at = created_at, contact_approved_at = CASE WHEN contact_approved_at IS NULL THEN NULL ELSE created_at END");
  await store.query("UPDATE evimed_vcr.sites SET updated_at = created_at");
  await store.query(`WITH r AS (SELECT study_id AS s, node AS nn, row_number() OVER (ORDER BY marked_at, node) AS n FROM evimed_vcr.stale_marks)
    UPDATE evimed_vcr.stale_marks t SET marked_at = $1::timestamptz + r.n * interval '11 minutes' FROM r WHERE t.study_id = r.s AND t.node = r.nn`, [iso(late + 3_600_000)]);
}

/** An engine-shaped measure. @param {string} name @param {number | null} value @param {Record<string, any>} [extra] */
const measure = (name, value, extra = {}) => ({ name, value, simulated: false, ...extra });

/** A simulated measure with its Monte-Carlo error and interval, the way `vcr_summarize_replicates` writes one. @param {string} name @param {number} value @param {number} mcse */
const simulated = (name, value, mcse) => ({
  name, value, simulated: true, mcse,
  interval: { kind: "monte_carlo", low: value - 1.96 * mcse, high: value + 1.96 * mcse, level: 0.95 },
});

/**
 * Seed the EV-201 study and a second, empty one, and return what the test needs
 * to address them.
 *
 * @param {{ store: any, matchStore: any, evidenceStore: any }} stores
 */
export async function seedEv201({ store, matchStore, evidenceStore }) {
  await seedVcrCatalogue({ store });
  for (const [method, endpoints, passed, total] of [
    ["comparator.entropy_balance", ["continuous", "binary", "time_to_event"], 7, 7],
    ["comparator.rmst", ["time_to_event"], 6, 6],
    ["accrual.poisson_gamma", ["accrual"], 9, 9],
    ["evidence.reconstruct_km", ["time_to_event"], 5, 5],
  ]) {
    const known = (await store.methods()).find((row) => row.method === method);
    if (known) await store.saveMethod({ method, version: known.version, endpoints, numericTests: { passed, total }, crossChecks: known.crossChecks });
  }

  const study = await store.createStudy({
    userId: OWNER, projectId: "prj_ev201", name: "EV-201 二线 NSCLC：单臂 II 期还是随机",
    question: "单臂 II 期加外部对照行不行，还是必须做随机？", dataTier: "T0", intendedUse: "design_support",
  });
  await store.query("INSERT INTO evimed_vcr.members (study_id, user_id, role) VALUES ($1, 'u_stat', 'statistical_reviewer'), ($1, 'u_recruit', 'recruiter')", [study.id]);
  const userId = OWNER;
  const studyId = study.id;

  // --- 定义
  const definition = await store.saveDefinition({
    studyId, userId, endpointType: "time_to_event", intendedUse: "design_support",
    pico: { population: "EGFR/ALK 阴性晚期非小细胞肺癌，一线含铂化疗 ± 免疫治疗后进展", intervention: "EV-201", comparator: "多西他赛", outcome: "PFS" },
    estimand: { variable: "PFS", kind: "ATT", text: "试验人群的无进展生存（PFS）" },
  });

  // --- 方案与入排条件
  const protocol = await store.saveProtocolVersion({
    studyId, userId, title: "EV-201 方案 v1",
    criteria: [
      { kind: "inclusion", criterionType: "demographic", sourceText: "年龄 ≥ 18 岁", sourceLocator: { page: 12 },
        requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 }, evidenceNeeded: ["出生日期或年龄"] },
      { kind: "inclusion", criterionType: "performance_status", sourceText: "ECOG 体能评分 0–1（近 4 周内）", sourceLocator: { page: 12, section: "3.1" },
        requirement: { op: "compare", variable: "ecog", comparator: "lte", value: 1, window: { days: 28 } }, evidenceNeeded: ["近 4 周内的体能评分"] },
      { kind: "inclusion", criterionType: "prior_treatment", sourceText: "一线接受过含铂双药化疗，可联合 PD-1/PD-L1 抑制剂", sourceLocator: { page: 12, section: "3.1" },
        requirement: { op: "present", variable: "first_line_platinum" }, evidenceNeeded: ["一线治疗记录"] },
      { kind: "exclusion", criterionType: "comorbidity", sourceText: "活动性脑转移", sourceLocator: { page: 13, section: "3.2" },
        requirement: { op: "absent", variable: "active_brain_metastasis", window: { days: 84 } }, evidenceNeeded: ["申请近 4 周头颅 MRI"] },
      { kind: "exclusion", criterionType: "time_window", sourceText: "末次免疫治疗距今不足 28 天", sourceLocator: { page: 13, section: "3.2" },
        requirement: { op: "elapsed_since", variable: "last_immunotherapy", days: 28 }, evidenceNeeded: ["末次免疫治疗日期"] },
      { kind: "exclusion", criterionType: "pregnancy", sourceText: "妊娠或哺乳期", sourceLocator: { page: 13, section: "3.2" },
        requirement: { op: "absent", variable: "pregnancy" }, evidenceNeeded: ["妊娠状态记录"] },
    ],
  });
  const criteria = protocol.criteria;

  // --- 试验先例、抽取值、假设卡
  /** @type {any[]} */
  const precedentRows = [];
  const registryRows = [
    ["NCT09900001", "clinicaltrials.gov", "多西他赛二线 NSCLC 随机 III 期", 425, 421, 20, 38, ["中国", "日本"], 3.9, 3.4, 4.4, false],
    ["NCT09900002", "clinicaltrials.gov", "多西他赛对照 II 期", 288, 279, 14, 22, ["美国"], 4.3, 3.7, 4.9, false],
    ["CTR20990001", "cde", "多西他赛对照 III 期（中国人群）", 420, 426, 22, 38, ["中国"], 4.0, 3.3, 4.2, true],
  ];
  for (const [registryId, registry, title, planned, actual, months, siteCount, countries] of registryRows) {
    precedentRows.push(await evidenceStore.savePrecedent({
      userId, studyId,
      precedent: {
        registry, registryId, title,
        pico: { conditions: ["非小细胞肺癌"], interventions: [{ name: "多西他赛" }] },
        design: { phases: ["PHASE3"], allocation: "RANDOMIZED", masking: "开放" },
        enrollment: { planned, actual, accrualToPrimaryCompletionMonths: months }, enrollmentKind: "actual",
        sites: { count: siteCount, countries }, eligibilityText: "组织学或细胞学确诊的晚期 NSCLC；一线含铂化疗后进展。",
        endpoints: [{ title: "无进展生存期（PFS）" }], results: { hasResults: true },
        sources: [{ url: `https://example.org/${registryId}` }], fetchedAt: "2026-09-27T00:00:00.000Z",
      },
    }));
  }
  const evidenceIds = [];
  for (const [index, row] of registryRows.entries()) {
    const [registryId, , , , , , , , median, low, high, chinese] = row;
    const written = await evidenceStore.appendEvidenceItems({
      userId, studyId, precedentId: precedentRows[index].id,
      items: [{
        parameter: "median_survival_months", arm: "docetaxel", value: median, valueText: `${median}`, unit: "月", ciLow: low, ciHigh: high,
        sampleSize: [425, 288, 420][index], events: [380, 250, 372][index], valueSource: "extracted", sourceRef: registryId,
        quote: `多西他赛组中位 PFS 为 ${median} 个月（95% CI ${low}–${high}）`,
        locator: { page: 6, table: "表 2", verification: "verified" }, applicability: { chinesePopulation: chinese },
      }],
    });
    evidenceIds.push(...written.ids);
  }
  const pooled = readPoolResult({
    status: "succeeded",
    measures: [
      measure("pooled", Math.log(4.1), { interval: { kind: "confidence", low: Math.log(3.6), high: Math.log(4.6), level: 0.95 } }),
      measure("prediction", Math.log(4.1), { interval: { kind: "prediction", low: Math.log(3.0), high: Math.log(5.6), level: 0.95 } }),
      measure("k", 7), measure("i_squared", 41), measure("tau_squared", 0.02),
    ],
    diagnostics: { scale: "log", poolingMethod: "random_effects_reml", k: 7, i2: 0.41, tau2: 0.02 },
  });
  const card = assumptionFromPooling({
    key: "control_median_pfs", name: "对照组中位 PFS", parameter: "median_survival_months", endpoint: "PFS", unit: "个月",
    pools: { overall: pooled }, evidenceIdsByCalibre: { overall: evidenceIds }, applicability: { population: "二线 NSCLC，多西他赛单药", region: "含中国人群的研究" },
    note: "7 项随机效应汇总",
  }).card;
  await evidenceStore.saveAssumption({ userId, studyId, card });
  await store.saveAssumption({
    studyId, userId, key: "target_hr", name: "目标 HR", pointValue: 0.6, unit: "", sourceKind: "scenario", valueSource: "assumed",
    distribution: { family: "lognormal", params: { meanlog: Math.log(0.6), sdlog: 0.22 }, note: "设计先验" },
    sensitivity: { range: { kind: "prediction", low: 0.5, high: 0.75 } }, note: "情景假设；敏感性范围 0.50–0.75", reviewState: "ai_set",
  });
  await store.saveAssumption({
    studyId, userId, key: "orr_control", name: "对照组 ORR", pointValue: 12.4, unit: "%", sourceKind: "external_evidence", valueSource: "aggregate",
    poolingMethod: "random_effects_reml", pooling: { k: 9, predictionInterval: { kind: "prediction", low: 7.9, high: 18.6 } },
    evidenceIds: [], reviewState: "reviewed", note: "9 项汇总",
  });
  await store.saveAssumption({
    studyId, userId, key: "dropout_annual", name: "脱落率", pointValue: 10, unit: "%/年", sourceKind: "external_evidence", valueSource: "aggregate",
    pooling: { k: 5 }, evidenceIds: [], reviewState: "ai_set",
  });
  const assumptions = await store.assumptions(studyId);

  // --- 模型
  await store.saveModel({
    name: "nsclc-docetaxel-pfs-weibull", version: "1.2", tier: "literature", risk: "low", endpointType: "time_to_event", userId,
    card: { title: "二线 NSCLC 多西他赛组 PFS · Weibull", type: "fitted_prediction_model", provider: "研究 EV-201", interface: "vcr-engine patients.time_to_event",
      inputs: ["中位 PFS", "形状参数"], outputs: "对照组个体 PFS 的推演", missingData: "缺项不插补。", knownLimits: ["未做外部验证", "无更新机制"],
      retirement: "来源试验更新时复核。" },
    applicability: { population: "二线 NSCLC，多西他赛单药", region: "含中国人群的研究", endpoints: ["time_to_event"], sources: ["NCT09900001", "NCT09900002", "CTR20990001"] },
    validation: { codeVerification: "对照解析解", internal: "重建 QC 通过", external: false },
    evidence: ["code_verification", "seed_reproducible", "input_traceable", "sensitivity_analysis"],
  });
  const modelUsed = [{ name: "nsclc-docetaxel-pfs-weibull", tier: "literature", risk: "low",
    evidence: ["code_verification", "seed_reproducible", "input_traceable", "sensitivity_analysis"] }];

  // --- 模型评估记录（AI 写入，ICH M15 附录 1；评价与结论两行要等分析做完才填）
  await store.saveModelAssessment({
    studyId, userId, actor: "runtime", record: {
      key: "pfs_projection", modelName: "nsclc-docetaxel-pfs-weibull", modelVersion: "1.2",
      questionOfInterest: "对照组的无进展生存分布是否足以支持单臂试验的样本量计算",
      contextOfUse: "用文献模型生成对照组个体 PFS，只用于设计阶段的功效模拟",
      influence: "medium", influenceJustification: "模拟结果与文献对照并用，不是唯一依据",
      consequence: "high", consequenceJustification: "样本量低估会让关键试验功效不足",
      riskJustification: "后果为高而影响力为中，风险随后果",
      impact: "low", impactJustification: "加权外部对照在监管上已有讨论",
      technicalCriteria: [{ criterion: "重建后的中位 PFS 与来源试验相差不超过 5%", rationale: "与模型风险相称" }],
      appropriateness: "文献模型覆盖二线 NSCLC 多西他赛单药的人群与终点",
    },
  });

  // --- 人群（v1 更早，v2 当前）
  await store.savePopulation({
    studyId, userId, kind: "real", name: "合作方候选人 v1", counts: { realPatients: 3390, eligible: 41, indeterminate: 590, excluded: 2759 },
    waterfall: [{ key: "all", label: "全部候选人", remaining: 3390 }], profile: {}, reviewState: "ai_set",
  });
  const eventsAt = (/** @type {number} */ index) => criteria[index].id;
  const population = await store.savePopulation({
    studyId, userId, kind: "real", name: "合作方候选人 v2", allowedUses: ["feasibility", "design"], reviewState: "ai_set",
    definition: { timeZero: "一线治疗后首次影像进展日", evidenceWindow: "影像 ≤ 12 周 · 体能评分与化验 ≤ 4 周", exit: "死亡 · 失访 · 已开始二线治疗" },
    counts: { realPatients: 3412, eligible: 57, indeterminate: 612, excluded: 2743 },
    waterfall: [
      { key: "all", label: "全部候选人", remaining: 3412 },
      { criterionId: eventsAt(0), label: "年龄 ≥ 18 岁", kept: 3400, excluded: 12, unknown: 0, remaining: 3400 },
      { criterionId: eventsAt(1), label: "ECOG 0–1", kept: 2589, excluded: 152, unknown: 188, remaining: 2741,
        unknownReasons: [{ key: "stale_evidence", label: "证据超过时效", detail: "如体能评分超过 4 周", count: 188 }] },
      { criterionId: eventsAt(2), label: "一线含铂双药化疗", kept: 1855, excluded: 611, unknown: 22, remaining: 2130 },
      { criterionId: eventsAt(3), label: "无活动性脑转移", kept: 1200, excluded: 90, unknown: 402, remaining: 1692,
        unknownReasons: [{ key: "stale_evidence", label: "证据超过时效", detail: "如头颅 MRI 超过 12 周", count: 291 }, { key: "not_recorded", label: "没有记录", count: 111 }] },
    ],
    profile: { rows: [
      { key: "age", label: "年龄（岁）", ours: { value: 62, unit: "岁" }, theirs: { value: 61, unit: "岁" }, smd: 0.09 },
      { key: "immuno", label: "既往免疫治疗", ours: { value: 100, unit: "%" }, theirs: { value: 95.4, unit: "%" }, smd: 0.31 },
      { key: "ecog", label: "ECOG 0 / 1", ours: { value: 31, unit: "%" }, theirs: { value: 35, unit: "%" }, smd: 0.08 },
    ] },
    quality: {
      fidelity: {
        univariate: [{ variable: "age", statistic: "ks_d", value: 0.04, missingRateDifference: 0.01 }, { variable: "ecog", statistic: "tvd", value: 0.03, missingRateDifference: 0.02 }],
        pairwise: [{ pair: "age~ecog", value: 0.05 }],
        global: { sPMSE: 1.4, propensityAuc: 0.56 },
      },
      constraints: [{ constraint: "age>=18", violations: 0 }],
      utility: { feasibility: { jointPassRateRelativeDifference: 0.06 }, specific: { pfs_median: { analysis: "pfs_median", confidenceIntervalOverlap: 0.91 } } },
      disclosure: { available: true, replicationRatio: 0.9, nearestNeighbourInTrainShare: 0.5, membershipAuc: 0.52 },
      generator: { trainingObservations: 3412, syntheticCopies: 1 },
    },
  });

  // --- 虚拟患者集（这一步没做完：保留部分结果）
  const patientSet = await store.savePatientSet({
    studyId, userId, populationId: population.id, name: "2000 名虚拟患者", modelId: "nsclc-docetaxel-pfs-weibull", modelVersion: "1.2",
    scenario: { seed: 5 }, twinLabel: "baseline_conditioned_prediction",
  });

  // --- 对照：外部对照不可估计（v1），文献对照有限制地估计（v2，当前）
  const external = await store.saveComparatorDesign({
    studyId, userId, route: "external_control", estimand: "ATT", conclusion: "not_estimable",
    targetTrial: { population: "二线 NSCLC", treatment: "EV-201 单药" },
    gapList: [
      { title: "同期治疗记录", detail: "后续治疗线：合作方只有入组前资料", answers: "换药按治疗策略处理，伴随事件与试验一致" },
      { title: "结局评估频率", detail: "影像随访间隔：常规诊疗无固定间隔", answers: "校正评估时点偏倚" },
      { title: "ECOG 缺失 38%", detail: "关键预后因素，缺失多于可插补的范围", answers: "把 ECOG 纳入熵平衡" },
    ],
  });
  const literature = await store.saveComparatorDesign({
    studyId, userId, route: "literature_control", estimand: "ATT",
    targetTrial: { population: "二线 NSCLC，多西他赛单药", treatment: "EV-201 单药 vs 多西他赛", note: "文献对照的估计落在来源试验人群；与本研究人群的可比性见右。" },
    configuration: { comparability: [
      { key: "prognostic_factors", state: "approximate", reason: "ECOG 分布不同" }, { key: "geography", state: "exact" }, { key: "time_period", state: "approximate", reason: "来源试验早于 2020 年" },
    ], e10: [
      { key: "effect_large", state: "partial", note: "目标 HR 0.60" }, { key: "objective_endpoint", state: "met" },
      { key: "predictable_course", state: "met" }, { key: "prognostic_factors_known", state: "doubtful", note: "免疫治疗暴露不同" },
    ] },
  });

  // --- 试验方案 A/B/C/D
  const designs = [
    ["方案 A 单臂 + 文献对照", "single_arm_external", "binary", { nTreat: 60, nControl: 0 }, 1450],
    ["方案 B 2:1 随机", "two_arm_fixed", "time_to_event", { nTreat: 120, nControl: 60, allocation: 0.667 }, 3900],
    ["方案 C 1:1 随机 + 一次期中分析", "group_sequential", "time_to_event", { nTreat: 110, nControl: 110 }, 4600],
    ["方案 D 1:1 随机 无期中", "two_arm_fixed", "time_to_event", { nTreat: 120, nControl: 120 }, 5000],
  ];
  const scenarios = [];
  for (const [label, design, endpointType, sizes, cost] of designs) {
    scenarios.push(await store.saveTrialScenario({
      studyId, userId, label, design, endpointType, assumptionIds: ["control_median_pfs", "target_hr"], comparatorId: literature.id,
      configuration: {
        design: sizes, truth: { hazardRatio: 0.6, controlMedian: 4.1 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 },
        performance: ["power", "type_one_error", "expected_sample_size"], cost,
      },
    }));
  }
  await store.saveDesignGrid({
    studyId, userId,
    dimensions: { designs: [{ label: "方案 B" }, { label: "方案 C" }] },
    truthScenarios: [{ name: "HR 1.0（零假设）", effect: 1 }, { name: "HR 0.75", effect: 0.75 }, { name: "HR 0.60", effect: 0.6 }, { name: "HR 0.50", effect: 0.5 }],
    comparisonGoal: { text: "成功把握尽量高、样本量尽量少", measures: [{ name: "assurance", direction: "higher" }, { name: "expected_sample_size", direction: "lower" }] },
    // Numbered the way the engine numbers a grid's designs and truths: from 1 (R's own), so the
    // first design under the null is (1, 1) — a seed that counted from 0 drew a page the engine's
    // own cells would then have shifted by one design and one truth.
    cells: [
      [1, 1, 0.0247], [1, 2, 0.35], [1, 3, 0.81], [1, 4, 0.96], [2, 1, 0.0251], [2, 2, 0.42], [2, 3, 0.85], [2, 4, 0.97],
    ].map(([designIndex, truthIndex, power]) => ({ designIndex, truthIndex, status: "succeeded", measures: [simulated(truthIndex === 1 ? "type_one_error" : "power", power, 0.003)] })),
  });

  // --- 计算：任务、执行、结果
  let jobNumber = 0;
  /** @param {string} kind @param {string} method @param {Record<string, any>} [fields] */
  const job = async (kind, method, fields = {}) => {
    jobNumber += 1;
    const id = `job_seed_${jobNumber}`;
    await store.query(`INSERT INTO evimed_vcr.jobs (id, study_id, user_id, kind, method, method_version, state, scenario_hash, seed, replicates,
      progress, cpu_seconds_limit, cpu_seconds_used, error)
      VALUES ($1, $2, $3, $4, $5, '1.0.0', $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb)`,
    [id, studyId, userId, kind, method, fields.state ?? "succeeded", createHash("sha256").update(id).digest("hex"), fields.seed ?? 5, fields.replicates ?? null,
      JSON.stringify(fields.progress ?? {}), fields.limit ?? 600, fields.used ?? 12, fields.error ? JSON.stringify(fields.error) : null]);
    return id;
  };
  /** @param {string} jobId @param {string} method @param {number | null} replicates */
  const execution = async (jobId, method, replicates) => store.recordExecution({
    jobId, studyId, userId, method, methodVersion: "1.0.0", scenarioHash: createHash("sha256").update(jobId).digest("hex"), seed: 5, replicates, cpuSeconds: 12.4,
  });
  /** @param {Record<string, any>} input */
  const record = (input) => store.recordResult({ studyId, userId, requestedUse: "design_support", ...input });

  // 人群（真实队列，全部是观察）
  const populationExecution = await execution(await job("build_cohort", "cohort.build"), "cohort.build", null);
  const populationResult = await record({ kind: "population", executionId: populationExecution.id, conclusion: "estimable",
    counts: { realPatients: 3412, events: null, effectiveSampleSize: null, generatedRecords: 0 }, measures: [measure("cohort_size", 57)], diagnostics: {} });
  await store.attachResult("populations", population.id, populationResult.id);

  // 虚拟患者（模型预测；这一次运行只完成了一部分重复）
  const patientsExecution = await execution(await job("generate_patients", "patients.time_to_event", { replicates: 2000 }), "patients.time_to_event", 2000);
  const patientsResult = await record({
    kind: "patient_set", executionId: patientsExecution.id, conclusion: "limited", models: modelUsed,
    counts: { realPatients: 0, events: 1210, effectiveSampleSize: null, generatedRecords: 2000 },
    measures: [measure("generated_records", 2000, { source: "synthetic" }), simulated("median_pfs_control", 4.1, 0.06)],
    diagnostics: {
      partial: true, replicatesCompleted: 1200, replicatesPlanned: 2000, headline: "按文献模型推演：试验情景的中位 PFS 长于对照情景。",
      trajectories: { xLabel: "月", yLabel: "PFS 概率", ticks: ["0", "6", "12"], series: [
        { key: "treatment", label: "试验情景", source: "predicted", ours: true, bandKind: "prediction", bandLevel: 80, endLabel: "试验",
          points: [{ x: 0, y: 1, low: 1, high: 1 }, { x: 6, y: 0.62, low: 0.5, high: 0.72 }, { x: 12, y: 0.41, low: 0.28, high: 0.52 }] },
        { key: "control", label: "对照情景", source: "predicted", bandKind: "prediction", bandLevel: 80, endLabel: "对照",
          points: [{ x: 0, y: 1, low: 1, high: 1 }, { x: 6, y: 0.4, low: 0.3, high: 0.5 }, { x: 12, y: 0.18, low: 0.1, high: 0.26 }] },
      ] },
      panels: [{ key: "rescue", title: "12 个月内需要补救治疗", kind: "binary", note: "模型预测，非观察",
        rows: [{ label: "对照情景", value: { value: 24, unit: "%", source: "predicted", interval: { kind: "prediction", low: 13, high: 39, level: 80 } } }] }],
      sensitivity: { measure: "试验情景 12 个月 PFS 概率", base: { value: 0.41, source: "predicted" }, rows: [
        { label: "目标 HR", range: "0.50～0.75", low: 0.33, high: 0.49 }, { label: "对照组中位 PFS", range: "3.0～5.6 个月", low: 0.36, high: 0.47 } ] },
      example: { id: "VP-0412", source: "synthetic", origin: "批量合成（人群 v2）· 种子已记录",
        baseline: [{ label: "年龄", value: "62 岁", source: "synthetic" }, { label: "ECOG", value: "1", source: "synthetic" }],
        inScope: { ok: true, text: "在模型适用范围内" },
        scenarios: { difference: "12 个月生存概率相差 0.23", series: [
          { key: "as_control", label: "对照假设", source: "predicted", points: [{ x: 0, y: 1 }, { x: 6, y: 0.4 }, { x: 12, y: 0.18 }] },
          { key: "as_treatment", label: "试验假设", source: "predicted", ours: true, points: [{ x: 0, y: 1 }, { x: 6, y: 0.62 }, { x: 12, y: 0.41 }] },
        ] } },
    },
  });
  await store.attachResult("patient_sets", patientSet.id, patientsResult.id);
  await store.setStep(studyId, "patients", { status: "failed", requested: true, note: "这一次运行只完成了一部分" });

  // 对照
  const externalExecution = await execution(await job("weight_comparator", "comparator.entropy_balance"), "comparator.entropy_balance", null);
  const externalResult = await record({
    kind: "comparator", subjectId: "external_control", executionId: externalExecution.id, conclusion: "not_estimable",
    notEstimableRule: "effective_sample_size_below_floor", counts: { realPatients: 669, effectiveSampleSize: 31, events: null, generatedRecords: 0 },
    measures: [], diagnostics: { gaps: external.gapList },
  });
  await store.attachResult("comparator_designs", external.id, externalResult.id, { conclusion: "not_estimable", gapList: external.gapList });
  const literatureExecution = await execution(await job("reconstruct_km", "evidence.reconstruct_km"), "evidence.reconstruct_km", null);
  const literatureResult = await record({
    kind: "comparator", subjectId: "literature_control", executionId: literatureExecution.id, conclusion: "limited",
    counts: { realPatients: 0, events: 812, generatedRecords: 0, reconstructedPseudoPatients: 801 },
    measures: [
      measure("rmst_control", 5.9, { unit: "months", interval: { kind: "confidence", low: 5.6, high: 6.2, level: 0.95 } }),
      measure("median_survival", 4.1, { unit: "months" }),
    ],
    diagnostics: {
      tau: 12,
      qualityControl: { pass: true, checks: {
        atRisk: { name: "numbers at risk", reported: [287, 99, 60], reconstructed: [287, 100, 62], allowed: [14.35, 5, 3], pass: true },
        events: { name: "total events", reported: 812, reconstructed: 797, pass: true },
        median: { name: "median survival", reported: 4.1, reconstructed: 4.0, pass: true },
      } },
      curves: [
        { key: "s1", label: "研究 1 · 2021", source: "reconstructed", points: [{ x: 0, y: 1 }, { x: 6, y: 0.42 }, { x: 12, y: 0.2 }, { x: 24, y: 0.05 }],
          atRisk: [{ x: 0, n: 287 }, { x: 6, n: 99 }, { x: 12, n: 60 }] },
        { key: "pooled", label: "合并估计", source: "reconstructed", pooled: true, points: [{ x: 0, y: 1 }, { x: 6, y: 0.4 }, { x: 12, y: 0.18 }, { x: 24, y: 0.04 }] },
      ],
      balance: [
        { covariate: "ECOG 0–1", smdUnadjusted: 0.24, smdAdjusted: 0.09 }, { covariate: "既往免疫治疗", smdUnadjusted: 0.42, smdAdjusted: 0.31 },
      ],
      weights: { effectiveSampleSize: 412.5, max: 6.2, coefficientOfVariation: 0.8, topOnePercentShare: 0.07 },
      support: { overlapCoefficient: 0.82, outsideShare: 0.03 },
    },
  });
  await store.attachResult("comparator_designs", literature.id, literatureResult.id, { conclusion: "limited" });

  // 试验方案：模拟运行 + 入组预测
  const designMeasures = {
    "方案 A 单臂 + 文献对照": [simulated("power", 0.66, 0.004), simulated("assurance", 0.58, 0.004), simulated("expected_sample_size", 60, 0)],
    "方案 B 2:1 随机": [simulated("power", 0.81, 0.003), simulated("assurance", 0.71, 0.004), simulated("type_one_error", 0.0247, 0.0011), simulated("expected_sample_size", 180, 0)],
    "方案 C 1:1 随机 + 一次期中分析": [simulated("power", 0.85, 0.003), simulated("assurance", 0.74, 0.004), simulated("type_one_error", 0.0251, 0.0011), simulated("expected_sample_size", 204, 1.1)],
    "方案 D 1:1 随机 无期中": [simulated("power", 0.86, 0.003), simulated("assurance", 0.72, 0.004), simulated("expected_sample_size", 240, 0)],
  };
  for (const scenario of scenarios) {
    const jobId = await job("design_simulation", "design.simulate", { replicates: 16000 });
    const run = await execution(jobId, "design.simulate", 16000);
    const result = await record({
      // A design's result is filed under the design, or the next design's would supersede it.
      kind: "trial_scenario", subjectId: scenario.id, executionId: run.id, conclusion: "estimable", models: modelUsed,
      counts: { realPatients: 0, events: 138, effectiveSampleSize: null, generatedRecords: 6_480_000 },
      measures: /** @type {any} */ (designMeasures)[scenario.label],
      diagnostics: { analyticCheck: { name: "power", value: 0.8, simulated: 0.81, difference: 0.004, differenceInMcse: 1.3, withinThreeMcse: true }, replicatesCompleted: 16000, replicatesPlanned: 16000 },
    });
    await store.attachResult("trial_scenarios", scenario.id, result.id);
    if (scenario.label.startsWith("方案 D")) continue;
    const durations = { "方案 A 单臂 + 文献对照": [11.7, 9.2, 15.0], "方案 B 2:1 随机": [16.4, 13.9, 19.3], "方案 C 1:1 随机 + 一次期中分析": [19.6, 16.7, 23.2] };
    const [median, low, high] = /** @type {any} */ (durations)[scenario.label];
    const accrualRun = await execution(await job("accrual_forecast", "accrual.poisson_gamma"), "accrual.poisson_gamma", 20000);
    await record({
      kind: "accrual_forecast", subjectId: scenario.id, executionId: accrualRun.id, conclusion: "estimable",
      counts: { realPatients: 0, generatedRecords: 0 },
      measures: [simulated("last_patient_in_months", median, 0.05)].map((entry) => ({ ...entry, interval: { kind: "prediction", low, high, level: 0.8 } })),
      diagnostics: {},
    });
  }
  const powerCurveRun = await execution(await job("design_grid", "design.grid", { replicates: 5000 }), "design.grid", 5000);
  await record({ kind: "design_grid", executionId: powerCurveRun.id, conclusion: "estimable", counts: { realPatients: 0, generatedRecords: 40_000_000 },
    measures: [measure("cells", 8)], diagnostics: {} });
  // The recruitment forecast of the study itself.
  const recruitRun = await execution(await job("accrual_forecast", "accrual.poisson_gamma"), "accrual.poisson_gamma", 20000);
  await record({
    kind: "accrual_forecast", subjectId: "recruitment", executionId: recruitRun.id, conclusion: "estimable", counts: { realPatients: 11 },
    measures: [
      { ...simulated("last_patient_in_months", 14.2, 0.06), interval: { kind: "prediction", low: 12.1, high: 17.3, level: 0.8 } },
      { ...simulated("probability_by_2027-12-15", 0.61, 0.004), interval: undefined },
    ],
    diagnostics: {},
  });
  const evidenceRun = await execution(await job("pool_evidence", "evidence.pool"), "evidence.pool", null);
  await record({ kind: "evidence_pool", subjectId: "control_median_pfs", executionId: evidenceRun.id, conclusion: "estimable",
    counts: { realPatients: null, generatedRecords: 0 },
    measures: [measure("pooled", Math.log(4.1), { interval: { kind: "confidence", low: Math.log(3.6), high: Math.log(4.6), level: 0.95 } }), measure("k", 7)],
    diagnostics: { scale: "log", poolingMethod: "random_effects_reml" } });
  await record({ kind: "snapshot_profile", executionId: (await execution(await job("profile_snapshot", "profile.snapshot"), "profile.snapshot", null)).id,
    conclusion: "estimable", counts: { realPatients: 3412 }, measures: [measure("rows", 3412), measure("columns", 28)], diagnostics: {} });

  // 一个正在运行、一个等预算确认的任务
  await job("design_simulation", "design.simulate", { state: "running", replicates: 20000, progress: { done: 3, total: 10 }, used: 30, limit: 600 });
  await job("design_grid", "design.grid", { state: "awaiting_budget", limit: 9000, used: 0 });

  // --- 决策记录、复核、过期、预测登记、研究包
  const scenarioB = scenarios[1];
  await store.addDecision({
    studyId, userId, question: "在成功把握尽量高、样本量尽量少的目标下选哪个方案", decidedBy: userId,
    chosen: { id: scenarioB.id, code: "B", label: "方案 B 2:1 随机" }, alternatives: [{ code: "A" }, { code: "C" }],
    rationale: "成功把握与样本量的折中；方案 C 周期更长。",
  });
  await store.addReview({
    studyId, userId, kind: "statistical", reviewer: "u_stat", note: "复核了对照组 ORR",
    nodes: [lineageNode("assumption", "orr_control", 1)],
  });
  // What each card feeds: the lineage the data tab's 「被这些结果使用」 reads.
  for (const scenario of scenarios) {
    await store.addEdges(studyId, [
      { from: lineageNode("assumption", "control_median_pfs", 1), to: lineageNode("trial_scenario", scenario.id, scenario.version), cost: "heavy" },
      { from: lineageNode("assumption", "target_hr", 1), to: lineageNode("trial_scenario", scenario.id, scenario.version), cost: "heavy" },
    ]);
  }
  await store.addEdges(studyId, [{ from: lineageNode("assumption", "control_median_pfs", 1), to: lineageNode("patient_set", patientSet.id, patientSet.version) }]);
  const populationNode = lineageNode("population", population.id, population.version);
  await store.markStale(studyId, [populationNode], "criterion_changed", {});
  await store.noteRecomputeJob(studyId, populationNode, "job_seed_1");
  await store.registerForecast({ studyId, userId, kind: "accrual", prediction: { last_patient_in_months: 14.2, probability_by_2027_12_15: 0.61 } });

  // 合作方数据：评估、转诊、中心
  const asOf = "2026-09-28T00:00:00.000Z";
  const factsFor = (/** @type {Record<string, any>} */ spec) => {
    /** @type {any[]} */
    const facts = [];
    const add = (/** @type {string} */ variable, /** @type {any} */ value, /** @type {string} */ occurredAt, extra = {}) => facts.push({
      id: `${spec.key}:${variable}`, variable, value, occurredAt, visibleAt: occurredAt, polarity: "affirmed", extractedBy: "snapshot",
      snapshot: { id: "snp_partner", field: variable }, ...extra,
    });
    if (spec.age != null) add("age", spec.age, "2026-08-14T00:00:00.000Z", { unit: "year" });
    if (spec.ecog != null) add("ecog", spec.ecog, spec.ecogAt ?? "2026-09-10T00:00:00.000Z");
    if (spec.platinum) add("first_line_platinum", true, "2026-01-05T00:00:00.000Z");
    if (spec.brain === "denied") add("active_brain_metastasis", false, spec.brainAt ?? "2026-09-01T00:00:00.000Z", { polarity: "negated" });
    if (spec.immunotherapy) add("last_immunotherapy", spec.immunotherapy, spec.immunotherapy);
    if (spec.pregnancy === "denied") add("pregnancy", false, "2026-09-01T00:00:00.000Z", { polarity: "negated" });
    return facts;
  };
  const criterionRows = criteria.map((row) => ({ id: row.id, kind: row.kind, criterionType: row.criterionType, requirement: row.requirement }));
  const subjects = [
    { key: "P-0192", age: 63, ecog: 1, platinum: true, brain: null, immunotherapy: "2026-09-20T00:00:00.000Z", pregnancy: "denied" },
    { key: "P-0201", age: 58, ecog: 0, platinum: true, brain: "denied", immunotherapy: "2026-06-01T00:00:00.000Z", pregnancy: "denied" },
    { key: "P-0207", age: 71, ecog: 1, platinum: true, brain: "denied", immunotherapy: "2026-05-11T00:00:00.000Z", pregnancy: "denied" },
    { key: "P-0233", age: 66, ecog: null, platinum: true, brain: null, immunotherapy: "2026-04-02T00:00:00.000Z", pregnancy: null },
    { key: "P-0240", age: 49, ecog: 2, platinum: true, brain: "denied", immunotherapy: "2026-03-01T00:00:00.000Z", pregnancy: "denied" },
    { key: "P-0251", age: 17, ecog: 1, platinum: true, brain: "denied", immunotherapy: "2026-03-01T00:00:00.000Z", pregnancy: "denied" },
  ];
  /** @type {Record<string, any>} */
  const assessments = {};
  for (const subject of subjects) {
    const assessment = assessSubject({
      studyId, protocolVersionId: protocol.id, subjectKey: subject.key, direction: "trial_to_patient", criteria: criterionRows,
      facts: factsFor(subject), asOf, priority: subject.key === "P-0192" ? { score: 0.8, rationale: "ECOG 1，一线含铂后进展" } : undefined,
    });
    assessments[subject.key] = await matchStore.saveAssessment({ assessment, userId });
  }
  for (const [id, name, activated, slots, used, verified] of [
    ["ste_01", "中心 01", "2026-07-15", 6, 2, "2026-09-20T00:00:00.000Z"], ["ste_07", "中心 07", null, 4, 0, null],
  ]) {
    await store.query(`INSERT INTO evimed_vcr.sites (id, study_id, user_id, name, capability, capacity, competing, contacts, activated_on, verified_at)
      VALUES ($1, $2, $3, $4, '{"place": "北京"}'::jsonb, $5::jsonb, '[{"id":"x"}]'::jsonb, '[]'::jsonb, $6, $7)`,
    [id, studyId, userId, name, JSON.stringify({ slots, used }), activated, verified]);
  }
  for (const [id, subjectKey, state, siteId, approver] of [
    ["ref_seed_1", "P-0192", "contactable", "ste_01", null], ["ref_seed_2", "P-0233", "needs_evidence", null, null],
    ["ref_seed_3", "P-0201", "contacted", "ste_01", "u_recruit"], ["ref_seed_4", "P-0207", "enrolled", "ste_01", "u_recruit"],
  ]) {
    await store.query(`INSERT INTO evimed_vcr.referrals (id, study_id, assessment_id, site_id, user_id, subject_key, state, contact_approved_by, contact_approved_at, enrolled_on)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, CASE WHEN $7 = 'enrolled' THEN '2026-09-20'::date ELSE NULL END)`,
    [id, studyId, assessments[subjectKey]?.id ?? null, siteId, userId, subjectKey, state, approver]);
  }
  await matchStore.saveFollowupEpisode({ episode: { studyId, subjectKey: "P-0207", kind: "study_specific", windowStart: "2026-09-21T00:00:00.000Z", observations: [] }, userId });
  await record({ kind: "matching", executionId: (await execution(await job("match_criteria", "matching.evaluate"), "matching.evaluate", null)).id,
    conclusion: "estimable", counts: { realPatients: 6 }, measures: [measure("eligible", 1), measure("insufficient_evidence", 2)], diagnostics: {} });

  // 各步骤
  await store.setStep(studyId, "definition", { status: "done", requested: true, note: `研究定义 v${definition.version}` });
  await store.setStep(studyId, "evidence", { status: "done", requested: true, note: `${assumptions.length} 张假设卡` });
  await store.setStep(studyId, "population", { status: "done", requested: true, note: `人群 v${population.version}` });
  await store.setStep(studyId, "comparator", { status: "done", requested: true, note: "文献对照" });
  await store.setStep(studyId, "trial", { status: "done", requested: true, note: "4 个方案" });
  await store.setStep(studyId, "matching", { status: "done", requested: true, note: "6 人已评估" });

  // 研究包：一个已生成（带渲染出的正文），一个 CDE 草稿
  await store.query("UPDATE evimed_vcr.reviews SET created_at='2026-09-27T09:00:00.000Z' WHERE study_id=$1", [studyId]);
  const model = vcrReportModel({
    study, definition, assumptions, results: await store.results(studyId), seal: null, reviews: await store.reviews(studyId),
    staleMarks: await store.staleMarks(studyId), models: await store.models(userId), population, comparator: literature, scenarios,
  });
  const packageRow = await store.createExport({
    studyId, userId, kind: "study_package",
    cover: {
      reviewed: true, reviews: [{ kind: "statistical", reviewer: "u_stat", nodes: [lineageNode("assumption", "orr_control", 1)], at: "2026-09-27T09:00:00.000Z" }],
      staleResults: 1, intendedUse: "design_support", conclusions: ["estimable", "limited"], seal: { required: false }, preparedAt: "2026-09-28T02:00:00.000Z",
      report: { section: "main", template: "方案 B 的成功把握为 {{n:results.trial_scenario.measures[1].value|pct0}}。", rendered: "方案 B 的成功把握为 71%。", bindings: [] },
      results: model,
    },
  });
  await store.updateExport(packageRow.id, { state: "ready", runId: "run_12", location: "package.pdf" });
  await store.createExport({ studyId, userId, kind: "cde_communication_pack", cover: { reviewed: false } });

  // --- 第二个研究：刚创建，什么都没有
  const empty = await store.createStudy({ userId: OWNER, projectId: "prj_empty", name: "GLP-1 周制剂 III 期：样本量与脱落情景", question: "", dataTier: "T0" });
  for (const step of ["population", "patients", "comparator", "trial"]) await store.setStep(empty.id, step, { requested: true });
  await store.setStep(empty.id, "definition", { requested: true });

  await fixClock(store);
  return { study, empty, protocol, population, criteria, scenarios, packageId: packageRow.id, owner: OWNER };
}
