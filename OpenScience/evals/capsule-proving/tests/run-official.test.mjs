import test from 'node:test';
import assert from 'node:assert/strict';
import { officialPrompt, officialYes, OFFICIAL, rubricFacts } from '../run/officialJudge.mjs';
import { buildJudgePacket, judgePackets, mergeJudgeResults } from '../run/judgePackets.mjs';
import { parseArgs } from '../run/score.mjs';

test('official templates cover every upstream type, abstention overrides type, interpolation is literal', () => {
  assert.match(OFFICIAL.commit, /^[a-f0-9]{40}$/);
  assert.match(OFFICIAL.sha256, /^[a-f0-9]{64}$/);
  for (const type of ['single-session-user', 'single-session-assistant', 'multi-session', 'temporal-reasoning', 'knowledge-update', 'single-session-preference']) {
    const prompt = officialPrompt({ question_type: type, question_id: 'fixture', question: '{}', answer: 'answer' }, 'reply');
    assert.ok(prompt.includes('Question: {}\n\n'));
    assert.ok(prompt.endsWith('Answer yes or no only.'));
    if (type === 'temporal-reasoning') assert.ok(prompt.includes('19 days when the answer is 18'));
    if (type === 'knowledge-update') assert.ok(prompt.includes('previous information along with an updated answer'));
    if (type === 'single-session-preference') assert.ok(prompt.includes('does not need to reflect all the points'));
  }
  assert.ok(officialPrompt({ question_type: 'unknown', question_id: 'fixture_abs_suffix', question: 'q', answer: 'a' }, 'r').includes('unanswerable question'));
  assert.equal(officialYes(' YES. '), true);
  assert.equal(officialYes('not yes'), true);
  assert.equal(officialYes('No.'), false);
  assert.equal(rubricFacts('official', 'qwen3.8-max').answerJudgeSameFamily, true);
  assert.equal(parseArgs(['--run', 'r', '--data', 'd', '--rubric', 'official']).rubric, 'official');
});

test('official judge uses individual verbatim user prompts and hash-bound checkpoints; pending stays unknown', async () => {
  const row = { runId: 'fixture', set: 'longmemeval-s', split: 'dev', caseId: 'c', kind: 'answer', id: 'q', verdict: 'needs-judge', checks: [] };
  const context = { gold: { question_id: 'q', question_type: 'multi-session', question: 'Q', answer: 'A' }, answer: { answer: 'R' }, official: OFFICIAL.commit };
  const packet = buildJudgePacket(row, context), requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return { ok: true, headers: new Headers(), json: async () => ({ model: 'qwen3.8-max', choices: [{ message: { content: 'Yes' } }], usage: {} }) };
  };
  assert.equal(mergeJudgeResults([row], [packet], [])[0].verdict, 'unknown');
  const results = await judgePackets([packet], { key: 'fake-private-key', fetchImpl });
  assert.deepEqual(requests[0].messages, [{ role: 'user', content: officialPrompt(context.gold, 'R') }]);
  assert.equal(requests[0].max_tokens, 10);
  assert.equal(requests[0].response_format, undefined);
  assert.equal(mergeJudgeResults([row], [packet], results)[0].verdict, 'pass');
  assert.notEqual(buildJudgePacket(row, { ...context, official: 'changed' }).hash, packet.hash);
});
