/** Batch patient trajectory prediction: what leaves for a provider, and where every submitted person ends up.
 *
 * Hidden knowledge:
 *
 * - **Origin, availability, action context and horizon are four different things.** The origin is the instant the forecast is
 *   made for; an observation is usable only when it both happened (`occurredAt`) and was visible (`availableAt`) at or before it;
 *   the action context says where any treatment input comes from; the horizon is how far past the origin a row is asked for.
 *   `replayClinicalEvents` already cuts a frozen history at the origin; the projection here cuts again, so a history that was
 *   assembled some other way (an evaluation context, a later import) cannot put a post-origin lab value or a later-recorded
 *   medication into a request.
 * - **Three action sources.** `none` (a factual forecast: current care continues, no action is supplied), `supplied_schedule`
 *   (a conditional forecast under an explicit future schedule the person or an experiment wrote down: deployable, because the
 *   schedule is a hypothesis stated at the origin) and `logged_replay` (the schedule is what the record shows happened after
 *   the origin: information nobody had at the origin, so the result is an evaluation of the model given the actual actions and
 *   is never scored or labelled as a deployable forecast).
 * - **A provider names its inputs.** `inputCodes` (observations), `actionCodes` (medication and dose events) and
 *   `actionUnits` (the unit each action's dose is expressed in). An endpoint-only provider keeps the endpoint-only filter; an
 *   action-conditioned one (`actionCodes` non-empty) receives its actions or the subject is rejected by name, never silently
 *   forecast without them.
 * - **One person, one terminal line.** Every submitted subject ends `completed`, `rejected`, `failed` or `unprocessed`, each
 *   with a reason, and `submitted = completed + rejected + failed + unprocessed` is checked in code (`reconcileSubjects`
 *   throws on a break, so a bookkeeping bug can never show as a smaller batch). `unprocessed` is resumable: a cancel, a spent
 *   budget or a withdrawn grant leaves the rest of the batch counted, not forgotten. A completed person may have some horizons
 *   rejected (`partial`); a draw is a sample of one person's future, never a person.
 * - **Pure.** No store, no network; the provider and the longitudinal module call it.
 *
 * @module vcrTrajectoryBatch
 */
import { VCR_PREDICTION_MODES, VCR_UNIT_DIMENSIONS, assessModelUse, vcrUnitsConvertible } from '@evimed/domain';
import { finishPremises, modelUsePremises } from './vcrPremises.mjs';
import { predictionClaimOf, predictionClaimPremise } from '@evimed/domain';

export const TRAJECTORY_ACTION_SOURCES = Object.freeze(['none', 'supplied_schedule', 'logged_replay']);
export const TRAJECTORY_STATUSES = Object.freeze(['completed', 'rejected', 'failed', 'unprocessed']);
const DAY_MS = 86_400_000;

/** @param {unknown} value */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string,any>} */ (value) : {};
/** @param {unknown} value */
const list = value => Array.isArray(value) ? value : [];

/** Convert within one dimension of the domain's closed unit table; null when the two do not convert.
 * @param {number} value @param {string} from @param {string} to */
export function convertUnit(value, from, to) {
  if (!Number.isFinite(value)) return null;
  if (from === to) return value;
  if (!vcrUnitsConvertible(from, to)) return null;
  const dimension = Object.values(VCR_UNIT_DIMENSIONS).find(d => Object.hasOwn(d, from) && Object.hasOwn(d, to));
  const table = /** @type {Record<string,number>|undefined} */ (dimension);
  return table ? value * table[from] / table[to] : null;
}

/**
 * The action context of a request, validated. `issues` are execution issues of that request (an action in a factual forecast,
 * a conditional forecast without actions, a time that cannot be put on the day scale); they refuse this request only.
 * @param {Record<string, any>} scenario `{ predictionMode?, actions?, actionSource? }`
 */
export function actionContext(scenario) {
  const mode = scenario.predictionMode ?? 'factual_forecast';
  /** @type {Array<{code:string,detail:string,field:string}>} */ const issues = [];
  if (!VCR_PREDICTION_MODES.includes(mode)) issues.push({ code: 'mode_unknown', field: 'predictionMode', detail: 'Use factual_forecast, conditional_forecast or intervention_comparison.' });
  const raw = list(scenario.actions);
  /** @type {Array<{code:string,atDay:number,dose:{value:number,unit:string}|null,subjectKey:string|null}>} */ const actions = [];
  for (const [index, entry] of raw.entries()) {
    const action = object(entry), at = object(action.at ?? { value: action.atDay, unit: 'days' });
    const atDay = convertUnit(Number(at.value), String(at.unit ?? 'days'), 'days');
    const dose = action.dose == null ? null : { value: Number(object(action.dose).value), unit: String(object(action.dose).unit ?? '') };
    if (typeof action.code !== 'string' || !action.code) issues.push({ code: 'invalid_parameters', field: `actions.${index}.code`, detail: 'An action names its code.' });
    else if (atDay == null || atDay < 0) issues.push({ code: 'units_not_convertible', field: `actions.${index}.at`, detail: 'An action time is a nonnegative time in days, weeks, months or years (or hours, converted).' });
    else if (dose && !Number.isFinite(dose.value)) issues.push({ code: 'invalid_parameters', field: `actions.${index}.dose`, detail: 'A dose is a finite number with a unit.' });
    else actions.push({ code: action.code, atDay, dose, subjectKey: typeof action.subjectKey === 'string' ? action.subjectKey : null });
  }
  const source = scenario.actionSource ?? (raw.length ? 'supplied_schedule' : 'none');
  if (!TRAJECTORY_ACTION_SOURCES.includes(source)) issues.push({ code: 'invalid_parameters', field: 'actionSource', detail: 'Use none, supplied_schedule or logged_replay.' });
  if (mode === 'factual_forecast' && raw.length) issues.push({ code: 'mode_not_executable', field: 'actions', detail: 'A factual forecast takes no future actions; use conditional_forecast with a schedule.' });
  if (mode !== 'factual_forecast' && !raw.length) issues.push({ code: 'intervention_input_unavailable', field: 'actions', detail: 'A conditional forecast needs the schedule it is conditional on.' });
  if (source === 'none' && raw.length) issues.push({ code: 'invalid_parameters', field: 'actionSource', detail: 'Actions were supplied; name their source.' });
  if (actions.some(a => a.subjectKey) && source !== 'logged_replay') issues.push({ code: 'invalid_parameters', field: 'actions', detail: 'A per-person schedule is a logged replay; a supplied schedule applies to everyone.' });
  return { mode, actionSource: source, actions, issues,
    // what the result may be called
    deployable: source !== 'logged_replay',
    label: source === 'logged_replay' ? 'logged_action_replay' : mode === 'factual_forecast' ? 'factual_forecast' : mode };
}

/**
 * The per-person schedule a logged replay uses, read from the medication events of a LATER history (the outcome history), never
 * from the one the forecast is made from. Only for scoring the model given what really happened.
 * @param {any[]} laterEvents @param {string} origin @param {string[]} actionCodes
 */
export function loggedActionSchedule(laterEvents, origin, actionCodes) {
  const start = Date.parse(origin);
  return laterEvents.filter(e => e.kind === 'medication' && actionCodes.includes(e.code) && Date.parse(e.occurredAt) > start && e.medicationState !== 'stopped' && !e.conflict)
    .map(e => ({ subjectKey: e.subjectKey, code: e.code, at: { value: (Date.parse(e.occurredAt) - start) / DAY_MS, unit: 'days' },
      ...(Number.isFinite(e.value) ? { dose: { value: e.value, unit: e.unit ?? '' } } : {}) }));
}

/**
 * What a provider is sent, stated: observation codes, action codes and units, and whether actions are required.
 * @param {Record<string, any>} provider @param {{code:string,unit:string}} endpoint
 */
export function providerInputSpec(provider, endpoint) {
  const observationCodes = list(provider.inputCodes).length ? list(provider.inputCodes).map(String) : [endpoint.code];
  const actionCodes = list(provider.actionCodes).map(String);
  return { observationCodes, actionCodes, actionUnits: object(provider.actionUnits), actionConditioned: actionCodes.length > 0,
    requiresActions: provider.requiresActions === true || actionCodes.length > 0 && provider.requiresActions !== false,
    // what the provider declares about the person's own history (plan C.3): `history` uses it, `baseline` does not, anything else is not stated
    usesOwnHistory: provider.conditioning === 'history' ? true : provider.conditioning === 'baseline' ? false : null,
    codes: new Set([...observationCodes, ...actionCodes]) };
}

/** The use check of a provider, through the domain's one function. Execution issues refuse this prediction only; premises are
 * returned for the result's one block.
 * @param {Record<string, any>} provider @param {{mode:string,endpoint:any,horizonsDays:number[],subjects?:number,units?:any[]}} request */
export function assessProviderUse(provider, request) {
  const spec = providerInputSpec(provider, request.endpoint);
  const maxDays = Number(provider.maxHorizonDays);
  const pack = { executable: true,
    executableModes: Array.isArray(provider.executableModes) ? provider.executableModes
      : ['factual_forecast', ...(spec.actionConditioned ? ['conditional_forecast', 'intervention_comparison'] : [])],
    ...(Array.isArray(provider.validation) ? { validation: provider.validation } : {}),
    limits: { ...(Number.isFinite(maxDays) && maxDays > 0 ? { maxHorizonHours: maxDays * 24 } : {}),
      ...(Number.isFinite(provider.maxSubjects) ? { maxSubjects: provider.maxSubjects } : {}) } };
  return assessModelUse(pack, { mode: request.mode, endpoint: request.endpoint.code, horizonHours: Math.max(...request.horizonsDays) * 24,
    ...(request.subjects != null ? { subjects: request.subjects } : {}), ...(request.units ? { units: request.units } : {}) });
}

/**
 * Cut one batch's events at the origin and project them to what the provider named. Returns the events to send, and the people
 * rejected before sending with their reason. A person without any observation is NOT rejected here: the provider may forecast
 * from nothing and says so, or declines and is counted `rejected: no_forecast_returned`.
 * @param {{events:any[],keys:string[],origin:string,spec:ReturnType<typeof providerInputSpec>,endpoint:{code:string,unit:string},
 *   context:ReturnType<typeof actionContext>}} input
 */
export function projectBatch({ events, keys, origin, spec, endpoint, context }) {
  const cutoff = Date.parse(origin);
  const wanted = new Set(keys);
  /** @type {Map<string, any[]>} */ const bySubject = new Map(keys.map(key => [key, []]));
  /** @type {Map<string, {dropped:number, unitDropped:number, latestDropped:number}>} */ const trace = new Map(keys.map(key => [key, { dropped: 0, unitDropped: 0, latestDropped: -Infinity }]));
  for (const e of events) {
    if (!wanted.has(e.subjectKey) || e.conflict || !spec.codes.has(e.code)) continue;
    const at = Date.parse(e.occurredAt), seen = Date.parse(e.availableAt);
    // defence in depth: replay already cut here; a post-origin or undated record is never sent
    if (!Number.isFinite(at) || !Number.isFinite(seen) || at > cutoff || seen > cutoff) { /** @type {any} */ (trace.get(e.subjectKey)).dropped++; continue; }
    let value = e.value, unit = e.unit;
    const target = e.code === endpoint.code ? endpoint.unit : spec.actionUnits[e.code];
    if (target && unit !== target) {
      const converted = convertUnit(Number(value), String(unit ?? ''), target);
      if (converted == null) {
        const t = /** @type {any} */ (trace.get(e.subjectKey));
        t.unitDropped++;
        if (e.code === endpoint.code) t.latestDropped = Math.max(t.latestDropped, at);
        continue;
      }
      value = converted; unit = target;
    }
    bySubject.get(e.subjectKey)?.push({ subjectKey: e.subjectKey, code: e.code, value, unit, occurredAt: e.occurredAt, availableAt: e.availableAt,
      kind: e.kind, modality: e.modality ?? 'unspecified', assertion: e.assertion, experiencer: e.experiencer, medicationState: e.medicationState });
  }
  /** @type {Array<{subjectKey:string,reason:string}>} */ const rejected = [];
  /** @type {any[]} */ const actions = [];
  for (const key of keys) {
    const own = bySubject.get(key) ?? [], t = /** @type {any} */ (trace.get(key));
    const endpointKept = own.some(e => e.code === endpoint.code);
    if (!endpointKept && t.unitDropped) { rejected.push({ subjectKey: key, reason: 'unit_not_convertible' }); continue; }
    // a newer endpoint value in a unit that cannot be converted would leave an older one to be read as the latest: the person is not
    // sent rather than sent a stale value (review stats P2-16)
    const latestKept = Math.max(-Infinity, ...own.filter(e => e.code === endpoint.code).map(e => Date.parse(e.occurredAt)));
    if (t.latestDropped > latestKept) { rejected.push({ subjectKey: key, reason: 'unit_not_convertible' }); continue; }
    const scheduled = context.actions.filter(a => !a.subjectKey || a.subjectKey === key);
    const unitBad = scheduled.find(a => a.dose && spec.actionUnits[a.code] && convertUnit(a.dose.value, a.dose.unit, spec.actionUnits[a.code]) == null);
    if (unitBad) { rejected.push({ subjectKey: key, reason: 'action_unit_not_convertible' }); continue; }
    const recordedAction = own.some(e => spec.actionCodes.includes(e.code));
    if (spec.requiresActions && !recordedAction && !scheduled.length) { rejected.push({ subjectKey: key, reason: 'action_input_missing' }); continue; }
    for (const a of scheduled) actions.push({ subjectKey: key, code: a.code, atDay: a.atDay,
      ...(a.dose ? { dose: { value: spec.actionUnits[a.code] ? convertUnit(a.dose.value, a.dose.unit, spec.actionUnits[a.code]) : a.dose.value,
        unit: spec.actionUnits[a.code] ?? a.dose.unit } } : {}) });
  }
  const refused = new Set(rejected.map(r => r.subjectKey));
  return { events: [...bySubject.entries()].filter(([key]) => !refused.has(key)).flatMap(([, rows]) => rows), actions: actions.filter(a => !refused.has(a.subjectKey)),
    sendKeys: keys.filter(key => !refused.has(key)), rejected, leakageDropped: [...trace.values()].reduce((n, t) => n + t.dropped, 0),
    // the observations left out because their unit could not be converted, counted (stats P2-16)
    unitDropped: [...trace.values()].reduce((n, t) => n + t.unitDropped, 0) };
}

/** How a row's uncertainty is named; a deterministic model with none says `unavailable`.
 * @param {any[]} rows */
export function uncertaintyProvenance(rows) {
  const names = /** @type {Record<string,string>} */ ({ parameter: 'parameter', model: 'structural', monte_carlo: 'monte_carlo', predictive: 'predictive' });
  /** @type {Record<string, number>} */ const kinds = {};
  let carried = 0, draws = 0;
  for (const row of rows) {
    const has = Number.isFinite(row.sd) || list(row.quantiles).length > 0 || list(row.samples).length > 0;
    if (!has) continue;
    carried++;
    draws += list(row.samples).length;
    const kind = names[row.uncertainty] ?? 'unnamed';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { available: carried > 0, rowsWithUncertainty: carried, rows: rows.length, kinds, drawsTotal: draws,
    // `predictive` mixes patient heterogeneity with observation noise and is said so; nothing is split that the provider did not split
    note: carried === 0 ? 'unavailable' : kinds.unnamed ? 'some_unnamed' : kinds.predictive ? 'predictive_mixes_heterogeneity_and_observation_noise' : 'named' };
}

/**
 * Every submitted person's terminal or resumable line, and the identity that holds them together.
 * @param {{subjects:string[],horizonsDays:number[],preRejected?:Array<{subjectKey:string,reason:string}>,rows:any[],
 *   validationRejected?:Array<{subjectKey:string,horizonDays:number,codes:string[]}>,
 *   batches:Array<{keys:string[],outcome:'done'|'failed',code?:string}>,unprocessedReason?:string|null}} input
 */
export function reconcileSubjects({ subjects, horizonsDays, preRejected = [], rows, validationRejected = [], batches, unprocessedReason = null }) {
  const pre = new Map(preRejected.map(r => [r.subjectKey, r.reason]));
  /** @type {Map<string, any[]>} */ const rowsBy = new Map();
  for (const row of rows) { if (!rowsBy.has(row.subjectKey)) rowsBy.set(row.subjectKey, []); /** @type {any[]} */ (rowsBy.get(row.subjectKey)).push(row); }
  /** @type {Map<string, any[]>} */ const rejectedBy = new Map();
  for (const r of validationRejected) { if (!rejectedBy.has(r.subjectKey)) rejectedBy.set(r.subjectKey, []); /** @type {any[]} */ (rejectedBy.get(r.subjectKey)).push(r); }
  /** @type {Map<string,{outcome:string,code?:string}>} */ const batchOf = new Map();
  for (const b of batches) for (const key of b.keys) batchOf.set(key, b);
  const lines = subjects.map(subjectKey => {
    const got = rowsBy.get(subjectKey) ?? [], bad = rejectedBy.get(subjectKey) ?? [];
    const base = { subjectKey, horizonsRequested: horizonsDays.length, horizonsAccepted: got.length };
    if (pre.has(subjectKey)) return { ...base, status: 'rejected', reason: pre.get(subjectKey) };
    const batch = batchOf.get(subjectKey);
    if (!batch) return { ...base, status: 'unprocessed', reason: unprocessedReason ?? 'not_reached' };
    if (batch.outcome === 'failed' && !got.length) return { ...base, status: 'failed', reason: batch.code ?? 'provider_request_failed' };
    if (got.length) {
      const partial = got.length < horizonsDays.length;
      return { ...base, status: 'completed', reason: null, partial,
        ...(partial ? { rejectedHorizons: bad.map(r => ({ horizonDays: r.horizonDays, codes: r.codes })) } : {}),
        uncertainty: uncertaintyProvenance(got), draws: got.reduce((n, r) => Math.max(n, list(r.samples).length), 0) };
    }
    return { ...base, status: 'rejected', reason: bad[0]?.codes?.[0] ?? 'no_forecast_returned' };
  });
  return { lines, counts: assertReconciled(countStatuses(lines, subjects.length, preRejected.length)) };
}

/** @param {Array<{status:string}>} lines @param {number} submitted @param {number} preRejected */
function countStatuses(lines, submitted, preRejected) {
  const n = (/** @type {string} */ status) => lines.filter(l => l.status === status).length;
  // `admitted` (not `eligible`): `eligible` is a head-count key the small-cell suppression hides, and a batch's own ledger is shown whole
  return { submitted, admitted: submitted - preRejected, completed: n('completed'), rejected: n('rejected'), failed: n('failed'), unprocessed: n('unprocessed'),
    partial: lines.filter(l => /** @type {any} */ (l).partial).length };
}

/** The identity, enforced. @param {{submitted:number,completed:number,rejected:number,failed:number,unprocessed:number}} counts */
export function assertReconciled(counts) {
  if (counts.submitted !== counts.completed + counts.rejected + counts.failed + counts.unprocessed) {
    throw Object.assign(new Error('Batch accounting does not reconcile.'), { code: 'trajectory_batch_unreconciled', counts });
  }
  return counts;
}

/** A reason histogram for the summary, which never holds a person's key. @param {Array<{status:string,reason:string|null}>} lines */
export function reasonCounts(lines) {
  /** @type {Record<string, number>} */ const out = {};
  for (const l of lines) if (l.reason) out[l.reason] = (out[l.reason] ?? 0) + 1;
  return out;
}

/**
 * The one premises block of a trajectory result: what the domain's use check found, and what the action context and the missing
 * or mixed uncertainty mean for how far the result goes. Sentences, never numbers; the page folds all but the decisive rows.
 * The claim row (which of the three claims the forecast supports) leads when the provider said whether it used the person's own history.
 * @param {{findings?:any[],actionContext:{mode:string,actionSource:string},uncertainty:ReturnType<typeof uncertaintyProvenance>,usesOwnHistory?:boolean|null,individualizationHelped?:boolean|null}} input
 */
export function trajectoryPremises({ findings = [], actionContext: context, uncertainty, usesOwnHistory = null, individualizationHelped = null }) {
  /** @type {any[]} */ const rows = [];
  const claim = predictionClaimPremise(predictionClaimOf({ real: true, usesOwnHistory }), { helped: individualizationHelped });
  if (claim) rows.push(claim);
  if (context.actionSource === 'logged_replay') {
    rows.push({ key: 'trajectory:logged_replay', label: '用药信息的来源', decisive: true, source: 'given',
      value: '这次使用了预测起点之后实际记录的用药，检验的是“已知实际用药时模型有多准”，不能当作起点时就能得到的预测。' });
  } else if (context.mode !== 'factual_forecast') {
    rows.push({ key: 'trajectory:conditional', label: '预测所依据的用药安排', decisive: true, source: 'given',
      value: '这是在你给定的用药安排下的模型推演，表示在该安排下结果可能怎样变化，不是对疗效的因果证明。' });
  }
  if (!uncertainty.available) {
    rows.push({ key: 'trajectory:uncertainty', label: '预测的不确定性', decisive: true, source: 'default',
      value: '这个模型没有给出不确定性，所以不显示预测区间，也不用抽样结果代替。' });
  } else if (uncertainty.note === 'predictive_mixes_heterogeneity_and_observation_noise') {
    rows.push({ key: 'trajectory:interval', label: '预测区间的含义', decisive: false, source: 'default',
      value: '区间由模型直接给出，合并了患者之间的差异和观测误差，没有单独给出参数的不确定性。' });
  } else if (uncertainty.note === 'some_unnamed') {
    rows.push({ key: 'trajectory:interval', label: '预测区间的含义', decisive: false, source: 'default',
      value: '部分预测的不确定性来源模型没有说明，区间不能解释为某一种来源。' });
  }
  return finishPremises([...rows, ...modelUsePremises(findings)]);
}
