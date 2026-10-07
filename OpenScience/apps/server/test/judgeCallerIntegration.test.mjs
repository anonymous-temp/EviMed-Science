import assert from 'node:assert/strict';
import test from 'node:test';
import { FrontierEditor } from '../src/frontierEditor.mjs';
import { classifyProbeAnswer, classifyProbeAnswerWithJudge } from '../src/geoSanity.mjs';
import { tickCatalogue } from '../src/geoMarket.mjs';
import { SourceService } from '../src/sourceService.mjs';

const settled = value => ({ outcome: 'settled', value });
const owner = { userId: 'operator', projectId: 'evimed-frontier' };
const config = { deepseekProviderEnabled: true, deepseekApiKey: 'test-placeholder', operatorUsers: ['operator'] };
const item = { key: 'entry', title: '糖尿病新研究', sourceName: 'Journal', excerpt: 'Preserved source text', allowedLanes: ['evidence'] };

test('J5 restricts the vocabulary and adapts a settled answer without a Flash call', async () => {
  const calls = [];
  const editor = new FrontierEditor(config, { owner, callModel: async () => { throw new Error('Flash forbidden'); }, judgeService: { judge: async (...args) => {
    calls.push(args); return settled({ items: [{ id: '1', isMedical: true, isNews: true, category: 'evidence', roundup: false, specialties: ['endocrinology'] }] });
  } } });
  const result = await editor.screen([item]);
  assert.equal(calls[0][0], 'J5');
  assert.deepEqual(calls[0][1].items[0].allowedCategories, ['evidence']);
  assert.ok(calls[0][1].items[0].allowedSpecialties.length >= 20);
  assert.equal(result.errors.size, 0);
  assert.equal(result.verdicts.get('entry').language, 'zh');
  assert.deepEqual(result.verdicts.get('entry').specialties, ['endocrinology']);
});

test('J5 uncertainty falls back to the existing metered Flash classifier', async () => {
  let flash = 0;
  const editor = new FrontierEditor(config, { owner, judgeService: { judge: async () => ({ outcome: 'fallback', value: null }) }, callModel: async () => {
    flash++;
    return { choices: [{ message: { content: JSON.stringify({ items: [{ id: '1', medical: true, news: false, lane: 'evidence', specialties: [], language: 'zh', digest: false }] }) } }] };
  } });
  assert.equal((await editor.screen([item])).verdicts.size, 1);
  assert.equal(flash, 1);
});

test('J6 uncertainty keeps distinct events and never pays for the former Flash fallback', async () => {
  const editor = new FrontierEditor(config, { owner, callModel: async () => { throw new Error('Flash forbidden'); }, judgeService: { judge: async () => ({ outcome: 'fallback', value: null }) } });
  const report = { sourceName: 'Journal', titleRaw: 'Trial followup', publishedAt: '2026-10-06' };
  assert.deepEqual((await editor.judgeSameEvent({ report, candidates: [report] })).verdicts, ['no']);
  editor.judgeService = { judge: async () => settled({ relation: 'related' }) };
  assert.deepEqual((await editor.judgeSameEvent({ report, candidates: [report] })).verdicts, ['related']);
});

test('J21 distinguishes refusals from infrastructure notices and preserves provider failures', async () => {
  const input = { rawStatus: 'ok', answer: 'This answer declines an individual treatment recommendation.' };
  assert.equal((await classifyProbeAnswerWithJudge(input, { judge: async () => settled({ usable: true, status: 'refusal' }) }, owner)).status, 'refusal');
  assert.equal((await classifyProbeAnswerWithJudge(input, { judge: async () => settled({ usable: false, status: 'login' }) }, owner)).status, 'suspect');
  assert.deepEqual(await classifyProbeAnswerWithJudge(input, { judge: async () => ({ outcome: 'fallback' }) }, owner), classifyProbeAnswer(input));
  assert.equal((await classifyProbeAnswerWithJudge({ ...input, rawStatus: 'failed' }, { judge: async () => { throw new Error('Must not call'); } }, owner)).status, 'failed');
});

test('J22 adds blacklist evidence, keeps regex exclusions and rechecks persisted decisions on resync', async () => {
  const stored = new Map();
  const store = { getMediaRows: async (type, ids) => ids.map(id => stored.get(`${type}:${id}`)).filter(Boolean),
    upsertMediaRows: async rows => { for (const row of rows) stored.set(`${row.mediaType}:${row.resourceId}`, row); }, markUnseenMediaUnavailable: async () => 0 };
  const raw = (resourceId, remarks) => ({ resourceId, remarks, title: 'News outlet', fields: {}, priceCny: 1, publishRate: 1, caseLink: '', available: true });
  const market = { configured: true, fields: async () => [], mediaList: async (type, { page }) => type === 'website' && page === 1 ? { rows: [raw('1', '不接医疗'), raw('2', '需要提供联系电话'), raw('3', '需要提供联系电话')], received: 3 } : { rows: [], received: 0 } };
  let calls = 0;
  let owners = 0;
  const catalogueOwner = { userId: 'publisher', projectId: 'evimed-evidence' };
  const deps = { store, market, config, catalogueJudgeContext: async () => { owners++; return catalogueOwner; }, judgeService: { judge: async (site, input, context) => { calls++; assert.equal(site, 'J22'); assert.deepEqual(context, { ...catalogueOwner, module: 'geo' }); return settled({ blacklisted: input.remark.includes('电话'), medicalExcluded: false, contactRequired: input.remark.includes('电话'), changesCopy: false, promisesIndex: false, weekendPosting: true, linkRetention: false }); } } };
  await tickCatalogue(deps);
  assert.equal(calls, 2, 'identical remarks are judged once');
  assert.equal(owners, 1, 'resolve the real catalogue owner once per sync');
  assert.equal(stored.get('website:1').blacklisted, true, 'semantic no never releases a regex exclusion');
  assert.equal(stored.get('website:2').blacklisted, true);
  await tickCatalogue(deps);
  assert.equal(calls, 4, 'persisted decisions cannot bypass current calibration or disablement');
  assert.equal(stored.get('website:2').blacklisted, true);
  const fallback = await tickCatalogue({ ...deps, catalogueJudgeContext: async () => { throw new Error('Owner unavailable'); } });
  assert.equal(fallback.rows, 3);
  assert.equal(fallback.blacklisted, 1, 'ordinary counts and persistence survive a missing billing owner');
  assert.equal(calls, 4, 'missing attribution keeps lexical rules without a provider call');
  assert.equal(stored.get('website:1').blacklisted, true);
});

test('J7 classifies parsed text before capture and respects manual overrides and generation changes', async () => {
  for (const scenario of ['classify', 'override', 'changed']) {
    const source = { id: 'src_test', projectId: 'project', revision: 1, payload: { paths: ['upload.pdf'], generation: 1, docType: 'published-paper', depth: 'structured', ...(scenario === 'override' ? { override: { docType: 'published-paper' } } : {}) } };
    let saved, calls = 0;
    const documents = { get: async () => structuredClone(source), put: async (user, kind, id, payload) => { saved = payload; } };
    const service = new SourceService(documents, {}, { judgeService: { judge: async (site, input) => {
      calls++; assert.equal(site, 'J7'); assert.equal(input.text.length, 1500); assert.equal(input.types.length, 22); return settled({ docType: 'research-protocol' });
    } } });
    let leases = 0;
    service.withSourceLease = async (job, action) => { leases++; return action({ ...source, payload: { ...source.payload, generation: scenario === 'changed' && leases > 1 ? 2 : 1 } }, { query: async () => ({ rows: [] }) }); };
    await service.freezeCapture({ id: 'ingest', userId: 'user', projectId: 'project', payload: { sourceId: source.id } }, { text: 'a'.repeat(2000), units: [], extractor: 'test', summary: 'summary' });
    assert.equal(calls, scenario === 'override' ? 0 : 1);
    assert.equal(saved.docType, scenario === 'classify' ? 'research-protocol' : 'published-paper');
    assert.equal(saved.depth, scenario === 'classify' ? 'deep' : 'structured');
  }
});

test('evolution decision calls disable thinking and reject actions outside the supplied options', async () => {
  const { createEvolutionDecisionModel, evolutionOptionId } = await import('../src/evolutionComposition.mjs');
  let request;
  const model = createEvolutionDecisionModel({ config: { evolutionDailyBudgetCny: 10 }, usageLedger: {}, owner: async () => 'operator' }, async (_dependencies, input) => {
    request = input; return { choices: [{ message: { content: '{"option":"keep"}' } }] };
  });
  assert.deepEqual(await model('Choose an existing option.', { options: [{ id: 'keep' }] }), { option: 'keep' });
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.purpose, 'evolution');
  assert.equal(request.userId, 'operator');
  assert.equal(request.limits.daily, 10);
  assert.equal(evolutionOptionId([{ id: 'keep' }], 'keep'), 'keep');
  for (const invalid of ['delete-everything', null, { id: 'keep' }]) assert.throws(() => evolutionOptionId([{ id: 'keep' }], invalid), { code: 'evolution_refresh_unavailable' });
});


test('J6 disabled and uncalibrated decisions restore the original Flash path', async () => {
  for (const code of ['judge_disabled', 'judge_unconfigured', 'judge_uncalibrated', 'judge_calibration_mismatch']) {
    let flash = 0;
    const report = { sourceName: 'Journal', titleRaw: 'Trial followup', publishedAt: '2026-10-06' };
    const editor = new FrontierEditor(config, { owner, judgeService: { judge: async () => ({ outcome: 'fallback', code }) },
      callModel: async () => { flash++; return { choices: [{ message: { content: JSON.stringify({ items: [{ id: '1', verdict: 'yes' }] }) } }] }; } });
    assert.deepEqual((await editor.judgeSameEvent({ report, candidates: [report] })).verdicts, ['yes']);
    assert.equal(flash, 1);
  }
});

test('J5 and J6 supply actual metered Flash drift baselines in judge vocabulary', async () => {
  const report = { sourceName: 'Journal', titleRaw: 'Trial followup', publishedAt: '2026-10-06' };
  let flash = 0;
  const editor = new FrontierEditor(config, { owner, callModel: async (_deps, call) => {
    flash++; assert.equal(call.purpose, 'frontier');
    const value = flash === 1 ? { items: [{ id: '1', medical: true, news: false, lane: 'evidence', specialties: [], language: 'zh', digest: false }] }
      : { items: [{ id: '1', verdict: 'yes' }] };
    return { choices: [{ message: { content: JSON.stringify(value) } }] };
  }, judgeService: { judge: async (site, input, context) => {
    const baseline = await context.baseline();
    if (site === 'J5') assert.deepEqual(baseline.value, { items: [{ id: '1', isMedical: true, isNews: false, category: 'evidence', specialties: [], roundup: false }] });
    else assert.deepEqual(baseline.value, { relation: 'same' });
    return settled(baseline.value);
  } } });
  assert.equal((await editor.screen([item])).verdicts.size, 1);
  assert.deepEqual((await editor.judgeSameEvent({ report, candidates: [report] })).verdicts, ['yes']);
  assert.equal(flash, 2);
});

test('J1 samples the original SCREEN semantics through one metered model call, never a runtime', async () => {
  const { MethodConsolidation, createMethodScreenBaseline } = await import('../src/methodConsolidation.mjs');
  const { createJudgeService } = await import('../src/judgeService.mjs');
  for (const sample of [0, 1]) {
    let calls = 0;
    const baseline = createMethodScreenBaseline({ config: { deepseekModel: 'deepseek-flash', learningDailyLimitCny: 10 }, usageLedger: {},
      callModel: async (_deps, call) => {
        calls++; assert.equal(call.purpose, 'learning'); assert.equal(call.operation, 'J1-baseline');
        assert.equal(call.limits.moduleDaily, 10); assert.equal(call.limits.daily, undefined); assert.equal(call.body.thinking.type, 'enabled'); assert.equal(call.body.max_tokens, 8192);
        return { choices: [{ message: { content: JSON.stringify({ screened: { selected: [{ methods: ['a', 'b'], reason: 'same work' }], rejected: [] } }) } }] };
      } });
    const judge = createJudgeService({ config: { typesafeApiKey: 'test-only', reviewJevModel: 'jev-1.13.0' }, calibrationMode: true,
      random: () => sample, database: { query: async () => ({ rows: [] }) },
      callImpl: async () => ({ model: 'jev-1.13.0', answers: { p0: { type: 'choice', choice: 'related', probabilities: { unrelated: 0, related: 1 }, confidence: 1 } } }) });
    const consolidation = new MethodConsolidation({ learning: {}, dispatch: async () => { throw new Error('Runtime forbidden'); }, readResult: async () => null,
      judgeService: judge, screenBaseline: baseline });
    const result = await consolidation.screenPairs({ id: 'job', userId: 'user', projectId: 'project' }, [{ a: 'a', b: 'b', overlap: 2 }], []);
    assert.equal(result.pairs.length, 1);
    await judge.close();
    assert.equal(calls, sample === 0 ? 1 : 0);
  }
});
