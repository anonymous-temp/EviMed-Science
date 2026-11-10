/** Deterministic L8 scoring; memory/skill/file reads do not occupy task steps. */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { scoreTrajectory } from '../synthetic/toolverse/score.mjs';
import { wilson } from '../run/ledger.mjs';

export function scoreCalls(gold, toolCalls, error = null) {
  const calls = toolCalls.filter(c => c.kind === 'task' || c.kind === 'ask').map(c => c.scoringCall);
  const score = scoreTrajectory(gold, calls);
  const firstTask = toolCalls.findIndex(c => c.kind === 'task');
  const before = firstTask < 0 ? [] : toolCalls.slice(0, firstTask);
  // A completed task trajectory earns its gold score even if the final text call hit a model/round limit.
  void error;
  return { ...score, calls,
    stepCredit: score.perStep.filter(Boolean).length / (score.perStep.length || 1),
    prefixCredit: (score.firstFail ?? score.perStep.length) / (score.perStep.length || 1),
    askedUser: calls.some(c => c.ask),
    memorySearchBeforeTask: before.some(c => c.kind === 'memory' && c.name.endsWith('__search')),
    memoryReadBeforeTask: before.some(c => c.kind === 'memory' && c.name.endsWith('__read')) };
}

const mean = (rows, fn) => rows.reduce((n, r) => n + Number(fn(r) || 0), 0) / (rows.length || 1);
function group(rows) {
  const pass = rows.filter(r => r.score.pass).length;
  const failures = {};
  for (const r of rows) {
    const key = r.error ? 'error' : r.score.firstFail !== null ? `step-${r.score.firstFail + 1}` : r.score.tellOnceFailure ? 'TellOnce-only' : r.score.extraCalls ? 'extra-calls' : r.score.pass ? 'pass' : 'other';
    failures[key] = (failures[key] || 0) + 1;
  }
  return { n: rows.length, pass, passRate: pass / (rows.length || 1), ci95: wilson(pass, rows.length),
    meanStepCredit: mean(rows, r => r.score.stepCredit), meanPrefixCredit: mean(rows, r => r.score.prefixCredit),
    tellOnceRate: mean(rows, r => r.score.tellOnceFailure), askedUserRate: mean(rows, r => r.score.askedUser),
    memorySearchBeforeTaskRate: mean(rows, r => r.score.memorySearchBeforeTask), memoryReadBeforeTaskRate: mean(rows, r => r.score.memoryReadBeforeTask),
    errors: rows.filter(r => r.error).length, failures,
    tokens: { prompt: rows.reduce((n,r) => n+(r.usage?.promptTokens || 0),0), completion: rows.reduce((n,r) => n+(r.usage?.completionTokens || 0),0), cached: rows.reduce((n,r) => n+(r.usage?.cachedTokens || 0),0) },
    seconds: rows.reduce((n,r) => n+(r.ms || 0)/1000,0) };
}
export function summarize(rows) {
  const arms = {};
  for (const arm of [...new Set(rows.map(r => r.armLabel))].sort()) {
    const rs = rows.filter(r => r.armLabel === arm);
    arms[arm] = { ...group(rs), byLevel: {}, byLength: {}, bySource: {} };
    for (const [field, target] of [['level','byLevel'],['length','byLength'],['source','bySource']]) {
      for (const value of [...new Set(rs.map(r => r[field]))]) arms[arm][target][value] = group(rs.filter(r => r[field] === value));
    }
  }
  return { scorer: 'l8-v1', rows: rows.length, arms };
}
export async function scoreRun(out, data) {
  const text = await readFile(resolve(out, 'rows.jsonl'), 'utf8');
  const rows = text.trim().split('\n').filter(Boolean).map(JSON.parse);
  if (data) {
    if (/sealed/i.test(data)) throw new Error('Only development data is permitted');
    const items = new Map(await Promise.all((await readdir(join(data,'items'))).filter(n => n.endsWith('.json')).map(async n => {
      const item = JSON.parse(await readFile(join(data,'items',n),'utf8'));
      if (item.split !== 'dev') throw new Error('Only development data is permitted');
      return [item.id,item];
    })));
    for (const row of rows) {
      const item = items.get(row.itemId);
      if (!item) throw new Error('Missing gold for '+row.itemId);
      row.score = scoreCalls(item.arms[row.arm].gold,row.toolCalls,row.error);
    }
    await writeFile(resolve(out,'rows.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  }
  const previous = JSON.parse(await readFile(resolve(out,'summary.json'),'utf8').catch(()=> '{}'));
  const summary = { ...previous, ...summarize(rows), rescoredAt:new Date().toISOString(), scorerDigest:createHash('sha256').update(await readFile(new URL('./score_l8.mjs',import.meta.url))).digest('hex') };
  await writeFile(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2)+'\n');
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  scoreRun(process.argv[2],process.argv[3]).then(s => console.log(JSON.stringify(s))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
