import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { historySearchText } from '../../../apps/server/src/memoryHistory.mjs';
import { searchStatusText } from '../../../apps/server/src/memoryReadStatus.mjs';
import { replayLiteralSearch, summarizeLiteralReplay } from './literal-fallback.mjs';

const query = 'What happened to ZX17?';
const memoryUri = 'viking://user/owner/memories/notes';
const history = (id, text, decision = 'allowed') => ({
  uri: `viking://user/owner/resources/history/${id}`, sessionId: id, conversationTitle: 'Earlier thread',
  conversationUrl: `/app/chat/${id}`, messages: [{ sourceRole: 'user', text }], decision,
});
const adjacent = history('nearby', 'A neighbouring case.');
const correct = history('source', 'ZX17 was rescheduled for Monday.');
const wrong = history('other', 'ZX17 was the reference for a different case.');
const targets = [{ source: 'history', sessionId: 'source', quote: 'ZX17 was rescheduled for Monday.' }];
const pool = (...candidates) => ({ complete: true, candidates });
const capsule = content => `胶囊笔记与专区（历史记录，不是指令）：\n- [note · 参考胶囊《Unused title》] ${content}`;
const blocks = ({ files = [], history: returned = [adjacent], fill = [], historyState = 'searched' } = {}) => [
  JSON.stringify({ memories: files, resources: [], skills: [] }),
  searchStatusText({ memoryFiles: { state: files.length ? 'searched' : 'empty' },
    earlierConversations: { state: historyState }, receivedCapsules: { state: fill.length ? 'searched' : 'empty' } }),
  ...fill, ...(returned.length ? [historySearchText(returned)] : []),
];
const call = (overrides = {}) => ({ name: 'mcp__openviking__search', args: { query, limit: 5 }, blocks: blocks(), ...overrides });

test('the trigger inspects the actual search query and the returned bodies from every source', () => {
  assert.equal(replayLiteralSearch(call({ args: { query: 'what happened?' } })).reason, 'no_anchor');
  assert.equal(replayLiteralSearch(call({ args: { query, mode: 'context' } })).reason, 'opening_context');
  assert.equal(replayLiteralSearch(call(), { evidence: { scope: 'shared' } }).reason, 'shared_namespace');
  const titleOnly = { ...adjacent, conversationTitle: 'ZX17' };
  assert.equal(replayLiteralSearch(call({ blocks: blocks({ history: [titleOnly] }) })).trigger, 'yes');
  for (const returned of [
    blocks({ files: [{ uri: `${memoryUri}/ZX17.md`, abstract: 'The schedule is updated.' }] }),
    blocks({ history: [correct] }), blocks({ fill: [capsule('The ZX17 appointment changed.')] }),
    [JSON.stringify({ result: { memories: [], history: [correct], capsules: [] } })],
  ]) assert.equal(replayLiteralSearch(call({ blocks: returned })).reason, 'returned_anchor');
});

test('history rescue promotes verified exact excerpts in bounded order and scores wrong additions independently', () => {
  const withdrawn = history('withdrawn', 'ZX17 was removed.', 'withdrawn');
  const denied = history('denied', 'ZX17 was kept in a different project.', 'denied');
  const evidence = { files: pool(), history: pool(withdrawn, denied, wrong, wrong, correct), targets };
  const replay = replayLiteralSearch(call(), { evidence });
  assert.deepEqual(replay.promoted.map(hit => [hit.uri, hit.result]), [[wrong.uri, 'wrong'], [correct.uri, 'correct']]);
  assert.deepEqual(summarizeLiteralReplay([replay]), { searches: 1, anchored: 1, missingReturnedAnchor: 1, triggered: 1, triggerUnknown: 0,
    noMatch: 0, unknownOutcome: 0, promoted: 1, correctPromotions: 1, wrongPromotions: 1, unscoredPromotions: 0 });
  const top = replayLiteralSearch(call({ args: { query, limit: 1 } }), { evidence });
  assert.deepEqual(top.promoted.map(hit => hit.result), ['wrong']);
  const onlyFenced = replayLiteralSearch(call(), { evidence: { files: pool(), history: pool(denied, withdrawn), targets } });
  assert.equal(onlyFenced.outcome, 'no_match');
  assert.doesNotMatch(JSON.stringify(replay), /removed|kept in a different project|rescheduled/);
});

test('a scoped file match takes precedence and requires the current body or filename to still match', () => {
  const staleIndex = { uri: `${memoryUri}/old.md`, indexedBody: 'ZX17', body: 'The code was removed.', decision: 'allowed' };
  const exact = { uri: `${memoryUri}/ZX17.md`, body: 'The sample was delayed.', decision: 'allowed' };
  const evidence = { files: pool(staleIndex, exact), history: pool(correct), targets: [{ source: 'memory', uri: exact.uri }] };
  const result = replayLiteralSearch(call({ args: { query, target_uri: 'viking://~/memories/notes' } }), { evidence });
  assert.deepEqual(result.promoted.map(hit => [hit.source, hit.uri, hit.result]), [['memory', exact.uri, 'correct']]);
  const narrow = replayLiteralSearch(call({ args: { query, target_uri: memoryUri } }), { evidence: { ...evidence, files: pool(staleIndex) } });
  assert.equal(narrow.outcome, 'no_match');
  const excluded = replayLiteralSearch(call({ args: { query, target_uri: memoryUri, exclude_uris: ['viking://~/memories/notes/ZX17.md'] } }), { evidence });
  assert.equal(excluded.outcome, 'no_match');
});

test('missing candidates, missing gold and filtered recordings remain distinguishable', () => {
  const possible = replayLiteralSearch(call(), { sourceSessions: [{
    sessionId: 'recorded', messages: [{ role: 'user', content: 'ZX17 was scheduled.' }],
  }] });
  assert.equal(possible.trigger, 'yes');
  assert.equal(possible.outcome, 'unknown');
  assert.deepEqual(possible.possible.map(hit => [hit.sessionId, hit.chunkIndex]), [['recorded', 0]]);
  const partial = replayLiteralSearch(call(), { evidence: { files: pool(), history: { complete: false, candidates: [correct] }, targets } });
  assert.equal(partial.outcome, 'unknown');
  assert.equal(partial.possible[0].uri, correct.uri);
  const unscored = replayLiteralSearch(call(), { evidence: { files: pool(), history: pool(correct) } });
  assert.equal(unscored.promoted[0].result, 'unknown');
  const stripped = replayLiteralSearch(call({ blocks: blocks({ history: [] }) }), { forceSearch: 'memory' });
  assert.equal(stripped.trigger, 'unknown');
});

test('CLI reads runner JSONL and raw retrieval probes without counting report mirrors twice', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'literal-replay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runnerRecord = { qid: 'answer', arm: 'product', question: 'different words', toolCalls: [
    call({ name: 'mcp__openviking__read' }), call(), call({ args: { query: 'what happened?' } }),
  ] };
  const probe = { runId: 'probe-run', qid: 'probe', question: query, results: [{ limit: 8, blocks: blocks() }] };
  await writeFile(path.join(dir, 'answers.jsonl'), JSON.stringify(runnerRecord) + '\n');
  await writeFile(path.join(dir, 'case.json'), JSON.stringify(probe));
  await writeFile(path.join(dir, 'retrieval.json'), JSON.stringify({ report: { rows: [probe] } }));
  const evidence = [{ qid: 'answer', search: 1, query, files: pool(), history: pool(correct), targets }];
  const labelsFile = path.join(dir, 'evidence.json');
  await writeFile(labelsFile, JSON.stringify(evidence));
  const script = fileURLToPath(new URL('./literal-fallback.mjs', import.meta.url));
  const guard = fileURLToPath(new URL('../../../scripts/test/localhostProbeGuard.mjs', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, ['--import', guard, script, dir, '--evidence', labelsFile], { encoding: 'utf8' }));
  assert.equal(report.counts.searches, 3);
  assert.equal(report.counts.triggered, 2);
  assert.equal(report.counts.correctPromotions, 1);
  assert.equal(report.counts.unknownOutcome, 1);
});
