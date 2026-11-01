/**
 * Synthetic harness-patch campaigns for the lifecycle tests (tests/harnessCampaign.test.mjs, tests/harnessScorers.test.mjs). Every
 * row, answer, verdict and cost is invented and seeded; nothing here certifies a benefit. A fixture is built the way the lab
 * builds a campaign: exports (a development source with gold, a SEALED confirmation source with its gold and verdict records
 * apart), a pre-registration, and `buildHarnessCampaign` joining them.
 */
import { createHash } from 'node:crypto';
import { rsiDigest as digest } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { buildHarnessCampaign, roundRegistrationDigest } from '../harness_assemble.mjs';
import { harnessPatchDigest, harnessPatchSizes } from '../harness_campaign.mjs';
import { SKILL_SCORERS } from '../skill_scorers.mjs';

export const IMAGE = Object.freeze({ id: 'evimed-lane-test', digest: 'ab'.repeat(32) });
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** mulberry32, so every fixture is the same bytes on every run. */
export function generator(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const bundleOf = (name, guidance = `Process rule for ${name}: state the working before the answer.`) => ({ guidanceSupplement: guidance, skills: [{ name, description: `Use when ${name} applies.`, body: `Steps for ${name}: one, two, three.` }] });
/** A candidate arm on `image`: `{arm, harness}` as an export writes it. */
export function candidate(name, guidance, image = IMAGE) {
  const bundle = bundleOf(name, guidance), digestValue = harnessPatchDigest(bundle, image);
  return { arm: `cand-${digestValue.slice(0, 12)}`, harness: { digest: digestValue, ...harnessPatchSizes(bundle), title: name, bundle } };
}
export const BASE = Object.freeze({ arm: 'baseline', harness: null });
export const AA = Object.freeze({ arm: 'aa', harness: null, control: 'A/A' });
export const GOOD = candidate('stepwise-closure', 'Deliver a provisional result early and refine it in later turns.');
export const WEAK = candidate('generic-reminder', 'Remember to be careful.');
/** Baseline and control share one distribution; GOOD repairs the failure slice; WEAK changes nothing. */
export const improving = (arm, inSlice) => (arm === GOOD.arm ? (inSlice ? 0.8 : 0.85) : inSlice ? 0.35 : 0.85);

const JUDGE = Object.freeze({ id: 'claude-judge-test', provider: 'anthropic', form: 'absolute', passes: 3, maxCalls: 5000,
  qualification: { agreement: 0.96, noiseSd: 0.0155, noiseBand95: 0.0304, measuredOn: 'judge-noise.txt@2026-10-31 (synthetic)', minimumAgreement: 0.9, maximumNoiseBand: 0.05 } });
export const judgeOf = (changes = {}) => ({ ...structuredClone(JUDGE), ...changes });

/** What differs between the scorers in a fixture: the row shape, the failure slice, a right answer and a wrong one. */
export const KITS = {
  medcalc: {
    scorer: 'medcalc', family: 'medcalc', benchmark: 'medcalc-bench', slice: [2, 3],
    row: (id, index, inSlice) => ({ id: String(id), calculatorId: inSlice ? (index % 2 ? 3 : 2) : 5, gold: { answer: '10.0', lower: '9.5', upper: '10.5' } }),
    answer: (correct) => (correct ? 'Working...\nFinal answer: 10.1' : 'Working...\nFinal answer: 14'),
  },
  mbc: {
    scorer: 'mbc-normalized', family: 'mbc', benchmark: 'medbrowsecomp', slice: ['Ingredient'],
    row: (id, index, inSlice) => (inSlice ? { id: `mbc-${id}`, task: 'Ingredient', gold: { task_name: 'Ingredient', answer: 'ZORVALINIB' } }
      : { id: `mbc-${id}`, task: 'Applicant_Full_Name', gold: { task_name: 'Applicant_Full_Name', answer: 'NORTHWIND PHARMA' } }),
    answer: (correct, row) => (row.task === 'Ingredient' ? `Looked it up.\nINGREDIENT: ${correct ? 'ZORVALINIB' : 'OTHERSTUFF'}` : `Looked it up.\nCOMPANY: ${correct ? 'Northwind Pharma Inc' : 'Elsewhere Corp'}`),
  },
  judged: {
    scorer: 'judged-verdicts', family: 'drb', benchmark: 'deepresearchbench', slice: ['Science'],
    row: (id, index, inSlice) => ({ id: String(id), category: inSlice ? 'Science' : 'Health' }),
  },
};
const inSliceOf = (kit, row) => kit.slice.includes(row.calculatorId ?? row.task ?? row.category);
const natural = (a, b) => Number(String(a).replace(/\D/g, '')) - Number(String(b).replace(/\D/g, '')) || String(a).localeCompare(String(b));

/** The records file of a judged export (JSONL, one record per verdict line) and the `judged` section that digests it. */
function judgedSection({ kit, rows, runs, judge, mean, noise, seed, stem, verdictShape = {} }) {
  const { keep = () => true, mutate = (record) => record, extraCalls = 0 } = verdictShape;
  const random = generator(seed ^ 0x9e3779b9);
  const records = [];
  for (const run of runs) {
    if (run.status !== 'succeeded' || (judge.form === 'pairwise' && run.arm === 'baseline')) continue;
    const row = rows.find((candidateRow) => candidateRow.id === run.row);
    for (let pass = 1; pass <= judge.passes; pass += 1) {
      const raw = mean(run.arm, inSliceOf(kit, row)) + (random() - 0.5) * 2 * noise;
      const entry = mutate({ row: run.row, arm: run.arm, repeat: run.repeat, pass, score: Math.round(Math.min(1, Math.max(0, raw)) * 1e6) / 1e6, judge: judge.id });
      if (keep(entry)) records.push(entry);
    }
  }
  records.sort((a, b) => natural(a.row, b.row) || a.arm.localeCompare(b.arm) || a.repeat - b.repeat || a.pass - b.pass);
  const text = records.map((record) => `${JSON.stringify(record)}\n`).join('');
  return { text, records, section: {
    schema: 1, judge: { id: judge.id, provider: judge.provider, form: judge.form, passes: judge.passes }, calls: records.length + extraCalls,
    cost: { settledCny: 0, note: "Judge calls run under the operator's Claude subscription; not metered in CNY." },
    files: [{ name: `${stem}.p1.jsonl`, sha256: sha256(`raw-verdicts-${stem}`), lines: records.length }],
    recordsFile: { name: `${stem}.verdicts.jsonl`, sha256: sha256(text), lines: records.length } } };
}

/**
 * One export (a harness-arms source): the runs of every arm on every row and repeat, drawn from `p` (deterministic scorers) or
 * `mean` (judged). Returns the source as export_harness_arms.py writes it plus what it writes beside it.
 */
export function exportSource(kit, { role, ids, sliceShare, arms, repeats, seed, p = improving, mean = (arm) => (arm === GOOD.arm ? 0.7 : 0.5), noise = 0.2, verdictShape,
  cost = (arm, random) => Math.round(0.1 * (0.85 + 0.3 * random()) * 1e6) / 1e6, status = () => 'succeeded', judge, image = IMAGE, benchmark }) {
  const random = generator(seed);
  const rows = ids.map((id, index) => kit.row(id, index, index < Math.round(ids.length * sliceShare)));
  const runs = [];
  for (const row of rows) for (const { arm } of arms) for (let repeat = 0; repeat < repeats; repeat += 1) {
    const state = status(arm, row, repeat), good = random() < p(arm, inSliceOf(kit, row)), price = cost(arm, random);
    runs.push(kit.scorer === 'judged-verdicts'
      ? { row: row.id, arm, repeat, runId: `run-${row.id}-${arm}-${repeat}`, status: state, answer: null, answerChars: 4200, reportSha256: sha256(`report-${row.id}-${arm}-${repeat}`), cost: price }
      : { row: row.id, arm, repeat, runId: `run-${row.id}-${arm}-${repeat}`, status: state, answer: state === 'succeeded' ? kit.answer(good, row) : null, cost: price });
  }
  const source = { kind: 'harness-arms', schema: 1, role, benchmark: benchmark ?? kit.benchmark, image, repeats, rows, arms: Object.fromEntries(arms.map(({ arm, harness, control }) => [arm, control ? { harness, control } : { harness }])), runs };
  const stem = role;
  const result = { source, gold: null, verdicts: null };
  if (kit.scorer === 'judged-verdicts') {
    const made = judgedSection({ kit, rows, runs, judge, mean, noise, seed, stem, verdictShape });
    source.judged = made.section; result.verdicts = made.text;
  } else if (role === 'confirmation') {
    // The seal: the export carries the answers and the costs, the gold travels apart.
    result.gold = { kind: 'harness-gold', schema: 1, benchmark: source.benchmark, gold: Object.fromEntries(rows.map((row) => [String(row.id), structuredClone(row.gold)])) };
    source.rows = rows.map(({ gold, ...rest }) => rest);
  }
  return result;
}

/** The pre-registration register_round.py writes, with its digest. */
export function roundOf(kit, { developmentIds, confirmationIds, judge, campaignsPerQuarter = 3, candidatesMax = 3, changes = {} } = {}) {
  const sliceKey = SKILL_SCORERS[kit.scorer]?.slice.registration ?? 'failureSlice';
  const round = {
    schema: 'rsi-round-registration/1', tool: 'register_round.py/1', round: 'rsi1-test', family: kit.family, benchmark: kit.benchmark, scorer: kit.scorer,
    pool: { file: 'pool.json', name: 'main', digest: 'c'.repeat(64) }, hashOrder: { salt: 'test-salt', rule: 'ascending sha256(salt|id)' },
    rows: { development: developmentIds, confirmation: confirmationIds }, available: { development: developmentIds.length, confirmation: confirmationIds.length },
    excluded: { ppc: [], ppcFile: null, ppcFileSha256: null }, repeats: { development: 1, confirmation: 3 },
    failureSlice: kit.slice, failureSliceKey: sliceKey, margin: 0.05, costRatio: 1.1,
    alpha: { quarterTotal: 0.05, campaignsPerQuarter, perCampaign: 0.05 / campaignsPerQuarter }, candidatesMax,
    control: { arm: 'aa', kind: 'A/A', rule: 'a candidate is eligible only if its failure-slice gain exceeds the absolute failure-slice difference the A/A arm shows against the baseline' },
    minimumGroups: 25, groupsBelowMinimum: confirmationIds.length < 25, ...(judge ? { judge } : {}), registeredAt: '2026-11-01T00:00:00Z', ...changes,
  };
  round.digest = roundRegistrationDigest(round);
  return round;
}

/**
 * A complete campaign as the lab assembles it: manifest, inputs, the supply report, and the exports it was built from.
 * @param {keyof typeof KITS} kitId
 */
export async function harnessFixture(kitId = 'medcalc', {
  developmentRows = 30, confirmationRows = 32, sliceShareDev = 0.6, sliceShareConf = 0.85, developmentArms = [BASE, AA, GOOD, WEAK], confirmationArms = [BASE, GOOD],
  p, mean, noise, cost, developmentStatus, confirmationStatus, verdictShape, judge = kitId === 'judged' ? judgeOf() : undefined, mutateRound, mutateExports, month = '2026-11', id = '', developmentIds, confirmationIds,
  campaignsPerQuarter = 3, candidatesMax = 3, repeatsConfirmation = 3, now = '2026-10-26T00:00:00Z', improvement, seeds = {},
} = {}) {
  const kit = KITS[kitId];
  const devIds = developmentIds ?? Array.from({ length: developmentRows }, (_, i) => 1000 + i), confIds = confirmationIds ?? Array.from({ length: confirmationRows }, (_, i) => 2000 + i);
  // Judged scores are continuous and the statistics refuse an influential group (one group over a fifth of the spread): this seed draws a campaign without one.
  const seedsFor = { development: 7, confirmation: kitId === 'judged' ? 24 : 11, ...seeds };
  const shared = { p, mean, noise, cost, judge, verdictShape };
  const exports = {
    development: exportSource(kit, { ...shared, role: 'development', ids: devIds, sliceShare: sliceShareDev, arms: developmentArms, repeats: 1, seed: seedsFor.development, status: developmentStatus }),
    confirmation: exportSource(kit, { ...shared, role: 'confirmation', ids: confIds, sliceShare: sliceShareConf, arms: confirmationArms, repeats: repeatsConfirmation, seed: seedsFor.confirmation, status: confirmationStatus }),
  };
  mutateExports?.(exports);
  const round = roundOf(kit, { developmentIds: devIds.map((x) => kit.row(x, 0, true).id), confirmationIds: confIds.map((x) => kit.row(x, 0, true).id), judge, campaignsPerQuarter, candidatesMax });
  mutateRound?.(round);
  if (mutateRound) round.digest = roundRegistrationDigest(round);
  const built = await buildHarnessCampaign({ development: exports.development.source, confirmation: exports.confirmation.source, registration: round, confirmationGold: exports.confirmation.gold ?? undefined,
    developmentVerdicts: exports.development.verdicts ?? undefined, confirmationVerdicts: exports.confirmation.verdicts ?? undefined, month, pilotRationale: 'Synthetic unit-test family; no benefit is claimed.',
    idPrefix: id, now, improvement });
  return { manifest: built.manifest, inputs: built.inputs, supply: built.supply, round, exports, kit };
}

/**
 * The campaign with `mutate({manifest, inputs})` applied and every digest that covers the change recomputed, as a hand-edited
 * inputs.json would be bound: the sources' digests, the statistics' corpus digest, the registration digest.
 */
export function rebind(campaign, mutate) {
  const manifest = structuredClone(campaign.manifest), inputs = structuredClone(campaign.inputs);
  mutate({ manifest, inputs });
  for (const row of manifest.data.sources) {
    row.digest = digest(inputs.sources[row.id]);
    if (row.role === 'confirmation' && inputs.registration.statistics) inputs.registration.statistics.corpus_digest = row.digest;
  }
  manifest.registration.digest = digest(inputs.registration);
  return { ...campaign, manifest, inputs };
}
