#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLedgerRows, rowsFromSummary } from '../run/ledger.mjs';
import { wilson } from '../c2/run_c2.mjs';
import { isPeak, priceUsage, priceListAt } from '../../../packages/domain/src/metering.mjs';

const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];

export function primaryRequest(request, amendments = []) {
  return !amendments.some(a => request.runId === a.runId && a.tasks.includes(request.task)
    && (!request.at || request.at < a.primaryAfter));
}

export function verdict(record) {
  if (record.infraError) return { pass: false, scored: false, error: record.infraError };
  const official = record.official ?? {};
  if (official.verifier_error) return { pass: false, scored: false, error: official.verifier_error };
  if (official.error && official.verifier_exit == null && official.rewards == null) return { pass: false, scored: false, error: official.error };
  if ('passed' in official) return { pass: official.passed === true, scored: true, error: null };
  const rewards = official.rewards;
  if (rewards === null || rewards === undefined) return { pass: false, scored: false, error: 'missing official reward' };
  const score = typeof rewards === 'number' ? rewards : (rewards.reward ?? Object.values(rewards)[0]);
  return { pass: Number(score) === 1, scored: true, error: null };
}

// A successful read of a mounted SKILL.md is an opening. Mentioning a skill or listing its directory is not an opening.
export function openings(events, mounted) {
  const names = new Set(mounted);
  const calls = new Map(), completed = new Set();
  const returnedSkillName = value => {
    if (typeof value === 'string') {
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(value)?.[1];
      if (!header) return null;
      let name;
      try { name = JSON.parse(header).name; } catch { name = /^name:\s*["']?([A-Za-z0-9_-]+)/m.exec(header)?.[1]; }
      return names.has(name) ? name : null;
    }
    if (!value || typeof value !== 'object') return null;
    for (const child of Object.values(value)) {
      const name = returnedSkillName(child);
      if (name) return name;
    }
    return null;
  };
  const visit = obj => {
    if (!obj || typeof obj !== 'object') return;
    const tool = obj.name ?? obj.toolName ?? obj.tool_name;
    const args = obj.arguments ?? obj.args ?? obj.input ?? obj.rawInput;
    if (['read', 'read_file', 'Read'].includes(tool) && args && typeof args === 'object') {
      const file = String(args.path ?? args.file_path ?? args.filePath ?? '');
      const match = /\/([^/]+)\/SKILL\.md$/.exec(file);
      const key = obj.toolCallId ?? obj.id;
      if (match && names.has(match[1]) && key) calls.set(key, match[1]);
    }
    const key = obj.toolCallId ?? obj.tool_call_id;
    if (obj.type === 'tool_call' && obj.kind === 'read' && key) {
      const match = /\/([^/]+)\/SKILL\.md(?:$|[\s:])/.exec(String(obj.title ?? ''));
      if (match && names.has(match[1])) calls.set(key, match[1]);
      // BenchFlow's captured ACP title can be only "read"; the successful
      // returned document still preserves its canonical skill frontmatter.
      const returned = returnedSkillName(obj.content);
      if (returned) calls.set(key, returned);
    }
    if (key && ((obj.type === 'tool_execution_end' && obj.isError === false)
      || (obj.role === 'toolResult' && obj.isError === false) || obj.status === 'completed')) completed.add(key);
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
    }
  };
  events.forEach(visit);
  return [...calls].filter(([key]) => completed.has(key)).map(([, name]) => name);
}

export function aggregate(records, planned) {
  const counts = { n: planned, completed: records.length, pass: 0, fail: 0, error: 0, unknown: planned - records.length };
  const totals = { prompt: 0, completion: 0, cached: 0, costCny: 0, costCnyPeakEquivalent: 0, requests: 0, missingUsage: 0 };
  const byCategory = {};
  let mounted = 0, opened = 0;
  for (const record of records) {
    const v = verdict(record), category = record.task.category;
    const part = byCategory[category] ??= { n: 0, pass: 0, fail: 0, error: 0 };
    part.n += 1;
    if (!v.scored) { counts.error += 1; part.error += 1; }
    else if (v.pass) { counts.pass += 1; part.pass += 1; }
    else { counts.fail += 1; part.fail += 1; }
    for (const request of record.requests ?? []) {
      totals.requests += 1; totals.prompt += request.usage?.prompt_tokens ?? 0;
      totals.completion += request.usage?.completion_tokens ?? 0;
      totals.cached += request.usage?.prompt_cache_hit_tokens ?? 0;
      const at = new Date(request.at ?? '');
      const priced = !Number.isNaN(at.getTime()) && request.usage ? priceUsage({ resourceType: 'model',
        model: request.requestedModel ?? request.model ?? 'deepseek-flash',
        cacheHit: request.usage.prompt_cache_hit_tokens ?? 0,
        cacheMiss: Math.max(0, (request.usage.prompt_tokens ?? 0) - (request.usage.prompt_cache_hit_tokens ?? 0)),
        output: request.usage.completion_tokens ?? 0, peak: isPeak(at) }, priceListAt(at)) : null;
      totals.costCny += priced?.priced ? priced.cost : request.costCny ?? 0;
      totals.costCnyPeakEquivalent += request.costCny ?? 0;
      totals.missingUsage += request.usageMissing ? 1 : 0;
    }
    mounted += record.mounted?.length ?? 0; opened += record.opened?.length ?? 0;
  }
  for (const part of Object.values(byCategory)) { part.value = part.pass / part.n; part.ci95 = wilson(part.pass, part.n); }
  return { ...counts, value: planned ? counts.pass / planned : null, ci95: wilson(counts.pass, planned),
    scored: counts.pass + counts.fail, scoredValue: counts.pass + counts.fail ? counts.pass / (counts.pass + counts.fail) : null,
    scoredCi95: wilson(counts.pass, counts.pass + counts.fail),
    complete: records.length === planned, byCategory, tokens: totals, mounted, opened,
    distinctMounted: new Set(records.flatMap(r => r.mounted ?? [])).size,
    distinctOpened: new Set(records.flatMap(r => r.opened ?? [])).size,
    modelInvoked: records.filter(r => r.requests?.length).length,
    perModelTask: records.some(r => r.requests?.length) ? {
      tokens: (totals.prompt + totals.completion) / records.filter(r => r.requests?.length).length,
      costCny: totals.costCny / records.filter(r => r.requests?.length).length } : null,
    perTask: records.length ? { tokens: (totals.prompt + totals.completion) / records.length, costCny: totals.costCny / records.length,
      mounted: mounted / records.length, opened: opened / records.length } : null };
}

function main() {
  const root = process.argv[2] ?? '/srv/evimed/sb', runs = process.argv[3] ?? '/srv/evimed/runs';
  const ledger = process.argv[4] ?? '/srv/evimed/results/ledger.jsonl';
  const manifest = read(`${root}/manifest.json`);
  const amendments = read(`${root}/protocol-amendments.json`) ?? [];
  const usageFile = `${root}/usage.jsonl`;
  const metered = fs.existsSync(usageFile) ? fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : null;
  const results = [];
  for (const bench of ['sb', 'slb']) for (const arm of ['none', 'flat', 'learned']) {
    const runId = `${bench}-${arm}-1`, dir = `${runs}/${runId}`, run = read(`${dir}/run.json`);
    if (!run) continue;
    const records = walk(`${dir}/records`).filter(f => f.endsWith('.json')).map(read);
    for (const record of records) {
      // A canceled agent can leave a provider stream settling after its task record was written.
      // The append-only gateway record, including late/disconnected completions, owns the final charge.
      if (metered) record.requests = metered.filter(request => request.runId === runId && request.task === record.task.id && primaryRequest(request, amendments));
      const events = walk(record.trialPath ?? `${dir}/trials`).filter(f => f.includes(record.task.id) && /(?:trajectory|pi\.jsonl|sessions).*\.jsonl$/.test(f)).flatMap(file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }));
      record.opened = openings(events, record.mounted ?? []);
    }
    const summary = aggregate(records, run.tasks.length);
    summary.rows = records.map(record => ({ task: record.task.id, category: record.task.category, ...verdict(record),
      agentError: record.official?.error ?? null,
      agentTimedOut: record.official?.agent_timed_out === true || record.official?.error_category === 'timeout',
      mounted: record.mounted, opened: record.opened, wallSeconds: record.wallSeconds,
      tokens: aggregate([record], 1).tokens }));
    const learning = read(`${root}/practice/complete.json`);
    if (arm === 'learned') summary.learning = learning ? { learned: learning.learned, approved: learning.approved,
      distinctOpenedInOtherTasks: new Set(records.flatMap(r => r.opened)).size,
      tasksOpeningLearned: records.filter(r => r.opened.length).length, reachedQuiet: learning.reachedQuiet } : { unavailable: true };
    fs.writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
    const sourceCommit = process.env.SB_COMMIT ?? (fs.existsSync(`${root}/source-commit`) ? fs.readFileSync(`${root}/source-commit`, 'utf8').trim() : 'unknown');
    const rows = rowsFromSummary({ run: { ...run, runId, commit: sourceCommit, arm: `reference-${arm}`,
      split: 'dev', label: 'model + our methods, not the product', rawPath: dir,
      engine: { version: 'reference-harness', templatesDigest: 'not-applicable' },
      flags: { pins: run.pins, manifestSha256: run.manifestSha256, thinking: 'high', model: run.model,
        harness: bench === 'sb' ? 'BenchFlow 0.6.3 + Pi ACP' : 'SkillLearnBench core.eval_runner + Pi CLI',
        productPracticeLockIsolationEnabled: true, subset: true, tasks: run.tasks, perFamily: run.perFamily ?? null,
        resources: run.resources ?? 'task-manifest', costBasis: 'Provider usage priced by product domain priceListAt/isPeak; proxy budget uses peak equivalent' } },
      summary: { sets: { [bench === 'sb' ? 'skillsbench' : 'skilllearnbench']: { ...summary, accuracy: summary.value,
        judged: { code: summary.scored, judge: 0, unknown: summary.unknown, error: summary.error }, byCategory: summary.byCategory } },
        tokens: summary.tokens, wallSeconds: records.reduce((s, r) => s + r.wallSeconds, 0) },
      costCny: summary.tokens.costCny, scorer: `${bench}@${manifest.pins[bench]}:official-verifier` });
    for (const row of rows) row.notes = `${manifest.samplingRule} ${run.capacityAmendment ?? ''} Model + our methods, NOT the product. Inference only; product practice and adapter calibration cost are separate. Every affected adapter-calibration phase was archived wholly (passes included) and its tasks repeated; see protocol-amendments.json. Infrastructure errors and unfinished tasks stay in the planned denominator; scorer-only rate and interval are in summary.json. Mounted/opened ${summary.mounted}/${summary.opened}; model-invoked ${summary.modelInvoked}/${summary.n}.`;
    fs.writeFileSync(`${dir}/ledger-row.json`, JSON.stringify(rows, null, 2) + '\n');
    // Incomplete arms have a reviewable summary, but no final ledger row until all planned records exist.
    if (summary.complete && process.argv.slice(5).includes('--append')) appendLedgerRows(ledger, rows);
    results.push({ bench, arm, ...summary });
  }
  fs.writeFileSync(`${root}/summary.json`, JSON.stringify(results, null, 2) + '\n');
  const costOf = requests => aggregate([{ task: { category: 'accounting' }, official: { passed: true }, requests }], 1).tokens;
  const practice = read(`${root}/practice/complete.json`)?.usage ?? read(`${root}/practice/usage.json`);
  const reference = costOf(metered ?? []);
  const batch = read(`${root}/batch.json`);
  const balanceText = fs.existsSync('/srv/evimed/runs/BUDGET-LAST') ? fs.readFileSync('/srv/evimed/runs/BUDGET-LAST', 'utf8') : '';
  const accounting = { at: new Date().toISOString(), reference,
    smokes: costOf((metered ?? []).filter(r => r.runId?.includes('smoke'))),
    precompatCalibration: costOf((metered ?? []).filter(r => !primaryRequest(r, amendments))),
    judges: costOf((metered ?? []).filter(r => r.purpose === 'judge')),
    practice: practice ?? null, totalObservedCny: reference.costCny + (practice?.account?.actualCost ?? 0),
    conservativeUpperBoundCny: reference.costCnyPeakEquivalent + (practice?.account?.actualCost ?? 0) + (practice?.account?.reservedCost ?? 0),
    balanceBefore: batch?.balanceBefore ?? null, balanceAfter: /balance\s+([\d.]+)/.exec(balanceText)?.[1] ?? null,
    balanceScope: 'Shared account; balance delta includes other lanes and is not attribution to SB.',
    startedAt: batch?.startedAt ? new Date(batch.startedAt * 1000).toISOString() : null,
    priceBasis: 'Provider token usage at observed timestamps, product domain dated prices/peak schedule; billing estimate, not an isolated vendor invoice.' };
  fs.writeFileSync(`${root}/accounting.json`, JSON.stringify(accounting, null, 2) + '\n');
  console.log(JSON.stringify(results.map(({ rows, byCategory, ...rest }) => rest), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
