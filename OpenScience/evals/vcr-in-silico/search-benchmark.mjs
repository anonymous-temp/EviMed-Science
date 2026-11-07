#!/usr/bin/env node
// The design-search benchmark (plan T10, A19): 30 predeclared candidate designs in two families, searched by fixed arms at matched
// budgets on the local engine, with no model call. Every arm runs the platform's own decision code (`@evimed/domain`
// vcrExperimentSearch: the same manifest validation, seeds, screening, bounds and stop reasons the hosted campaign uses); only the
// transport differs: each unit is one `Rscript service/run_job.R` process, run serially, i.e. the shared host's one-job profile.
//
//   node OpenScience/evals/vcr-in-silico/search-benchmark.mjs [--out <file.json>] [--cache <units.jsonl>] [--exhaustive] [--families analytic,survival]
//   node OpenScience/evals/vcr-in-silico/search-benchmark.mjs --score <campaign-view.json> --reference <results.json>
//
// Needs R with the engine's lock (VCR_R_LIBS) and VCR_ENGINE_ROOT; scratch goes to $TMPDIR. Deterministic: the same revision gives
// the same seeds, the same numbers and the same decisions (times differ).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VCR_ENGINE_METHODS, vcrCampaignAdvance, vcrCampaignCanonical, vcrCampaignCandidates, vcrCampaignInitialState, vcrCampaignManifest, vcrCampaignRecord,
  vcrCampaignVerdict, vcrCandidateVerdicts,
} from '../../packages/domain/index.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = process.env.VCR_ENGINE_ROOT || path.resolve(here, '../../../项目代码/vcr-engine');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// --- the 30 predeclared candidates -------------------------------------------------------------------------------------------

/** The cheap family: 15 closed-form sample sizes of a two-arm survival design (allocation x accrual duration), exact. */
function analyticManifest() {
  const values = { allocation: [0.5, 0.6, 2 / 3], duration: [12, 15, 18, 21, 24] };
  return {
    question: 'Fewest patients for 80% power at HR 0.70, at most 330 events, by allocation and accrual duration (closed form)',
    objective: { measure: 'required_patients', direction: 'minimize', truth: 'planned' },
    constraints: [{ measure: 'required_events', op: '<=', bound: 330, kind: 'design', truth: 'planned' }],
    space: { method: 'design.analytic', scenario: { design: { kind: 'two_arm_fixed', allocation: 0.5 }, endpoint: { type: 'time_to_event' },
      truth: { hazardRatio: 0.7, controlMedian: 12 }, analysis: { alpha: 0.025, power: 0.8, sided: 1 }, accrual: { duration: 12, followup: 12, dropoutAnnual: 0.05 } },
    truths: [{ name: 'planned', truth: { hazardRatio: 0.7, controlMedian: 12 } }],
    variables: [{ path: 'design.allocation', values: values.allocation }, { path: 'accrual.duration', values: values.duration }] },
    stages: { screening: null, final: { count: 5 } },
    budget: { maxCandidates: 15, cpuSeconds: 600, modelCalls: 0 },
  };
}

/** The heavy family: 15 simulated two-arm log-rank designs (patients per arm x accrual duration), power and type I error. */
const SURVIVAL = { nPerArm: [100, 125, 150, 175, 200], duration: [12, 18, 24] };
function survivalSpace(order = null) {
  const grid = SURVIVAL.nPerArm.flatMap((n) => SURVIVAL.duration.map((d) => ({ set: { 'design.nTreat': n, 'design.nControl': n, 'accrual.duration': d } })));
  return order ? order.map((i) => grid[i]) : grid;
}
function survivalManifest({ label, screening, finalCount, cpuSeconds, order = null, reference = null }) {
  return {
    question: `Fewest patients with power at least 80% at HR 0.70 and type I error held at 2.5% (${label})`,
    objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
    constraints: [
      { measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' },
      { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null', analyticSupport: true },
    ],
    space: { method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }, endpoint: { type: 'time_to_event' },
      truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: 'uniform', duration: 18, followup: 12 },
      analysis: { method: 'logrank', alpha: 0.025, sided: 1 }, performance: ['power', 'type_one_error', 'expected_sample_size'] },
    truths: [{ name: 'alternative', truth: { hazardRatio: 0.7, controlMedian: 12 } }, { name: 'null', truth: { hazardRatio: 1, controlMedian: 12 } }],
    candidates: survivalSpace(order) },
    stages: { screening: screening ? { replicates: screening } : null, final: { count: finalCount } },
    budget: { maxCandidates: 15, cpuSeconds, modelCalls: 0 },
    ...(reference == null ? {} : { reference }),
  };
}

/** A fixed permutation of 0..n-1 from a seed (the random arm's predeclared order). */
function permutation(n, seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Array.from({ length: n }, (_, i) => ({ i, u: next() })).sort((x, y) => x.u - y.u).map((x) => x.i);
}

// --- running a campaign on the local engine ------------------------------------------------------------------------------------

/**
 * Finished units by their idempotency key (`--cache <file.jsonl>`): seeds and scenarios are deterministic, so a unit that ran is the
 * same unit when the benchmark is resumed after an interruption, and its recorded outcome and cost are reused, never rerun.
 */
const cacheFile = option('--cache');
const cache = new Map();
if (cacheFile) {
  const text = await fs.readFile(cacheFile, 'utf8').catch(() => '');
  for (const line of text.split('\n').filter(Boolean)) { const row = JSON.parse(line); cache.set(row.key, row.value); }
}

/** One unit: a job file, one R process, its result and its cost. */
async function runUnit(scratch, unit, cpuSecondsLimit) {
  const cacheKey = `${unit.idempotencyKey}:${Math.max(1, Math.ceil(cpuSecondsLimit))}`;
  if (cache.has(cacheKey)) return { ...cache.get(cacheKey), cached: true };
  const value = await runUnitNow(scratch, unit, cpuSecondsLimit);
  if (cacheFile) await fs.appendFile(cacheFile, `${JSON.stringify({ key: cacheKey, value })}\n`);
  return value;
}

/** @param {string} scratch @param {any} unit @param {number} cpuSecondsLimit */
async function runUnitNow(scratch, unit, cpuSecondsLimit) {
  const jobId = `job_${sha256(`${unit.idempotencyKey}`).slice(0, 16)}`;
  const dir = path.join(scratch, jobId);
  await fs.mkdir(dir, { recursive: true });
  const job = { jobId, studyId: 'std_bench', kind: unit.kind, method: unit.method, methodVersion: unit.version, protocolVersion: 1, scenario: unit.scenario,
    inputs: [{ kind: 'assumption', id: 'asm_bench@1' }], seed: unit.seed, cpuSecondsLimit: Math.max(1, Math.ceil(cpuSecondsLimit)), cores: Number(process.env.VCR_TEST_CORES ?? 2),
    ...(unit.replicates ? { replicates: unit.replicates } : {}) };
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
  const started = Date.now();
  // run_job.R exits 1 for a result that is not a success (a CPU budget spent mid-run is one); its result file says what happened
  let stderr = '';
  try {
    ({ stderr } = await run('/usr/bin/time', ['-f', 'VCR_BENCH %M %e', 'Rscript', path.join(engineRoot, 'service/run_job.R'), path.join(dir, 'job.json'), path.join(dir, 'out')],
      { env: { ...process.env, VCR_ENGINE_ROOT: engineRoot, VCR_ENGINE_CORES: String(job.cores) }, timeout: 3_600_000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    stderr = String(error?.stderr ?? '');
    if (!(await fs.stat(path.join(dir, 'out', 'result.json')).catch(() => null))) throw error;
  }
  const wall = (Date.now() - started) / 1000;
  const peak = Number(/VCR_BENCH (\d+) /.exec(stderr)?.[1] ?? 0);
  const result = JSON.parse(await fs.readFile(path.join(dir, 'out', 'result.json'), 'utf8'));
  await fs.rm(dir, { recursive: true, force: true });
  const evaluation = result.diagnostics?.evaluation ?? {};
  return { outcome: { jobId, state: result.status === 'succeeded' || result.status === 'not_estimable' ? 'succeeded' : result.status, seed: unit.seed,
    replicates: result.replicates ?? null, precision: evaluation.purpose, measures: result.measures ?? [], cpuSeconds: Number(result.manifest?.cpuSeconds ?? 0),
    queueSeconds: 0, wallSeconds: wall, issues: (result.diagnostics?.issues ?? []).map((i) => i.code), drawSignature: evaluation.drawSignature ?? null, rejects: evaluation.rejects ?? null },
  profile: { unit: unit.key, stage: unit.stage, method: unit.method, replicates: result.replicates ?? null, engineCpuSeconds: Number(result.manifest?.cpuSeconds ?? 0), wallSeconds: wall, peakKb: peak } };
}

/** Drive a campaign to its stop with the domain's own state machine; serial, one unit in flight. */
async function campaign(name, input, scratch) {
  const { manifest, issues } = vcrCampaignManifest(input);
  if (!manifest) throw new Error(`${name}: ${JSON.stringify(issues)}`);
  const identity = sha256(vcrCampaignCanonical(manifest));
  let state = vcrCampaignInitialState(manifest);
  const units = [];
  const began = Date.now();
  for (let step = 0; step < 500; step++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity });
    state = next;
    if (action.type !== 'evaluate') break;
    const queued = (Date.now() - began) / 1000;
    const left = manifest.budget.cpuSeconds - state.usage.cpuSeconds;
    const { outcome, profile } = await runUnit(scratch, action.unit, Math.min(3600, left));
    units.push({ ...profile, submittedAt: queued });
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: action.unit.key, unit: action.unit } }, action.unit, outcome);
    process.stderr.write(`${name}: ${action.unit.key} ${outcome.state} ${profile.engineCpuSeconds.toFixed(1)} cpu-s ${profile.wallSeconds.toFixed(1)} s\n`);
  }
  // the arm's wall time is the sum of its units' (they run serially), so a run resumed from the cache reports what the units cost
  return summarize(name, manifest, state, units, units.reduce((total, unit) => total + unit.wallSeconds, 0));
}

/** What an arm decided and what it cost. */
function summarize(name, manifest, state, units, wall) {
  const candidates = vcrCampaignCandidates(manifest);
  const verdict = state.finalists ? vcrCampaignVerdict(manifest, state) : { best: null, feasible: [], inconclusive: [] };
  const describe = (key) => {
    const c = candidates.find((x) => x.key === key);
    const entry = state.candidates[key];
    const value = (stage, truth, measure) => entry.evaluations[`${stage}:${truth}`]?.measures?.find((m) => m.name === measure) ?? null;
    return { key, set: c?.set ?? null, status: entry.status, reason: entry.reason ?? null,
      final: Object.fromEntries(['power', 'type_one_error', 'expected_sample_size', 'required_patients', 'required_events']
        .map((m) => [m, value('final', 'alternative', m) ?? value('final', 'null', m) ?? value('final', 'planned', m)]).filter(([, v]) => v)),
      verdicts: vcrCandidateVerdicts(manifest, entry, 'final').map((v) => ({ measure: v.measure, status: v.status, bound: v.bound ?? null })) };
  };
  // the 1-job profile: the queue a unit would wait in had every unit of this arm been submitted at once to the shared queue
  let ahead = 0;
  const profile = units.map((u) => { const row = { ...u, queueIfSubmittedTogether: ahead }; ahead += u.wallSeconds; return row; });
  return {
    arm: name, stop: state.stop?.reason ?? null, best: verdict.best ? describe(verdict.best) : null, feasible: verdict.feasible, inconclusive: verdict.inconclusive,
    finalists: state.finalists ?? [], candidates: candidates.map((c) => describe(c.key)),
    evaluated: candidates.filter((c) => Object.keys(state.candidates[c.key].evaluations).length).length,
    usage: { ...state.usage, units: units.length, wallSeconds: wall, peakKb: Math.max(0, ...units.map((u) => u.peakKb)),
      queueIfSubmittedTogether: { total: profile.reduce((t, u) => t + u.queueIfSubmittedTogether, 0), max: Math.max(0, ...profile.map((u) => u.queueIfSubmittedTogether)) } },
    units: profile,
  };
}

/** Score an arm against the full-precision reference: did it find the reference's best design, and how much worse is its pick. */
function score(arm, reference) {
  const refBest = reference?.best?.final?.expected_sample_size?.value ?? null;
  const pick = arm.best?.final?.expected_sample_size?.value ?? null;
  return { arm: arm.arm, stop: arm.stop, picked: arm.best?.set ?? null, pickedSize: pick, referenceSize: refBest,
    foundReferenceBest: refBest != null && pick === refBest, sizeAboveReference: refBest != null && pick != null ? pick - refBest : null,
    feasibleFound: arm.feasible.length > 0, cpuSeconds: arm.usage.cpuSeconds, wallSeconds: arm.usage.wallSeconds, units: arm.usage.units };
}

// --- main ----------------------------------------------------------------------------------------------------------------------

if (option('--score')) {
  const view = JSON.parse(await fs.readFile(option('--score'), 'utf8'));
  const reference = JSON.parse(await fs.readFile(option('--reference'), 'utf8')).survival.exhaustive;
  const best = view.candidates?.find((c) => c.key === view.best);
  const arm = { arm: 'agent', stop: view.stop?.reason ?? null, feasible: view.feasible ?? [], usage: { cpuSeconds: view.budget?.used?.cpuSeconds ?? null, wallSeconds: view.budget?.used?.wallSeconds ?? null, units: view.budget?.used?.units ?? null },
    best: best ? { set: best.set, final: { expected_sample_size: { value: best.objective?.final?.value ?? null } } } : null };
  process.stdout.write(`${JSON.stringify(score(arm, reference), null, 2)}\n`);
  process.exit(0);
}

const families = (option('--families', 'analytic,survival') ?? '').split(',');
const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'vcr-search-bench-'));
const out = { revision: null, engine: { versions: { 'design.simulate': VCR_ENGINE_METHODS['design.simulate'].version, 'design.analytic': VCR_ENGINE_METHODS['design.analytic'].version },
  cores: Number(process.env.VCR_TEST_CORES ?? 2), concurrency: 1 }, startedAt: new Date().toISOString() };
try { out.revision = (await run('git', ['rev-parse', 'HEAD'], { cwd: here })).stdout.trim(); } catch { out.revision = null; }
try {
  if (families.includes('analytic')) out.analytic = { campaign: await campaign('analytic', analyticManifest(), scratch) };
  if (families.includes('survival')) {
    const s = {};
    // the fixed expert design (150 per arm, 18 months of accrual) checked at full precision
    s.reference = await campaign('reference', { ...survivalManifest({ label: 'reference design', screening: null, finalCount: 5, cpuSeconds: 3600 }),
      space: { ...survivalManifest({ label: 'x', screening: null, finalCount: 1, cpuSeconds: 1 }).space, candidates: [survivalSpace()[7]] }, budget: { maxCandidates: 1, cpuSeconds: 3600 } }, scratch);
    // the staged campaign: screen all 15 at 300 replicates, re-check 3 finalists at the floor on new streams
    s.staged = await campaign('staged', survivalManifest({ label: 'staged', screening: 300, finalCount: 3, cpuSeconds: 3600 }), scratch);
    const budget = s.staged.usage.cpuSeconds;
    // ordinary grid and random search at the staged campaign's budget: every unit at full precision, in space order or a fixed random order
    s.grid = await campaign('grid', survivalManifest({ label: 'grid at matched budget', screening: null, finalCount: 5, cpuSeconds: budget }), scratch);
    s.random = await campaign('random', survivalManifest({ label: 'random at matched budget', screening: null, finalCount: 5, cpuSeconds: budget, order: permutation(15, 20261107) }), scratch);
    // the full-precision answer every arm is scored against (every candidate under both truths; no budget)
    if (flag('--exhaustive')) s.exhaustive = await campaign('exhaustive', survivalManifest({ label: 'exhaustive', screening: null, finalCount: 5, cpuSeconds: 100000 }), scratch);
    s.scores = ['reference', 'staged', 'grid', 'random'].map((name) => score(s[name], s.exhaustive ?? null));
    s.matchedBudgetCpuSeconds = budget;
    out.survival = s;
  }
  out.finishedAt = new Date().toISOString();
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
const file = option('--out');
if (file) await fs.writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ analytic: out.analytic ? { stop: out.analytic.campaign.stop, best: out.analytic.campaign.best?.set, usage: out.analytic.campaign.usage } : null,
  survival: out.survival?.scores ?? null }, null, 2)}\n`);
