import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateObservation, summarize } from './scorer.mjs';
import { validateCollectedEvidence } from './evidence.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const b = JSON.parse(await fs.readFile(path.join(root, 'cases.json'), 'utf8'));
const input = process.argv[2];
if (!input) throw new Error('Usage: node report.mjs <reviewed-observations.jsonl>');
const rows = (await fs.readFile(input, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const seenRunIds = new Set();
for (const row of rows) {
  validateObservation(b.cases.find(c => c.id === row.caseId), row);
  const evidence = JSON.parse(await fs.readFile(path.resolve(path.dirname(input), row.evidence.transcript), 'utf8'));
  validateCollectedEvidence(b.cases.find(c=>c.id===row.caseId), row, evidence, seenRunIds);
}
// Lifecycle probes are measured HTTP outcomes, never fabricated DSH answers.
for (const file of await fs.readdir(path.dirname(input))) {
  const match = /^(baseline|candidate)-lifecycle-([123])\.json$/.exec(file);
  if (!match) continue;
  const measured = JSON.parse(await fs.readFile(path.join(path.dirname(input),file),'utf8'));
  if (measured.kind !== 'real-product-http-lifecycle-only' || measured.denominator !== 30 || measured.rows.length !== 30) throw new Error('Invalid lifecycle measurement');
  if (measured.qualityEligible !== true) continue; // HTTP setup checks never satisfy native retrieval lifecycle acceptance.
  for (const result of measured.rows) {
    if (result.status === 'blocked') continue; // Missing engine proof must leave the full verdict inconclusive.
    const c = b.cases.find(c=>c.id===result.caseId && c.stratum==='lifecycle');
    if (!c || !['pass','fail'].includes(result.status)) throw new Error('Unknown lifecycle case/outcome');
    rows.push({caseId:c.id,arm:match[1],repetition:Number(match[2]),score:result.status==='pass'?1:0,violations:result.status==='fail'?[result.error??'Lifecycle violation']:[]});
  }
}
const report = summarize(b, rows);
await fs.writeFile(path.join(path.dirname(input), 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
