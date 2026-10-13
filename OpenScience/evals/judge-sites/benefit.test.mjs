import assert from 'node:assert/strict';
import test from 'node:test';
import { BENEFIT_RULE, decideSite, hybridOf, percentile, rowsDigest, siteConditions, summarizeSite } from './benefit.mjs';
import { lowerConfidenceBound } from './statistics.mjs';

/** A row the way `run.mjs --incumbent` writes it. */
const row = (id, { outcome = 'settled', correct = true, ms = 300, cost = 0.0001, hybrid = correct, incumbent = { correct: true, ms: 700, cost: 0.004 } } = {}) => ({
  id, outcome, correct, ms, cost, hybridCorrect: hybrid, incumbent,
});
const many = (count, make) => Array.from({ length: count }, (_, i) => make(i));

test('the rule states the two numbers it applies to every site, and they are the ones the pins and J3 were recorded against', () => {
  assert.equal(BENEFIT_RULE.qualificationBar, 0.95);
  assert.equal(BENEFIT_RULE.marginPoints, 0.02);
  assert.match(BENEFIT_RULE.statement, /0\.95/);
  assert.match(BENEFIT_RULE.statement, /0\.02/);
});

test('percentiles are nearest-rank and ignore what is not a number', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 100], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.equal(percentile([10, undefined, NaN, 20], 50), 10);
});

test('a summary counts settled, correct among settled, the lower bound, the site with Jev on and the pairs', () => {
  const rows = [
    ...many(70, (i) => row(`s${i}`)),
    // Unsettled: Jev's top choice was wrong or right, the site's original path answered, the incumbent as it did.
    row('u1', { outcome: 'escalated', correct: false, hybrid: true, incumbent: { correct: true, ms: 650, cost: 0.004 } }),
    row('u2', { outcome: 'escalated', correct: true, hybrid: false, incumbent: { correct: true, ms: 900, cost: 0.004 } }),
    // A call that never answered: no verdict of Jev's, no latency, and the original path answered.
    { id: 'u3', outcome: 'fallback', hybridCorrect: true, incumbent: { correct: true, ms: 800, cost: 0.004 } },
  ];
  const summary = summarizeSite(rows);
  assert.equal(summary.cases, 73);
  assert.deepEqual([summary.jev.measured, summary.jev.settled, summary.jev.correctSettled], [72, 70, 70]);
  assert.equal(summary.jev.lower95, lowerConfidenceBound(70, 70));
  assert.equal(summary.jev.failures, 1);
  assert.equal(summary.jev.ms.n, 72, 'a call that never answered has no latency');
  assert.equal(summary.incumbent.measured, 73);
  assert.equal(summary.incumbent.correct, 73);
  assert.deepEqual([summary.hybrid.measured, summary.hybrid.correct], [73, 72]);
  assert.deepEqual(summary.paired, { n: 73, hybridOnly: 0, incumbentOnly: 1, bothRight: 72, bothWrong: 0 }, 'u2 is the one the incumbent got and the site did not');
});

test('a site that meets the bar, is not worse than the incumbent and is faster is switched on', () => {
  const summary = summarizeSite(many(100, (i) => row(`c${i}`)));
  const verdict = decideSite(summary);
  assert.equal(verdict.decision, 'on');
  assert.deepEqual(verdict.checks.map((check) => [check.id, check.ok]), [['qualification', true], ['non-inferiority', true], ['benefit', true]]);
  assert.deepEqual(verdict.reasons, []);
});

test('each of the three conditions keeps the original path on its own, and says which', () => {
  // Too few settled-correct to reach 0.95 (58 of 58 is 0.9505 only from 59).
  assert.equal(decideSite(summarizeSite(many(58, (i) => row(`c${i}`)))).checks[0].ok, false);
  assert.equal(decideSite(summarizeSite(many(59, (i) => row(`c${i}`)))).checks[0].ok, true);
  // One settled answer wrong among 100 still clears 0.95 (0.9534); two do not (0.9384).
  const oneWrong = many(100, (i) => row(`c${i}`, i === 0 ? { correct: false, hybrid: false } : {}));
  assert.equal(decideSite(summarizeSite(oneWrong)).checks[0].ok, true);
  const twoWrong = many(100, (i) => row(`c${i}`, i < 2 ? { correct: false, hybrid: false } : {}));
  const wrong = decideSite(summarizeSite(twoWrong));
  assert.equal(wrong.decision, 'original-path');
  assert.match(wrong.reasons[0], /^qualification: settled-correct 98\/100, lower95 0\.9384 against the bar 0\.95/);
  // The site with Jev on is worse than the incumbent by more than the margin, though every settled answer is right.
  const worse = many(100, (i) => row(`c${i}`, i < 70 ? {} : { outcome: 'escalated', correct: true, hybrid: false }));
  const behind = decideSite(summarizeSite(worse));
  assert.equal(behind.checks.find((check) => check.id === 'non-inferiority')?.ok, false);
  assert.match(behind.reasons.join('\n'), /non-inferiority: site with Jev on 0\.7000 against incumbent 1\.0000 less the margin 0\.02/);
  // Right, but neither faster nor cheaper nor more accurate.
  const nothing = many(100, (i) => row(`c${i}`, { ms: 900, cost: 0.01 }));
  const none = decideSite(summarizeSite(nothing));
  assert.equal(none.checks.find((check) => check.id === 'benefit')?.ok, false);
  assert.equal(none.decision, 'original-path');
});

test('the margin is two points: exactly two below is allowed, anything more is not', () => {
  const build = (wrongHybrid) => many(100, (i) => row(`c${i}`, { hybrid: i >= wrongHybrid, correct: true }));
  assert.equal(decideSite(summarizeSite(build(2))).checks[1].ok, true);
  assert.equal(decideSite(summarizeSite(build(3))).checks[1].ok, false);
});

test('cheaper alone, or more accurate alone, is a benefit; a site never measured against its incumbent is not switched on', () => {
  const cheapOnly = many(100, (i) => row(`c${i}`, { ms: 2000, cost: 0.00001 }));
  assert.equal(decideSite(summarizeSite(cheapOnly)).checks[2].ok, true);
  const accurate = many(100, (i) => row(`c${i}`, { ms: 2000, cost: 0.01, incumbent: { correct: i > 5, ms: 700, cost: 0.004 } }));
  assert.equal(decideSite(summarizeSite(accurate)).checks[2].ok, true);
  const unmeasured = many(100, (i) => ({ id: `c${i}`, outcome: 'settled', correct: true, ms: 300, cost: 0.0001, hybridCorrect: true }));
  const verdict = decideSite(summarizeSite(unmeasured));
  assert.equal(verdict.decision, 'original-path');
  assert.match(verdict.reasons.join('\n'), /not measured on these cases/);
});

test('a bar the site\'s own record states replaces the settled-correct bar, and a broken constraint keeps the original path', () => {
  const summary = summarizeSite(many(100, (i) => row(`c${i}`, i < 40 ? {} : { outcome: 'escalated', correct: true, hybrid: true })));
  assert.equal(decideSite(summary).checks[0].id, 'qualification');
  assert.equal(decideSite(summary).checks[0].ok, false, '40 settled, all right, reach 0.9278 and not 0.95 on their own');
  const recorded = decideSite(summary, { extraBar: { id: 'final-route-bar', ok: true, detail: 'final lower95 against the incumbent less 0.02' } });
  assert.equal(recorded.checks[0].id, 'final-route-bar');
  assert.equal(recorded.decision, 'on');
  const constrained = decideSite(summary, { extraBar: { id: 'final-route-bar', ok: true, detail: 'ok' },
    constraints: [{ id: 'title-to-paper', ok: false, detail: '1 of 50 title-only requests was routed to a specialist' }] });
  assert.equal(constrained.decision, 'original-path');
  assert.deepEqual(constrained.reasons, ['title-to-paper: 1 of 50 title-only requests was routed to a specialist']);
});

test('a digest binds the rows in order', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  assert.equal(rowsDigest(rows), rowsDigest(structuredClone(rows)));
  assert.notEqual(rowsDigest(rows), rowsDigest([...rows].reverse()));
  assert.match(rowsDigest(rows), /^[a-f0-9]{64}$/);
});

test('what a decision takes with the site on counts the original path wherever the caller still asks it after Jev', () => {
  const settled = { outcome: 'settled', ms: 200, cost: 0.001, incumbent: { ms: 700, cost: 0.0007 } };
  const unsettled = { ...settled, outcome: 'escalated' };
  const failed = { ...settled, outcome: 'fallback' };
  // A cascade (J2, J5, J6, the engines): Jev always, and the original path for what Jev did not settle.
  assert.deepEqual(hybridOf('J2', settled), { ms: 200, cost: 0.001, asked: false });
  const again = hybridOf('J2', unsettled);
  assert.deepEqual([again.ms, again.asked], [900, true]);
  assert.ok(Math.abs(again.cost - 0.0017) < 1e-12);
  // J3 leaves an unsure answer on the ordinary line, which is no model call, and asks the original classifier only when Jev failed.
  assert.equal(hybridOf('J3', unsettled).asked, false);
  assert.equal(hybridOf('J3', failed).asked, true);
  // J4's original path is no notice at all.
  assert.equal(hybridOf('J4', unsettled).asked, false);
});

test('a cascade whose Jev call is mostly unsettled is slower and dearer than the original path alone, and the benefit check sees it', () => {
  // J5's shape: Jev settles almost nothing, so every decision pays for Jev and for the original path.
  const rows = many(100, (i) => row(`c${i}`, { outcome: i < 4 ? 'settled' : 'escalated', correct: true, hybrid: true, ms: 250, cost: 0.003, incumbent: { correct: true, ms: 900, cost: 0.005 } }));
  const summary = summarizeSite(rows, { site: 'J5' });
  assert.equal(summary.hybrid.ms.p50, 1150);
  assert.ok(summary.hybrid.costCnyPerCall > summary.incumbent.costCnyPerCall);
  const benefit = decideSite(summary).checks.find((check) => check.id === 'benefit');
  assert.equal(benefit?.ok, false);
  assert.match(benefit?.detail ?? '', /with the site on: faster false \(p50 1150 against 900 ms\), cheaper false/);
  // The same rows for a site that does not ask the original path afterwards are judged on Jev alone.
  assert.equal(summarizeSite(rows, { site: 'J4' }).hybrid.ms.p50, 250);
});

test('J3 is decided by the plan\'s two launch conditions and by not being slower, not by the settled-subset bar', () => {
  const rows = (/** @type {{ misrouted?: number, jevFalse?: number, flashFalse?: number, titleToPaper?: number, jevMs?: number }} */ options = {}) => {
    const { misrouted = 0, jevFalse = misrouted, flashFalse = 0, titleToPaper = 50, jevMs = 220 } = options;
    return [
      ...many(titleToPaper, (i) => ({ ...row(`p${i}`, { ms: jevMs, cost: 0.0015, incumbent: { correct: true, ms: 740, cost: 0.004 } }), tag: 'title-to-paper', falseSpecialist: i < misrouted, baselineFalseSpecialist: false })),
      ...many(40, (i) => ({ ...row(`q${i}`, { outcome: i < 20 ? 'settled' : 'escalated', correct: true, hybrid: true, ms: jevMs, cost: 0.0015, incumbent: { correct: true, ms: 740, cost: 0.004 } }),
        tag: 'regression', falseSpecialist: i >= 40 - (jevFalse - misrouted), baselineFalseSpecialist: i < flashFalse })),
    ];
  };
  const decide = (/** @type {any} */ input) => {
    const data = rows(input);
    const summary = summarizeSite(data, { site: 'J3' });
    const { extraBar, constraints } = siteConditions('J3', data, summary);
    return decideSite(summary, { extraBar, constraints });
  };
  const good = decide({});
  assert.equal(good.decision, 'on');
  assert.equal(good.checks[0].id, 'plan-launch-conditions');
  assert.match(good.checks[0].detail, /0 of 50 title-to-paper questions routed to a specialist; ordinary questions sent to a specialist: Jev 0, Flash 0/);
  // One title-to-paper question sent to a specialist is enough.
  assert.equal(decide({ misrouted: 1 }).decision, 'original-path');
  assert.match(decide({ misrouted: 1 }).reasons[0], /plan-launch-conditions: 1 of 50 title-to-paper/);
  // More ordinary questions sent to a specialist than Flash does.
  assert.equal(decide({ jevFalse: 2, flashFalse: 1 }).decision, 'original-path');
  assert.equal(decide({ jevFalse: 1, flashFalse: 1 }).decision, 'on', 'no more often than Flash is enough');
  // A corpus without its 50 title-to-paper questions has not shown the condition.
  assert.equal(decide({ titleToPaper: 49 }).decision, 'original-path');
  // Slower than Flash on the online path.
  const slow = decide({ jevMs: 800 });
  assert.equal(slow.decision, 'original-path');
  assert.match(slow.reasons.join('\n'), /not-slower/);
});

test('J4 is also held to the plan\'s condition of no false notice on real non-clinical report sentences', () => {
  const line = (/** @type {string} */ id, /** @type {string} */ source, /** @type {boolean} */ leak, /** @type {boolean} */ label) => ({ ...row(id, { correct: leak === label, hybrid: leak === label }), source, jev: { leakage: leak }, label: { leakage: label } });
  const rows = [...many(60, (i) => line(`c${i}`, 'preserved-report', false, false)), ...many(40, (i) => line(`n${i}`, 'nonclinical-delivered-report', false, false))];
  const verdict = (/** @type {any[]} */ data) => { const summary = summarizeSite(data, { site: 'J4' }); return decideSite(summary, siteConditions('J4', data, summary)); };
  assert.equal(verdict(rows).decision, 'on');
  const noisy = [...rows.slice(0, 99), line('n-fp', 'nonclinical-delivered-report', true, false)];
  const failing = verdict(noisy);
  assert.equal(failing.decision, 'original-path');
  assert.match(failing.reasons.join('\n'), /nonclinical-false-notices: 1 false notices among 40 non-clinical sentences/);
  // A clinical false notice is a qualification matter, not this condition.
  const clinical = [line('c-fp', 'preserved-report', true, false), ...rows.slice(1)];
  assert.equal(siteConditions('J4', clinical, summarizeSite(clinical, { site: 'J4' })).constraints[0].ok, true);
  // Sites with no named conditions have none.
  assert.deepEqual(siteConditions('J2', rows, summarizeSite(rows)), { extraBar: null, constraints: [], basis: null });
});

test('J5 and J6 carry the plan\'s launch conditions as checks: the lane incidents with the calibrated value nobody recorded, and the eleven same-event incidents read as the caller reads Jev', () => {
  const j5 = [...many(5, (i) => ({ ...row(`incident-${i}`, { outcome: 'escalated', correct: false, hybrid: true }), releaseEligible: true })), ...many(5, (i) => ({ ...row(`snapshot-${i}`, { outcome: 'escalated', correct: false, hybrid: false }), releaseEligible: false }))];
  const five = siteConditions('J5', j5, summarizeSite(j5, { site: 'J5' }));
  assert.equal(five.extraBar?.ok, false, 'the calibrated agreement value was never recorded, so the second condition cannot be shown');
  assert.match(five.extraBar?.detail ?? '', /^5 of 5 lane incident cases pass with the site on; the calibrated agreement value/);
  const failing = j5.map((entry, i) => (i === 0 ? { ...entry, hybridCorrect: false } : entry));
  assert.match(siteConditions('J5', failing, summarizeSite(failing, { site: 'J5' })).extraBar?.detail ?? '', /^4 of 5/);

  const incident = (/** @type {number} */ i, /** @type {any} */ label, /** @type {string} */ outcome, /** @type {string} */ relation) => ({ ...row(`incident-${i}`, { outcome }), releaseEligible: true, label, jev: { relation } });
  const eleven = [
    ...many(4, (i) => incident(i, { relation: 'different' }, 'escalated', 'related')),   // an unsure answer is read as different
    ...many(2, (i) => incident(10 + i, { relation: ['related', 'different'] }, 'settled', 'related')),
    ...many(5, (i) => incident(20 + i, { relation: 'same' }, 'settled', 'same')),
  ];
  const read = siteConditions('J6', eleven, summarizeSite(eleven, { site: 'J6' }));
  assert.equal(read.extraBar?.ok, true);
  assert.match(read.extraBar?.detail ?? '', /^11 of 11 same-event incident cases pass/);
  // A same-event pair Jev was unsure of is a missed merge.
  const missed = eleven.map((entry, i) => (i === 7 ? { ...entry, outcome: 'escalated' } : entry));
  const miss = siteConditions('J6', missed, summarizeSite(missed, { site: 'J6' }));
  assert.equal(miss.extraBar?.ok, false);
  assert.match(miss.extraBar?.detail ?? '', /^10 of 11/);
});
