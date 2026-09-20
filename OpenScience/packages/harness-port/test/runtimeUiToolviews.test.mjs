// The run's tool calls as cards: what each one says to a researcher, from the
// call alone and with the bound run's live state.
//
// The blocks are the kernel's two call forms (`RunningToolCall` while the
// arguments stream, the `tool-result` node once settled) and the results are
// socket-tool text in the form the kernel records it (`ok\n<JSON>`,
// `failed: <code>` + issue lines) — the forms the kit's tests hold to
// production samples.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply, awaitView, BODY, claimView, delegateView, liveRunFor, planView, refusalOf, verdictView,
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
const PLAN_RESULT = ok({ runId: 'run-1', revision: 1, deliverables: PLAN_ARGS.deliverables.map((item) => ({ ...item, status: 'planned', attempts: 0, issues: [] })) });

const LIVE = {
  runId: 'run-1', sessionId: 'session-a', state: 'running', title: '老年房颤抗凝',
  progress: {
    deliverables: [
      { id: 'evidence', title: '老年房颤抗凝证据综述', capability: 'clinical-evidence-synthesis', status: 'rejected', attempts: 2, lastVerdict: 'issues', mustFixCount: 3, childSessionId: 'child-1' },
      { id: 'drug-eval', title: '利伐沙班综合评价', capability: 'drug-evaluation', status: 'planned', attempts: 0 },
    ],
    phaseCounts: { search: 4, screen: 2, fulltext: 1, claims: 0, write: 0, deliver: 0 },
    currentPhase: 'screen',
    sources: { searched: 120, included: 18, fullText: 6 },
    claims: { total: 0, verified: 0 },
    children: [{ childSessionId: 'child-1', deliverableId: 'evidence', state: 'running', lastActivityAt: null }],
    startedAt: '2026-09-18T01:00:00.000Z',
    updatedAt: '2026-09-18T01:05:00.000Z',
  },
};

/** No Latin word of three letters or more: the validator's English never reaches a card. */
function assertNoEnglish(/** @type {string} */ text) {
  assert.doesNotMatch(text.replace(/EviMed|RCT|Meta/g, ''), /[A-Za-z]{3,}/, `English reached the card: ${text}`);
}

test('the run state counts for the conversation it belongs to, and for its children', () => {
  assert.equal(liveRunFor(LIVE, { sessionId: 'session-a' }), LIVE);
  assert.equal(liveRunFor(LIVE, { sessionId: 'child-1', subagent: true, rootSessionId: 'session-a' }), LIVE);
  assert.equal(liveRunFor(LIVE, { sessionId: 'session-b' }), null, 'a state for another task');
  assert.equal(liveRunFor({ runId: null }, { sessionId: 'session-a' }), null, 'the shell cleared it');
  assert.equal(liveRunFor(LIVE, null), LIVE, 'before the bridge has said which session is open');
});

test('a plan is its deliverables, dependencies by name, and no stale 「待开始」', () => {
  const view = planView(settled('evimed_plan', PLAN_ARGS, PLAN_RESULT), null, kit());
  assert.equal(view.kind, 'written');
  assert.deepEqual(view.deliverables.map((/** @type {any} */ item) => [item.title, item.capability, item.kind, item.dependsOn]), [
    ['老年房颤抗凝证据综述', '临床证据综合', '临床证据综述', []],
    ['利伐沙班综合评价', '药品综合评价', '药品综合评价', ['老年房颤抗凝证据综述']],
  ]);
  // The result's own `planned` is a snapshot from when it was written.
  assert.ok(view.deliverables.every((/** @type {any} */ item) => item.status === null));
  assert.deepEqual(view.clarifications, ['人群限定为 65 岁以上', '结局采用全因死亡']);
  // With the live run, each item says where it stands now.
  const live = planView(settled('evimed_plan', PLAN_ARGS, PLAN_RESULT), LIVE, kit());
  assert.deepEqual(live.deliverables.map((/** @type {any} */ item) => item.status?.text), ['需修改', '待开始']);
  // A read-back is the state at that moment and says so.
  const status = planView(settled('evimed_plan', { action: 'status' }, ok({ runId: 'run-1', revision: 1, items: [{ id: 'evidence', title: 'T', status: 'accepted' }] })), null, kit());
  assert.equal(status.kind, 'status');
  assert.equal(status.deliverables[0].status?.text, '已通过');
});

test('a plan still streaming shows what is written so far, and a refused one says so in Chinese', () => {
  assert.equal(planView(running('evimed_plan', '{"action":"write","clarifications":["人'), null, kit()).kind, 'writing');
  const refused = planView(settled('evimed_plan', PLAN_ARGS, 'failed: plan_invalid\n- (required) deliverable_missing_capability Deliverable d1 has no capability.'), null, kit());
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.text, '计划需要修改');
});

test('a blocking delegation that settled is a finished card with its duration', () => {
  const block = settled('evimed_delegate', { deliverableId: 'evidence' },
    ok({ deliverableId: 'evidence', childSessionId: 'child-1', report: { deliverableId: 'evidence', submitted: true, summary: 'done' }, status: 'accepted' }),
    { callTime: 1_000_000, time: 1_000_000 + 192_000 });
  const view = delegateView(block, null, 9_999_999_999, kit(), new Map([['evidence', '老年房颤抗凝证据综述']]));
  assert.equal(view.state, 'done');
  assert.equal(view.stateText, '已通过');
  assert.equal(view.tone, 'ok');
  assert.equal(view.title, '老年房颤抗凝证据综述');
  assert.equal(view.elapsed, '3 分 12 秒', 'the call was open exactly as long as its child worked');
  assert.equal(view.childSessionId, 'child-1');
  // The blocking call's retried shape has no status; it is still finished.
  const retried = delegateView(settled('evimed_delegate', { deliverableId: 'evidence' }, ok({ deliverableId: 'evidence', childSessionId: 'child-2', report: null, retried: true })), null, 9_999_999_999, kit());
  assert.equal(retried.state, 'done');
  assert.notEqual(retried.elapsed, null);
});

test('a non-blocking delegation follows its child in the live run', () => {
  const started = settled('evimed_delegate', { deliverableId: 'evidence' },
    ok({ handle: 'h-1', deliverableId: 'evidence', childSessionId: 'child-1', status: 'started' }), { callTime: 1_000_000, time: 1_000_500 });
  const view = delegateView(started, LIVE, 1_000_000 + 125_000, kit());
  assert.equal(view.state, 'running');
  assert.equal(view.stateText, '进行中');
  assert.equal(view.tone, 'active');
  assert.equal(view.elapsed, '2 分 05 秒');
  assert.equal(view.phase, '筛选');
  assert.equal(view.sources, '纳入 18 篇 · 全文 6 篇');
  assert.deepEqual(view.submission, { attempt: 2, verdict: { text: '⚠ 3 项需核对', tone: 'warn' } });
  assert.equal(view.capability, '临床证据综合');
  // Without live news it says only that it started, with no clock that
  // would count hours on an old task.
  const quiet = delegateView(started, null, 9_999_999_999, kit());
  assert.equal(quiet.state, 'started');
  assert.equal(quiet.stateText, '已启动');
  assert.equal(quiet.elapsed, null);
  // Finished: the duration stops at the child's last activity.
  const finished = { ...LIVE, progress: { ...LIVE.progress,
    deliverables: [{ ...LIVE.progress.deliverables[0], status: 'accepted', lastVerdict: 'pass', mustFixCount: 0 }],
    children: [{ childSessionId: 'child-1', deliverableId: 'evidence', state: 'done', lastActivityAt: new Date(1_000_000 + 600_000).toISOString() }] } };
  const done = delegateView(started, finished, 9_999_999_999, kit());
  assert.equal(done.state, 'done');
  assert.equal(done.stateText, '已通过');
  assert.equal(done.elapsed, '10 分 00 秒');
  assert.deepEqual(done.submission?.verdict, { text: '✓ 通过', tone: 'ok' });
});

test('with two children at work the run-level phase and counts are not pinned on one card', () => {
  const two = { ...LIVE, progress: { ...LIVE.progress, children: [
    { childSessionId: 'child-1', deliverableId: 'evidence', state: 'running', lastActivityAt: null },
    { childSessionId: 'child-2', deliverableId: 'drug-eval', state: 'running', lastActivityAt: null },
  ] } };
  const view = delegateView(running('evimed_delegate', { deliverableId: 'evidence' }), two, 1_060_000, kit());
  assert.equal(view.phase, null);
  assert.equal(view.sources, null);
  assert.equal(view.state, 'running');
});

test('a refused delegation names its reason, and a streaming one its deliverable already', () => {
  const refused = delegateView(settled('evimed_delegate', { deliverableId: 'drug-eval' },
    'failed: deliverable_dependency_pending\n- (required) deliverable_dependency_pending 它依赖 evidence，等这些通过后再委派。'), null, 0, kit());
  assert.equal(refused.state, 'refused');
  assert.equal(refused.stateText, '它依赖的那一件还没有通过');
  const streaming = delegateView(running('evimed_delegate', '{"deliverableId":"drug-eval","brief":"比较'), LIVE, 1_030_000, kit());
  assert.equal(streaming.title, '利伐沙班综合评价');
  assert.equal(streaming.state, 'running');
});

test('an await lists what came back, in Chinese', () => {
  assert.equal(awaitView(running('evimed_await', { handles: ['h-1', 'h-2'] }), null, kit()).handles, 2);
  const view = awaitView(settled('evimed_await', { handles: ['h-1', 'h-2'] }, ok({ results: [
    { handle: 'h-1', deliverableId: 'evidence', childSessionId: 'child-1', status: 'completed', summary: 'Evidence synthesis done.', submission: { attempts: 2, verdict: 'pass' } },
    { handle: 'h-2', deliverableId: 'drug-eval', childSessionId: 'child-2', status: 'running' },
  ] })), LIVE, kit());
  assert.equal(view.kind, 'settled');
  assert.deepEqual(view.results.map((/** @type {any} */ entry) => [entry.title, entry.status, entry.verdict?.text ?? null]), [
    ['老年房颤抗凝证据综述', '已完成', '✓ 通过'],
    ['利伐沙班综合评价', '仍在进行', null],
  ]);
  assertNoEnglish(view.results.map((/** @type {any} */ entry) => [entry.status, entry.verdict?.text ?? '']).flat().join(' '));
});

test('a submission is a verdict in three words, never the validator text', () => {
  const failed = 'failed: specialist_evidence_traceability_failed\n'
    + '- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S01 is not cited by the report.\n'
    + '- (required) quote_not_in_source The quotation for CLM-S07 is not in the source it names.\n'
    + '- (advisory) citation_style Reference style is inconsistent.';
  const issues = verdictView(settled('evimed_submit_deliverable', { deliverableId: 'evidence' }, failed), LIVE, kit());
  assert.equal(issues.kind, 'judged');
  assert.deepEqual(issues.verdict, { text: '⚠ 2 项需核对', tone: 'warn' });
  assert.equal(issues.title, '老年房颤抗凝证据综述');
  // One finding carries its own code at the top too; it is still a verdict.
  const single = verdictView(settled('evimed_submit_deliverable', { deliverableId: 'evidence' },
    'failed: quote_not_in_source\n- (required) quote_not_in_source The quotation for CLM-S07 is not in the source it names.'), null, kit());
  assert.deepEqual(single.verdict, { text: '⚠ 1 项需核对', tone: 'warn' });
  const pass = verdictView(settled('evimed_submit_deliverable', { deliverableId: 'evidence' },
    ok({ deliverableId: 'evidence', contractKind: 'clinical-evidence-report', label: '临床证据综述', metrics: {}, notices: ['a', 'b'] })), null, kit());
  assert.deepEqual(pass.verdict, { text: '✓ 通过', tone: 'ok' });
  assert.equal(pass.advice, 2);
  assert.equal(pass.title, '临床证据综述', 'with nothing better, the contract kind names it');
  const refused = verdictView(settled('evimed_submit_deliverable', { deliverableId: 'evidence' },
    'failed: deliverable_not_owned\n- (required) deliverable_not_owned 此能力子代理只负责交付物「x」。'), null, kit());
  assert.equal(refused.kind, 'refused');
  assert.equal(/** @type {any} */ (refused).text, '这一件不由当前子任务负责');
  assert.equal(verdictView(running('evimed_submit_deliverable', { deliverableId: 'evidence' }), null, kit()).kind, 'judging');
  assert.equal(refusalOf({ ok: false, code: 'quote_not_in_source', issues: [{ code: 'quote_not_in_source' }] }), null);
});

test('a registered claim shows its wording, whether it checked out, and the running tally', () => {
  const claim = { deliverableId: 'evidence', claim: { id: 'CLM-003', type: 'direct', text: '与华法林相比，利伐沙班使老年患者大出血风险降低。', sources: ['src_1'] } };
  const verified = claimView(settled('evimed_claim_upsert', claim, ok({ claimId: 'CLM-003', status: 'verified', issues: [], totals: { total: 12, verified: 10 } })), kit());
  assert.equal(verified.statement, '与华法林相比，利伐沙班使老年患者大出血风险降低。');
  assert.deepEqual(verified.status, { text: '✓ 已核对', tone: 'ok' });
  assert.equal(verified.totals, '已核对 10/12');
  const unverified = claimView(settled('evimed_claim_upsert', claim, ok({ claimId: 'CLM-003', status: 'unverified', issues: [{ code: 'quote_not_found', message: 'Quote not found in src_1.' }], totals: { total: 12, verified: 10 } })), kit());
  assert.deepEqual(unverified.status, { text: '⚠ 未核对', tone: 'warn' });
  assert.equal(claimView(running('evimed_claim_upsert', '{"deliverableId":"evidence","claim":{"text":"与华法林'), kit()).kind, 'recording');
});

test('every card is registered under its tool name, in the conversation namespace', () => {
  const ctx = fakeCtx({ slots: kernelSlots(), sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } } });
  const target = fakeTarget({ frame: { capabilities: CAPABILITIES } });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const views = ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'tool.call.toolview' && entry.component !== 'shipped');
  assert.deepEqual(views.map((/** @type {any} */ entry) => entry.options.key).sort(),
    ['evimed_await', 'evimed_claim_upsert', 'evimed_delegate', 'evimed_package_check', 'evimed_plan', 'evimed_submit_deliverable']);
  assert.ok(views.every((/** @type {any} */ entry) => entry.options.locale === 'conversation'));
  assert.deepEqual(target.warnings, []);
  assert.equal(BODY.name, 'toolviews');
});

test('outside a frame nothing is registered', () => {
  const ctx = fakeCtx({ slots: kernelSlots() });
  const target = fakeTarget({ framed: false });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.component !== 'shipped').length, 0);
});

test('the cards render Chinese markup, and a call of an unknown shape draws a plain row instead of throwing', () => {
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

  const plan = renderStatic(view('evimed_plan'), { block: settled('evimed_plan', PLAN_ARGS, PLAN_RESULT) });
  assert.match(plan, /研究计划/);
  assert.match(plan, /依赖：老年房颤抗凝证据综述/);
  assert.match(plan, /需修改/);

  const delegate = renderStatic(view('evimed_delegate'), { block: settled('evimed_delegate', { deliverableId: 'evidence' }, ok({ handle: 'h-1', deliverableId: 'evidence', childSessionId: 'child-1', status: 'started' })) });
  assert.match(delegate, /子任务/);
  assert.match(delegate, /老年房颤抗凝证据综述/);
  assert.match(delegate, /第 2 次提交/);
  assert.match(delegate, /查看子任务/);
  assert.doesNotMatch(delegate, /disabled/, 'the catalogue lists the child, so the link is live');

  const failed = 'failed: specialist_evidence_traceability_failed\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S01 is not cited by the report.';
  const submit = renderStatic(view('evimed_submit_deliverable'), { block: settled('evimed_submit_deliverable', { deliverableId: 'evidence' }, failed) });
  assert.match(submit, /⚠ 1 项需核对/);
  assert.doesNotMatch(submit, /Evidence matrix|specialist_evidence/);

  const check = renderStatic(view('evimed_package_check'), { block: settled('evimed_package_check', { deliverableId: 'evidence' }, ok({ deliverableId: 'evidence', notices: [] })) });
  assert.match(check, /自检/);
  assert.match(check, /✓ 通过/);

  // A result node with content blocks of a shape nobody expected.
  const odd = renderStatic(view('evimed_await'), { block: { kind: 'tool-result', call: { name: 'evimed_await', argsRaw: '{}' }, content: 'not-an-array', time: 1 } });
  assert.match(odd, /等待子任务/);
  // A call the model of which cannot even be read: a plain row and a warning,
  // not a throw that would retire the view for every later call.
  const unreadable = { get kind() { throw new Error('a shape from a newer kernel'); } };
  assert.match(renderStatic(view('evimed_delegate'), { block: unreadable }), /子任务/);
  assert.ok(target.warnings.some((/** @type {any[]} */ entry) => String(entry[0]).includes('delegate view could not read a call')));
  assert.deepEqual(target.warnings.filter((/** @type {any[]} */ entry) => String(entry[0]).includes('did not start')), []);
});
