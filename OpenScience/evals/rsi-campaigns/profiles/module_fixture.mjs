/**
 * Synthetic module-policy campaigns for the lifecycle tests (tests/moduleCampaign.test.mjs). Every row, decision, rewrite, verdict and token count is invented and seeded; nothing here
 * certifies a benefit. A fixture is built the way a campaign is: the arms' exports (a development source with gold, a SEALED confirmation source with its gold apart), a pre-registration from
 * `moduleRound`, verdict records from `fidelityVerdicts`, and `buildHarnessCampaign` joining them. The image digest is this tree's real dependency closure, because a candidate's digest is computed over it.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rsiClosureSettings } from '../../../apps/server/src/rsiClosureSettings.mjs';
import { computeRsiDependencyClosure } from '../../../apps/server/src/rsiDependencyClosure.mjs';
import { REFERENCE_PRICE_LIST } from '../../../packages/domain/src/metering.mjs';
import { buildHarnessCampaign, roundRegistrationDigest } from '../harness_assemble.mjs';
import { fidelityVerdicts, moduleRound } from '../module_arms.mjs';
import { MODULE_SURFACES, moduleCandidateArm, moduleRunCost } from '../module_campaign.mjs';
import { generator, improvementOf } from './harness_fixture.mjs';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const INCUMBENT_TEXT = 'The code default of the component under test.';
export const INCUMBENT = Object.freeze({ revisionId: `default:${'d'.repeat(64)}`, componentSha256: sha256(INCUMBENT_TEXT) });
export const JUDGE = Object.freeze({ id: 'claude-fidelity-test', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', form: 'absolute', passes: 3, maxCalls: 5000,
  qualification: { measuredOn: 'judge-noise.json sha256:0123456789abcdef frontier-source/absolute (synthetic)', form: 'absolute', scale: 'verdict-0-1', agreement: 0.95, noiseSd: 0.0155, noiseBand95: 0.0304 } });
export const judgeOf = (changes = {}) => ({ ...structuredClone(JUDGE), ...changes });

const closures = new Map();
/** This tree's closure digest of a surface, once per process. @param {string} surface */
export async function closureImage(surface) {
  if (!closures.has(surface)) closures.set(surface, computeRsiDependencyClosure({ rootDir: ROOT, surface, settings: rsiClosureSettings(surface) }));
  const closure = await closures.get(surface);
  if (!closure.qualified) throw new Error(`fixture_closure_unqualified:${closure.issues}`);
  return { id: `module-${surface}`, digest: closure.dependencyDigest };
}

/** A candidate arm for a surface on an image. */
export const candidateOn = (surface, text, image, title = 'fixture candidate') => moduleCandidateArm(surface, { title, policy: { [MODULE_SURFACES[surface].component]: text } }, image, INCUMBENT.componentSha256);

const tokensFor = (random) => [{ cacheHit: Math.round(2000 * (0.8 + 0.4 * random())), cacheMiss: Math.round(1500 * (0.8 + 0.4 * random())), output: Math.round(400 * (0.85 + 0.3 * random())), peak: true }];

/** What differs between the scorers: a row, a right or wrong answer unit (`right`), and whether its code check passed (`numbers`). */
export const KITS = {
  'autopilot-checklist': { row: (id, inSlice) => ({ id, category: inSlice ? 'run' : 'stop', gold: { expect: inSlice ? [{ action: 'run', taskType: 'literature-sentinel' }] : [{ action: 'stop', stopKind: 'answered' }] } }),
    unit: (row, right) => ({ decision: right ? { ...row.gold.expect[0], reason: 'r' } : { action: 'run', taskType: 'writing-pipeline', reason: 'r' } }) },
  'frontier-numbers': { row: (id, inSlice) => ({ id, category: inSlice ? 'lane' : 'flags', gold: inSlice ? { kind: 'lane', expect: ['safety'] } : { kind: 'flags', expect: [] } }),
    unit: (row, right, numbers, drop) => ({ verification: right ? 'passed' : 'title-only', numbers: { checked: drop ? 0 : 3, source: 3, missing: numbers ? [] : ['12%'], unitMismatches: [] }, output: { lane: row.gold.kind === 'lane' ? 'safety' : 'evidence', titleZh: 't', summaryZh: right ? 's' : null, reasonZh: null, evidenceType: null, flags: [], genre: 'paper', industryKind: null } }) },
};
KITS['frontier-source'] = KITS['frontier-numbers'];

/** One export: every arm on every row and repeat, drawn from `p(arm, inSlice)` and `numbers(arm)`. Returned as the arms runner writes it. */
function exportOf({ surface, scorer, role, ids, sliceShare, arms, repeats, seed, image, p, numbers, drops, status, incumbent, mutateRun, fromExport = false }) {
  const kit = KITS[scorer], random = generator(seed), rows = ids.map((id, at) => (fromExport ? { id: `export-${id}`, category: 'export', gold: {} } : kit.row(`case-${id}`, at < Math.round(ids.length * sliceShare))));
  const runs = [];
  for (const row of rows) for (const arm of arms) for (let repeat = 0; repeat < repeats; repeat += 1) {
    const right = random() < p(arm.arm, ['lane', 'run', 'export'].includes(row.category)), passed = random() < numbers(arm.arm), drop = random() < drops(arm.arm), calls = tokensFor(random), state = status(arm.arm, row, repeat);
    const delivered = state === 'succeeded';
    const run = { row: row.id, arm: arm.arm, repeat, runId: `module-${row.id}-${arm.arm}-${repeat}`, status: state, cost: moduleRunCost(calls, 'deepseek-flash', REFERENCE_PRICE_LIST), calls,
      answer: delivered ? { units: [{ variant: 'case', inputSha256: sha256(row.id), ...kit.unit(row, right, passed, drop) }] } : null, policyRevisionId: !delivered ? null : arm.harness ? arm.arm : INCUMBENT.revisionId };
    runs.push(mutateRun?.(run) ?? run);
  }
  const source = { kind: 'module-arms', schema: 1, role, surface, benchmark: scorer === 'autopilot-checklist' ? 'autopilot-next-action' : 'frontier-editing', image, incumbent, model: 'deepseek-flash', priceVersion: REFERENCE_PRICE_LIST.version, repeats,
    rows, arms: Object.fromEntries(arms.map(({ arm, harness, control }) => [arm, control ? { harness, control } : { harness }])), runs };
  if (role !== 'confirmation') return { source, gold: null, rows };
  return { source: { ...source, rows: rows.map(({ gold, ...rest }) => rest) }, gold: { kind: 'harness-gold', schema: 1, benchmark: source.benchmark, gold: Object.fromEntries(rows.map((row) => [row.id, row.gold])) }, rows };
}

/** The verdict records of an export by the real path: claude_judge.py's parts for every delivered run and pass, `fidelityVerdicts` over them. */
function judgedExport(made, judge, supported, seed) {
  const random = generator(seed ^ 0x51ed27), keys = {}, parts = {}, judgeRecord = { schema: 'claude-judge/2', judge: judge.id, model: judge.model, effort: judge.effort, dialect: 'questions', briefSha256: 'b'.repeat(64) };
  for (const run of made.source.runs.filter((entry) => entry.status === 'succeeded')) {
    const key = `k-${sha256(`${run.row}|${run.arm}|${run.repeat}`).slice(0, 12)}`;
    keys[key] = { row: run.row, arm: run.arm, repeat: run.repeat };
    for (let pass = 1; pass <= judge.passes; pass += 1) parts[`${key}.p${pass}.jsonl`] = `${JSON.stringify({ key: `${key}#supported`, verdict: random() < supported(run.arm) ? 'correct' : 'incorrect', judge: judge.id, model: judge.model, effort: judge.effort })}\n`;
  }
  const out = fidelityVerdicts({ source: made.source, keys, parts, judgeRecord, judge });
  return { ...made, source: out.source, verdicts: out.text };
}

/**
 * A complete campaign as an operator assembles it, plus its exports. Defaults measure a candidate that repairs the failure slice and keeps its numbers, 32 confirmation groups of which 85% in the slice.
 * @param {string} surface @param {any} [options]
 */
export async function moduleFixture(surface = 'frontier-edit', { scorer = surface === 'autopilot-planner' ? 'autopilot-checklist' : 'frontier-numbers', confirmationFrom = scorer === 'frontier-source' ? 'export' : 'cases', developmentRows = 30, confirmationRows = 32, sliceShareDevelopment = 0.6, sliceShareConfirmation = 0.85, repeatsDevelopment = 2, repeatsConfirmation = 3,
  goodText = 'A better version of the component under test.', weakText = 'A different version of the component that changes nothing.', p, numbers, drops = () => 0, supported = (arm) => (arm === 'baseline' ? 0.5 : 0.9), status = () => 'succeeded', month = '2026-11', now = '2026-10-26T00:00:00Z', improvement = improvementOf(), judge = scorer === 'frontier-source' ? judgeOf() : undefined, seeds = {}, incumbent = INCUMBENT,
  mutateRound, mutateExports, mutateRun } = {}) {
  const image = await closureImage(surface);
  const good = candidateOn(surface, goodText, image, 'good'), weak = candidateOn(surface, weakText, image, 'weak');
  const pOf = p ?? ((arm, inSlice) => (arm === good.arm ? (inSlice ? 0.8 : 0.85) : inSlice ? 0.35 : 0.85));
  const numbersOf = numbers ?? (() => 1);
  const base = { arm: 'baseline', harness: null }, aa = { arm: 'aa', harness: null, control: 'A/A' };
  const devIds = Array.from({ length: developmentRows }, (_, at) => 1000 + at), confIds = Array.from({ length: confirmationRows }, (_, at) => 2000 + at);
  const shared = { surface, scorer, image, p: pOf, numbers: numbersOf, drops, status, incumbent, mutateRun };
  let development = exportOf({ ...shared, role: 'development', ids: devIds, sliceShare: sliceShareDevelopment, arms: [base, aa, good, weak], repeats: repeatsDevelopment, seed: seeds.development ?? 7 });
  let confirmation = exportOf({ ...shared, role: 'confirmation', ids: confIds, sliceShare: sliceShareConfirmation, arms: [base, good], repeats: repeatsConfirmation, seed: seeds.confirmation ?? 11, fromExport: confirmationFrom === 'export' });
  if (judge) { development = judgedExport(development, judge, supported, seeds.development ?? 7); confirmation = judgedExport(confirmation, judge, supported, seeds.confirmation ?? 11); }
  const exports = { development, confirmation };
  mutateExports?.(exports);
  const pool = [...development.rows, ...confirmation.rows];
  const round = moduleRound({ surface, scorer, round: 'b2-test', salt: 'test-salt', pool, developmentCount: 0, drawn: [], repeats: { development: repeatsDevelopment, confirmation: repeatsConfirmation }, judge, registeredAt: '2026-11-01T00:00:00Z' });
  // The fixture names its rows outright: which case lands in which role is what the hash order decides on a real pool.
  const named = { ...round, rows: { development: development.rows.map((row) => row.id), confirmation: confirmation.rows.map((row) => row.id) }, groupsBelowMinimum: confirmation.rows.length < 25,
    ...(confirmationFrom === 'export' ? { confirmationDraw: { exportSha256: 'e'.repeat(64), salt: 'test-salt', rule: 'ascending sha256(salt|id)', sample: confirmation.rows.length } } : {}) };
  mutateRound?.(named);
  named.digest = roundRegistrationDigest(named);
  const built = await buildHarnessCampaign({ development: exports.development.source, confirmation: exports.confirmation.source, registration: named, confirmationGold: exports.confirmation.gold, developmentVerdicts: exports.development.verdicts, confirmationVerdicts: exports.confirmation.verdicts,
    month, pilotRationale: 'Synthetic unit-test family; no benefit is claimed.', now, improvement });
  return { manifest: built.manifest, inputs: built.inputs, supply: built.supply, round: named, exports, good, weak, image };
}
