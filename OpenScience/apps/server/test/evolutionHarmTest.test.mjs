import test from 'node:test';
import assert from 'node:assert/strict';
import { METHOD_HARM_TEST, EVOLUTION_TOOL_HARM_TEST, METHOD_SCIENTIFIC_HARM_TEST, methodHarmTest } from '@evimed/domain';
import { EvolutionMaintenance, harmTestOperatingCharacteristics } from '../src/evolutionMaintenance.mjs';
import { createEvolutionFeedback } from '../src/evolutionFeedback.mjs';
import { evolutionServiceFixture } from './helpers/evolutionServiceFixture.mjs';

/** Seeded generator: every rate below is reproducible. @param {number} seed */
function mulberry32(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

async function tool(f, callbacks = {}) {
  const maintenance = new EvolutionMaintenance({ service: f.service, callbacks });
  await f.service.registerTool({ id: 'tool', track: 'M', artifactDigest: 'digest-1', holdoutCases: [{ id: 'case', sha256: 'hash' }] });
  return maintenance;
}
/** One account's run of the tool with the researcher's verdict on it. */
async function use(f, maintenance, account, run, outcome) {
  f.advance(1000);
  return maintenance.observe('tool', { runId: run, userId: account, callId: `${run}:call`, invoked: true, executionOk: true, outcome, corrected: outcome === 'rejected', feedbackEventId: `feedback:${run}`, feedbackKind: outcome === 'rejected' ? 'result-corrected' : 'deliverable-adopted' });
}

test('the tool test is the existing sequential test on the scientific axis, and its operating characteristics are exact', () => {
  assert.equal(EVOLUTION_TOOL_HARM_TEST, METHOD_SCIENTIFIC_HARM_TEST);
  const at = rate => harmTestOperatingCharacteristics(EVOLUTION_TOOL_HARM_TEST, rate);
  // The figures the module's comment states.
  assert.ok(Math.abs(at(0.25).harm - 0.0363) < 0.0002, String(at(0.25).harm));
  assert.ok(Math.abs(at(0.15).harm - 0.0034) < 0.0002);
  assert.ok(Math.abs(at(0.10).harm - 0.0006) < 0.0001);
  assert.ok(Math.abs(at(0.60).harm - 0.8439) < 0.0005);
  assert.ok(at(0.25).meanTrials > 6 && at(0.25).meanTrials < 7);
  // The delivery axis at its own 10% background rate: the per-test false alarm the review measured as 2.8%.
  assert.ok(Math.abs(harmTestOperatingCharacteristics(METHOD_HARM_TEST, 0.1).harm - 0.0281) < 0.0002);
  // The dynamic programme and methodHarmTest agree sequence by sequence on every length-6 history.
  for (let mask = 0; mask < 64; mask++) {
    const outcomes = Array.from({ length: 6 }, (_, index) => mask >> index & 1 ? 'rejected' : 'accepted');
    const read = methodHarmTest(/** @type {any} */ ({ observations: outcomes.map((outcome, index) => ({ runId: `r${index}`, family: `r${index}`, outcome, invoked: true, at: `2026-10-04T00:00:0${index}Z` })) }), EVOLUTION_TOOL_HARM_TEST);
    const bad = outcomes.filter(outcome => outcome === 'rejected').length;
    if (bad === 6) assert.equal(read.state, 'harm');
    if (bad === 0) assert.equal(read.state, 'clear');
  }
});

test('a harmless tool is proposed for retirement at the single test\'s rate, however long it is used', async () => {
  // The loop under test is the production one: observe() per run, accounts returning again and again.
  // Before the fix this figure was 33% by 100 runs and 87% by 500 at the delivery axis's 10% background rate.
  const simulate = async (rate, tools, seed) => {
    const random = mulberry32(seed);
    const proposedBy = { 40: 0, 150: 0, 600: 0 };
    for (let index = 0; index < tools; index++) {
      const f = evolutionServiceFixture(), proposals = [];
      const maintenance = await tool(f, { proposeReview: async input => proposals.push(input) });
      let proposedAt = null;
      for (let run = 1; run <= 600; run++) {
        // 120 accounts in rotation: every account is seen five times, and only its first evaluated run is a trial.
        await use(f, maintenance, `account-${run % 120}`, `run-${run}`, random() < rate ? 'rejected' : 'accepted');
        if (proposedAt === null && proposals.length) proposedAt = run;
        // Past the cap the test is over; nothing later can change it, so the remaining runs need not be played.
        if (run >= 60 && (await f.service.get('tool')).payload.usage.harm.state !== 'watching') break;
      }
      assert.ok(proposals.length <= 1, 'the verdict is raised once');
      assert.equal((await f.service.get('tool')).payload.status, 'active', 'a verdict proposes; it does not retire');
      for (const horizon of Object.keys(proposedBy)) if (proposedAt !== null && proposedAt <= Number(horizon)) proposedBy[horizon]++;
    }
    return Object.fromEntries(Object.entries(proposedBy).map(([horizon, count]) => [horizon, count / tools]));
  };
  const tools = 1500;
  const background = await simulate(EVOLUTION_TOOL_HARM_TEST.baseRate, tools, 20261005);
  const exact = harmTestOperatingCharacteristics(EVOLUTION_TOOL_HARM_TEST, EVOLUTION_TOOL_HARM_TEST.baseRate).harm;
  const standardError = Math.sqrt(exact * (1 - exact) / tools);
  assert.ok(Math.abs(background[600] - exact) < 3.5 * standardError, `simulated ${background[600]} against exact ${exact}`);
  assert.equal(background[600], background[150], 'no false retirement accrues after the test has concluded');
  assert.ok(background[600] < 0.06);
  const quiet = await simulate(0.1, 600, 77);
  assert.ok(quiet[600] < 0.01, `at a 10% correction rate: ${quiet[600]}`);
});

test('a tool whose results are corrected most of the time is found', async () => {
  const random = mulberry32(5);
  let found = 0;
  const tools = 300;
  for (let index = 0; index < tools; index++) {
    const f = evolutionServiceFixture(), proposals = [];
    const maintenance = await tool(f, { proposeReview: async input => proposals.push(input) });
    for (let run = 1; run <= 40 && !proposals.length; run++) await use(f, maintenance, `account-${run}`, `run-${run}`, random() < EVOLUTION_TOOL_HARM_TEST.harmRate ? 'rejected' : 'accepted');
    found += proposals.length;
  }
  const exact = harmTestOperatingCharacteristics(EVOLUTION_TOOL_HARM_TEST, EVOLUTION_TOOL_HARM_TEST.harmRate).harm;
  assert.ok(Math.abs(found / tools - exact) < 3.5 * Math.sqrt(exact * (1 - exact) / tools), `found ${found / tools} against exact ${exact}`);
});

test('one account cannot retire a tool for everyone; distinct accounts raise a decision an operator can reverse', async () => {
  const f = evolutionServiceFixture(), proposals = [], notified = [], restored = [];
  const maintenance = await tool(f, { proposeReview: async input => proposals.push(input), notifyAffected: async input => notified.push(input), restorePin: async pin => restored.push(pin) });
  // Security finding S3: three ordinary corrections from one account used to retire the tool platform-wide.
  for (let run = 0; run < 12; run++) await use(f, maintenance, 'one-account', `solo-${run}`, 'rejected');
  let row = await f.service.get('tool');
  assert.equal(row.payload.status, 'active');
  assert.equal(row.payload.usage.harm.trials.length, 1, 'twelve runs of one account are one trial');
  assert.equal(row.payload.usage.harm.state, 'watching');
  assert.equal(row.payload.usage.corrected, 12, 'the counters still count every run');
  assert.equal(proposals.length, 0);
  // Three more accounts: four distinct researchers have now corrected their first result.
  for (const account of ['b', 'c']) await use(f, maintenance, account, `first-${account}`, 'rejected');
  assert.equal(proposals.length, 0, 'three accounts are below the test\'s minimum of four trials');
  await use(f, maintenance, 'd', 'first-d', 'rejected');
  row = await f.service.get('tool');
  assert.equal(row.payload.usage.harm.state, 'harm');
  assert.equal(row.payload.status, 'active', 'the verdict is a proposal');
  assert.equal(proposals.length, 1);
  const [proposal] = proposals;
  assert.deepEqual({ category: proposal.category, recommended: proposal.recommended, conservative: proposal.conservative, directional: proposal.directional, paths: proposal.attemptedPaths.length },
    { category: 'tool-retire', recommended: 'retire', conservative: 'keep', directional: true, paths: 2 });
  assert.doesNotMatch(proposal.title + proposal.body, /one-account|account|llr|harm|digest/i, 'the card speaks to a reader, not in internal state');
  const review = await f.service.get(proposal.subjectId);
  assert.equal(review.payload.kind, 'sequential-harm');
  assert.deepEqual({ accounts: review.payload.evidence.accounts, corrected: review.payload.evidence.corrected }, { accounts: 4, corrected: 4 });
  assert.ok(Math.abs(review.payload.evidence.falseAlarmAtBackgroundRate - 0.0363) < 0.0002);
  // No identity of a researcher is written into the platform's record.
  assert.doesNotMatch(JSON.stringify(row.payload), /one-account/);
  // Further corrections do not raise it again.
  await use(f, maintenance, 'e', 'first-e', 'rejected');
  assert.equal(proposals.length, 1);
  // The decision (the operator's, or the default at expiry) retires; history is kept.
  await maintenance.executeReview({ subjectId: proposal.subjectId, option: 'retire', actionId: 'decision:1:retire' });
  row = await f.service.get('tool');
  assert.deepEqual({ status: row.payload.status, reason: row.payload.retirement.reason, state: row.payload.retirement.state }, { status: 'retired', reason: 'sequential-harm', state: 'complete' });
  assert.equal(notified.length, 1);
  // And the same decision reverses it.
  const reversed = await maintenance.executeReview({ id: 'decision', subjectId: proposal.subjectId, option: 'keep', actionId: 'decision:2:keep' });
  assert.equal(reversed.state, 'restored');
  row = await f.service.get('tool');
  assert.equal(row.payload.status, 'active');
  assert.equal(row.payload.retirement.state, 'reversed');
  assert.equal(row.payload.usage.harmState, 'overridden', 'kept by decision is not the same as cleared by evidence');
  assert.deepEqual(restored, [{ id: 'tool', digest: 'digest-1', revision: undefined }]);
  await use(f, maintenance, 'f', 'first-f', 'rejected');
  assert.equal(proposals.length, 1, 'an overridden verdict is not raised again');
  assert.equal((await f.service.get('tool')).payload.status, 'active');
});

test('a correction that arrives after an adoption is read at its latest value, and only for evaluated runs', async () => {
  const f = evolutionServiceFixture(), proposals = [];
  const maintenance = await tool(f, { proposeReview: async input => proposals.push(input) });
  const feedback = createEvolutionFeedback({ service: f.service, maintenance });
  for (const account of ['a', 'b', 'c', 'd']) {
    f.advance(1000);
    await maintenance.observe('tool', { runId: `run-${account}`, userId: account, callId: `call-${account}`, invoked: true, executionOk: true, outcome: 'pending' });
    await f.service.save('use', `use-${account}`, { projectId: 'research', runId: `run-${account}`, toolId: 'tool' }, null, account);
  }
  assert.equal((await f.service.get('tool')).payload.usage.harm.trials.length, 0, 'a run nobody has judged is not a trial');
  const event = (account, trigger, at, detail) => ({ id: `${trigger}-${account}`, userId: account, projectId: 'research', runId: `run-${account}`, trigger, occurredAt: at, detail });
  for (const account of ['a', 'b', 'c', 'd']) await feedback.observeFeedback(event(account, 'deliverable-adopted', '2026-10-04T01:00:00Z'));
  let harm = (await f.service.get('tool')).payload.usage.harm;
  // Three adoptions in a row reach the lower boundary, so the test is over before the fourth account is read.
  assert.deepEqual({ trials: harm.trials.length, bad: harm.bad, state: harm.state }, { trials: 3, bad: 0, state: 'clear' });
  // The researchers then correct the analysis. The history is read again at its latest outcomes, as the
  // learned-methods loop reads it: three corrections re-open the test, and the fourth account's is its fourth trial.
  for (const account of ['a', 'b', 'c', 'd']) await feedback.observeFeedback(event(account, 'result-corrected', '2026-10-04T02:00:00Z', { kind: 'analytic' }));
  harm = (await f.service.get('tool')).payload.usage.harm;
  assert.deepEqual({ trials: harm.trials.length, bad: harm.bad, state: harm.state }, { trials: 4, bad: 4, state: 'harm' });
  assert.equal(proposals.length, 1);
  // A presentation change is not a verdict on the analysis.
  assert.equal((await feedback.observeFeedback({ ...event('a', 'result-corrected', '2026-10-04T03:00:00Z', { kind: 'presentation' }), id: 'restyle' })).observed, 0);
});

test('every run keeps its own record: the tool record stays small and concurrent calls are not lost', async () => {
  const f = evolutionServiceFixture(), maintenance = await tool(f);
  // Integration finding F16: at about 500 runs the tool record passed 256 KiB and every later save was refused.
  for (let run = 1; run <= 1500; run++) {
    f.advance(1);
    await maintenance.observe('tool', { runId: `run_${String(run).padStart(32, '0')}`, userId: `account-${run % 300}`, callId: `session_${run}:call_${String(run).padStart(24, '0')}`, invoked: true, executionOk: true, outcome: 'accepted', feedbackEventId: `evt_${run}`, feedbackOccurredAt: '2026-10-04T00:00:00Z', feedbackKind: 'deliverable-adopted', causalBenefit: 'unproven' });
  }
  let row = await f.service.get('tool');
  assert.equal(row.payload.usage.invoked, 1500);
  assert.equal(row.payload.usage.runs, 1500);
  assert.equal(row.payload.observations, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(row.payload)) < 16 * 1024, `tool record is ${Buffer.byteLength(JSON.stringify(row.payload))} bytes`);
  assert.ok(row.payload.usage.harm.trials.length <= EVOLUTION_TOOL_HARM_TEST.maxRuns);
  assert.equal((await maintenance.observationOf('tool', `run_${String(7).padStart(32, '0')}`)).outcome, 'accepted');
  // Forty runs call the tool at the same moment. One shared array used to keep one of them.
  await Promise.all(Array.from({ length: 40 }, (_, index) => maintenance.observe('tool', { runId: `burst-${index}`, userId: `burst-account-${index}`, callId: `burst-call-${index}`, invoked: true, executionOk: index % 4 !== 0, outcome: 'pending' })));
  row = await f.service.get('tool');
  assert.equal(row.payload.usage.invoked, 1540);
  assert.equal(row.payload.usage.executionFailed, 10);
  // The same call reported twice, and two calls of one run at once, are counted once each.
  await Promise.all([1, 2, 1, 2, 3].map(call => maintenance.observe('tool', { runId: 'same-run', userId: 'same', callId: `same-call-${call}`, invoked: true, executionOk: true, outcome: 'pending' })));
  assert.equal((await f.service.get('tool')).payload.usage.invoked, 1543);
  // A run that loops over one tool cannot grow its own record without bound either.
  for (let call = 0; call < 520; call++) await maintenance.observe('tool', { runId: 'looping-run', userId: 'looper', callId: `loop-${call}`, invoked: true, outcome: 'pending' });
  const looping = await maintenance.observationOf('tool', 'looping-run');
  assert.deepEqual({ remembered: looping.callIds.length, overflow: looping.callOverflow }, { remembered: 500, overflow: 20 });
  assert.equal((await f.service.get('tool')).payload.usage.invoked, 1543 + 520);
});

test('a record written before runs had their own is moved once, and its unattributed runs are not trials', async () => {
  const f = evolutionServiceFixture(), maintenance = await tool(f);
  const legacy = await f.service.get('tool');
  await f.service.save('tool', 'tool', { ...legacy.payload, usage: { ...legacy.payload.usage, invoked: 3, runs: 3, corrected: 3, harmState: 'watching', harmEpochs: [{ index: 0, runIds: ['old-1', 'old-2'], state: 'watching' }] },
    observations: [1, 2, 3].map(index => ({ runId: `old-${index}`, invoked: true, outcome: 'rejected', corrected: true, callIds: [`old-call-${index}`], callOutcomes: {}, retrievalIds: [], at: `2026-10-0${index}T00:00:00.000Z` })) }, legacy);
  await maintenance.observe('tool', { runId: 'new-run', userId: 'a', callId: 'new-call', invoked: true, executionOk: true, outcome: 'pending' });
  const row = await f.service.get('tool');
  assert.equal(row.payload.observations, undefined);
  assert.equal(row.payload.usage.harmEpochs, undefined);
  assert.equal(row.payload.usage.invoked, 4, 'legacy runs stay counted, once');
  assert.equal(row.payload.usage.harm.trials.length, 0);
  assert.equal(row.payload.status, 'active');
  assert.equal((await maintenance.observationOf('tool', 'old-2')).outcome, 'rejected');
});
