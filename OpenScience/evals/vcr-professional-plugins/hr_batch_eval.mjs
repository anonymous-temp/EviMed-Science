#!/usr/bin/env node
/** The ICU heart-rate task through the batch trajectory path (plan T08, A05/A06): the stays of one split, their first six hours as
 * the history, a local deterministic adapter standing in for the model, and the platform's own forecast evaluation of what came back.
 *
 * Nothing here calls a model or a network: the "provider" is a function over the local files (persistence, or the regression the
 * engine fitted on split A, read from a predictions CSV), run through `createForecastProviders` so the batching, the per-person
 * ledger and the origin cut are the product's. Selection is frozen: the equation was fitted on A and is only read here; no threshold
 * or arm is chosen on B or C. The denominator is the whole split: stays that lacked an early or a 24-hour heart rate were dropped by
 * `hr_baseline.py` before this path and are carried in from its counts, so submitted + dropped = every stay.
 *
 *   node hr_batch_eval.mjs --clinical <dir with hr-b-paired.csv, hr-baseline.json> --split b [--predictions <csv: USUBJID or patientId (the engine's own column), prediction>] --out <file.json>
 *
 * Aggregates only: no patient row is written. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateForecast } from '@evimed/domain';
import { createForecastProviders } from '../../apps/server/src/vcrForecastProvider.mjs';

const ORIGIN = '2026-01-01T06:00:00.000Z';
// the target is the heart rate nearest 24 h after admission, 18 h after the six-hour origin
const HORIZON = 0.75;
const at = hours => new Date(Date.parse('2026-01-01T00:00:00.000Z') + hours * 3_600_000).toISOString();
const endpoint = { code: 'HR', type: 'continuous', unit: 'bpm' };
const permission = { schema: 1, status: 'approved', dataClass: 'synthetic', purpose: 'vcr', destinations: ['https://local-adapter.example.org'] };

/** One CSV line into fields; a quoted field (the engine's own writer quotes every string, and `""` is a quote inside one) is read as its text.
 * @param {string} line */
function splitLine(line) {
  const fields = [];
  for (let i = 0, field = '', quoted = false; i <= line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch ?? '';
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',' || ch === undefined) { fields.push(field); field = ''; } else field += ch;
  }
  return fields;
}

/** @param {string} text */
export function parseCsv(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const names = splitLine(head);
  return rows.map(row => Object.fromEntries(splitLine(row).map((value, index) => [names[index], value])));
}

/**
 * @param {{pairs:Array<{USUBJID:string,hr_early:string,hr_24:string}>, predictions?:Map<string,number>|null, dropped?:Record<string,number>|null, batchSize?:number}} input
 */
export async function runBatchEval({ pairs, predictions = null, dropped = null, batchSize = 500 }) {
  const subjects = pairs.map(p => p.USUBJID);
  const early = new Map(pairs.map(p => [p.USUBJID, Number(p.hr_early)]));
  const history = { asOf: ORIGIN, subjects, events: pairs.map(p => ({ subjectKey: p.USUBJID, code: 'HR', value: Number(p.hr_early), originalValue: p.hr_early, unit: 'bpm',
    occurredAt: at(5.9), availableAt: at(5.9), kind: 'measurement', valueSource: 'observed', assertion: 'affirmed', experiencer: 'patient' })) };
  const outcomes = { asOf: at(25), subjects, events: pairs.map(p => ({ subjectKey: p.USUBJID, code: 'HR', value: Number(p.hr_24), unit: 'bpm', occurredAt: at(24), availableAt: at(24),
    kind: 'measurement', valueSource: 'observed', assertion: 'affirmed', experiencer: 'patient' })) };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hr-batch-'));
  try {
    const file = path.join(root, 'providers.json');
    await fs.writeFile(file, JSON.stringify({ providers: [{ id: 'local', url: 'https://local-adapter.example.org/predict', protocol: 'evimed-event-history-v1', enabled: true,
      model: predictions ? 'engine-regression' : 'persistence', version: 'frozen', batchSize, inputCodes: ['HR'] }] }));
    const adapter = async (/** @type {any} */ _url, /** @type {any} */ init) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ schema: 1, origin: body.origin, endpoint: body.endpoint, model: body.model, version: 'frozen',
        rows: body.subjects.flatMap((/** @type {string} */ key) => {
          const point = predictions ? predictions.get(key) : early.get(key);
          return Number.isFinite(point) ? [{ subjectKey: key, horizonDays: HORIZON, point }] : [];
        }) }));
    };
    const api = createForecastProviders({ file, fetchImpl: adapter });
    const result = await api.predict({ providerId: 'local', jobId: 'hr-batch', history, endpoint, horizonsDays: [HORIZON], seed: 1, permissions: async () => [permission],
      onBatch: async () => {}, isCanceled: async () => false });
    const prediction = { origin: ORIGIN, endpoint, horizonsDays: [HORIZON], rows: result.rows, rejected: result.rejected, issues: [], model: result.provider, historyId: 'hr-history', dataClass: 'patient' };
    const evaluation = evaluateForecast(prediction, { ...history, split: null }, outcomes, { windowDays: 1 / 24, bootstrap: 200, seed: 20261107 });
    const group = evaluation.groups[0];
    const dropBefore = dropped ? Object.values(dropped).reduce((n, v) => n + v, 0) : null;
    return { arm: predictions ? 'engine regression (fitted on A, applied as frozen)' : 'persistence (last early HR)',
      denominator: { ...result.accounting.counts, droppedBeforeBatch: dropped, wholeSplit: dropBefore == null ? null : result.accounting.counts.submitted + dropBefore },
      reasons: result.accounting.lines.reduce((/** @type {Record<string,number>} */ out, line) => { if (line.reason) out[line.reason] = (out[line.reason] ?? 0) + 1; return out; }, {}),
      evaluated: group.evaluated, requested: group.requested, missingForecasts: group.missingForecasts, missingOutcomes: group.missingOutcomes,
      metrics: { mae: group.metrics.mae, rmse: group.metrics.rmse }, persistenceBaseline: group.baselines?.persistence?.comparisons ?? null,
      uncertainty: result.uncertainty, selection: 'frozen: equation fitted on split A; no arm or threshold chosen on this split' };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((/** @type {string[][]} */ acc, item, i, all) => item.startsWith('--') ? [...acc, [item.slice(2), all[i + 1]]] : acc, []));
  if (!args.clinical || !args.split || !args.out) throw new Error('Usage: --clinical <dir> --split b|c --out <file> [--predictions <csv>]');
  const pairs = parseCsv(await fs.readFile(path.join(args.clinical, `hr-${args.split}-paired.csv`), 'utf8'));
  const baseline = JSON.parse(await fs.readFile(path.join(args.clinical, 'hr-baseline.json'), 'utf8')).splits?.[args.split];
  const dropped = baseline ? { noEarlyOrNoTarget: baseline.no_both } : null;
  const predictionRows = args.predictions ? parseCsv(await fs.readFile(args.predictions, 'utf8')) : null;
  // A predictions file with neither id column would read as "every forecast missing"; say what is wrong instead.
  if (predictionRows && !(predictionRows.length && ('USUBJID' in predictionRows[0] || 'patientId' in predictionRows[0]) && 'prediction' in predictionRows[0])) throw new Error('predictions csv needs a USUBJID or patientId column and a prediction column');
  const predictions = predictionRows ? new Map(predictionRows.map(r => [r.USUBJID ?? r.patientId, Number(r.prediction)])) : null;
  const persistence = await runBatchEval({ pairs, dropped });
  const arms = predictions ? [persistence, await runBatchEval({ pairs, predictions, dropped })] : [persistence];
  await fs.writeFile(args.out, JSON.stringify({ split: args.split, records: baseline?.records ?? null, arms }, null, 2) + '\n');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
