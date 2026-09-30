#!/usr/bin/env node
/** Deterministic no-adjudicator stress control; this is not a live model score. */
import { readFile, writeFile } from 'node:fs/promises';
import { frontierVectorReading, frontierClusterDecision } from '../../apps/server/src/frontierEvents.mjs';
const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8')).same_event;
const results = cases.map((item) => {
  // Assigned high similarity isolates the former unconditional-join behavior.
  // It is not an observed embedding score for this pair.
  const reading = frontierVectorReading([{ eventId: '1', cosine: 0.99 }]);
  const decision = frontierClusterDecision({ identifier: [], strong: reading.strong, yes: [], related: [],
    events: new Map([['1', { id: '1', firstAt: '2026-09-22' }]]) });
  return { id: item.id, expectedSame: item.expect.includes('yes'), joinedWithoutJudge: decision.target !== null };
});
const negative = results.filter((item) => !item.expectedSame);
const positive = results.filter((item) => item.expectedSame);
const falseMerges = negative.filter((item) => item.joinedWithoutJudge).length;
const report = { at: new Date().toISOString(), kind: 'deterministic-no-adjudicator-control',
  note: 'Assigned cosine 0.99; no model or embedding call. Measures safe fallback only, not production accuracy. Existing labeled cases remain the input for the separate live same-event evaluator.',
  total: results.length, negativePairs: negative.length, positivePairs: positive.length,
  falseMerges, falseMergeRate: negative.length ? falseMerges / negative.length : null,
  unmatchedPositivePairs: positive.filter((item) => !item.joinedWithoutJudge).length,
  modelCalls: 0, modelErrorRate: null, results };
const output = new URL('./results/policy-control-20260929.json', import.meta.url);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ total: report.total, falseMerges, negativePairs: negative.length, unmatchedPositivePairs: report.unmatchedPositivePairs, modelCalls: 0 }));
