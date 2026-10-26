import test from 'node:test';
import assert from 'node:assert/strict';
import { frontierMixCandidate } from '../../../apps/server/src/frontierPipeline.mjs';
import { replayFrontierPool, sweepFrontierThresholds } from '../frontier_selection.mjs';
import { frontierMixSelect } from '../../../packages/domain/src/frontierMix.mjs';
import { loadFrontierGold, historicalFrontierReport, frontierGoldStatus } from '../frontier_gold.mjs';
const row = (id, extra = {}) => ({ id, genre: 'paper', platform: 'journal', source_type: 'journal', source_source_type: 'journal', source_authority: 3, primary_source_id: 'journal-a', lang: 'en', title_raw: 'A study', score_total: 95, score_version: 'current', verification: 'passed', flags: [], publication_types: ['Journal Article'], summarized: true, selected: false, selected_rule: null, safety_alert: false, event_id: null, beside_selected: false, adds_value: null, evidence_type: 'randomized-trial', visible_at: '2026-10-25T00:00:00Z', ...extra });
const pool = (rows) => ({ complete: true, day: '2026-10-25', window: { start: '2026-10-25T00:00:00Z', end: '2026-10-26T00:00:00Z' }, rows, events: {}, genreFloors: {}, congressActive: false, preprintPlaces: 2, preprintMinScore: 80, scoreVersion: 'current' });
test('projection retains production semantics and score version presence', () => {
 const c = frontierMixCandidate(row('a'));
 assert.equal(c.id, 'a'); assert.equal(c.primary, true); assert.equal(c.eligible, true);
 assert.equal(frontierMixCandidate(row('a', { score_version: null })).score, null);
 assert.equal(frontierMixCandidate(row('a', { score_version: 'older' })).score, 95);
 assert.equal(frontierMixCandidate(row('a', { flags: ['retracted'] })).eligible, false);
 assert.equal(frontierMixCandidate(row('a', { verification: 'pending' })).eligible, false);
 assert.equal(frontierMixCandidate(row('a', { publication_types: ['Editorial'] })).eligible, false);
 assert.equal(frontierMixCandidate(row('a', { title_raw: '临床研究发现新的结果' })).zh, true);
});
test('requires complete pool truth and actual visibility', () => {
 assert.equal(replayFrontierPool(pool([row('a')]), 85).eligible, true);
 for (const key of ['events', 'genreFloors', 'scoreVersion', 'window']) { const p = pool([row('a')]); delete p[key]; assert.equal(replayFrontierPool(p, 85).eligible, false); }
 assert.equal(replayFrontierPool(pool([row('a', { visible_at: null })]), 85).eligible, false);
});
test('whole pool applies event and source caps before label slicing', () => {
 const p = pool([row('a', { event_id: 'event' }), row('b', { event_id: 'event' }), row('c'), row('d'), row('e')]); p.events.event = [];
 const result = replayFrontierPool(p, 85);
 assert.ok(result.selectedIds.length <= 3); assert.ok(!result.selectedIds.includes('b'));
});
test('sweep protects baseline picks and safety without publishing candidates', () => {
 const p = pool([row('a', { primary_source_id: 'discovered-29e04956f24c862b4024' }), row('safe', { selected: true, safety_alert: true, score_total: 0, selected_rule: 'safety' })]);
 const runs = sweepFrontierThresholds(p, { baselineThreshold: 85, thresholds: [99, 85], protectedPickIds: ['a'] });
 assert.equal(runs[0].threshold, 85); assert.equal(runs[1].protectionPassed, false); assert.ok(runs[1].selectedIds.includes('safe'));
});
test('historical gold refuses fresh confirmation', () => {
 assert.equal(frontierGoldStatus().freshConfirmationEligible, false);
 assert.equal(frontierGoldStatus().rawRaterAgreementRecomputable, false);
});

test('frozen complete pool is identical to the production consumer', () => {
 const p = pool([row('a'), row('b', { selected: true, selected_rule: 'threshold', event_id: 'e' }), row('c', { event_id: 'e' }), row('d', { score_version: null }), row('f', { flags: ['retracted'] }), row('g', { summarized: false, score_total: 65 })]);
 p.events.e = [{ id: 'b', genre: 'paper', selected: true, rule: 'threshold', safety: false, evidenceType: 'randomized-trial' }];
 const expected = frontierMixSelect({ candidates: p.rows.map(frontierMixCandidate), threshold: 85, events: p.events, genreFloors: p.genreFloors, congressActive: p.congressActive, preprintPlaces: p.preprintPlaces, preprintMinScore: p.preprintMinScore });
 const actual = replayFrontierPool(p, 85);
 assert.deepEqual(actual.result, expected); assert.ok(actual.selectedIds.includes('b')); assert.ok(!actual.selectedIds.includes('c')); assert.ok(!actual.selectedIds.includes('d')); assert.ok(!actual.selectedIds.includes('f'));
});
test('historical dataset identity, exposure and split are auditable', async () => {
 const gold = await loadFrontierGold(); const report = await historicalFrontierReport();
 assert.equal(gold.sha256, '0cfd168507b5754ba15d3e494fec4050fe16747f560ad4a41c5f3a59457c48bf');
 assert.equal(gold.rows.length, 248); assert.equal(gold.split.development.length, 124); assert.equal(gold.split.historicalTest.length, 124);
 assert.deepEqual(report.labelCounts, { ok: 200, pick: 41, no: 7 }); assert.equal(report.exposures.length, 2); assert.equal(report.freshConfirmationEligible, false);
});
