// The frame kit's readers and its in-frame channel.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFrameKit, createHub, parseToolText, partialArgField, toolCallState, validFrame,
} from '../src/runtimeUiKit.mjs';
import { FRAME_VOCABULARY } from '../src/runtimeUiFrame.mjs';
import { fakeCtx, fakeTarget, kernelSlots } from './helpers/frameFakes.mjs';

// Verbatim from a production transcript, 2026-09-16 (project
// eval-memory-ablation-v7-545d9b64) — the same samples the control plane's
// `socketToolResult` is held to. A reader written against `{ ok, data }` JSON
// passed its tests and found nothing on a live run; these are the wire.
const LIVE_OK = 'ok\n{\n  "verdicts": [\n    {\n      "claimId": "CLM-095",\n      "verdict": "stands",\n      "grounds": "placeholder"\n    }\n  ],\n  "blocking": false\n}';
const LIVE_FAILED = 'failed: specialist_evidence_traceability_failed\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S01 is not cited by the report.\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S02 is not cited by the report.';
const LIVE_DELEGATE_HEAD = 'ok\n{\n  "deliverableId": "mimic-sepsis-prognosis-scoping",\n  "childSessionId": "8765be77-2ac4-4655-bd9a-7c16c266a70e",\n  "report": {\n    "deliverableId": "mimic-sepsis-prognosis-scoping",\n    "submitted": true\n  }\n}';

// An accepted submission carrying its review's findings as issue lines after
// the data — production, 2026-09-22 (project review-ai-chronic-home). The data
// block is trimmed to three fields; the two issue lines are verbatim.
const LIVE_OK_WITH_REVIEW = "ok\n{\n  \"deliverableId\": \"ai-chronic-home-pharmacy-review\",\n  \"contractKind\": \"clinical-evidence-report\",\n  \"label\": \"临床证据综述\"\n}\n- (required) review_contradicted 结论 CLM-073 与独立审查者查到的证据相矛盾：同一实体(随机风险差的95%CI)在包内两处不能同真:报告结果节P47写\"风险差 7.3 个百分点(95%CI 2.9 至 11.7…;HR 4.40,95%CI 1.66 至 11.66)\",而报告摘要P9写\"新发心房颤动…9.6%(21例)与 2.3%(5例)\"所省略的同一区间;矩阵CLM-073 supportQuote 与报告P47一致,取 11.7。来源 PMID:41569211(摘要级)逐字为 \"risk difference: 7.3 percentage points; 95% CI: 2.9-11.7 percentage points; P = 0.001; HR: 4.40; 95% CI: 1.66-11.66\",即\"个百分点\"区间的上界是 11.\n- (advisory) review_weakened 结论 CLM-062 证据强度弱于结论写法：报告摘要P11与结论P183 + 矩阵CLM-062(synthesized, confidence=moderate)。其被引来源的原文只支持较窄的结论:PMID:42520248 摘要逐字为 \"No statistically significant pooled effects were observed for glycated hemoglobin, blood pressure, mortality, hospitalization, or readmission…\" 与 \"Certainty was low or very low for all 7 GRADE-assessed outcomes\",即该来源自身对七个结局的确定性均为低或极低,而包内的整体判定写为\"按 GRA";

test('an accepted result keeps the issue lines that follow its data', () => {
  const read = /** @type {any} */ (parseToolText(LIVE_OK_WITH_REVIEW));
  assert.equal(read.ok, true);
  assert.equal(read.data.deliverableId, 'ai-chronic-home-pharmacy-review', 'the data is the JSON, not the whole text as a string');
  assert.deepEqual(read.issues.map((/** @type {any} */ issue) => [issue.severity, issue.code]), [['required', 'review_contradicted'], ['advisory', 'review_weakened']]);
  assert.match(read.issues[0].message, /^结论 CLM-073 与独立审查者查到的证据相矛盾/);
});

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

test('a takeover draws the row it shadows: the next entry above its own, whichever bodies are on', () => {
  const ctx = fakeCtx({ slots: kernelSlots() });
  const kit = createFrameKit(ctx, fakeTarget(), undefined, FRAME_VOCABULARY);
  const slot = 'conversation.chat.node';
  function Checks() { return null; }
  function Files() { return null; }
  // Alone, below the kernel: the kernel's own row.
  kit.occupy({ slot, key: 'assistant-step', priority: -2 }, Files);
  assert.equal(kit.shadowed(slot, 'assistant-step', Files), 'shipped');
  // With a second takeover between them: that one, which draws the kernel's.
  kit.occupy({ slot, key: 'assistant-step', priority: -1 }, Checks);
  assert.equal(kit.shadowed(slot, 'assistant-step', Files), Checks);
  assert.equal(kit.shadowed(slot, 'assistant-step', Checks), 'shipped');
  // Another key's entries are not in the cell; an unregistered component shadows nothing.
  assert.equal(kit.shadowed(slot, 'context', Files), null);
  assert.equal(kit.shadowed(slot, 'assistant-step', () => null), null);
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
      { id: 'minutes-wrong', title: 'x', category: 'y', brief: 'b', minutes: [0, 'a'], listed: false },
    ],
  });
  assert.equal(frame.operator, false, 'only a literal true is the operator flag');
  assert.deepEqual(frame.off, ['theme']);
  assert.deepEqual(frame.capabilities.map((/** @type {any} */ entry) => entry.id), ['meta-analysis', 'source-understanding', 'minutes-wrong']);
  assert.deepEqual(frame.capabilities[0].minutes, [30, 120]);
  assert.equal(frame.capabilities[1].internal, true);
  assert.equal(frame.capabilities[2].minutes, null);
  // Only a literal false keeps a tool out of the lists; absent is listed.
  assert.deepEqual(frame.capabilities.map((/** @type {any} */ entry) => entry.listed), [true, true, false]);
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
