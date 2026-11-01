import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rsiDigest as digest } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { runCampaign } from '../campaign_runner.mjs';
import { evaluatorReceiptPayload, SKILL_COST_IDENTITY } from '../evaluator.mjs';
import { chooseSkillCandidate, skillArmsIssues, skillCampaignConsumerIdentity, skillObservations } from '../skill_campaign.mjs';
import { arbDeepScore, arbWideScore, bixbenchAnswers, bixbenchScore, bixbenchVerdict, bixbenchDeterministic, SKILL_SCORERS, sequenceRatio, skillScorer } from '../skill_scorers.mjs';
import { BENIGN_PROCEDURE, memoryCampaignStore, runToVerdict, runnerEnvironment, tickingClock } from '../profiles/benign_fixture.mjs';

const DEADLINE = '2026-10-31T15:59:59.999Z';
const scratch = await mkdtemp(join(tmpdir(), 'rsi-scorers-'));
let dirs = 0;
const nextDir = () => join(scratch, String(dirs += 1));
const vectors = JSON.parse(await readFile(new URL('./fixtures/scorer-vectors.json', import.meta.url), 'utf8'));

// ------------------------------------------------------------------------------------------------ the ports and their vectors

test('the similarity port reproduces difflib on short strings and past the autojunk threshold', () => {
  assert.ok(vectors.ratio.length >= 40);
  for (const { a, b, ratio } of vectors.ratio) assert.ok(Math.abs(sequenceRatio(a, b) - ratio) < 1e-12, `${JSON.stringify([a.length, b.length])}: ${sequenceRatio(a, b)} vs ${ratio}`);
  assert.ok(vectors.ratio.some((row) => row.b.length >= 200) && vectors.ratio.some((row) => row.b.length < 200));
});

test('AutoResearchBench deep: the port gives score_arb.py\'s verdicts (a judge-band title counts as not matched)', () => {
  for (const { name, text, gold, verdict, score } of vectors.arbDeep) {
    assert.equal(arbDeepScore(text, { gold }), score, `${name} (${verdict})`);
  }
  assert.ok(vectors.arbDeep.some((row) => row.verdict === 'needs_judge') && vectors.arbDeep.some((row) => row.verdict === 'correct') && vectors.arbDeep.some((row) => row.verdict === 'incorrect'));
  assert.equal(arbDeepScore(null, { gold: vectors.arbDeep[0].gold }), 0);
});

test('AutoResearchBench wide: the port gives score_arb.py\'s IoU, the rescued one', () => {
  for (const { name, text, gold, iou } of vectors.arbWide) assert.ok(Math.abs(arbWideScore(text, { gold }) - iou) < 5e-7, `${name}: ${arbWideScore(text, { gold })} vs ${iou}`);
  assert.equal(arbWideScore(null, { gold: vectors.arbWide[0].gold }), 0);
});

test('BixBench: answers, verdicts and the share of deterministic questions follow the official graders in the vectors', () => {
  for (const { name, text, gold, answers, extraction, verdicts, deterministic, score } of vectors.bixbench) {
    const parsed = bixbenchAnswers(text);
    assert.equal(parsed.extraction, extraction, name);
    assert.deepEqual(Object.fromEntries([...parsed.answers].sort((a, b) => a[0] - b[0]).map(([n, answer]) => [String(n), answer])), answers, name);
    assert.deepEqual(gold.questions.map((question) => bixbenchVerdict(question, parsed.answers.get(question.n))), verdicts, name);
    assert.deepEqual(gold.questions.map(bixbenchDeterministic), deterministic, name);
    assert.equal(bixbenchScore(text, { gold }), score, name);
  }
});

test('BixBench: a typographic minus is a minus, so "\u221225" earns nothing from a range of (24,26)', () => {
  const question = { n: 1, qid: 'q', eval_mode: 'range_verifier', ideal: '(24,26)', range: [24, 26] };
  assert.equal(bixbenchVerdict(question, '25%'), 'correct');
  assert.equal(bixbenchVerdict(question, '\u221225'), 'incorrect');
  assert.equal(bixbenchVerdict(question, '-25'), 'incorrect');
});

test('every scorer returns a number in [0, 1] whatever it is given, and none loads or calls anything it was handed', () => {
  const rows = {
    medcalc: { id: '1', calculatorId: 2, gold: { answer: '10.0', lower: '9.5', upper: '10.5' } },
    'bixbench-deterministic': { id: '1', topic: 'x', gold: { questions: vectors.bixbench[0].gold.questions } },
    'arb-deep': { id: '1', category: 'x', gold: vectors.arbDeep[0].gold },
    'arb-wide': { id: '1', category: 'x', gold: vectors.arbWide[0].gold },
  };
  for (const [id, scorer] of Object.entries(SKILL_SCORERS)) {
    assert.ok(Object.isFrozen(scorer) && Object.isFrozen(scorer.slice), id);
    assert.equal(scorer.id, id);
    assert.ok(scorer.validRow(rows[id]), `${id}: its sample row is valid`);
    for (const answer of [null, '', '   ', 'Final answer:', 'Final answers:\n1.', '  ', 'x'.repeat(50_000), '1. 2. 3.\n'.repeat(500), '```\n```']) {
      const value = scorer.score(answer, rows[id]);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${id} on ${JSON.stringify(answer).slice(0, 30)}: ${value}`);
    }
  }
});

// ------------------------------------------------------------------------------------------------------- the closed registry

test('the registry is closed: four ids, frozen, an unknown or hostile id names no scorer', () => {
  assert.deepEqual(Object.keys(SKILL_SCORERS), ['medcalc', 'bixbench-deterministic', 'arb-deep', 'arb-wide']);
  assert.ok(Object.isFrozen(SKILL_SCORERS));
  assert.throws(() => { SKILL_SCORERS.extra = SKILL_SCORERS.medcalc; }, TypeError);
  assert.equal(skillScorer({}).id, 'medcalc');
  assert.equal(skillScorer(undefined).id, 'medcalc');
  assert.equal(skillScorer({ scorer: 'arb-wide' }).id, 'arb-wide');
  for (const hostile of ['judge', 'MEDCALC', '', '__proto__', 'constructor', 'toString', null, 7, ['medcalc'], { id: 'medcalc' }, '../skill_scorers.mjs', 'file:///tmp/x.mjs']) {
    assert.equal(skillScorer({ scorer: hostile }), null, JSON.stringify(hostile));
  }
  // The scorers are values of this file, never read from a registration: a function in one is not called.
  let called = false;
  assert.equal(skillScorer({ scorer: { toString: () => { called = true; return 'medcalc'; } } }), null);
  assert.equal(called, false);
});

test('the consumer identity binds the scorer id, both files, and nothing the registration could supply', async () => {
  const identities = {};
  for (const id of Object.keys(SKILL_SCORERS)) identities[id] = await skillCampaignConsumerIdentity({ scorer: id });
  assert.equal(new Set(Object.values(identities).map((identity) => identity.implementationSha256)).size, 4);
  for (const [id, identity] of Object.entries(identities)) {
    assert.equal(identity.scorer, id);
    assert.deepEqual(identity.components.map((component) => component.path), ['evals/rsi-campaigns/skill_campaign.mjs', 'evals/rsi-campaigns/skill_scorers.mjs']);
    assert.ok(identity.components.every((component) => /^[a-f0-9]{64}$/.test(component.sha256)));
    // Recomputable from the two files and the id: the id is inside the digest, not beside it.
    assert.equal(identity.implementationSha256, createHash('sha256').update(JSON.stringify({ scorer: id, components: identity.components })).digest('hex'));
  }
  // A registration that names nothing is medcalc, and says so the same way; extra registration fields change nothing.
  assert.deepEqual(await skillCampaignConsumerIdentity(), identities.medcalc);
  assert.deepEqual(await skillCampaignConsumerIdentity({ margin: 0.1, scorer: undefined }), identities.medcalc);
  await assert.rejects(skillCampaignConsumerIdentity({ scorer: 'judge' }), { message: 'campaign_scorer_not_qualified' });
});

// -------------------------------------------------------------------- medcalc: behaviour pinned from the code before the registry

function generator(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const skill = (name, chars) => { const value = digest({ name }); return { arm: `cand-${value.slice(0, 12)}`, skill: { digest: value, chars, title: name } }; };
const GOOD = skill('stepwise-calculator', 900), WEAK = skill('generic-reminder', 400);
const BASE = { arm: 'baseline', skill: null };
const improving = (arm, inSlice) => (arm === GOOD.arm ? (inSlice ? 0.8 : 0.85) : inSlice ? 0.35 : 0.85);

/** What differs between the scorers in a fixture: the row shape, the failure slice, a right answer and a wrong one. */
const KITS = {
  medcalc: {
    benchmark: 'medcalc-bench', slice: [2, 3], key: 'failureCalculators',
    row: (id, index, inSlice) => ({ id: String(id), calculatorId: inSlice ? (index % 2 ? 3 : 2) : 5, gold: { answer: '10.0', lower: '9.5', upper: '10.5' } }),
    answer: (correct) => (correct ? 'Working...\nFinal answer: 10.1' : 'Working...\nFinal answer: 14'),
  },
  'bixbench-deterministic': {
    benchmark: 'bixbench', slice: ['transcriptomics'], key: 'failureSlice',
    row: (id, index, inSlice) => ({ id: `bix-${id}`, topic: inSlice ? 'transcriptomics' : 'imaging', gold: { questions: [
      { n: 1, qid: `q${id}-1`, eval_mode: 'range_verifier', ideal: '(1.50,1.54)', range: [1.5, 1.54] }, { n: 2, qid: `q${id}-2`, eval_mode: 'str_verifier', ideal: '1-50', range: null },
      { n: 3, qid: `q${id}-3`, eval_mode: 'range_verifier', ideal: '(10,12)', range: [10, 12] }, { n: 4, qid: `q${id}-4`, eval_mode: 'llm_verifier', ideal: 'high', range: null }] } }),
    answer: (correct) => (correct ? 'Analysis...\n\nFinal answers:\n1. OR 1.52\n2. 1-50\n3. 11\n4. high' : 'Analysis...\n\nFinal answers:\n1. 9.1\n2. 51-100\n3. 40\n4. high'),
  },
  'arb-deep': {
    benchmark: 'autoresearchbench-deep', slice: ['Computer Vision'], key: 'failureSlice',
    row: (id, index, inSlice) => ({ id: `arb-${id}`, category: inSlice ? 'Computer Vision' : 'NLP & Language Models',
      gold: { type: 'deep', titles: [`Synthetic Study Number ${id} Of Invented Methods`], arxiv_ids: [`2201.${String(id).padStart(5, '0')}`], is_none: false } }),
    answer: (correct, row) => (correct ? `Searched...\nFinal answer: ${row.gold.titles[0]} (arXiv:${row.gold.arxiv_ids[0]})` : 'Searched...\nFinal answer: Unrelated Work On Other Matters (arXiv:2399.00001)'),
  },
  'arb-wide': {
    benchmark: 'autoresearchbench-wide', slice: ['Computer Vision'], key: 'failureSlice',
    row: (id, index, inSlice) => ({ id: `arb-${id}`, category: inSlice ? 'Computer Vision' : 'NLP & Language Models',
      gold: { type: 'wide', titles: [1, 2, 3].map((n) => `Synthetic Wide Paper ${id} Part ${n}`), arxiv_ids: [1, 2, 3].map((n) => `2202.${String(id * 10 + n).padStart(5, '0')}`), is_none: false } }),
    answer: (correct, row) => (correct ? `Searched...\nFinal answer:\n${row.gold.arxiv_ids.map((id, n) => `${n + 1}. ${row.gold.titles[n]} (arXiv:${id})`).join('\n')}`
      : 'Searched...\nFinal answer:\n1. Extra One Paper Title (arXiv:2399.00001)\n2. Extra Two Paper Title (arXiv:2399.00002)'),
  },
};

/** A source of recorded runs, drawn like skillCampaign.test.mjs draws its own (the same generator, the same call order). */
function source(kit, { ids, sliceShare, arms, repeats, seed, p = improving, cost = (arm, random) => Math.round((arm === 'baseline' ? 0.1 : 0.104) * (0.7 + 0.6 * random()) * 1e6) / 1e6 }) {
  const random = generator(seed);
  const rows = ids.map((id, index) => kit.row(id, index, index < Math.round(ids.length * sliceShare)));
  const inSlice = (row) => kit.slice.includes(row.calculatorId ?? row.topic ?? row.category);
  const runs = [];
  for (const row of rows) for (const { arm } of arms) for (let repeat = 0; repeat < repeats; repeat += 1) {
    runs.push({ row: row.id, arm, repeat, runId: `run-${row.id}-${arm}-${repeat}`, status: 'succeeded', answer: kit.answer(random() < p(arm, inSlice(row)), row), cost: cost(arm, random) });
  }
  return { kind: 'skill-arms', schema: 1, benchmark: kit.benchmark, repeats, rows, arms: Object.fromEntries(arms.map(({ arm, skill: s }) => [arm, { skill: s }])), runs };
}

/** A development + confirmation campaign for a scorer; `named: false` leaves `scorer` out (the shape of every campaign before the registry). */
async function fixture(scorerId, { named = true, development: dev = {}, confirmation: conf = {}, mutateRegistration, id = `benign-${scorerId}` } = {}) {
  const kit = KITS[scorerId], scorer = SKILL_SCORERS[scorerId];
  const development = source(kit, { ids: Array.from({ length: 30 }, (_, i) => 1000 + i), sliceShare: 0.6, arms: [BASE, GOOD, WEAK], repeats: 1, seed: 7, ...dev });
  const confirmation = source(kit, { ids: Array.from({ length: 32 }, (_, i) => 2000 + i), sliceShare: 0.85, arms: [BASE, GOOD], repeats: 3, seed: 11, ...conf });
  const identity = await skillCampaignConsumerIdentity(named ? { scorer: scorerId } : undefined);
  const inSlice = (row) => kit.slice.includes(row.calculatorId ?? row.topic ?? row.category);
  const statistics = {
    procedure: { ...BENIGN_PROCEDURE }, version: 1, paid_cost_budget: 1000, consumer_id: identity.implementationSha256, corpus_digest: digest(confirmation),
    mode: 'paired-t', deterministicConsumer: false, G_target: confirmation.rows.length,
    groups: confirmation.rows.map((row) => ({ id: `row-${row.id}`, family: scorer.family, failure_slice: inSlice(row) })),
    families: { [scorer.family]: { repeats: 3, forms: { answer: 1 }, score_type: 'bounded-continuous', margin: 0.05, pilot_rationale: 'Synthetic unit-test family; no benefit is claimed.' } },
    claims: { 'targeted-repair': 0.05 / 3 }, cost_identity: SKILL_COST_IDENTITY, expires_at: DEADLINE,
  };
  const registration = { ...(named ? { scorer: scorerId } : {}), [kit.key]: kit.slice, margin: 0.05, selection: { objective: 'failure-slice-gain', tieBreak: 'shorter-skill' }, statistics };
  mutateRegistration?.(registration);
  const target = { surface: 'capability-skill', dependencyDigest: 'a'.repeat(64), baselineRevision: 'benign-baseline' };
  const sources = { 'development-dev': development, 'confirmation-conf': confirmation };
  const manifest = {
    schemaVersion: 1, id, surface: 'capability-skill', candidateKind: 'skill', claim: 'targeted-repair', automated: true,
    createdAt: '2026-10-26T00:00:00Z', deadline: DEADLINE, budget: { campaignCny: 1000, monthCny: 30000 },
    models: { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improver: { provider: 'dashscope', model: 'qwen3.8-max' }, reviewer: { provider: 'dashscope', model: 'qwen3.8-max' } },
    target, registration: { digest: digest(registration), procedure: BENIGN_PROCEDURE.id, claim: 'targeted-repair' },
    data: { classification: 'public', sources: [
      { id: 'development-dev', digest: digest(development), role: 'development', exposure: 'exposed' },
      { id: 'confirmation-conf', digest: digest(confirmation), role: 'confirmation', exposure: 'sealed' }] },
  };
  return { manifest, inputs: { registration, target, sources } };
}

test('medcalc: the development choice, the confirmation, the costs and the statistics are the bytes the code before the registry produced', async () => {
  // Literals recorded on 2026-10-31 by running this fixture through skill_campaign.mjs / evaluator.mjs as they were before
  // skill_scorers.mjs existed. The consumer identity digest is not among them: it is the hash of the code, so it changed.
  const PINNED = {
    developmentResultDigest: '08dd55bed05bb9f3d395a142c9367ef053472ab5d4243ee43c0bb7a6af1e6250',
    confirmationResultDigest: '38e942eed6e41f9e0aa0c65dd14124a24da4fe43a38c0f4c0521801a9c9d4168',
    observationDigest: '5cf93ab0d0fdec30347e62c0b17606929c8a72931a2f1005851b8b71a9ff4799',
    costsDigest: 'f93904005fa8b664758f512b3fab6263613afaf2fede5bf8f54a81b9dfcabb38',
    costReceiptId: 'production-usage-ledger:bd14c1634ae5d099',
    statisticsObservationDigest: '90086ba0f657dc45b802a37786c20c0afbcc99ef2d5fac73206fd969035165f8',
  };
  const { manifest, inputs } = await fixture('medcalc', { named: false, id: 'benign-skill-campaign' });
  assert.equal(GOOD.arm, 'cand-8055f74527c7');
  const [development, confirmation] = Object.values(inputs.sources);
  const choice = chooseSkillCandidate(development, inputs.registration);
  assert.equal(choice.frozen.arm, GOOD.arm);
  assert.equal(digest({ scores: choice.scores, candidates: choice.candidates }), PINNED.developmentResultDigest);
  const frozen = { arm: choice.frozen.arm, skillDigest: choice.frozen.skillDigest };
  const measured = skillObservations(confirmation, inputs.registration, frozen);
  assert.equal(digest({ observations: measured.observations, scores: measured.scores ?? null }), PINNED.confirmationResultDigest);
  const { awaiting, completed, signed } = await runToVerdict({ manifest, inputs }, { dir: nextDir() });
  assert.equal(awaiting.status, 'awaiting-evaluation');
  assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint?.evaluation?.reasons ?? completed).slice(0, 300));
  assert.equal(completed.checkpoint.frozenPolicy.developmentResultDigest, PINNED.developmentResultDigest);
  assert.equal(completed.checkpoint.stages.confirmation.resultDigest, PINNED.confirmationResultDigest);
  assert.equal(signed.payload.observationDigest, PINNED.observationDigest);
  assert.equal(digest(signed.payload.costs), PINNED.costsDigest);
  assert.equal(signed.payload.costProvenance.receiptId, PINNED.costReceiptId);
  assert.equal(completed.checkpoint.evaluation.observationDigest, PINNED.statisticsObservationDigest);
  const quantities = completed.checkpoint.evaluation.quantities['targeted-repair'];
  assert.equal(quantities.quality_noninferiority.mean, 0.5395833333333333);
  assert.equal(quantities.cost_contrast.mean, -0.00854511562500001);
  assert.equal(quantities.failure_slice_quality.n_groups, 27);
  assert.equal(signed.payload.receipt.deterministic_qualification, null);
  assert.equal(signed.payload.consumer.scorer, 'medcalc');
});

test('medcalc: naming the scorer changes the registration and the identity-bound digests, not a single score', async () => {
  const legacy = await fixture('medcalc', { named: false }), named = await fixture('medcalc');
  const [dev] = Object.values(legacy.inputs.sources);
  assert.equal(digest(chooseSkillCandidate(dev, named.inputs.registration)), digest(chooseSkillCandidate(dev, legacy.inputs.registration)));
  assert.equal((await skillCampaignConsumerIdentity({ scorer: 'medcalc' })).implementationSha256, (await skillCampaignConsumerIdentity()).implementationSha256);
});

// --------------------------------------------------------------------------------------------- each scorer through the runner

for (const scorerId of ['bixbench-deterministic', 'arb-deep', 'arb-wide', 'medcalc']) {
  test(`${scorerId}: a skill that repairs its failure slice is qualified end to end, the receipt names the scorer`, async () => {
    const campaign = await fixture(scorerId);
    const { awaiting, completed, signed } = await runToVerdict(campaign, { dir: nextDir() });
    assert.equal(awaiting.status, 'awaiting-evaluation', JSON.stringify(awaiting).slice(0, 300));
    assert.equal(completed.status, 'completed', JSON.stringify(completed).slice(0, 400));
    assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint.evaluation?.reasons ?? completed).slice(0, 400));
    assert.equal(completed.checkpoint.frozenPolicy.arm, GOOD.arm);
    assert.equal(signed.payload.consumer.scorer, scorerId);
    assert.equal(signed.payload.consumer.implementationSha256, campaign.inputs.registration.statistics.consumer_id);
    assert.ok(signed.payload.costs.every((row) => row.cost > 0));
    // The slice the statistics were registered with is the slice the scorer's own field gives.
    assert.equal(completed.checkpoint.evaluation.quantities['targeted-repair'].failure_slice_quality.n_groups, campaign.inputs.registration.statistics.groups.filter((g) => g.failure_slice).length);
  });
}

test('a campaign whose arms do not differ ends before confirmation with the closed reason, whichever scorer scored it', async () => {
  for (const scorerId of ['bixbench-deterministic', 'arb-deep', 'arb-wide']) {
    const flat = await fixture(scorerId, { development: { p: () => 0.5 } });
    const store = memoryCampaignStore();
    const result = await runCampaign({ ...flat, ...runnerEnvironment({ store, now: tickingClock() }) });
    assert.equal(result.status, 'not-qualified', scorerId);
    assert.ok(['campaign_no_improving_candidate'].includes(result.reason), `${scorerId}: ${result.reason}`);
    assert.equal(store.ledger.size, 0, 'nothing is opened');
  }
});

test('an id outside the registry, or one of the wrong kind, is refused before anything runs', async () => {
  for (const scorer of ['judge', 'MEDCALC', '', null, 7, ['medcalc'], '__proto__']) {
    const campaign = await fixture('medcalc', { mutateRegistration: (registration) => { registration.scorer = scorer; } });
    const store = memoryCampaignStore();
    const result = await runCampaign({ ...campaign, ...runnerEnvironment({ store }) });
    assert.deepEqual(result, { status: 'not-qualified', reason: 'campaign_scorer_not_qualified' }, JSON.stringify(scorer));
    assert.equal(store.writes(), 0);
  }
});

test('a source that says another benchmark than the scorer scores is not a valid source', async () => {
  const mismatched = await fixture('arb-deep', { mutateRegistration: (registration) => { registration.scorer = 'medcalc'; registration.failureCalculators = [2, 3]; } });
  assert.equal((await runCampaign({ ...mismatched, ...runnerEnvironment() })).reason, 'campaign_source_invalid');
  const campaign = await fixture('bixbench-deterministic');
  assert.deepEqual(skillArmsIssues(Object.values(campaign.inputs.sources)[0], campaign.inputs.registration), []);
  assert.deepEqual(skillArmsIssues(Object.values(campaign.inputs.sources)[0], { scorer: 'arb-deep' }), ['skill_arms_invalid']);
  assert.deepEqual(skillArmsIssues(Object.values(campaign.inputs.sources)[0]), ['skill_arms_invalid'], 'no scorer named means medcalc');
});

test('rows are validated for the scorer: a medcalc row is not a bixbench row, a capsule needs a question code can settle', async () => {
  const campaign = await fixture('bixbench-deterministic');
  const [development] = Object.values(campaign.inputs.sources);
  const withRow = (mutate) => { const copy = structuredClone(development); mutate(copy.rows[0]); return skillArmsIssues(copy, campaign.inputs.registration); };
  assert.deepEqual(withRow(() => {}), []);
  assert.deepEqual(withRow((row) => { delete row.topic; }), ['skill_arms_rows_invalid']);
  assert.deepEqual(withRow((row) => { row.gold.questions.forEach((q) => { q.eval_mode = 'llm_verifier'; }); }), ['skill_arms_rows_invalid']);
  assert.deepEqual(withRow((row) => { row.gold.questions[2].n = 1; }), ['skill_arms_rows_invalid']);
  assert.deepEqual(withRow((row) => { row.gold.questions[0].range = [2, 1]; }), ['skill_arms_rows_invalid']);
  assert.deepEqual(withRow((row) => { row.gold.questions[0].eval_mode = 'regex_verifier'; }), ['skill_arms_rows_invalid']);
  const deep = await fixture('arb-deep'), wide = await fixture('arb-wide');
  const [deepDev] = Object.values(deep.inputs.sources), [wideDev] = Object.values(wide.inputs.sources);
  const wideAsDeep = structuredClone(wideDev); wideAsDeep.benchmark = 'autoresearchbench-deep';
  assert.deepEqual(skillArmsIssues(wideAsDeep, deep.inputs.registration), ['skill_arms_rows_invalid'], 'a wide row under the deep scorer');
  assert.deepEqual(skillArmsIssues(deepDev, wide.inputs.registration), ['skill_arms_invalid']);
});

test('the failure slice has the shape its scorer registers: strata for bixbench and arb, calculator ids for medcalc', async () => {
  const wrong = [
    ['bixbench-deterministic', (r) => { delete r.failureSlice; r.failureCalculators = [2, 3]; }],
    ['bixbench-deterministic', (r) => { r.failureSlice = [3]; }],
    ['bixbench-deterministic', (r) => { r.failureSlice = []; }],
    ['arb-deep', (r) => { r.failureSlice = ['']; }],
    ['arb-wide', (r) => { r.failureSlice = 'Computer Vision'; }],
    ['medcalc', (r) => { r.failureCalculators = ['2']; }],
  ];
  for (const [scorerId, mutateRegistration] of wrong) {
    const campaign = await fixture(scorerId, { mutateRegistration });
    assert.equal((await runCampaign({ ...campaign, ...runnerEnvironment() })).reason, 'campaign_registration_invalid', scorerId);
  }
  // A slice that names strata no confirmation row has leaves the registered groups disagreeing with the rows.
  const stray = await fixture('arb-deep', { mutateRegistration: (r) => { r.failureSlice = ['NLP & Language Models']; } });
  assert.equal((await runCampaign({ ...stray, ...runnerEnvironment() })).reason, 'campaign_source_group_registration_invalid');
});

test('a registration pinned to one scorer\'s identity cannot be evaluated under another\'s', async () => {
  const campaign = await fixture('arb-deep');
  const others = await skillCampaignConsumerIdentity({ scorer: 'arb-wide' });
  campaign.inputs.registration.statistics.consumer_id = others.implementationSha256;
  campaign.manifest.registration.digest = digest(campaign.inputs.registration);
  const store = memoryCampaignStore(), now = tickingClock();
  const awaiting = await runCampaign({ ...campaign, ...runnerEnvironment({ store, now }) });
  assert.equal(awaiting.status, 'awaiting-evaluation');
  await assert.rejects(evaluatorReceiptPayload({ ...campaign, request: awaiting.request, checkpoint: store.state(campaign.manifest.id), now: now() }), { message: 'campaign_evaluation_consumer_or_corpus_changed' });
});

test('the assembler builds a campaign for another scorer that the runner takes as it is', async () => {
  const { buildSkillCampaign, developmentOnly } = await import('../skill_assemble.mjs');
  const base = await fixture('bixbench-deterministic');
  const [development, confirmation] = Object.values(base.inputs.sources);
  const candidates = { model: 'qwen3.8-max', candidates: [GOOD, WEAK].map((c) => ({ arm: c.arm, digest: c.skill.digest, chars: c.skill.chars, title: c.skill.title })) };
  const input = { development, confirmation, candidates, scorer: 'bixbench-deterministic', failureSlice: ['transcriptomics'], month: '2026-11', idPrefix: 'rehearsal-', now: '2026-10-26T00:00:00Z' };
  await assert.rejects(buildSkillCampaign(input), { message: 'campaign_pilot_rationale_missing' });
  const built = await buildSkillCampaign({ ...input, pilotRationale: 'Synthetic rehearsal family; no benefit is claimed.' });
  assert.equal(built.manifest.id, 'rehearsal-capability-skill-bixbench-2026-11');
  assert.equal(built.inputs.registration.scorer, 'bixbench-deterministic');
  assert.deepEqual(built.inputs.registration.failureSlice, ['transcriptomics']);
  assert.equal(built.manifest.target.baselineRevision, SKILL_SCORERS['bixbench-deterministic'].baselineRevision);
  assert.equal(built.supply.developmentChoice.frozen.arm, GOOD.arm);
  assert.equal(built.inputs.registration.statistics.consumer_id, (await skillCampaignConsumerIdentity({ scorer: 'bixbench-deterministic' })).implementationSha256);
  const { completed } = await runToVerdict({ manifest: built.manifest, inputs: built.inputs }, { dir: nextDir() });
  assert.equal(completed.qualification, 'qualified');
  await assert.rejects(buildSkillCampaign({ ...input, scorer: 'judge', pilotRationale: 'x' }), { message: 'campaign_scorer_not_qualified' });
  await assert.rejects(buildSkillCampaign({ ...input, failureSlice: [4], pilotRationale: 'x' }), { message: 'campaign_registration_invalid' });
  // Development-only keeps the legacy shape for medcalc (no scorer key, calculators) and takes the new one for the others.
  const legacy = await fixture('medcalc', { named: false });
  const old = developmentOnly({ development: Object.values(legacy.inputs.sources)[0], candidates, failureCalculators: [3, 2], month: '2026-11' });
  assert.deepEqual(Object.keys(old.registration).slice(0, 2), ['failureCalculators', 'margin']);
  assert.equal(old.campaignId, 'capability-skill-medcalc-2026-11');
  const fresh = developmentOnly({ development, candidates, scorer: 'bixbench-deterministic', failureSlice: ['transcriptomics'], month: '2026-11' });
  assert.equal(fresh.campaignId, 'capability-skill-bixbench-2026-11');
  assert.equal(fresh.supply.developmentChoice.frozen.arm, GOOD.arm);
  assert.equal(fresh.supply.development.sliceRows, 18);
});
