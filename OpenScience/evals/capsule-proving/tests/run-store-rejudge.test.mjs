import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildJudgePacket, memoryStoreJudgePacket, judgePackets, mergeJudgeResults, JUDGE_SYSTEM, STORE_JUDGE_SYSTEM, STORE_JUDGE_CLIENT_SHA256 } from '../run/judgePackets.mjs';
import { rejudgeStores } from '../run/rejudge-stores.mjs';

const row = runId => ({ runId, set: 'synthetic-users', split: 'dev', caseId: 'invented', id: 'store:choice', kind: 'store', category: 'preference_repeated',
  verdict: 'needs-judge', stored: false, expectedStored: true, checks: [{ name: 'stored-current', ok: false, detail: 'comparison tables' }] });
const packet = item => buildJudgePacket(item, { snapshot: { files: { 'preferences/self/format.md': '- Use tabular comparisons.' } },
  anchors: ['comparison tables'], rubric: ['Retain the user preference by meaning.'], transcriptEvidence: [{ role: 'user', text: 'Compare options in a table.' }] });

function fakeJudge(calls) {
  return async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    const input = JSON.parse(body.messages[1].content);
    return { ok: true, headers: new Headers(), json: async () => ({ model: 'qwen3.8-max', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ judgements:
      input.map(item => ({ id: item.id, verdict: 'correct', reason: 'The captured memory retains the requested tabular comparison preference.', failureStep: null })) }) } }] }) };
  };
}

test('explicit store review changes prompt identity, preserves evidence and does not grade an intentionally empty reply', async () => {
  const raw = row('before'), legacy = packet(raw), typed = memoryStoreJudgePacket(legacy);
  assert.equal(legacy.reply, '');
  assert.equal(typed.reply, '');
  assert.notEqual(typed.hash, legacy.hash);
  assert.notEqual(typed.judgeClientSha256, legacy.judgeClientSha256);
  assert.equal(typed.judgeClientSha256, STORE_JUDGE_CLIENT_SHA256);
  assert.equal(typed.rowKey, legacy.rowKey);
  assert.deepEqual(typed.memoryLines, legacy.memoryLines);
  assert.deepEqual(typed.transcriptEvidence, legacy.transcriptEvidence);
  assert.deepEqual(memoryStoreJudgePacket(typed), typed);
  const calls = [];
  const results = await judgePackets([typed], { key: 'synthetic-test-value', fetchImpl: fakeJudge(calls) });
  assert.equal(calls[0].messages[0].content, STORE_JUDGE_SYSTEM);
  assert.equal(mergeJudgeResults([raw], [typed], results)[0].stored, true, 'semantic retention can override a failed literal anchor');
  await judgePackets([legacy], { key: 'synthetic-test-value', fetchImpl: fakeJudge(calls) });
  assert.equal(calls[1].messages[0].content, JUDGE_SYSTEM, 'the existing evaluator remains the default');
});

test('the opt-in rubric cannot be silently applied to answer packets or mixed batches', async () => {
  const answer = packet(row('before'));
  answer.rowKey = JSON.stringify(['before', 'synthetic-users', 'dev', 'invented', 'answer', 'q']);
  assert.throws(() => memoryStoreJudgePacket(answer), /store_packet_required/);
  const legacy = packet(row('before'));
  await assert.rejects(judgePackets([legacy, memoryStoreJudgePacket(legacy)], { key: 'synthetic-test-value', fetchImpl: fakeJudge([]) }), /judge_mixed_task_rubrics/);
});

test('paired store review preserves both original score sets, denominators, and resumable model checkpoints', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'store-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = [];
  for (const id of ['before', 'after']) {
    const dir = path.join(root, id); runs.push(dir);
    await mkdir(path.join(dir, 'scores'), { recursive: true });
    await writeFile(path.join(dir, 'run.json'), JSON.stringify({ runId: id, split: 'dev' }));
    await writeFile(path.join(dir, 'scores/summary.json'), 'original scores stay intact');
    const other = { ...row(id), id: 'store:other', category: 'stable' };
    await writeFile(path.join(dir, 'scores/score-cache.json'), JSON.stringify({ rows: [row(id), other], packets: [packet(row(id)), packet(other)] }));
  }
  const keyFile = path.join(root, 'synthetic-key');
  await writeFile(keyFile, 'synthetic-test-value');
  const calls = [], options = { runs, out: path.join(root, 'review'), categories: ['preference_repeated'], keyFile, fetchImpl: fakeJudge(calls) };
  const result = await rejudgeStores(options);
  assert.deepEqual(result.map(item => item.storeRecall.n), [1, 1]);
  assert.deepEqual(result.map(item => item.storeRecall.pass), [1, 1]);
  assert.deepEqual(result.map(item => item.categories), [['preference_repeated'], ['preference_repeated']]);
  assert.ok(result.every(item => item.batchSize === 1), 'both frozen runs use the same one-packet request shape');
  for (const dir of runs) assert.equal(await readFile(path.join(dir, 'scores/summary.json'), 'utf8'), 'original scores stay intact');
  await rejudgeStores(options);
  assert.equal(calls.length, 2, 'a resumed review does not rejudge unchanged packets');
});
