#!/usr/bin/env node
/**
 * The plugin's own ranking function (`composeRanking`, TrialLink policy triallink-2) applied to saved provider answers, so a board scores the
 * order the product would save: Qwen3.7 rerank scores give the rerank order (ties keep the candidate list's order, as the model port
 * does), Jev's five-level fit scores the second order and the expected gain of Jev's graded probabilities (`gradedP`) the third. Writes judgments.jsonl per cohort for `score.py a` or a run file for E.
 *
 *   node product_rank.mjs --boards <dir> [--cohorts name=dir,...] --qwen <pairs.jsonl> --jev <pairs.jsonl> [--jev-field fit] --out <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { composeRanking, expectedGradedGain } from '../../packages/patient-matching-core/index.mjs';

const { values: o } = parseArgs({ options: { boards: { type: 'string' }, cohorts: { type: 'string' }, qwen: { type: 'string' }, jev: { type: 'string' },
  'jev-field': { type: 'string', default: 'fit' }, out: { type: 'string' }, 'jev-depth': { type: 'string', default: '0' } } });
const readJsonl = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const cohorts = o.cohorts ? Object.fromEntries(o.cohorts.split(',').map(part => part.split('='))) : { sigir: 'A-sigir', trec_2021: 'A-trec2021', trec_2022: 'A-trec2022' };
const qwen = {};
for (const row of readJsonl(o.qwen)) if (!row.error) Object.assign(qwen[row.p] ??= {}, row.scores);
const jev = {};
for (const row of readJsonl(o.jev)) if (!row.error && row[o['jev-field']] != null) (jev[row.p] ??= {})[row.t] = row[o['jev-field']];
const graded = {};
for (const row of readJsonl(o.jev)) { const gain = row.error ? null : expectedGradedGain(row.gradedP); if (gain != null) (graded[row.p] ??= {})[row.t] = gain; }
const depth = Number(o['jev-depth']);
let patients = 0, skipped = 0;
for (const [cohort, dir] of Object.entries(cohorts)) {
  const lines = [];
  for (const item of readJsonl(path.join(o.boards, dir, 'cases.jsonl'))) {
    const scores = qwen[item.patientId];
    if (!scores || item.candidateIds.some(id => !(id in scores))) { skipped++; continue; }
    const position = new Map(item.candidateIds.map((id, index) => [id, index]));
    const rerankOrder = [...item.candidateIds].sort((a, b) => scores[b] - scores[a] || position.get(a) - position.get(b));
    const head = depth > 0 ? rerankOrder.slice(0, depth) : rerankOrder;
    const jevScores = head.filter(id => jev[item.patientId]?.[id] != null).map(id => ({ registryId: id, score: jev[item.patientId][id] }));
    const gradedGains = head.filter(id => graded[item.patientId]?.[id] != null).map(id => ({ registryId: id, gain: graded[item.patientId][id] }));
    const { finalOrder } = composeRanking({ rerankOrder, jevScores, gradedGains });
    lines.push(JSON.stringify({ patientId: item.patientId, status: 'complete', ranking: finalOrder.map((registryId, index) => ({ registryId, rank: index + 1 })), failed: [] }));
    patients++;
  }
  fs.mkdirSync(path.join(o.out, cohort), { recursive: true });
  fs.writeFileSync(path.join(o.out, cohort, 'judgments.jsonl'), `${lines.join('\n')}\n`);
}
console.log(`[product_rank] ${patients} patients ranked, ${skipped} without complete rerank scores`);
