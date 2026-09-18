// The frame kit's readers and its in-frame channel.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHub, formatDuration, parseToolText, partialArgField, toolCallState, validFrame, verdictOf,
} from '../src/runtimeUiKit.mjs';

// Verbatim from a production transcript, 2026-09-16 (project
// eval-memory-ablation-v7-545d9b64) — the same samples the control plane's
// `socketToolResult` is held to. A reader written against `{ ok, data }` JSON
// passed its tests and found nothing on a live run; these are the wire.
const LIVE_OK = 'ok\n{\n  "verdicts": [\n    {\n      "claimId": "CLM-095",\n      "verdict": "stands",\n      "grounds": "placeholder"\n    }\n  ],\n  "blocking": false\n}';
const LIVE_FAILED = 'failed: specialist_evidence_traceability_failed\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S01 is not cited by the report.\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S02 is not cited by the report.';
const LIVE_DELEGATE_HEAD = 'ok\n{\n  "deliverableId": "mimic-sepsis-prognosis-scoping",\n  "childSessionId": "8765be77-2ac4-4655-bd9a-7c16c266a70e",\n  "report": {\n    "deliverableId": "mimic-sepsis-prognosis-scoping",\n    "submitted": true\n  }\n}';

test('a socket tool result is read in the form the kernel records it', () => {
  assert.deepEqual(parseToolText(LIVE_OK), { ok: true, data: { verdicts: [{ claimId: 'CLM-095', verdict: 'stands', grounds: 'placeholder' }], blocking: false } });
  assert.equal(/** @type {any} */ (parseToolText(LIVE_DELEGATE_HEAD))?.data.childSessionId, '8765be77-2ac4-4655-bd9a-7c16c266a70e');
  assert.deepEqual(parseToolText(LIVE_FAILED), {
    ok: false,
    code: 'specialist_evidence_traceability_failed',
    issues: [
      { severity: 'required', code: 'specialist_evidence_traceability_failed', message: 'Evidence matrix claim CLM-S01 is not cited by the report.' },
      { severity: 'required', code: 'specialist_evidence_traceability_failed', message: 'Evidence matrix claim CLM-S02 is not cited by the report.' },
    ],
  });
  // What is not a socket result reads as nothing, never as a guess.
  assert.deepEqual(parseToolText('{"ok":true,"data":{"childSessionId":"c1"}}'), { ok: true, data: { childSessionId: 'c1' } });
  assert.equal(parseToolText('{"status":"success","data":{}}'), null);
  assert.equal(parseToolText('okay then'), null);
  assert.equal(parseToolText(undefined), null);
  assert.deepEqual(parseToolText('ok'), { ok: true, data: null });
});

test('a call is read the same way whether it is still streaming or settled', () => {
  const running = toolCallState({ callId: 'c1', name: 'evimed_delegate', argsRaw: '{"deliverableId":"clinical-ev', turn: 1, step: 1, time: 1000, subCalls: [] });
  assert.equal(running.running, true);
  assert.equal(running.args, null, 'a prefix of an object is not the object');
  assert.equal(running.startedAt, 1000);
  assert.equal(partialArgField(running.argsRaw, 'deliverableId'), null, 'an unterminated string is not a value yet');
  assert.equal(partialArgField('{"deliverableId":"clinical-evidence","brief":"…', 'deliverableId'), 'clinical-evidence');
  assert.equal(partialArgField('{"title":"70 岁以上\\"阿司匹林\\""', 'title'), '70 岁以上"阿司匹林"');

  const settled = toolCallState({ kind: 'tool-result', seq: 9, time: 5000, callId: 'c1', call: { name: 'evimed_delegate', argsRaw: '{"deliverableId":"clinical-evidence"}' },
    callTime: 1000, content: [{ type: 'text', text: LIVE_DELEGATE_HEAD }], isError: false, subCalls: [] });
  assert.equal(settled.settled, true);
  assert.deepEqual(settled.args, { deliverableId: 'clinical-evidence' });
  assert.equal(/** @type {any} */ (settled.result)?.data.childSessionId, '8765be77-2ac4-4655-bd9a-7c16c266a70e');
  assert.equal(settled.startedAt, 1000);
  assert.equal(settled.settledAt, 5000);

  const cut = toolCallState({ kind: 'tool-result', seq: 9, time: 5000, callId: 'c1', call: null, callTime: null, content: [], isError: true, error: { name: 'Error', code: 'interrupted' }, subCalls: [] });
  assert.equal(cut.args, null);
  assert.equal(cut.stopped, true);
  assert.equal(cut.startedAt, null);
});

test('a verdict reaches the reader as three words, never as the validator text', () => {
  assert.deepEqual(verdictOf(parseToolText('ok\n{"deliverableId":"d1","notices":["a","b"]}')), { verdict: 'pass', mustFix: 0, advice: 2 });
  assert.deepEqual(verdictOf(parseToolText(LIVE_FAILED)), { verdict: 'issues', mustFix: 2, advice: 0 });
  // A refusal that names nothing the run must fix is not "N items to check":
  // it is a package nobody verified.
  assert.deepEqual(verdictOf(parseToolText('failed: deliverable_rejected\n- (advisory) citation_style 参考文献格式可以统一。')), { verdict: 'unverified', mustFix: 0, advice: 1 });
  assert.deepEqual(verdictOf(null), { verdict: 'unverified', mustFix: 0, advice: 0 });
});

test('durations read the way the product writes them', () => {
  assert.equal(formatDuration(45_000), '45 秒');
  assert.equal(formatDuration(192_000), '3 分 12 秒');
  assert.equal(formatDuration(3_900_000), '1 小时 05 分');
  assert.equal(formatDuration(-5), '0 秒');
});

test('the bootstrap object is validated field by field', () => {
  assert.equal(validFrame(null), null);
  assert.equal(validFrame({ version: 2 }), null);
  const frame = validFrame({
    version: 1, frameId: 'f', projectId: 'p', shellOrigin: 'https://app.example', operator: 'yes', off: ['theme', 'BAD NAME', 3],
    capabilities: [
      { id: 'meta-analysis', title: '自动化 Meta 分析', category: '证据综合', brief: 'b', summary: '一句话', minutes: [30, 120] },
      { id: 'source-understanding', title: '资料理解', category: '内部', brief: 'b', visibility: 'internal' },
      { id: 'broken', title: '', category: '', brief: '' },
      { id: 'minutes-wrong', title: 'x', category: 'y', brief: 'b', minutes: [0, 'a'] },
    ],
  });
  assert.equal(frame.operator, false, 'only a literal true is the operator flag');
  assert.deepEqual(frame.off, ['theme']);
  assert.deepEqual(frame.capabilities.map((/** @type {any} */ entry) => entry.id), ['meta-analysis', 'source-understanding', 'minutes-wrong']);
  assert.deepEqual(frame.capabilities[0].minutes, [30, 120]);
  assert.equal(frame.capabilities[1].internal, true);
  assert.equal(frame.capabilities[2].minutes, null);
});

test('the hub carries state to subscribers and settles one request by its id', async () => {
  const hub = createHub({ setTimeout, clearTimeout });
  assert.equal(hub.send('open-artifact', {}), false, 'with no bridge attached nothing is sent');
  await assert.rejects(hub.request('kb-query', { query: 'x' }), /unavailable/);

  /** @type {any[]} */
  const sent = [];
  const detach = hub.attach((type, fields) => sent.push({ type, fields }));
  let notified = 0;
  const unsubscribe = hub.subscribe(() => { notified++; });
  hub.deliver('theme', { preference: 'dark', resolved: 'dark' });
  assert.deepEqual(hub.getState().theme, { preference: 'dark', resolved: 'dark' });
  assert.equal(notified, 1);
  unsubscribe();

  const answer = hub.request('kb-query', { query: '阿司匹林' });
  assert.equal(sent.at(-1).type, 'kb-query');
  const requestId = sent.at(-1).fields.requestId;
  assert.match(requestId, /^[A-Za-z0-9_-]{1,64}$/);
  hub.deliver('kb-result', { requestId: 'someone-else', items: [] });
  hub.deliver('kb-result', { requestId, items: [{ id: 'src_1', title: 'ASPREE' }] });
  assert.deepEqual((await answer).items, [{ id: 'src_1', title: 'ASPREE' }]);

  const late = hub.request('kb-query', { query: 'y' }, 10);
  await assert.rejects(late, /timed out/);
  const pending = hub.request('kb-query', { query: 'z' });
  detach();
  await assert.rejects(pending, /closed/);
  assert.equal(hub.send('open-artifact', {}), false);
});
