/**
 * Assemble a capability-skill campaign (skill_campaign.mjs) from recorded production runs: the development and
 * confirmation `skill-arms` sources (bench export), the improver's candidates and the registered failure slice. Writes the
 * manifest, the inputs (registration with its statistics, target, sources) and a supply report read from development
 * alone — the same shapes the runner, the evaluator and the monthly report use for frontier-selection.
 *
 *   node skill_assemble.mjs --development dev.json --confirmation conf.json --candidates candidates.json \
 *     --failure-calculators 2,19,31 --month 2026-11 --out-dir dir [--margin 0.05] [--id-prefix rehearsal-]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { rsiCampaignIssues } from '../../packages/domain/src/rsiCampaign.mjs';
import { rsiDigest } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { RSI_QUARTER_ALPHA } from './campaign_runner.mjs';
import { SKILL_COST_IDENTITY } from './evaluator.mjs';
import { beijingMonthEnd } from './frontier_assemble.mjs';
import { chooseSkillCandidate, skillArmsIssues, skillCampaignConsumerIdentity } from './skill_campaign.mjs';

export const SKILL_CAMPAIGN_REGISTRATION = Object.freeze({
  margin: 0.05,
  repeats: 3,
  campaignsPerQuarter: 3,
  procedure: { id: 'rsi-paired-group-v5', digest_codec: 'rfc8785-sha256-v1', test_alpha_fraction: 0.5, minimum_slice_groups: 25 },
  pilotRationale: 'MedCalc-Bench baseline v1 (2026-10-28, 120 rows) and a development screen: the failure slice is the calculators the baseline arm missed; a skill is expected to repair them without costing more than 1.1x.',
});

/** @param {{development:any, confirmation:any, candidates:any, failureCalculators:number[], month:string, margin?:number, idPrefix?:string, now?:string}} input */
export async function buildSkillCampaign({ development, confirmation, candidates, failureCalculators, month, margin = SKILL_CAMPAIGN_REGISTRATION.margin, idPrefix = '', now = new Date().toISOString() }) {
  for (const source of [development, confirmation]) {
    const issues = skillArmsIssues(source);
    if (issues.length) throw new Error(issues[0]);
  }
  const r = SKILL_CAMPAIGN_REGISTRATION;
  if (confirmation.repeats !== r.repeats) throw new Error('campaign_confirmation_repeats_unregistered');
  const slice = new Set(failureCalculators);
  const identity = await skillCampaignConsumerIdentity();
  const alpha = RSI_QUARTER_ALPHA / r.campaignsPerQuarter;
  const deadline = beijingMonthEnd(month);
  const statistics = {
    procedure: { ...r.procedure }, version: 1, paid_cost_budget: 1000, consumer_id: identity.implementationSha256, corpus_digest: rsiDigest(confirmation),
    mode: 'paired-t', deterministicConsumer: false, G_target: confirmation.rows.length,
    groups: confirmation.rows.map((row) => ({ id: `row-${row.id}`, family: 'medcalc', failure_slice: slice.has(Number(row.calculatorId)) })),
    families: { medcalc: { repeats: r.repeats, forms: { answer: 1 }, score_type: 'bounded-continuous', margin, pilot_rationale: r.pilotRationale } },
    claims: { 'targeted-repair': alpha }, cost_identity: SKILL_COST_IDENTITY, expires_at: deadline,
  };
  const registration = { failureCalculators: [...slice].sort((a, b) => a - b), margin, selection: { objective: 'failure-slice-gain', tieBreak: 'shorter-skill' }, statistics,
    candidates: (candidates.candidates ?? []).map((c) => ({ arm: c.arm, digest: c.digest, chars: c.chars, title: c.title })), improver: { model: candidates.model ?? null } };
  const target = { surface: 'capability-skill', dependencyDigest: identity.implementationSha256, baselineRevision: 'medcalc-open-domain-answer-no-personal-skill' };
  const sources = { [`development-${month}`]: development, [`confirmation-${month}`]: confirmation };
  const manifest = {
    schemaVersion: 1, id: `${idPrefix}capability-skill-medcalc-${month}`, surface: 'capability-skill', candidateKind: 'skill', claim: 'targeted-repair', automated: true,
    createdAt: now, deadline, budget: { campaignCny: 1000, monthCny: 30000 },
    models: { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improver: { provider: 'dashscope', model: candidates.model ?? 'qwen3.8-max' }, reviewer: { provider: 'dashscope', model: 'qwen3.8-max' } },
    target, registration: { digest: rsiDigest(registration), procedure: r.procedure.id, claim: 'targeted-repair' },
    data: { classification: 'public', sources: [
      { id: `development-${month}`, digest: rsiDigest(development), role: 'development', exposure: 'exposed' },
      { id: `confirmation-${month}`, digest: rsiDigest(confirmation), role: 'confirmation', exposure: 'sealed' }] },
  };
  const issues = rsiCampaignIssues(manifest);
  if (issues.length) throw new Error(issues[0]);
  const choice = chooseSkillCandidate(development, registration);
  const sum = (source, arm) => source.runs.filter((run) => run.arm === arm).reduce((total, run) => total + (run.cost ?? 0), 0);
  const supply = {
    development: { rows: development.rows.length, sliceRows: development.rows.filter((row) => slice.has(Number(row.calculatorId))).length, arms: Object.keys(development.arms), runs: development.runs.length,
      costCny: Object.fromEntries(Object.keys(development.arms).map((arm) => [arm, Math.round(sum(development, arm) * 1e6) / 1e6])) },
    confirmation: { rows: confirmation.rows.length, sliceGroups: statistics.groups.filter((g) => g.failure_slice).length, repeats: confirmation.repeats, runs: confirmation.runs.length,
      costCny: Object.fromEntries(Object.keys(confirmation.arms).map((arm) => [arm, Math.round(sum(confirmation, arm) * 1e6) / 1e6])) },
    developmentChoice: { frozen: choice.frozen, reason: choice.reason, candidates: choice.candidates },
    alpha: { allocated: alpha, testAlpha: alpha * r.procedure.test_alpha_fraction }, minimumGroups: r.procedure.minimum_slice_groups,
  };
  return { status: 'assembled', manifest, inputs: { registration, target, sources }, supply };
}

/**
 * Development only: the registered choice over the development source, recomputed here, when no candidate earned a
 * confirmation. Nothing is opened: no confirmation corpus exists, no alpha is reserved, the report says why it ended.
 */
export function developmentOnly({ development, candidates, failureCalculators, margin = SKILL_CAMPAIGN_REGISTRATION.margin, month }) {
  const issues = skillArmsIssues(development);
  if (issues.length) throw new Error(issues[0]);
  const registration = { failureCalculators: [...new Set(failureCalculators)].sort((a, b) => a - b), margin, selection: { objective: 'failure-slice-gain', tieBreak: 'shorter-skill' },
    candidates: (candidates.candidates ?? []).map((c) => ({ arm: c.arm, digest: c.digest, chars: c.chars, title: c.title })), improver: { model: candidates.model ?? null, rounds: candidates.rounds ?? null } };
  const choice = chooseSkillCandidate(development, registration);
  const slice = new Set(registration.failureCalculators);
  const sum = (arm) => Math.round(development.runs.filter((run) => run.arm === arm).reduce((total, run) => total + (run.cost ?? 0), 0) * 1e6) / 1e6;
  return { status: 'development-only', campaignId: `capability-skill-medcalc-${month}`, registration, developmentDigest: rsiDigest(development),
    supply: { development: { rows: development.rows.length, sliceRows: development.rows.filter((row) => slice.has(Number(row.calculatorId))).length, arms: Object.keys(development.arms),
      runs: development.runs.length, costCny: Object.fromEntries(Object.keys(development.arms).map((arm) => [arm, sum(arm)])) },
      developmentChoice: { frozen: choice.frozen, reason: choice.reason, candidates: choice.candidates, scores: Object.fromEntries(Object.entries(choice.scores).map(([arm, s]) => [arm, { overall: s.overall, slice: s.slice }])) },
      improverSpendCny: Math.round((candidates.spend ?? []).reduce((total, row) => total + (row.cny ?? 0), 0) * 1e6) / 1e6 } };
}

async function main() {
  const { values } = parseArgs({ options: { development: { type: 'string' }, confirmation: { type: 'string' }, candidates: { type: 'string' }, 'failure-calculators': { type: 'string' },
    month: { type: 'string' }, 'out-dir': { type: 'string' }, margin: { type: 'string' }, 'id-prefix': { type: 'string' }, now: { type: 'string' }, 'development-only': { type: 'boolean' } } });
  const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
  if (values['development-only']) {
    const result = developmentOnly({ development: await json(values.development), candidates: await json(values.candidates), failureCalculators: values['failure-calculators'].split(',').map(Number),
      margin: values.margin ? Number(values.margin) : undefined, month: values.month });
    await mkdir(values['out-dir'], { recursive: true });
    await writeFile(join(values['out-dir'], 'development-only.json'), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(values['out-dir'], 'supply.json'), `${JSON.stringify(result.supply, null, 2)}\n`);
    console.log(JSON.stringify({ status: result.status, frozen: result.supply.developmentChoice.frozen, reason: result.supply.developmentChoice.reason }));
    return;
  }
  const result = await buildSkillCampaign({ development: await json(values.development), confirmation: await json(values.confirmation), candidates: await json(values.candidates),
    failureCalculators: values['failure-calculators'].split(',').map(Number), month: values.month, margin: values.margin ? Number(values.margin) : undefined,
    idPrefix: values['id-prefix'] ?? '', now: values.now ?? new Date().toISOString() });
  await mkdir(values['out-dir'], { recursive: true });
  for (const [name, value] of [['manifest.json', result.manifest], ['inputs.json', result.inputs], ['supply.json', result.supply]]) await writeFile(join(values['out-dir'], name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, campaignId: result.manifest.id, groups: result.inputs.registration.statistics.G_target, sliceGroups: result.supply.confirmation.sliceGroups, frozen: result.supply.developmentChoice.frozen }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });
