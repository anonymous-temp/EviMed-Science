import assert from 'node:assert/strict';
import test from 'node:test';
import { VCR_MATCH_BATCH_LIMITS, planMatchExtraction } from '@evimed/domain';
import { createFactExtractor, createMatchBatch, createMatchExtractExecutor, extractScenario, matchExtractBudget, matchExtractChunks, matchExtractDigest, planBatch } from '../src/vcrMatchBatch.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { assessSubject } from '../src/vcrMatching.mjs';

const study = { id: 'study', userId: 'user', projectId: 'project' };
const criterion = (id, text, variable = 'history') => ({ id, kind: 'inclusion', sourceText: text, requirement: { op: 'present', variable, window: { months: 6 } } });
const criteria = [criterion('first', `${'Definition '.repeat(20)}includes the complete final definition.`), criterion('second', 'Another use of the same concept.')];

function currentReading(selectedCriteria) {
  const variables = selectedCriteria.map(row => row.requirement.variable);
  const estimate = planMatchExtraction({ roster: [{ subjectKey: 'person', documents: [{ id: 'doc', chars: 60000 }] }], limit: 1,
    reading: matchExtractBudget(selectedCriteria, variables) }).estimate;
  return { protocolVersionId: 'v1', subjects: ['person'], variables, questionsDigest: matchExtractDigest(variables, selectedCriteria, 'v1'), estimate };
}

test('batch context retains complete definitions, every use and structured predicates', async () => {
  const calls = [];
  const extractor = createFactExtractor({ config: {}, async callModel(_deps, call) {
    calls.push(call.body);
    return { choices: [{ finish_reason: 'stop', message: { content: '{"facts":[]}' } }] };
  } });
  await extractor.extract({ study, jobId: 'job', text: 'record', criteria, variables: ['history'] });
  const prompt = calls[0].messages[0].content;
  assert.ok(prompt.includes(criteria[0].sourceText));
  assert.ok(prompt.includes(criteria[1].sourceText));
  assert.ok(prompt.includes('"window":{"months":6}'));
  assert.notEqual(matchExtractDigest(['history'], criteria, 'v1'), matchExtractDigest(['history'], [criterion('first', 'Changed meaning')], 'v1'));
  assert.notEqual(matchExtractDigest(['history'], criteria, 'v1'), matchExtractDigest(['history'], criteria, 'v2'));
});

test('question chunks bound output work and reject oversized context without silently truncating it', () => {
  const many = Array.from({ length: VCR_MATCH_BATCH_LIMITS.questionsPerCall + 1 }, (_, index) => criterion(`c${index}`, `Meaning ${index}`, `value_${index}`));
  const chunks = matchExtractChunks(many, many.map(row => row.requirement.variable));
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(chunk => chunk.length <= VCR_MATCH_BATCH_LIMITS.questionsPerCall));
  const long = [criterion('long_a', 'x'.repeat(4000), 'a'), criterion('long_b', 'y'.repeat(4000), 'b')];
  assert.equal(matchExtractChunks(long, ['a', 'b']).length, 2, 'context length also splits a request below the variable-count limit');
  assert.throws(() => matchExtractChunks([criterion('large', 'x'.repeat(VCR_MATCH_BATCH_LIMITS.questionChars + 1))], ['history']), { code: 'vcr_extract_context_too_large' });
});

test('language-only protocols retain explicit pending work and never claim the table answered them', async () => {
  const language = { id: 'consent', kind: 'inclusion', sourceText: 'Can provide consent', requirement: { op: 'language', key: 'consent', text: 'Can provide consent' } };
  const matchStore = { async latestProtocol() { return { id: 'v1' }; }, async listCriteria() { return [language]; } };
  const batch = createMatchBatch({ jobs: { async enqueue() { throw new Error('No fact questions to queue'); } }, matchStore, documents: { async roster() { return []; } }, config: {} });
  const result = await batch.start(study, {});
  assert.deepEqual(result.pendingLanguageKeys, ['consent']);
  assert.equal(result.state, 'language_pending');
  assert.doesNotMatch(result.statement, /表格已回答.*全部变量/);
});

test('planning prices every chunk and changed criteria do not reuse completed readings', async () => {
  const many = Array.from({ length: VCR_MATCH_BATCH_LIMITS.questionsPerCall + 1 }, (_, index) => criterion(`c${index}`, `Meaning ${index}`, `value_${index}`));
  const variables = many.map(row => row.requirement.variable).sort();
  const oldDigest = matchExtractDigest(variables, many, 'v1');
  const matchStore = { async latestProtocol() { return { id: 'v1' }; }, async listCriteria() { return many; }, async extractionsRead(_studyId, digest) { return digest === oldDigest ? new Set(['person\u0000doc']) : new Set(); } };
  const documents = { async roster() { return [{ id: 'doc', subjectKey: 'person', chars: 50 }]; } };
  const original = await planBatch({ study, matchStore, documents, config: {} });
  assert.equal(original.ok && original.plan.alreadyRead.length, 1);
  many[0] = criterion('c0', 'Changed definition', 'value_0');
  const revised = await planBatch({ study, matchStore, documents, config: {} });
  assert.equal(revised.ok && revised.plan.toRead.length, 1);
  assert.equal(revised.ok && revised.plan.estimate.outputTokens, 2 * VCR_MATCH_BATCH_LIMITS.outputTokens);
  assert.ok(revised.ok && revised.plan.estimate.inputTokens >= 2 * 50);
});

test('all chunks must finish before facts or the completed-record ledger are written', async () => {
  const many = Array.from({ length: VCR_MATCH_BATCH_LIMITS.questionsPerCall + 1 }, (_, index) => criterion(`c${index}`, `Meaning ${index}`, `value_${index}`));
  let calls = 0;
  const saved = [];
  const completed = [];
  const run = createMatchExtractExecutor({
    store: { async studyById() { return study; }, async one() { return null; } },
    matchStore: { async listCriteria() { return many; }, async extractionsRead() { return new Set(); }, async recordExtraction(row) { completed.push(row); } },
    documents: { async roster() { return [{ id: 'doc', subjectKey: 'person' }]; }, async runtimeRead() { return { text: 'The chart records a finding.' }; } },
    extractor: { async extract() { calls += 1; if (calls === 2) throw Object.assign(new Error('cut off'), { code: 'vcr_extract_incomplete' }); return { answer: { facts: [{ variable: 'value_0', surface: 'finding', quote: 'The chart records a finding.' }] }, inputTokens: 30, outputTokens: 20 }; } },
    async writeFacts({ items }) { saved.push(...items); return { ids: ['fact'], issues: [] }; }, config: { vcrMatchExtractConcurrency: 1 },
  });
  const result = await run({ job: { id: 'job', studyId: study.id, scenario: currentReading(many) }, async onProgress() {} });
  assert.equal(calls, 2);
  assert.equal(result.diagnostics.recordsFailed, 1);
  assert.deepEqual(completed, []);
  assert.deepEqual(saved, []);
});

test('successful chunks write together once, account every prompt and resume as one completed record', async () => {
  const many = Array.from({ length: VCR_MATCH_BATCH_LIMITS.questionsPerCall + 1 }, (_, index) => criterion(`c${index}`, `Meaning ${index}`, `value_${index}`));
  const variables = many.map(row => row.requirement.variable);
  const calls = [];
  const saved = [];
  const completed = [];
  const done = new Set();
  const matchStore = {
    async latestProtocol() { return { id: 'v1' }; }, async listCriteria() { return many; },
    async extractionsRead() { return done; }, async recordExtraction(row) { completed.push(row); done.add('person\u0000doc'); },
  };
  const text = 'The chart records a finding.';
  const documents = { async roster() { return [{ id: 'doc', subjectKey: 'person', chars: text.length }]; }, async runtimeRead() { return { text }; } };
  const extractor = createFactExtractor({ config: {}, async callModel(_deps, call) {
    calls.push(call.body);
    const asked = [...call.body.messages[0].content.matchAll(/^- (value_\d+)：/gm)].map(match => match[1]);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ facts: asked.map(variable => ({ variable, surface: 'finding', quote: text })) }) } }], usage: { prompt_tokens: 30, completion_tokens: 20 } };
  } });
  const run = createMatchExtractExecutor({ store: { async studyById() { return study; }, async one() { return null; } }, matchStore, documents, extractor,
    async writeFacts({ items }) { assert.equal(calls.length, 2); saved.push(...items); return { ids: items.map(row => row.variable), issues: [] }; }, config: { vcrMatchExtractConcurrency: 1 } });
  const built = await planBatch({ study, matchStore, documents, config: {} });
  assert.equal(built.ok, true);
  const job = { job: { id: 'job', studyId: study.id, scenario: extractScenario(built) }, async onProgress() {} };
  const result = await run(job);
  assert.equal(saved.length, variables.length);
  assert.equal(completed.length, 1);
  assert.deepEqual([completed[0].inputTokens, completed[0].outputTokens], [60, 40]);
  assert.equal(result.diagnostics.recordsRead, 1);
  const actualPromptCharacters = calls.reduce((sum, call) => sum + call.messages.reduce((n, message) => n + message.content.length, 0), 0);
  assert.ok(built.ok && built.plan.estimate.inputTokens >= actualPromptCharacters);
  assert.ok(built.ok && built.plan.estimate.inputTokens < actualPromptCharacters + 201);
  await run(job);
  assert.equal(calls.length, 2);
  assert.equal(saved.length, variables.length);
});

test('legacy queued estimates cannot spend on new chunking or expanded context before replanning', async () => {
  for (const variablesCount of [1, 7]) {
    const many = Array.from({ length: variablesCount }, (_, index) => criterion(`c${index}`, 'A complete definition '.repeat(80), `value_${index}`));
    let reads = 0, calls = 0, writes = 0;
    const scenario = { protocolVersionId: 'v1', subjects: ['person'], variables: many.map(row => row.requirement.variable), estimate: { records: 1, inputTokens: 1501, outputTokens: 2000 } };
    const original = JSON.stringify(scenario);
    const run = createMatchExtractExecutor({ store: { async studyById() { return study; }, async one() { return null; } },
      matchStore: { async listCriteria() { return many; }, async extractionsRead() { return new Set(); }, async recordExtraction() { writes += 1; } },
      documents: { async roster() { return [{ id: 'doc', subjectKey: 'person', chars: 1 }]; }, async runtimeRead() { reads += 1; return { text: 'x' }; } },
      extractor: { async extract() { calls += 1; return { answer: { facts: [] }, inputTokens: 1, outputTokens: 1 }; } }, async writeFacts() { writes += 1; return { ids: [] }; } });
    await assert.rejects(() => run({ job: { id: 'legacy', studyId: study.id, scenario }, async onProgress() {} }), { code: 'vcr_extract_replan_required', recoverable: true });
    assert.deepEqual([reads, calls, writes], [0, 0, 0]);
    assert.equal(JSON.stringify(scenario), original, 'a durable estimate is never rewritten');
  }
});

test('current context markers do not permit a changed or underfunded frozen budget', async () => {
  const many = Array.from({ length: 7 }, (_, index) => criterion(`c${index}`, `Meaning ${index}`, `value_${index}`));
  for (const change of [
    scenario => { scenario.questionsDigest = '0'.repeat(64); },
    scenario => { scenario.estimate.promptVersion = 'match-extract-2'; },
    scenario => { scenario.estimate.promptVersion = 'match-extract-3'; },
    scenario => { scenario.estimate.overheadTokensPerRecord -= 1; },
    scenario => { scenario.estimate.callsPerRecord = 1; },
    scenario => { scenario.estimate.inputTokens = 0; },
    scenario => { scenario.estimate.outputTokens = 0; },
    scenario => { scenario.estimate.calls = 0; },
    scenario => { scenario.estimate.records = 0; },
  ]) {
    const scenario = currentReading(many);
    change(scenario);
    let reads = 0;
    const run = createMatchExtractExecutor({ store: { async studyById() { return study; }, async one() { return null; } },
      matchStore: { async listCriteria() { return many; }, async extractionsRead() { return new Set(); } },
      documents: { async roster() { return [{ id: 'doc', subjectKey: 'person', chars: 1 }]; }, async runtimeRead() { reads += 1; throw new Error('Must not read'); } },
      extractor: { async extract() { throw new Error('Must not spend'); } }, async writeFacts() { throw new Error('Must not write'); } });
    await assert.rejects(() => run({ job: { id: 'changed', studyId: study.id, scenario }, async onProgress() {} }), { code: 'vcr_extract_replan_required' });
    assert.equal(reads, 0);
  }
});

test('a record that grows beyond its roster length cannot exceed the frozen model-input ceiling', async () => {
  const selectedCriteria = [criterion('one', 'A finding')];
  const matchStore = { async latestProtocol() { return { id: 'v1' }; }, async listCriteria() { return selectedCriteria; }, async extractionsRead() { return new Set(); },
    async recordExtraction() { throw new Error('Incomplete record must not be marked done'); } };
  const documents = { async roster() { return [{ id: 'doc', subjectKey: 'person', chars: 1 }]; }, async runtimeRead() { return { text: 'x'.repeat(1000) }; } };
  const built = await planBatch({ study, matchStore, documents, config: {} });
  let calls = 0;
  const run = createMatchExtractExecutor({ store: { async studyById() { return study; }, async one() { return null; } }, matchStore, documents,
    extractor: { async extract() { calls += 1; throw new Error('Must not spend beyond ceiling'); } }, async writeFacts() { throw new Error('Must not write'); } });
  const result = await run({ job: { id: 'grown', studyId: study.id, scenario: extractScenario(built) }, async onProgress() {} });
  assert.equal(calls, 0);
  assert.equal(result.diagnostics.failures.vcr_extract_replan_required, 1);
});

test('batch interval denials reach the real fact writer and evaluator with their source-bound scope', async () => {
  const selectedCriteria = [{ id: 'recent', kind: 'inclusion', sourceText: 'No event in the past six months', requirement: { op: 'absent', variable: 'event_history', window: { months: 6 } } }];
  for (const [quote, interval, expected, kept] of [
    ['From 2026-05-01 through 2026-11-01: no event.', { start: '2026-05-01', end: '2026-11-01' }, 'eligible', 1],
    ['From 2026-10-01 through 2026-11-01: no event.', { start: '2026-10-01', end: '2026-11-01' }, 'insufficient_evidence', 1],
    ['2026-11-01: no event today.', null, 'insufficient_evidence', 1],
    ['2026-11-01: no event today.', { start: '2026-05-01', end: '2026-11-01' }, 'insufficient_evidence', 0],
  ]) {
    const saved = [];
    const matchStore = { async latestProtocol() { return { id: 'v1' }; }, async listCriteria() { return selectedCriteria; }, async extractionsRead() { return new Set(); },
      async recordExtraction() {}, async matchingFactsByIds() { return []; }, async saveFact({ fact }) { saved.push(fact); return { id: `fact_${saved.length}` }; } };
    const documents = { async roster() { return [{ id: 'doc', subjectKey: 'person', chars: quote.length }]; },
      async runtimeRead() { return { id: 'doc', subjectKey: 'person', text: quote, visibleAt: '2026-11-01T00:00:00Z' }; } };
    const extractor = createFactExtractor({ config: {}, async callModel(_deps, call) {
      assert.match(call.body.messages[0].content, /occurredInterval/);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ facts: [{ variable: 'event_history', polarity: 'negated', surface: 'no event', quote,
        clinical: { schema: 1, assertion: 'negated', experiencer: 'patient', ...(interval ? { occurredInterval: interval } : {}) } }] }) } }] };
    } });
    const run = createMatchExtractExecutor({ store: { async studyById() { return study; }, async one() { return null; } }, matchStore, documents, extractor,
      writeFacts: ({ study: current, items, documents: held, caller }) => vcrRuntimeWrite({ store: {}, service: null, orchestrator: null, study: current, what: 'fact', items, data: null, matchStore, documents: held, caller }) });
    const built = await planBatch({ study, matchStore, documents, config: {}, selection: { asOf: '2026-11-01' } });
    await run({ job: { id: 'interval', studyId: study.id, scenario: extractScenario(built) }, async onProgress() {} });
    assert.equal(saved.length, kept, quote);
    const assessment = assessSubject({ asOf: '2026-11-01', criteria: selectedCriteria, facts: saved, documents: { doc: { text: quote } } });
    assert.equal(assessment.summary, expected, quote);
  }
});
