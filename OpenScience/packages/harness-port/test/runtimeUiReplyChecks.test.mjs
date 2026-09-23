// The reply check (L1) as a row under the one answer it is about; every other
// assistant step drawn by the kernel as before.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, BODY, replyCheckFor, replyCheckSummary } from '../src/runtimeUiReplyChecks.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, realReact, renderStatic } from './helpers/frameFakes.mjs';

/** A kernel whose assistant step is a real component, so the pass-through can be seen. */
function kernel() {
  const slots = kernelSlots();
  const { React } = realReact();
  const KernelAssistantStep = (/** @type {any} */ props) => React.createElement('div', { 'data-kernel-assistant': props.node.data.finalNode?.seq ?? 'streaming' }, 'answer');
  const shipped = /** @type {any} */ (slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.key === 'assistant-step'));
  shipped.component = KernelAssistantStep;
  return slots;
}

const check = {
  turnSeq: 12, status: 'done',
  verdicts: [
    { sentence: '二甲双胍可使 HbA1c 降低约 1% [1]。', verdict: 'supported', reason: '一致', safety: 'none', source: { number: 1, title: 'Metformin trial', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' } },
    { sentence: '华法林与布洛芬合用无妨 [2]。', verdict: 'unsupported', reason: '来源说增加出血', safety: 'contradicted', source: { number: 2, title: 'Warfarin', url: 'javascript:alert(1)' } },
    { sentence: '另一句 [3]。', verdict: 'uncertain', reason: '', safety: 'none', source: null },
  ],
  cautions: [{ title: '华法林：出血风险', message: '合用 NSAID 增加出血。' }],
};

test('a check belongs to the answer whose closing message it was read from', () => {
  const state = { sessionId: 's1', checks: [check] };
  assert.equal(replyCheckFor(state, { data: { finalNode: { seq: 12 } } }), check);
  assert.equal(replyCheckFor(state, { data: { finalNode: { seq: 11 } } }), null);
  assert.equal(replyCheckFor(state, { data: {} }), null, 'a streaming step has no final message yet');
  assert.equal(replyCheckFor(null, { data: { finalNode: { seq: 12 } } }), null);
});

test('the row says what was found, and a link is kept only when it is https', () => {
  const model = replyCheckSummary(check);
  assert.equal(model.tone, 'warn');
  assert.equal(model.text, '依据核对 ✓ 1 · ⚠ 1 · 其他 1 · 用药提示 1 条');
  assert.deepEqual(model.items.map((item) => item.mark), ['✓', '⚠', '·']);
  assert.match(model.items[1].reason, /来源不支持（用药说法与来源相反）：来源说增加出血/);
  assert.equal(model.items[0].url, 'https://pubmed.ncbi.nlm.nih.gov/1/');
  assert.equal(model.items[1].url, '', 'never a script link');
  assert.equal(replyCheckSummary({ status: 'running' }).text, '依据核对中…');
  assert.equal(replyCheckSummary({ status: 'failed' }).text, '依据核对没有完成');
  assert.equal(replyCheckSummary({ status: 'done', verdicts: [], cautions: [] }).text, '', 'nothing to say draws nothing');
});

test('the checked answer gets its row after the kernel draws it; every other answer is the kernel\'s alone', () => {
  const ctx = fakeCtx({ slots: kernel() });
  const target = fakeTarget();
  const kit = kitFor(ctx, target);
  apply(ctx, {}, target, undefined, kit);
  const ours = ctx.slots.registrations.find((/** @type {any} */ entry) => entry.options.key === 'assistant-step' && entry.options.priority === -1);
  assert.ok(ours, 'taken over below the shipped entry');
  assert.equal(ours.options.locale, 'chat');
  kit.hub.deliver('reply-check', { sessionId: 's1', checks: [check] });
  const checked = renderStatic(ours.component, { node: { kind: 'assistant-step', data: { finalNode: { seq: 12 } } } });
  assert.match(checked, /^<div data-kernel-assistant="12">answer<\/div>/, 'the kernel draws the answer first, as it would without this body');
  assert.match(checked, /data-evimed-reply-check="warn"/);
  assert.match(checked, /依据核对 ✓ 1 · ⚠ 1/);
  const other = renderStatic(ours.component, { node: { kind: 'assistant-step', data: { finalNode: { seq: 30 } } } });
  assert.equal(other, '<div data-kernel-assistant="30">answer</div>');
  assert.deepEqual(target.warnings, []);
  assert.equal(BODY.name, 'reply-checks');
});

test('outside a frame nothing is taken over', () => {
  const ctx = fakeCtx({ slots: kernel() });
  const target = fakeTarget({ framed: false });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.options.priority === -1).length, 0);
});
