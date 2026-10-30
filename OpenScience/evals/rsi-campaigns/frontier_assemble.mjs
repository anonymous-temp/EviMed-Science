/**
 * The monthly frontier-selection campaign, assembled from production's export (2026-10-26).
 *
 * A run on the 1st of month M reads the export of months M-2 and M-1: M-2 is development, M-1 is the sealed confirmation.
 * Each month's confirmation corpus is new items no campaign has opened, so it is never reused; the confirmation ledger
 * (`campaign_runner.mjs`) refuses a second opening and draws the quarter's alpha (0.05 over the quarter's three campaigns).
 *
 *   node frontier_assemble.mjs plan  --export <frontier-YYYY-MM.json[.gz]> --month YYYY-MM --out <plan.json>
 *   node frontier_assemble.mjs build --export <...> --plan <plan.json> --labels <labels.json> --calibration <calibration.json>
 *                                    --out-dir <dir> [--now <iso>]
 *
 * `plan` replays every registered threshold on every day, from production's own selector, and lists the rows a labeller
 * must label (the labelled set is fixed here, before any label exists). `build` writes the manifest and inputs the runner
 * takes, registering as groups the confirmation days with enough labelled rows (decided from labels, never from outcomes),
 * and reports the supply: days, labelled rows, abstentions, and the minimum detectable effect the registration can see.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { rsiDigest } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { computeRsiDependencyClosure } from '../../apps/server/src/rsiDependencyClosure.mjs';
import { rsiCampaignIssues } from '../../packages/domain/src/rsiCampaign.mjs';
import { RSI_QUARTER_ALPHA } from './campaign_runner.mjs';
import { FRONTIER_DAYS_SCHEMA, chooseFrontierCandidate, evaluateFrontierDays, frontierCampaignConsumerIdentity, frontierLabelPlan } from './frontier_campaign.mjs';

/** Registered once, changed only as a new campaign family (a change is visible in the registration digest). */
export const FRONTIER_CAMPAIGN_REGISTRATION = Object.freeze({
  thresholds: Object.freeze([58, 60, 62, 64, 66, 68, 70, 72, 75, 78]),
  pickWeight: 3,
  minLabelled: 20,
  maxVolumeRatio: 1.1,
  campaignsPerQuarter: 3,
  procedure: Object.freeze({ id: 'rsi-paired-group-v5', digest_codec: 'rfc8785-sha256-v1', test_alpha_fraction: 0.5, minimum_slice_groups: 25 }),
  pilotRationale: 'Unit is the day: frontierMixSelect shares one day\'s size, group shares, language target and event picks across sources, so days are the independent units. Endpoint: weighted accuracy over a labelled set fixed from replays alone (rows at or above the lowest registered threshold, safety alerts, and every row any registered threshold selects); a pick weighs 3 because a missed pick costs a reader more than an extra adequate item. Labels: a two-pass Qwen jury (a model family other than the DeepSeek screener) calibrated on the 2026-10-25 human anchor; disagreement abstains.',
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

export async function planCampaign({ exportPath, month, windows = null, idPrefix = '', rehearsalPickWeight = null }) {
  if (!/^\d{4}-\d{2}$/.test(month ?? '') || !/^(?:[a-z][a-z0-9-]{0,30}-)?$/.test(idPrefix)) throw new Error('campaign_plan_arguments_invalid');
  // A rehearsal may exercise the whole chain with another pick weight; a real campaign always takes the registered one.
  if (rehearsalPickWeight !== null && (!idPrefix.startsWith('rehearsal-') || !(rehearsalPickWeight >= 1 && rehearsalPickWeight <= 10))) throw new Error('campaign_plan_arguments_invalid');
  const { value, sha256: exportSha256 } = await readFrontierExport(exportPath);
  const { development, confirmation, devDays, confirmDays } = splitDays(value, month, windows);
  if (!devDays.length || !confirmDays.length) throw new Error('campaign_export_window_incomplete');
  const registration = campaignRegistration(value.settings.threshold);
  const plan = frontierLabelPlan([...devDays, ...confirmDays], registration, registration.floor);
  if (!plan.eligible) throw new Error('campaign_export_pool_incomplete');
  return { month, windows, idPrefix, rehearsalPickWeight, development, confirmation, exportSha256, settings: value.settings, releaseId: value.releaseId, registration,
    devDays: devDays.map((day) => day.day), confirmDays: confirmDays.map((day) => day.day), ids: plan.ids,
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

export async function buildCampaign({ exportPath, plan, labels, calibration, now = new Date().toISOString(), rootDir }) {
  const { value, sha256: exportSha256 } = await readFrontierExport(exportPath);
  if (exportSha256 !== plan.exportSha256) throw new Error('campaign_export_changed');
  // The jury's calibration file (`frontier_labels.mjs calibrate`): its qualification gates the campaign, its metrics are reported.
  const juryQualified = calibration?.qualification?.qualified === true;
  if (!juryQualified) return { status: 'not-run', reason: 'campaign_labels_unqualified', calibration: { qualification: calibration?.qualification ?? null, metrics: calibration?.calibration ?? null } };
  const { devDays, confirmDays } = splitDays(value, plan.month, plan.windows ?? null);
  const r = { ...FRONTIER_CAMPAIGN_REGISTRATION, ...(plan.rehearsalPickWeight ? { pickWeight: plan.rehearsalPickWeight } : {}) }, registrationBase = plan.registration;
  const labelById = new Map(labels.labels.map((label) => [String(label.id), label.worth ?? null]));
  const source = (days) => {
    const ids = new Set(days.flatMap((day) => day.rows.map((row) => String(row.id))));
    return { kind: 'frontier-days', schema: FRONTIER_DAYS_SCHEMA, days,
      labels: plan.ids.filter((id) => ids.has(id) && labelById.has(id)).map((id) => ({ id, worth: labelById.get(id) })),
      band: { floor: registrationBase.floor, pickWeight: r.pickWeight } };
  };
  const development = source(devDays), confirmation = source(confirmDays);
  const selection = { baselineThreshold: registrationBase.baselineThreshold, thresholds: registrationBase.thresholds, minLabelled: r.minLabelled };
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
  const registration = { ...selection, maxVolumeRatio: r.maxVolumeRatio, selection: { objective: 'weighted-accuracy-difference', tieBreak: 'nearest-baseline' },
    statistics, labelling: { juryVersion: labels.juryVersion ?? null, model: labels.model ?? null, calibrationDigest: rsiDigest({ qualification: calibration.qualification, calibration: calibration.calibration }) } };
  const closure = await computeRsiDependencyClosure({ rootDir, surface: 'frontier-selection', settings: { model: 'deepseek-flash', provider: 'deepseek' } });
  const target = { surface: 'frontier-selection', dependencyDigest: closure.qualified ? closure.dependencyDigest : identity.implementationSha256,
    baselineRevision: `threshold-${registrationBase.baselineThreshold}-${String(value.releaseId ?? 'unknown').replace(/[^A-Za-z0-9_.:-]/g, '-')}`.slice(0, 160) };
  const sources = { [`development-${plan.development}`]: development, [`confirmation-${plan.confirmation}`]: confirmation };
  const manifest = {
    schemaVersion: 1, id: `${plan.idPrefix ?? ''}frontier-selection-${plan.month}`, surface: 'frontier-selection', candidateKind: 'policy', claim: 'superiority', automated: true,
    createdAt: now, deadline, budget: { campaignCny: 1000, monthCny: 30000 },
    models: { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improver: { provider: 'none', model: 'registered-grid' }, reviewer: { provider: 'dashscope', model: 'qwen3.8-max' } },
    target, registration: { digest: rsiDigest(registration), procedure: r.procedure.id, claim: 'superiority' },
    data: { classification: 'public', sources: [
      { id: `development-${plan.development}`, digest: rsiDigest(development), role: 'development', exposure: 'exposed' },
      { id: `confirmation-${plan.confirmation}`, digest: rsiDigest(confirmation), role: 'confirmation', exposure: 'sealed' }] },
  };
  const issues = rsiCampaignIssues(manifest);
  if (issues.length) throw new Error(issues[0]);
  // Supply and power, read before confirmation from development alone.
  const devEvaluation = evaluateFrontierDays(development, selection);
  const choice = chooseFrontierCandidate(devEvaluation, selection);
  // Power is read from the candidate development liked best, frozen or not, so a month with no winner still says what it could see.
  const leader = [...choice.candidates].filter((c) => c.meanDifference !== null).sort((a, b) => b.meanDifference - a.meanDifference)[0];
  const best = choice.frozen ? String(choice.frozen.threshold) : leader ? String(leader.threshold) : null, base = String(selection.baselineThreshold);
  const differences = best && devEvaluation.eligible ? devEvaluation.days.filter((day) => day.measured).map((day) => day.arms[best].quality - day.arms[base].quality) : [];
  const supply = {
    exportSha256, releaseId: value.releaseId, settings: value.settings, drift: plan.drift,
    development: { month: plan.development, days: devDays.length, measuredDays: devEvaluation.eligible ? devEvaluation.days.filter((day) => day.measured).length : 0, labelled: development.labels.filter((l) => l.worth).length, abstained: development.labels.filter((l) => !l.worth).length },
    confirmation: { month: plan.confirmation, days: confirmDays.length, measuredDays: measuredDays.length, labelled: confirmation.labels.filter((l) => l.worth).length, abstained: confirmation.labels.filter((l) => !l.worth).length },
    replayFidelity: devEvaluation.eligible ? devEvaluation.days.reduce((sum, day) => sum + day.replayFidelity, 0) / Math.max(1, devEvaluation.days.length) : null,
    developmentChoice: { frozen: choice.frozen, reason: choice.reason, candidates: choice.candidates },
    alpha: { allocated: alpha, testAlpha: alpha * r.procedure.test_alpha_fraction },
    power: minimumDetectableEffect(differences, measuredDays.length, alpha * r.procedure.test_alpha_fraction),
    minimumGroups: r.procedure.minimum_slice_groups,
    calibration: { qualified: juryQualified, juryVersion: calibration.juryVersion ?? null, metrics: calibration.calibration ?? null },
  };
  return { status: 'assembled', manifest, inputs: { registration, target, sources }, supply };
}

async function main() {
  const [command] = process.argv.slice(2);
  const { values } = parseArgs({ args: process.argv.slice(3), options: { export: { type: 'string' }, month: { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' },
    labels: { type: 'string' }, calibration: { type: 'string' }, 'out-dir': { type: 'string' }, now: { type: 'string' }, root: { type: 'string' },
    'development-days': { type: 'string' }, 'confirmation-days': { type: 'string' }, 'id-prefix': { type: 'string' }, 'rehearsal-pick-weight': { type: 'string' } } });
  const range = (value) => value ? value.split('..') : null;
  const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
  if (command === 'plan') {
    const windows = values['development-days'] || values['confirmation-days'] ? { development: range(values['development-days']), confirmation: range(values['confirmation-days']) } : null;
    const plan = await planCampaign({ exportPath: values.export, month: values.month, windows, idPrefix: values['id-prefix'] ?? '',
      rehearsalPickWeight: values['rehearsal-pick-weight'] ? Number(values['rehearsal-pick-weight']) : null });
    await writeFile(values.out, `${JSON.stringify(plan)}\n`);
    console.log(JSON.stringify({ status: 'planned', month: plan.month, devDays: plan.devDays.length, confirmDays: plan.confirmDays.length, toLabel: plan.ids.length, drift: plan.drift }));
  } else if (command === 'build') {
    const result = await buildCampaign({ exportPath: values.export, plan: await json(values.plan), labels: await json(values.labels), calibration: await json(values.calibration),
      now: values.now ?? new Date().toISOString(), rootDir: values.root ?? resolve(new URL('../..', import.meta.url).pathname) });
    await mkdir(values['out-dir'], { recursive: true });
    if (result.status === 'assembled') {
      await writeFile(join(values['out-dir'], 'manifest.json'), `${JSON.stringify(result.manifest)}\n`);
      await writeFile(join(values['out-dir'], 'inputs.json'), `${JSON.stringify(result.inputs)}\n`);
    }
    await writeFile(join(values['out-dir'], 'supply.json'), `${JSON.stringify(result.supply ?? result, null, 1)}\n`);
    console.log(JSON.stringify({ status: result.status, reason: result.reason ?? null, campaignId: result.manifest?.id ?? null, groups: result.inputs?.registration.statistics.G_target ?? null, mde: result.supply?.power?.mde ?? null }));
  } else throw new Error('Usage: frontier_assemble.mjs plan|build ...');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(JSON.stringify({ status: 'refused', reason: /^campaign_[a-z_]+$/.test(error.message) ? error.message : 'campaign_assembly_failed', detail: /^campaign_/.test(error.message) ? undefined : String(error.message).slice(0, 300) })); process.exitCode = 1; });
}
