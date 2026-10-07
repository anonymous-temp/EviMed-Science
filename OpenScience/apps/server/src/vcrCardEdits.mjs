/**
 * The structured cards a person edits on a study's page: the population's
 * settings, a trial design's settings and the numbers inside the study's
 * inclusion and exclusion criteria (plan 2026-10-07 §8.4 item 6).
 *
 * An assumption card has always been editable on the page. These are the other
 * three objects the study rests on, and they follow the same rule: **an edit is
 * the object's next version, written through the stores the conversation's own
 * write goes through** (`savePopulation`, `saveTrialScenario`,
 * `saveProtocolVersion`) — never through the runtime gateway, which is the
 * model's door — and what was computed from the old version is marked stale and
 * recomputed by the orchestrator, exactly as after an edited assumption.
 *
 * Hidden knowledge:
 *
 * - **Only numbers, and only the ones the engine reads.** A person changes
 *   `n`, a mean, a hazard ratio, an alpha, a threshold; what a setting *is* —
 *   which distribution, which design, which operator — is the conversation's
 *   (the model writes structure, the researcher tunes values). So the editable
 *   list is read off the stored object's own numeric leaves through a closed
 *   table of names; a number the table does not name is not offered, and a path
 *   the list does not hold is refused. No free-form path ever reaches a stored
 *   object.
 * - **The edit is checked by the planner that would run it.** An edited design
 *   or population goes through `vcrBuildStages` — the function that turns an
 *   object into engine jobs and refuses what the engine would refuse — before
 *   anything is written, so a value the schema rejects (an alpha above one half
 *   for a one-sided design, a negative standard deviation) is refused here in
 *   one Chinese sentence and the object is not versioned. A criterion's
 *   requirement is checked by the domain's `validateRequirement`, the grammar
 *   the evaluator reads.
 * - **A person's edit is a reviewed version.** The version carries
 *   `reviewed`, like an assumption card the page edits; 「AI 设定」 stays on what
 *   the model wrote.
 * - **Only the newest version is edited.** An object that has a newer version
 *   is refused (`vcr_card_not_current`): editing the past would write a version
 *   newer than the one a reader is looking at.
 *
 * @module vcrCardEdits
 */

import { VCR_JOB_METHODS, validateRequirement, validateScenario } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { vcrObjectNode } from "./vcrStore.mjs";
import { vcrBuildStages } from "./vcrOrchestrator.mjs";

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** The most settings one object offers: a form is not a spreadsheet. */
export const VCR_CARD_SETTINGS_MAX = 40;

/** The kinds of card a person edits. */
export const VCR_CARD_KINDS = Object.freeze(["population", "trial_scenario", "criteria"]);

/**
 * A trial design's settings, by the path inside its configuration: the reader's
 * name, the unit and the closed range a person may type (the engine's schema is
 * the real check; this keeps an obviously wrong number out of the form).
 * @type {Readonly<Record<string, { label: string, unit?: string, integer?: boolean, min?: number, max?: number }>>}
 */
const DESIGN_SETTINGS = Object.freeze({
  "design.nTreat": { label: "试验组人数", unit: "人", integer: true, min: 1 },
  "design.nControl": { label: "对照组人数", unit: "人", integer: true, min: 1 },
  "design.n": { label: "样本量", unit: "例", integer: true, min: 1 },
  "design.n1": { label: "第一阶段人数", unit: "例", integer: true, min: 1 },
  "design.r1": { label: "第一阶段有效例数界值", unit: "例", integer: true, min: 0 },
  "design.r": { label: "有效例数界值", unit: "例", integer: true, min: 0 },
  "design.maxN": { label: "最大样本量", unit: "例", integer: true, min: 2 },
  "design.events": { label: "目标事件数", unit: "例", integer: true, min: 1 },
  "design.allocation": { label: "试验组分配比例", min: 0, max: 1 },
  "truth.hazardRatio": { label: "真实风险比", min: 0 },
  "truth.controlMedian": { label: "对照组中位生存时间", min: 0 },
  "truth.controlRate": { label: "对照组事件率", min: 0, max: 1 },
  "truth.treatmentRate": { label: "试验组事件率", min: 0, max: 1 },
  "truth.riskDifference": { label: "风险差", min: -1, max: 1 },
  "truth.oddsRatio": { label: "比值比", min: 0 },
  "truth.effect": { label: "处理效应" },
  "truth.sd": { label: "结局标准差", min: 0 },
  "truth.baselineCorrelation": { label: "与基线测量的相关", min: -1, max: 1 },
  "truth.nullRate": { label: "无效时的响应率", min: 0, max: 1 },
  "truth.responseRate": { label: "真实响应率", min: 0, max: 1 },
  "truth.alternativeRate": { label: "有效时的响应率", min: 0, max: 1 },
  "analysis.alpha": { label: "显著性水平 α", min: 0, max: 0.5 },
  "analysis.power": { label: "目标功效", min: 0, max: 1 },
  "accrual.duration": { label: "入组时长", min: 0 },
  "accrual.followup": { label: "随访时长", min: 0 },
  "accrual.dropoutAnnual": { label: "每年脱落比例", min: 0, max: 1 },
  cost: { label: "成本", unit: "万元", min: 0 },
});

/** What a generated variable's parameters are called. */
const PARAMETER_LABELS = Object.freeze(/** @type {Record<string, { label: string, min?: number, max?: number }>} */ ({
  mean: { label: "均数" }, sd: { label: "标准差", min: 0 }, meanlog: { label: "对数均数" }, sdlog: { label: "对数标准差", min: 0 },
  prob: { label: "比例", min: 0, max: 1 }, proportion: { label: "比例", min: 0, max: 1 }, alpha: { label: "形状 α", min: 0 }, beta: { label: "形状 β", min: 0 },
  shape: { label: "形状", min: 0 }, rate: { label: "速率", min: 0 }, min: { label: "下限" }, max: { label: "上限" },
}));

/** What a criterion's numbers are called, by their key inside the requirement. */
const REQUIREMENT_LABELS = Object.freeze(/** @type {Record<string, { label: string, unit?: string, integer?: boolean, min?: number }>} */ ({
  value: { label: "界值" }, days: { label: "时间窗", unit: "天", integer: true, min: 0 }, "window.days": { label: "证据时效", unit: "天", integer: true, min: 0 },
}));

/**
 * One editable setting, as the page's form reads it.
 * @typedef {{ path: string, label: string, value: number, unit: string | null, integer: boolean, min: number | null, max: number | null }} VcrSetting
 */

/** @param {string} label @param {number} value @param {{ unit?: string, integer?: boolean, min?: number, max?: number }} rule @param {string} path @returns {VcrSetting} */
const setting = (path, label, value, rule) => ({
  path, label, value, unit: rule.unit ?? null, integer: rule.integer === true, min: finite(rule.min) ? Number(rule.min) : null, max: finite(rule.max) ? Number(rule.max) : null,
});

/** @param {string} text @param {number} [max] */
const clip = (text, max = 28) => ([...String(text ?? "")].length > max ? `${[...String(text)].slice(0, max - 1).join("")}…` : String(text ?? ""));

/**
 * The numbers of a population definition a person may change: how many records
 * are generated, and each declared variable's parameters.
 * @param {Record<string, any>} population a `populations` row
 * @returns {VcrSetting[]}
 */
export function populationSettings(population) {
  const definition = object(population.definition);
  /** @type {VcrSetting[]} */
  const out = [];
  if (population.kind === "scenario") {
    if (finite(definition.n)) out.push(setting("n", "生成记录数", definition.n, { unit: "条", integer: true, min: 1 }));
    for (const [index, variable] of list(object(definition.population).variables).entries()) {
      const entry = object(variable);
      for (const [key, rule] of Object.entries(PARAMETER_LABELS)) {
        if (finite(entry[key])) out.push(setting(`population.variables.${index}.${key}`, `${clip(String(entry.name ?? `变量 ${index + 1}`), 20)} ${rule.label}`, entry[key], rule));
      }
    }
  } else if (population.kind === "literature") {
    if (finite(definition.n)) out.push(setting("n", "生成记录数", definition.n, { unit: "条", integer: true, min: 1 }));
    for (const [index, row] of list(definition.baselineTable).entries()) {
      const entry = object(row);
      for (const key of ["mean", "sd", "proportion", "min", "max"]) {
        const rule = PARAMETER_LABELS[key];
        if (finite(entry[key])) out.push(setting(`baselineTable.${index}.${key}`, `${clip(String(entry.variable ?? `变量 ${index + 1}`), 20)} ${rule.label}`, entry[key], rule));
      }
    }
  }
  return out.slice(0, VCR_CARD_SETTINGS_MAX);
}

/**
 * A trial design's editable numbers, read off its configuration through the closed table.
 * @param {Record<string, any>} scenario a `trial_scenarios` row
 * @returns {VcrSetting[]}
 */
export function designSettings(scenario) {
  const configuration = object(scenario.configuration);
  /** @type {VcrSetting[]} */
  const out = [];
  for (const [path, rule] of Object.entries(DESIGN_SETTINGS)) {
    const value = path.split(".").reduce((node, key) => object(node)[key], /** @type {any} */ (configuration));
    if (finite(value)) out.push(setting(path, rule.label, value, rule));
  }
  return out;
}

/**
 * The numbers inside the criteria's requirements: one entry per criterion that has a threshold or a time window, named by the
 * protocol's own sentence so the form reads as the criterion does.
 * @param {ReadonlyArray<Record<string, any>>} criteria
 * @returns {VcrSetting[]}
 */
export function criteriaSettings(criteria) {
  /** @type {VcrSetting[]} */
  const out = [];
  for (const [index, criterion] of criteria.entries()) {
    const requirement = object(criterion.requirement);
    const name = clip(String(criterion.sourceText || `条件 ${index + 1}`));
    for (const [key, rule] of Object.entries(REQUIREMENT_LABELS)) {
      const value = key.split(".").reduce((node, part) => object(node)[part], /** @type {any} */ (requirement));
      if (finite(value)) out.push(setting(`${index}.requirement.${key}`, `${name} · ${rule.label}`, value, rule));
    }
  }
  return out.slice(0, VCR_CARD_SETTINGS_MAX);
}

/**
 * Check a typed value against its setting: a whole number where one is asked for, inside the closed range.
 * @param {VcrSetting} entry @param {unknown} value
 */
function checkedValue(entry, value) {
  if (!finite(value)) throw new HttpError(422, "vcr_card_edit_refused", `“${entry.label}”要填一个数字。`);
  const number = /** @type {number} */ (value);
  if (entry.integer && !Number.isInteger(number)) throw new HttpError(422, "vcr_card_edit_refused", `“${entry.label}”要填整数。`);
  if (entry.min !== null && number < entry.min) throw new HttpError(422, "vcr_card_edit_refused", `“${entry.label}”不能小于 ${entry.min}。`);
  if (entry.max !== null && number > entry.max) throw new HttpError(422, "vcr_card_edit_refused", `“${entry.label}”不能大于 ${entry.max}。`);
  return number;
}

/**
 * Write `value` at a dotted path of a copy of `root` (an array index is a number segment). The path was taken from the
 * object's own settings, so every segment exists; one that does not is refused.
 * @param {any} root @param {string} path @param {number} value
 */
function setAt(root, path, value) {
  const keys = path.split(".");
  let node = root;
  for (const key of keys.slice(0, -1)) {
    node = node?.[Array.isArray(node) ? Number(key) : key];
    if (node === undefined || node === null || typeof node !== "object") throw new HttpError(422, "vcr_card_edit_refused", "这项设定已经不在对象里了，刷新后再改。");
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * @param {Record<string, any>} set what the person typed, by setting path
 * @param {readonly VcrSetting[]} offered what the object offers
 * @returns {Array<{ entry: VcrSetting, value: number }>} the changes that are actual changes
 */
function changesOf(set, offered) {
  const asked = Object.entries(object(set));
  if (!asked.length) throw new HttpError(400, "vcr_card_edit_empty", "没有要改的设定。");
  if (asked.length > VCR_CARD_SETTINGS_MAX) throw new HttpError(400, "vcr_card_edit_refused", "一次改的设定太多了。");
  const changes = [];
  for (const [path, value] of asked) {
    const entry = offered.find((candidate) => candidate.path === path);
    if (!entry) throw new HttpError(422, "vcr_card_edit_refused", "这里没有这项设定。");
    const number = checkedValue(entry, value);
    if (number !== entry.value) changes.push({ entry, value: number });
  }
  if (!changes.length) throw new HttpError(409, "vcr_card_edit_unchanged", "没有改动。");
  return changes;
}

/** The settings of the object a planner dry-run is about. @param {{ kind: string, row: Record<string, any> }} item */
function settingsOf(item) {
  return item.kind === "population" ? populationSettings(item.row) : designSettings(item.row);
}

/**
 * The objects a card edit reads and writes. `matchStore` writes a protocol with its criteria's applicability in one
 * transaction (the gateway's own write); a store without it writes what the study store can.
 * @param {{ store: any, matchStore?: any, orchestrator?: any, audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown> | unknown }} dependencies
 */
export function createVcrCardEdits({ store, matchStore = null, orchestrator = null, audit = () => {} }) {
  /**
   * The object a card names, and its settings.
   * @param {any} study @param {string} kind @param {string | null} objectId
   */
  async function target(study, kind, objectId) {
    if (kind === "population") {
      const populations = await store.populations(study.id, 20);
      const current = populations[0] ?? null;
      if (!current) throw new HttpError(404, "vcr_card_not_found", "这个研究还没有人群。");
      if (objectId && objectId !== current.id) throw new HttpError(409, "vcr_card_not_current", "人群已经有新版本了，刷新后再改。");
      return { kind, row: current, settings: populationSettings(current), title: "人群设定" };
    }
    if (kind === "trial_scenario") {
      const scenarios = await store.trialScenarios(study.id, 60);
      const found = scenarios.find((/** @type {any} */ row) => row.id === objectId) ?? null;
      if (!found) throw new HttpError(404, "vcr_card_not_found", "没有找到这个方案。");
      const newest = scenarios.filter((/** @type {any} */ row) => (row.label || row.id) === (found.label || found.id)).sort((/** @type {any} */ a, /** @type {any} */ b) => b.version - a.version)[0];
      if (newest.id !== found.id) throw new HttpError(409, "vcr_card_not_current", "这个方案已经有新版本了，刷新后再改。");
      return { kind, row: found, settings: designSettings(found), title: found.label || "试验方案" };
    }
    const protocol = await store.latestProtocolVersion(study.id);
    if (!protocol) throw new HttpError(404, "vcr_card_not_found", "这个研究还没有入排条件。");
    const criteria = matchStore?.listCriteria ? await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }) : await store.criteria(protocol.id);
    return { kind, row: protocol, criteria, settings: criteriaSettings(criteria), title: "入排条件" };
  }

  /** What the page's form is built from. @param {any} study @param {string} kind @param {string | null} objectId */
  async function read(study, kind, objectId) {
    const found = await target(study, kind, objectId);
    return { kind, objectId: String(found.row.id), title: found.title, settings: found.settings };
  }

  /**
   * Version the object with the typed numbers, mark what was computed from the old version stale and let the programme
   * recompute it. Answers what was written.
   * @param {any} study @param {{ id: string }} user @param {{ kind: string, objectId?: string | null, set: Record<string, any> }} edit
   */
  async function apply(study, user, edit) {
    const found = await target(study, edit.kind, edit.objectId ?? null);
    const changes = changesOf(edit.set, found.settings);
    const actor = String(user.id);
    /** @type {{ id: string, version: number }} */
    let saved;
    /** @type {string[]} */
    let changed;
    /** @type {string} */
    let step;
    /** @type {string} */
    let reason;

    if (edit.kind === "population") {
      const definition = structuredClone(object(found.row.definition));
      for (const { entry, value } of changes) setAt(definition, entry.path, value);
      await refuseIfPlannerRefuses(study, { step: "population", kind: "population", row: { ...found.row, definition } });
      saved = await store.savePopulation({
        studyId: study.id, userId: study.userId, name: found.row.name, kind: found.row.kind, definition, snapshotId: found.row.snapshotId,
        allowedUses: found.row.allowedUses, reviewState: "reviewed", profile: {}, quality: {}, waterfall: [],
      });
      changed = [vcrObjectNode("population", found.row)];
      step = "population";
      reason = "criterion_changed";
    } else if (edit.kind === "trial_scenario") {
      const configuration = structuredClone(object(found.row.configuration));
      for (const { entry, value } of changes) setAt(configuration, entry.path, value);
      await refuseIfPlannerRefuses(study, { step: "trial", kind: "trial_scenario", row: { ...found.row, configuration } });
      saved = await store.saveTrialScenario({
        studyId: study.id, userId: study.userId, label: found.row.label, design: found.row.design, endpointType: found.row.endpointType,
        configuration, assumptionIds: found.row.assumptionIds, comparatorId: found.row.comparatorId,
      });
      changed = [vcrObjectNode("trial_scenario", found.row)];
      step = "trial";
      reason = "protocol_revised";
    } else {
      const criteria = structuredClone(found.criteria).map((/** @type {any} */ criterion) => ({ ...criterion }));
      for (const { entry, value } of changes) {
        const [index, ...rest] = entry.path.split(".");
        setAt(criteria[Number(index)], rest.join("."), value);
      }
      for (const [index, criterion] of criteria.entries()) {
        const problems = validateRequirement(criterion.requirement, { path: `criteria[${index}].requirement` });
        if (problems.length) throw new HttpError(422, "vcr_card_edit_refused", `这条入排条件改完以后不成立：${problems[0].detail}。`);
      }
      const writer = matchStore?.saveProtocolVersion ? matchStore : store;
      saved = await writer.saveProtocolVersion({
        studyId: study.id, userId: study.userId, title: found.row.title ?? "", sourceRef: found.row.sourceRef ?? null, usdm: found.row.usdm ?? {},
        criteria: criteria.map((/** @type {any} */ criterion) => ({
          kind: criterion.kind, criterionType: criterion.criterionType, sourceText: criterion.sourceText, sourceLocator: criterion.sourceLocator,
          evidenceNeeded: criterion.evidenceNeeded, requirement: criterion.requirement, applicability: criterion.applicability ?? null, reviewState: "reviewed",
        })),
      });
      changed = [`protocol_version:${saved.id}@${saved.version}`];
      step = "population";
      reason = "criterion_changed";
    }

    await Promise.resolve(audit("vcr.card.edit", "completed", { userId: actor, projectId: study.projectId, code: study.id, detail: `${edit.kind}:${changes.length}` })).catch(() => null);
    // The edited step is asked for: a person who changed a number wants the result under it.
    await store.setStep(study.id, step, { requested: true }).catch(() => null);
    if (orchestrator?.recomputeAfterChange) {
      await orchestrator.recomputeAfterChange({ studyId: study.id, changed, reason, detail: { by: actor, what: edit.kind } }).catch(() => null);
    }
    return { kind: edit.kind, id: String(saved.id), version: Number(saved.version), changed: changes.length };
  }

  /**
   * Refuse, in one sentence, an object the planner would refuse to turn into a job. A plan that waits (for another stage's
   * result) is not a refusal.
   * @param {any} study @param {{ step: string, kind: string, row: Record<string, any> }} item
   */
  async function refuseIfPlannerRefuses(study, item) {
    const [definition, assumptions, populations, scenarios, grid, models] = await Promise.all([
      store.latestDefinition(study.id), store.assumptions(study.id), store.populations(study.id, 20), store.trialScenarios(study.id, 60),
      store.latestDesignGrid(study.id), store.models(study.userId),
    ]);
    const plan = vcrBuildStages(item, { study, definition, assumptions, populations, scenarios, grid, analytic: null, analyticJob: null, models });
    if (plan.ok === false) {
      if ("waiting" in plan) return;
      const message = "refused" in plan ? plan.refused.message : "unavailable" in plan ? plan.unavailable.reason : "";
      throw new HttpError(422, "vcr_card_edit_refused", `这样改引擎不会接受：${message || "设定不成立"}`);
    }
    // The planner projects the object onto what each stage reads; the schema the engine validates against is what says a value is
    // allowed. The same `validateScenario` the job queue applies, so a number the queue would refuse is refused here, by the setting's name.
    for (const stage of plan.stages) {
      const method = /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[stage.jobKind];
      const issues = method ? validateScenario(method, stage.scenario) : [];
      if (issues.length) {
        const field = String(issues[0].field ?? "").replace(/^scenario\.?/, "").replace(/\[(\d+)\]/g, ".$1");
        const named = settingsOf(item).find((entry) => entry.path === field || field.startsWith(`${entry.path}.`));
        throw new HttpError(422, "vcr_card_edit_refused", named ? `“${named.label}”这样填引擎不会接受，没有保存。` : "这样改引擎不会接受，没有保存。");
      }
    }
  }

  return { read, apply };
}
