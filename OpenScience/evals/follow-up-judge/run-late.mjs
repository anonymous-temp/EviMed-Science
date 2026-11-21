#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { FollowUpJudge, readLateFollowUp } from '../../apps/server/src/learningEvidence.mjs';
import { LATE_CASE_IDS } from './replay-late.mjs';

const dryRun = process.argv.includes('--dry-run');
const key = dryRun ? '' : process.env.DEEPSEEK_API_KEY;
if (!dryRun && !key) throw new Error('Set DEEPSEEK_API_KEY in the lab environment.');
const model = process.env.FOLLOW_UP_JUDGE_MODEL || 'deepseek-flash';
const judge = new FollowUpJudge({ deepseekProviderEnabled: true, deepseekApiKey: key,
  deepseekModel: model, deepseekBaseUrl: 'https://api.deepseek.com', modelGatewayTimeoutMs: 30_000 });
const { cases } = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));

const abstract = { path: 'results/abstract.docx', sha256: 'a'.repeat(64) };
const slides = { path: 'results/presentation.pptx', sha256: 'b'.repeat(64) };
const notes = { path: 'results/speaker-notes.md', sha256: 'c'.repeat(64) };
const expected = new Map([['fj-062', { relation: 'convert', artifact: abstract }], ['fj-069', { relation: 'share', artifact: slides }]]);
const rows = [];
for (const id of LATE_CASE_IDS) {
  const source = cases.find(item => item.id === id);
  if (!source) throw new Error(`Missing case ${id}`);
  const deliveries = id === 'fj-062' ? [abstract] : id === 'fj-069' ? [notes, slides]
    : id === 'fj-085' ? [] : [{ path: 'results/delivery.md', sha256: 'd'.repeat(64) }];
  if (dryRun) {
    rows.push({ id, positive: expected.has(id), deliveries });
    continue;
  }
  const answer = await readLateFollowUp(judge, { message: source.message, previousRequest: source.previousRequest, methods: [], deliveries },
    { userId: 'eval', projectId: 'eval', runId: `eval-late-${id}` });
  const target = expected.get(id);
  const accepted = 'verdict' in answer && answer.verdict === 'accept';
  const bound = accepted && answer.relation === target?.relation && answer.artifact?.path === target?.artifact.path
    && answer.artifact?.sha256 === target?.artifact.sha256;
  rows.push({ id, verdict: 'verdict' in answer ? answer.verdict : null,
    failure: 'failure' in answer ? answer.failure : null,
    ...('failure' in answer && answer.failure === 'judge_unreadable' && { diagnostic: answer.diagnostic }),
    falsePositive: accepted && (!target || !bound), missedPositive: Boolean(target) && !bound });
}
const falsePositives = rows.filter(row => row.falsePositive).map(row => row.id);
const missedPositives = rows.filter(row => row.missedPositive).map(row => row.id);
const failures = rows.filter(row => row.failure).map(row => row.id);
const passed = !dryRun && falsePositives.length === 0 && missedPositives.length <= 1 && failures.length === 0;
console.log(JSON.stringify({ model, cases: rows.length, dryRun, passed, falsePositives, missedPositives, failures, rows }, null, 2));
if (!dryRun && !passed) process.exitCode = 1;
