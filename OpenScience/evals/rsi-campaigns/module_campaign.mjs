/**
 * The module-policy consumer (2026-11-04): the harness-patch campaign (harness_campaign.mjs) for a candidate that is one component of one of the platform's
 * own module policies, the text the serving layer can activate (`rsiServingAdapters.mjs` `components`, `parseRsiPolicyCandidate`). Everything a campaign does is the
 * harness consumer's (the A/A control, K candidates, the sealed confirmation, the choice rule, the settled costs, the directional rule, the Claude improvers and
 * judge); this file is the kit that says what differs:
 *
 *  - the candidate: `arms[id].harness = {digest, chars, alwaysOnChars, title, policy: {surface, component, text}}`, exactly one component, the surface's, valid by the
 *    function serving uses (`validateModuleEvolutionPolicy`), and not the incumbent's text; the digest is over surface, component, text and the consumer's dependency
 *    digest (`image.digest`, computed by `computeRsiDependencyClosure`: the same text over another editor is another candidate);
 *  - the sources: `kind: module-arms`, written by module_arms.mjs on the operator's box, which runs production's own classes on `deepseek-flash`. A run carries its
 *    decisions or rewrites (`answer.units`, one per variant of the case, the variants being one group), its tokens call by call, the cost those tokens come to at the
 *    reference price list (recomputed here, so a cost is never typed), and the policy revision production's class says it served;
 *  - the scorers: the closed table of module_scorers.mjs, and for a scorer that rests on a model's writing the bar `moduleDeterministicChecks`: a candidate whose
 *    deterministic pass share is worse than the incumbent's beyond the noise of the incumbent's own repeats is not eligible, and not confirmed;
 *  - the error budget is the consumer's (`RSI_CAMPAIGN_SURFACES[surface].consumer`): frontier-screen and frontier-edit, one class and one policy document, share one;
 *  - what can qualify: `moduleDirectional` below. Every other round is a directional reading, however many groups it has;
 *  - the end: a qualified round is a pull-request proposal, like a patch of the image, and the signed report (`harness_report.mjs`, component and text digest named) is the evidence it cites.
 *    Nothing is imported: production's fuses and witnesses do not exist for these surfaces, and the text lives in code a reviewed release ships. The target's baseline is that code's own text.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalRsiJson } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { validateModuleEvolutionPolicy } from '../../apps/server/src/moduleEvolutionPolicies.mjs';
import { priceListFor, priceUsage } from '../../packages/domain/src/metering.mjs';
import { HARNESS_BASELINE_ARM, HARNESS_CONTROL_ARM, HARNESS_SOLVER, chooseHarnessCandidate, harnessCampaignIssue, harnessImageValid, harnessObservations, registrationSurface } from './harness_campaign.mjs';
import { directionalCounts, groupCounts } from './directional.mjs';
import { moduleDeterministicChecks, moduleScorer } from './module_scorers.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysWithin = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.includes(key));
const isText = (value) => typeof value === 'string';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const HEX64 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export const MODULE_SOURCE_KIND = 'module-arms';
/** The cost identity of a run on the operator's box: the provider's tokens call by call at the reference price list of the source (`metering.mjs`), read from the answer that came back; no ledger, and nothing the lab has to take on trust. */
export const MODULE_COST_IDENTITY = 'operator-box-reference-price-cny';
/** What a surface changes of its module's policy: the one component the serving layer lets it supply, read from no other table on purpose (tests/moduleCampaign.test.mjs holds it to `parseRsiPolicyCandidate`). */
export const MODULE_SURFACES = Object.freeze({
  'frontier-screen': Object.freeze({ moduleId: 'frontier', component: 'screenInstructions' }),
  'frontier-edit': Object.freeze({ moduleId: 'frontier', component: 'editInstructions' }),
});
/** @param {any} surface */
export const isModuleSurface = (surface) => isText(surface) && Object.hasOwn(MODULE_SURFACES, surface);

// ---------------------------------------------------------------------------------------------------------------- candidate

/** sha256 of the canonical JSON of surface, component and text and the consumer they were measured on. @param {{ surface: string, component: string, text: string }} policy @param {{ digest: string }} image */
export const modulePolicyDigest = (policy, image) => sha(canonicalRsiJson({ component: policy.component, dependencyDigest: image.digest, surface: policy.surface, text: policy.text }));

/**
 * The arm of a candidate as a Claude session wrote it, `{title?, policy: {<component>: text}}`, or a closed code thrown: a policy that changes anything but the
 * surface's one component (`module_candidate_not_one_component`), one the serving validation refuses (`module_candidate_invalid`), the incumbent's own text (`module_candidate_unchanged`).
 * @param {string} surface @param {any} candidate @param {{ id: string, digest: string }} image @param {string} incumbentComponentSha256
 */
export function moduleCandidateArm(surface, candidate, image, incumbentComponentSha256) {
  const row = MODULE_SURFACES[surface];
  if (!row || !keysWithin(candidate, ['title', 'policy']) || !record(candidate.policy) || (candidate.title !== undefined && !isText(candidate.title))) throw new Error('module_candidate_invalid');
  const keys = Object.keys(candidate.policy);
  if (keys.length !== 1 || keys[0] !== row.component) throw new Error('module_candidate_not_one_component');
  if (!validateModuleEvolutionPolicy(row.moduleId, candidate.policy)) throw new Error('module_candidate_invalid');
  const text = candidate.policy[row.component];
  if (sha(text) === incumbentComponentSha256) throw new Error('module_candidate_unchanged');
  const policy = { surface, component: row.component, text }, digest = modulePolicyDigest(policy, image);
  return { arm: `cand-${digest.slice(0, 12)}`, harness: { digest, chars: text.length, alwaysOnChars: text.length, ...(candidate.title === undefined ? {} : { title: candidate.title }), policy } };
}

function candidateValid(id, arm, source, registration) {
  const h = arm?.harness, policy = h?.policy, row = MODULE_SURFACES[registrationSurface(registration)];
  return Boolean(row) && keysWithin(arm, ['harness']) && keysWithin(h, ['digest', 'chars', 'alwaysOnChars', 'title', 'policy']) && keysWithin(policy, ['surface', 'component', 'text'])
    && policy.surface === registrationSurface(registration) && policy.component === row.component && isText(policy.text) && validateModuleEvolutionPolicy(row.moduleId, { [row.component]: policy.text })
    && harnessImageValid(source.image) && /^cand-[a-f0-9]{12}$/.test(id) && HEX64.test(h.digest ?? '') && id === `cand-${h.digest.slice(0, 12)}` && h.digest === modulePolicyDigest(policy, source.image)
    && h.chars === policy.text.length && h.alwaysOnChars === policy.text.length && (h.title === undefined || isText(h.title)) && sha(policy.text) !== source.incumbent?.componentSha256;
}

// ------------------------------------------------------------------------------------------------------------------- the cost

const tokens = (value) => Number.isSafeInteger(value) && value >= 0;
/**
 * What a run's calls come to at a price list, or null when any of them cannot be priced. The rule is the gateway's: `priceUsage` per call, each at its own peak flag.
 * @param {any} calls @param {string} model @param {any} prices
 */
export function moduleRunCost(calls, model, prices) {
  if (!Array.isArray(calls) || !prices) return null;
  let total = 0;
  for (const call of calls) {
    if (!keysWithin(call, ['cacheHit', 'cacheMiss', 'output', 'peak']) || !tokens(call.cacheHit) || !tokens(call.cacheMiss) || !tokens(call.output) || typeof call.peak !== 'boolean') return null;
    const priced = priceUsage({ resourceType: 'model', model, ...call }, prices);
    if (!priced.priced || priced.currency !== 'CNY') return null;
    total += priced.cost;
  }
  return Math.round(total * 1e8) / 1e8;
}

// ---------------------------------------------------------------------------------------------------------------------- sources

/** What is left to refuse of a source the harness validation found well formed. @param {any} source @param {any} registration @returns {string[]} */
function sourceIssues(source, registration) {
  const issues = new Set();
  if (source.surface !== registrationSurface(registration)) issues.add('module_arms_surface_invalid');
  if (!keysWithin(source.incumbent, ['revisionId', 'componentSha256']) || !IDENTIFIER.test(source.incumbent.revisionId ?? '') || !HEX64.test(source.incumbent.componentSha256 ?? '')) issues.add('module_arms_incumbent_invalid');
  if (source.model !== HARNESS_SOLVER.model) issues.add('module_arms_model_invalid');
  const prices = priceListFor(source.priceVersion);
  const inputs = new Map(), served = new Set(), candidateServed = {};
  const scorer = moduleScorer(registration);
  for (const run of source.runs) {
    if (run.status === 'timeout') issues.add('harness_arms_runs_infrastructure');
    const cost = moduleRunCost(run.calls, source.model, prices);
    if (cost === null || cost !== run.cost) issues.add('module_arms_cost_invalid');
    if (run.status === 'succeeded') {
      if (run.answer === null) issues.add('harness_arms_runs_invalid');
      // What the class says it served, one value per arm: a candidate's is not the incumbent's, or it measured the incumbent under another name (production's editor falls back with instructions older than its answer's keys).
      if (run.arm === HARNESS_BASELINE_ARM || run.arm === HARNESS_CONTROL_ARM) served.add(run.policyRevisionId);
      else (candidateServed[run.arm] ??= new Set()).add(run.policyRevisionId);
    } else if (run.answer !== null) issues.add('harness_arms_runs_invalid');
    if (!scorer.validAnswer(run.answer)) issues.add('harness_arms_runs_invalid');
    // Every arm and repeat of a case read the same input: what differs between them is the policy.
    for (const unit of run.answer?.units ?? []) {
      const key = `${run.row}\0${unit.variant}`;
      if (inputs.has(key) && inputs.get(key) !== unit.inputSha256) issues.add('module_arms_inputs_differ');
      inputs.set(key, unit.inputSha256);
    }
  }
  if (served.size > 1 || Object.values(candidateServed).some((values) => values.size > 1 || values.has(null) || [...values].some((value) => served.has(value)))) issues.add('module_arms_candidate_not_served');
  return [...issues];
}

/** A measurement of one arm in the shape `moduleDeterministicChecks` reads: a run that delivered nothing has no number that passed. @param {any} source @param {any} scorer @param {string} arm @param {number} [repeat] */
function measurement(source, scorer, arm, repeat) {
  const units = source.runs.filter((run) => run.arm === arm && (repeat === undefined || run.repeat === repeat)).flatMap((run) => {
    const delivered = run.status === 'succeeded' ? run.answer?.units ?? [] : [];
    return delivered.length ? delivered.map((unit) => ({ groupId: String(run.row), deterministicPassed: scorer.deterministicPassed(unit) })) : [{ groupId: String(run.row), deterministicPassed: false }];
  });
  return { units };
}

/**
 * The bar of a candidate on a source: against every repeat of the incumbent's arms, the baseline and, in development, its A/A control. Undefined for a scorer with no
 * deterministic check (a checklist is promoted on its gain: it claims no flag of its own).
 * @param {any} source @param {any} registration @param {string} arm
 */
function bar(source, registration, arm) {
  const scorer = moduleScorer(registration);
  if (!scorer?.deterministicPassed) return undefined;
  const incumbents = Object.keys(source.arms).filter((id) => id === HARNESS_BASELINE_ARM || id === HARNESS_CONTROL_ARM).sort()
    .flatMap((id) => Array.from({ length: source.repeats }, (_, repeat) => measurement(source, scorer, id, repeat)));
  const checks = moduleDeterministicChecks(measurement(source, scorer, arm), incumbents);
  return { deterministic: { ...checks, eligible: checks.ran && checks.nonInferior } };
}

/** @param {any} registration @param {any} development */
function developmentIssue(registration, development) {
  const scorer = moduleScorer(registration);
  // The bar needs three runs of the incumbent, the statistics three repeats of a confirmation; a registration short of either can never be read, so it is refused before a run is paid for.
  if ((scorer.deterministicPassed && development.repeats < 2) || !(registration.repeats?.confirmation >= 3)) return 'campaign_repeats_unregistered';
  if (scorer.judged && registration.judge?.form !== 'absolute') return 'campaign_judge_unregistered';
  return null;
}

/** The harness consumer, specialised (harness_campaign.mjs `HARNESS_KIT`). */
export const MODULE_KIT = Object.freeze({
  surfaces: Object.freeze(Object.keys(MODULE_SURFACES)), sourceKind: MODULE_SOURCE_KIND, scorer: moduleScorer, costIdentity: MODULE_COST_IDENTITY, candidateValid,
  answerValid: (answer) => answer === null || record(answer), costValid: (cost) => finite(cost) && cost >= 0, sourceIssues, developmentIssue, bar,
});

// --------------------------------------------------------------------------------------------------------------------- identity

/**
 * The consumer as the evaluator pins it: the harness consumer's files this one specialises, this surface's own files, the scorer and the surface the registration names.
 * @param {any} [registration]
 */
export async function moduleCampaignConsumerIdentity(registration) {
  const scorer = moduleScorer(registration);
  if (!scorer) throw new Error('campaign_scorer_not_qualified');
  const components = ['skill_campaign.mjs', 'skill_scorers.mjs', 'harness_scorers.mjs', 'harness_campaign.mjs', 'directional.mjs', 'module_scorers.mjs', 'module_campaign.mjs']
    .map((name) => ({ path: `evals/rsi-campaigns/${name}`, sha256: sha(readFileSync(new URL(`./${name}`, import.meta.url))) }));
  return { revision: 'module-arms-v1', surface: registration.surface, scorer: scorer.id, components, implementationSha256: sha(JSON.stringify({ surface: registration.surface, scorer: scorer.id, components })) };
}

// ------------------------------------------------------------------------------------------------------------------- the runner

/** Development: the harness consumer's choice, with the bar on every candidate's row. @param {any} source @param {any} registration */
export const chooseModuleCandidate = (source, registration) => chooseHarnessCandidate(source, registration, MODULE_KIT);

/**
 * Confirmation: the harness consumer's observations and, for a scorer with a deterministic check, the bar over the confirmation's repeats. A regression there ends the
 * campaign by name, as it ended a model-scored promotion online: quality may have gained while the numbers got worse.
 * @param {any} source @param {any} registration @param {any} frozen
 */
export function moduleConfirmation(source, registration, frozen) {
  const measured = harnessObservations(source, registration, frozen, MODULE_KIT);
  if (measured.reason) return { result: { observations: measured.observations, scores: measured.scores ?? null }, reason: measured.reason };
  const checked = bar(source, registration, frozen.arm);
  return { result: { observations: measured.observations, scores: measured.scores ?? null, ...checked }, reason: checked && !checked.deterministic.eligible ? (checked.deterministic.ran ? 'campaign_deterministic_check_regressed' : 'campaign_deterministic_checks_missing') : null };
}

/**
 * Whether a round's confirmation is sealed: rows drawn from a public export by a registered draw (`confirmationDraw`: the export's digest and the salt). A case of the repo is not, whatever a label
 * says: the improver reads it with its gold. A draw has no gold either, so anyone holding the file can score it: what binds it is the registered draw and a candidate frozen on development, not secrecy.
 * @param {any} registration
 */
export const moduleConfirmationSealed = (registration) => /^[a-f0-9]{64}$/.test(registration?.confirmationDraw?.exportSha256 ?? '') && Array.isArray(registration?.rows?.confirmation) && registration.rows.confirmation.length > 0 && registration.rows.confirmation.every((id) => String(id).startsWith('export-'));

/**
 * Why a round cannot qualify, or null when it can: a confirmation that is not sealed; a sealed one scored by a code floor alone (with no gold the floor and the bar are one test, and nothing pulls
 * against writing less); fewer groups than the procedure's minimum. Such a round is a directional reading: no α, its corpus spent (campaign_runner.mjs `confirmationDecision`). So only `frontier-edit`
 * scored by `frontier-source` on an export draw of at least the minimum can qualify. Decided from the registration alone.
 * @param {any} registration @returns {{ groups: number, sliceGroups: number | null, minimum: number, code: string } | null}
 */
export function moduleDirectional(registration) {
  const statistics = registration.statistics, counts = groupCounts(statistics);
  const code = !moduleConfirmationSealed(registration) ? 'campaign_directional_confirmation_not_sealed' : !moduleScorer(registration)?.judged ? 'campaign_directional_export_floor_only' : directionalCounts(statistics) ? 'campaign_directional_below_minimum_groups' : null;
  return code ? { ...counts, code } : null;
}

/** The target a campaign binds: the consumer the arms ran on and the incumbent production reported. @param {string} surface @param {any} development */
export const moduleTarget = (surface, development) => ({ surface, dependencyDigest: development.image.digest, baselineRevision: development.incumbent.revisionId });

/** The runner's validation: the harness consumer's, and the target naming what the arms actually ran on. @param {any} manifest @param {any} inputs @param {{ id: string }} dev @param {{ id: string }} confirm */
export function moduleCampaignIssue(manifest, inputs, dev, confirm) {
  const issue = harnessCampaignIssue(manifest, inputs, dev, confirm, MODULE_KIT);
  if (issue) return issue;
  // The manifest says what the rows are: a case of the repo is not sealed, a registered draw is.
  if (manifest.data.classification !== 'synthetic' && (confirm.exposure === 'sealed') !== moduleConfirmationSealed(inputs.registration)) return 'campaign_confirmation_not_independent';
  const development = inputs.sources[dev.id], confirmation = inputs.sources[confirm.id], target = moduleTarget(manifest.surface, development);
  if (canonicalRsiJson(manifest.target) !== canonicalRsiJson(target) || canonicalRsiJson(moduleTarget(manifest.surface, confirmation)) !== canonicalRsiJson(target)) return 'campaign_target_changed';
  return null;
}
