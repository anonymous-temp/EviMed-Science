// The run's tool calls as the conversation shows them: the plan as the list
// of what will be handed back, each delegation as one line, and the delivery
// gate's own calls not at all — unless one was refused outright.
//
// The blocks are the kernel's two call forms (`RunningToolCall` while the
// arguments stream, the `tool-result` node once settled) and the results are
// socket-tool text in the form the kernel records it (`ok\n<JSON>`,
// `failed: <code>` + issue lines) — the forms the kit's tests hold to
// production samples.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply, BODY, delegateView, gateRefusal, liveRunFor, planView, refusalOf,
} from '../src/runtimeUiToolviews.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, renderStatic } from './helpers/frameFakes.mjs';

const CAPABILITIES = [
  { id: 'clinical-evidence-synthesis', title: '临床证据综合', category: '证据综合', brief: 'b', summary: 's', minutes: [20, 40] },
  { id: 'drug-evaluation', title: '药品综合评价', category: '药物评价', brief: 'b', summary: 's', minutes: [30, 60] },
];

function kit() {
  const target = fakeTarget({ frame: { capabilities: CAPABILITIES } });
  return kitFor(fakeCtx(), target);
}

/** @param {string} name @param {unknown} args @param {number} [time] */
const running = (name, args, time = 1_000_000) => ({
  callId: 'c1', name, argsRaw: typeof args === 'string' ? args : JSON.stringify(args), turn: 1, step: 1, time, subCalls: [],
});
/** @param {string} name @param {unknown} args @param {string} text @param {{ callTime?: number, time?: number, isError?: boolean }} [at] */
const settled = (name, args, text, { callTime = 1_000_000, time = 1_060_000, isError = false } = {}) => ({
  kind: 'tool-result', seq: 9, time, callId: 'c1', call: { name, argsRaw: JSON.stringify(args) }, callTime,
  content: [{ type: 'text', text }], isError, subCalls: [],
});
const ok = (/** @type {unknown} */ data) => `ok\n${JSON.stringify(data, null, 2)}`;

const PLAN_ARGS = {
  action: 'write',
  clarifications: ['人群限定为 65 岁以上', '结局采用全因死亡'],
  deliverables: [
    { id: 'evidence', contractKind: 'clinical-evidence-report', capability: 'clinical-evidence-synthesis', title: '老年房颤抗凝证据综述', dependsOn: [] },
    { id: 'drug-eval', contractKind: 'drug-evaluation-report', capability: 'drug-evaluation', title: '利伐沙班综合评价', dependsOn: ['evidence'] },
  ],
};
const PLAN_RESULT = ok({ runId: 'run-1', revision: 2, deliverables: PLAN_ARGS.deliverables.map((item) => ({ ...item, status: 'planned', attempts: 0, issues: [] })) });

const LIVE = {
  runId: 'run-1', sessionId: 'session-a', state: 'running', title: '老年房颤抗凝',
  progress: {
    deliverables: [
      { id: 'evidence', title: '老年房颤抗凝证据综述', capability: 'clinical-evidence-synthesis', status: 'rejected', attempts: 2, lastVerdict: 'issues', mustFixCount: 3, childSessionId: 'child-1' },
      { id: 'drug-eval', title: '利伐沙班综合评价', capability: 'drug-evaluation', status: 'planned', attempts: 0 },
    ],
    currentPhase: 'screen',
    sources: { searched: 120, included: 18, fullText: 6 },
    children: [{ childSessionId: 'child-1', deliverableId: 'evidence', state: 'running', lastActivityAt: null }],
    startedAt: '2026-09-18T01:00:00.000Z',
    updatedAt: '2026-09-18T01:05:00.000Z',
  },
};

/** Nothing of the run's machinery or the validator's English reaches a row. */
function assertReaderWords(/** @type {string} */ html) {
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text.replace(/EviMed/g, ''), /[A-Za-z]{3,}/, `English reached a row: ${text}`);
  assert.doesNotMatch(text, /第 \d+ 版|要交付|依赖|契约|临床证据综述|已用时|纳入|全文|提交|核对|审查|内核|已交付|已通过|需修改/, `the run's machinery reached a row: ${text}`);
}

test('the run state counts for the conversation it belongs to, and for its children', () => {
  assert.equal(liveRunFor(LIVE, { sessionId: 'session-a' }), LIVE);
  assert.equal(liveRunFor(LIVE, { sessionId: 'child-1', subagent: true, rootSessionId: 'session-a' }), LIVE);
  assert.equal(liveRunFor(LIVE, { sessionId: 'session-b' }), null, 'a state for another task');
  assert.equal(liveRunFor({ runId: null }, { sessionId: 'session-a' }), null, 'the shell cleared it');
  assert.equal(liveRunFor(LIVE, null), LIVE, 'before the bridge has said which session is open');
});

test('a plan is what will be handed back and where each piece stands — no revision, kind, dependency or clarification', () => {
  const view = planView(settled('evimed_plan', PLAN_ARGS, PLAN_RESULT), null, kit());
  assert.equal(view.kind, 'written');
  assert.deepEqual(view.deliverables, [
    { id: 'evidence', title: '老年房颤抗凝证据综述', status: null },
    { id: 'drug-eval', title: '利伐沙班综合评价', status: null },
  ], "the result's own `planned` is a snapshot from when it was written");
  const live = planView(settled('evimed_plan', PLAN_ARGS, PLAN_RESULT), LIVE, kit());
  assert.deepEqual(live.deliverables.map((/** @type {any} */ item) => item.status), ['进行中', '待开始'], 'a package under repair is still in progress to a reader');
  const done = planView(settled('evimed_plan', PLAN_ARGS, PLAN_RESULT), { ...LIVE, progress: { ...LIVE.progress, deliverables: [{ id: 'evidence', status: 'delivered' }, { id: 'drug-eval', status: 'failed' }] } }, kit());
  assert.deepEqual(done.deliverables.map((/** @type {any} */ item) => item.status), ['已完成', '未完成']);
  // A read-back is the run checking itself.
  assert.equal(planView(settled('evimed_plan', { action: 'status' }, ok({ items: [{ id: 'evidence', status: 'accepted' }] })), null, kit()).kind, 'status');
});

test('a plan still streaming shows what is written so far, and a refused one says so in Chinese', () => {
  const writing = planView(running('evimed_plan', '{"action":"write","deliverables":[{"id":"evidence","title":"老年房颤'), null, kit());
  assert.equal(writing.kind, 'writing');
  const refused = planView(settled('evimed_plan', PLAN_ARGS, 'failed: plan_invalid\n- (required) deliverable_missing_capability Deliverable d1 has no capability.'), null, kit());
  assert.equal(refused.kind, 'refused');
  assert.equal(/** @type {any} */ (refused).text, '计划需要修改');
});

test('a delegation is its piece of work and where it stands', () => {
  const started = settled('evimed_delegate', { deliverableId: 'evidence' },
    ok({ handle: 'h-1', deliverableId: 'evidence', childSessionId: 'child-1', status: 'started' }), { callTime: 1_000_000, time: 1_000_500 });
  const working = delegateView(started, LIVE, kit());
  assert.deepEqual(working, { deliverableId: 'evidence', title: '老年房颤抗凝证据综述', childSessionId: 'child-1', state: 'running', stateText: '进行中' });
  assert.deepEqual(delegateView(started, null, kit(), new Map([['evidence', '老年房颤抗凝证据综述']])).stateText, '已启动', 'with no live news it says only that it started');
  const finished = { ...LIVE, progress: { ...LIVE.progress,
    deliverables: [{ ...LIVE.progress.deliverables[0], status: 'accepted' }],
    children: [{ childSessionId: 'child-1', deliverableId: 'evidence', state: 'done', lastActivityAt: null }] } };
  assert.equal(delegateView(started, finished, kit()).stateText, '已完成');
  // The blocking delegate's settled shape: finished, by its own word.
  const blocking = settled('evimed_delegate', { deliverableId: 'evidence' },
    ok({ deliverableId: 'evidence', childSessionId: 'child-1', report: { submitted: true }, status: 'accepted' }));
  assert.equal(delegateView(blocking, null, kit()).state, 'done');
  // A refused delegation names its reason; a streaming one its deliverable already.
  const refused = delegateView(settled('evimed_delegate', { deliverableId: 'drug-eval' },
    'failed: deliverable_dependency_pending\n- (required) deliverable_dependency_pending 它依赖 evidence。'), null, kit());
  assert.deepEqual([refused.state, refused.stateText], ['refused', '它依赖的那一件还没有完成']);
  const streaming = delegateView(running('evimed_delegate', '{"deliverableId":"drug-eval","brief":"比较'), LIVE, kit());
  assert.deepEqual([streaming.title, streaming.state], ['利伐沙班综合评价', 'running']);
});

test("the gate's own calls say nothing, unless the call itself was refused", () => {
  const verdict = 'failed: specialist_evidence_traceability_failed\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S01 is not cited by the report.';
  assert.equal(gateRefusal(settled('evimed_submit_deliverable', { deliverableId: 'evidence' }, verdict), LIVE, kit()), null, 'a verdict on the work is not a refusal');
  assert.equal(gateRefusal(settled('evimed_submit_deliverable', { deliverableId: 'evidence' }, ok({ deliverableId: 'evidence', notices: ['a'] })), LIVE, kit()), null);
  assert.equal(gateRefusal(running('evimed_package_check', { deliverableId: 'evidence' }), LIVE, kit()), null);
  assert.equal(gateRefusal(settled('evimed_claim_upsert', { deliverableId: 'evidence' }, ok({ status: 'verified', totals: { total: 12, verified: 10 } })), LIVE, kit()), null);
  assert.equal(gateRefusal(settled('evimed_await', { handles: ['h-1'] }, ok({ results: [] })), LIVE, kit()), null);
  assert.deepEqual(gateRefusal(settled('evimed_submit_deliverable', { deliverableId: 'evidence' },
    'failed: deliverable_attempts_spent\n- (required) deliverable_attempts_spent No attempts left.'), LIVE, kit()), { title: '老年房颤抗凝证据综述', text: '这一件的提交次数已用完' });
  assert.equal(refusalOf({ ok: false, code: 'quote_not_in_source', issues: [{ code: 'quote_not_in_source' }] }), null);
});

/** A frame with the catalogue listing child-1, and the views applied. */
function frame() {
  const ctx = fakeCtx({ slots: kernelSlots(), sessions: {
    list: { getSnapshot: () => ({ current: 'session-a', subagentsByParent: { 'session-a': { entries: [{ id: 'child-1', kind: 'child', mode: 'one-shot' }] } } }), subscribe: () => () => {} },
    refreshSubagents() {}, openSubagent() {},
  } });
  const target = fakeTarget({ frame: { capabilities: CAPABILITIES } });
  const frameKit = kitFor(ctx, target);
  apply(ctx, {}, target, undefined, frameKit);
  frameKit.hub.deliver('session', { sessionId: 'session-a' });
  frameKit.hub.deliver('run-state', LIVE);
  const view = (/** @type {string} */ key) => ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'tool.call.toolview' && entry.options.key === key).component;
  return { ctx, target, view };
}

test('every view is registered under its tool name, in the conversation namespace', () => {
  const f = frame();
  const views = f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'tool.call.toolview' && entry.component !== 'shipped');
  assert.deepEqual(views.map((/** @type {any} */ entry) => entry.options.key).sort(),
    ['evimed_await', 'evimed_claim_upsert', 'evimed_delegate', 'evimed_package_check', 'evimed_plan', 'evimed_submit_deliverable']);
  assert.ok(views.every((/** @type {any} */ entry) => entry.options.locale === 'conversation'));
  assert.deepEqual(f.target.warnings, []);
  assert.equal(BODY.name, 'toolviews');
});

test('the plan card is its list; the subtask card its title, state and 「查看」', () => {
  const f = frame();
  const plan = renderStatic(f.view('evimed_plan'), { block: settled('evimed_plan', PLAN_ARGS, PLAN_RESULT) });
  assert.match(plan, /研究计划/);
  assert.match(plan, /老年房颤抗凝证据综述/);
  assert.match(plan, /进行中/);
  assert.match(plan, /待开始/);
  assert.doesNotMatch(plan, /澄清|人群限定/, 'the clarifications are the run\'s own notes');
  assertReaderWords(plan);
  assert.equal(renderStatic(f.view('evimed_plan'), { block: settled('evimed_plan', { action: 'status' }, ok({ items: [] })) }), '', 'a read-back draws nothing');

  const delegate = renderStatic(f.view('evimed_delegate'), { block: settled('evimed_delegate', { deliverableId: 'evidence' }, ok({ handle: 'h-1', deliverableId: 'evidence', childSessionId: 'child-1', status: 'started' })) });
  assert.match(delegate, /老年房颤抗凝证据综述/);
  assert.match(delegate, /进行中/);
  assert.match(delegate, />查看</);
  assert.match(delegate, /aria-label="查看「老年房颤抗凝证据综述」"/);
  assert.doesNotMatch(delegate, /disabled/, 'the catalogue lists the child, so the link is live');
  assert.doesNotMatch(delegate, /title=/, 'no tooltip about the kernel');
  assertReaderWords(delegate);
});

test("the gate's rows are empty — their call row is removed by the shell — and a refusal is one plain line", () => {
  const f = frame();
  const failed = 'failed: specialist_evidence_traceability_failed\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S01 is not cited by the report.';
  assert.equal(renderStatic(f.view('evimed_submit_deliverable'), { block: settled('evimed_submit_deliverable', { deliverableId: 'evidence' }, failed) }), '');
  assert.equal(renderStatic(f.view('evimed_package_check'), { block: settled('evimed_package_check', { deliverableId: 'evidence' }, ok({ notices: [] })) }), '');
  assert.equal(renderStatic(f.view('evimed_claim_upsert'), { block: settled('evimed_claim_upsert', { deliverableId: 'evidence', claim: { text: 'x' } }, ok({ status: 'verified', totals: { total: 1, verified: 1 } })) }), '');
  assert.equal(renderStatic(f.view('evimed_await'), { block: running('evimed_await', { handles: ['h-1', 'h-2'] }) }), '', 'no 「正在等待 N 个子任务…」: the subtask cards say where each stands');
  const refused = renderStatic(f.view('evimed_submit_deliverable'), { block: settled('evimed_submit_deliverable', { deliverableId: 'evidence' },
    'failed: deliverable_not_owned\n- (required) deliverable_not_owned 此能力子代理只负责交付物「x」。') });
  assert.match(refused, /老年房颤抗凝证据综述 · 这一件不由当前子任务负责/);
  assert.match(refused, /data-evimed-toolview="refused"/);
});

test('a call of an unknown shape draws a plain row instead of throwing', () => {
  const f = frame();
  const unreadable = { get kind() { throw new Error('a shape from a newer kernel'); } };
  assert.match(renderStatic(f.view('evimed_delegate'), { block: unreadable }), /子任务/);
  assert.ok(f.target.warnings.some((/** @type {any[]} */ entry) => String(entry[0]).includes('delegate view could not read a call')));
  assert.equal(renderStatic(f.view('evimed_await'), { block: unreadable }), '', 'a gate row stays empty either way');
  assert.deepEqual(f.target.warnings.filter((/** @type {any[]} */ entry) => String(entry[0]).includes('did not start')), []);
});

test('outside a frame nothing is registered', () => {
  const ctx = fakeCtx({ slots: kernelSlots() });
  const target = fakeTarget({ framed: false });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.component !== 'shipped').length, 0);
});
