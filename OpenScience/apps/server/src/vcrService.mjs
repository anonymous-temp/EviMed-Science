/**
 * What 「虚拟临研」's pages are served (build contract 2026-09-28 §3.1), the
 * module's switch, readiness and metrics, and the first-version catalogue of
 * models and methods (plan §8.2).
 *
 * Hidden knowledge:
 *
 * - **Numbers are read, never computed here.** Every count, estimate and
 *   interval on a page is a field of a `results` row an execution wrote, with
 *   its own counts, conclusion and Monte-Carlo error. A page that computed a
 *   number would be a second implementation of the method, and the page and
 *   the study package would then be able to disagree about it.
 * - **Ownership is the study lookup.** Every method resolves the study for the
 *   account first (`requireStudy` → owner or member) and answers 404
 *   `vcr_study_not_found` for anything else: another account's study reads
 *   exactly like one that never existed.
 * - **Off is invisible** (`vcrAudienceAllows`): the module off, or on for
 *   operators and the preview list only while this account is neither, reads
 *   as a module that does not exist — every route answers 404
 *   `vcr_not_enabled` and the runtime is given no tools.
 * - **The four packages that are not mine are injected** (`attach`): the data
 *   plane and access (A), the evidence side (C) and matching (E). Each is read
 *   at request time, so a package composed after the service attaches to the
 *   same object; each missing one answers a named 「暂不可用」 in its own tab
 *   and nothing else in the study is held up (plan §10.5).
 * - **The model catalogue is seeded, not assumed** (`seedVcrCatalogue`): the
 *   method rows come from the domain's `VCR_ENGINE_METHODS`, which is the same
 *   list the engine validates against, and the three mathematical reference
 *   simulators are written as `scenario`-tier models so 「模型与方法库」 has
 *   something true in it on the first day. When the engine is reachable its
 *   `/health` method list is compared against the catalogue and a mismatch is
 *   shown as a notice — never a block (principle 4).
 *
 * @module vcrService
 */

import { VCR_PRIVATE_MATCHING_PROVENANCE_KEYS } from './vcrMatching.mjs';
import { loadMethodValidation, validatedMethods } from './vcrMethodValidation.mjs';
import {
  VCR_COMPARATOR_ROUTES, VCR_COUNT_KEYS, VCR_DATA_TIERS, VCR_DATA_TIER_LABELS_ZH, VCR_ENGINE_METHODS, VCR_MIN_CELL_SIZE, VCR_MODEL_INTERFACES, VCR_ROUTE_MIN_TIER,
  VCR_SCENARIO_SCHEMAS, VCR_STEPS, VCR_STEP_CAPABILITIES, VCR_TABS, reviewStateFor, roleAllows, suppressForModel, twinLabel, vcrAssessmentIssues,
  vcrModelCardIssues, vcrModelInterfaceOf, vcrTierIsSupported, vcrTierNeedsSupport, vcrTierOffer, whenHolds,
} from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_DEFAULT_STUDY_NAME, vcrObjectNode } from "./vcrStore.mjs";
import { vcrSealState } from "./vcrSeal.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import {
  presentExport, presentModels, presentPrecedents, presentReviewNotes, presentStudy, presentSummary, presentTodos, resultNode, useCeilingOf,
  vcrCurrentNodes, vcrReviewIsCurrent,
} from "./vcrViews.mjs";
import {
  presentComparatorTab, presentDataTab, presentMatchingTab, presentPatientsTab, presentPopulationTab, presentTrialTab,
} from "./vcrViewsTabs.mjs";
import { numeric, withReviewState } from "./vcrViewsKit.mjs";
import { vcrReportModel } from "./vcrRender.mjs";
import { buildModelAnalysis, isModelDocumentKind, readModelAnalysisInputs } from "./vcrModelDocuments.mjs";

export { VCR_DEFAULT_STUDY_NAME };

/** Items one runtime read returns at most. */
export const VCR_READ_MAX_ITEMS = 50;

/** What a runtime read may ask for. Closed; the MCP tool's schema copies it. */
export const VCR_READ_WHATS = Object.freeze([
  "study", "definition", "criteria", "assumptions", "evidence", "population", "patients", "comparator", "trial",
  "precedents", "matching", "subject_document", "results", "report_model", "snapshot_profile", "models", "jobs",
  "trial_registry_record", "pack", "library", "model_assessments",
]);

/**
 * What a runtime write may write. Definitions, conditions, assumptions,
 * designs, decisions, evidence values, patient facts and report text — never a
 * result number, a count or an execution record (build contract §3.2). Those
 * come from the engine, and a model that could write them could write anything.
 * Referrals are not here: the control plane makes them from assessments.
 */
/**
 * What a run is never told: where a file lives in the data plane or the engine's
 * work volume, and the hashes of the inputs a job opened. A run names data by
 * snapshot and result ids; a location or an input hash in its hands is an
 * address to guess at and an oracle to confirm a guess (merge verification,
 * 2026-09-29). Removed by key at any depth before the small-cell boundary.
 * @param {unknown} value @param {Set<unknown>} [ancestors]
 * @returns {unknown}
 */
export function stripPlaneAddresses(value, ancestors = new Set()) {
  if (!value || typeof value !== "object") return value;
  // A value two branches share is data twice; only a value that contains itself is a cycle, and a
  // boundary that cannot finish a payload refuses it whole.
  if (ancestors.has(value)) throw new TypeError("stripPlaneAddresses: the payload refers to itself");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => stripPlaneAddresses(item, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "location" || key === "inputHashes" || key === "outputHash" || key === "signature" || VCR_PRIVATE_MATCHING_PROVENANCE_KEYS.includes(key)) continue;
      out[key] = stripPlaneAddresses(item, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * The reads whose figures are another trial's, published: an extracted value
 * and its sample size, a registry record's enrollment, its arms and its site
 * count. They are not this study's people, so the small-cell floor has nothing
 * to protect in them — and applied to them it hollowed every row that had a
 * `sampleSize` beside an unknown `events` and read a registry's site count as a
 * head count (merge verification C2-2). Named here, by `what`, rather than
 * recognised by shape: a shape rule is the thing that let the first boundary
 * pass what nothing produced.
 */
export const VCR_PUBLISHED_FIGURE_READS = Object.freeze(["evidence", "precedents", "trial_registry_record"]);

export const VCR_WRITE_WHATS = Object.freeze([
  "definition", "protocol", "criteria", "assumption", "evidence_item", "precedent", "population", "patient_set",
  "comparator", "trial_scenario", "design_grid", "decision", "report", "model", "forecast", "step", "plan",
  "fact", "language_judgment", "site", "followup", "field_map", "pack", "model_assessment",
]);

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {number} status @param {string} code @param {string} message */
const failure = (status, code, message) => new HttpError(status, code, message);

/**
 * The query a route was asked with, as plain strings: a `URLSearchParams`
 * (what the route hands over) or an object (what a test does).
 * @param {URLSearchParams | Record<string, any> | null | undefined} query
 * @returns {Record<string, string>}
 */
function queryOf(query) {
  /** @type {Record<string, string>} */
  const asked = {};
  const entries = query instanceof URLSearchParams ? [...query] : Object.entries(query ?? {});
  for (const [key, value] of entries.slice(0, 20)) if (value != null) asked[String(key)] = String(value);
  return asked;
}

/**
 * Whether this account sees the module at all: on, and either open to every
 * account or this one an operator or on the preview list. The default
 * audience is `operators`.
 * @param {Record<string, any>} config @param {{ id?: string } | null | undefined} user
 */
export function vcrAudienceAllows(config, user) {
  if (!config?.vcrEnabled) return false;
  if (config.vcrAudience === "all") return true;
  const id = String(user?.id ?? "");
  return Boolean(id) && ((config.operatorUsers ?? []).includes(id) || (config.vcrPreviewUsers ?? []).includes(id));
}

/**
 * What a reference simulator's scenario takes, in the reader's words, each
 * beside the scenario keys it stands for. A card's 「输入」 is this table read
 * through the domain's schema for the simulator's own method
 * ({@link vcrReferenceModelInputs}), so a card cannot offer an input its
 * endpoint's schema refuses. The three lists were typed by hand, and two of
 * them said 「脱落率」 and 「入组节奏」 for simulators that have no follow-up:
 * a run that followed the binary card wrote `accrual`, was refused for a field
 * the engine does not read, and spent a whole retry (pilot acceptance,
 * 2026-10-03). The same lists offered a risk ratio and an acceleration factor
 * no schema has.
 */
export const VCR_REFERENCE_INPUTS = Object.freeze([
  Object.freeze({ label: "两组人数", keys: Object.freeze(["design.nTreat", "design.nControl"]) }),
  Object.freeze({ label: "处理效应（均值差）", keys: Object.freeze(["truth.effect"]) }),
  Object.freeze({ label: "结局的标准差", keys: Object.freeze(["truth.sd"]) }),
  Object.freeze({ label: "与基线测量的相关", keys: Object.freeze(["truth.baselineCorrelation"]) }),
  Object.freeze({ label: "对照组事件率", keys: Object.freeze(["truth.controlRate"]) }),
  Object.freeze({ label: "处理效应（试验组事件率、风险差或比值比，三选一）",
    keys: Object.freeze(["truth.treatmentRate", "truth.riskDifference", "truth.oddsRatio"]) }),
  Object.freeze({ label: "风险比", keys: Object.freeze(["truth.hazardRatio"]) }),
  Object.freeze({ label: "对照组生存分布（中位时间，或指数、Weibull、分段指数）",
    keys: Object.freeze(["truth.controlMedian", "truth.controlDistribution"]) }),
  Object.freeze({ label: "协变量效应", keys: Object.freeze(["truth.covariateEffects", "truth.covariateLogit"]) }),
  Object.freeze({ label: "入组节奏", keys: Object.freeze(["accrual.kind", "accrual.duration", "accrual.breaks", "accrual.rates", "accrual.tail"]) }),
  Object.freeze({ label: "随访时长", keys: Object.freeze(["accrual.followup", "accrual.maxFollowup"]) }),
  Object.freeze({ label: "脱落率（每 12 个时间单位）", keys: Object.freeze(["accrual.dropoutAnnual"]) }),
]);

/**
 * The scenario keys, two levels deep (`truth.controlRate`, `accrual.followup`),
 * the engine's schema reads for one endpoint family's patient generator — the
 * `when` gates applied as the validators apply them. The endpoint's own type is
 * the simulator's identity, not something a reader supplies.
 * @param {string} endpointType one of the domain's endpoint types
 * @returns {readonly string[]}
 */
export function vcrPatientScenarioKeys(endpointType) {
  const schema = /** @type {Record<string, any>} */ (VCR_SCENARIO_SCHEMAS)[`patients.${endpointType}`];
  const root = { endpoint: { type: endpointType } };
  /** @type {string[]} */
  const keys = [];
  for (const [top, field] of Object.entries(/** @type {Record<string, any>} */ (schema?.fields ?? {}))) {
    if (top === "endpoint" || !whenHolds(field.when, root)) continue;
    // A variant's keys are its discriminator and every key any of its variants takes.
    const inner = field.t === "variant" ? { [field.on]: {}, ...Object.assign({}, ...Object.values(field.variants)) } : field.fields ?? {};
    for (const [key, entry] of Object.entries(/** @type {Record<string, any>} */ (inner))) {
      if (whenHolds(entry.when, root)) keys.push(`${top}.${key}`);
    }
  }
  return Object.freeze(keys);
}

/** A reference simulator's 「输入」: the rows of the table its endpoint's schema reads at least one key of. @param {string} endpointType */
export function vcrReferenceModelInputs(endpointType) {
  const read = new Set(vcrPatientScenarioKeys(endpointType));
  return Object.freeze(VCR_REFERENCE_INPUTS.filter((input) => input.keys.some((key) => read.has(key))).map((input) => input.label));
}

/**
 * The three mathematical reference simulators the first catalogue ships
 * (plan §8.2). Scenario-tier by construction: they answer 「在这些假设下会
 * 怎样」 and carry no claim about any real population, which is why their
 * applicability says so in words rather than naming an indication.
 */
export const VCR_REFERENCE_MODELS = Object.freeze([
  Object.freeze({
    name: "reference-continuous", version: "1.0.0", tier: "scenario", risk: "none", endpointType: "continuous",
    card: Object.freeze({
      title: "连续终点参考仿真器",
      type: "mathematical_simulation",
      provider: "EviMed 虚拟临研",
      interface: "vcr-engine patients.continuous",
      inputs: vcrReferenceModelInputs("continuous"),
      outputs: "按给定分布生成的连续终点观测值；输出的是情景推演，不是对任何真实人群的预测。",
      missingData: "输入缺项不插补：缺哪一项就报哪一项，不用默认值顶替。",
      knownLimits: Object.freeze(["不含任何真实人群的协变量结构", "不可用于个体层面的预测", "不承载疗效或安全性证据"]),
      retirement: "当引擎的 patients.continuous 方法版本变更时退役并重新发布。",
    }),
    applicability: Object.freeze({ population: "不限，但只作情景推演", region: "不限", endpoints: Object.freeze(["continuous"]) }),
    validation: Object.freeze({ codeVerification: "对照解析解", seedReproducible: true }),
    evidence: Object.freeze(["code_verification", "seed_reproducible"]),
  }),
  Object.freeze({
    name: "reference-binary", version: "1.0.0", tier: "scenario", risk: "none", endpointType: "binary",
    card: Object.freeze({
      title: "二分类终点参考仿真器",
      type: "mathematical_simulation",
      provider: "EviMed 虚拟临研",
      interface: "vcr-engine patients.binary",
      inputs: vcrReferenceModelInputs("binary"),
      outputs: "按给定事件率生成的二分类观测值；输出的是情景推演，不是对任何真实人群的预测。",
      missingData: "输入缺项不插补：缺哪一项就报哪一项，不用默认值顶替。",
      knownLimits: Object.freeze(["不含任何真实人群的协变量结构", "不可用于个体层面的预测", "不承载疗效或安全性证据"]),
      retirement: "当引擎的 patients.binary 方法版本变更时退役并重新发布。",
    }),
    applicability: Object.freeze({ population: "不限，但只作情景推演", region: "不限", endpoints: Object.freeze(["binary"]) }),
    validation: Object.freeze({ codeVerification: "对照精确二项解", seedReproducible: true }),
    evidence: Object.freeze(["code_verification", "seed_reproducible"]),
  }),
  Object.freeze({
    name: "reference-time-to-event", version: "1.0.0", tier: "scenario", risk: "none", endpointType: "time_to_event",
    card: Object.freeze({
      title: "事件时间终点参考仿真器",
      type: "mathematical_simulation",
      provider: "EviMed 虚拟临研",
      interface: "vcr-engine patients.time_to_event",
      inputs: vcrReferenceModelInputs("time_to_event"),
      outputs: "按给定风险函数生成的事件时间与删失指示；生成的曲线不得画成观察到的 KM 曲线。",
      missingData: "输入缺项不插补：缺哪一项就报哪一项，不用默认值顶替。",
      knownLimits: Object.freeze(["默认比例风险，非比例情景须显式设定", "不含任何真实人群的协变量结构", "不承载疗效或安全性证据"]),
      retirement: "当引擎的 patients.time_to_event 方法版本变更时退役并重新发布。",
    }),
    applicability: Object.freeze({ population: "不限，但只作情景推演", region: "不限", endpoints: Object.freeze(["time_to_event"]) }),
    validation: Object.freeze({ codeVerification: "对照 simsurv 的已知真值", seedReproducible: true }),
    evidence: Object.freeze(["code_verification", "seed_reproducible"]),
  }),
]);

/**
 * Write the first-version catalogue. Idempotent by the schema's own unique
 * keys, so composing the module twice — or two control planes starting
 * together — writes it once.
 *
 * @param {{ store: import("./vcrStore.mjs").VcrStore, engine?: any, methodValidationFile?: string, report?: (code: string) => void }} dependencies
 * @returns {Promise<{ methods: number, models: number, engineMismatch: readonly string[] | null }>}
 */
export async function seedVcrCatalogue({ store, engine = null, methodValidationFile = '', report = () => {} }) {
  await store.ready();
  let methods = 0;
  for (const [method, entry] of Object.entries(VCR_ENGINE_METHODS)) {
    await store.saveMethod({
      method, version: entry.version, endpoints: [...entry.endpoints], crossChecks: [...entry.crossChecks],
    });
    methods += 1;
  }
  let models = 0;
  for (const model of VCR_REFERENCE_MODELS) {
    await store.saveModel({ ...model, evidence: [...model.evidence] });
    models += 1;
  }
  /** @type {readonly string[] | null} */
  let engineMismatch = null;
  if (engine?.configured?.()) {
    try {
      const health = await engine.health();
      const published = new Set(list(health.methods).map(String));
      const catalogue = Object.keys(VCR_ENGINE_METHODS);
      const missing = catalogue.filter((method) => !published.has(method));
      const extra = [...published].filter((method) => !catalogue.includes(method));
      engineMismatch = missing.length || extra.length
        ? Object.freeze([...missing.map((method) => `目录有引擎没有：${method}`), ...extra.map((method) => `引擎有目录没有：${method}`)])
        : Object.freeze([]);
    } catch (error) {
      report(typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "vcr_engine_unreachable");
    }
  }
  const validation = await loadMethodValidation({ file: methodValidationFile, engine, report });
  if (validation.status === 'verified') {
    for (const method of validatedMethods(validation.artifact.methods, validation)) {
      const entry = VCR_ENGINE_METHODS[method.method];
      await store.saveMethod({ method: method.method, version: method.version, endpoints: [...entry.endpoints], crossChecks: [...entry.crossChecks],
        assumptions: method.assumptions, numericTests: method.numericTests });
    }
  }
  return { methods, models, engineMismatch };
}

/** Which step each of the home page's four action cards asks for (plan §9.2). */
export const VCR_ACTION_STEPS = Object.freeze({
  cohort: "population", patients: "patients", comparator: "comparator", trial: "trial",
});

/**
 * The steps a new study is asked for. A named action card asks for its own
 * step and lets the programme fill the upstream minimally; anything else asks
 * for all seven.
 * @param {string | undefined | null} action
 */
export function vcrRequestedSteps(action) {
  const step = /** @type {Record<string, string>} */ (VCR_ACTION_STEPS)[String(action ?? "")];
  return step ? Object.freeze([step]) : VCR_STEPS;
}

/** The four counts, read apart, never folded (plan §3.5). @param {Record<string, any>} counts */
export function vcrCountBand(counts) {
  const row = object(counts);
  /** @type {Record<string, number | null>} */
  const band = {};
  for (const key of VCR_COUNT_KEYS) band[key] = row[key] == null ? null : Number(row[key]);
  for (const key of ["priorEffectiveSampleSize", "reconstructedPseudoPatients"]) {
    if (row[key] != null) band[key] = Number(row[key]);
  }
  return band;
}

/**
 * Which comparator routes this study's data tier can reach at all, and what
 * each one would need. Deterministic (§5.3's table), so the page never asks a
 * model which routes exist.
 * @param {string} dataTier
 */
export function vcrRouteOptions(dataTier) {
  const order = VCR_DATA_TIERS.indexOf(String(dataTier));
  return VCR_COMPARATOR_ROUTES.map((route) => {
    const minimum = /** @type {Record<string, string>} */ (VCR_ROUTE_MIN_TIER)[route];
    const needed = VCR_DATA_TIERS.indexOf(minimum);
    // A route this version has no engine method for is not offered at any tier: it is listed as unsupported (`supported: false`),
    // and a comparator written for it is refused by name rather than recorded as a verdict about a route nobody could take.
    const supported = !VCR_UNSUPPORTED_COMPARATOR_ROUTES.includes(route);
    return { route, minimumTier: minimum, supported, available: supported && order >= 0 && needed >= 0 && order >= needed };
  });
}

/** The comparator routes this version cannot compute: the model-prediction comparator (the engine's simulators give set values, not predictions for a population). */
export const VCR_UNSUPPORTED_COMPARATOR_ROUTES = Object.freeze(["model_comparator"]);

/**
 * The accounts the matching page names: whoever countersigned the assessment on
 * show, and whoever moved the referral. The platform's own hand is not an account.
 * @param {any} match
 */
function matchingPeopleOf(match) {
  return [match?.selected?.reviewedBy, ...list(match?.referralEvents).map((event) => object(event).actor)].filter(Boolean);
}

/**
 * The accounts the data page names: whoever confirmed a source's field map, and
 * each account a source is granted to (a role or the whole study is not one).
 * @param {any} dataPlane
 */
function dataPeopleOf(dataPlane) {
  return list(dataPlane?.sources).flatMap((source) => [
    object(source.fieldMap).confirmedBy,
    ...list(source.grants).map((grant) => object(grant).grantee).filter((grantee) => typeof grantee === "string" && !/^(role|study):/.test(grantee)),
  ]).filter(Boolean);
}

export class VcrService {
  /**
   * @param {{ store: import("./vcrStore.mjs").VcrStore, config: Record<string, any>, engine?: any, now?: () => Date,
   *   metricName?: ((id: string) => string | null) | null,
   *   access?: any, dataPlane?: any, evidence?: any, matching?: any, jobs?: any, seal?: any,
   *   matchStore?: any, evidenceStore?: any, documents?: any, knowledge?: any }} options
   */
  constructor({ store, config, engine = null, now = () => new Date(), metricName = null,
    access = null, dataPlane = null, evidence = null, matching = null, jobs = null, seal = null,
    matchStore = null, evidenceStore = null, documents = null, knowledge = null }) {
    if (!store || !config) throw new TypeError("The VCR service needs its store and the config.");
    this.store = store;
    this.config = config;
    this.engine = engine;
    this.now = now;
    this.metricName = metricName;
    /**
     * The packages that are not this one's, read at request time. `matchStore`
     * and `evidenceStore` are the matching and evidence packages' own stores:
     * the pages read rows from them directly, because the seams above them
     * (`matching.tab`, `evidence.tab`) answer for the runtime and the deliverable,
     * not for a page.
     */
    this.packages = { access, dataPlane, evidence, matching, jobs, seal, matchStore, evidenceStore, documents, knowledge, frontierEvents: null, platformPacks: null, predictions: null, engineProbe: null, records: null };
    this.counters = { studiesCreated: 0, reads: 0, writes: 0, writeIssues: 0, notFound: 0, tabs: 0 };
    /** @type {readonly string[] | null} set by `seedVcrCatalogue` at composition */
    this.engineMismatch = null;
  }

  /** Attach a package composed after the service (the GEO hook pattern). @param {Record<string, any>} packages */
  attach(packages) {
    for (const [name, value] of Object.entries(packages ?? {})) {
      if (value != null) this.packages[/** @type {keyof typeof this.packages} */ (name)] = value;
    }
    return this;
  }

  ready() { return this.store.ready(); }

  /**
   * What a study's conversation is checked against (`vcrReplyCheck.mjs`): every result the engine wrote for it — superseded ones too, a
   * reply may restate a number that has since been recomputed and was true when it was said — and what the study was set to
   * (the assumption cards and the objects' own settings), and what each job ran. The study is the one whose conversation this project is.
   * @param {{ userId: string, projectId: string }} identity
   * @returns {Promise<{ studyId: string, results: any[], inputs: any[], executions: any[] } | null>}
   */
  async replyCheckFacts({ userId, projectId }) {
    const study = await this.store.studyByControlProject(String(userId), String(projectId));
    if (!study) return null;
    const [results, assumptions, scenarios, populations, patientSets, comparators, grid, executions] = await Promise.all([
      this.store.allResults(study.id), this.store.assumptions(study.id), this.store.trialScenarios(study.id, 100), this.store.populations(study.id, 50),
      this.store.patientSets(study.id, 50), this.store.comparatorDesigns(study.id, 50), this.store.latestDesignGrid(study.id), this.#executions(study.id),
    ]);
    return {
      studyId: study.id, results,
      inputs: [
        assumptions.map((card) => ({ point: card.pointValue, distribution: card.distribution, sensitivity: card.sensitivity, pooling: card.pooling })),
        scenarios.map((row) => row.configuration), populations.map((row) => row.definition), patientSets.map((row) => row.scenario),
        comparators.map((row) => row.configuration), grid ? [grid.dimensions, grid.truthScenarios] : [],
      ],
      executions: [...executions.values()],
    };
  }

  /**
   * What a page says about the statistics engine, from the one reading readiness reports (`vcrEngineProbe.mjs`): `missing` (no engine
   * is composed here), `wired` (composed, nobody has asked it yet), `answering`, `not_answering`. `available` is false for the first and
   * the last — the computations that need it wait or say so — and a study page puts one line at its top instead of letting the first
   * failed job say it in small print.
   * @returns {{ state: "missing" | "wired" | "answering" | "not_answering", available: boolean }}
   */
  engineStatus() {
    const composed = Boolean(this.engine?.configured?.());
    const reading = composed ? this.packages.engineProbe?.snapshot?.() ?? null : null;
    const state = !composed ? "missing" : reading?.state === "answering" ? "answering" : reading?.state === "not_answering" ? "not_answering" : "wired";
    return { state, available: composed && state !== "not_answering" };
  }

  /** @param {{ id?: string }} user */
  allows(user) { return vcrAudienceAllows(this.config, user); }

  /** @param {{ id?: string }} user */
  isOperator(user) { return (this.config.operatorUsers ?? []).includes(String(user?.id ?? "")); }

  /** The account's study, or 404. @param {{ id: string }} user @param {string} id */
  async requireStudy(user, id) {
    const study = await this.store.getStudy(String(user.id), id);
    if (!study) {
      this.counters.notFound += 1;
      throw failure(404, "vcr_study_not_found", "Study not found.");
    }
    return study;
  }

  // --- the home list --------------------------------------------------------------

  /**
   * `GET /api/vcr/studies`: the home list, in the browser's own shape
   * (`VcrHome`). 招募待办 is present only for an account that may contact
   * patients in at least one study; the routes check each write for themselves,
   * so this is presentation.
   * @param {{ id: string }} user
   */
  async listStudies(user) {
    const now = this.now();
    const studies = await this.store.listStudies(String(user.id));
    const groups = await Promise.all(studies.map(async (study) => {
      const [results, allResults, stale, jobs, assumptions, scenarios, comparators, reviews, roles, grid, decisions, exports] = await Promise.all([
        this.store.results(study.id),
        this.store.allResults(study.id),
        this.store.staleMarks(study.id),
        this.store.jobs(study.id, 20),
        this.store.assumptions(study.id),
        this.store.trialScenarios(study.id, 60),
        this.store.comparatorDesigns(study.id, 20),
        this.store.reviews(study.id),
        this.#rolesOf(study, user),
        this.store.latestDesignGrid(study.id),
        this.store.decisions(study.id),
        // The home list says what the study page says under 「需要关注」, an export that did not arrive included.
        this.store.exports(study.id),
      ]);
      const summary = presentSummary({ study, results, allResults, stale, jobs, assumptions, scenarios, comparators, grid, decisions, exports, now });
      return { study, summary, reviews, roles };
    }));
    const recruiting = groups.filter((group) => group.roles.some((/** @type {string} */ role) => roleAllows(role, "contact_patients")));
    /** @type {Record<string, any>} */
    const home = { studies: groups.map((group) => group.summary) };
    const matchStore = this.packages.matchStore;
    if (matchStore && recruiting.length) {
      const todos = presentTodos(await Promise.all(recruiting.map(async (group) => ({
        study: group.study,
        referrals: await matchStore.listReferrals({ studyId: group.study.id, limit: 500 }).catch(() => []),
        sites: await matchStore.listSites(group.study.id).catch(() => []),
      }))), now);
      if (todos.length) home.todos = todos;
    }
    const reviews = presentReviewNotes(groups.map((group) => ({ study: group.study, reviews: group.reviews })), now);
    if (reviews.length) home.reviews = reviews;
    return home;
  }

  /** The seven-step rail, row-level. @param {any} study */
  #progress(study) {
    return VCR_STEPS.map((step) => ({
      step,
      status: study.steps?.[step]?.status ?? "none",
      requested: study.steps?.[step]?.requested === true,
      capability: /** @type {Record<string, string>} */ (VCR_STEP_CAPABILITIES)[step],
      note: study.steps?.[step]?.note ?? null,
    }));
  }

  /**
   * The roles an account holds in one study; the owner is a `lead` even when
   * no membership row says so.
   * @param {any} study @param {{ id: string }} user
   */
  async #rolesOf(study, user) {
    const roles = await this.store.rolesOf?.(study.id, String(user.id)) ?? [];
    return roles.length ? roles : (study.userId === String(user.id) ? ["lead"] : []);
  }

  // --- creation, settings, deletion ------------------------------------------------

  /**
   * `POST /api/vcr/studies`: the control-plane project, its study row, and a
   * conversation bound to `vcr-protocol` — the first step of the seven.
   * @param {{ id: string }} user
   * @param {{ name?: string, question?: string, dataTier?: string, intendedUse?: string, action?: string }} input already validated by the route
   * @param {{ createResearcherProject: (user: any, name: string) => Promise<{ id: string, name: string }>,
   *   bindSession: (user: any, projectId: string, capabilityId: string) => Promise<{ sessionId: string, bound: boolean }> }} hooks
   */
  async createStudy(user, input, hooks) {
    const name = String(input.name || VCR_DEFAULT_STUDY_NAME);
    const control = await hooks.createResearcherProject(user, name);
    const study = await this.store.createStudy({
      userId: String(user.id), projectId: control.id, name, question: String(input.question ?? ""),
      dataTier: input.dataTier, intendedUse: input.intendedUse,
    });
    // What the study is asked for at birth. One of the home page's four action
    // cards asks for that one step, and whatever it needs upstream comes as a
    // minimal version; 「新建研究」 with a question asks for the whole
    // programme, which is what makes 一句话到研究包 the default path (plan §4,
    // §9.2). Nothing else about the study waits for a person.
    for (const step of vcrRequestedSteps(input.action)) {
      await this.store.setStep(study.id, step, { requested: true });
    }
    const session = await hooks.bindSession(user, control.id, VCR_STEP_CAPABILITIES.definition)
      .catch(() => ({ sessionId: "", bound: false }));
    this.counters.studiesCreated += 1;
    return {
      id: study.id, projectId: control.id, name: study.name, requested: [...vcrRequestedSteps(input.action)],
      sessionId: session.sessionId || null, bound: session.bound === true,
    };
  }

  /**
   * The tier this study's frozen sources support, or tier T0 where nothing does
   * or the plane is not composed here. Derived (`vcrTierSupportedBy`), never
   * stored: the data a study holds can change, and the offer follows it.
   * @param {any} study
   */
  async #tierSupport(study) {
    const seam = this.packages.dataPlane;
    if (typeof seam?.tierSupport !== "function") return { tier: "T0", subjects: 0, treatment: false, outcomes: false };
    return seam.tierSupport(study).catch(() => ({ tier: "T0", subjects: 0, treatment: false, outcomes: false }));
  }

  /**
   * The move the study's data offers, for the lead who may make it: the highest
   * tier the frozen sources support when that is above the study's own. Null for
   * a reader who may not (`manage_study`) — the page shows only what will not be
   * refused — and where the data supports nothing more.
   * @param {any} study @param {readonly string[]} roles
   */
  async #tierOffer(study, roles) {
    if (!roles.some((role) => roleAllows(role, "manage_study"))) return null;
    // T2 is the most the data can show (T3 is declared, not derived): nothing above it to offer, so nothing to ask.
    if (VCR_DATA_TIERS.indexOf(study.dataTier) >= VCR_DATA_TIERS.indexOf("T2")) return null;
    const support = await this.#tierSupport(study);
    const offer = vcrTierOffer(study.dataTier, support);
    if (!offer) return null;
    const label = /** @type {Record<string, string>} */ (VCR_DATA_TIER_LABELS_ZH);
    return {
      tier: offer.tier, label: label[offer.tier] ?? offer.tier, unlocks: offer.unlocks,
      basis: { subjects: support.subjects, treatment: support.treatment, outcomes: support.outcomes },
    };
  }

  /**
   * A rise in tier is a claim about data, so it needs data: the frozen sources
   * must support the tier asked for (T3, which no column map can show, needs the
   * data that qualifies as T2 and is then the lead's declaration). A lowering,
   * or the same tier, is not held to it — lowering is an explicit act of the
   * lead's and this never does it. The role check is the route's and unchanged.
   * @param {any} study @param {string} tier
   */
  async #assertTierSupported(study, tier) {
    if (VCR_DATA_TIERS.indexOf(tier) <= VCR_DATA_TIERS.indexOf(study.dataTier)) return;
    const support = await this.#tierSupport(study);
    if (vcrTierIsSupported(tier, support.tier)) return;
    const labels = /** @type {Record<string, string>} */ (VCR_DATA_TIER_LABELS_ZH);
    const needs = vcrTierNeedsSupport(tier);
    throw failure(409, "vcr_tier_unsupported",
      `研究里已冻结的数据还达不到「${labels[needs] ?? needs}」：${support.tier === "T0" ? "还没有可用的患者级数据" : `现有数据只到「${labels[support.tier] ?? support.tier}」`}。`
      + `先在「数据与证据」里接入并冻结数据，再升档位。`);
  }

  /** `PATCH /api/vcr/studies/:id`. @param {{ id: string }} user @param {string} id @param {Record<string, any>} patch */
  async updateStudy(user, id, patch) {
    const study = await this.requireStudy(user, id);
    const { action, ...fields } = patch ?? {};
    if (fields.dataTier !== undefined) await this.#assertTierSupported(study, String(fields.dataTier));
    let updated = await this.store.updateStudy(study.id, fields, String(user.id));
    if (!updated) throw failure(404, "vcr_study_not_found", "Study not found.");
    if (action !== undefined) {
      // A changed 起点 re-asks which steps run; a step already done stays done,
      // it is only no longer requested of the programme.
      const wanted = new Set(vcrRequestedSteps(action === "auto" ? undefined : action));
      for (const step of VCR_STEPS) updated = await this.store.setStep(study.id, step, { requested: wanted.has(step) }) ?? updated;
    }
    return updated;
  }

  /** `DELETE /api/vcr/studies/:id`. @param {{ id: string }} user @param {string} id */
  async deleteStudy(user, id) {
    const study = await this.requireStudy(user, id);
    await this.store.softDeleteStudy(study.id, String(user.id));
    return { id: study.id, projectId: study.projectId, deleted: true };
  }

  // --- the study page --------------------------------------------------------------

  /**
   * `GET /api/vcr/studies/:id`: the header, the seven-step rail and the
   * overview, in the browser's own shape (`VcrStudy`).
   * @param {{ id: string }} user @param {string} id
   */
  async studyView(user, id) {
    const study = await this.requireStudy(user, id);
    return presentStudy(await this.#bundle(study, user));
  }

  /**
   * The row-level view of a study — every result with its stale mark, the
   * review records, the use ceiling — for tests and tools that want the rows
   * rather than the page. The browser reads {@link studyView}.
   * @param {any} study
   */
  async studyViewOf(study) {
    const [definition, results, stale, reviews, jobs, budget, assumptions, members, exports, populations, patientSets, comparators, scenarios, grid, protocol] = await Promise.all([
      this.store.latestDefinition(study.id),
      this.store.results(study.id),
      this.store.staleMarks(study.id),
      this.store.reviews(study.id),
      this.store.jobs(study.id, 20),
      this.packages.jobs?.budgetOf ? this.packages.jobs.budgetOf(study.id).catch(() => null) : null,
      this.store.assumptions(study.id),
      this.store.members(study.id),
      this.store.exports(study.id),
      this.store.populations(study.id, 20), this.store.patientSets(study.id, 20), this.store.comparatorDesigns(study.id, 20),
      this.store.trialScenarios(study.id, 60), this.store.latestDesignGrid(study.id), this.store.latestProtocolVersion(study.id),
    ]);
    const headline = results.find((result) => result.kind === "trial_scenario") ?? results[0] ?? null;
    const seal = vcrSealState(study);
    const current = vcrCurrentNodes({ study, assumptions, populations, patientSets, comparators, scenarios, grid, results, definition, protocol });
    const ceiling = useCeilingOf({ study, results, reviews, stale, current });
    return {
      id: study.id, projectId: study.projectId, name: study.name, question: study.question,
      dataTier: study.dataTier, intendedUse: study.intendedUse, status: study.status, entityKeys: study.entityKeys ?? [],
      steps: study.steps, progress: this.#progress(study), tabs: [...VCR_TABS],
      definition,
      counts: vcrCountBand(object(headline?.counts)),
      results: results.map((result) => this.#resultView(result, stale)),
      conclusion: headline?.conclusion ?? null,
      seal,
      review: this.#reviewView(reviews, results, stale, current, exports),
      intendedUseCeiling: ceiling,
      stale,
      jobs,
      budget,
      assumptionCount: assumptions.length,
      members: members.map((member) => ({ userId: member.userId, role: member.role })),
      exports,
      engineAvailable: Boolean(this.engine?.configured?.()),
      engineMismatch: this.engineMismatch,
      updatedAt: study.updatedAt,
    };
  }

  /**
   * The highest use this study's results can be labelled with, and why — the
   * study page's own answer, taken from the page's own computation (the
   * presenter over the same bundle, for the study's owner) and not made again:
   * a package cover that says what the page says is the point, and a second
   * computation of the ceiling is a second answer.
   * @param {any} study
   */
  async ceilingOf(study) {
    return presentStudy(await this.#bundle(study, { id: String(study.userId) })).ceiling;
  }

  /** @param {any[]} reviews @param {any[]} results @param {any[]} stale @param {{ nodes: Set<string>, kinds: Set<string> }} currentNodes @param {any[]} exports */
  #reviewView(reviews, results, stale, currentNodes, exports) {
    const staleNodes = new Set(stale.map((mark) => String(mark.node)));
    const current = results.map((result) => `result:${result.id}@${result.version}`);
    return {
      records: reviews.map((review) => ({
        ...review,
        // A review countersigns one version; if any of them moved it reads
        // `changed_after_review` (AC-21). The node list is what moved, not the
        // review, which is why the state is derived and never stored.
        state: review.status && review.status !== "done" ? "ai_set" : !vcrReviewIsCurrent(review, { results, stale, current: currentNodes, exports })
          ? "changed_after_review"
          : reviewStateFor({ reviewedNodes: review.nodes, currentNodes: [...new Set([...current, ...review.nodes.filter((node) => !staleNodes.has(node))])] }),
      })),
      reviewed: reviews.some((review) => vcrReviewIsCurrent(review, { results, stale, current: currentNodes, exports })),
      kinds: [...new Set(reviews.map((review) => review.kind))],
    };
  }

  /** @param {any} result @param {any[]} stale */
  #resultView(result, stale) {
    const node = `result:${result.id}@${result.version}`;
    const mark = stale.find((entry) => entry.node === node) ?? null;
    return {
      id: result.id, kind: result.kind, subjectId: result.subjectId, version: result.version,
      conclusion: result.conclusion, notEstimableRule: result.notEstimableRule,
      counts: vcrCountBand(result.counts), measures: result.measures, diagnostics: result.diagnostics,
      tables: result.tables, intendedUse: result.intendedUse, useDowngrade: result.useDowngrade,
      reviewState: result.reviewState,
      // Stale is a state, never a deletion (plan §6.3, AC-16): the numbers
      // stay and the reason travels with them.
      stale: mark ? { reason: mark.reason, markedAt: mark.markedAt, queuedJobId: mark.queuedJobId } : null,
      createdAt: result.createdAt,
    };
  }

  // --- the seven tabs ----------------------------------------------------------------

  /**
   * `GET /api/vcr/studies/:id/:tab`. `query` is what the route was asked with
   * (a `URLSearchParams` or a plain object): the matching tab's `view`,
   * `candidate` and `direction`, the data tab's `card`.
   * @param {{ id: string }} user @param {string} id @param {string} tab
   * @param {URLSearchParams | Record<string, any>} [query]
   */
  async tab(user, id, tab, query = {}) {
    if (!VCR_TABS.includes(tab)) throw failure(404, "vcr_tab_not_found", `tab must be one of: ${VCR_TABS.join(", ")}.`);
    const study = await this.requireStudy(user, id);
    this.counters.tabs += 1;
    const asked = queryOf(query);
    const bundle = await this.#bundle(study, user, tab, asked);
    switch (tab) {
      case "overview": return presentStudy(bundle);
      case "population": return presentPopulationTab(bundle);
      case "patients": return presentPatientsTab(bundle);
      case "comparator": return presentComparatorTab(bundle);
      case "trial": return presentTrialTab(bundle);
      case "matching": return presentMatchingTab(bundle, asked);
      default: return presentDataTab(bundle, asked);
    }
  }

  /**
   * `GET /api/vcr/studies/:id/export/:exportId`: one package for the reader.
   * @param {{ id: string }} user @param {string} id @param {string} exportId
   */
  async exportView(user, id, exportId) {
    const study = await this.requireStudy(user, id);
    const row = await this.store.exportRow(study.id, exportId);
    if (!row) throw failure(404, "vcr_export_not_found", "Export not found.");
    const bundle = await this.#bundle(study, user, "overview");
    // The page compares a model document with the records as they stand, so it reads the same inputs the document was built from.
    if (isModelDocumentKind(row.kind)) {
      bundle.modelAnalysis = buildModelAnalysis({ inputs: await readModelAnalysisInputs(this.store, study), results: bundle.results,
        versions: await this.store.modelPlanVersions(study.id) });
    }
    return presentExport(row, bundle);
  }

  /**
   * Every row a page of this study may need, read once. The presenters are
   * pure; this is the only place a page touches a store.
   * @param {any} study @param {{ id: string }} user @param {string} [tab] @param {Record<string, string>} [query]
   */
  async #bundle(study, user, tab = "overview", query = {}) {
    const wants = tab === "overview" || tab === "trial" || tab === "comparator";
    const [definition, results, allResults, stale, reviews, jobs, budget, assumptions, members, exports, decisions, roles,
      scenarios, comparators, populations, patientSets, grid, forecasts, models, executions, protocol, jobMarks] = await Promise.all([
      this.store.latestDefinition(study.id),
      this.store.results(study.id),
      this.store.allResults(study.id),
      this.store.staleMarks(study.id),
      this.store.reviews(study.id),
      this.store.jobs(study.id, 30),
      this.packages.jobs?.budgetOf ? this.packages.jobs.budgetOf(study.id).catch(() => null) : null,
      this.store.assumptions(study.id),
      this.store.members(study.id),
      this.store.exports(study.id),
      this.store.decisions(study.id),
      this.#rolesOf(study, user),
      this.store.trialScenarios(study.id, 60),
      this.store.comparatorDesigns(study.id, 20),
      this.store.populations(study.id, 20),
      this.store.patientSets(study.id, 20),
      this.store.latestDesignGrid(study.id),
      this.store.forecasts(study.id),
      this.store.models(study.userId),
      this.#executions(study.id),
      this.store.latestProtocolVersion(study.id),
      // Why an object is not being computed (a refusal recorded before any job was queued).
      this.store.rows(`SELECT key, state, detail FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND kind = 'job' AND state = 'failed'`, [study.id]),
    ]);
    // What the countersignatures say about each version the pages show (assumption cards carry
    // theirs from the store): a result or an object whose exact version somebody signed reads
    // 已复核, one whose earlier version was signed reads 复核后有变更, the rest is what it was stored as.
    const signed = (/** @type {any[]} */ rows, /** @type {(row: any) => string} */ nodeOf) => rows.map((row) => withReviewState(row, nodeOf(row), reviews));
    const reviewedResults = signed(results, resultNode);
    const reviewedAll = signed(allResults, resultNode);
    const reviewedPopulations = signed(populations, (row) => vcrObjectNode("population", row));
    const reviewedComparators = signed(comparators, (row) => vcrObjectNode("comparator", row));
    const currentNodes = vcrCurrentNodes({ study, assumptions, populations, patientSets, comparators, scenarios, grid, results, definition, protocol });
    /** @type {Record<string, any>} */
    const bundle = {
      engine: this.engineStatus(),
      now: this.now(), study, definition, results: reviewedResults, allResults: reviewedAll, stale, reviews: reviews.map(review => ({ ...review, current: vcrReviewIsCurrent(review, { results, stale, current: currentNodes, exports }) })), jobs, budget, assumptions, members, exports, decisions,
      roles, scenarios, comparators: reviewedComparators, comparator: reviewedComparators[0] ?? null, populations: reviewedPopulations, patientSets, grid, forecasts, models,
      executions, protocol, seal: vcrSealState(study),
      forecastResults: reviewedAll.filter((result) => result.kind === "accrual_forecast"),
      criteria: protocol ? await this.store.criteria(protocol.id) : [], jobMarks,
      currentNodes,
    };
    if (tab === "data" || wants) {
      bundle.edges = await this.store.edges(study.id);
      /** @type {Array<[string, any[]]>} */
      const versions = await Promise.all(assumptions.map(async (/** @type {any} */ card) =>
        /** @type {[string, any[]]} */ ([card.key, await this.store.assumptionVersions(study.id, card.key)])));
      bundle.assumptionVersions = new Map(versions);
      // 「有新证据」 on a card, and the versions written after the plan froze (flywheel F24).
      bundle.evidenceSignals = await this.packages.frontierEvents?.signalsFor?.(study.id).catch(() => null) ?? null;
      bundle.candidates = await this.packages.frontierEvents?.candidatesFor?.(study.userId, { studyId: study.id }).catch(() => null) ?? null;
    }
    // The overview drills into a card's quotation, so it reads the extracted
    // values too; only the data tab asks the data plane.
    if (tab === "data" || tab === "overview") bundle.evidence = await this.#evidence(study);
    if (tab === "data") bundle.dataPlane = await this.#dataPlane(study, user);
    if (tab === "matching") bundle.match = await this.#match(study, query);
    // The model's assessment records and the frozen plan that names them: the patients tab shows them beside the model.
    if (tab === "patients") {
      const [assessments, plans] = await Promise.all([this.store.modelAssessments(study.id), this.store.modelPlanVersions(study.id)]);
      bundle.assessments = assessments;
      bundle.modelPlan = plans[0] ?? null;
    }
    // The people a page names are shown by name: resolved once for the page, through the one join the module has.
    if (tab === "data") bundle.people = await this.#people(dataPeopleOf(bundle.dataPlane));
    if (tab === "matching") bundle.people = await this.#people(matchingPeopleOf(bundle.match));
    if (tab === "patients") bundle.people = await this.#people(list(bundle.assessments).map((/** @type {any} */ record) => record.by).filter(Boolean));
    // The header's one offer, read for the page that has a header (the overview is the study's own payload).
    if (tab === "overview") bundle.tierOffer = await this.#tierOffer(study, roles);
    // The pack the study works from and the library definitions it used: the overview shows them, the population tab acts on them.
    if (tab === "overview" || tab === "population") bundle.knowledge = await this.#knowledge(study, user, roles, populations);
    return bundle;
  }

  /**
   * The study's knowledge block (`null` when the package is not composed or cannot answer — the page then shows nothing of it).
   * @param {any} study @param {{ id: string }} user @param {string[]} roles @param {any[]} populations
   */
  async #knowledge(study, user, roles, populations) {
    const knowledge = this.packages.knowledge;
    if (!knowledge?.studyKnowledge) return null;
    const canPromote = this.isOperator(user) || roles.some((role) => roleAllows(role, "manage_study"));
    const view = await knowledge.studyKnowledge(study, { canPromote }).catch(() => null);
    if (!view) return null;
    // The populations a definition could be saved from: defined by rules on real data.
    const savable = populations.filter((population) => population.kind === "real" && list(object(population.definition).rules).length)
      .map((population) => ({ populationId: population.id, label: `人群 v${population.version}`, name: String(population.name ?? "") }));
    return { ...view, savable };
  }

  /**
   * What the matching run reads beside its funnel: the pack's concept names for the variables the protocol's criteria
   * name, and the dataset columns that realise them.
   * @param {any} study
   */
  async #matchingGuide(study) {
    const knowledge = this.packages.knowledge;
    if (!knowledge?.studyPack || !knowledge.matchingGuide) return null;
    const bound = await knowledge.studyPack(study).catch(() => null);
    if (!bound) return null;
    const protocol = await this.store.latestProtocolVersion(study.id);
    const criteria = protocol
      ? (this.packages.matchStore ? await this.packages.matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }) : await this.store.criteria(protocol.id))
      : [];
    return knowledge.matchingGuide(study, bound, criteria);
  }

  /**
   * The names of the accounts a page mentions, or null where this service has no
   * way to resolve them (a double without the join): the presenters then say
   * nothing of a person rather than their id.
   * @param {Iterable<unknown>} ids @returns {Promise<Map<string, string> | null>}
   */
  async #people(ids) {
    if (typeof this.store.personNames !== "function") return null;
    return this.store.personNames(ids).catch(() => null);
  }

  /** What each finished job ran: method, version, seed, replicates, cost. @param {string} studyId */
  async #executions(studyId) {
    const rows = await this.store.rows(`SELECT id, job_id, method, method_version, scenario_hash, seed, replicates, cpu_seconds, finished_at
      FROM ${VCR_SCHEMA}.executions WHERE study_id = $1 ORDER BY created_at DESC LIMIT 200`, [studyId]);
    return new Map(rows.map((row) => [String(row.id), {
      id: String(row.id), jobId: String(row.job_id), method: String(row.method), methodVersion: String(row.method_version ?? ""),
      scenarioHash: String(row.scenario_hash ?? ""), seed: row.seed == null ? null : Number(row.seed),
      replicates: row.replicates == null ? null : Number(row.replicates), cpuSeconds: numeric(row.cpu_seconds),
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    }]));
  }

  /**
   * The evidence half of the data tab: the precedents this study pulled in and
   * the extracted values behind its cards. A deployment without the evidence
   * side says so by name.
   * @param {any} study
   */
  async #evidence(study) {
    const evidenceStore = this.packages.evidenceStore;
    if (!evidenceStore) {
      return { available: false, code: "vcr_evidence_unavailable", message: "证据参数化在本部署尚未接入；假设卡仍可手工登记。", precedents: [], items: [] };
    }
    const [precedents, items] = await Promise.all([
      evidenceStore.listPrecedents({ userId: study.userId, studyId: study.id, limit: 100 }).catch(() => []),
      evidenceStore.listEvidenceItems({ userId: study.userId, studyId: study.id, limit: 1000 }).catch(() => []),
    ]);
    return { available: true, precedents, items };
  }

  /**
   * The data plane's half of the data tab, without a path of the server: a
   * reader needs the source and the snapshot, not where the bytes sit.
   * @param {any} study @param {{ id: string }} user
   */
  async #dataPlane(study, user) {
    const dataPlane = this.packages.dataPlane;
    if (!dataPlane?.tab) {
      return { available: false, code: "vcr_data_plane_unavailable",
        message: this.config.vcrDataPlaneDir ? "数据平面尚未接入本部署。" : "本部署未配置数据平面目录：T0 档以外的数据接入暂不可用。" };
    }
    const tab = await dataPlane.tab(study, user).catch(() => null);
    if (!tab) return { available: false, code: "vcr_data_plane_unavailable", message: "数据平面暂时不可用。" };
    if (tab.available === false) return { available: false, code: tab.unavailable?.code ?? "vcr_data_plane_unavailable", message: tab.unavailable?.message ?? "" };
    return { available: true, sources: tab.sources ?? [], snapshots: tab.snapshots ?? [] };
  }

  /**
   * The matching tab's rows, from package E's own store: the latest assessment
   * of every subject, tallies over all of them (a page that counted only its
   * first hundred would report a smaller cohort than it has), the referral
   * ledger, the sites and the follow-up. `null` when the package is not composed.
   * @param {any} study @param {Record<string, string>} query
   */
  async #match(study, query) {
    const matchStore = this.packages.matchStore;
    if (!matchStore) return null;
    const protocol = await this.store.latestProtocolVersion(study.id).catch(() => null);
    const criteria = protocol ? await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }).catch(() => []) : [];
    const latest = `SELECT DISTINCT ON (subject_key) * FROM ${VCR_SCHEMA}.matching_assessments
      WHERE study_id = $1 ORDER BY subject_key, as_of DESC, created_at DESC`;
    const [tallyRows, subjectRows, referrals, sites, siteFunnel, followups, gapRows, reviewRows] = await Promise.all([
      matchStore.rows(`SELECT summary, count(*)::int AS total FROM (${latest}) l GROUP BY summary`, [study.id]).catch(() => []),
      matchStore.rows(`SELECT * FROM (${latest}) l WHERE summary <> 'ineligible' ORDER BY subject_key LIMIT 200`, [study.id]).catch(() => []),
      matchStore.listReferrals({ studyId: study.id, limit: 500 }).catch(() => []),
      matchStore.listSites(study.id).catch(() => []),
      matchStore.siteFunnel(study.id).catch(() => []),
      matchStore.listFollowupEpisodes({ studyId: study.id }).catch(() => []),
      matchStore.rows(`SELECT j.criterion_id, count(*)::int AS unknown FROM ${VCR_SCHEMA}.criterion_judgments j
        WHERE j.assessment_id IN (SELECT id FROM (${latest}) l) AND j.applicable AND j.state = 'unknown' GROUP BY 1`, [study.id]).catch(() => []),
      // Excluded on a model's word alone: they wait in 「待复核排除」, so the
      // false-exclusion rate has a denominator (plan §7.1).
      matchStore.rows(`SELECT l.subject_key FROM (${latest}) l WHERE l.summary = 'ineligible'
        AND EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.criterion_judgments j WHERE j.assessment_id = l.id AND j.applicable AND j.state = 'not_satisfied')
        AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.criterion_judgments j WHERE j.assessment_id = l.id AND j.applicable
          AND j.state = 'not_satisfied' AND j.decided_by <> 'model') ORDER BY l.subject_key LIMIT 200`, [study.id]).catch(() => []),
    ]);
    const subjects = subjectRows.map((row) => ({
      id: String(row.id), subjectKey: String(row.subject_key), summary: String(row.summary), counts: row.counts ?? {},
      priority: row.priority ?? null, direction: String(row.direction ?? "trial_to_patient"), asOf: row.as_of, reviewedBy: row.reviewed_by ?? null,
    }));
    const wanted = subjects.map((subject) => subject.id);
    const openRows = wanted.length
      ? await matchStore.rows(`SELECT j.assessment_id, j.criterion_id, j.state, j.recheck_at FROM ${VCR_SCHEMA}.criterion_judgments j
          JOIN ${VCR_SCHEMA}.criteria c ON c.id = j.criterion_id
          WHERE j.assessment_id = ANY($1::text[]) AND j.applicable AND j.state IN ('unknown', 'pending_recheck')
          ORDER BY j.assessment_id, c.ordinal`, [wanted]).catch(() => [])
      : [];
    /** @type {Map<string, Array<{ criterionId: string, state: string, recheckAt: string | null }>>} */
    const openByAssessment = new Map();
    for (const row of openRows) {
      const list_ = openByAssessment.get(String(row.assessment_id)) ?? [];
      list_.push({ criterionId: String(row.criterion_id), state: String(row.state), recheckAt: row.recheck_at ? new Date(row.recheck_at).toISOString() : null });
      openByAssessment.set(String(row.assessment_id), list_);
    }
    // The candidate the detail panel is about: the one asked for, else the first listed.
    const order = ["eligible", "insufficient_evidence", "pending"];
    const listed = [...subjects].sort((a, b) => order.indexOf(a.summary) - order.indexOf(b.summary)
      || Number(a.counts?.unknown ?? 0) - Number(b.counts?.unknown ?? 0) || a.subjectKey.localeCompare(b.subjectKey));
    const focus = listed.find((subject) => subject.subjectKey === query.candidate) ?? listed[0] ?? null;
    const selected = focus ? await matchStore.getAssessment(focus.id).catch(() => null) : null;
    // Who moved the person's referral, to where, and when: every step of the
    // ledger leaves its mark (plan §7.2), and the detail panel shows it.
    const focusReferral = focus ? referrals.find((referral) => referral.subjectKey === focus.subjectKey) ?? null : null;
    const referralEvents = focusReferral ? await matchStore.listReferralEvents(focusReferral.id).catch(() => []) : [];
    return {
      protocol, criteria, subjects, referrals, sites, siteFunnel, followups, selected, referralEvents, openByAssessment,
      tallies: Object.fromEntries(tallyRows.map((row) => [String(row.summary), Number(row.total)])),
      gapsByCriterion: new Map(gapRows.map((row) => [String(row.criterion_id), { unknown: Number(row.unknown) }])),
      pendingReview: reviewRows.map((row) => String(row.subject_key)),
      forecastResult: null,
      snapshotAt: null,
    };
  }

  // --- cross-study pages --------------------------------------------------------------

  /**
   * `GET /api/vcr/models`: the shared model and method library (plan §8.2), in
   * the browser's card shape — with, on each card, the studies that use it.
   * @param {{ id: string }} user
   */
  async modelLibrary(user) {
    const [models, methods, uses] = await Promise.all([
      this.store.models(String(user.id)), this.store.methods(),
      this.store.rows(`SELECT DISTINCT ps.model_id, s.id, s.name FROM ${VCR_SCHEMA}.patient_sets ps
        JOIN ${VCR_SCHEMA}.studies s ON s.id = ps.study_id
        WHERE s.deleted_at IS NULL AND ps.model_id IS NOT NULL
          AND (s.user_id = $1 OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.members m WHERE m.study_id = s.id AND m.user_id = $1))
        ORDER BY s.name LIMIT 500`, [String(user.id)]),
    ]);
    /** @type {Map<string, Array<{ id: string, label: string }>>} */
    const usedBy = new Map();
    for (const row of uses) {
      const key = String(row.model_id);
      const found = usedBy.get(key) ?? [];
      found.push({ id: String(row.id), label: String(row.name) });
      usedBy.set(key, found);
    }
    // A patient set names its model by catalogue name or by id.
    for (const model of models) {
      const byId = usedBy.get(model.id) ?? [];
      const byName = usedBy.get(model.name) ?? [];
      const merged = [...byId, ...byName.filter((entry) => !byId.some((other) => other.id === entry.id))];
      if (merged.length) usedBy.set(model.id, merged);
    }
    return presentModels({ models, methods: validatedMethods(methods, await loadMethodValidation({ file: this.config.vcrMethodValidationFile, engine: this.engine })),
      usedBy, engineAvailable: Boolean(this.engine?.configured?.()), engineMismatch: this.engineMismatch });
  }

  /**
   * Take a literature model a study fitted into the shared catalogue. Its
   * applicability is written from the trials it came from, not by hand: a
   * model that claims a population nobody fitted it on is the failure §8.2
   * exists to prevent.
   * @param {{ id: string }} user @param {Record<string, any>} input
   */
  async adoptModel(user, input) {
    const study = input.studyId ? await this.requireStudy(user, String(input.studyId)) : null;
    const sources = list(input.sources).map((source) => String(object(source).label ?? source));
    // The call shape a card declares is one of the two plan §5.2 names (a card that says nothing is the first). A model of the second
    // shape is taken in with the card it arrives with; what that card has not said is returned as notices, never as a refusal, and
    // the applicability check then declines to answer for it field by field (`vcrModelCardIssues`).
    const shape = vcrModelInterfaceOf({ card: object(input.card) });
    if (shape === null) throw failure(400, "vcr_model_invalid", `card.interfaceShape is one of: ${VCR_MODEL_INTERFACES.join(", ")}.`);
    const card = { ...object(input.card), type: shape === "event_history_to_trajectories" ? "generative" : "fitted_prediction_model",
      provider: study ? `研究 ${study.name}` : "虚拟临研" };
    const applicability = { ...object(input.applicability), population: sources.length ? `来源试验的人群：${sources.join("、")}` : "来源试验的人群", sources };
    const validation = object(input.validation);
    const saved = await this.store.saveModel({
      userId: String(user.id), studyId: study?.id ?? null,
      name: String(input.name), version: String(input.version ?? "1.0.0"),
      tier: "literature", risk: String(input.risk ?? "low"), endpointType: input.endpointType ?? null,
      card, applicability, validation, evidence: list(input.evidence).map(String),
    });
    await this.store.audit({ studyId: study?.id ?? null, userId: String(user.id), actor: String(user.id),
      action: "vcr.model.adopt", object: String(saved?.id ?? ""), detail: { name: String(input.name), tier: "literature", shape } });
    return saved ? { ...saved, issues: vcrModelCardIssues({ version: String(input.version ?? "1.0.0"), card, applicability, validation }) } : saved;
  }

  /**
   * `GET /api/vcr/precedents`: the trial-precedent search over the account's
   * library. The query is `q` (registry id or title) and `limit`; a deployment
   * without the evidence side answers `available: false` with the sentence
   * saying so, never an empty table that reads as 「没有先例」.
   * @param {{ id: string }} user @param {URLSearchParams | Record<string, any>} [query]
   */
  async precedents(user, query = {}) {
    const asked = queryOf(query);
    const evidenceStore = this.packages.evidenceStore;
    if (!evidenceStore) {
      return presentPrecedents({ available: false, message: "试验先例库在本部署尚未接入。" });
    }
    const limit = Math.min(200, Math.max(1, Number.parseInt(asked.limit ?? "", 10) || 100));
    const rows = await evidenceStore.listPrecedents({ userId: String(user.id), search: String(asked.q ?? ""), limit });
    const registryCoverage = await (this.packages.evidence?.registryCoverageFor?.(String(user.id)) ?? this.packages.evidence?.registryCoverage?.() ?? []);
    const candidates = this.packages.frontierEvents?.candidatesFor ? await this.packages.frontierEvents.candidatesFor(String(user.id)) : null;
    return presentPrecedents({ available: true, rows, registryCoverage, sources: rows.length ? `${rows.length} 项试验先例` : null, candidates });
  }

  // --- the runtime's read (build contract §3.2, §4) ---------------------------------------

  /**
   * The smallest cell a model is shown: the domain's floor, raised (never
   * lowered) by the deployment. A boundary that a configuration could loosen to
   * two people would be a setting, not a control.
   */
  get minCell() {
    const configured = Number(this.config?.vcrMinCellSize);
    return Number.isInteger(configured) && configured > VCR_MIN_CELL_SIZE ? configured : VCR_MIN_CELL_SIZE;
  }

  /**
   * Everything a model may read passes through here, exactly once: the domain's
   * `suppressForModel`, over every object and array to any depth (build
   * contract §4). A payload the boundary cannot finish — a cycle, a nesting no
   * store produces — is refused whole rather than passed on unfinished; a
   * boundary that stops walking and lets the rest through has a hole in it.
   * Applying it twice would hide more than once (a hidden cell reads as zero),
   * so a caller hands over data that has not been through it.
   *
   * `publishedFigures` is for the reads of {@link VCR_PUBLISHED_FIGURE_READS}
   * only: another trial's numbers pass the boundary's other half (no plane
   * address, a cycle refused whole) and are not judged as this study's head
   * counts: the exemption is a rule about numbers, not a hole.
   * @param {unknown} payload @param {{ publishedFigures?: boolean }} [options]
   */
  forModel(payload, { publishedFigures = false } = {}) {
    try {
      const addressed = stripPlaneAddresses(payload);
      return publishedFigures ? addressed : suppressForModel(addressed, { minCell: this.minCell });
    } catch {
      throw failure(503, "vcr_gateway_unavailable", "这份读取结果无法确认不含小样本格子，已整体拒绝。");
    }
  }

  /**
   * The render root of a report: the document a template's `{{n:…}}` references
   * bind to, built from the study's own rows (`vcrReportModel`). Exact — the
   * platform renders it into the package a study member reads. What a run reads
   * of it goes through {@link forModel}.
   * @param {any} study
   */
  async reportModel(study, options = {}) {
    return this.store.reportSnapshot ? this.store.reportSnapshot(async (snapshot) =>
      this.reportModelFromStore(await snapshot.studyById(study.id), snapshot, options)) : this.reportModelFromStore(study, this.store, options);
  }

  /**
   * `options.kind` is the export the model is for: the two model documents
   * carry, in addition, the `modelAnalysis` block they are rendered from, built
   * from the same reads the plan's freeze uses (so a deviation is a real change
   * and never a difference in how much was read).
   * @param {any} study @param {any} store @param {{ kind?: string | null }} [options]
   */
  async reportModelFromStore(study, store, options = {}) {
    if (!study) throw failure(404, "vcr_study_not_found", "Study not found.");
    const [definition, assumptions, results, reviews, stale, population, comparator, scenarios, models, populations, patientSets, comparators, grid, protocol, exports] = await Promise.all([
      store.latestDefinition(study.id), store.assumptions(study.id), store.results(study.id),
      store.reviews(study.id), store.staleMarks(study.id), store.latestPopulation(study.id),
      store.latestComparatorDesign(study.id), store.trialScenarios(study.id, 60), store.models(study.userId),
      store.populations(study.id, 20), store.patientSets(study.id, 20), store.comparatorDesigns(study.id, 20), store.latestDesignGrid(study.id), store.latestProtocolVersion(study.id), store.exports(study.id),
    ]);
    const current = vcrCurrentNodes({ study, assumptions, populations, patientSets, comparators, scenarios, grid, results, definition, protocol });
    const modelAnalysis = isModelDocumentKind(String(options.kind ?? ""))
      ? buildModelAnalysis({ inputs: await readModelAnalysisInputs(store, study), results, versions: await store.modelPlanVersions(study.id) }) : null;
    return vcrReportModel({ study, definition, assumptions, results, reviews: reviews.map(review => ({ ...review, current: vcrReviewIsCurrent(review, { results, stale, current, exports }) })), staleMarks: stale, population, comparator,
      scenarios, models, seal: vcrSealState(study), modelAnalysis });
  }

  /**
   * What a run may read. **Aggregates and structure only**: no row of any
   * person ever appears here, and a cell speaking for fewer than
   * `minCell` people is suppressed by the domain's `suppressForModel` before it
   * leaves (plan §8.1, AC-26) — for every `what` but the three that carry
   * another trial's published figures ({@link VCR_PUBLISHED_FIGURE_READS}). The
   * one thing that is per person is `subject_document`, whose whole point is
   * the person's own record, so it is judged and audited per read and answers
   * with a pseudonymous key and nothing that names anyone.
   *
   * @param {any} study @param {string} what @param {Record<string, any>} [filter]
   */
  async runtimeRead(study, what, filter = {}) {
    if (!VCR_READ_WHATS.includes(what)) {
      throw failure(400, "vcr_read_what_invalid", `what must be one of: ${VCR_READ_WHATS.join(", ")}.`);
    }
    this.counters.reads += 1;
    return this.forModel(await this.#runtimeRead(study, what, filter), { publishedFigures: VCR_PUBLISHED_FIGURE_READS.includes(what) });
  }

  /** @param {any} study @param {string} what @param {Record<string, any>} filter */
  async #runtimeRead(study, what, filter) {
    const limit = Math.min(VCR_READ_MAX_ITEMS, Math.max(1, Number(filter.limit ?? 20)));
    switch (what) {
      case "study": {
        const [definition, stale, budget, intendedUseCeiling] = await Promise.all([
          this.store.latestDefinition(study.id), this.store.staleMarks(study.id),
          this.packages.jobs?.budgetOf ? this.packages.jobs.budgetOf(study.id).catch(() => null) : null,
          this.ceilingOf(study),
        ]);
        return { study: { id: study.id, name: study.name, question: study.question, dataTier: study.dataTier,
          intendedUse: study.intendedUse, status: study.status, steps: study.steps }, definition, stale, budget,
        seal: vcrSealState(study),
        intendedUseCeiling };
      }
      case "definition": return { definition: await this.store.latestDefinition(study.id),
        versions: (await this.store.definitionVersions(study.id)).map((version) => ({ version: version?.version, createdAt: version?.createdAt })) };
      case "criteria": {
        const protocol = await this.store.latestProtocolVersion(study.id);
        // The matching store's criteria carry their applicability beside the requirement.
        const criteria = protocol
          ? (this.packages.matchStore ? await this.packages.matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }) : await this.store.criteria(protocol.id))
          : [];
        return { protocol, criteria };
      }
      case "assumptions": {
        const assumptions = await this.store.assumptions(study.id);
        return { assumptions: assumptions.slice(0, limit), more: assumptions.length > limit };
      }
      case "evidence": {
        const evidence = this.packages.evidence;
        if (!evidence?.evidenceRead) {
          return { available: false, code: "vcr_evidence_unavailable", message: "证据参数化未接入：这一步暂不可用，其余步骤照常。" };
        }
        return { ...await evidence.evidenceRead(study, { ...filter, limit }),
          curveReceipts: evidence.curves ? await evidence.curves.receipts({ studyId: study.id, principal: study.userId }) : [] };
      }
      case "population": {
        const populations = await this.store.populations(study.id, limit);
        return { populations: populations.map((population) => ({ ...population, counts: vcrCountBand(population.counts) })) };
      }
      case "patients": {
        // 「数字孪生」 is a label a model's evidence earns, and the run may not
        // write it: it is read off the model's own evidence here, every time.
        const [sets, models] = await Promise.all([this.store.patientSets(study.id, limit), this.store.models(study.userId)]);
        return { patientSets: sets.map((set) => {
          const model = models.find((row) => row.id === set.modelId || row.name === set.modelId) ?? null;
          const held = list(model?.evidence).map(String);
          return { ...set, counts: vcrCountBand(set.counts), twinLabel: model ? twinLabel(held) : null };
        }) };
      }
      case "comparator": return { designs: await this.store.comparatorDesigns(study.id, limit), routes: vcrRouteOptions(study.dataTier) };
      case "trial": return { scenarios: await this.store.trialScenarios(study.id, limit), grid: await this.store.latestDesignGrid(study.id),
        forecasts: (await this.store.forecasts(study.id)).map(({ public: _public, ...forecast }) => forecast) };
      case "results": {
        const results = await this.store.results(study.id, filter.kind ? String(filter.kind) : null);
        const stale = await this.store.staleMarks(study.id);
        return { results: results.slice(0, limit).map((result) => this.#resultView(result, stale)), more: results.length > limit };
      }
      case "report_model": return { model: await this.reportModel(study, { kind: filter.kind ? String(filter.kind) : null }) };
      case "jobs": return { jobs: await this.store.jobs(study.id, limit) };
      case "models": return { models: await this.store.models(study.userId), methods: validatedMethods(await this.store.methods(),
        await loadMethodValidation({ file: this.config.vcrMethodValidationFile, engine: this.engine })) };
      case "model_assessments": {
        // The records the model analysis plan is built from, each with what it has not said yet, so a run knows what to fill.
        const assessments = await this.store.modelAssessments(study.id);
        return { assessments: assessments.slice(0, limit).map((record) => ({ ...record, gaps: vcrAssessmentIssues(record, "planning").map((found) => found.text) })),
          more: assessments.length > limit, plan: (await this.store.modelPlanVersions(study.id)).slice(0, 1).map((version) => ({
            version: version.version, frozenAt: version.frozenAt, contentHash: version.contentHash })) };
      }
      case "snapshot_profile": {
        const dataPlane = this.packages.dataPlane;
        if (!dataPlane?.runtimeProfile) {
          return { available: false, code: "vcr_data_plane_unavailable", message: "数据平面未接入：这一步暂不可用，其余步骤照常。" };
        }
        // Bound to this study and judged (and audited) there: a snapshot of
        // another study, or one the study's owner may not read, is refused by
        // name, never profiled.
        return dataPlane.runtimeProfile(study, filter);
      }
      case "subject_document": {
        const documents = this.packages.documents;
        if (!documents?.subjectDocuments) {
          return { available: false, code: "vcr_data_plane_unavailable", message: "数据平面未接入病历文档：这一步暂不可用，其余步骤照常。" };
        }
        return documents.subjectDocuments(study, { ...filter, limit });
      }
      case "matching": {
        const matching = this.packages.matching;
        if (!matching?.runtimeRead) {
          return { available: false, code: "vcr_matching_unavailable", message: "匹配与招募未接入：这一步暂不可用，其余步骤照常。" };
        }
        const answer = await matching.runtimeRead(study, filter);
        // The study-level read also says which concept names the pack uses for the variables the criteria
        // name and which dataset columns realise them — the names a fact is written under.
        const guide = filter.subjectKey ? null : await this.#matchingGuide(study);
        return guide ? { ...answer, packMapping: guide } : answer;
      }
      case "pack": {
        const knowledge = this.packages.knowledge;
        if (!knowledge?.runtimeReadPack) {
          return { available: false, code: "vcr_unavailable", message: "知识包未接入本部署：这一步暂不可用，其余步骤照常。" };
        }
        return knowledge.runtimeReadPack(study, filter);
      }
      case "library": {
        const knowledge = this.packages.knowledge;
        if (!knowledge?.runtimeReadLibrary) {
          return { available: false, code: "vcr_unavailable", message: "人群定义库未接入本部署：这一步暂不可用，其余步骤照常。" };
        }
        return knowledge.runtimeReadLibrary(study, filter);
      }
      case "precedents": {
        const evidence = this.packages.evidence;
        if (!evidence?.runtimeRead) {
          return { available: false, code: "vcr_evidence_unavailable", message: "试验先例库未接入：这一步暂不可用，其余步骤照常。" };
        }
        return evidence.runtimeRead(study, { ...filter, what: "precedents" });
      }
      default: {
        // `trial_registry_record`: a registry id in, a structured record out.
        // The control plane resolves it through package C's registry client,
        // so a run never reaches a registry itself.
        const evidence = this.packages.evidence;
        if (!evidence?.registryRecord) {
          return { available: false, code: "registry_unavailable", message: "试验登记检索未接入：这一步暂不可用，其余步骤照常。" };
        }
        return evidence.registryRecord(study, filter);
      }
    }
  }

  /** The counters the metric families read. */
  metrics() {
    return { ...this.counters };
  }
}

/**
 * Scenarios beaten on every measure of the team's comparison goal. Ties do not
 * dominate: a scenario equal on everything is not worse, and calling it
 * dominated would delete a legitimate choice from the page.
 * @param {Array<{ id: string, label: string, result: any }>} scenarios
 * @param {{ measures?: Array<{ name: string, direction?: string }> }} goal
 */
export function vcrDominatedScenarios(scenarios, goal) {
  const measures = list(object(goal).measures).map((measure) => ({
    name: String(object(measure).name), higherIsBetter: String(object(measure).direction ?? "higher") !== "lower",
  })).filter((measure) => measure.name);
  if (!measures.length) return [];
  /** @param {any} scenario @param {string} name */
  const valueOf = (scenario, name) => {
    const found = list(object(scenario.result).measures).find((measure) => String(object(measure).name) === name);
    const value = Number(object(found).value);
    return Number.isFinite(value) ? value : null;
  };
  /** @type {Array<{ id: string, label: string, dominatedBy: string }>} */
  const dominated = [];
  for (const candidate of scenarios) {
    for (const other of scenarios) {
      if (other.id === candidate.id) continue;
      let strictlyBetterSomewhere = false;
      let neverWorse = true;
      for (const measure of measures) {
        const mine = valueOf(candidate, measure.name);
        const theirs = valueOf(other, measure.name);
        if (mine == null || theirs == null) { neverWorse = false; break; }
        const better = measure.higherIsBetter ? theirs > mine : theirs < mine;
        const worse = measure.higherIsBetter ? theirs < mine : theirs > mine;
        if (worse) { neverWorse = false; break; }
        if (better) strictlyBetterSomewhere = true;
      }
      if (neverWorse && strictlyBetterSomewhere) {
        dominated.push({ id: candidate.id, label: candidate.label, dominatedBy: other.id });
        break;
      }
    }
  }
  return dominated;
}

/** A readiness failure as `readinessCheck` in `server.mjs` reads one. @param {string} code @param {Record<string, any> | null} [details] */
function readinessFailure(code, details = null) {
  const error = new Error(code);
  /** @type {any} */ (error).code = code;
  if (details) /** @type {any} */ (error).details = details;
  return error;
}

/**
 * The `vcr` readiness check. Red only for this module's own invariants: it is
 * on, the schema is there, and a receipt key the operator configured is one the
 * process can use. The engine not being composed is a warning, not a failure —
 * the study's AI steps and its conversation work without it (plan §10.5).
 * @param {{ config: Record<string, any>, vcr: any, database: any }} input
 */
export async function vcrReadiness({ config, vcr, database }) {
  if (!config?.vcrEnabled) return { enabled: false, status: "off" };
  if (!vcr?.service || !database) throw readinessFailure("vcr_unavailable", { reason: database ? "not_composed" : "no_product_database" });
  try {
    await vcr.service.ready();
  } catch (error) {
    throw readinessFailure("vcr_migration_failed", {
      reason: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "migration_error",
    });
  }
  // A receipt key the operator configured and the process cannot use. The engine
  // stays composed and every step runs — a receipt labels a result and never
  // decides whether a person has one — but the deployment is not what its
  // configuration says, and that is what a readiness check is for.
  if (config.vcrEngineReceiptKeyError) {
    throw readinessFailure("vcr_engine_receipt_key_unusable", { reason: String(config.vcrEngineReceiptKeyError) });
  }
  // Composed is not answering (`vcrEngineProbe.mjs`): a stopped engine container read `wired` here until the
  // two were told apart. `wired` stays for an engine nobody has asked yet, `answering` and `not_answering` are
  // what the last contact (a job's, or a `/health` read) said. Not answering is a warning on a green check —
  // an engine down makes the computations that need it wait, not the platform fail.
  const composed = Boolean(vcr.engine?.configured?.());
  const reading = composed ? vcr.engineProbe?.snapshot?.() ?? null : null;
  const engine = !composed ? "missing" : reading?.state === "answering" ? "answering" : reading?.state === "not_answering" ? "not_answering" : "wired";
  const warnings = [
    ...(composed ? [] : ["vcr_engine_not_composed"]),
    ...(engine === "not_answering" ? ["vcr_engine_not_answering"] : []),
    ...(config.vcrDataPlaneDir ? [] : ["vcr_data_plane_not_configured"]),
    ...(vcr.service.engineMismatch?.length ? ["vcr_engine_catalogue_mismatch"] : []),
  ];
  return {
    enabled: true, status: "ok", audience: config.vcrAudience,
    engine,
    // The one word a page reads: the engine is composed and not known to be down.
    engineAvailable: composed && engine !== "not_answering",
    ...(engine === "not_answering" && reading?.checkedAt ? { engineCheckedAt: reading.checkedAt } : {}),
    ...(warnings.length ? { warning: warnings[0], warnings } : {}),
  };
}
