/**
 * The EV-201 study the design renders are drawn from, as fixtures.
 *
 * The numbers are the mockups' own (`docs/superpowers/specs/
 * 2026-09-28-virtual-clinical-research-assets/mockups/SPEC.md`), so a test
 * that asserts 「71%」 or 「±0.4」 is asserting the thing a reader was shown a
 * picture of — and so a test reads as the product rather than as a fixture
 * factory.
 */
import { VCR_REFERRAL_STATE_LABELS_ZH } from "@evimed/domain";
import type {
  VcrComparatorTab,
  VcrCounts,
  VcrDataTab,
  VcrMatchingTab,
  VcrPatientsTab,
  VcrPopulationTab,
  VcrStudy,
  VcrStudySummary,
  VcrTrialTab,
  VcrValue,
} from "@/lib/vcrClient";

export const value = (input: Partial<VcrValue> & Pick<VcrValue, "source">): VcrValue => ({
  value: null,
  ...input,
});

export const counts = (input: Partial<VcrCounts> = {}): VcrCounts => ({
  realPatients: 0,
  events: null,
  effectiveSampleSize: null,
  generatedRecords: 6_480_000,
  note: "设计阶段：尚无真实患者",
  scope: "方案 B",
  ...input,
});

export const studySummary = (input: Partial<VcrStudySummary> = {}): VcrStudySummary => ({
  id: "std_1",
  projectId: "prj_1",
  name: "EV-201 二线 NSCLC：单臂 II 期还是随机",
  question: "单臂 II 期加外部对照行不行，还是必须做随机？",
  tier: "T0",
  intendedUse: "design_support",
  status: "active",
  steps: {
    definition: { status: "done", note: "研究定义 v2" },
    evidence: { status: "done", note: "12 张假设卡" },
    population: { status: "done", note: "人群 v3" },
    patients: { status: "done", note: "虚拟患者集 v2" },
    comparator: { status: "done", note: "文献对照" },
    trial: { status: "done", note: "4 个方案" },
    matching: { status: "none", note: "未开始" },
  },
  conclusion: { text: "方案 B（2:1 随机，180 例）成功把握 71%（±0.4），高于单臂方案 A 的 58%", state: "limited" },
  attention: [
    { kind: "ai_set", text: "3 条关键假设由 AI 设定", tone: "attention" },
    { kind: "stale", text: "1 个结果已过期", tone: "stale" },
  ],
  updatedAt: "今天 14:32",
  ...input,
});

export const study = (input: Partial<VcrStudy> = {}): VcrStudy => ({
  id: "std_1",
  projectId: "prj_1",
  name: "EV-201 二线 NSCLC：单臂 II 期还是随机",
  question: "单臂 II 期加外部对照行不行，还是必须做随机？",
  tier: "T0",
  intendedUse: "design_support",
  status: "active",
  steps: studySummary().steps,
  sessionId: "ses_1",
  abilities: ["read", "write", "run", "export"],
  budget: { limitCny: 500, spentCny: 128.4 },
  run: { id: "run_12", label: "运行 #12", at: "今天 14:20" },
  overview: {
    headline: "方案 B（2:1 随机，180 例）在当前证据下成功把握 71%，高于单臂方案 A 的 58%；真实外部对照暂不可估计，缺 3 项数据。",
    metrics: [
      {
        key: "control_pfs",
        label: "对照组中位 PFS",
        note: "7 项随机效应汇总",
        value: value({
          value: 4.1, unit: "个月", source: "aggregate", review: "ai_set",
          interval: { kind: "prediction", low: 3.0, high: 5.6, level: 80 },
          detail: {
            kind: "assumption",
            title: "对照组中位 PFS",
            quote: "多西他赛组中位 PFS 为 4.0 个月（95% CI 3.3–4.2）",
            quoteSource: "某试验 2024，第 6 页，表 2",
            fields: [{ label: "合并方法", value: "随机效应（DL）" }, { label: "I²", value: "41%" }],
          },
        }),
      },
      {
        key: "assurance",
        label: "方案 B 成功把握",
        lead: true,
        value: value({
          value: 71, unit: "%", source: "predicted", mcse: 0.4,
          detail: {
            kind: "run",
            title: "运行 #12 · 方案 B",
            fields: [
              { label: "种子", value: "20260928" },
              { label: "备择情景重复", value: "16,000 次" },
              { label: "蒙特卡洛标准误", value: "0.004" },
            ],
          },
        }),
      },
      { key: "sample", label: "样本量", value: value({ value: 180, unit: "例", source: "assumed" }), note: "2:1 随机 · 120 : 60" },
      {
        key: "external_control",
        label: "真实外部对照",
        value: value({ value: null, text: "不可估计", source: "observed", reason: "缺 3 项数据" }),
      },
    ],
    counts: counts(),
    designs: [
      {
        id: "d_a", code: "A", name: "单臂 + 文献对照",
        measures: {
          assurance: value({ value: 0.58, source: "predicted", mcse: 0.4 }),
          duration_months: value({ value: 11.7, source: "predicted" }),
          cost: value({ value: 1450, source: "predicted" }),
        },
      },
      {
        id: "d_b", code: "B", name: "2:1 随机", chosen: true,
        measures: {
          assurance: value({ value: 0.71, source: "predicted", mcse: 0.4 }),
          duration_months: value({ value: 16.4, source: "predicted" }),
          cost: value({ value: 3900, source: "predicted" }),
        },
      },
      {
        id: "d_d", code: "D", name: "1:1 随机，无期中", dominated: true, dominatedBy: "C",
        measures: {},
      },
    ],
    attention: [
      {
        kind: "ai_set", text: "3 条关键假设由 AI 设定", tone: "attention",
        items: ["对照组中位 PFS", "目标 HR", "每中心每月入组"],
        action: { label: "去复核", tab: "data" },
      },
      { kind: "stale", text: "1 个结果已过期：人群 v2 因入排条件 I6 修改", tone: "stale" },
    ],
    changes: [
      { id: "c1", at: "今天 14:32", text: "生成研究包 v2（运行 #12）" },
      { id: "c2", at: "9 月 27 日 17:40", text: "「对照组 ORR 12.4%」复核通过", by: "王统计师", state: "reviewed" },
    ],
    deliverables: [
      { id: "exp_1", kind: "study_package", title: "研究包 v2", meta: "今天 14:32 · PDF · 42 页", runId: "run_12", path: "package.pdf" },
      { id: "exp_2", kind: "cde_communication_pack", title: "CDE 沟通交流资料包", meta: "Word · 统计复核后可定稿", draft: true },
    ],
  },
  updatedAt: "今天 14:32",
  ...input,
});

export const population = (input: Partial<VcrPopulationTab> = {}): VcrPopulationTab => ({
  version: "人群 v3（方案 v2）",
  versions: [{ id: "v3", label: "人群 v3" }, { id: "v2", label: "人群 v2", stale: true }],
  definition: { timeZero: "一线治疗后首次影像进展日", evidenceWindow: "影像 ≤ 12 周 · 体能评分与化验 ≤ 4 周", exit: "死亡 · 失访 · 已开始二线治疗" },
  criteria: [
    { id: "i6", code: "I6", name: "一线含免疫治疗", kind: "inclusion", kept: 1855, excluded: 611, unknown: 22, quote: "一线接受过含铂双药化疗联合 PD-1/PD-L1 抑制剂", review: "ai_set", source: "extracted", changed: "v2 修改" },
    { id: "i4", code: "I4", name: "ECOG 0–1", kind: "inclusion", kept: 2589, excluded: 152, unknown: 188 },
  ],
  attrition: [
    { key: "all", label: VCR_REFERRAL_STATE_LABELS_ZH.candidate, remaining: 3412 },
    { key: "i6", code: "I6", label: "一线含免疫治疗", remaining: 1877, unknown: 260, removed: 611 },
  ],
  outcome: { eligible: 57, insufficient: 612, ineligible: 2743 },
  profile: [
    { key: "immuno", label: "既往免疫治疗", ours: value({ value: 100, unit: "%", source: "observed" }), theirs: value({ value: 95.4, unit: "%", source: "aggregate" }), smd: 0.31, flagged: true },
    { key: "ecog", label: "ECOG 0 / 1", ours: value({ value: 31, unit: "%", source: "observed" }), theirs: value({ value: 35, unit: "%", source: "aggregate" }), smd: 0.09 },
  ],
  unknownReasons: [{ key: "stale", label: "证据超过时效", detail: "如头颅 MRI 超过 12 周", count: 291 }],
  blockers: [{ code: "E3", label: "活动性脑转移", text: "无法判断 402", tone: "attention" }],
  counts: counts({ realPatients: 669, generatedRecords: 0, note: null, scope: null, notes: { events: "T1 无结局记录" } }),
  headline: "按方案 v2，3,412 人中 57 人全部满足、612 人至少 1 条无法判断。",
  ...input,
});

export const patients = (input: Partial<VcrPatientsTab> = {}): VcrPatientsTab => ({
  model: {
    id: "m_1", name: "成人 2 型糖尿病 HbA1c 轨迹", version: "v1.2", tier: "literature", risk: "low",
    useCeiling: "design_support", scope: "HbA1c 7.5–10.5% · 52 周 · BMI 25–40", sources: "来源 9 项试验",
  },
  headline: "按文献模型推演 52 周：试验情景 HbA1c 平均 −1.4%，对照情景 −0.3%。",
  trajectories: {
    yLabel: "HbA1c 较基线变化（%）",
    ticks: ["基线", "26 周", "52 周"],
    series: [
      {
        key: "treatment", label: "试验情景", source: "predicted", ours: true, bandKind: "prediction",
        endLabel: "试验 −1.4%",
        points: [{ x: 0, y: 0, low: 0, high: 0 }, { x: 26, y: -1.3, low: -2.1, high: -0.5 }, { x: 52, y: -1.4, low: -2.3, high: -0.5 }],
      },
      {
        key: "control", label: "对照情景", source: "predicted", endLabel: "对照 −0.3%",
        points: [{ x: 0, y: 0, low: 0, high: 0 }, { x: 26, y: -0.5, low: -1.2, high: 0.2 }, { x: 52, y: -0.3, low: -1.1, high: 0.6 }],
      },
    ],
  },
  example: {
    id: "VP-0412", source: "synthetic", origin: "批量合成（人群 v3）· 种子已记录",
    baseline: [{ label: "年龄", value: "56 岁", source: "synthetic" }, { label: "HbA1c", value: "8.6%", source: "synthetic" }],
    inScope: { ok: true, text: "在模型适用范围内（HbA1c、BMI 均在范围内）" },
    note: "同一虚拟患者在两种假设下的推演，个体的两个结局不可能同时被观察到。",
  },
  panels: [
    {
      key: "hypo", title: "52 周低血糖：试验情景略高", kind: "binary", note: "模型预测，非观察",
      rows: [{ label: "对照情景", value: value({ value: 2.4, unit: "%", source: "predicted", interval: { kind: "prediction", low: 1.3, high: 3.9, level: 80 } }) }],
    },
  ],
  sensitivity: { measure: "试验情景 52 周 HbA1c 变化", rows: [{ label: "处理效应", range: "−0.8～−1.4", low: -1.4, high: -0.8 }] },
  counts: counts({ realPatients: 0, generatedRecords: 2000, note: "T0 · 无患者级数据", scope: null }),
  ...input,
});

export const comparator = (input: Partial<VcrComparatorTab> = {}): VcrComparatorTab => ({
  headline: "文献对照有限制地可用：三条重建曲线全部通过质控，合并 12 个月 RMST 5.9 个月。",
  routes: [
    { route: "prognostic_adjustment", state: "not_applicable", reason: "单臂设计无随机数据" },
    { route: "external_control", state: "not_estimable", reason: "缺 3 项数据，见下方清单" },
    { route: "literature_control", state: "limited", reason: "3 条重建曲线 · 7 项汇总", selected: true },
  ],
  curves: [
    {
      key: "s1", label: "研究 1 · 2021", source: "reconstructed",
      points: [{ x: 0, y: 1 }, { x: 6, y: 0.42 }, { x: 12, y: 0.2 }, { x: 24, y: 0.05 }],
      atRisk: [{ x: 0, n: 287 }, { x: 6, n: 99 }, { x: 12, n: 60 }],
    },
    {
      key: "pooled", label: "合并估计", source: "reconstructed", pooled: true,
      points: [{ x: 0, y: 1 }, { x: 6, y: 0.4 }, { x: 12, y: 0.18 }, { x: 24, y: 0.04 }],
    },
  ],
  rmst: { value: value({ value: 5.9, unit: "个月", source: "reconstructed", interval: { kind: "confidence", low: 5.6, high: 6.2, level: 95 } }), tau: 12, label: "τ = 12 个月" },
  median: value({ value: 4.1, unit: "个月", source: "aggregate", interval: { kind: "prediction", low: 3.0, high: 5.6, level: 80 } }),
  qc: [
    { key: "atrisk", label: "各时点风险人数", value: "2 人", threshold: "max(2 人, 5%)", passed: true },
    { key: "events", label: "总事件数", value: "1.8%", threshold: "5%", passed: true },
  ],
  comparability: population().profile,
  gaps: {
    title: "真实外部对照：不可估计",
    needs: "需要 T2 · 完整治疗与纵向结局",
    items: [
      { title: "同期治疗记录", detail: "后续治疗线：合作方只有入组前资料", answers: "换药按治疗策略处理，伴随事件与试验一致" },
      { title: "结局评估频率", detail: "影像随访间隔：常规诊疗无固定间隔", answers: "校正评估时点偏倚" },
      { title: "ECOG 缺失 38%", detail: "关键预后因素，缺失多于可插补的范围", answers: "把 ECOG 纳入熵平衡" },
    ],
    conclusion: "三项补齐后可估计：EV-201 相对多西他赛的 12 个月 RMST 差。",
  },
  counts: counts({ realPatients: 0, generatedRecords: 0, reconstructedPseudoPatients: 801, note: "T0 · 无个体数据", scope: null }),
  verdict: { conclusion: "limited", review: "ai_set", reviewed: false },
  ...input,
});

export const trial = (input: Partial<VcrTrialTab> = {}): VcrTrialTab => ({
  headline: "随机方案 B、C 的成功把握都高于单臂方案 A。",
  ademp: [{ key: "a", label: "目的", text: "在单臂加文献对照和随机对照之间选定 II 期方案" }],
  ademReview: "ai_set",
  designs: study().overview.designs,
  columns: [
    { key: "assurance", label: "成功把握" },
    { key: "duration_months", label: "末例入组中位", unit: "月" },
    { key: "cost", label: "成本", unit: "万元" },
  ],
  footnotes: ["方案 A 的功效按真实 ORR 25% 计。"],
  powerCurve: {
    xLabel: "真实 HR", yLabel: "功效",
    series: [{ key: "b", label: "方案 B", source: "predicted", ours: true, points: [{ x: 0.4, y: 0.99 }, { x: 0.6, y: 0.81 }, { x: 1, y: 0.025 }] }],
    markers: [{ x: 0.6, label: "目标 HR 0.60", kind: "assumed" }],
  },
  decision: { options: [{ id: "d_a", label: "A" }, { id: "d_b", label: "B" }], note: "平台不自动选定方案。" },
  runRecord: [{ key: "check", title: "解析值与仿真值一致（差 0.4 个百分点）", detail: "rpact 解析 · gsDesign 交叉核对", ok: true }],
  counts: counts(),
  ...input,
});

export const matching = (input: Partial<VcrMatchingTab> = {}): VcrMatchingTab => ({
  view: "matching",
  headline: "3,412 人里 57 人全部满足，612 人至少 1 条未知。",
  partner: { name: "某招募机构", candidates: 3412, tier: "T1", snapshotAt: "9月27日" },
  funnel: [
    { key: "candidates", label: VCR_REFERRAL_STATE_LABELS_ZH.candidate, count: 3412 },
    { key: "insufficient", label: "可能符合 · 待补证", count: 612, tone: "attention" },
    { key: "eligible", label: "符合", count: 57, tone: "accent" },
    { key: "ineligible", label: "不符合", count: 2743 },
  ],
  candidates: [
    { id: "P-0192", summary: "男 · 63 岁 · 腺癌 IV 期", site: "中心 01", eligibility: "insufficient_evidence", open: [{ code: "E3", state: "unknown" }] },
  ],
  selected: {
    candidate: { id: "P-0192", summary: "男 · 63 岁 · 腺癌 IV 期", site: "中心 01", eligibility: "insufficient_evidence", open: [{ code: "E3", state: "unknown" }] },
    facts: [{ label: "临床资格", value: "不能判定", tone: "attention" }],
    criteria: [
      { code: "I1", kind: "inclusion", text: "年龄 ≥ 18 岁", state: "satisfied", evidence: { quote: "63 岁", source: "基本信息", at: "2026-08-14" } },
      { code: "E3", kind: "exclusion", text: "活动性脑转移", state: "unknown", evidence: { quote: "头颅 MRI 未见明确转移灶", source: "影像报告", at: "2026-02-10 · 已超过 12 周" }, request: "申请近 4 周头颅 MRI", requestNote: "补上后可重新判定" },
    ],
    verdict: { text: "不能判为符合：排除标准 E3 未知", note: "E5 于 10月6日自动复评" },
    canContact: true,
  },
  gaps: [{ code: "E3", label: "活动性脑转移", detail: "近 4 周头颅 MRI", count: 402 }],
  counts: counts({ realPatients: 3412, generatedRecords: 0, note: null, scope: null }),
  ...input,
});

export const data = (input: Partial<VcrDataTab> = {}): VcrDataTab => ({
  headline: "12 张假设卡，其中 3 条关键假设由 AI 设定。",
  status: [{ label: "证据截至", value: "9月27日" }, { label: "试验先例", value: "23 项" }],
  assumptions: [
    {
      id: "a_pfs", name: "对照组中位 PFS", key: true, version: 3,
      summary: "7 项 · 预测区间 3.0–5.6",
      value: study().overview.metrics[0].value,
      detail: {
        subtitle: "多西他赛单药 · 二线 · 研究者评估（RECIST 1.1）",
        stats: [{ label: "I²", value: "41%" }],
        forest: [
          { id: "s1", label: "NCT09900001", n: 425, value: 4.1, low: 3.6, high: 4.5, weight: 17.2 },
          { id: "pooled", label: "随机效应合并", n: 1898, value: 4.1, low: 3.6, high: 4.6, weight: 100, pooled: true },
          { id: "pred", label: "预测区间", value: 4.1, low: 3.0, high: 5.6, prediction: true },
        ],
        distribution: { family: "对数正态" },
        quote: "多西他赛组中位 PFS 为 4.0 个月（95% CI 3.3–4.2）",
        quoteSource: "某试验 2024，第 6 页，表 2",
        usedBy: [{ id: "pop3", label: "人群 v3", note: "画像对比" }],
        versions: [{ version: 3, at: "9月27日 14:20", text: "新增 CTR20990001（2024，中国人群）", note: "3 项已重算" }],
      },
    },
    {
      id: "a_hr", name: "目标 HR", key: true,
      value: value({ value: 0.6, source: "assumed", review: "ai_set" }),
      summary: "情景假设 · 敏感性范围 0.50–0.75",
    },
  ],
  precedents: [
    { id: "p1", registryId: "CTR20990001", registry: "CDE 登记", population: "中国人群", design: "随机 1:1 · 开放 · III 期", planned: 420, actual: 426, sites: 38, plannedMonths: 20, actualMonths: 22, perSitePerMonth: 0.51, usedFor: "中位 PFS · 入组速度" },
  ],
  precedentSources: "ClinicalTrials.gov 14 · ChiCTR 5 · CDE 登记 4",
  ...input,
});
