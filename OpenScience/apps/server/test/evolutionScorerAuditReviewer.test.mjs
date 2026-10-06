// The scorer audit's reviewer: which evidence ids it may cite, which family reads which unit, and what happens to a paid
// review that cannot become a finding (release 6, 2026-10-06: one Qwen call, CNY 1.4795, then a throw and nothing stored).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../../../evals/paper-gold/evaluator.mjs';
import { createEvolutionScorerAudit, createScorerAuditReview, goldEvidenceIds, scorerAuditReviewerConfig, scorerAuditReviewerFamilies } from '../src/evolutionScorerAudit.mjs';

// The evidence shape of the scoped-research gold of the acceptance cycle (ids and hashes only; the hidden numbers and the author
// document's text are not part of what these tests need).
const SOURCE_HASH = 'a0a8476ab3ce31723e8ebd1a6ca365d77dd9a384bef32c21834f7dfc69d51275';
const AUTHOR_HASH = 'b'.repeat(64);
const scopedGold = () => ({ numeric: {}, inputAvailable: true, applicableStages: ['question', 'method', 'calculation', 'certainty', 'writing'], sourceHash: SOURCE_HASH,
  stageChecks: { question: ['question_aligned'], method: ['method_supported'], certainty: ['certainty_supported'], writing: ['writing_sources_bound'] },
  preservedEvidence: [{ id: 'hackshaw-main-dl', sourceHash: SOURCE_HASH }, { id: 'author-dataset-documentation', sourceHash: AUTHOR_HASH, kind: 'author-dataset-documentation', supportsPaperAdjudication: false }],
  reachableEvidenceIds: [], unreachableEvidenceIds: [] });
const allStages = { question: { observed: true, valid: true }, method: { observed: true, valid: true }, calculation: { observed: true, valid: true }, certainty: { observed: true, valid: true }, writing: { observed: true, valid: true } };

async function cycleOf(root, units, gold = scopedGold()) {
  const directory = path.join(root, 'paper-gold', 'cycles', 'cycle1');
  await fs.mkdir(directory, { recursive: true });
  const definition = { definition: { cases: [{ id: 'hackshaw-main-dl', type: 'research', gold }] }, evaluatorCodeHash: 'code1' };
  definition.hash = digest({ definition: definition.definition, evaluatorCodeHash: definition.evaluatorCodeHash });
  await fs.writeFile(path.join(directory, 'definition.json'), JSON.stringify(definition));
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ complete: true, evaluatorHash: definition.hash, units }));
}
const memoryService = () => {
  const records = new Map();
  return { records, get: async id => records.get(id), now: () => new Date('2026-10-07'), save: async (_kind, id, payload) => { const row = { id, payload }; records.set(id, row); return row; } };
};
const unit = (producerRunId, assessmentModel = 'qwen3.8-max-0902') => ({ caseId: 'hackshaw-main-dl', producerRunId, producerProjectId: 'eval-paper-test', allStagesValid: true, assessmentModel });
const complete = { header: { completeness: 'complete' } };
const readClean = async () => ({ transcript: complete, artifactIssues: [], unverifiedArtifacts: [] });
const reviewOf = (over = {}) => ({ independent: true, model: 'deepseek-v4-flash', evidenceIds: ['hackshaw-main-dl', 'author-dataset-documentation'], stages: allStages, ...over });
async function withCycle(units, gold, body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scorer-audit-reviewer-'));
  try { await cycleOf(root, units, gold); await body(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('the evidence a gold defines is every id and source hash it carries, including its preserved evidence rows', () => {
  assert.deepEqual([...goldEvidenceIds(scopedGold())].sort(), [AUTHOR_HASH, SOURCE_HASH, 'author-dataset-documentation', 'hackshaw-main-dl'].sort());
  assert.deepEqual([...goldEvidenceIds({ sourceHash: 'h', reachableEvidenceIds: ['r'], unreachableEvidenceIds: ['u'], evidenceIds: ['e'] })].sort(), ['e', 'h', 'r', 'u']);
  assert.equal(goldEvidenceIds({}).size, 0);
});

test('a review that cites the ids the gold itself defines is a finding, not a thrown error (release 6 discarded exactly this)', async () => {
  await withCycle([unit('run1')], scopedGold(), async root => {
    const seen = [];
    const audit = createEvolutionScorerAudit({ service: memoryService(), config: { evaluationDataDir: root }, readEvidence: readClean,
      review: async request => { seen.push(request.allowedEvidenceIds); return reviewOf(); } });
    const result = (await audit.run({ day: '2026-10-07' })).payload;
    assert.equal(result.findings[0].status, 'reviewed');
    assert.deepEqual(result.findings[0].reviewEvidenceIds, ['hackshaw-main-dl', 'author-dataset-documentation']);
    assert.deepEqual(seen[0], [AUTHOR_HASH, SOURCE_HASH, 'author-dataset-documentation', 'hackshaw-main-dl'].sort());
    assert.equal(result.refusedReviews, 0);
  });
});

test('a paid review that cannot become a finding is stored with the clause that refused it and is never paid for twice', async () => {
  const cases = [
    ['cites an id the gold does not define', reviewOf({ evidenceIds: ['hackshaw-main-dl', 'invented-source'] }), 'review_cites_evidence_outside_gold', ['invented-source']],
    ['cites nothing', reviewOf({ evidenceIds: [] }), 'review_cites_no_evidence', undefined],
    ['has no confirmed model identity', reviewOf({ independent: false }), 'review_model_identity_unconfirmed', undefined],
    ['names no model', reviewOf({ model: '' }), 'review_model_unnamed', undefined],
  ];
  for (const [label, review, reason, offending] of cases) {
    await withCycle([unit('run1')], scopedGold(), async root => {
      const service = memoryService();
      let calls = 0;
      const audit = createEvolutionScorerAudit({ service, config: { evaluationDataDir: root }, readEvidence: readClean, review: async () => { calls++; return review; } });
      const result = (await audit.run({ day: '2026-10-07' })).payload;
      assert.equal(result.status, 'complete', label);
      const finding = result.findings[0];
      assert.equal(finding.status, 'review-refused', label);
      assert.equal(finding.reason, reason, label);
      assert.deepEqual(finding.offendingEvidenceIds, offending, label);
      assert.deepEqual(finding.refusedReview.stages, allStages, label);
      assert.deepEqual({ reviewed: result.reviewed, refusedReviews: result.refusedReviews, outcome: result.outcome, passed: result.passed, waitingByReason: result.waitingByReason }, { reviewed: 0, refusedReviews: 1, outcome: 'nothing-audited', passed: false, waitingByReason: { [reason]: 1 } }, label);
      // A retry of the same day starts from what is stored: the unit is not reviewed again.
      service.records.set('evolution-scorer-audit-2026-10-07', { id: 'evolution-scorer-audit-2026-10-07', payload: { ...result, status: 'running' } });
      await audit.run({ day: '2026-10-07' });
      assert.equal(calls, 1, label);
    });
  }
});

test('the audit refuses by name, before any call, when the only reviewer it has is the assessor family, and picks the other family when it has both', async () => {
  await withCycle([unit('run_qwen', 'qwen3.8-max-0902'), unit('run_deepseek', 'deepseek-v4-flash')], scopedGold(), async root => {
    const families = [];
    const run = async reviewerFamilies => {
      families.length = 0;
      const audit = createEvolutionScorerAudit({ service: memoryService(), config: { evaluationDataDir: root }, readEvidence: readClean, reviewerFamilies,
        review: async request => { families.push(request.family); return reviewOf({ model: request.family === 'qwen' ? 'qwen3.8-max-0902' : 'deepseek-v4-flash' }); } });
      const result = (await audit.run({ day: '2026-10-07' })).payload;
      return Object.fromEntries(result.findings.map(row => [row.producerRunId, row]));
    };
    // Only Qwen configured: the Qwen-assessed unit is refused before any call, the DeepSeek-assessed one is read by Qwen.
    let byRun = await run(['qwen']);
    assert.equal(byRun.run_qwen.status, 'waiting-reviewer');
    assert.equal(byRun.run_qwen.reason, 'only_reviewer_available_is_assessor_family');
    assert.deepEqual([byRun.run_qwen.assessorFamily, byRun.run_qwen.reviewerFamilies], ['qwen', ['qwen']]);
    assert.equal(byRun.run_deepseek.status, 'reviewed');
    assert.deepEqual(families, ['qwen']);
    // Both configured: each unit is read by the other family, whatever the order of preference.
    byRun = await run(['qwen', 'deepseek']);
    assert.deepEqual([byRun.run_qwen.status, byRun.run_qwen.reviewerFamily, byRun.run_deepseek.status, byRun.run_deepseek.reviewerFamily], ['reviewed', 'deepseek', 'reviewed', 'qwen']);
    assert.deepEqual(families.sort(), ['deepseek', 'qwen']);
    // Nothing configured: named, no call.
    byRun = await run([]);
    assert.equal(byRun.run_qwen.reason, 'no_reviewer_configured');
    assert.deepEqual(families, []);
    // An assessor that cannot be named cannot be differed from: the read happens and is not called independent.
    byRun = await run(['qwen']);
    assert.equal(byRun.run_deepseek.independentOfAssessor, true);
  });
  await withCycle([unit('run_unnamed', null)], scopedGold(), async root => {
    const audit = createEvolutionScorerAudit({ service: memoryService(), config: { evaluationDataDir: root }, readEvidence: readClean, reviewerFamilies: ['qwen', 'deepseek'], review: async request => reviewOf({ model: request.family === 'qwen' ? 'qwen3.8-max-0902' : 'deepseek-v4-flash' }) });
    const finding = (await audit.run({ day: '2026-10-07' })).payload.findings[0];
    assert.deepEqual([finding.status, finding.independentOfAssessor, finding.assessorFamily], ['same-family-reread', false, 'unknown']);
  });
});

test('a gold that defines nothing a review could cite is refused before the reviewer is paid', async () => {
  await withCycle([unit('run1')], { numeric: {}, applicableStages: ['method'] }, async root => {
    const audit = createEvolutionScorerAudit({ service: memoryService(), config: { evaluationDataDir: root }, readEvidence: readClean, review: async () => { throw Error('must not be called'); } });
    const finding = (await audit.run({ day: '2026-10-07' })).payload.findings[0];
    assert.deepEqual([finding.status, finding.reason], ['waiting-reviewer', 'gold_defines_no_citable_evidence']);
  });
});

const deployment = (over = {}) => ({ reviewProvider: 'dashscope', reviewModel: 'qwen3.8-max-0902', reviewApiBase: 'https://dashscope.example/compatible-mode/v1', dashscopeApiKey: 'dashscope-test-key',
  deepseekApiKey: 'deepseek-test-key', deepseekModel: 'deepseek-flash', deepseekBaseUrl: 'https://api.deepseek.com', reviewMaxOutputTokens: 1000, userDailySpendLimit: 0, userWeeklySpendLimit: 0, production: false, ...over });

test('the families a deployment can call are those with a key and a model the gateways carry, Qwen only on a DashScope review provider', () => {
  assert.deepEqual(scorerAuditReviewerFamilies(deployment()), ['qwen', 'deepseek']);
  assert.deepEqual(scorerAuditReviewerFamilies(deployment({ deepseekApiKey: '' })), ['qwen']);
  assert.deepEqual(scorerAuditReviewerFamilies(deployment({ dashscopeApiKey: '' })), ['deepseek']);
  assert.deepEqual(scorerAuditReviewerFamilies(deployment({ deepseekModel: 'not-a-certified-model' })), ['qwen']);
  assert.deepEqual(scorerAuditReviewerFamilies(deployment({ reviewProvider: 'deepseek', reviewModel: 'deepseek-v4-pro', reviewApiBase: 'https://api.deepseek.com' })), ['deepseek']);
  const config = deployment();
  assert.equal(scorerAuditReviewerConfig(config, 'qwen'), config);
  assert.equal(scorerAuditReviewerConfig(config, undefined), config);
  assert.deepEqual(Object.fromEntries(['reviewProvider', 'reviewModel', 'reviewApiBase'].map(key => [key, scorerAuditReviewerConfig(config, 'deepseek')[key]])), { reviewProvider: 'deepseek', reviewModel: 'deepseek-flash', reviewApiBase: 'https://api.deepseek.com' });
  assert.equal(scorerAuditReviewerConfig(deployment({ deepseekApiKey: '' }), 'deepseek'), null);
});

/** An OpenAI-style SSE answer that reports the model that answered. */
const sse = (model, value) => new Response(new TextEncoder().encode([
  { id: 'chatcmpl-test', model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(value) } }] },
  { id: 'chatcmpl-test', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 'chatcmpl-test', model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('the audit review calls the chosen family at its own provider with its own key, and tells the reviewer which ids it may cite', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), authorization: init.headers.authorization, model: body.model, user: JSON.parse(body.messages.at(-1).content), system: body.messages.find(message => message.content.startsWith('Independently')).content });
    return sse(String(url).includes('deepseek') ? 'deepseek-flash' : 'qwen3.8-max-0902', { stages: allStages, evidenceIds: ['hackshaw-main-dl'] });
  };
  const review = createScorerAuditReview({ config: deployment(), usageLedger: null, fetchImpl, owner: async () => 'operator', projectId: 'evimed-evolution', limits: { daily: 0, weekly: 0 } });
  const request = { gold: scopedGold(), observed: { transcript: 'x' } };
  const viaDeepseek = await review({ ...request, family: 'deepseek', allowedEvidenceIds: ['hackshaw-main-dl', 'author-dataset-documentation'] });
  assert.deepEqual(sent[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(sent[0].authorization, 'Bearer deepseek-test-key');
  assert.equal(sent[0].model, 'deepseek-flash');
  assert.deepEqual(sent[0].user.allowedEvidenceIds, ['hackshaw-main-dl', 'author-dataset-documentation']);
  assert.match(sent[0].system, /Cite only IDs listed in allowedEvidenceIds/);
  assert.deepEqual([viaDeepseek.model, viaDeepseek.independent], ['deepseek-flash', true]);
  const viaQwen = await review({ ...request, family: 'qwen' });
  assert.equal(sent[1].url, 'https://dashscope.example/compatible-mode/v1/chat/completions');
  assert.equal(sent[1].authorization, 'Bearer dashscope-test-key');
  assert.equal(sent[1].model, 'qwen3.8-max-0902');
  assert.deepEqual(sent[1].user.allowedEvidenceIds, [...goldEvidenceIds(scopedGold())].sort(), 'without an explicit list the reviewer is given the gold\'s own');
  assert.equal(viaQwen.independent, true);
  await assert.rejects(createScorerAuditReview({ config: deployment({ deepseekApiKey: '' }), fetchImpl, owner: async () => 'operator', projectId: 'p', limits: {} })({ ...request, family: 'deepseek' }), /no deepseek reviewer configured/);
});
