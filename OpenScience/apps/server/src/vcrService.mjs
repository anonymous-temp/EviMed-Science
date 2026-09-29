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

import {
  VCR_COMPARABILITY_DIMENSIONS, VCR_COMPARATOR_ROUTES, VCR_COUNT_KEYS, VCR_DATA_TIERS, VCR_E10_CONDITIONS,
  VCR_ENGINE_METHODS, VCR_INTENDED_USES, VCR_MIN_CELL_SIZE, VCR_ROUTE_MIN_TIER, VCR_STEPS, VCR_STEP_CAPABILITIES,
  VCR_TABS, intendedUseCeiling, reviewStateFor, useWithin,
} from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_DEFAULT_STUDY_NAME, vcrObjectNode } from "./vcrStore.mjs";
import { vcrSealState } from "./vcrSeal.mjs";

export { VCR_DEFAULT_STUDY_NAME };

/** Items one runtime read returns at most. */
export const VCR_READ_MAX_ITEMS = 50;

/** What a runtime read may ask for. Closed; the MCP tool's schema copies it. */
export const VCR_READ_WHATS = Object.freeze([
  "study", "definition", "criteria", "assumptions", "population", "patients", "comparator", "trial",
  "precedents", "matching", "results", "snapshot_profile", "models", "jobs", "trial_registry_record",
]);

/**
 * What a runtime write may write. Definitions, conditions, assumptions,
 * designs, decisions and report text — never a result number, a count or an
 * execution record (build contract §3.2). Those come from the engine, and a
 * model that could write them could write anything.
 */
export const VCR_WRITE_WHATS = Object.freeze([
  "definition", "protocol", "criteria", "assumption", "population", "patient_set", "comparator",
  "trial_scenario", "design_grid", "decision", "report", "model", "forecast", "step",
]);

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {number} status @param {string} code @param {string} message */
const failure = (status, code, message) => new HttpError(status, code, message);

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
      inputs: Object.freeze(["均值", "标准差", "处理效应", "脱落率", "入组节奏"]),
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
      inputs: Object.freeze(["事件率", "处理效应（OR / RR / RD）", "脱落率", "入组节奏"]),
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
      inputs: Object.freeze(["基线风险函数", "风险比或加速因子", "随访时长", "删失机制", "入组节奏"]),
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
 * @param {{ store: import("./vcrStore.mjs").VcrStore, engine?: any, report?: (code: string) => void }} dependencies
 * @returns {Promise<{ methods: number, models: number, engineMismatch: readonly string[] | null }>}
 */
export async function seedVcrCatalogue({ store, engine = null, report = () => {} }) {
  await store.ready();
  let methods = 0;
  for (const [method, entry] of Object.entries(VCR_ENGINE_METHODS)) {
    await store.saveMethod({
      method, version: entry.version, endpoints: [...entry.endpoints], crossChecks: [...entry.crossChecks],
      assumptions: [], numericTests: {},
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
    return { route, minimumTier: minimum, available: order >= 0 && needed >= 0 && order >= needed };
  });
}

export class VcrService {
  /**
   * @param {{ store: import("./vcrStore.mjs").VcrStore, config: Record<string, any>, engine?: any, now?: () => Date,
   *   metricName?: ((id: string) => string | null) | null,
   *   access?: any, dataPlane?: any, evidence?: any, matching?: any, jobs?: any, seal?: any }} options
   */
  constructor({ store, config, engine = null, now = () => new Date(), metricName = null,
    access = null, dataPlane = null, evidence = null, matching = null, jobs = null, seal = null }) {
    if (!store || !config) throw new TypeError("The VCR service needs its store and the config.");
    this.store = store;
    this.config = config;
    this.engine = engine;
    this.now = now;
    this.metricName = metricName;
    /** The packages that are not this one's, read at request time. */
    this.packages = { access, dataPlane, evidence, matching, jobs, seal };
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

  /** `GET /api/vcr/studies`. @param {{ id: string }} user */
  async listStudies(user) {
    const studies = await this.store.listStudies(String(user.id));
    const rows = await Promise.all(studies.map(async (study) => {
      const [results, stale, jobs, budget] = await Promise.all([
        this.store.results(study.id),
        this.store.staleMarks(study.id),
        this.store.jobs(study.id, 20),
        this.packages.jobs?.budgetOf ? this.packages.jobs.budgetOf(study.id).catch(() => null) : null,
      ]);
      const headline = results.find((result) => result.kind === "trial_scenario") ?? results[0] ?? null;
      const attention = [
        ...(stale.length ? [{ kind: "stale", count: stale.length, text: `${stale.length} 项结果已过期` }] : []),
        ...(jobs.some((job) => job.state === "awaiting_budget")
          ? [{ kind: "budget_confirm", count: jobs.filter((job) => job.state === "awaiting_budget").length, text: "有计算等待预算确认" }] : []),
        ...(results.some((result) => result.conclusion === "not_estimable")
          ? [{ kind: "not_estimable", count: results.filter((result) => result.conclusion === "not_estimable").length, text: "有结论为不可估计" }] : []),
      ];
      return {
        id: study.id, projectId: study.projectId, name: study.name, question: study.question,
        dataTier: study.dataTier, intendedUse: study.intendedUse, status: study.status,
        steps: study.steps,
        progress: this.#progress(study),
        headline: headline ? {
          kind: headline.kind, conclusion: headline.conclusion, counts: vcrCountBand(headline.counts),
          measures: headline.measures.slice(0, 3), intendedUse: headline.intendedUse,
        } : null,
        attention,
        runningJobs: jobs.filter((job) => ["queued", "running"].includes(job.state)).length,
        budget,
        createdAt: study.createdAt, updatedAt: study.updatedAt,
      };
    }));
    return { studies: rows, dataTiers: [...VCR_DATA_TIERS], intendedUses: [...VCR_INTENDED_USES] };
  }

  /** The seven-step rail, as the page draws it. @param {any} study */
  #progress(study) {
    return VCR_STEPS.map((step) => ({
      step,
      status: study.steps?.[step]?.status ?? "none",
      requested: study.steps?.[step]?.requested === true,
      capability: /** @type {Record<string, string>} */ (VCR_STEP_CAPABILITIES)[step],
      note: study.steps?.[step]?.note ?? null,
    }));
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

  /** `PATCH /api/vcr/studies/:id`. @param {{ id: string }} user @param {string} id @param {Record<string, any>} patch */
  async updateStudy(user, id, patch) {
    const study = await this.requireStudy(user, id);
    const updated = await this.store.updateStudy(study.id, patch, String(user.id));
    if (!updated) throw failure(404, "vcr_study_not_found", "Study not found.");
    return updated;
  }

  /** `DELETE /api/vcr/studies/:id`. @param {{ id: string }} user @param {string} id */
  async deleteStudy(user, id) {
    const study = await this.requireStudy(user, id);
    await this.store.softDeleteStudy(study.id, String(user.id));
    return { id: study.id, projectId: study.projectId, deleted: true };
  }

  // --- the study page --------------------------------------------------------------

  /** `GET /api/vcr/studies/:id`. @param {{ id: string }} user @param {string} id */
  async studyView(user, id) {
    return this.studyViewOf(await this.requireStudy(user, id));
  }

  /** @param {any} study */
  async studyViewOf(study) {
    const [definition, results, stale, reviews, jobs, budget, assumptions, members, exports] = await Promise.all([
      this.store.latestDefinition(study.id),
      this.store.results(study.id),
      this.store.staleMarks(study.id),
      this.store.reviews(study.id),
      this.store.jobs(study.id, 20),
      this.packages.jobs?.budgetOf ? this.packages.jobs.budgetOf(study.id).catch(() => null) : null,
      this.store.assumptions(study.id),
      this.store.members(study.id),
      this.store.exports(study.id),
    ]);
    const headline = results.find((result) => result.kind === "trial_scenario") ?? results[0] ?? null;
    const seal = vcrSealState(study);
    const ceiling = await this.#useCeiling(study, results);
    return {
      id: study.id, projectId: study.projectId, name: study.name, question: study.question,
      dataTier: study.dataTier, intendedUse: study.intendedUse, status: study.status,
      steps: study.steps, progress: this.#progress(study), tabs: [...VCR_TABS],
      definition,
      counts: vcrCountBand(object(headline?.counts)),
      results: results.map((result) => this.#resultView(result, stale)),
      conclusion: headline?.conclusion ?? null,
      seal,
      review: this.#reviewView(reviews, results, stale),
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
   * The highest use this study's results can be labelled with, and why. The
   * weakest model decides (§8.2); an unreviewed study cannot claim
   * `specified_analysis` or above (§10.2, AC-21).
   * @param {any} study @param {any[]} results
   */
  async #useCeiling(study, results) {
    /** @type {string[]} */
    const tiers = [];
    for (const result of results) {
      for (const model of [...list(object(result.diagnostics).modelsUsed), ...list(object(result.useDowngrade).models)]) {
        const tier = String(object(model).tier ?? "");
        if (tier) tiers.push(tier);
      }
    }
    const modelCeiling = intendedUseCeiling(tiers);
    const reviews = await this.store.reviews(study.id);
    const reviewed = reviews.length > 0;
    // 「导出不因为未复核而被拦，但未复核的研究包不能标『指定研究分析』及以上」.
    const reviewCeiling = reviewed ? "submission_preparation" : "design_support";
    const ceiling = useWithin(modelCeiling, reviewCeiling) ? modelCeiling : reviewCeiling;
    return {
      ceiling,
      requested: study.intendedUse,
      withinCeiling: useWithin(study.intendedUse, ceiling),
      reasons: [
        ...(useWithin(modelCeiling, "specified_analysis") && modelCeiling !== "submission_preparation"
          ? [{ code: "model_tier", detail: `所用模型的层级最高支持「${modelCeiling}」` }] : []),
        ...(reviewed ? [] : [{ code: "not_reviewed", detail: "尚无复核签注：未复核的研究包不能标「指定研究分析」及以上" }]),
      ],
    };
  }

  /** @param {any[]} reviews @param {any[]} results @param {any[]} stale */
  #reviewView(reviews, results, stale) {
    const staleNodes = new Set(stale.map((mark) => String(mark.node)));
    const current = results.map((result) => `result:${result.id}@${result.version}`);
    return {
      records: reviews.map((review) => ({
        ...review,
        // A review countersigns one version; if any of them moved it reads
        // `changed_after_review` (AC-21). The node list is what moved, not the
        // review, which is why the state is derived and never stored.
        state: review.nodes.some((node) => staleNodes.has(node))
          ? "changed_after_review"
          : reviewStateFor({ reviewedNodes: review.nodes, currentNodes: [...new Set([...current, ...review.nodes.filter((node) => !staleNodes.has(node))])] }),
      })),
      reviewed: reviews.length > 0,
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
   * `GET /api/vcr/studies/:id/:tab`.
   * @param {{ id: string }} user @param {string} id @param {string} tab
   */
  async tab(user, id, tab) {
    if (!VCR_TABS.includes(tab)) throw failure(404, "vcr_tab_not_found", `tab must be one of: ${VCR_TABS.join(", ")}.`);
    const study = await this.requireStudy(user, id);
    this.counters.tabs += 1;
    switch (tab) {
      case "overview": return this.studyViewOf(study);
      case "population": return this.#populationTab(study);
      case "patients": return this.#patientsTab(study);
      case "comparator": return this.#comparatorTab(study);
      case "trial": return this.#trialTab(study);
      case "matching": return this.#matchingTab(study, user);
      default: return this.#dataTab(study, user);
    }
  }

  /** @param {any} study */
  async #populationTab(study) {
    const [populations, results, stale] = await Promise.all([
      this.store.populations(study.id), this.store.results(study.id, "population"), this.store.staleMarks(study.id),
    ]);
    const current = populations[0] ?? null;
    return {
      tab: "population", studyId: study.id, dataTier: study.dataTier,
      current: current ? {
        ...current,
        node: vcrObjectNode("population", current),
        counts: vcrCountBand(current.counts),
        result: results.find((result) => result.id === current.resultId)
          ? this.#resultView(/** @type {any} */ (results.find((result) => result.id === current.resultId)), stale) : null,
      } : null,
      versions: populations.map((population) => ({ id: population.id, version: population.version, kind: population.kind,
        name: population.name, counts: vcrCountBand(population.counts), reviewState: population.reviewState, createdAt: population.createdAt })),
      results: results.map((result) => this.#resultView(result, stale)),
      dataPlane: await this.#dataPlaneNote(study),
    };
  }

  /** @param {any} study */
  async #patientsTab(study) {
    const [sets, results, stale, models] = await Promise.all([
      this.store.patientSets(study.id), this.store.results(study.id, "patient_set"), this.store.staleMarks(study.id),
      this.store.models(study.userId),
    ]);
    const current = sets[0] ?? null;
    return {
      tab: "patients", studyId: study.id,
      current: current ? {
        ...current, node: vcrObjectNode("patient_set", current), counts: vcrCountBand(current.counts),
        model: models.find((model) => model.name === current.modelId || model.id === current.modelId) ?? null,
      } : null,
      versions: sets.map((set) => ({ id: set.id, version: set.version, name: set.name, twinLabel: set.twinLabel,
        counts: vcrCountBand(set.counts), createdAt: set.createdAt })),
      results: results.map((result) => this.#resultView(result, stale)),
      models,
    };
  }

  /** @param {any} study */
  async #comparatorTab(study) {
    const [designs, results, stale] = await Promise.all([
      this.store.comparatorDesigns(study.id), this.store.results(study.id, "comparator"), this.store.staleMarks(study.id),
    ]);
    const current = designs[0] ?? null;
    return {
      tab: "comparator", studyId: study.id, dataTier: study.dataTier,
      routes: vcrRouteOptions(study.dataTier),
      comparabilityDimensions: [...VCR_COMPARABILITY_DIMENSIONS],
      e10Conditions: [...VCR_E10_CONDITIONS],
      current: current ? { ...current, node: vcrObjectNode("comparator", current) } : null,
      versions: designs.map((design) => ({ id: design.id, version: design.version, route: design.route, estimand: design.estimand,
        conclusion: design.conclusion, reviewState: design.reviewState, createdAt: design.createdAt })),
      results: results.map((result) => this.#resultView(result, stale)),
    };
  }

  /** @param {any} study */
  async #trialTab(study) {
    const [scenarios, results, stale, grid, forecasts] = await Promise.all([
      this.store.trialScenarios(study.id), this.store.results(study.id, "trial_scenario"), this.store.staleMarks(study.id),
      this.store.latestDesignGrid(study.id), this.store.forecasts(study.id),
    ]);
    const views = scenarios.map((scenario) => ({
      ...scenario,
      node: vcrObjectNode("trial_scenario", scenario),
      result: (() => {
        const result = results.find((row) => row.id === scenario.resultId);
        return result ? this.#resultView(result, stale) : null;
      })(),
    }));
    return {
      tab: "trial", studyId: study.id,
      scenarios: views,
      // Dominated on every measure of the team's own comparison goal — a
      // deterministic judgment, and the ordering is the team's, never the
      // platform's (plan §5.4).
      dominated: grid?.comparisonGoal ? vcrDominatedScenarios(views, grid.comparisonGoal) : [],
      grid,
      forecasts,
      results: results.map((result) => this.#resultView(result, stale)),
    };
  }

  /** @param {any} study @param {{ id: string }} user */
  async #matchingTab(study, user) {
    const matching = this.packages.matching;
    if (matching?.tab) return { tab: "matching", studyId: study.id, ...(await matching.tab(study, user)) };
    const protocol = await this.store.latestProtocolVersion(study.id);
    return {
      tab: "matching", studyId: study.id, protocol,
      available: false,
      unavailable: { code: "vcr_matching_unavailable", message: "匹配与招募在本部署尚未接入；其余步骤照常。" },
      criteria: protocol ? await this.store.criteria(protocol.id) : [],
    };
  }

  /** @param {any} study @param {{ id: string }} user */
  async #dataTab(study, user) {
    const [assumptions, definition, seal] = await Promise.all([
      this.store.assumptions(study.id), this.store.latestDefinition(study.id), Promise.resolve(vcrSealState(study)),
    ]);
    const dataPlane = this.packages.dataPlane?.tab ? await this.packages.dataPlane.tab(study, user).catch(() => null) : null;
    const evidence = this.packages.evidence?.tab ? await this.packages.evidence.tab(study, user).catch(() => null) : null;
    return {
      tab: "data", studyId: study.id, dataTier: study.dataTier,
      definition, assumptions, seal,
      minCellSize: VCR_MIN_CELL_SIZE,
      data: dataPlane ?? { available: false, code: "vcr_data_plane_unavailable",
        message: this.config.vcrDataPlaneDir ? "数据平面尚未接入本部署。" : "本部署未配置数据平面目录：T0 档以外的数据接入暂不可用。" },
      evidence: evidence ?? { available: false, code: "vcr_evidence_unavailable", message: "证据参数化在本部署尚未接入；假设卡仍可手工登记。" },
    };
  }

  /** @param {any} study */
  async #dataPlaneNote(study) {
    if (!this.packages.dataPlane?.note) {
      return { available: false, code: "vcr_data_plane_unavailable", message: "数据平面尚未接入本部署。" };
    }
    return this.packages.dataPlane.note(study).catch(() => ({ available: false, code: "vcr_data_plane_unavailable" }));
  }

  // --- cross-study pages --------------------------------------------------------------

  /** `GET /api/vcr/models`: the shared model and method library (plan §8.2). @param {{ id: string }} user */
  async modelLibrary(user) {
    const [models, methods] = await Promise.all([this.store.models(String(user.id)), this.store.methods()]);
    return {
      models, methods,
      engineAvailable: Boolean(this.engine?.configured?.()),
      // Advisory, never a block: a catalogue row the engine does not publish
      // is shown as 「引擎方法与目录不一致」 and the study goes on.
      engineMismatch: this.engineMismatch,
      intendedUses: [...VCR_INTENDED_USES],
    };
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
    const saved = await this.store.saveModel({
      userId: String(user.id), studyId: study?.id ?? null,
      name: String(input.name), version: String(input.version ?? "1.0.0"),
      tier: "literature", risk: String(input.risk ?? "low"), endpointType: input.endpointType ?? null,
      card: { ...object(input.card), type: "fitted_prediction_model", provider: study ? `研究 ${study.name}` : "虚拟临研" },
      applicability: { ...object(input.applicability), population: sources.length ? `来源试验的人群：${sources.join("、")}` : "来源试验的人群", sources },
      validation: object(input.validation),
      evidence: list(input.evidence).map(String),
    });
    await this.store.audit({ studyId: study?.id ?? null, userId: String(user.id), actor: String(user.id),
      action: "vcr.model.adopt", object: String(saved?.id ?? ""), detail: { name: String(input.name), tier: "literature" } });
    return saved;
  }

  /** `GET /api/vcr/precedents`: the trial-precedent search (package C's read model). @param {{ id: string }} user @param {Record<string, any>} query */
  async precedents(user, query) {
    const evidence = this.packages.evidence;
    if (!evidence?.precedents) {
      return { precedents: [], available: false, code: "vcr_evidence_unavailable",
        message: "试验先例库在本部署尚未接入。" };
    }
    return { ...(await evidence.precedents(user, query)), available: true };
  }

  // --- the runtime's read (build contract §3.2) ------------------------------------------

  /**
   * What a run may read. **Aggregates and structure only**: no row of any
   * person ever appears here, and a cell speaking for fewer than
   * `VCR_MIN_CELL_SIZE` people is suppressed by the data plane's own
   * `suppressSmallCells` before it leaves (plan §8.1, AC-26).
   *
   * @param {any} study @param {string} what @param {Record<string, any>} [filter]
   */
  async runtimeRead(study, what, filter = {}) {
    if (!VCR_READ_WHATS.includes(what)) {
      throw failure(400, "vcr_read_what_invalid", `what must be one of: ${VCR_READ_WHATS.join(", ")}.`);
    }
    this.counters.reads += 1;
    const limit = Math.min(VCR_READ_MAX_ITEMS, Math.max(1, Number(filter.limit ?? 20)));
    const suppress = this.packages.dataPlane?.suppressSmallCells ?? ((value) => value);
    switch (what) {
      case "study": {
        const [definition, stale, budget] = await Promise.all([
          this.store.latestDefinition(study.id), this.store.staleMarks(study.id),
          this.packages.jobs?.budgetOf ? this.packages.jobs.budgetOf(study.id).catch(() => null) : null,
        ]);
        return { study: { id: study.id, name: study.name, question: study.question, dataTier: study.dataTier,
          intendedUse: study.intendedUse, status: study.status, steps: study.steps }, definition, stale, budget,
        seal: vcrSealState(study) };
      }
      case "definition": return { definition: await this.store.latestDefinition(study.id),
        versions: (await this.store.definitionVersions(study.id)).map((version) => ({ version: version?.version, createdAt: version?.createdAt })) };
      case "criteria": {
        const protocol = await this.store.latestProtocolVersion(study.id);
        return { protocol, criteria: protocol ? await this.store.criteria(protocol.id) : [] };
      }
      case "assumptions": {
        const assumptions = await this.store.assumptions(study.id);
        return { assumptions: assumptions.slice(0, limit), more: assumptions.length > limit };
      }
      case "population": {
        const populations = await this.store.populations(study.id, limit);
        return { populations: await suppress(populations.map((population) => ({ ...population, counts: vcrCountBand(population.counts) }))) };
      }
      case "patients": return { patientSets: (await this.store.patientSets(study.id, limit)).map((set) => ({ ...set, counts: vcrCountBand(set.counts) })) };
      case "comparator": return { designs: await this.store.comparatorDesigns(study.id, limit), routes: vcrRouteOptions(study.dataTier) };
      case "trial": return { scenarios: await this.store.trialScenarios(study.id, limit), grid: await this.store.latestDesignGrid(study.id),
        forecasts: await this.store.forecasts(study.id) };
      case "results": {
        const results = await this.store.results(study.id, filter.kind ? String(filter.kind) : null);
        const stale = await this.store.staleMarks(study.id);
        return { results: results.slice(0, limit).map((result) => this.#resultView(result, stale)), more: results.length > limit };
      }
      case "jobs": return { jobs: await this.store.jobs(study.id, limit) };
      case "models": return { models: await this.store.models(study.userId), methods: await this.store.methods() };
      case "snapshot_profile": {
        const dataPlane = this.packages.dataPlane;
        if (!dataPlane?.runtimeProfile) {
          return { available: false, code: "vcr_data_plane_unavailable", message: "数据平面未接入：这一步暂不可用，其余步骤照常。" };
        }
        return dataPlane.runtimeProfile(study, filter);
      }
      case "matching": {
        const matching = this.packages.matching;
        if (!matching?.runtimeRead) {
          return { available: false, code: "vcr_matching_unavailable", message: "匹配与招募未接入：这一步暂不可用，其余步骤照常。" };
        }
        return matching.runtimeRead(study, filter);
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
 * on, and the schema is there. The engine not being composed is a warning, not
 * a failure — the study's AI steps and its conversation work without it (plan
 * §10.5).
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
  const warnings = [
    ...(vcr.engine?.configured?.() ? [] : ["vcr_engine_not_composed"]),
    ...(config.vcrDataPlaneDir ? [] : ["vcr_data_plane_not_configured"]),
    ...(vcr.service.engineMismatch?.length ? ["vcr_engine_catalogue_mismatch"] : []),
  ];
  return {
    enabled: true, status: "ok", audience: config.vcrAudience,
    engine: vcr.engine?.configured?.() ? "wired" : "missing",
    ...(warnings.length ? { warning: warnings[0], warnings } : {}),
  };
}

/** The module's metric families, for the dashboard. @param {any} service */
export function vcrMetricFamilies(service) {
  const counters = service?.metrics?.() ?? {};
  return [
    { name: "evimed_vcr_studies_created_total", type: "counter", help: "Studies created.", value: Number(counters.studiesCreated ?? 0) },
    { name: "evimed_vcr_runtime_reads_total", type: "counter", help: "Runtime gateway reads.", value: Number(counters.reads ?? 0) },
    { name: "evimed_vcr_runtime_writes_total", type: "counter", help: "Runtime gateway writes.", value: Number(counters.writes ?? 0) },
    { name: "evimed_vcr_runtime_write_issues_total", type: "counter", help: "Items a runtime write refused.", value: Number(counters.writeIssues ?? 0) },
    { name: "evimed_vcr_study_not_found_total", type: "counter", help: "Reads of a study this account cannot see.", value: Number(counters.notFound ?? 0) },
  ];
}
