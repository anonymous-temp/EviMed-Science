/**
 * The signed closure of a harness-patch / tool-patch campaign whose receipt the evaluator refused because some runs have no settled
 * cost (`campaign_cost_measurement_missing`), written for MedCalc round 1 (2026-11-02): 2 of 822 runs had a usage record that still
 * showed an uncertain call or an open reservation when the driver read it.
 *
 * What the binding covers, and why this is a closure and not a repair. A run's cost is part of the confirmation source; the source's
 * digest is the corpus digest, the manifest names it, and the checkpoint is bound to the digest of manifest and inputs together. A cost
 * written into the source afterwards is another source: another corpus (the opened-corpus record and the quarter's reservation name the
 * old digest) and another binding (`campaign_checkpoint_input_changed`). The result digest the evaluator's request carries covers the
 * observations (group, arm, repeat, quality) and not costs, so the scores can be shown to be the same bytes; but a receipt that put costs
 * into a source nobody had digested with them would be an attestation the corpus does not support. So the evaluator does not repair the
 * run: it closes the campaign with a report that says what it did.
 *
 * What this signs, and only this:
 *  - the campaign is the one the checkpoint is bound to (manifest and inputs digest to the checkpoint's binding), still awaiting its
 *    evaluation (no verdict, no outcome), opened once (look 1);
 *  - the development choice and the confirmation observations are recomputed from the recorded runs, twice, and are the checkpoint's
 *    (frozen policy digest, confirmation result digest): not one score moved;
 *  - the runs without a settled cost are exactly the runs the cost records name (row, arm, repeat, run id, status), each with the ledger's
 *    record of that run (its settled sum, its open reservation and uncertain calls); each takes that settled sum as its cost, a lower
 *    bound, and every other run keeps the cost the source carries;
 *  - the registered statistics (statistics.py, the procedure the registration pins) are recomputed over the same observations with
 *    those costs, with the attestations the evaluator's receipt would have carried, and the verdict is recorded as the procedure gave it;
 *  - the deviation is stated in the signed payload (`deviation`): the closure is not the receipt path, it attests no complete cost, and
 *    the error-budget reservation is untouched: this module reads no ledger and writes none (`alpha.reservation`).
 *
 * It uses only exports the round-1 lab image already has (evaluator.mjs, campaign_runner.mjs, harness_campaign.mjs), because the lab
 * runs it in the image the campaign ran in: the registered consumer identity is a digest of that image's files and pins the scoring code,
 * so the code that recomputes the campaign must be the code that ran it. `rsi-lab-harness.sh <month> <family> close` does that.
 *
 *   node harness_closure.mjs <manifest.json> <inputs.json> <checkpoint.json> <cost-closure.json> <evaluator-key.pem> <out.json>
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { evaluatorKey, signEnvelope } from './evaluator.mjs';
import { digest, evaluateStatistics } from './campaign_runner.mjs';
import { HARNESS_COST_IDENTITY, chooseHarnessCandidate, harnessCampaignConsumerIdentity, harnessDevelopmentResult, harnessObservations } from './harness_campaign.mjs';

const fail = (reason) => { throw new Error(reason); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const runKey = (row, arm, repeat) => `${row}\0${arm}\0${repeat}`;

/** The consumer identity of the surface the campaign is on; the tool-patch module is loaded only for that surface (an older image has none). @param {string} surface @param {any} registration */
async function consumerIdentity(surface, registration) {
  if (surface === 'tool-patch') return (await import('./tool_patch_campaign.mjs')).toolPatchCampaignConsumerIdentity(registration);
  return harnessCampaignConsumerIdentity(registration);
}

/** The directional rule, when the image has it (a campaign below the procedure's minimum groups is never a verdict). @param {any} statistics */
async function directionalOf(statistics) {
  try { return (await import('./directional.mjs')).directionalCounts(statistics); } catch { return null; }
}

/**
 * Check the cost records against the source: they name exactly the confirmation runs that have no settled cost, each once, with the run
 * id and status the source has, and a ledger record that is a settled sum.
 * @param {any} source @param {any} closure @returns {Map<string, { cost: number, ledger: any }>}
 */
export function closureCosts(source, closure) {
  if (closure?.kind !== 'harness-cost-closure' || closure.schema !== 1 || !Array.isArray(closure.runs)) fail('campaign_cost_closure_invalid');
  const missing = source.runs.filter((run) => !finite(run.cost));
  if (!missing.length) fail('campaign_cost_closure_not_needed');
  const byKey = new Map();
  for (const entry of closure.runs) {
    const key = runKey(entry?.row, entry?.arm, entry?.repeat);
    const ledger = entry?.ledger;
    if (byKey.has(key) || !finite(ledger?.cost) || ledger.cost < 0 || typeof entry.runId !== 'string' || typeof entry.status !== 'string') fail('campaign_cost_closure_invalid');
    byKey.set(key, { cost: ledger.cost, ledger: { cost: ledger.cost, openCost: ledger.openCost ?? null, uncertain: ledger.uncertain ?? null, calls: ledger.calls ?? null }, entry });
  }
  const wanted = new Set(missing.map((run) => runKey(run.row, run.arm, run.repeat)));
  if (byKey.size !== wanted.size || [...byKey.keys()].some((key) => !wanted.has(key))) fail('campaign_cost_closure_runs_differ');
  for (const run of missing) {
    const found = byKey.get(runKey(run.row, run.arm, run.repeat)).entry;
    if (found.runId !== run.runId || found.status !== run.status) fail('campaign_cost_closure_runs_differ');
  }
  return byKey;
}

/**
 * Recompute and describe. Throws a closed `campaign_*` code when the campaign is not the one the checkpoint is bound to, is not waiting
 * for its evaluation, or its scores cannot be reproduced.
 * @param {{manifest:any, inputs:any, checkpoint:any, closure:any, closureSha256?:string, now?:string, statisticsPython?:string, statisticsModulePath?:string}} input
 */
export async function closurePayload({ manifest, inputs, checkpoint, closure, closureSha256 = null, now = new Date().toISOString(), statisticsPython, statisticsModulePath }) {
  if (!['harness-patch', 'tool-patch'].includes(manifest.surface)) fail('campaign_consumer_not_qualified');
  const binding = digest({ manifest, inputs });
  if (checkpoint.binding !== binding) fail('campaign_evaluator_binding_changed');
  if (checkpoint.evaluation || checkpoint.outcome || checkpoint.stages?.confirmation?.status !== 'completed' || !checkpoint.frozenPolicy) fail('campaign_closure_not_awaiting');
  if (checkpoint.confirmationLooks !== 1) fail('campaign_evaluator_repeated_look');
  const registration = inputs.registration, statistics = registration.statistics;
  const development = manifest.data.sources.find((row) => row.role === 'development'), confirmation = manifest.data.sources.find((row) => row.role === 'confirmation');
  for (const source of [development, confirmation]) if (digest(inputs.sources[source.id]) !== source.digest) fail('campaign_source_changed');
  const identity = await consumerIdentity(manifest.surface, registration);
  if (statistics?.consumer_id !== identity.implementationSha256 || statistics?.corpus_digest !== confirmation.digest) fail('campaign_evaluation_consumer_or_corpus_changed');
  if (statistics.cost_identity !== HARNESS_COST_IDENTITY || statistics.deterministicConsumer !== false || statistics.mode !== 'paired-t') fail('campaign_cost_identity_unsupported');
  // The development choice and the frozen policy, as the receipt checks them.
  const choice = chooseHarnessCandidate(inputs.sources[development.id], registration), frozen = checkpoint.frozenPolicy;
  if (!choice.frozen || choice.frozen.arm !== frozen.arm || choice.frozen.harnessDigest !== frozen.harnessDigest || choice.frozen.imageDigest !== frozen.imageDigest
    || digest(frozen) !== checkpoint.frozenPolicyDigest || digest(harnessDevelopmentResult(choice)) !== frozen.developmentResultDigest) fail('campaign_evaluator_development_differs');
  if (!(Date.parse(checkpoint.frozenAt) < Date.parse(checkpoint.confirmationOpenedAt))) fail('campaign_evaluator_chronology_invalid');
  // The confirmation scores, twice, and equal to the checkpoint's: not one score moved.
  const source = inputs.sources[confirmation.id];
  const runs = [0, 1].map(() => { const measured = harnessObservations(source, registration, frozen); return { result: { observations: measured.observations, scores: measured.scores ?? null }, reason: measured.reason }; });
  if (runs[0].reason || digest(runs[0].result) !== digest(runs[1].result)) fail('campaign_evaluator_nondeterministic');
  if (digest(runs[0].result) !== checkpoint.stages.confirmation.resultDigest || digest(checkpoint.stages.confirmation.result) !== checkpoint.stages.confirmation.resultDigest) fail('campaign_evaluator_recomputation_differs');
  // The costs: every run keeps what the source carries; the runs without one take the ledger's settled sum.
  const repairs = closureCosts(source, closure);
  const costOf = new Map();
  for (const run of source.runs) {
    const group = `row-${run.row}`, arm = run.arm === 'baseline' ? 'baseline' : 'candidate';
    costOf.set(`${group}\0${arm}\0answer\0${run.repeat}`, finite(run.cost) ? run.cost : repairs.get(runKey(run.row, run.arm, run.repeat)).cost);
  }
  const observations = runs[0].result.observations.map((row) => {
    const cost = costOf.get(`${row.group}\0${row.arm}\0${row.form}\0${row.repeat}`);
    if (!finite(cost) || cost < 0) fail('campaign_cost_measurement_missing');
    return { ...row, cost };
  });
  if (observations.length !== costOf.size) fail('campaign_cost_measurement_missing');
  // The registered statistics, with the attestations the receipt would have carried.
  const attestations = { registration_digest: digest(statistics), confirmation_exposed: false, look: 1, complete_costs: true, cost_identity: statistics.cost_identity, expired_budget: Date.parse(now) >= Date.parse(statistics.expires_at) };
  const statisticsInput = { registration: statistics, observations, receipt: { ...attestations, deterministic_qualification: null, now: now.replace(/Z$/, '+00:00') } };
  let evaluated = await evaluateStatistics(statisticsInput, { pythonExecutable: statisticsPython, modulePath: statisticsModulePath });
  if (!['qualified', 'not-qualified', 'inconclusive'].includes(evaluated.decision)) fail(evaluated.reason ?? 'campaign_statistics_failed');
  const directional = await directionalOf(statistics);
  if (directional) evaluated = { ...evaluated, decision: 'inconclusive', reasons: ['campaign_directional_below_minimum_groups', ...(evaluated.reasons ?? [])], directional };
  const totals = { baseline: 0, candidate: 0 };
  for (const row of observations) totals[row.arm] += row.cost;
  return {
    type: 'rsi-campaign-closure-v1', issuedAt: now, campaignId: manifest.id, surface: manifest.surface, binding,
    corpusDigest: confirmation.digest, registrationDigest: digest(statistics), frozenPolicyDigest: checkpoint.frozenPolicyDigest,
    confirmationResultDigest: checkpoint.stages.confirmation.resultDigest, observationDigest: digest(runs[0].result.observations), confirmationOpenedAt: checkpoint.confirmationOpenedAt, look: 1,
    alpha: { claims: statistics.claims, reservation: 'unchanged: made when the corpus was opened (look 1); this closure reads no ledger and writes none' },
    deviation: {
      code: 'cost_closed_from_ledger_record',
      reason: 'campaign_cost_measurement_missing: the evaluator\'s receipt refuses runs without a settled cost, and a cost cannot be added to a sealed, digested source without making it another corpus',
      effect: 'each listed run carries the ledger\'s settled sum for its calls, a lower bound (the ledger also held an uncertain call or an open reservation); no score, row, repeat or arm changed; the statistics ran over the recorded observations with these costs',
      runs: [...repairs.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, found]) => ({ row: found.entry.row, arm: found.entry.arm, repeat: found.entry.repeat, runId: found.entry.runId, status: found.entry.status,
        usedCost: found.cost, ledger: found.ledger, ...(found.entry.resultSha256 ? { resultSha256: found.entry.resultSha256 } : {}) })),
      costRecords: closureSha256,
    },
    statistics: { decision: evaluated.decision, reasons: evaluated.reasons ?? [], quantities: evaluated.quantities ?? null, scope: directional ? 'directional-reference' : 'registered-population-task-family',
      inputDigest: digest(statisticsInput), outputDigest: evaluated.outputDigest ?? null, costTotals: { baseline: Math.round(totals.baseline * 1e6) / 1e6, candidate: Math.round(totals.candidate * 1e6) / 1e6 }, ...(directional ? { directional } : {}) },
    consumer: identity,
  };
}

async function main() {
  const [manifestPath, inputsPath, checkpointPath, closurePath, keyPath, outPath] = process.argv.slice(2);
  if (!outPath) throw new Error('Usage: harness_closure.mjs <manifest.json> <inputs.json> <checkpoint.json> <cost-closure.json> <evaluator-key.pem> <out.json>');
  const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
  const { key, publicKeySha256 } = evaluatorKey(await readFile(keyPath, 'utf8'));
  const stored = await json(checkpointPath), closureBytes = await readFile(closurePath);
  const payload = await closurePayload({ manifest: await json(manifestPath), inputs: await json(inputsPath), checkpoint: stored.checkpoint ?? stored, closure: JSON.parse(closureBytes.toString('utf8')), closureSha256: sha(closureBytes),
    statisticsModulePath: process.env.RSI_STATISTICS_PYTHONPATH ?? '/opt/evimed/rsi-python' });
  await writeFile(outPath, `${JSON.stringify(signEnvelope(payload, key))}\n`, { mode: 0o640 });
  console.log(JSON.stringify({ status: 'signed', type: payload.type, publicKeySha256, decision: payload.statistics.decision, reasons: payload.statistics.reasons, deviationRuns: payload.deviation.runs.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(JSON.stringify({ status: 'refused', reason: /^campaign_[a-z_]+$/.test(error.message) ? error.message : 'campaign_closure_failed' })); process.exitCode = 1; });
}
