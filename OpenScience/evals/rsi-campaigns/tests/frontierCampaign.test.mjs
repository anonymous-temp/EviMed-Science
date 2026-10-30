import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { replayFrontierPool } from '../frontier_selection.mjs';
import { FRONTIER_DAYS_SCHEMA, chooseFrontierCandidate, evaluateFrontierDays, frontierCampaignConsumerIdentity, frontierDaysIssues, frontierLabelPlan, frontierLabelSet, frontierObservations } from '../frontier_campaign.mjs';
import { benignCampaignFixture, frontierDayPool, frontierRow } from '../profiles/benign_fixture.mjs';

const DAY = '2026-10-01';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A day of unsummarised rows from distinct sources: only a score at or above the threshold selects a row. */
const scored = (scores, extra = {}) => frontierDayPool(DAY, Object.entries(scores).map(([id, score_total]) => frontierRow(id, DAY, { score_total, ...(extra[id] ?? {}) })));
const source = (days, labels, band = { floor: 60, pickWeight: 3 }) => ({ kind: 'frontier-days', schema: FRONTIER_DAYS_SCHEMA, days, labels: Object.entries(labels).map(([id, worth]) => ({ id, worth })), band });
const registration = { baselineThreshold: 64, thresholds: [68], minLabelled: 1 };
/** a(80 pick) b(70 ok) c(66 pick) d(61 no): the baseline line 64 takes a, b, c; the line 68 takes a, b. */
const tiny = (band) => source([scored({ a: 80, b: 70, c: 66, d: 61 })], { a: 'pick', b: 'ok', c: 'pick', d: 'no' }, band);

test('the day endpoint is weighted accuracy over the labelled set, a pick weighing the band weight', () => {
  const evaluation = evaluateFrontierDays(tiny(), registration);
  assert.equal(evaluation.eligible, true);
  const [day] = evaluation.days;
  assert.equal(day.labelSet, 4);
  // weights: a 3, b 1, c 3, d 1 = 8. Baseline (a, b, c chosen): a and c right (6), d right (1), b wrong -> 7/8.
  assert.equal(day.arms['64'].quality, 7 / 8);
  assert.deepEqual([day.arms['64'].picks, day.arms['64'].missed, day.arms['64'].extra, day.arms['64'].selected], [2, 0, 1, 3]);
  // Candidate (a, b chosen): a right (3), d right (1), b wrong, c a missed pick -> 4/8.
  assert.equal(day.arms['68'].quality, 4 / 8);
  assert.deepEqual([day.arms['68'].picks, day.arms['68'].missed, day.arms['68'].extra, day.arms['68'].selected], [2, 1, 1, 2]);
  // With every row weighing one the same choices score 3/4 and 2/4: the pick weight is what moved the figures.
  const flat = evaluateFrontierDays(tiny({ floor: 60, pickWeight: 1 }), registration).days[0];
  assert.equal(flat.arms['64'].quality, 3 / 4);
  assert.equal(flat.arms['68'].quality, 2 / 4);
  assert.equal(day.arms['68'].selectedDigest, sha(JSON.stringify(['a', 'b'])));
});

test('an ok or no label is simply not a pick: choosing it is wrong, leaving it is right', () => {
  const only = source([scored({ a: 80, b: 70 })], { a: 'ok', b: 'no' });
  const day = evaluateFrontierDays(only, { baselineThreshold: 64, thresholds: [75], minLabelled: 1 }).days[0];
  assert.equal(day.arms['64'].quality, 0);
  assert.equal(day.arms['75'].quality, 0.5);
  assert.equal(day.arms['64'].picks, 0);
});

test('the labelled set depends on the replays, the floor and safety alerts, never on the labels', () => {
  const pool = scored({ a: 80, b: 70, c: 66, d: 61, e: 59, f: 40 });
  pool.rows.push(frontierRow('alert', DAY, { genre: 'safety', safety_alert: true, selected: true, selected_rule: 'safety', evidence_type: 'safety-notice', score_total: 5 }));
  const labelings = [
    { a: 'pick', b: 'ok', c: 'pick', d: 'no', e: 'no', f: 'no', alert: 'pick' },
    { a: 'no', b: 'no', c: 'no', d: 'no', e: 'pick', f: 'pick', alert: 'no' },
    {},
  ];
  const sets = labelings.map((labels) => evaluateFrontierDays(source([pool], labels), registration).days[0]);
  // Scores 80/70/66/61 reach the floor of 60, the alert is safety: five rows, whatever anyone said about them. 59 and 40 stay out.
  for (const day of sets) assert.equal(day.labelSet, 5);
  // Labels on rows outside the set (e, f) are ignored: they count neither as labelled nor as abstained.
  assert.deepEqual(sets.map((day) => day.labelled), [5, 5, 0]);
  assert.deepEqual(sets.map((day) => day.abstained), [0, 0, 5]);
  const replays = new Map([[64, new Set(replayFrontierPool(pool, 64).selectedIds)], [68, new Set(replayFrontierPool(pool, 68).selectedIds)]]);
  assert.deepEqual([...frontierLabelSet(pool, replays, 60)].sort(), ['a', 'alert', 'b', 'c', 'd']);
  // Raising the floor above everything leaves the replays and the alert: rows any registered threshold selects are always in.
  assert.deepEqual([...frontierLabelSet(pool, replays, 99)].sort(), ['a', 'alert', 'b', 'c']);
});

test('labelThresholds widen the labelled set without measuring those thresholds', () => {
  // The floor is 75, the baseline line is 70: row m (65) is below both, but a registered line of 60 would select it.
  const pool = scored({ hi: 90, mid: 72, m: 65 });
  const labels = { hi: 'pick', mid: 'ok', m: 'pick' };
  const plain = evaluateFrontierDays(source([pool], labels, { floor: 75, pickWeight: 3 }), { baselineThreshold: 70, thresholds: [], minLabelled: 1 });
  assert.equal(plain.days[0].labelSet, 2);
  const widened = evaluateFrontierDays(source([pool], labels, { floor: 75, pickWeight: 3 }), { baselineThreshold: 70, thresholds: [], labelThresholds: [60], minLabelled: 1 });
  assert.equal(widened.days[0].labelSet, 3);
  assert.deepEqual(Object.keys(widened.days[0].arms), ['70'], 'the label threshold is replayed for the set only: it has no arm');
  assert.deepEqual(widened.thresholds, [70]);
  // The set is the same whichever arm is measured: measuring the 60 line itself adds nothing further.
  const measured = evaluateFrontierDays(source([pool], labels, { floor: 75, pickWeight: 3 }), { baselineThreshold: 70, thresholds: [60], minLabelled: 1 });
  assert.equal(measured.days[0].labelSet, 3);
  // The 60 line takes all three rows: hi and m are right (3 + 3), mid is an adequate item taken (wrong, 1) -> 6/7.
  assert.equal(measured.days[0].arms['60'].quality, 6 / 7);
});

test('a day with too few labelled rows is not measured and its abstentions are counted', () => {
  const base = source([scored({ a: 80, b: 70, c: 66, d: 61 })], { a: 'pick', b: null, c: 'pick' });
  const loose = evaluateFrontierDays(base, { ...registration, minLabelled: 2 }).days[0];
  assert.deepEqual([loose.labelSet, loose.labelled, loose.abstained, loose.measured], [4, 2, 2, true]);
  assert.equal(evaluateFrontierDays(base, { ...registration, minLabelled: 3 }).days[0].measured, false);
  // The registered minimum defaults to twenty labelled rows.
  assert.equal(evaluateFrontierDays(base, { baselineThreshold: 64, thresholds: [68] }).days[0].measured, false);
  // Labels are digested as given.
  const changed = evaluateFrontierDays({ ...base, labels: base.labels.slice(0, 2) }, registration);
  assert.notEqual(evaluateFrontierDays(base, registration).labelsDigest, changed.labelsDigest);
});

test('replay fidelity is the overlap of the baseline replay with what production selected', () => {
  const pool = scored({ a: 80, b: 70, c: 66, d: 61 }, { a: { production_selected: true }, b: { production_selected: true } });
  const day = evaluateFrontierDays(source([pool], { a: 'pick' }), registration).days[0];
  assert.equal(day.productionSelected, 2);
  assert.equal(day.replayFidelity, 2 / 3, 'baseline {a, b, c} against production {a, b}: two of three');
  const exact = scored({ a: 80, b: 70, c: 66, d: 61 }, { a: { production_selected: true }, b: { production_selected: true }, c: { production_selected: true } });
  assert.equal(evaluateFrontierDays(source([exact], { a: 'pick' }), registration).days[0].replayFidelity, 1);
});

test('days are reported in date order whatever order the source lists them', () => {
  const later = frontierDayPool('2026-10-03', [frontierRow('z', '2026-10-03', { score_total: 80 })]);
  const earlier = frontierDayPool('2026-10-02', [frontierRow('y', '2026-10-02', { score_total: 80 })]);
  const evaluation = evaluateFrontierDays(source([later, earlier], { z: 'pick', y: 'pick' }), registration);
  assert.deepEqual(evaluation.days.map((day) => day.day), ['2026-10-02', '2026-10-03']);
});

test('an incomplete pool makes the source ineligible and nothing downstream proceeds', () => {
  const bad = scored({ a: 80, b: 70 });
  bad.complete = false;
  const evaluation = evaluateFrontierDays(source([bad], { a: 'pick' }), registration);
  assert.equal(evaluation.eligible, false);
  assert.deepEqual(evaluation.issues, ['frontier_day_pool_incomplete']);
  assert.equal(evaluation.day, DAY);
  assert.ok(evaluation.missing.includes('complete'));
  assert.deepEqual(chooseFrontierCandidate(evaluation, registration), { frozen: null, reason: 'campaign_consumer_failed', candidates: [] });
  assert.deepEqual(frontierObservations(evaluation, registration, 68), { observations: null, reason: 'campaign_consumer_failed' });
  const plan = frontierLabelPlan([bad], registration, 60);
  assert.deepEqual([plan.eligible, plan.day], [false, DAY]);
  assert.ok(plan.missing.includes('complete'));
  // One incomplete day among good ones still refuses the whole source: a missing day is never imputed.
  const good = frontierDayPool('2026-10-02', [frontierRow('y', '2026-10-02', { score_total: 80 })]);
  assert.equal(evaluateFrontierDays(source([good, bad], { a: 'pick', y: 'pick' }), registration).eligible, false);
  // A row missing a consumed field is the same refusal.
  const missingField = scored({ a: 80 });
  delete missingField.rows[0].evidence_type;
  const refused = evaluateFrontierDays(source([missingField], { a: 'pick' }), registration);
  assert.equal(refused.eligible, false);
  assert.ok(refused.missing.some((item) => item.includes('evidence_type')));
});

test('a non-finite threshold is refused before any replay', () => {
  assert.deepEqual(evaluateFrontierDays(tiny(), { ...registration, thresholds: [Number.NaN] }), { eligible: false, issues: ['frontier_thresholds_invalid'] });
  assert.deepEqual(evaluateFrontierDays(tiny(), { ...registration, labelThresholds: [Infinity] }), { eligible: false, issues: ['frontier_thresholds_invalid'] });
});

test('the source contract names every malformed shape', () => {
  assert.deepEqual(frontierDaysIssues(tiny()), []);
  assert.deepEqual(frontierDaysIssues(null), ['frontier_days_invalid']);
  assert.deepEqual(frontierDaysIssues({ ...tiny(), kind: 'frontier-day' }), ['frontier_days_invalid']);
  assert.deepEqual(frontierDaysIssues({ ...tiny(), schema: 2 }), ['frontier_days_invalid']);
  assert.ok(frontierDaysIssues({ ...tiny(), days: [] }).includes('frontier_days_empty'));
  const duplicate = tiny();
  duplicate.days.push(duplicate.days[0]);
  assert.deepEqual(frontierDaysIssues(duplicate), ['frontier_days_duplicate']);
  assert.ok(frontierDaysIssues({ ...tiny(), labels: undefined }).includes('frontier_labels_missing'));
  for (const labels of [[{ id: 'a', worth: 'great' }], [{ id: 'a', worth: 'pick' }, { id: 'a', worth: 'ok' }], [{ id: 7, worth: 'pick' }], [null]]) {
    assert.deepEqual(frontierDaysIssues({ ...tiny(), labels }), ['frontier_labels_invalid']);
  }
  assert.deepEqual(frontierDaysIssues({ ...tiny(), labels: [{ id: 'a', worth: null }] }), [], 'an abstention is a valid label');
  for (const band of [undefined, { floor: 60 }, { floor: 60, pickWeight: 0.5 }, { floor: 60, pickWeight: 11 }, { floor: Number.NaN, pickWeight: 3 }]) {
    assert.deepEqual(frontierDaysIssues({ ...tiny(), band }), ['frontier_band_invalid']);
  }
  // The evaluation carries the same refusal as `issues`.
  assert.deepEqual(evaluateFrontierDays({ ...tiny(), band: undefined }, registration), { eligible: false, issues: ['frontier_band_invalid'] });
});

test('development freezes the highest mean day difference, never a candidate that does not improve', () => {
  // Two days: a higher line helps on one and costs a missed pick on the other.
  const good = scored({ a: 90, b: 67 });
  const other = frontierDayPool('2026-10-02', [frontierRow('c', '2026-10-02', { score_total: 90 }), frontierRow('d', '2026-10-02', { score_total: 66 })]);
  const evaluation = evaluateFrontierDays(source([good, other], { a: 'pick', b: 'no', c: 'pick', d: 'no' }), { baselineThreshold: 64, thresholds: [60, 68, 95], minLabelled: 1 });
  const choice = chooseFrontierCandidate(evaluation, { baselineThreshold: 64, thresholds: [60, 68, 95] });
  const byThreshold = Object.fromEntries(choice.candidates.map((row) => [row.threshold, row]));
  assert.equal(byThreshold[68].meanDifference, 0.25 * 2 / 2, 'both days: baseline picks the extra row, the 68 line does not: +0.25 each');
  assert.ok(byThreshold[60].meanDifference <= 0);
  assert.ok(byThreshold[95].meanDifference < 0, 'a line above every pick loses them');
  assert.deepEqual(choice.frozen, { threshold: 68 });
  assert.equal(choice.reason, null);
  assert.equal(byThreshold[68].days, 2);
  // With no candidate above the baseline nothing is frozen, and the reason is a verdict.
  const none = chooseFrontierCandidate(evaluation, { baselineThreshold: 64, thresholds: [60, 95] });
  assert.deepEqual([none.frozen, none.reason], [null, 'campaign_no_improving_candidate']);
});

test('equal improvements go to the threshold nearest the baseline, then to the lower one', () => {
  // Real replays: lines 66 and 70 select exactly the same rows on this day, so their quality is the same.
  const pool = scored({ hi: 80, near: 65 });
  const labels = { hi: 'pick', near: 'no' };
  const regs = (thresholds) => ({ baselineThreshold: 64, thresholds, minLabelled: 1 });
  for (const thresholds of [[70, 66], [66, 70]]) {
    const evaluation = evaluateFrontierDays(source([pool], labels), regs(thresholds));
    assert.equal(evaluation.days[0].arms['66'].quality, evaluation.days[0].arms['70'].quality);
    assert.equal(evaluation.days[0].arms['66'].selectedDigest, evaluation.days[0].arms['70'].selectedDigest);
    assert.deepEqual(chooseFrontierCandidate(evaluation, regs(thresholds)).frozen, { threshold: 66 }, `registered as ${thresholds}`);
  }
  // Pure ties on an evaluation: equal distance (60 and 68 around 64) goes to the lower threshold.
  const arm = (quality) => ({ quality, selected: 3, lostSafety: [] });
  const evaluation = { eligible: true, days: [{ day: DAY, measured: true, arms: { 64: arm(0.5), 60: arm(0.6), 68: arm(0.6), 70: arm(0.6) } }] };
  assert.deepEqual(chooseFrontierCandidate(evaluation, { baselineThreshold: 64, thresholds: [70, 68, 60] }).frozen, { threshold: 60 });
  assert.deepEqual(chooseFrontierCandidate(evaluation, { baselineThreshold: 64, thresholds: [70, 68] }).frozen, { threshold: 68 });
  // A better mean beats nearness.
  evaluation.days[0].arms[70] = arm(0.9);
  assert.deepEqual(chooseFrontierCandidate(evaluation, { baselineThreshold: 64, thresholds: [60, 68, 70] }).frozen, { threshold: 70 });
});

test('the volume guard excludes a candidate that selects too much, however well it scores', () => {
  // The baseline line 70 misses the pick `mid`; the line 60 finds it but selects twice what the baseline does.
  const pool = scored({ hi: 90, mid: 65 });
  const labels = { hi: 'pick', mid: 'pick' };
  const reg = { baselineThreshold: 70, thresholds: [60], minLabelled: 1 };
  const evaluation = evaluateFrontierDays(source([pool], labels), reg);
  assert.equal(evaluation.days[0].arms['60'].quality, 1);
  assert.equal(evaluation.days[0].arms['70'].quality, 0.5);
  const refused = chooseFrontierCandidate(evaluation, reg);
  assert.deepEqual([refused.frozen, refused.reason], [null, 'campaign_no_improving_candidate']);
  assert.deepEqual([refused.candidates[0].volumeRatio, refused.candidates[0].eligible], [2, false], 'the default ceiling is 1.1 of the baseline volume');
  assert.deepEqual(chooseFrontierCandidate(evaluation, { ...reg, maxVolumeRatio: 1.9 }).frozen, null);
  assert.deepEqual(chooseFrontierCandidate(evaluation, { ...reg, maxVolumeRatio: 2 }).frozen, { threshold: 60 }, 'a ratio equal to the ceiling is allowed');
});

test('a candidate that loses a baseline safety pick is never frozen and its lost picks are the critical violations', () => {
  // The replay keeps a sticky alert at every line, so a lost alert is built here from an evaluation, the function's own input.
  const arm = (quality, selected, lostSafety = []) => ({ quality, selected, lostSafety });
  const evaluation = { eligible: true, days: [
    { day: '2026-10-01', measured: true, arms: { 64: arm(0.5, 4), 72: arm(0.9, 2, ['s1']), 76: arm(0.7, 2) } },
    { day: '2026-10-02', measured: true, arms: { 64: arm(0.5, 4), 72: arm(0.9, 2, ['s2']), 76: arm(0.6, 2) } },
  ] };
  const reg = { baselineThreshold: 64, thresholds: [72, 76], statistics: { groups: [{ id: 'g1', day: '2026-10-01' }, { id: 'g2', day: '2026-10-02' }] } };
  const choice = chooseFrontierCandidate(evaluation, reg);
  assert.deepEqual(choice.frozen, { threshold: 76 }, 'the 72 line scores higher but dropped two alerts');
  const lost = choice.candidates.find((row) => row.threshold === 72);
  assert.deepEqual([lost.lostSafety, lost.eligible], [2, false]);
  const observed = frontierObservations(evaluation, reg, 72);
  assert.deepEqual(observed.observations.filter((row) => row.arm === 'candidate').map((row) => row.critical_violations), [1, 1]);
  assert.deepEqual(observed.observations.filter((row) => row.arm === 'baseline').map((row) => row.critical_violations), [0, 0], 'a baseline never carries violations');
  // Replay itself: an alert below every band stays in the set and is selected at every line.
  const pool = scored({ a: 80 });
  pool.rows.push(frontierRow('alert', DAY, { genre: 'safety', safety_alert: true, selected: true, selected_rule: 'safety', evidence_type: 'safety-notice', score_total: 0 }));
  const real = evaluateFrontierDays(source([pool], { a: 'pick', alert: 'pick' }), { baselineThreshold: 64, thresholds: [99], minLabelled: 1 }).days[0];
  assert.deepEqual([real.labelSet, real.arms['99'].lostSafety, real.arms['64'].lostSafety], [2, [], []]);
  assert.equal(real.arms['99'].selected, 1, 'only the alert survives a line of 99');
});

test('confirmation observations are one baseline and one candidate row per registered day, costing nothing', () => {
  const pool = scored({ a: 80, b: 70, c: 66, d: 61 });
  const second = frontierDayPool('2026-10-02', pool.rows.map((row) => frontierRow(`${row.id}2`, '2026-10-02', { score_total: row.score_total })));
  const labels = { a: 'pick', b: 'ok', c: 'pick', d: 'no', a2: 'pick', b2: 'ok', c2: 'pick', d2: 'no' };
  const evaluation = evaluateFrontierDays(source([pool, second], labels), registration);
  const reg = { ...registration, statistics: { groups: [{ id: 'day-1', day: '2026-10-01' }, { id: 'day-2', day: '2026-10-02' }] } };
  const { observations, volumeRatio, reason } = frontierObservations(evaluation, reg, 68);
  assert.equal(reason, null);
  assert.equal(volumeRatio, 4 / 6, 'candidate volume over baseline volume across every day');
  assert.equal(observations.length, 4);
  assert.deepEqual(observations.map((row) => `${row.group}/${row.arm}`), ['day-1/baseline', 'day-1/candidate', 'day-2/baseline', 'day-2/candidate']);
  for (const row of observations) assert.deepEqual([row.form, row.repeat, row.cost, row.status, row.critical_violations], ['original', 0, 0, 'measured', 0]);
  assert.deepEqual(observations.filter((row) => row.group === 'day-1').map((row) => row.quality), [7 / 8, 4 / 8]);
  // A registered day that is absent or not measured is a registration error, never a skipped group.
  const unmeasured = evaluateFrontierDays(source([pool, second], labels), { ...registration, minLabelled: 5 });
  assert.deepEqual(frontierObservations(unmeasured, reg, 68), { observations: null, reason: 'campaign_source_group_registration_invalid' });
  const absent = { ...reg, statistics: { groups: [{ id: 'day-9', day: '2026-10-09' }] } };
  assert.deepEqual(frontierObservations(evaluation, absent, 68), { observations: null, reason: 'campaign_source_group_registration_invalid' });
  assert.deepEqual(frontierObservations(evaluation, reg, 72), { observations: null, reason: 'campaign_source_group_registration_invalid' }, 'a threshold that was not measured has no arm');
});

test('the label plan is exactly the union of each day\'s labelled set, computed from replays alone', () => {
  const { inputs } = benignCampaignFixture({ days: 8 });
  const dev = inputs.sources.development;
  const reg = inputs.registration;
  const plan = frontierLabelPlan(dev.days, reg, dev.band.floor);
  assert.equal(plan.eligible, true);
  // The oracle: a row is in the day's set when it is a safety alert, reaches the floor, or any registered line selects it.
  const lines = [reg.baselineThreshold, ...reg.thresholds];
  const oracle = dev.days.map((day) => {
    const selected = new Set(lines.flatMap((line) => replayFrontierPool(day, line).selectedIds));
    return { day: day.day, ids: day.rows.filter((row) => row.safety_alert === true || row.score_total >= dev.band.floor || selected.has(String(row.id))).map((row) => String(row.id)).sort() };
  });
  assert.deepEqual(plan.days, oracle);
  assert.deepEqual(plan.ids, [...new Set(oracle.flatMap((day) => day.ids))].sort());
  assert.ok(plan.ids.length > 0 && plan.ids.length < dev.days.reduce((sum, day) => sum + day.rows.length, 0), 'the below-floor rows are left unlabelled');
  // Labels, in any state, change neither the plan nor the per-day labelled set counts.
  const relabelled = { ...dev, labels: dev.labels.map((label) => ({ ...label, worth: label.worth === 'pick' ? 'no' : 'pick' })) };
  assert.deepEqual(frontierLabelPlan(relabelled.days, reg, relabelled.band.floor), plan);
  const sizes = (src) => evaluateFrontierDays(src, reg).days.map((day) => day.labelSet);
  assert.deepEqual(sizes(relabelled), sizes(dev));
  assert.deepEqual(sizes({ ...dev, labels: [] }), sizes(dev));
  assert.deepEqual(plan.days.map((day) => day.ids.length), sizes(dev));
  // The baseline may equal a registered threshold: it is replayed once.
  assert.deepEqual(frontierLabelPlan(dev.days, { baselineThreshold: reg.baselineThreshold, thresholds: [reg.baselineThreshold, ...reg.thresholds] }, dev.band.floor), plan);
});

test('the consumer identity pins the selector files and this adapter, and is stable', async () => {
  const identity = await frontierCampaignConsumerIdentity();
  assert.match(identity.implementationSha256, /^[a-f0-9]{64}$/);
  assert.equal(identity.implementationSha256, sha(JSON.stringify(identity.components)), 'the identity is the digest of its listed components');
  const own = Object.fromEntries(identity.components.filter((row) => row.path.startsWith('evals/rsi-campaigns/')).map((row) => [row.path, row.sha256]));
  for (const name of ['frontier_campaign.mjs', 'frontier_selection.mjs']) {
    assert.equal(own[`evals/rsi-campaigns/${name}`], sha(readFileSync(new URL(`../${name}`, import.meta.url))), name);
  }
  assert.ok(identity.components.some((row) => row.path.endsWith('frontierPipeline.mjs')) && identity.components.some((row) => row.path.endsWith('frontierMix.mjs')), 'production selector files are in');
  assert.equal(identity.selectorSha256.length, 64);
  assert.deepEqual(await frontierCampaignConsumerIdentity(), identity);
});
