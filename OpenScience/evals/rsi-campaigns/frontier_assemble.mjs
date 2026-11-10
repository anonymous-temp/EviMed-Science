/**
 * The monthly frontier-selection campaign, assembled from production's export (2026-10-26).
 *
 * A run on the 1st of month M reads the export of months M-2 and M-1: M-2 is development, M-1 is the sealed confirmation.
 * Each month's confirmation corpus is new items no campaign has opened, so it is never reused; the confirmation ledger
 * (`campaign_runner.mjs`) refuses a second opening and draws the quarter's alpha (0.05 over the quarter's three campaigns) — unless
 * fewer confirmation days are measured than the procedure's minimum (25): such a month is directional and reserves none.
 *
 * The manifest's `models` (schema 2): the product's solver, no improver (the candidates are the registered threshold grid), and as the
 * judge the jury that produced the labels — its provider and model as the labels file names them (and the calibration agrees), held to the
 * domain's rule for an offline adjudicator: a pinned Claude model, or the one exception, the frontier jury (Qwen 3.8 Max, role `jury`, on this
 * surface; `RSI_FRONTIER_JURY`, owner 2026-11-03). Any other jury is refused before anything is assembled.
 *
 * The baseline is the incumbent policy identity production's own export carries (`incumbent.revisionId`: `default:<sha>` or
 * `evolution-module-policy-frontier:<revision>`, the serving layer's `baselineRevision`), bound as it is, so a bundle of this campaign
 * names the baseline production will compare it with. An export without it (an older export script, until the next release is deployed) does
 * not stop the month's measurement: the plan records `incumbent: null`, the manifest's baseline is `unbound:<releaseId>`, and the campaign is
 * measured and reported but not publishable — `finalize.mjs` refuses to build a bundle for it (`campaign_export_incumbent_missing`) and the report
 * says so. An incumbent that is present but malformed, or for another threshold than the export states, is refused (`campaign_export_incumbent_invalid`).
 *
 * The same holds for the consumer: the export carries production's dependency digest of this surface (`consumerDigest`) and `plan` compares it with this lab's before anything is spent. A month
 * whose digest differs is measured as ever, its baseline is `unbound-consumer:<releaseId>`, the report says so, and `finalize.mjs` refuses it (`campaign_export_consumer_changed`).
 *
 * Labelling happens in two phases (`frontier_labels.mjs label --phase`): development first, then — only when `decide` finds a candidate from
 * the development labels alone — confirmation. A month whose development finds none never labels its confirmation month.
 *
 *   node frontier_assemble.mjs plan  --export <frontier-YYYY-MM.json[.gz]> --month YYYY-MM --out <plan.json>
 *   node frontier_assemble.mjs decide --export <...> --plan <plan.json> --labels <labels-development.json> --calibration <calibration.json> --out <decision.json>
 *   node frontier_assemble.mjs merge-labels --plan <plan.json> --labels <development.json> --labels <confirmation.json> --out <labels.json>
 *   node frontier_assemble.mjs build --export <...> --plan <plan.json> --labels <labels.json> --calibration <calibration.json>
 *                                    --out-dir <dir> [--now <iso>]
 *
 * `plan` replays every registered threshold on every day, from production's own selector, and lists the rows a labeller
 * must label, by phase (the labelled set is fixed here, before any label exists). `build` writes the manifest and inputs the runner
 * takes, registering as groups the confirmation days with enough labelled rows (decided from labels, never from outcomes),
 * and reports the supply: days, labelled rows, abstentions, and the minimum detectable effect the registration can see.
 */
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { rsiDigest } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { computeRsiDependencyClosure } from '../../apps/server/src/rsiDependencyClosure.mjs';
import { rsiClosureSettings } from '../../apps/server/src/rsiClosureSettings.mjs';
import { RSI_FRONTIER_VOLUME_BOUND, RSI_FRONTIER_JURY, rsiCampaignIssues, rsiOfflineRoleIssue } from '../../packages/domain/src/rsiCampaign.mjs';
import { RSI_QUARTER_ALPHA, frontierJuryIdentity } from './campaign_runner.mjs';
import { FRONTIER_LABELS_SCHEMA } from './frontier_labels.mjs';
import { FRONTIER_DAYS_SCHEMA, chooseFrontierCandidate, evaluateFrontierDays, frontierCampaignConsumerIdentity, frontierLabelPlan } from './frontier_campaign.mjs';

/** Registered once, changed only as a new campaign family (a change is visible in the registration digest). */
export const FRONTIER_CAMPAIGN_REGISTRATION = Object.freeze({
  thresholds: Object.freeze([58, 60, 62, 64, 66, 68, 70, 72, 75, 78]),
  pickWeight: 3,
  minLabelled: 20,
  maxVolumeRatio: RSI_FRONTIER_VOLUME_BOUND.max,
  minVolumeRatio: RSI_FRONTIER_VOLUME_BOUND.min,
  campaignsPerQuarter: 3,
  procedure: Object.freeze({ id: 'rsi-paired-group-v5', digest_codec: 'rfc8785-sha256-v1', test_alpha_fraction: 0.5, minimum_slice_groups: 25 }),
  pilotRationale: 'Unit is the day: frontierMixSelect shares one day\'s size, group shares, language target and event picks across sources, so days are the independent units. Endpoint: weighted accuracy over a labelled set fixed from replays alone (rows at or above the lowest registered threshold, safety alerts, and every row any registered threshold selects); a pick weighs 3 because a missed pick costs a reader more than an extra adequate item. Labels: a two-pass jury of a model family other than the DeepSeek screener (the model the registration\'s labelling names), calibrated on the 2026-10-25 human anchor; disagreement abstains.',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const monthOf = (day) => day.slice(0, 7);
/** @param {string} month YYYY-MM @param {number} delta */
export function shiftMonth(month, delta) {
  const [year, m] = month.split('-').map(Number);
  const at = new Date(Date.UTC(year, m - 1 + delta, 1));
  return at.toISOString().slice(0, 7);
}
/** The instant a Beijing calendar month ends. @param {string} month */
export function beijingMonthEnd(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 1) - 8 * 3600000).toISOString();
}

export async function readFrontierExport(path) {
  const bytes = await readFile(path);
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const value = JSON.parse(raw.toString('utf8'));
  if (value?.schema !== 'rsi-frontier-export-v1' || !Array.isArray(value.days)) throw new Error('campaign_export_invalid');
  return { value, sha256: sha256(bytes) };
}

/** The lab's selector against the one production ran: differing files are reported, not hidden. */
export async function replayDrift(exported) {
  const identity = await frontierCampaignConsumerIdentity();
  const lab = new Map(identity.components.map((row) => [row.path.replace(/^\.\.\/\.\.\//, ''), row.sha256]));
  return (exported.consumer ?? []).filter((row) => lab.has(row.path) && lab.get(row.path) !== row.sha256).map((row) => row.path);
}

/**
 * Development and confirmation days: by default months M-2 and M-1; a rehearsal may name explicit inclusive day ranges
 * (`windows: {development: [from, to], confirmation: [from, to]}`), which still must not overlap and must be in order.
 */
export function splitDays(exported, month, windows = null) {
  const days = exported.days.filter((day) => day.complete === true);
  if (windows) {
    const [df, dt] = windows.development, [cf, ct] = windows.confirmation;
    if (!(df <= dt && dt < cf && cf <= ct)) throw new Error('campaign_windows_invalid');
    return { development: `${df}..${dt}`, confirmation: `${cf}..${ct}`, devDays: days.filter((day) => day.day >= df && day.day <= dt), confirmDays: days.filter((day) => day.day >= cf && day.day <= ct) };
  }
  const development = shiftMonth(month, -2), confirmation = shiftMonth(month, -1);
  return { development, confirmation, devDays: days.filter((day) => monthOf(day.day) === development), confirmDays: days.filter((day) => monthOf(day.day) === confirmation) };
}

export function campaignRegistration(baselineThreshold) {
  const r = FRONTIER_CAMPAIGN_REGISTRATION;
  return { baselineThreshold, thresholds: [...r.thresholds].filter((t) => t !== baselineThreshold), floor: Math.min(...r.thresholds, baselineThreshold) };
}

/** The registered forms of the frontier module's incumbent: what the serving layer reports as its `baselineRevision` (`rsiIncumbent`, apps/server/src/rsiServingAdapters.mjs). */
const INCUMBENT_REVISION = /^(?:default:[a-f0-9]{64}|evolution-module-policy-frontier:[1-9][0-9]{0,8})$/;
/** The baseline a campaign of an export without an incumbent carries: no policy identity production would accept, so no bundle can be imported against it (`finalize.mjs` refuses it by this prefix). */
export const UNBOUND_BASELINE_PREFIX = 'unbound:';
/** The baseline a campaign carries when production's selection consumer is not this lab's (or its export does not say): the same refusal, by its own name (`finalize.mjs`). */
export const UNBOUND_CONSUMER_PREFIX = 'unbound-consumer:';
/** @param {string|null|undefined} releaseId */
export function unboundBaselineRevision(releaseId) {
  const named = String(releaseId ?? '').replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 150);
  return `${UNBOUND_BASELINE_PREFIX}${named || 'unknown'}`;
}
/** The incumbent policy identity an export carries, and the one threshold it stands for; null when the export carries none (it predates the field). @param {any} value @returns {{revisionId:string, threshold:number}|null} */
export function exportIncumbent(value) {
  const incumbent = value?.incumbent;
  if (incumbent === undefined || incumbent === null) return null;
  if (typeof incumbent !== 'object' || !INCUMBENT_REVISION.test(incumbent.revisionId ?? '') || incumbent.threshold !== value.settings?.threshold) throw new Error('campaign_export_incumbent_invalid');
  return { revisionId: incumbent.revisionId, threshold: incumbent.threshold };
}

/**
 * The early answer: is the consumer production serves the one this lab measures? Asked of the export's own digest (`consumerDigest`, the serving layer's `currentTarget`) before anything is
 * spent, so a release that moved it is said on the 1st and not as a refusal at import. An export that does not say counts as moved: nothing would be left to compare a bundle with.
 * @param {any} value the export @param {string} rootDir the tree this lab measures with
 */
async function consumerFacts(value, rootDir) {
  const closure = await computeRsiDependencyClosure({ rootDir, surface: 'frontier-selection', settings: rsiClosureSettings('frontier-selection') });
  const lab = closure.qualified ? closure.dependencyDigest : null, production = value.consumerDigest ?? null;
  return { production, lab, bound: lab !== null && production === lab };
}
export async function planCampaign({ exportPath, month, windows = null, idPrefix = '', rehearsalPickWeight = null, rootDir = resolve(new URL('../..', import.meta.url).pathname) }) {
  if (!/^\d{4}-\d{2}$/.test(month ?? '') || !/^(?:[a-z][a-z0-9-]{0,30}-)?$/.test(idPrefix)) throw new Error('campaign_plan_arguments_invalid');
  // A rehearsal may exercise the whole chain with another pick weight; a real campaign always takes the registered one.
  if (rehearsalPickWeight !== null && (!idPrefix.startsWith('rehearsal-') || !(rehearsalPickWeight >= 1 && rehearsalPickWeight <= 10))) throw new Error('campaign_plan_arguments_invalid');
  const { value, sha256: exportSha256 } = await readFrontierExport(exportPath);
  const incumbent = exportIncumbent(value);
  const { development, confirmation, devDays, confirmDays } = splitDays(value, month, windows);
  if (!devDays.length || !confirmDays.length) throw new Error('campaign_export_window_incomplete');
  const registration = campaignRegistration(value.settings.threshold);
  const plan = frontierLabelPlan([...devDays, ...confirmDays], registration, registration.floor);
  if (!plan.eligible) throw new Error('campaign_export_pool_incomplete');
  // The rows a labeller is asked about, by phase: confirmation is labelled only when development finds a candidate, and an id is asked once.
  const developmentDays = new Set(devDays.map((day) => day.day)), confirmationDays = new Set(confirmDays.map((day) => day.day));
  const developmentIds = [...new Set(plan.days.filter((day) => developmentDays.has(day.day)).flatMap((day) => day.ids))].sort();
  const taken = new Set(developmentIds);
  const confirmationIds = [...new Set(plan.days.filter((day) => confirmationDays.has(day.day)).flatMap((day) => day.ids))].filter((id) => !taken.has(id)).sort();
  return { month, windows, idPrefix, rehearsalPickWeight, development, confirmation, exportSha256, settings: value.settings, releaseId: value.releaseId, incumbent, consumer: await consumerFacts(value, rootDir), registration,
    devDays: devDays.map((day) => day.day), confirmDays: confirmDays.map((day) => day.day), ids: plan.ids, idsByRole: { development: developmentIds, confirmation: confirmationIds },
    perDay: plan.days.map((day) => ({ day: day.day, labelSet: day.ids.length })), drift: await replayDrift(value) };
}

/** One-sided MDE of a paired mean difference at the test alpha, 80% power, from development's day differences (normal approximation). */
export function minimumDetectableEffect(differences, groups, testAlpha) {
  if (differences.length < 3 || groups < 2) return null;
  const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
  const sd = Math.sqrt(differences.reduce((a, b) => a + (b - mean) ** 2, 0) / (differences.length - 1));
  const z = (p) => { // Acklam's inverse normal, adequate for a planning figure
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const q = p < 0.02425 ? Math.sqrt(-2 * Math.log(p)) : p > 1 - 0.02425 ? Math.sqrt(-2 * Math.log(1 - p)) : null;
    if (q === null) { const r = (p - 0.5) ** 2, s = p - 0.5; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * s / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    const v = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return p < 0.5 ? v : -v;
  };
  return { sd, mde: (z(1 - testAlpha) + z(0.8)) * sd / Math.sqrt(groups), basis: 'development day differences of the frozen candidate; normal approximation' };
}

/**
 * The jury a labels file and its calibration name, or the refusal that stops the campaign. The jury is the one the calibration qualified
 * (same provider, model and rubric) and an adjudicator the domain admits on this surface (`rsiOfflineRoleIssue`); a file that names no provider has none.
 * @param {any} labels @param {any} calibration
 * @returns {{jury:{juryVersion:string|null, provider:string|null, model:string|null}, refusal?:undefined}|{refusal:any}}
 */
function juryOf(labels, calibration) {
  // The jury's calibration file (`frontier_labels.mjs calibrate`): its qualification gates the campaign, its metrics are reported.
  if (calibration?.qualification?.qualified !== true) return { refusal: { status: 'not-run', reason: 'campaign_labels_unqualified', calibration: { qualification: calibration?.qualification ?? null, metrics: calibration?.calibration ?? null } } };
  if (labels.model !== calibration.model) return { refusal: { status: 'not-run', reason: 'campaign_labels_jury_changed', jury: { labels: labels.model ?? null, calibration: calibration.model ?? null } } };
  // Another provider or another rubric is another jury: what the calibration measured is not what labelled.
  const named = (/** @type {any} */ file) => ({ provider: file.provider ?? null, juryVersion: file.juryVersion ?? null, promptDigest: file.promptDigest ?? null });
  if (JSON.stringify(named(labels)) !== JSON.stringify(named(calibration))) return { refusal: { status: 'not-run', reason: 'campaign_labels_jury_changed', jury: { labels: named(labels), calibration: named(calibration) } } };
  const jury = { juryVersion: labels.juryVersion ?? null, provider: labels.provider ?? null, model: labels.model ?? null };
  const refused = rsiOfflineRoleIssue('judge', frontierJuryIdentity(jury), RSI_FRONTIER_JURY.surface);
  if (refused) return { refusal: { status: 'not-run', reason: refused === 'campaign_model_invalid' ? 'campaign_judge_refused' : refused, jury } };
  return { jury };
}

/** A labels file is the jury's answer for one export: labels made from another export, or a run that stopped before it finished, are not labels of this plan.
 * @param {any} labels @param {any} plan */
function labelsIssue(labels, plan) {
  if (labels.exportSha256 !== undefined && labels.exportSha256 !== plan.exportSha256) return 'campaign_labels_export_mismatch';
  if (labels.stopped != null || (labels.incomplete ?? 0) > 0) return 'campaign_labels_incomplete';
  return null;
}

/**
 * The registered grid and the plan's band as the sources and the selection read them. The selection carries every registered parameter
 * `chooseFrontierCandidate` reads (`maxVolumeRatio` included), so `decide`, `build` and the runner can never choose under different rules.
 * @param {any} plan @param {any} [registered] the registered family (FRONTIER_CAMPAIGN_REGISTRATION; a test passes another)
 */
function registrationOf(plan, registered = FRONTIER_CAMPAIGN_REGISTRATION) {
  const r = { ...registered, ...(plan.rehearsalPickWeight ? { pickWeight: plan.rehearsalPickWeight } : {}) }, base = plan.registration;
  return { r, base, selection: { baselineThreshold: base.baselineThreshold, thresholds: base.thresholds, minLabelled: r.minLabelled, maxVolumeRatio: r.maxVolumeRatio, minVolumeRatio: r.minVolumeRatio } };
}
/** One role's source: its days and the labels the plan asked for on them. @param {any[]} days @param {any} plan @param {Map<string, string|null>} labelById @param {any} registered */
function daysSource(days, plan, labelById, registered) {
  const { r, base } = registrationOf(plan, registered);
  const ids = new Set(days.flatMap((day) => day.rows.map((row) => String(row.id))));
  return { kind: 'frontier-days', schema: FRONTIER_DAYS_SCHEMA, days,
    labels: plan.ids.filter((id) => ids.has(id) && labelById.has(id)).map((id) => ({ id, worth: labelById.get(id) })),
    band: { floor: base.floor, pickWeight: r.pickWeight } };
}
const labelMap = (/** @type {any} */ labels) => new Map(labels.labels.map((/** @type {any} */ label) => [String(label.id), label.worth ?? null]));

/** What development alone says: the registered choice over the development labels, power read from the leader whether or not it froze. */
function developmentReading(development, selection) {
  const evaluation = evaluateFrontierDays(development, selection);
  const choice = chooseFrontierCandidate(evaluation, selection);
  const leader = [...choice.candidates].filter((c) => c.meanDifference !== null).sort((a, b) => b.meanDifference - a.meanDifference)[0];
  const best = choice.frozen ? String(choice.frozen.threshold) : leader ? String(leader.threshold) : null, base = String(selection.baselineThreshold);
  const differences = best && evaluation.eligible ? evaluation.days.filter((day) => day.measured).map((day) => day.arms[best].quality - day.arms[base].quality) : [];
  return { evaluation, choice, differences };
}
const developmentFacts = (/** @type {any} */ source, /** @type {any[]} */ days, /** @type {any} */ evaluation, /** @type {string} */ month) => ({ month, days: days.length,
  measuredDays: evaluation.eligible ? evaluation.days.filter((day) => day.measured).length : 0, labelled: source.labels.filter((/** @type {any} */ l) => l.worth).length, abstained: source.labels.filter((/** @type {any} */ l) => !l.worth).length });
const calibrationFacts = (/** @type {any} */ calibration, /** @type {boolean} */ qualified) => ({ qualified, juryVersion: calibration.juryVersion ?? null, model: calibration.model ?? null, metrics: calibration.calibration ?? null });

/**
 * The development choice from development labels alone, before confirmation is labelled (`decide`). A frozen candidate means the
 * confirmation phase is worth labelling; none ends the month there, with nothing opened and no alpha reserved. The runner takes the same
 * source and the same functions, so its own development stage reaches the same choice.
 * @param {{exportPath:string, plan:any, labels:any, calibration:any}} input
 */
export async function decideDevelopment({ exportPath, plan, labels, calibration, registered = FRONTIER_CAMPAIGN_REGISTRATION }) {
  const { value, sha256: exportSha256 } = await readFrontierExport(exportPath);
  if (exportSha256 !== plan.exportSha256) throw new Error('campaign_export_changed');
  const gate = juryOf(labels, calibration);
  if (gate.refusal) return gate.refusal;
  if (labels.schema !== FRONTIER_LABELS_SCHEMA || labels.phase !== 'development' || labels.exportSha256 !== plan.exportSha256) throw new Error('campaign_labels_phase_invalid');
  const incomplete = labelsIssue(labels, plan);
  if (incomplete) throw new Error(incomplete);
  const allowed = new Set(plan.idsByRole.development);
  if (labels.labels.some((/** @type {any} */ label) => !allowed.has(String(label.id)))) throw new Error('campaign_labels_outside_plan');
  const { devDays, confirmDays } = splitDays(value, plan.month, plan.windows ?? null);
  const { r, selection } = registrationOf(plan, registered);
  const development = daysSource(devDays, plan, labelMap(labels), registered);
  const { evaluation, choice, differences } = developmentReading(development, selection);
  const supply = {
    exportSha256, releaseId: value.releaseId, settings: value.settings, incumbent: plan.incumbent ?? null, drift: plan.drift,
    development: developmentFacts(development, devDays, evaluation, plan.development),
    // Confirmation is not labelled yet: its days are counted, what labels would make of them is not known.
    confirmation: { month: plan.confirmation, days: confirmDays.length, measuredDays: null, labelled: null, abstained: null },
    replayFidelity: evaluation.eligible ? evaluation.days.reduce((sum, day) => sum + day.replayFidelity, 0) / Math.max(1, evaluation.days.length) : null,
    developmentChoice: { frozen: choice.frozen, reason: choice.reason, candidates: choice.candidates },
    minimumGroups: r.procedure.minimum_slice_groups, calibration: calibrationFacts(calibration, true),
    power: minimumDetectableEffect(differences, confirmDays.length, RSI_QUARTER_ALPHA / r.campaignsPerQuarter * r.procedure.test_alpha_fraction),
  };
  return { status: choice.frozen ? 'confirmation-needed' : 'development-ended', reason: choice.frozen ? null : choice.reason, frozen: choice.frozen, supply };
}

/**
 * The two phases' labels files as one labels file: exactly one per phase, from the same jury and the same export, finished, each id inside its phase's plan.
 * @param {any[]} files @param {any} plan
 */
export function mergeLabelFiles(files, plan) {
  const phases = files.map((file) => file?.phase);
  if (files.length !== 2 || phases.includes(undefined) || [...new Set(phases)].sort().join() !== 'confirmation,development') throw new Error('campaign_labels_phase_invalid');
  const [first] = files;
  const sameJury = (/** @type {any} */ file) => file?.schema === FRONTIER_LABELS_SCHEMA && ['provider', 'model', 'juryVersion', 'promptDigest'].every((key) => file[key] === first[key]);
  if (!files.every(sameJury)) throw new Error('campaign_labels_jury_changed');
  const seen = new Set();
  for (const file of files) {
    const issue = file.exportSha256 === plan.exportSha256 ? labelsIssue(file, plan) : 'campaign_labels_export_mismatch';
    if (issue) throw new Error(issue);
    const allowed = new Set(plan.idsByRole[file.phase]);
    for (const label of file.labels) {
      if (!allowed.has(String(label.id)) || seen.has(String(label.id))) throw new Error('campaign_labels_outside_plan');
      seen.add(String(label.id));
    }
  }
  const sum = (/** @type {(file:any)=>number} */ pick) => files.reduce((total, file) => total + pick(file), 0);
  const labelCounts = Object.fromEntries(['pick', 'ok', 'no', 'abstained', 'refused'].map((key) => [key, sum((file) => file.labelCounts?.[key] ?? 0)]));
  return { schema: FRONTIER_LABELS_SCHEMA, phase: 'all', month: plan.month, idPrefix: plan.idPrefix ?? '', exportSha256: plan.exportSha256, juryVersion: first.juryVersion, provider: first.provider, model: first.model,
    promptDigest: first.promptDigest, items: sum((file) => file.items ?? 0), missing: sum((file) => file.missing ?? 0), labelled: sum((file) => file.labels.length), incomplete: 0, labelCounts,
    calls: sum((file) => file.calls ?? 0), cachedCalls: sum((file) => file.cachedCalls ?? 0), costCny: Math.round(sum((file) => file.costCny ?? 0) * 1e8) / 1e8, stopped: null,
    labels: files.flatMap((file) => file.labels) };
}

export async function buildCampaign({ exportPath, plan, labels, calibration, now = new Date().toISOString(), rootDir, registered = FRONTIER_CAMPAIGN_REGISTRATION }) {
  const { value, sha256: exportSha256 } = await readFrontierExport(exportPath);
  if (exportSha256 !== plan.exportSha256) throw new Error('campaign_export_changed');
  const gate = juryOf(labels, calibration);
  if (gate.refusal) return gate.refusal;
  const { jury } = gate;
  const issue = labelsIssue(labels, plan);
  if (issue) throw new Error(issue);
  const { devDays, confirmDays } = splitDays(value, plan.month, plan.windows ?? null);
  const { r, base: registrationBase, selection } = registrationOf(plan, registered);
  const labelById = labelMap(labels);
  const development = daysSource(devDays, plan, labelById, registered), confirmation = daysSource(confirmDays, plan, labelById, registered);
  const confirmEvaluation = evaluateFrontierDays(confirmation, { ...selection, thresholds: [], labelThresholds: selection.thresholds });
  if (!confirmEvaluation.eligible) throw new Error('campaign_export_pool_incomplete');
  const measuredDays = confirmEvaluation.days.filter((day) => day.measured).map((day) => day.day);
  const identity = await frontierCampaignConsumerIdentity();
  const alpha = RSI_QUARTER_ALPHA / r.campaignsPerQuarter;
  const deadline = beijingMonthEnd(plan.month);
  const statistics = {
    procedure: { ...r.procedure }, version: 1, paid_cost_budget: 1, consumer_id: identity.implementationSha256, corpus_digest: rsiDigest(confirmation),
    mode: 'paired-t', deterministicConsumer: true, G_target: measuredDays.length,
    groups: measuredDays.map((day) => ({ id: `day-${day}`, family: 'frontier-days', failure_slice: false, day })),
    families: { 'frontier-days': { repeats: 1, forms: { original: 1 }, score_type: 'bounded-continuous', pilot_rationale: r.pilotRationale } },
    claims: { superiority: alpha }, cost_identity: 'deterministic-no-model-call', expires_at: deadline,
  };
  const registration = { ...selection, selection: { objective: 'weighted-accuracy-difference', tieBreak: 'nearest-baseline' },
    statistics, labelling: { ...jury, calibrationDigest: rsiDigest({ qualification: calibration.qualification, calibration: calibration.calibration }) } };
  const closure = await computeRsiDependencyClosure({ rootDir, surface: 'frontier-selection', settings: rsiClosureSettings('frontier-selection') });
  const consumer = await consumerFacts(value, rootDir);
  const target = { surface: 'frontier-selection', dependencyDigest: closure.qualified ? closure.dependencyDigest : identity.implementationSha256,
    baselineRevision: !plan.incumbent ? unboundBaselineRevision(value.releaseId) : consumer.bound ? plan.incumbent.revisionId : unboundBaselineRevision(value.releaseId).replace(UNBOUND_BASELINE_PREFIX, UNBOUND_CONSUMER_PREFIX) };
  const sources = { [`development-${plan.development}`]: development, [`confirmation-${plan.confirmation}`]: confirmation };
  const manifest = {
    schemaVersion: 2, id: `${plan.idPrefix ?? ''}frontier-selection-${plan.month}`, surface: 'frontier-selection', candidateKind: 'policy', claim: 'superiority', automated: true,
    createdAt: now, deadline, budget: { campaignCny: 1000, monthCny: 30000 },
    models: { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improvers: [], judges: [frontierJuryIdentity(registration.labelling)] },
    target, registration: { digest: rsiDigest(registration), procedure: r.procedure.id, claim: 'superiority' },
    data: { classification: 'public', sources: [
      { id: `development-${plan.development}`, digest: rsiDigest(development), role: 'development', exposure: 'exposed' },
      { id: `confirmation-${plan.confirmation}`, digest: rsiDigest(confirmation), role: 'confirmation', exposure: 'sealed' }] },
  };
  const issues = rsiCampaignIssues(manifest);
  if (issues.length) throw new Error(issues[0]);
  // Supply and power, read before confirmation from development alone.
  const { evaluation: devEvaluation, choice, differences } = developmentReading(development, selection);
  const supply = {
    exportSha256, releaseId: value.releaseId, settings: value.settings, incumbent: plan.incumbent ?? null, consumer, drift: plan.drift,
    development: developmentFacts(development, devDays, devEvaluation, plan.development),
    confirmation: { month: plan.confirmation, days: confirmDays.length, measuredDays: measuredDays.length, labelled: confirmation.labels.filter((l) => l.worth).length, abstained: confirmation.labels.filter((l) => !l.worth).length },
    replayFidelity: devEvaluation.eligible ? devEvaluation.days.reduce((sum, day) => sum + day.replayFidelity, 0) / Math.max(1, devEvaluation.days.length) : null,
    developmentChoice: { frozen: choice.frozen, reason: choice.reason, candidates: choice.candidates },
    alpha: { allocated: alpha, testAlpha: alpha * r.procedure.test_alpha_fraction },
    power: minimumDetectableEffect(differences, measuredDays.length, alpha * r.procedure.test_alpha_fraction),
    minimumGroups: r.procedure.minimum_slice_groups, directional: measuredDays.length < r.procedure.minimum_slice_groups,
    calibration: calibrationFacts(calibration, true),
  };
  return { status: 'assembled', manifest, inputs: { registration, target, sources }, supply };
}

async function main() {
  const [command] = process.argv.slice(2);
  const { values } = parseArgs({ args: process.argv.slice(3), options: { export: { type: 'string' }, month: { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' },
    labels: { type: 'string', multiple: true }, calibration: { type: 'string' }, 'out-dir': { type: 'string' }, now: { type: 'string' }, root: { type: 'string' },
    'development-days': { type: 'string' }, 'confirmation-days': { type: 'string' }, 'id-prefix': { type: 'string' }, 'rehearsal-pick-weight': { type: 'string' } } });
  const range = (value) => value ? value.split('..') : null;
  const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
  const oneLabels = () => { if (values.labels?.length !== 1) throw new Error('campaign_labels_phase_invalid'); return values.labels[0]; };
  if (command === 'plan') {
    const windows = values['development-days'] || values['confirmation-days'] ? { development: range(values['development-days']), confirmation: range(values['confirmation-days']) } : null;
    const plan = await planCampaign({ exportPath: values.export, month: values.month, windows, idPrefix: values['id-prefix'] ?? '',
      rehearsalPickWeight: values['rehearsal-pick-weight'] ? Number(values['rehearsal-pick-weight']) : null });
    // Whole or not at all: a truncated plan has no idsByRole, which the lab reads as a month begun before 2026-11-03 and refuses for good.
    await writeFile(`${values.out}.tmp`, `${JSON.stringify(plan)}\n`);
    await rename(`${values.out}.tmp`, values.out);
    console.log(JSON.stringify({ status: 'planned', month: plan.month, devDays: plan.devDays.length, confirmDays: plan.confirmDays.length, toLabel: plan.ids.length,
      byPhase: { development: plan.idsByRole.development.length, confirmation: plan.idsByRole.confirmation.length }, incumbent: plan.incumbent?.revisionId ?? null, consumerBound: plan.consumer.bound, drift: plan.drift }));
  } else if (command === 'decide') {
    const result = await decideDevelopment({ exportPath: values.export, plan: await json(values.plan), labels: await json(oneLabels()), calibration: await json(values.calibration) });
    await writeFile(values.out, `${JSON.stringify(result, null, 1)}\n`);
    console.log(JSON.stringify({ status: result.status, reason: result.reason ?? null, frozen: result.frozen ?? null }));
  } else if (command === 'merge-labels') {
    const merged = mergeLabelFiles(await Promise.all(values.labels.map(json)), await json(values.plan));
    await writeFile(values.out, `${JSON.stringify(merged, null, 1)}\n`);
    console.log(JSON.stringify({ status: 'merged', labelled: merged.labelled, labelCounts: merged.labelCounts }));
  } else if (command === 'build') {
    const result = await buildCampaign({ exportPath: values.export, plan: await json(values.plan), labels: await json(oneLabels()), calibration: await json(values.calibration),
      now: values.now ?? new Date().toISOString(), rootDir: values.root ?? resolve(new URL('../..', import.meta.url).pathname) });
    await mkdir(values['out-dir'], { recursive: true });
    if (result.status === 'assembled') {
      await writeFile(join(values['out-dir'], 'manifest.json'), `${JSON.stringify(result.manifest)}\n`);
      await writeFile(join(values['out-dir'], 'inputs.json'), `${JSON.stringify(result.inputs)}\n`);
    }
    await writeFile(join(values['out-dir'], 'supply.json'), `${JSON.stringify(result.supply ?? result, null, 1)}\n`);
    console.log(JSON.stringify({ status: result.status, reason: result.reason ?? null, campaignId: result.manifest?.id ?? null, groups: result.inputs?.registration.statistics.G_target ?? null, mde: result.supply?.power?.mde ?? null }));
  } else throw new Error('Usage: frontier_assemble.mjs plan|decide|merge-labels|build ...');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(JSON.stringify({ status: 'refused', reason: /^campaign_[a-z_]+$/.test(error.message) ? error.message : 'campaign_assembly_failed', detail: /^campaign_/.test(error.message) ? undefined : String(error.message).slice(0, 300) })); process.exitCode = 1; });
}
