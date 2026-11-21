import assert from 'node:assert/strict';
import test from 'node:test';
import { FollowUpJudge } from '../src/learningEvidence.mjs';
import { LearningTriggers } from '../src/learningTriggers.mjs';
import { lateFixture, boundAcceptance, DELIVERY, LATE_NOW } from '../../../evals/follow-up-judge/late-fixtures.mjs';

const message = 'Convert this report to PDF.';
test('late continuation is opt-in, version-bound, settled directly, and idempotent per run', async () => {
  const off = lateFixture({ enabled: false, answer: boundAcceptance(message) });
  await off.snapshot(); assert.equal((await off.turn(message)).recorded, false); assert.equal(off.calls.length, 0);
  const state = lateFixture({ answer: boundAcceptance(message) });
  await state.snapshot();
  assert.equal((await state.turn(message)).verdict, 'accept');
  assert.equal(state.outcome(), 'clean');
  assert.equal(state.calls[0].mode, 'late-follow-up');
  assert.deepEqual(state.calls[0].deliveries, [DELIVERY]);
  assert.equal(state.calls[0].previousRequest, state.run.question);
  await state.turn(message); await state.turn(message, { requestId: 'duplicate-other-id' });
  assert.equal(state.rows.filter(row => row.detail.lateFollowUp && row.detail.verdict === 'accept').length, 1);
  assert.ok(state.funnel.some(event => event.reason === 'fewer_than_three_clean'), 'late acceptance directly settled after the original job ended');
});
test('late window boundaries and the original half-hour path', async () => {
  for (const [age, accepted] of [[1_799_000, true], [1_800_000, true], [1_801_000, true], [86_400_000, true], [86_400_001, false]]) {
    const state = lateFixture({ age, answer: boundAcceptance(message) }); await state.snapshot();
    assert.equal((await state.turn(message)).recorded, accepted, String(age));
    if (age <= 1_800_000) assert.equal(state.calls[0].mode, undefined);
  }
});
test('bare thanks, unbound outputs, adoption, another conversation and intervening runs cannot add late clean evidence', async () => {
  const variants = [
    { answer: JSON.stringify({ verdict: 'accept' }), text: 'Thanks.' },
    { answer: JSON.stringify({ verdict: 'adopt', rule: 'Keep this', quote: 'Keep this' }), text: 'Keep this' },
    { files: [] }, { currentFiles: [{ ...DELIVERY, sha256: 'b'.repeat(64) }] },
    { answer: boundAcceptance(message, { ...DELIVERY, sha256: 'b'.repeat(64) }) },
    { sessionId: 'another' }, { requestId: '' },
    { extraRuns: [{ id: 'still-running', sessionId: 'session', status: 'running', startedAt: new Date(LATE_NOW - 7_200_000).toISOString() }] },
    { extraRuns: [{ id: 'middle', sessionId: 'session', status: 'failed', startedAt: new Date(LATE_NOW - 60_000).toISOString(), finishedAt: new Date(LATE_NOW - 30_000).toISOString() }] },
    ...['paused', 'before_reset', 'clinical_context', 'not_researcher_work', 'run_unavailable', 'transcript_incomplete'].map(refusal => ({ refusal })),
  ];
  for (const variant of variants) {
    const state = lateFixture({ answer: boundAcceptance(message), ...variant }); await state.snapshot(); await state.turn(variant.text ?? message);
    assert.notEqual(state.outcome(), 'clean', JSON.stringify(variant));
  }
});
test('a redo stays corrected; a later correction overrides acceptance without reviving the source', async () => {
  const correction = JSON.stringify({ verdict: 'rejection', rule: 'Redo the report', quote: 'Redo the report', concerns: [] });
  const redo = lateFixture({ answer: correction }); await redo.snapshot(); await redo.turn('Redo the report'); assert.equal(redo.outcome(), 'corrected');
  const state = lateFixture({ answer: request => request.message === message ? boundAcceptance(message) : correction }); await state.snapshot();
  await state.turn(message); assert.equal(state.outcome(), 'clean');
  await state.turn('Redo the report', { requestId: 'correction-turn' }); assert.equal(state.outcome(), 'corrected');
  await state.turn(message, { requestId: 'accept-again' }); assert.equal(state.outcome(), 'corrected');
});
test('an earlier follow-up consumes eligibility and an assistant read is no human continuation', async () => {
  const state = lateFixture({ answer: boundAcceptance(message) }); await state.snapshot();
  await state.feedback.recordLearningEvidence('owner', { runId: state.run.id, projectId: 'project', key: 'earlier', detail: { evidence: 'follow-up', verdict: 'none', sessionId: 'session', at: new Date(LATE_NOW - 60_000).toISOString() } });
  await state.turn(message); assert.notEqual(state.outcome(), 'clean');
  const untouched = lateFixture({ answer: boundAcceptance(message) }); await untouched.snapshot();
  await untouched.evidence.readDeliveryBindings(untouched.project, untouched.run);
  assert.equal(untouched.outcome(), 'unknown'); assert.equal(untouched.calls.length, 0);
});

test('multiple delivered versions require the selected digest, and concurrent callbacks write one reaction', async () => {
  const second = { path: 'report/second.md', sha256: 'b'.repeat(64) };
  const state = lateFixture({ files: [DELIVERY, second], answer: boundAcceptance(message, second) }); await state.snapshot();
  await Promise.all([state.turn(message), state.turn(message)]);
  assert.equal(state.rows.filter(row => row.detail.lateFollowUp).length, 1);
  assert.deepEqual(state.rows.find(row => row.detail.verdict === 'accept').detail.artifact, second);
});
test('judge unavailability consumes no clean evidence, and a withdrawal while judging is rechecked', async () => {
  const state = lateFixture({ answer: null }); await state.snapshot();
  assert.equal((await state.turn(message)).reason, 'judge_failed'); assert.equal(state.outcome(), 'unknown');
  const unavailable = lateFixture({ answer: boundAcceptance(message) }); await unavailable.snapshot(); unavailable.evidence.judge.available = false;
  assert.equal((await unavailable.turn(message)).reason, 'judge_unavailable');
  const pending = lateFixture({ answer: async () => { pending.evidence.triggers.refusalFor = async () => 'before_reset'; return boundAcceptance(message); } }); await pending.snapshot();
  assert.equal((await pending.turn(message)).reason, 'before_reset'); assert.notEqual(pending.outcome(), 'clean');
});

test('a late clean run is one of three trajectories and never an adoption lesson', async () => {
  const state = lateFixture({ answer: boundAcceptance(message) }); await state.snapshot();
  for (const runId of ['first', 'second']) await state.feedback.recordLearningEvidence('owner', { runId, projectId: 'project', key: 'kept',
    detail: { evidence: 'follow-up', verdict: 'accept', scope: 'conversation', at: state.run.finishedAt,
      shape: [{ format: 'md', labels: ['summary', 'findings'] }] } });
  assert.equal((await state.turn(message)).verdict, 'accept');
  assert.deepEqual(state.queued.map(lesson => lesson.trigger), ['routine']);
  assert.equal(state.queued[0].payload.peers.length, 2);
});


test('the real admission gates still refuse late evidence from automated, clinical, paused, reset and incomplete runs', async () => {
  for (const reason of ['not_researcher_work', 'clinical_context', 'paused', 'before_reset', 'transcript_incomplete']) {
    const state = lateFixture({ answer: boundAcceptance(message) }); await state.snapshot();
    if (reason === 'not_researcher_work') state.run.automated = true;
    if (reason === 'transcript_incomplete') state.run.transcript.completeness = 'partial';
    const memory = { configured: true, settings: async () => ({ learningPaused: reason === 'paused', pausedProjects: [] }),
      resetInstant: async () => reason === 'before_reset' ? new Date(LATE_NOW).toISOString() : null };
    state.evidence.triggers = new LearningTriggers({ jobs: { enqueue: async () => {} }, agentRuns: { list: async () => [state.run] },
      memory, canReuseRun: async () => reason !== 'clinical_context' });
    assert.equal((await state.turn(message)).reason, reason);
    assert.notEqual(state.outcome(), 'clean'); assert.equal(state.calls.length, 0);
  }
});

test('deleting the bound file while the judge is pending cannot revive its snapshot', async () => {
  const currentFiles = [{ ...DELIVERY }];
  const state = lateFixture({ currentFiles, answer: async () => { currentFiles.length = 0; return boundAcceptance(message); } });
  await state.snapshot();
  assert.equal((await state.turn(message)).reason, 'binding_changed');
  assert.notEqual(state.outcome(), 'clean');
});

test('an unreadable first late turn stays unknown on retries and cannot be replaced by a later positive', async () => {
  const state = lateFixture({ answer: null }); await state.snapshot();
  assert.equal((await state.turn(message)).reason, 'judge_failed');
  state.evidence.judge.read = async () => boundAcceptance(message);
  assert.equal((await state.turn(message)).reason, 'already_followed_up');
  await state.turn(message, { requestId: 'another-human-turn' });
  assert.equal(state.outcome(), 'unknown');
});
test('a replay recovers settling interrupted after the late evidence write', async () => {
  const state = lateFixture({ answer: boundAcceptance(message) }); await state.snapshot();
  for (const runId of ['first', 'second']) await state.feedback.recordLearningEvidence('owner', { runId, projectId: 'project', key: 'kept',
    detail: { evidence: 'follow-up', verdict: 'accept', scope: 'conversation', at: state.run.finishedAt, shape: [{ format: 'md', labels: ['summary', 'findings'] }] } });
  const read = state.feedback.cleanSettledRuns;
  state.feedback.cleanSettledRuns = async () => { throw new Error('interrupted settle'); };
  assert.equal((await state.turn(message)).reason, 'record_failed');
  assert.equal(state.outcome(), 'clean'); assert.equal(state.queued.length, 0);
  state.feedback.cleanSettledRuns = read;
  assert.equal((await state.turn(message)).reason, 'already_followed_up');
  assert.equal(state.queued.length, 1); assert.equal(state.queued[0].trigger, 'routine');
});


test('a gateway budget refusal has its own content-free funnel reason', async () => {
  const observed = [];
  const judge = new FollowUpJudge({ deepseekProviderEnabled: true, deepseekApiKey: 'test', deepseekModel: 'test' }, {
    callModel: async () => { throw Object.assign(new Error('message must not reach metrics'), { code: 'usage_budget_exceeded' }); },
    onFailure: (reason, owner) => observed.push({ reason, owner }),
  });
  assert.equal(await judge.read({ message: 'private input', previousRequest: 'private request', methods: [] }, { userId: 'u', projectId: 'p', runId: 'r' }), null);
  assert.equal(observed[0].reason, 'judge_over_budget');
  assert.doesNotMatch(JSON.stringify(observed), /private|must not reach/);
});

test('with late follow-up off, delivery queues the original half-hour job and only its worker settles the timely reaction', async () => {
  const state = lateFixture({ enabled: false, age: 1_799_000, answer: boundAcceptance(message) });
  /** @type {any[]} */
  const jobs = [];
  /** @type {any[]} */
  const broughtForward = [];
  state.evidence.jobs = {
    enqueue: async (/** @type {string} */ owner, /** @type {string} */ kind, /** @type {any} */ payload, /** @type {any} */ options) => {
      jobs.push({ owner, kind, payload, options });
    },
    bringForward: async (/** @type {string} */ owner, /** @type {string} */ key) => { broughtForward.push({ owner, key }); return true; },
  };
  state.evidence.readDeliveryBindings = async () => { throw new Error('Disabled late follow-up must not read delivery bindings'); };
  await state.snapshot();
  assert.deepEqual(state.rows, []);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'learning-evidence');
  assert.equal(jobs[0].options.runAfter.getTime(), Date.parse(state.run.finishedAt) + 1_800_000);
  assert.equal((await state.turn(message)).verdict, 'accept');
  assert.equal(state.calls[0].mode, undefined);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].detail.lateFollowUp, undefined);
  assert.equal(broughtForward.length, 1);
  assert.equal(state.funnel.some((/** @type {any} */ event) => event.reason === 'clean'), false, 'a timely turn brings the worker job forward, never settles directly');
  const settled = await state.evidence.settle({ job: { userId: 'owner', projectId: 'project', payload: { runId: state.run.id } } });
  assert.equal(settled.outcome, 'clean');
  assert.equal(state.funnel.some((/** @type {any} */ event) => event.reason === 'clean'), true);
});

test('the late prompt has its own quotation protocol and keeps the exact shared artifact', async () => {
  const shared = '就这个版本，我转发给导师了。';
  const judge = new FollowUpJudge({ deepseekProviderEnabled: true, deepseekApiKey: 'test', deepseekModel: 'test' }, {
    callModel: async (_gateway, { body }) => {
      const prompt = body.messages[0].content;
      assert.match(prompt, /already forwarded or shared/);
      assert.match(prompt, /several versions fit/);
      assert.doesNotMatch(prompt, /null for accept and none/);
      return { choices: [{ message: { content: JSON.stringify({ verdict: 'accept', quote: shared, artifact: DELIVERY, relation: 'share' }) } }] };
    },
  });
  const state = lateFixture();
  state.evidence.judge = judge;
  await state.snapshot();
  assert.equal((await state.turn(shared)).verdict, 'accept');
  const row = state.rows.find(row => row.detail.verdict === 'accept');
  assert.deepEqual(row.detail.artifact, DELIVERY);
  assert.equal(row.detail.quote, shared);
  assert.equal(row.detail.relation, 'share');
});
