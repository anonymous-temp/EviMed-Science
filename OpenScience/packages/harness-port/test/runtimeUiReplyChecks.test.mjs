// The reply check (L1) as a row under the one answer it is about — and only
// when the check found something; every other answer is the kernel's alone.
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
    { sentence: '二甲双胍可使 HbA1c 降低约 1% [1]。', verdict: 'supported', reason: '一致', evidence: 'HbA1c fell by 1.1%', safety: 'none', source: { number: 1, title: 'Metformin trial', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' } },
    { sentence: '华法林与布洛芬合用无妨 [2]。', verdict: 'unsupported', reason: '来源说增加出血', evidence: 'NSAIDs increased the risk of major bleeding', safety: 'contradicted', source: { number: 2, title: 'Warfarin', url: 'javascript:alert(1)' } },
    { sentence: '某药可用于儿童 [3]。', verdict: 'unresolvable', reason: '链接打不开', evidence: '', safety: 'none', source: { number: 3, title: 'Label', url: 'https://example.org/label' } },
    { sentence: '另一句 [4]。', verdict: 'uncertain', reason: '', safety: 'none', source: null },
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

test('only a problem is said: while checking, after a failed check and when everything checked out, nothing', () => {
  assert.equal(replyCheckSummary({ status: 'queued' }), null);
  assert.equal(replyCheckSummary({ status: 'running' }), null);
  assert.equal(replyCheckSummary({ status: 'failed', verdicts: check.verdicts }), null, 'a check that failed is silent');
  assert.equal(replyCheckSummary({ status: 'done', verdicts: [check.verdicts[0], check.verdicts[3]], cautions: [] }), null, 'supported and undecided sentences are no problem to report');
  assert.equal(replyCheckSummary({ status: 'done', verdicts: [], cautions: [] }), null);
  const model = /** @type {any} */ (replyCheckSummary(check));
  assert.equal(model.text, '⚠ 2 处引用待核对 · 用药提示 1 条');
  assert.deepEqual(model.items.map((/** @type {any} */ item) => item.sentence), ['华法林与布洛芬合用无妨 [2]。', '某药可用于儿童 [3]。']);
  assert.equal(model.items[0].reason, '来源不支持（用药说法与来源相反）：来源说增加出血');
  assert.equal(model.items[0].evidence, 'NSAIDs increased the risk of major bleeding', "the source's own words the verdict rests on");
  assert.equal(model.items[0].url, '', 'never a script link');
  assert.equal(model.items[1].url, 'https://example.org/label');
  // A pharmacist caution alone is still said.
  assert.equal(/** @type {any} */ (replyCheckSummary({ status: 'done', verdicts: [], cautions: check.cautions })).text, '⚠ 用药提示 1 条');
});

/** @param {any} [frameOptions] */
function frame(frameOptions) {
  const ctx = fakeCtx({ slots: kernel() });
  const target = fakeTarget(frameOptions);
  const kit = kitFor(ctx, target);
  apply(ctx, {}, target, undefined, kit);
  const ours = ctx.slots.registrations.find((/** @type {any} */ entry) => entry.options.key === 'assistant-step' && entry.options.priority === -1);
  return { ctx, target, kit, ours };
}

test('the answer with a problem gets one line after the kernel draws it; the mechanism is not explained', () => {
  const f = frame();
  assert.ok(f.ours, 'taken over below the shipped entry');
  assert.equal(f.ours.options.locale, 'chat');
  f.kit.hub.deliver('reply-check', { sessionId: 's1', checks: [check, { turnSeq: 30, status: 'done', verdicts: [check.verdicts[0]], cautions: [] }, { turnSeq: 31, status: 'running', verdicts: [], cautions: [] }] });
  const checked = renderStatic(f.ours.component, { node: { kind: 'assistant-step', data: { finalNode: { seq: 12 } } } });
  assert.match(checked, /^<div data-kernel-assistant="12">answer<\/div>/, 'the kernel draws the answer first, as it would without this body');
  assert.match(checked, /data-evimed-reply-check="warn"/);
  assert.match(checked, /⚠ 2 处引用待核对 · 用药提示 1 条/);
  assert.match(checked, /aria-expanded="false"/, 'the detail opens on demand');
  assert.doesNotMatch(checked, /依据核对|独立审查|逐句核对|✓/);
  for (const seq of [30, 31, 99]) {
    assert.equal(renderStatic(f.ours.component, { node: { kind: 'assistant-step', data: { finalNode: { seq } } } }), `<div data-kernel-assistant="${seq}">answer</div>`,
      'all supported, still checking, or never checked: the kernel\'s answer alone');
  }
  assert.deepEqual(f.target.warnings, []);
  assert.equal(BODY.name, 'reply-checks');
});

test('outside a frame nothing is taken over', () => {
  const f = frame({ framed: false });
  assert.equal(f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.options.priority === -1).length, 0);
});
