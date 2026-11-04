import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rsiDigest as digest } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { rsiCampaignIssues } from '../../../packages/domain/src/rsiCampaign.mjs';
import { runCampaign } from '../campaign_runner.mjs';
import { evaluatorReceiptPayload, SKILL_COST_IDENTITY } from '../evaluator.mjs';
import { medcalcCorrect, skillCampaignConsumerIdentity, statedAnswer } from '../skill_campaign.mjs';
import { BENIGN_PROCEDURE, memoryCampaignStore, runToVerdict, runnerEnvironment, tickingClock } from '../profiles/benign_fixture.mjs';

const DEADLINE = '2026-10-31T15:59:59.999Z';
/** Who wrote the candidates: the operator's Claude session (owner 2026-11-03), recorded as the manifest's improvers. */
const IMPROVERS = [{ role: 'lead', provider: 'anthropic', model: 'claude-opus-5-5' }];
const scratch = await mkdtemp(join(tmpdir(), 'rsi-skill-'));
after(() => rm(scratch, { recursive: true, force: true }));
let dirs = 0;
const nextDir = () => join(scratch, String(dirs += 1));

/** mulberry32, so every fixture is the same bytes on every run. */
function generator(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const skill = (name, chars) => { const value = digest({ name }); return { arm: `cand-${value.slice(0, 12)}`, skill: { digest: value, chars, title: name } }; };
const GOOD = skill('stepwise-calculator', 900), WEAK = skill('generic-reminder', 400);
/** Calculators 2 and 3 are the registered failure slice; 5 is not. Gold is a decimal range. */
const row = (id, calculatorId) => ({ id: String(id), calculatorId, gold: { answer: '10.0', lower: '9.5', upper: '10.5' } });
const answer = (correct) => correct ? 'Working...\nFinal answer: 10.1' : 'Working...\nFinal answer: 14';

/**
 * A source of recorded runs: `p(arm, row)` is the chance a run of that arm on that row is right.
 * @param {{ ids: number[], sliceShare: number, arms: Array<{arm:string, skill:any}>, repeats: number, seed: number, p: (arm:string, inSlice:boolean) => number, cost?: (arm:string) => number | null }} spec
 */
function source({ ids, sliceShare, arms, repeats, seed, p, cost = (arm, random) => Math.round((arm === 'baseline' ? 0.1 : 0.104) * (0.7 + 0.6 * random()) * 1e6) / 1e6 }) {
  const random = generator(seed);
  const rows = ids.map((id, index) => row(id, index < Math.round(ids.length * sliceShare) ? (index % 2 ? 3 : 2) : 5));
  const runs = [];
  for (const r of rows) for (const { arm } of arms) for (let repeat = 0; repeat < repeats; repeat += 1) {
    runs.push({ row: r.id, arm, repeat, runId: `run-${r.id}-${arm}-${repeat}`, status: 'succeeded', answer: answer(random() < p(arm, r.calculatorId !== 5)), cost: cost(arm, random) });
  }
  return { kind: 'skill-arms', schema: 1, benchmark: 'medcalc-bench', repeats, rows, arms: Object.fromEntries(arms.map(({ arm, skill: s }) => [arm, { skill: s }])), runs };
}
const BASE = { arm: 'baseline', skill: null };
const improving = (arm, inSlice) => (arm === GOOD.arm ? (inSlice ? 0.8 : 0.85) : inSlice ? 0.35 : 0.85);

async function skillFixture({ development: devSpec = {}, confirmation: confSpec = {}, statistics: statSpec = {}, id = 'benign-skill-campaign' } = {}) {
  const development = source({ ids: Array.from({ length: 30 }, (_, i) => 1000 + i), sliceShare: 0.6, arms: [BASE, GOOD, WEAK], repeats: 1, seed: 7, p: improving, ...devSpec });
  const confirmation = source({ ids: Array.from({ length: 32 }, (_, i) => 2000 + i), sliceShare: 0.85, arms: [BASE, GOOD], repeats: 3, seed: 11, p: improving, ...confSpec });
  const identity = await skillCampaignConsumerIdentity();
  const failureCalculators = [2, 3];
  const statistics = {
    procedure: { ...BENIGN_PROCEDURE }, version: 1, paid_cost_budget: 1000, consumer_id: identity.implementationSha256, corpus_digest: digest(confirmation),
    mode: 'paired-t', deterministicConsumer: false, G_target: confirmation.rows.length,
    groups: confirmation.rows.map((r) => ({ id: `row-${r.id}`, family: 'medcalc', failure_slice: failureCalculators.includes(r.calculatorId) })),
    families: { medcalc: { repeats: 3, forms: { answer: 1 }, score_type: 'bounded-continuous', margin: 0.05, pilot_rationale: 'MedCalc-Bench baseline v1 failure classes, 2026-10-28' } },
    claims: { 'targeted-repair': 0.05 / 3 }, cost_identity: SKILL_COST_IDENTITY, expires_at: DEADLINE, ...statSpec,
  };
  const registration = { failureCalculators, margin: 0.05, selection: { objective: 'failure-slice-gain', tieBreak: 'shorter-skill' }, statistics };
  const target = { surface: 'capability-skill', dependencyDigest: 'a'.repeat(64), baselineRevision: 'benign-baseline' };
  const sources = { 'development-dev': development, 'confirmation-conf': confirmation };
  const manifest = {
    schemaVersion: 2, id, surface: 'capability-skill', candidateKind: 'skill', claim: 'targeted-repair', automated: true,
    createdAt: '2026-10-26T00:00:00Z', deadline: DEADLINE, budget: { campaignCny: 1000, monthCny: 30000 },
    models: { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improvers: IMPROVERS, judges: [] },
    target, registration: { digest: digest(registration), procedure: BENIGN_PROCEDURE.id, claim: 'targeted-repair' },
    data: { classification: 'public', sources: [
      { id: 'development-dev', digest: digest(development), role: 'development', exposure: 'exposed' },
      { id: 'confirmation-conf', digest: digest(confirmation), role: 'confirmation', exposure: 'sealed' }] },
  };
  return { manifest, inputs: { registration, target, sources } };
}

test('answers are read the way MedCalc-Bench evaluate.py reads them', () => {
  const decimal = { calculatorId: 2, gold: { answer: '10.0', lower: '9.5', upper: '10.5' } };
  assert.equal(statedAnswer('step 1\n**Final answer:** 10.2 mL/min'), '10.2 mL/min');
  assert.equal(statedAnswer('计算过程……\n最终答案：12'), '12');
  assert.equal(medcalcCorrect('x\nFinal answer: 10.2 mL/min', decimal), 1);
  assert.equal(medcalcCorrect('Final answer: 10.6', decimal), 0);
  assert.equal(medcalcCorrect(null, decimal), 0);
  assert.equal(medcalcCorrect('Final answer: 3.4 points', { calculatorId: 4, gold: { answer: '3', lower: null, upper: null } }), 1);
  assert.equal(medcalcCorrect('最终答案：06/07/2024', { calculatorId: 13, gold: { answer: '6/7/2024', lower: null, upper: null } }), 1);
  assert.equal(medcalcCorrect('Final answer: (12 weeks, 3 days)', { calculatorId: 69, gold: { answer: "('12 weeks', '3 days')", lower: null, upper: null } }), 1);
  assert.equal(medcalcCorrect('Final answer: (12 weeks, 4 days)', { calculatorId: 69, gold: { answer: "('12 weeks', '3 days')", lower: null, upper: null } }), 0);
});

test('a skill that repairs its failure slice is qualified on recorded paid runs, with attested settled costs', async () => {
  const fixture = await skillFixture();
  const { awaiting, completed, signed } = await runToVerdict(fixture, { dir: nextDir() });
  assert.equal(awaiting.status, 'awaiting-evaluation', JSON.stringify(awaiting).slice(0, 300));
  assert.equal(completed.status, 'completed', JSON.stringify(completed).slice(0, 400));
  assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint.evaluation?.reasons ?? completed).slice(0, 400));
  assert.equal(completed.checkpoint.frozenPolicy.arm, GOOD.arm);
  assert.equal(signed.payload.receipt.deterministic_qualification, null);
  assert.ok(signed.payload.costs.every((row) => row.cost > 0));
  assert.match(signed.payload.costProvenance.receiptId, /^production-usage-ledger:/);
});

test('no candidate with a positive slice gain ends the campaign before confirmation', async () => {
  // Both candidates do worse than the baseline on the slice.
  const worse = (arm, inSlice) => (arm === 'baseline' ? 0.9 : inSlice ? 0.1 : 0.9);
  const fixture = await skillFixture({ development: { p: worse } });
  const store = memoryCampaignStore();
  const result = await runCampaign({ ...fixture, ...runnerEnvironment({ store, now: tickingClock() }) });
  assert.equal(result.reason, 'campaign_no_improving_candidate');
  assert.equal(store.ledger.size, 0);
});

test('the confirmation must carry exactly the development candidate, on rows development never saw', async () => {
  const mismatch = await skillFixture({ confirmation: { arms: [BASE, WEAK] } });
  const swapped = await runCampaign({ ...mismatch, ...runnerEnvironment() });
  assert.equal(swapped.status, 'not-qualified');
  // WEAK is a development candidate but not the one development freezes: the consumer refuses the confirmation.
  assert.equal(swapped.reason, 'campaign_confirmation_candidate_mismatch');
  const overlap = await skillFixture({ confirmation: { ids: Array.from({ length: 32 }, (_, i) => 1010 + i) } });
  assert.equal((await runCampaign({ ...overlap, ...runnerEnvironment() })).reason, 'campaign_confirmation_not_independent');
});

test('a paid consumer registered as deterministic is refused, and an unsettled run cost is never attested', async () => {
  const deterministic = await skillFixture({ statistics: { deterministicConsumer: true } });
  assert.equal((await runCampaign({ ...deterministic, ...runnerEnvironment() })).reason, 'campaign_statistics_registration_invalid');
  const unsettled = await skillFixture({ confirmation: { cost: (arm) => (arm === 'baseline' ? null : 0.1) } });
  const store = memoryCampaignStore(), now = tickingClock();
  const awaiting = await runCampaign({ ...unsettled, ...runnerEnvironment({ store, now }) });
  assert.equal(awaiting.status, 'awaiting-evaluation');
  await assert.rejects(evaluatorReceiptPayload({ ...unsettled, request: awaiting.request, checkpoint: store.state(unsettled.manifest.id), now: now() }), { message: 'campaign_cost_measurement_missing' });
});

test('the operator\'s candidates are registered content-addressed, by Claude improvers only, and an address that is not the text\'s is refused', async () => {
  const { registerSkillCandidates, candidateRecord, buildSkillCampaign } = await import('../skill_assemble.mjs');
  const raw = { improvers: IMPROVERS, candidates: [
    { title: 'Calculator discipline', description: 'Use for clinical calculator questions.', instructions: '1. Identify the formula.\n2. Convert units.' },
    { title: ' Calculator discipline ', description: 'Use for clinical calculator questions.', instructions: '1. Identify the formula.\n2. Convert units.\n' },
    { title: 'Recount the criteria', description: 'Use when a score is a sum of criteria.', instructions: 'Quote a phrase of the note for each criterion.' }] };
  const registered = registerSkillCandidates(raw);
  assert.deepEqual(registered.improvers, IMPROVERS);
  assert.equal(registered.candidates.length, 2, 'the same text twice is one candidate');
  for (const c of registered.candidates) {
    assert.deepEqual(c, candidateRecord(c));
    assert.match(c.arm, /^cand-[a-f0-9]{12}$/); assert.equal(c.arm, `cand-${c.digest.slice(0, 12)}`);
    assert.equal(c.chars, c.title.length + c.description.length + c.instructions.length);
  }
  // Who wrote them is Claude, named and pinned: nobody, DeepSeek, Qwen or an unpinned name is not an improver.
  for (const improvers of [undefined, [], [{ role: 'lead', provider: 'dashscope', model: 'qwen3.8-max' }], [{ role: 'lead', provider: 'deepseek', model: 'deepseek-v4-pro' }],
    [{ role: 'lead', provider: 'anthropic', model: 'sonnet' }], [{ role: 'lead', provider: 'anthropic', model: 'claude-opus-5-5' }, { role: 'x', provider: 'none', model: 'registered-grid' }]]) {
    assert.throws(() => registerSkillCandidates({ ...raw, improvers }), /^Error: campaign_(improver_missing|improver_refused)$/, JSON.stringify(improvers));
  }
  assert.throws(() => registerSkillCandidates({ ...raw, improvers: [{ role: 'lead', provider: 'anthropic', model: 'claude-opus-5-5', key: 'k' }] }), { message: 'campaign_model_invalid' });
  for (const candidates of [undefined, [], [{ title: 'x', description: '', instructions: 'y' }], [{ title: 'x'.repeat(61), description: 'd', instructions: 'y' }], [{ title: 'x', description: 'd', instructions: 'y'.repeat(6001) }], Array(17).fill(raw.candidates[0])]) {
    assert.throws(() => registerSkillCandidates({ ...raw, candidates }), { message: 'campaign_candidates_invalid' });
  }
  // The lab recomputes the address of a candidate that carries its text; a candidate without text is the registration's own record.
  const base = await skillFixture();
  const [development, confirmation] = Object.values(base.inputs.sources);
  const build = (candidates) => buildSkillCampaign({ development, confirmation, candidates, failureCalculators: [2, 3], month: '2026-10', idPrefix: 'rehearsal-', now: '2026-10-26T00:00:00Z' });
  const listed = [GOOD, WEAK].map((c) => ({ arm: c.arm, digest: c.skill.digest, chars: c.skill.chars, title: c.skill.title }));
  const forged = { improvers: IMPROVERS, candidates: [{ ...registered.candidates[0], chars: registered.candidates[0].chars + 1 }, ...listed] };
  await assert.rejects(build(forged), { message: 'campaign_candidate_digest_mismatch' });
  await assert.rejects(build({ improvers: IMPROVERS, candidates: [{ ...registered.candidates[0], instructions: 'edited after registration' }, ...listed] }), { message: 'campaign_candidate_digest_mismatch' });
  await assert.rejects(build({ improvers: IMPROVERS, candidates: [{ ...listed[0], description: 'only half the text' }] }), { message: 'campaign_candidates_invalid' });
  await assert.rejects(build({ improvers: IMPROVERS, candidates: [] }), { message: 'campaign_candidates_invalid' });
  await assert.rejects(build({ candidates: listed }), { message: 'campaign_improver_missing' });
  await assert.rejects(build({ improvers: [{ role: 'lead', provider: 'dashscope', model: 'qwen3.8-max' }], candidates: listed }), { message: 'campaign_improver_refused' });
});

test('the assembler builds a manifest and inputs the runner and evaluator take as they are', async () => {
  const { buildSkillCampaign } = await import('../skill_assemble.mjs');
  const base = await skillFixture();
  const sources = Object.values(base.inputs.sources);
  const candidates = { improvers: IMPROVERS, candidates: [GOOD, WEAK].map((c) => ({ arm: c.arm, digest: c.skill.digest, chars: c.skill.chars, title: c.skill.title })) };
  const built = await buildSkillCampaign({ development: sources[0], confirmation: sources[1], candidates, failureCalculators: [2, 3], month: '2026-10', idPrefix: 'rehearsal-', now: '2026-10-26T00:00:00Z' });
  assert.equal(built.supply.developmentChoice.frozen.arm, GOOD.arm);
  assert.deepEqual(built.manifest.models, { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improvers: IMPROVERS, judges: [] });
  assert.deepEqual(built.inputs.registration.improvers, IMPROVERS);
  assert.equal(built.manifest.schemaVersion, 2);
  assert.deepEqual(rsiCampaignIssues(built.manifest), []);
  assert.ok(built.supply.confirmation.sliceGroups >= 25);
  const { completed } = await runToVerdict({ manifest: built.manifest, inputs: built.inputs }, { dir: nextDir() });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.qualification, 'qualified');
});

test('a campaign whose development finds no improving candidate ends there, recomputed, with nothing opened', async () => {
  const { developmentOnly } = await import('../skill_assemble.mjs');
  const worse = (arm, inSlice) => (arm === 'baseline' ? 0.9 : inSlice ? 0.1 : 0.9);
  const base = await skillFixture({ development: { p: worse } });
  const development = Object.values(base.inputs.sources)[0];
  const candidates = { improvers: IMPROVERS, candidates: [GOOD, WEAK].map((c) => ({ arm: c.arm, digest: c.skill.digest, chars: c.skill.chars, title: c.skill.title })) };
  const result = developmentOnly({ development, candidates, failureCalculators: [2, 3], month: '2026-11' });
  assert.equal(result.status, 'development-only');
  assert.equal(result.supply.developmentChoice.frozen, null);
  assert.equal(result.supply.developmentChoice.reason, 'campaign_no_improving_candidate');
  assert.deepEqual(result.supply.improvers, IMPROVERS, 'who wrote the candidates is recorded, and no spend: they cost the lab nothing');
  assert.equal(result.supply.improverSpendCny, undefined);
});
