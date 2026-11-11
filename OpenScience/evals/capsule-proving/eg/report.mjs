// Paired reporting for the product-path evaluations. No missing observation counts as a pass.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson, appendLedgerRows } from '../run/ledger.mjs';
import { read, save } from './common.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const lines = async file => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const mean = x => x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
const prop = values => ({ n: values.length, pass: values.filter(Boolean).length, value: mean(values.map(Number)), ci95: values.length ? wilson(values.filter(Boolean).length, values.length) : null });

// Question/case paired percentile bootstrap, fixed seed; uncertainty across only four users is also disclosed.
export function paired(values) {
  if (!values.length) return { n: 0, difference: null, ci95: null };
  let state = 11112026;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const draws = [];
  for (let i = 0; i < 10_000; i++) { let sum = 0; for (let j = 0; j < values.length; j++) sum += values[Math.floor(random() * values.length)]; draws.push(sum / values.length); }
  draws.sort((a, b) => a - b);
  return { n: values.length, difference: mean(values), ci95: [draws[249], draws[9749]], method: 'paired percentile bootstrap, 10000 resamples, seed 11112026' };
}
const stepNames = ['not_stored', 'not_searched', 'not_retrieved', 'retrieved_but_wrong'];
function failedStep(row) {
  if (row.verdict !== 'fail' || !row.trace) return null;
  return !row.trace.stored ? 'not_stored' : !row.trace.searched ? 'not_searched' : !row.trace.retrieved ? 'not_retrieved' : 'retrieved_but_wrong';
}
function comparison(rows) {
  const a = rows.map(r => r.engine.verdict === 'pass'), b = rows.map(r => r.product.verdict === 'pass');
  const steps = Object.fromEntries(stepNames.map(step => [step, {
    engine: prop(rows.map(r => failedStep(r.engine) === step)), product: prop(rows.map(r => failedStep(r.product) === step)),
    paired: paired(rows.map(r => Number(failedStep(r.product) === step) - Number(failedStep(r.engine) === step))) }]));
  const observedStages = Object.fromEntries(['stored', 'searched', 'retrieved'].map(step => [step, {
    engine: prop(rows.map(r => r.engine.trace?.[step] === true)), product: prop(rows.map(r => r.product.trace?.[step] === true)),
    paired: paired(rows.map(r => Number(r.product.trace?.[step] === true) - Number(r.engine.trace?.[step] === true))) }]));
  return { engine: prop(a), product: prop(b), paired: paired(a.map((v, i) => Number(b[i]) - Number(v))),
    engineOnlyPass: a.filter((v, i) => v && !b[i]).length, productOnlyPass: b.filter((v, i) => v && !a[i]).length,
    judged: Object.fromEntries(['engine', 'product'].map(k => [k, Object.fromEntries(['pass', 'fail', 'unknown', 'error', 'needs-judge', 'gold-disputed'].map(v => [v, rows.filter(r => r[k].verdict === v).length]))])),
    byFailureStep: steps, observedStages };
}
const fmt = x => x == null ? '—' : (100 * x).toFixed(1);
const fmtProp = p => p.n ? `${p.pass}/${p.n} (${fmt(p.value)}%; ${p.ci95.map(fmt).join('–')}%)` : 'not observed';
const fmtPair = p => p.n ? `${fmt(p.difference)} pp [${p.ci95.map(fmt).join(', ')}]` : 'not observed';

async function g1() {
  const sample = await read(args.selection);
  const engineRows = await lines(`${args.engine}/scores/rows.jsonl`);
  const productRows = (await Promise.all(args.runs.split(',').map(async dir => { try { return await lines(`${dir}/scores/rows.jsonl`); } catch { return []; } }))).flat();
  const observed = new Set();
  for (const dir of args.runs.split(',')) for (const q of sample.questions) if (await read(`${dir}/cases/${q.user}/answer-records/${q.qid}.json`)) observed.add(q.qid);
  const rows = sample.questions.flatMap(q => {
    const engine = engineRows.find(r => r.kind === 'answer' && r.id === q.qid);
    const product = observed.has(q.qid) && productRows.find(r => r.kind === 'answer' && r.id === q.qid);
    return engine && product ? [{ ...q, engine, product }] : [];
  });
  const result = { planned: sample.n, completed: rows.length, complete: rows.length === sample.n, overall: comparison(rows),
    validGoldPairs: comparison(rows.filter(r => !r.engine.disputed && !r.product.disputed && ![r.engine.verdict, r.product.verdict].includes('invalid-item'))),
    byCategory: Object.fromEntries(sample.categories.map(c => [c, comparison(rows.filter(r => r.category === c))])),
    byUser: Object.fromEntries(sample.users.map(u => [u, comparison(rows.filter(r => r.user === u))])),
    limitations: ['Only four users; question bootstrap does not establish population-level user uncertainty.', 'Engine v3 baseline and candidate product path differ in switches and generated versus replayed assistant messages.',
      'Legacy failure attribution tests normalized anchors, excludes opening context from retrieved, and can call a raw-history recovery not_stored.',
      'Source timestamps are preserved as metadata; product conversations use the real wall clock.', 'Unobserved product rows are excluded from the completed-pair estimate; observed errors and unknowns remain in its denominator and never pass. Gold-disputed pairs are also reported separately.'],
    pairs: rows };
  await save(`${args.out}/g1.json`, result);
  const md = ['# G1: engine versus real conversations', '', `Completed ${rows.length}/${sample.n} frozen pairs. Intervals are Wilson; differences are paired bootstrap.`, '',
    '| Category | Engine | Product | Paired difference |', '|---|---|---|---|',
    ...[['Overall', result.overall], ...Object.entries(result.byCategory)].map(([c, r]) => `| ${c} | ${fmtProp(r.engine)} | ${fmtProp(r.product)} | ${fmtPair(r.paired)} |`), '',
    '| Failure step (legacy convention) | Engine | Product | Paired difference |', '|---|---|---|---|',
    ...Object.entries(result.overall.byFailureStep).map(([c, r]) => `| ${c} | ${fmtProp(r.engine)} | ${fmtProp(r.product)} | ${fmtPair(r.paired)} |`), '',
    '| Observed stage | Engine | Product | Paired difference |', '|---|---|---|---|',
    ...Object.entries(result.overall.observedStages).map(([c, r]) => `| ${c} | ${fmtProp(r.engine)} | ${fmtProp(r.product)} | ${fmtPair(r.paired)} |`), '', ...result.limitations.map(x => `- ${x}`)];
  await fs.writeFile(`${args.out}/g1.md`, md.join('\n') + '\n');
  return result;
}
async function g10() {
  const [empty, seeded] = await Promise.all([args.empty, args.seeded].map(dir => read(`${dir}/summary.json`)));
  if (!empty || !seeded) return { complete: false };
  const e = empty.rows ?? [], s = seeded.rows ?? [];
  const pairs = e.flatMap(a => { const b = s.find(b => b.caseId === a.caseId && b.variant === a.variant); return b ? [{ caseId: a.caseId, empty: a, seeded: b }] : []; });
  for (const p of pairs) for (const arm of ['empty', 'seeded']) p[arm].metrics.totalTokens = p[arm].metrics.inputTokens + p[arm].metrics.outputTokens;
  const summary = held => ({ empty: prop(held.map(p => p.empty.status === 'pass')), seeded: prop(held.map(p => p.seeded.status === 'pass')),
    pairedPass: paired(held.map(p => Number(p.seeded.status === 'pass') - Number(p.empty.status === 'pass'))),
    metrics: Object.fromEntries(['toolCalls', 'inputTokens', 'outputTokens', 'totalTokens'].map(k => [k, { empty: mean(held.map(p => p.empty.metrics[k])), seeded: mean(held.map(p => p.seeded.metrics[k])),
      emptyCi95: paired(held.map(p => p.empty.metrics[k])).ci95, seededCi95: paired(held.map(p => p.seeded.metrics[k])).ci95,
      paired: paired(held.map(p => p.seeded.metrics[k] - p.empty.metrics[k])) }])) });
  const seedCoverage = [];
  for (const unit of await fs.readdir(`${args.seeded}/units`).catch(() => [])) {
    const seed = await read(`${args.seeded}/units/${unit}/seed.json`);
    if (seed) seedCoverage.push({ unit, statements: seed.statements.length, files: seed.snapshot.metrics.files, settled: !seed.commits.timedOut });
  }
  const result = { planned: 29, completed: pairs.length, complete: pairs.length === 29, ...summary(pairs),
    general: summary(pairs.filter(p => p.caseId.startsWith('G'))), medical: summary(pairs.filter(p => p.caseId.startsWith('M'))), seedCoverage, pairs };
  await save(`${args.out}/g10.json`, result);
  const md = ['# G10: paired ordinary work', '', `Completed ${pairs.length}/29 pairs. Deterministic checks are the existing general-task checks; normal variants only.`, '',
    `Empty: ${fmtProp(result.empty)}. Seeded: ${fmtProp(result.seeded)}. Difference: ${fmtPair(result.pairedPass)}.`, '',
    '| Case | Empty / seeded pass | Tool calls empty / seeded | Tokens empty / seeded |', '|---|---|---|---|',
    ...pairs.map(p => `| ${p.caseId} | ${p.empty.status} / ${p.seeded.status} | ${p.empty.metrics.toolCalls} / ${p.seeded.metrics.toolCalls} | ${p.empty.metrics.totalTokens} / ${p.seeded.metrics.totalTokens} |`), '',
    'Seed ingestion is setup and excluded from task token/tool means. Both arms retain the memory plugin. A non-significant difference is not proof of non-inferiority.'];
  await fs.writeFile(`${args.out}/g10.md`, md.join('\n') + '\n');
  return result;
}
async function g3() {
  const records = [];
  for (const dir of args.runs.split(',')) for (const file of await fs.readdir(`${dir}/results`).catch(() => [])) if (/^S\d+-r\d+\.json$/.test(file)) records.push(await read(`${dir}/results/${file}`));
  const scenarios = Array.from({ length: 11 }, (_, i) => { const id = `S${i + 1}`, found = records.filter(r => r.id === id); return { id, n: found.length, allFivePass: found.length === 5 && found.every(r => r.status === 'pass'), statuses: found.map(r => r.status) }; });
  const complete = scenarios.every(s => s.n === 5);
  const result = { plannedRuns: 55, completedRuns: records.length, complete, allFivePass: complete ? prop(scenarios.map(s => s.allFivePass)) : null, completedScenarioEstimate: prop(scenarios.filter(s => s.n === 5).map(s => s.allFivePass)), scenarios, records };
  await save(`${args.out}/g3.json`, result);
  await fs.writeFile(`${args.out}/g3.md`, ['# G3: eleven scenarios, five repetitions', '', complete ? `All five pass: ${fmtProp(result.allFivePass)}.` : `Incomplete: ${records.length}/55 runs; no full-suite estimate.`, '',
    '| Scenario | Repetitions | Statuses | All five pass |', '|---|---|---|---|', ...scenarios.map(s => `| ${s.id} | ${s.n}/5 | ${s.statuses.join(', ')} | ${s.n === 5 ? s.allFivePass : 'pending'} |`), ''].join('\n'));
  return result;
}
async function ledger(result) {
  if (!result.complete || !args.ledger) return;
  const dirs = args.runs?.split(',') ?? [args.empty, args.seeded];
  const provenance = await read(`${dirs[0]}/provenance.json`);
  const engine = await read(`${dirs[0]}/engine.json`);
  if (!provenance || !engine) throw new Error('Missing recorded engine/provenance; ledger rows refused');
  const measurements = [];
  if (args.suite === 'g1') {
    measurements.push({ metric: 'answerAccuracy', ...result.overall.product, byStep: Object.fromEntries(Object.entries(result.overall.byFailureStep).map(([k, v]) => [k, v.product.pass])) });
    for (const [cat, v] of Object.entries(result.byCategory)) measurements.push({ metric: `answerAccuracy:${cat}`, ...v.product });
    for (const [step, v] of Object.entries(result.overall.observedStages)) measurements.push({ metric: `observed:${step}`, ...v.product });
  } else if (args.suite === 'g10') {
    for (const arm of ['empty', 'seeded']) measurements.push({ metric: `passRate:${arm}`, arm, ...result[arm] });
    for (const [metric, value] of Object.entries(result.metrics)) for (const arm of ['empty', 'seeded']) measurements.push({ metric: `${metric}PerTask:${arm}`, arm, n: result.completed, value: value[arm], ci95: value[`${arm}Ci95`] });
  } else measurements.push({ metric: 'allFivePass', ...result.allFivePass });
  const receipts = [];
  const walk = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (/sealed/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/^(usage|usage-.+)\.json$/.test(entry.name)) { const r = await read(full); if (r?.account) receipts.push(r.account); }
    }
  };
  for (const dir of dirs) for (const child of ['cases', 'units', 'browser']) await walk(`${dir}/${child}`);
  const tokens = { prompt: receipts.reduce((n, r) => n + (r.cacheHitTokens ?? 0) + (r.cacheMissTokens ?? 0), 0),
    completion: receipts.reduce((n, r) => n + (r.completionTokens ?? 0), 0), cached: receipts.reduce((n, r) => n + (r.cacheHitTokens ?? 0), 0), extractionPrompt: 0, extractionCompletion: 0 };
  const judgedFor = m => {
    if (args.suite !== 'g1' || !m.metric.startsWith('answerAccuracy')) return { code: m.n, judge: 0, unknown: 0, error: 0 };
    const category = m.metric.slice('answerAccuracy:'.length);
    const held = result.pairs.filter(p => m.metric === 'answerAccuracy' || p.category === category).map(p => p.product);
    return { code: held.filter(r => ['pass', 'fail'].includes(r.verdict) && r.by !== 'judge').length,
      judge: held.filter(r => ['pass', 'fail'].includes(r.verdict) && r.by === 'judge').length,
      unknown: held.filter(r => !['pass', 'fail', 'error'].includes(r.verdict)).length, error: held.filter(r => r.verdict === 'error').length };
  };
  const rows = measurements.map(m => ({ runId: args['run-id'] ?? `eg-${args.suite}-20261111`, commit: provenance.commit, arm: m.arm ?? 'product-path', set: args.suite, split: 'dev',
    metric: m.metric, scorer: 'eg-product-path/1', rawPath: `${args.out}/${args.suite}.json`, engine, flags: { lane: 'run', lockIsolation: true, safetyNotes: false,
      candidate: Object.fromEntries(Object.entries(provenance.env).filter(([k]) => k.startsWith('OPEN_SCIENCE_MEMORY_'))), complete: true,
      tokenScope: 'control-plane account receipts including setup, direct engine extraction unobserved', observedControlPlaneCostCny: receipts.reduce((n, r) => n + r.actualCost, 0) },
    n: m.n, value: m.value, ci95: m.ci95, judged: judgedFor(m),
    tokens, costCny: null, wallSeconds: Math.max(0, (Date.now() - Date.parse(provenance.attempts?.[0]?.at ?? provenance.at)) / 1000), ...(m.byStep ? { byStep: m.byStep } : {}) }));
  await save(`${args.out}/${args.suite}-ledger-rows.json`, rows);
  console.log(appendLedgerRows(args.ledger, rows));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fs.mkdir(args.out, { recursive: true });
  const result = args.suite === 'g1' ? await g1() : args.suite === 'g10' ? await g10() : await g3();
  await ledger(result);
  console.log(JSON.stringify({ suite: args.suite, complete: result.complete, completed: result.completed ?? result.completedRuns }));
}
