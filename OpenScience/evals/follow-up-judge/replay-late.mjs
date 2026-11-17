// Recorded verdict replay, not a measurement of the new late-judge semantics.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { lateFixture, DELIVERY, boundAcceptance, LATE_NOW } from './late-fixtures.mjs';

export const LATE_CASE_IDS = ['fj-058', 'fj-062', 'fj-064', 'fj-066', 'fj-069', 'fj-071', 'fj-073', 'fj-077',
  'fj-081', 'fj-085', 'fj-089', 'fj-091', 'fj-092', 'fj-097', 'fj-003', 'fj-009', 'fj-013', 'fj-015', 'fj-022',
  'fj-032', 'fj-040', 'fj-048', 'fj-050', 'fj-052', 'fj-056', 'fj-102', 'fj-108', 'fj-114'];

/** An injectable recorded judge function. Protocol additions are explicitly synthetic and never rewrite the recording. */
export async function replayLate({ judge = ({ recorded }) => recorded.modelText, protocolFixtures = false } = {}) {
  const { cases } = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
  const { results } = JSON.parse(await readFile(new URL('./results/2026-10-25-bank-embedding.json', import.meta.url), 'utf8'));
  const rows = [];
  const second = { path: 'report/earlier.md', sha256: 'b'.repeat(64) };
  const correctionCase = cases.find(row => row.id === 'fj-003');
  const correctionOutput = results.find(row => row.id === 'fj-003').modelText;
  for (const id of LATE_CASE_IDS) {
    const source = cases.find(row => row.id === id), recorded = results.find(row => row.id === id);
    assert.ok(source && recorded, `Missing recorded case ${id}`);
    const options = {
      ...(id === 'fj-071' ? { age: 1_799_000 } : {}), // Original half-hour behaviour stays unchanged.
      ...(id === 'fj-062' ? { age: 1_801_000 } : {}),
      ...(id === 'fj-003' ? { age: 86_400_000 } : {}),
      ...(id === 'fj-066' ? { age: 86_400_001 } : {}),
      ...(id === 'fj-085' ? { files: [] } : {}),
      ...(id === 'fj-069' ? { files: [second, DELIVERY] } : {}),
      ...(id === 'fj-073' ? { currentFiles: [] } : {}), // Deleted version, no revival.
      ...(id === 'fj-077' ? { refusal: 'before_reset' } : {}),
      ...(id === 'fj-091' ? { refusal: 'not_researcher_work' } : {}),
      ...(id === 'fj-092' ? { extraRuns: [{ id: 'intervening', status: 'failed', sessionId: 'session', startedAt: new Date(LATE_NOW - 60_000).toISOString() }] } : {}),
      ...(id === 'fj-097' ? { sessionId: 'other-conversation' } : {}),
    };
    const state = lateFixture({ ...options, previousRequest: source.previousRequest, answer: async request => {
      if (request.message === correctionCase.message && request.message !== source.message) return correctionOutput;
      const answer = await judge({ source, recorded, request });
      if (protocolFixtures && ['fj-062', 'fj-069'].includes(id) && JSON.parse(answer).verdict === 'accept') {
        // Exact words and version receipt supplied by deterministic fixtures, not present in the old judge result.
        return boundAcceptance(source.message, DELIVERY).replace('"convert"', id === 'fj-069' ? '"cite"' : '"convert"');
      }
      return answer;
    } });
    await state.snapshot();
    const result = await state.turn(source.message);
    const outcome = state.outcome();
    const isLate = (options.age ?? 1_801_000) > 1_800_000;
    if (['none', 'correction', 'preference', 'rejection'].includes(source.class)) assert.notEqual(outcome, 'clean', `${id}: unsafe clean`);
    if (isLate && !['fj-062', 'fj-069'].includes(id)) assert.notEqual(outcome, 'clean', `${id}: unbound or acknowledgement became clean`);
    if (['fj-073', 'fj-077', 'fj-091', 'fj-092', 'fj-097'].includes(id)) assert.notEqual(outcome, 'clean', `${id}: withdrawn/refused source revived`);
    await state.turn(source.message);
    assert.ok(state.rows.filter(row => row.detail.lateFollowUp).length <= 1, `${id}: duplicate event`);
    if (isLate && outcome === 'clean') {
      await state.turn(correctionCase.message, { requestId: 'later-correction' });
      assert.equal(state.outcome(), 'corrected', `${id}: late correction did not override`);
    }
    rows.push({ id, recordedVerdict: recorded.predicted, outcome, reason: result.reason ?? result.verdict,
      ...(isLate && ['fj-062', 'fj-069'].includes(id) && outcome !== 'clean' ? { missedPositive: 'recording lacks late quotation/version protocol' } : {}) });
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const recorded = await replayLate();
  const protocol = await replayLate({ protocolFixtures: true });
  console.log(JSON.stringify({ cases: LATE_CASE_IDS.length, recorded, protocolFixtures: protocol,
    acceptance: { noUnrelatedCorrectedOrRejectedClean: true, noWithdrawnSourceRevived: true, oneEventPerRun: true, lateCorrectionOverrides: true },
    limitation: 'Synthetic recorded cases and deterministic protocol metadata; no live late-judge validation and no production-effect claim.' }, null, 2));
}
