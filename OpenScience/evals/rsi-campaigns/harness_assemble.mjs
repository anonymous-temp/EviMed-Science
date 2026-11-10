/**
 * Assemble a harness-patch campaign (harness_campaign.mjs) from the exports of evals/public-benchmarks/tools/export_harness_arms.py
 * and the round's pre-registration (register_round.py): the manifest, the inputs (registration with its statistics, target,
 * sources) and a supply report read from development alone — the shapes the runner, the evaluator and the report use.
 *
 *   node harness_assemble.mjs --development dev.json --confirmation conf.json --confirmation-gold conf.gold.json \
 *     --registration registration.json --improvement improvement.json --month 2026-11 --out-dir dir --pilot-rationale "..." \
 *     [--development-verdicts dev.verdicts.jsonl --confirmation-verdicts conf.verdicts.jsonl] [--id-prefix rehearsal-]
 *   node harness_assemble.mjs --development-only --development dev.json --registration registration.json --improvement improvement.json --month 2026-11 --out-dir dir
 *   node harness_assemble.mjs --preview --development dev.json --registration registration.json --improvement improvement.json   (the dev box: the development choice, nothing written)
 *
 * The manifest's `models` (schema 2) are the product's solver, the improvers the round's improvement record names (`improvement.json`,
 * required: `{improvers: [{role, provider: 'anthropic', model: 'claude-...'}], ...provenance}`, the roles that actually wrote the candidates)
 * and, for a judged scorer, the registered judge (`registration.judge`); a deterministic scorer has none. No identity is written here by hand.
 *
 * `--preview` and `--development-only` apply to the development source and the registration every refusal the run applies on that side (one function,
 * `harnessDevelopmentIssue` of harness_campaign.mjs, also called by the runner): the control arm, K, the registered rows and repeats, the choice rule, the
 * alpha allocation and, for a judged family, the registered call maximum against what the registration itself needs.
 *
 * The seal. A confirmation export holds the answers and the costs and nothing that scores them: no gold in its rows, no verdict
 * records. The gold (`confirmation.gold.json`) and the verdict records (`*.verdicts.jsonl`) are joined here, in the lab's
 * assembly, each checked against the digest the export recorded; a confirmation source that already carries gold or records is
 * refused as not sealed. The development choice reads the development source alone (`--preview` and `--development-only` take
 * no confirmation file at all).
 *
 * A round whose `surface` is a module's (module_campaign.mjs, 2026-11-04) is assembled here too, with that consumer's kit: its sources are module_arms.mjs's, its target names
 * the consumer's dependency closure and the incumbent production reported, and a judged scorer of its table joins both the gold and the verdict records.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { RSI_CAMPAIGN_SURFACES, rsiCampaignIssues } from '../../packages/domain/src/rsiCampaign.mjs';
import { canonicalRsiJson, rsiDigest } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { RSI_QUARTER_ALPHA } from './campaign_runner.mjs';
import { beijingMonthEnd } from './frontier_assemble.mjs';
import { inSkillSlice, skillSlice } from './skill_campaign.mjs';
import { HARNESS_KIT, HARNESS_SELECTION, HARNESS_SURFACE, TOOL_PATCH_SURFACE, chooseHarnessCandidate, harnessArmsIssues, harnessCampaignConsumerIdentity, harnessDevelopmentIssue, harnessDevelopmentResult, harnessImprovementIssue, harnessJudgeRegistrationIssue, harnessModels, registrationSurface } from './harness_campaign.mjs';
import { toolPatchCampaignConsumerIdentity } from './tool_patch_campaign.mjs';
import { MODULE_KIT, isModuleSurface, moduleCampaignConsumerIdentity, moduleConfirmationSealed, moduleDirectional, moduleTarget } from './module_campaign.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const PROCEDURE = Object.freeze({ id: 'rsi-paired-group-v5', digest_codec: 'rfc8785-sha256-v1', test_alpha_fraction: 0.5, minimum_slice_groups: 25 });
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** The kit of the consumer a round registers for; anything but a module's surface is the harness consumer's to accept or refuse. @param {any} round */
const kitOf = (round) => (isModuleSurface(registrationSurface(round)) ? MODULE_KIT : HARNESS_KIT);

/** The digest register_round.py gives a pre-registration: the canonical JSON without `digest` and `registeredAt`. @param {any} round */
export function roundRegistrationDigest(round) {
  const { digest, registeredAt, ...body } = round;
  return sha(canonicalRsiJson(body));
}

/** A pre-registration the assembly can use, or a closed code. @param {any} round */
function checkRound(round) {
  if (round?.schema !== 'rsi-round-registration/1') throw new Error('campaign_registration_invalid');
  if (roundRegistrationDigest(round) !== round.digest) throw new Error('campaign_registration_digest_mismatch');
  const kit = kitOf(round), scorer = kit.scorer(round);
  if (!scorer) throw new Error('campaign_scorer_not_qualified');
  if (!kit.surfaces.includes(registrationSurface(round))) throw new Error('campaign_surface_invalid');
  const slice = round.failureSlice;
  if (round.failureSliceKey !== scorer.slice.registration || !Array.isArray(slice) || !slice.length || !slice.every(scorer.slice.valid)) throw new Error('campaign_registration_invalid');
  const alpha = round.alpha?.perCampaign;
  if (!(alpha > 0) || !Number.isInteger(round.alpha.campaignsPerQuarter) || alpha * round.alpha.campaignsPerQuarter > RSI_QUARTER_ALPHA + 1e-12) throw new Error('campaign_alpha_registration_invalid');
  if (scorer.judged && Number.isInteger(round.judge?.maxCalls) && round.judge.maxCalls >= 1 && round.judge.maxCalls < judgeCallsRequired(round)) throw new Error('campaign_judge_budget_below_registration');
  return scorer;
}

/**
 * The verdict records a judged registration will produce, from its own rows, repeats, passes and candidates: development carries the
 * baseline, the A/A control and up to K candidates, confirmation the baseline and one candidate. Pairwise judging records the
 * non-baseline arms only (the baseline is the 0.5 reference), absolute judging every arm. `register_round.py` computes the same
 * figure and refuses a maximum below it.
 * @param {any} round
 */
export function judgeCallsRequired(round) {
  const passes = round.judge.passes, pairwise = round.judge.form === 'pairwise';
  const developmentArms = (pairwise ? 0 : 1) + 1 + round.candidatesMax, confirmationArms = pairwise ? 1 : 2;
  return (round.rows.development.length * round.repeats.development * developmentArms + round.rows.confirmation.length * round.repeats.confirmation * confirmationArms) * passes;
}

/**
 * The registration the runner reads, without statistics: the scorer, the failure slice, the registered choice rule, the control,
 * the image, the rows, the repeats, the alpha allocation, K, (judged families) the judge, and the improvement record that names who
 * wrote the candidates (required: `harnessImprovementIssue`).
 * @param {any} round @param {any} development @param {any} improvement
 */
function namedRegistration(round, development, improvement) {
  const scorer = checkRound(round);
  const refused = harnessImprovementIssue(improvement);
  if (refused) throw new Error(refused);
  return {
    scorer: scorer.id, family: round.family, [scorer.slice.registration]: [...round.failureSlice].sort((a, b) => (typeof a === 'number' ? a - b : cmp(String(a), String(b)))),
    margin: round.margin, selection: { ...HARNESS_SELECTION }, costRatio: round.costRatio, candidatesMax: round.candidatesMax, control: { arm: round.control.arm, kind: round.control.kind },
    image: development.image, rows: { development: [...round.rows.development], confirmation: [...round.rows.confirmation] }, repeats: { ...round.repeats },
    alpha: { ...round.alpha }, ...(round.judge ? { judge: structuredClone(round.judge) } : {}),
    ...(registrationSurface(round) === HARNESS_SURFACE ? {} : { surface: registrationSurface(round) }),
    ...(round.confirmationDraw ? { confirmationDraw: structuredClone(round.confirmationDraw) } : {}),
    roundRegistration: { round: round.round, digest: round.digest }, improvement,
  };
}

/**
 * Join the verdict records of a judged source: the file's bytes must be the file the export digested (`judged.recordsFile`).
 * @param {any} source @param {string} text
 */
export function attachVerdicts(source, text) {
  const file = source?.judged?.recordsFile;
  if (!file || sha(text) !== file.sha256) throw new Error('campaign_judge_verdicts_changed');
  const records = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (records.length !== file.lines) throw new Error('campaign_judge_verdicts_changed');
  return { ...source, judged: { ...source.judged, records } };
}

/**
 * Join the gold of a sealed confirmation export. The rows must carry none, the gold file must be for this benchmark and name
 * exactly these rows.
 * @param {any} source @param {any} goldFile
 */
export function attachGold(source, goldFile) {
  if (source.rows.some((row) => Object.hasOwn(row, 'gold'))) throw new Error('harness_confirmation_not_sealed');
  if (goldFile?.kind !== 'harness-gold' || goldFile.schema !== 1 || goldFile.benchmark !== source.benchmark || !goldFile.gold || typeof goldFile.gold !== 'object') throw new Error('harness_gold_invalid');
  const ids = source.rows.map((row) => String(row.id)).sort(), named = Object.keys(goldFile.gold).sort();
  if (ids.length !== named.length || ids.some((id, at) => id !== named[at])) throw new Error('harness_gold_rows_differ');
  return { ...source, rows: source.rows.map((row) => ({ ...row, gold: structuredClone(goldFile.gold[String(row.id)]) })) };
}

/** Prepare the two sources: gold and verdict records joined in, nothing left to score from the confirmation export alone. */
function prepareSources({ scorer, development, confirmation, confirmationGold, developmentVerdicts, confirmationVerdicts }) {
  let dev = structuredClone(development), conf = confirmation === undefined ? undefined : structuredClone(confirmation);
  if (scorer.judged) {
    if (dev.judged?.records !== undefined || conf?.judged?.records !== undefined) throw new Error('harness_confirmation_not_sealed');
    if (typeof developmentVerdicts !== 'string' || (conf && typeof confirmationVerdicts !== 'string')) throw new Error('campaign_judge_verdicts_missing');
    dev = attachVerdicts(dev, developmentVerdicts);
    if (conf) conf = attachVerdicts(conf, confirmationVerdicts);
  }
  if (conf && (!scorer.judged || scorer.joinsGold)) {
    if (!confirmationGold) { if (conf.rows.some((row) => Object.hasOwn(row, 'gold'))) throw new Error('harness_confirmation_not_sealed'); throw new Error('harness_confirmation_gold_missing'); }
    conf = attachGold(conf, confirmationGold);
  }
  return { development: dev, confirmation: conf };
}

/**
 * @param {{development:any, confirmation:any, registration:any, confirmationGold?:any, developmentVerdicts?:string, confirmationVerdicts?:string,
 *   month:string, pilotRationale?:string, improvement:any, paidCostBudget?:number, idPrefix?:string, now?:string}} input
 */
export async function buildHarnessCampaign({ development: devExport, confirmation: confExport, registration: round, confirmationGold, developmentVerdicts, confirmationVerdicts, month, pilotRationale, improvement, paidCostBudget = 1000, idPrefix = '', now = new Date().toISOString() }) {
  const scorer = checkRound(round);
  if (typeof pilotRationale !== 'string' || !pilotRationale.trim()) throw new Error('campaign_pilot_rationale_missing');
  const { development, confirmation } = prepareSources({ scorer, development: devExport, confirmation: confExport, confirmationGold, developmentVerdicts, confirmationVerdicts });
  const named = namedRegistration(round, development, improvement), kit = kitOf(round);
  if (scorer.judged) { const refused = harnessJudgeRegistrationIssue(named.judge, named.margin); if (refused) throw new Error(refused); }
  for (const source of [development, confirmation]) {
    const issues = harnessArmsIssues(source, named, kit);
    if (issues.length) throw new Error(issues[0]);
  }
  // Everything the runner will refuse on the development side is refused here, before a manifest exists.
  const refusedOnDevelopment = harnessDevelopmentIssue(named, development, kit);
  if (refusedOnDevelopment) throw new Error(refusedOnDevelopment);
  const surface = registrationSurface(round), moduleRound = isModuleSurface(surface);
  const identity = await (moduleRound ? moduleCampaignConsumerIdentity : surface === TOOL_PATCH_SURFACE ? toolPatchCampaignConsumerIdentity : harnessCampaignConsumerIdentity)(named);
  const slice = skillSlice(named, scorer);
  const alpha = round.alpha.perCampaign;
  const deadline = beijingMonthEnd(month);
  const statistics = {
    procedure: { ...PROCEDURE }, version: 1, paid_cost_budget: paidCostBudget, consumer_id: identity.implementationSha256, corpus_digest: rsiDigest(confirmation),
    mode: 'paired-t', deterministicConsumer: false, G_target: confirmation.rows.length,
    groups: confirmation.rows.map((row) => ({ id: `row-${row.id}`, family: round.family, failure_slice: inSkillSlice(slice, scorer, row) })),
    families: { [round.family]: { repeats: confirmation.repeats, forms: { answer: 1 }, score_type: 'bounded-continuous', margin: round.margin, pilot_rationale: pilotRationale } },
    claims: { 'targeted-repair': alpha }, cost_identity: kit.costIdentity, expires_at: deadline,
  };
  const registration = { ...named, statistics,
    candidates: Object.entries(development.arms).filter(([id, arm]) => arm.harness).map(([arm, entry]) => ({ arm, digest: entry.harness.digest, chars: entry.harness.chars, alwaysOnChars: entry.harness.alwaysOnChars, title: entry.harness.title ?? null })) };
  const baselineRevision = `${round.family}-harness-baseline-${development.image.id}`.slice(0, 160);
  const target = moduleRound ? moduleTarget(surface, development) : { surface, dependencyDigest: identity.implementationSha256, baselineRevision };
  const sources = { [`development-${month}`]: development, [`confirmation-${month}`]: confirmation };
  const manifest = {
    schemaVersion: 2, id: `${idPrefix}${surface}-${round.family}-${month}`, surface, candidateKind: RSI_CAMPAIGN_SURFACES[surface].kind, claim: 'targeted-repair', automated: true,
    createdAt: now, deadline, budget: { campaignCny: 1000, monthCny: 30000 },
    models: harnessModels(registration),
    target, registration: { digest: rsiDigest(registration), procedure: PROCEDURE.id, claim: 'targeted-repair' },
    data: { classification: 'public', sources: [
      { id: `development-${month}`, digest: rsiDigest(development), role: 'development', exposure: 'exposed' },
      // A module round on the repo's cases says so: the improver reads them with their gold.
      { id: `confirmation-${month}`, digest: rsiDigest(confirmation), role: 'confirmation', exposure: moduleRound && !moduleConfirmationSealed(registration) ? 'exposed' : 'sealed' }] },
  };
  const issues = rsiCampaignIssues(manifest);
  if (issues.length) throw new Error(issues[0]);
  const choice = chooseHarnessCandidate(development, registration, kit);
  const sum = (source, arm) => round6(source.runs.filter((run) => run.arm === arm).reduce((total, run) => total + (run.cost ?? 0), 0));
  const minimum = PROCEDURE.minimum_slice_groups, sliceGroups = statistics.groups.filter((g) => g.failure_slice).length;
  const supply = {
    development: { rows: development.rows.length, sliceRows: development.rows.filter((row) => inSkillSlice(slice, scorer, row)).length, arms: Object.keys(development.arms), runs: development.runs.length,
      costCny: Object.fromEntries(Object.keys(development.arms).map((arm) => [arm, sum(development, arm)])) },
    confirmation: { rows: confirmation.rows.length, sliceGroups, repeats: confirmation.repeats, runs: confirmation.runs.length,
      costCny: Object.fromEntries(Object.keys(confirmation.arms).map((arm) => [arm, sum(confirmation, arm)])) },
    developmentChoice: { frozen: choice.frozen, reason: choice.reason, candidates: choice.candidates, controls: choice.controls, noiseFloor: choice.noiseFloor },
    judge: scorer.judged ? judgeSupply(registration.judge, development, confirmation) : null,
    image: development.image, alpha: { allocated: alpha, testAlpha: alpha * PROCEDURE.test_alpha_fraction }, minimumGroups: minimum,
    directional: moduleRound ? moduleDirectional(registration) !== null : confirmation.rows.length < minimum || sliceGroups < minimum,
  };
  return { status: 'assembled', manifest, inputs: { registration, target, sources }, supply };
}

/** What the judge did, from the sources alone: identity, calls, the CNY it cost (0, said), the qualification it was registered with. */
function judgeSupply(judge, ...sources) {
  return { id: judge.id, provider: judge.provider, model: judge.model, effort: judge.effort, form: judge.form, passes: judge.passes, maxCalls: judge.maxCalls, qualification: judge.qualification,
    calls: sources.reduce((total, source) => total + source.judged.calls, 0), costCny: 0, costNote: sources[0].judged.cost.note };
}

/**
 * Development only: the registered choice over the development source, recomputed here, when no candidate earned a confirmation
 * (or on the dev box, as a preview). Nothing is opened: no confirmation corpus is read, no alpha is reserved.
 * @param {{development:any, registration:any, developmentVerdicts?:string, improvement:any, month:string}} input
 */
export function developmentOnly({ development: devExport, registration: round, developmentVerdicts, improvement, month }) {
  const scorer = checkRound(round);
  if (devExport?.role !== 'development') throw new Error('harness_confirmation_scored_before_opening');
  const { development } = prepareSources({ scorer, development: devExport, developmentVerdicts });
  const registration = namedRegistration(round, development, improvement), kit = kitOf(round);
  if (scorer.judged) { const refused = harnessJudgeRegistrationIssue(registration.judge, registration.margin); if (refused) throw new Error(refused); }
  const issues = harnessArmsIssues(development, registration, kit);
  if (issues.length) throw new Error(issues[0]);
  // The preview and `--development-only` apply what `run` applies to the development side: the control arm, K, the registered rows and
  // repeats, the choice rule. A preview that says eligible has met every refusal the runner has for a development source.
  const refusedOnDevelopment = harnessDevelopmentIssue(registration, development, kit);
  if (refusedOnDevelopment) throw new Error(refusedOnDevelopment);
  const choice = chooseHarnessCandidate(development, registration, kit), slice = skillSlice(registration, scorer);
  const sum = (arm) => round6(development.runs.filter((run) => run.arm === arm).reduce((total, run) => total + (run.cost ?? 0), 0));
  return { status: 'development-only', campaignId: `${registrationSurface(round)}-${round.family}-${month}`, registration, developmentDigest: rsiDigest(development),
    supply: { development: { rows: development.rows.length, sliceRows: development.rows.filter((row) => inSkillSlice(slice, scorer, row)).length, arms: Object.keys(development.arms), runs: development.runs.length,
      costCny: Object.fromEntries(Object.keys(development.arms).map((arm) => [arm, sum(arm)])) },
      developmentChoice: { frozen: choice.frozen, reason: choice.reason, candidates: choice.candidates, controls: choice.controls, noiseFloor: choice.noiseFloor,
        scores: Object.fromEntries(Object.entries(choice.scores).map(([arm, s]) => [arm, { overall: s.overall, slice: s.slice }])) },
      judge: scorer.judged ? judgeSupply(registration.judge, development) : null, image: development.image, developmentResultDigest: rsiDigest(harnessDevelopmentResult(choice)) } };
}

/** A file's text, checked against its sibling `.sha256` (`sha256sum -c` format) when the caller asks for it. @param {string} path @param {boolean} [checked] */
export async function readChecked(path, checked = true) {
  const bytes = await readFile(path);
  if (checked) {
    const sidecar = await readFile(`${path}.sha256`, 'utf8').catch(() => null);
    if (!sidecar) throw new Error('campaign_input_checksum_missing');
    if (sidecar.trim().split(/\s+/)[0] !== sha(bytes)) throw new Error('campaign_input_checksum_mismatch');
  }
  return bytes.toString('utf8');
}

async function main() {
  const { values } = parseArgs({ options: { development: { type: 'string' }, confirmation: { type: 'string' }, 'confirmation-gold': { type: 'string' }, 'development-verdicts': { type: 'string' },
    'confirmation-verdicts': { type: 'string' }, registration: { type: 'string' }, improvement: { type: 'string' }, month: { type: 'string' }, 'out-dir': { type: 'string' }, 'pilot-rationale': { type: 'string' },
    'id-prefix': { type: 'string' }, now: { type: 'string' }, 'paid-cost-budget': { type: 'string' }, 'development-only': { type: 'boolean' }, preview: { type: 'boolean' }, 'no-checksums': { type: 'boolean' } } });
  const checked = !values['no-checksums'];
  const json = async (path) => (path ? JSON.parse(await readChecked(path, checked)) : undefined);
  const text = async (path) => (path ? readChecked(path, checked) : undefined);
  const registration = await json(values.registration), improvement = await json(values.improvement);
  if (values['development-only'] || values.preview) {
    const result = developmentOnly({ development: await json(values.development), registration, developmentVerdicts: await text(values['development-verdicts']), improvement, month: values.month ?? 'preview' });
    if (values.preview) { console.log(JSON.stringify(result.supply, null, 1)); return; }
    await mkdir(values['out-dir'], { recursive: true });
    await writeFile(join(values['out-dir'], 'development-only.json'), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(values['out-dir'], 'supply.json'), `${JSON.stringify(result.supply, null, 2)}\n`);
    console.log(JSON.stringify({ status: result.status, frozen: result.supply.developmentChoice.frozen, reason: result.supply.developmentChoice.reason }));
    return;
  }
  const result = await buildHarnessCampaign({ development: await json(values.development), confirmation: await json(values.confirmation), registration, confirmationGold: await json(values['confirmation-gold']),
    developmentVerdicts: await text(values['development-verdicts']), confirmationVerdicts: await text(values['confirmation-verdicts']), month: values.month, pilotRationale: values['pilot-rationale'], improvement,
    paidCostBudget: values['paid-cost-budget'] ? Number(values['paid-cost-budget']) : undefined, idPrefix: values['id-prefix'] ?? '', now: values.now ?? new Date().toISOString() });
  await mkdir(values['out-dir'], { recursive: true });
  for (const [name, value] of [['manifest.json', result.manifest], ['inputs.json', result.inputs], ['supply.json', result.supply]]) await writeFile(join(values['out-dir'], name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, campaignId: result.manifest.id, groups: result.inputs.registration.statistics.G_target, sliceGroups: result.supply.confirmation.sliceGroups, frozen: result.supply.developmentChoice.frozen, directional: result.supply.directional }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });
