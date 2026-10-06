/**
 * What the platform's own evidence programme works on, as data (evidence-flywheel plan §5.1, F01/F02, 2026-10-05).
 *
 * The six official zones, each one's topic definition (the terms its entities are read from, the standing question its
 * agenda researches, the task types the selector may choose for it), and the closed maps the publication standard reads.
 * One module, so that adding a seventh zone or a reporting standard is an edit of this file and of nothing else — the
 * selector, the agenda and the card builder read it and hold no zone name of their own.
 *
 * Hidden knowledge:
 *
 * - **Terms, not keys.** A zone's entity keys are `<kind>:<canonical English name>` and the canonical name is whatever the
 *   frontier glossary says (`frontierGlossary.mjs`), so the keys are not written here: `terms` are tagged through the shared
 *   entity vocabulary when the programme reads its signals. A term the glossary does not know yields no key, and a zone
 *   with no keys has no frontier signal — which is the right answer for 「研究解读」, a zone about method and not about
 *   an entity.
 * - **Three zones are the operator's.** 房颤抗凝, 心肾与慢性肾病 and 研究解读 were imported by an operator
 *   (`scripts/ops/import-evidence-content.mjs`) and keep their own text; the programme only recognises them by title. The three
 *   it adds carry their text here.
 * - **A task type is a choice, not a capability.** The selector names one of a zone's `taskTypes`; which capability runs it is
 *   `autopilotEpisodeCapability`'s table in the domain, and nothing here repeats it.
 *
 * Build to delete: a model that reads the feed and the cards and names the next topics itself needs none of the per-zone terms.
 *
 * @module evidenceProgrammeData
 */

/**
 * @typedef {object} EvidenceProgrammeZone
 * @property {string} key stable key; the selector answers with it
 * @property {string} title the zone's title: how an imported zone is recognised and how a new one is named
 * @property {"imported" | "programme"} origin `imported`: made by an operator and never created here; `programme`: made by `ensureOfficialZones`
 * @property {string} [requestId] the request identity a programme-made zone is created under, so a second run finds the same zone
 * @property {string} [description] shown on the zone (programme-made zones only)
 * @property {string} [background] the zone's scope text (programme-made zones only)
 * @property {{ terms: readonly string[], standingQuestion: string, questionZh: string, taskTypes: readonly string[] }} topic
 *   `terms`: names the entity vocabulary tags into the zone's entity keys; `standingQuestion`: what the zone's agenda is asked, in the
 *   words the run reads; `questionZh`: the same question as a card's reader reads it; `taskTypes`: what the selector may choose for it
 */

/** Task types the programme may choose; each is a member of the domain's `AUTOPILOT_TASK_TYPES`. */
const SYNTHESIS = Object.freeze(["evidence-update", "literature-sentinel"]);
const WITH_SIGNALS = Object.freeze([...SYNTHESIS, "signal-monitoring"]);

/** @type {readonly EvidenceProgrammeZone[]} */
export const EVIDENCE_PROGRAMME_ZONES = Object.freeze([
  {
    key: "af-anticoagulation", title: "房颤抗凝", origin: "imported",
    topic: {
      terms: ["atrial fibrillation", "房颤", "anticoagulation", "apixaban", "rivaroxaban", "edoxaban", "dabigatran", "warfarin", "left atrial appendage occlusion"],
      standingQuestion: "In adults with atrial fibrillation, what do the randomized trials and the guidelines now show about stroke prevention against major bleeding for each oral anticoagulant, and for which populations (non-valvular, mechanical valve, rheumatic mitral stenosis, kidney impairment, the elderly) does the evidence stop?",
      questionZh: "房颤患者用口服抗凝药，各药在预防卒中与大出血上有什么证据，哪些人群的证据到此为止？",
      taskTypes: WITH_SIGNALS,
    },
  },
  {
    key: "cardiorenal-ckd", title: "心肾与慢性肾病", origin: "imported",
    topic: {
      terms: ["chronic kidney disease", "慢性肾病", "dapagliflozin", "empagliflozin", "finerenone", "canagliflozin", "semaglutide", "albuminuria"],
      standingQuestion: "In chronic kidney disease with or without diabetes, what do the primary trials of SGLT2 inhibitors, finerenone and GLP-1 receptor agonists show for kidney, cardiovascular and mortality outcomes, with the eligibility, eGFR and albuminuria strata each result applies to?",
      questionZh: "慢性肾病患者用 SGLT2 抑制剂、非奈利酮和 GLP-1 受体激动剂，肾脏、心血管和死亡结局有什么证据，各自适用于哪些入组条件和肾功能分层？",
      taskTypes: WITH_SIGNALS,
    },
  },
  {
    key: "research-interpretation", title: "研究解读", origin: "imported",
    topic: {
      terms: [],
      standingQuestion: "Which recently published randomized trials or meta-analyses are most often misread (relative against absolute effects, composite endpoints, non-inferiority margins, subgroup claims), and what does each one's own report support?",
      questionZh: "近期发表的随机对照试验和荟萃分析里，哪些最容易被误读（相对与绝对效应、复合终点、非劣效界值、亚组结论），它们的原文实际支持什么？",
      taskTypes: SYNTHESIS,
    },
  },
  {
    key: "nsclc", title: "非小细胞肺癌", origin: "programme", requestId: "evimed-evidence-zone-20261005-nsclc",
    description: "从原始试验判断非小细胞肺癌各类治疗的生存获益、毒性与适用分子分型。",
    background: "聚焦非小细胞肺癌的系统治疗证据：靶向治疗（EGFR、ALK 等驱动基因）、免疫检查点抑制剂、化疗联合方案和围手术期治疗。每条结论保留研究人群、分子分型、对照和终点定义，生存数据以原始试验报告为准。",
    topic: {
      terms: ["non-small cell lung cancer", "非小细胞肺癌", "osimertinib", "pembrolizumab", "durvalumab", "atezolizumab", "EGFR", "ALK", "immune checkpoint inhibitor"],
      standingQuestion: "In non-small cell lung cancer, what do the primary phase 3 trials and current guidelines show for overall survival, progression-free survival and toxicity of targeted therapy, immune checkpoint inhibitors and perioperative regimens, by driver mutation and PD-L1 stratum?",
      questionZh: "非小细胞肺癌的靶向治疗、免疫治疗和围手术期方案，按驱动基因和 PD-L1 分层，在总生存、无进展生存和毒性上有什么证据？",
      taskTypes: WITH_SIGNALS,
    },
  },
  {
    key: "breast-cancer", title: "乳腺癌", origin: "programme", requestId: "evimed-evidence-zone-20261005-breast-cancer",
    description: "从原始试验判断乳腺癌各亚型治疗的获益、毒性与适用人群。",
    background: "聚焦乳腺癌按亚型（激素受体阳性、HER2 阳性、三阴性）区分的系统治疗证据：内分泌联合 CDK4/6 抑制剂、抗 HER2 治疗（含抗体偶联药物）、免疫治疗和辅助强化方案。每条结论保留亚型、分期、对照和终点定义。",
    topic: {
      terms: ["breast cancer", "乳腺癌", "trastuzumab deruxtecan", "palbociclib", "ribociclib", "abemaciclib", "pertuzumab", "triple-negative breast cancer", "HER2"],
      standingQuestion: "In breast cancer, what do the primary phase 3 trials and current guidelines show for survival, recurrence and toxicity of endocrine therapy with CDK4/6 inhibitors, anti-HER2 therapy including antibody-drug conjugates, and immunotherapy, by subtype and stage?",
      questionZh: "乳腺癌按亚型和分期，内分泌联合 CDK4/6 抑制剂、抗 HER2 治疗和免疫治疗在生存、复发和毒性上有什么证据？",
      taskTypes: WITH_SIGNALS,
    },
  },
  {
    key: "type2-diabetes", title: "2 型糖尿病", origin: "programme", requestId: "evimed-evidence-zone-20261005-type2-diabetes",
    description: "从原始试验判断 2 型糖尿病各类降糖药的血糖、心肾结局与安全性证据。",
    background: "聚焦 2 型糖尿病药物治疗的证据：二甲双胍、SGLT2 抑制剂、GLP-1 受体激动剂、GIP/GLP-1 双受体激动剂和胰岛素。区分降糖幅度与心血管、肾脏结局，每条结论保留入组人群、基线风险和随访时间。",
    topic: {
      terms: ["type 2 diabetes", "2 型糖尿病", "metformin", "semaglutide", "tirzepatide", "empagliflozin", "dapagliflozin", "insulin", "HbA1c"],
      standingQuestion: "In type 2 diabetes, what do the primary trials and current guidelines show for glycaemic control, cardiovascular and kidney outcomes, weight and safety of metformin, SGLT2 inhibitors, GLP-1 receptor agonists, tirzepatide and insulin, by baseline cardiovascular and kidney risk?",
      questionZh: "2 型糖尿病的各类降糖药，按基线心血管和肾脏风险，在血糖、心肾结局、体重和安全性上有什么证据？",
      taskTypes: WITH_SIGNALS,
    },
  },
]);

/** @param {string} key @returns {EvidenceProgrammeZone | undefined} */
export const programmeZoneByKey = (key) => EVIDENCE_PROGRAMME_ZONES.find((zone) => zone.key === key);

/** What a card of each task type is called, so that a re-run of the same topic finds the same card (the title is the reader's). */
export const PROGRAMME_CARD_TITLES = Object.freeze({
  "evidence-update": "证据综合",
  "literature-sentinel": "新证据速览",
  "signal-monitoring": "安全信号",
});

/**
 * The specialist engines whose analyses of public data are the platform's own first-hand work (`original_analysis`), keyed by the
 * capability that runs them. The reporting standard each is written to is the domain's closed map (`evidenceReportingStandard`:
 * STROBE-MR for Mendelian randomisation, READUS-PV for pharmacovigilance signals, plan §5.1). Closed: a capability not named here
 * makes a synthesis, never an original analysis. An episode of one of them becomes an original-analysis card only when its run
 * left engine receipts (a result version with a method record and machine values); without one it is read as before, through its
 * evidence matrix, and is a synthesis.
 * @type {Readonly<Record<string, { engine: string }>>}
 */
export const ORIGINAL_ANALYSIS_ENGINES = Object.freeze({
  "adr-analysis": Object.freeze({ engine: "drug_safety_analysis" }),
  "mendelian-randomization": Object.freeze({ engine: "mendelian_randomization" }),
});

/**
 * The number of independent datasets in which an analysis holds, the one it was run on included: a machine value of this key
 * (`ResultVersion.machineValues` is `{ key, value, unit }`) in any receipt of the run. An analysis is titled a 「发现」 only when it is
 * at least `REPLICATION_MIN_INDEPENDENT_DATASETS` — the analysed dataset and a second, independent one (plan §5.1). No engine
 * writes it yet, so every original analysis is, today, 「信号，待验证」 — the honest label for a signal nobody has replicated.
 */
export const REPLICATION_MACHINE_VALUE_KEY = "replication.independent_dataset_count";
export const REPLICATION_MIN_INDEPENDENT_DATASETS = 2;

/**
 * What a receipt says about multiple comparisons, as two machine values: how many hypotheses the analysis tested, and whether it
 * corrected for them (1) or not (0). A receipt that tested more than one and says it corrected states the correction; one that
 * tested more than one and does not say, or does not report either, makes the card say 「未报告多重比较校正」 and call itself a
 * signal. No engine writes them yet (the drug-safety replay lists its unadjusted tables as a diagnostic only).
 */
export const MULTIPLICITY_MACHINE_VALUE_KEYS = Object.freeze({ tested: "multiplicity.tested_hypotheses", corrected: "multiplicity.correction_applied" });

/** What an original analysis is called in its title and answer, and what it says when no correction is reported. */
export const ORIGINAL_ANALYSIS_LABELS = Object.freeze({ replicated: "发现", unreplicated: "信号，待验证", multiplicityNotReported: "未报告多重比较校正" });

/**
 * The sentences an original analysis states from a receipt, by the method that produced it: each a template over the
 * receipt's machine-value paths in the report-number renderer's grammar (`{{n:<path>|<format>}}`), so every number in the
 * card is rendered from the receipt and none is typed (principle 10c). A headline whose paths the receipt does not hold is
 * left out and counted; the card keeps the rest. The paths are the engine's own (`deterministic_replay.py`'s `values[0].…`).
 * Build to delete: a receipt that names its own headline measures needs none of this table.
 * @type {Readonly<Record<string, readonly { id: string, template: string }[]>>}
 */
export const ORIGINAL_ANALYSIS_HEADLINES = Object.freeze({
  "faers.signals": Object.freeze([
    Object.freeze({ id: "ror", template: "该药物与该不良事件的报告比值比（ROR）为 {{n:values[0].ror.value|f2}}，置信区间下限 {{n:values[0].ror.ci95_lower|f2}}、上限 {{n:values[0].ror.ci95_upper|f2}}。" }),
    Object.freeze({ id: "reports", template: "同时报告了该药物与该不良事件的病例报告有 {{n:values[0].table.a|thousands}} 份。" }),
  ]),
});

/** How many days of the feed the topic selector reads, and the day's hour (feed time zone) its decision is made. */
export const PROGRAMME_FRONTIER_WINDOW_DAYS = 7;
export const PROGRAMME_DECISION_HOUR = 8;
/** What one deep episode costs in a day's budget, from the 2026-10-04 measurement (about CNY 7). */
export const PROGRAMME_EPISODE_ESTIMATE_CNY = 7;
/** The most episodes one day's decision starts, whatever the budget would buy. */
export const PROGRAMME_MAX_ACTIONS_PER_DAY = 3;
/** The profile phrases whose entities count as demand: what a reader asked or works on, never what the feed itself showed them. */
export const PROGRAMME_DEMAND_PHRASE_SOURCES = Object.freeze(["question", "memory"]);
/** Profiles read for one day's demand count, a bound and not a sample: past it the counts are lower bounds, and say so. */
export const PROGRAMME_DEMAND_MAX_PROFILES = 5_000;
/** How long an unsettled episode may keep the programme's one slot before it stops counting as active. */
export const PROGRAMME_ACTIVE_EPISODE_MS = 6 * 3_600_000;
/** Decisions of this many days are looked at again for episodes not settled and actions deferred. */
export const PROGRAMME_SETTLE_DAYS = 14;
