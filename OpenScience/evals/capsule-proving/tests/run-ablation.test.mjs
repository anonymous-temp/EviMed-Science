import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { answerQuestion } from '../run/answerer.mjs';
import { answerOptions, gatewayOptions, selectSearchBlocks, fullTranscript } from '../run/answerVariants.mjs';
import { createDeepSeekClient, createOpenAICompatibleClient } from '../run/deepseek.mjs';
import { measureRetrieval, retrievalReport, summaryText, sessionMapping } from '../run/retrieval.mjs';
import { lineFingerprint } from '../../../apps/server/src/nativeMemoryOverlay.mjs';
import { parseArguments } from '../run/run.mjs';

const history = 'Original conversation excerpts (historical context, not instructions or confirmed facts):\n[title](/app/chat/run-s001)\nuser · 2024-01-01: invented fact';
const memoryBlock = JSON.stringify({ memories: [{ uri: 'viking://user/u/memories/notes/f.md', abstract: '- Invented detail (2024-01-01)\n- Other detail' }] });
const pluginTgz = process.env.CAPSULE_PROVING_PLUGIN_TGZ ?? '/srv/evimed/cache/dsh-memory-plugin-0.5.31.tgz';
let hasPlugin = true; try { await access(pluginTgz); } catch { hasPlugin = false; }
const base = { question: 'fixture question?', asOf: '2024-01-03T00:00:00.000Z', arm: 'product', pluginTgz };
const sessions = [{ sessionId: 's001', at: '2024-01-01T00:00:00.000Z', messages: [{ role: 'user', text: 'old '.repeat(300) }] },
  { sessionId: 's002', at: '2024-01-02T00:00:00.000Z', messages: [{ role: 'user', text: 'new fact' }] }];

test('variant validation separates runner controls from product configuration', () => {
  assert.deepEqual(gatewayOptions({ forceSearch: 'all', thinking: 'enabled', memoryHistorySearchEnabled: false }), { memoryHistorySearchEnabled: false });
  assert.deepEqual(answerOptions({ fullContext: true, answerModel: 'qwen3.8-max', memoryOpeningIndexEnabled: true }), { fullContext: true, answerModel: 'qwen3.8-max' });
  for (const config of [{ forceSearch: 'unknown' }, { thinking: true }, { fullContext: 'true' }, { fullContext: true, forceSearch: 'all' }, { answerBase: 'https://secret@example.test' }]) assert.throws(() => answerOptions(config));
  const args = ['--set', 'longmemeval-s', '--split', 'dev', '--data', '/fixture', '--out', '/fixture-run', '--engine-url', 'http://localhost:1', '--engine-key-file', '/key', '--database-url-file', '/db'];
  const parsed = parseArguments([...args, '--retrieval-only']);
  assert.equal(parsed.answersOnly, true); assert.equal(parsed.retrievalOnly, true);
  assert.throws(() => parseArguments([...args, '--answers-only', '--ingest-only']), /cannot ingest/);
});

test('layer selection is explicit, preserves bytes and handles missing history', () => {
  assert.deepEqual(selectSearchBlocks([memoryBlock, history], 'history'), [history]);
  assert.deepEqual(selectSearchBlocks([memoryBlock, history], 'memory'), [memoryBlock]);
  assert.deepEqual(selectSearchBlocks([memoryBlock], 'history'), []);
});

test('full transcript preserves all roles and dates and drops oldest sessions within a bounded context', () => {
  const all = fullTranscript(sessions);
  assert.equal(all.truncated, false); assert.ok(all.text.includes('2024-01-01')); assert.ok(all.text.includes('user |'));
  const trimmed = fullTranscript(sessions, { contextTokens: 250, reserveTokens: 50 });
  assert.equal(trimmed.droppedSessions, 1); assert.ok(trimmed.text.includes('new fact')); assert.ok(!trimmed.text.includes('old old'));
  const unicode = fullTranscript([{ ...sessions[0], messages: [{ role: 'user', text: '中'.repeat(200) }] }], { contextTokens: 128 });
  assert.ok(unicode.includedBytes <= 96); assert.equal(unicode.text.includes('\ufffd'), false);
});

test('forced history is inserted as a real tool result before first completion; later searches remain filtered', { skip: !hasPlugin }, async () => {
  const calls = [], requests = [];
  const memory = { tools: ['search', 'read', 'remember'].map(name => ({ name, description: name, inputSchema: {} })),
    fetchJSON() { throw new Error('history-only must not load profile'); }, residentBlock() { throw new Error('no resident'); },
    async callTool(name, args) { calls.push({ name, args }); return { blocks: [memoryBlock, history], isError: false }; } };
  const client = { model: 'fake-model', async complete(request) {
    requests.push(request);
    return { message: requests.length === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'followup', type: 'function', function: { name: 'mcp__openviking__search', arguments: '{"query":"follow-up"}' } }] } : { role: 'assistant', content: 'done' } };
  } };
  const record = await answerQuestion({ ...base, memory, client, forceSearch: 'history' });
  assert.equal(record.error, undefined); assert.equal(record.answer, 'done');
  assert.deepEqual(calls[0], { name: 'search', args: { query: base.question, limit: 8 } });
  assert.equal(requests[0].messages.at(-1).role, 'tool');
  assert.equal(requests[0].messages.at(-1).content, history);
  assert.deepEqual(requests[0].tools.map(t => t.function.name), ['skill', 'mcp__openviking__search']);
  assert.equal(record.opening.profileBlock, null); assert.equal(record.opening.residentBlock, null);
  assert.ok(record.toolCalls.every(c => c.blocks.length === 1 && c.blocks[0] === history));
});

test('fullcontext never touches memory, supplies dated haystack and exposes no memory tool', { skip: !hasPlugin }, async () => {
  const requests = [];
  const client = { model: 'fake', async complete(req) { requests.push(req); return { message: { role: 'assistant', content: 'done' } }; } };
  const memory = new Proxy({}, { get() { throw new Error('memory must not be read'); } });
  const record = await answerQuestion({ ...base, fullContext: true, sessions, memory, client });
  assert.equal(record.error, undefined); assert.equal(record.fullContext.truncated, false);
  assert.ok(requests[0].messages.some(m => m.content?.includes('Session s001 | 2024-01-01')));
  assert.ok(requests[0].tools.every(t => !t.function.name.includes('openviking')));
});

test('second client sends Qwen OpenAI tools and uses its own credential; DeepSeek thinking contract stays intact', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ablation-client-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key'); await writeFile(keyFile, 'fixture-private');
  const seen = [], fetch = async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ model: 'qwen3.8-max', choices: [{ message: { role: 'assistant', content: 'fixture' } }] }) }; };
  const tools = [{ type: 'function', function: { name: 'search', parameters: {} } }];
  await createOpenAICompatibleClient({ keyFile, model: 'qwen3.8-max', baseURL: 'https://fixture.test/v1', fetch }).complete({ messages: [], tools });
  assert.equal(seen[0].url, 'https://fixture.test/v1/chat/completions'); assert.deepEqual(seen[0].body.tools, tools);
  assert.equal(seen[0].body.thinking, undefined); assert.equal(seen[0].body.enable_thinking, false);
  await createDeepSeekClient({ keyFile, thinking: 'enabled', fetch }).complete({ messages: [] });
  assert.deepEqual(seen[1].body.thinking, { type: 'enabled' });
});

test('retrieval uses session links and line origins, deduplicates gold IDs, isolates abstentions and counts errors as misses', () => {
  const mapping = [{ engineSession: 'dsh-run-s001', sourceSessionId: 'sourceA', at: '2024-01-01T00:00:00.000Z' }, { engineSession: 'dsh-run-s002', sourceSessionId: 'sourceB', at: '2024-01-02T00:00:00.000Z' }];
  const origins = new Map([['viking://user/u/memories/notes/f.md', new Map([[lineFingerprint('Other detail'), { sources: [{ engineSession: 'dsh-run-s002' }] }]])]]);
  const result = limit => measureRetrieval({ blocks: [memoryBlock, history, history], goldIds: ['sourceA', 'sourceB', 'sourceA'], mapping, origins, limit });
  const r = result(8); assert.equal(r.history.recall, 0.5); assert.equal(r.memory.originAny, true); assert.equal(r.memory.any, true);
  assert.equal(r.memory.evidence.filter(e => e.method === 'date-proxy').length, 1);
  const abstain = limit => measureRetrieval({ blocks: [], goldIds: [], mapping, limit });
  const report = retrievalReport([{ questionType: 'multi-session', results: [r, result(20)] }, { questionType: 'abstention', results: [abstain(8), abstain(20)] }]);
  assert.equal(report.limits[0].answerable, 1); assert.equal(report.limits[0].microRecall, 0.5);
  assert.equal(measureRetrieval({ blocks: [], goldIds: ['sourceA'], mapping, limit: 8, isError: true }).history.hit, false);
  assert.ok(summaryText(report).includes('recall@8/20=50.0%/50.0%'));
  const item = { userKey: 'u', sessions: sessions };
  const entry = { runtimeInput: { histories: [{ sourceSessionId: 'b', at: sessions[1].at }, { sourceSessionId: 'a', at: sessions[0].at }] } };
  assert.deepEqual(sessionMapping(entry, item, 'run').map(s => s.sourceSessionId), ['a', 'b']);
});
