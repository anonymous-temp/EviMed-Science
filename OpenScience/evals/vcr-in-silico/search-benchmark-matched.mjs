#!/usr/bin/env node
// The matched-budget search benchmark (round-2 plan R36, §C.6 ability 2). Protocol: BENCHMARK-PROTOCOL.md (frozen before the first
// run; read it first). Six arms search two predeclared design spaces at the same budget of simulated trials, over many seeds, and are
// scored against a known truth: the high-precision exhaustive results of the 2026-11-07 benchmark (`results/search-benchmark-20261107.json`).
// "Ours" is the platform's own campaign, driven by `@evimed/domain`'s state machine (the same manifest validation, ranking, Clopper-Pearson
// verdicts and stop reasons the hosted campaign uses); only the transport differs: a unit's outcome is drawn from the truth table
// instead of one `Rscript` process (the campaign's CPU-second ceiling is kept in thousands of trials). No model call.
//
//   node OpenScience/evals/vcr-in-silico/search-benchmark-matched.mjs [--seeds 200] [--out <results.json>] [--tables <tables.md>] [--svg-dir <dir>]
//   node OpenScience/evals/vcr-in-silico/search-benchmark-matched.mjs --calibrate [--out <calibration.json>]   (real engine, needs VCR_R_LIBS)
//   node OpenScience/evals/vcr-in-silico/search-benchmark-matched.mjs --score-agent <campaign-view.json> --world survival|level [--trials <n>]
//
// Hidden knowledge: a unit is a draw from Binomial(replicates, true rate), which is exactly what the engine's rejection count is for
// independent replicates; the objective (patients) is a deterministic function of the design. The truth table is itself one run's
// estimate (SE 0.5 points on power, 0.11 on type I error), so a design's "true" feasibility near a bound is a property of this defined world.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  vcrCampaignAdvance, vcrCampaignCandidates, vcrCampaignCanonical, vcrCampaignManifest, vcrCampaignRecord, vcrCampaignInitialState,
  vcrCampaignUnit, vcrCampaignVerdict, vcrClopperPearson,
} from '../../packages/domain/index.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = process.env.VCR_ENGINE_ROOT || path.resolve(here, '../../../项目代码/vcr-engine');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// --- frozen constants (BENCHMARK-PROTOCOL.md) ---------------------------------------------------------------------------------
const FROZEN = {
  seeds: 200,
  budgets: [40_000, 80_000, 160_000, 320_000, 640_000],
  powerBound: 0.8, typeOneBound: 0.025,
  floors: { alternative: 5_000, null: 20_000 },
  splitAlt: 0.2, // a baseline's candidate share of trials under the alternative; the floors' own ratio (5,000 : 25,000)
  epsilonPatients: 50, successLevel: 0.8,
  ocba: { stageOneShare: 0.3, indifference: 0.005 },
  calibration: { screeningReplicates: 300, screeningSeeds: 30, finalAltSeeds: 10, finalNullSeeds: 5, sdRatio: [0.8, 1.25] },
  arms: ['grid', 'random', 'halving', 'ocba', 'ours'],
};
const reference = option('--reference', path.join(here, 'results/search-benchmark-20261107.json'));

// --- the two spaces -----------------------------------------------------------------------------------------------------------
/** Manifests as search-benchmark.mjs builds them (the same candidates in the same order, the same constraints and truths). */
function baseManifest({ label, candidates, screeningReplicates, finalCount, cpuSeconds, accrual, nTreat, powerBound = FROZEN.powerBound }) {
  return {
    question: `Fewest patients with power at least 80% at HR 0.70 and type I error held at 2.5% (${label})`,
    objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
    constraints: [
      { measure: 'power', op: '>=', bound: powerBound, kind: 'design', truth: 'alternative' },
      { measure: 'type_one_error', op: '<=', bound: FROZEN.typeOneBound, kind: 'error_control', truth: 'null', ...(label === 'survival' ? { analyticSupport: true } : {}) },
    ],
    space: { method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat, nControl: nTreat }, endpoint: { type: 'time_to_event' },
      truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: 'uniform', duration: accrual, followup: 12 },
      analysis: { method: 'logrank', alpha: 0.025, sided: 1 }, performance: ['power', 'type_one_error', 'expected_sample_size'] },
    truths: [{ name: 'alternative', truth: { hazardRatio: 0.7, controlMedian: 12 } }, { name: 'null', truth: { hazardRatio: 1, controlMedian: 12 } }],
    candidates },
    stages: { screening: { replicates: screeningReplicates }, final: { count: finalCount } },
    budget: { maxCandidates: candidates.length, cpuSeconds, modelCalls: 0 },
  };
}
const SPACES = {
  survival: { reference: 'survival', candidates: () => [100, 125, 150, 175, 200].flatMap((n) => [12, 18, 24].map((d) => ({ set: { 'design.nTreat': n, 'design.nControl': n, 'accrual.duration': d } }))),
    scenario: { accrual: 18, nTreat: 150 } },
  // the level family under a tighter power requirement (85%): a different feasible set and optimum from the same truth table
  level85: { reference: 'level', powerBound: 0.85, candidates: () => SPACES.level.candidates(), scenario: { accrual: 24, nTreat: 200 } },
  level: { reference: 'level', candidates: () => [200, 225, 250].flatMap((n) => [0.025, 0.0235, 0.022, 0.02].map((a) => ({ set: { 'design.nTreat': n, 'design.nControl': n, 'analysis.alpha': a } }))),
    scenario: { accrual: 24, nTreat: 200 } },
};

/** A world: for each candidate, the patients and the true power and type I error (the reference's full-precision values). */
async function loadWorld(name) {
  const doc = JSON.parse(await fs.readFile(reference, 'utf8'));
  const rows = doc[SPACES[name].reference].exhaustive.candidates;
  const space = SPACES[name].candidates();
  const items = rows.map((row, i) => {
    if (JSON.stringify(row.set) !== JSON.stringify(space[i].set)) throw new Error(`${name}: candidate ${i} differs from the reference`);
    return { index: i, set: row.set, patients: row.final.expected_sample_size.value, power: row.final.power.value, typeOne: row.final.type_one_error.value };
  });
  const powerBound = SPACES[name].powerBound ?? FROZEN.powerBound;
  const feasible = items.filter((c) => c.power >= powerBound && c.typeOne <= FROZEN.typeOneBound);
  const best = Math.min(...feasible.map((c) => c.patients));
  const patients = items.map((c) => c.patients);
  const step = [...new Set(patients)].sort((a, b) => a - b).reduce((s, v, i, a) => (i ? Math.min(s, v - a[i - 1]) : s), Infinity);
  return { name, powerBound, items, feasibleCount: feasible.length, optimalCount: feasible.filter((c) => c.patients === best).length, bestPatients: best,
    penaltyScore: Math.max(...patients) + step, step };
}

// --- randomness: a keyed stream and an exact binomial -------------------------------------------------------------------------
function fnv1a(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const stream = (...parts) => mulberry32(fnv1a(`isl2-d4|${parts.join('|')}`));

/** Exact Binomial(n, p) by geometric skipping on the rarer side (cost about n * min(p, 1 - p)). */
function binomial(n, p, rng) {
  if (n <= 0) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return n;
  const flip = p > 0.5;
  const q = flip ? 1 - p : p;
  const logq = Math.log1p(-q);
  let position = 0; let count = 0;
  for (;;) {
    position += Math.floor(Math.log(1 - rng()) / logq) + 1;
    if (position > n) break;
    count += 1;
  }
  return flip ? n - count : count;
}

// --- estimates, picks and scoring ---------------------------------------------------------------------------------------------
const emptyCell = () => ({ ka: 0, na: 0, kn: 0, nn: 0 });
const smoothed = (k, n) => (k + 0.5) / (n + 1);

/** Rule S: the smallest design whose point estimates meet both constraints. @param {{ items: any[] }} world @param {Map<number, any>} est */
function pickPoint(world, est, only = null) {
  let pick = null;
  for (const c of world.items) {
    const e = est.get(c.index);
    if (!e || e.na < 1 || e.nn < 1 || (only && !only.has(c.index))) continue;
    if (e.ka / e.na >= world.powerBound && e.kn / e.nn <= FROZEN.typeOneBound && (pick == null || c.patients < world.items[pick].patients)) pick = c.index;
  }
  return pick;
}
/** Rule P: the platform's verdict: both constraints pass on the Clopper-Pearson bound of the estimate's own replicates. */
function pickPlatform(world, est, confidence, only = null) {
  let pick = null;
  for (const c of world.items) {
    const e = est.get(c.index);
    if (!e || e.na < 1 || e.nn < 1 || (only && !only.has(c.index))) continue;
    const power = vcrClopperPearson(e.ka, e.na, confidence);
    const error = vcrClopperPearson(e.kn, e.nn, confidence);
    if (power.lower >= world.powerBound && error.upper <= FROZEN.typeOneBound && (pick == null || c.patients < world.items[pick].patients)) pick = c.index;
  }
  return pick;
}

/** One pick against the world and an independent re-evaluation at the floors. */
function judge(world, pick, rng) {
  if (pick == null) return { category: 'none', regret: world.penaltyScore - world.bestPatients, success: false, trueViolation: null, reevalViolation: null };
  const c = world.items[pick];
  const feasible = c.power >= world.powerBound && c.typeOne <= FROZEN.typeOneBound;
  const ka = binomial(FROZEN.floors.alternative, c.power, rng);
  const kn = binomial(FROZEN.floors.null, c.typeOne, rng);
  const reevalViolation = ka / FROZEN.floors.alternative < world.powerBound || kn / FROZEN.floors.null > FROZEN.typeOneBound;
  if (!feasible) return { category: 'infeasible', regret: world.penaltyScore - world.bestPatients, success: false, trueViolation: true, reevalViolation };
  const gap = c.patients - world.bestPatients;
  return { category: gap === 0 ? 'optimal' : 'suboptimal', regret: gap, success: gap <= FROZEN.epsilonPatients, trueViolation: false, reevalViolation };
}

// --- the arms (every arm returns its estimates, the trials it spent and an optional survivor set) -----------------------------

/** Draw `r` more trials of one cell of a candidate. */
function draw(world, est, index, alt, nul, rng) {
  const c = world.items[index];
  const e = est.get(index) ?? (est.set(index, emptyCell()), est.get(index));
  if (alt > 0) { e.ka += binomial(alt, c.power, rng); e.na += alt; }
  if (nul > 0) { e.kn += binomial(nul, c.typeOne, rng); e.nn += nul; }
  return alt + nul;
}
const split = (trials) => { const alt = Math.floor(trials * FROZEN.splitAlt); return [alt, Math.floor(trials) - alt]; };

function armGrid(world, B, seed) {
  const rng = stream(world.name, 'grid', B, seed); const est = new Map(); let spent = 0;
  const [alt, nul] = split(B / world.items.length);
  for (const c of world.items) spent += draw(world, est, c.index, alt, nul, rng);
  return { est, spent, only: null };
}

function armRandom(world, B, seed) {
  const rng = stream(world.name, 'random', B, seed); const est = new Map(); let spent = 0;
  const order = world.items.map((c) => ({ i: c.index, u: rng() })).sort((a, b) => a.u - b.u).map((x) => x.i);
  const cost = FROZEN.floors.alternative + FROZEN.floors.null;
  for (const index of order) {
    if (spent + cost > B) break;
    spent += draw(world, est, index, FROZEN.floors.alternative, FROZEN.floors.null, rng);
  }
  return { est, spent, only: null };
}

/** Ranking key for halving: point-feasible first, then fewer patients, then the larger feasibility margin. */
function rankKey(world, e) {
  const bound = world.powerBound;
  const pa = smoothed(e.ka, e.na); const pn = smoothed(e.kn, e.nn);
  const za = (e.ka / e.na - bound) / Math.sqrt(pa * (1 - pa) / e.na);
  const zn = (FROZEN.typeOneBound - e.kn / e.nn) / Math.sqrt(pn * (1 - pn) / e.nn);
  return { feasible: e.ka / e.na >= bound && e.kn / e.nn <= FROZEN.typeOneBound, margin: Math.min(za, zn) };
}
function armHalving(world, B, seed) {
  const rng = stream(world.name, 'halving', B, seed); const est = new Map(); let spent = 0;
  const rounds = Math.ceil(Math.log2(world.items.length));
  let alive = world.items.map((c) => c.index);
  for (let r = 0; r < rounds; r++) {
    const [alt, nul] = split(B / rounds / alive.length);
    for (const index of alive) spent += draw(world, est, index, alt, nul, rng);
    if (r < rounds - 1) {
      const ranked = alive.map((index) => ({ index, ...rankKey(world, est.get(index)), patients: world.items[index].patients }))
        .sort((a, b) => Number(b.feasible) - Number(a.feasible) || a.patients - b.patients || b.margin - a.margin || a.index - b.index);
      alive = ranked.slice(0, Math.ceil(alive.length / 2)).map((x) => x.index);
    }
  }
  return { est, spent, only: new Set(alive) };
}

/** Two-stage, OCBA-style: equal first stage, then the rest in proportion to (sigma / distance to the bound)^2 over the critical designs. */
function armOcba(world, B, seed) {
  const rng = stream(world.name, 'ocba', B, seed); const est = new Map(); let spent = 0;
  const [alt, nul] = split(FROZEN.ocba.stageOneShare * B / world.items.length);
  for (const c of world.items) spent += draw(world, est, c.index, alt, nul, rng);
  const feasible = world.items.filter((c) => { const e = est.get(c.index); return e.ka / e.na >= world.powerBound && e.kn / e.nn <= FROZEN.typeOneBound; });
  const star = feasible.length ? Math.min(...feasible.map((c) => c.patients)) : Infinity;
  const critical = world.items.filter((c) => c.patients <= star);
  const cells = [];
  for (const c of critical) {
    const e = est.get(c.index);
    const pa = smoothed(e.ka, e.na); const pn = smoothed(e.kn, e.nn);
    cells.push({ index: c.index, cell: 'a', w: (Math.sqrt(pa * (1 - pa)) / Math.max(Math.abs(pa - world.powerBound), FROZEN.ocba.indifference)) ** 2 });
    cells.push({ index: c.index, cell: 'n', w: (Math.sqrt(pn * (1 - pn)) / Math.max(Math.abs(pn - FROZEN.typeOneBound), FROZEN.ocba.indifference)) ** 2 });
  }
  const total = cells.reduce((s, x) => s + x.w, 0);
  const rest = B - spent;
  for (const x of cells) { const r = Math.floor(rest * x.w / total); spent += draw(world, est, x.index, x.cell === 'a' ? r : 0, x.cell === 'n' ? r : 0, rng); }
  return { est, spent, only: null };
}

// ours: the platform's campaign under the domain's own state machine, a unit's outcome drawn from the truth table
const manifests = new Map();
/** The frozen scaling of the campaign's parameters with the budget: finalists and screening replicates (BENCHMARK-PROTOCOL.md). */
function oursParameters(world, B) {
  const K = world.items.length;
  const finalCount = Math.min(5, Math.max(1, Math.floor(B / 26_667)));
  const screening = Math.min(4_999, Math.max(200, Math.floor((B - finalCount * (FROZEN.floors.alternative + FROZEN.floors.null)) / K / 100) * 100));
  return { finalCount, screening };
}
function oursManifest(world, B) {
  const key = `${world.name}:${B}`;
  if (!manifests.has(key)) {
    const { finalCount, screening } = oursParameters(world, B);
    const sc = SPACES[world.name].scenario;
    const input = baseManifest({ label: world.name, candidates: SPACES[world.name].candidates(), screeningReplicates: screening, finalCount, cpuSeconds: B / 1000, ...sc, powerBound: world.powerBound });
    const { manifest, issues } = vcrCampaignManifest(input);
    if (!manifest) throw new Error(`${world.name}: ${JSON.stringify(issues)}`);
    manifests.set(key, { manifest, identity: sha256(vcrCampaignCanonical(manifest)), candidates: vcrCampaignCandidates(manifest), ...oursParameters(world, B) });
  }
  return manifests.get(key);
}
function armOurs(world, B, seed) {
  const { manifest, identity, candidates } = oursManifest(world, B);
  const indexOf = new Map(candidates.map((c) => [c.key, c.index]));
  const est = new Map(); const finalEst = new Map(); let spent = 0;
  let state = vcrCampaignInitialState(manifest);
  for (let step = 0; step < 500; step++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity });
    state = next;
    if (action.type !== 'evaluate') break;
    const unit = action.unit; const index = indexOf.get(unit.candidate); const c = world.items[index];
    const screening = unit.stage === 'screening';
    const alt = unit.truth === 'alternative';
    const replicates = screening ? manifest.stages.screening.replicates : FROZEN.floors[unit.truth];
    const k = binomial(replicates, alt ? c.power : c.typeOne, stream(world.name, 'ours', B, seed, unit.key));
    const measures = [{ name: 'expected_sample_size', value: c.patients, mcse: 0, simulated: true, ...(screening ? { precision: 'screening' } : {}) },
      alt ? { name: 'power', value: k / replicates, mcse: Math.sqrt((k / replicates) * (1 - k / replicates) / replicates), simulated: true, ...(screening ? { precision: 'screening' } : {}) }
        : { name: 'type_one_error', value: k / replicates, mcse: Math.sqrt((k / replicates) * (1 - k / replicates) / replicates), simulated: true }];
    const outcome = { jobId: `sim_${unit.key}`, state: 'succeeded', seed: seed, replicates, precision: screening ? 'screening' : 'final', measures, cpuSeconds: replicates / 1000 };
    spent += replicates;
    if (!screening) {
      const e = finalEst.get(index) ?? emptyCell(); finalEst.set(index, e);
      if (alt) { e.ka += k; e.na += replicates; } else { e.kn += k; e.nn += replicates; }
    }
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, unit, outcome);
  }
  const verdict = state.finalists ? vcrCampaignVerdict(manifest, state) : { best: null };
  void est;
  return { est: finalEst, spent, only: null, domainPick: verdict.best == null ? null : indexOf.get(verdict.best), stop: state.stop?.reason ?? null };
}
const ARMS = { grid: armGrid, random: armRandom, halving: armHalving, ocba: armOcba, ours: armOurs };

// --- running and aggregating -----------------------------------------------------------------------------------------------------
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q; const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function wilson(k, n, z = 1.959964) {
  if (!n) return [null, null];
  const p = k / n; const d = 1 + z * z / n; const c = p + z * z / (2 * n); const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

function runWorld(world, seeds) {
  const confidence = vcrCampaignManifest(baseManifest({ label: world.name, candidates: SPACES[world.name].candidates(), screeningReplicates: 300, finalCount: 3, cpuSeconds: 3600, ...SPACES[world.name].scenario, powerBound: world.powerBound })).manifest.constraints[0].confidence;
  const rows = [];
  let disagreements = 0;
  for (const B of FROZEN.budgets) {
    for (const arm of FROZEN.arms) {
      for (let seed = 1; seed <= seeds; seed++) {
        const result = ARMS[arm](world, B, seed);
        const picks = { point: pickPoint(world, result.est, result.only), platform: pickPlatform(world, result.est, confidence, result.only) };
        // ours' own pick is the domain's verdict; my rule P on its final estimates must agree with it
        if (arm === 'ours') { if (result.domainPick !== picks.platform) disagreements += 1; picks.platform = result.domainPick; }
        for (const rule of ['point', 'platform']) {
          rows.push({ arm, budget: B, seed, rule, pick: picks[rule], spent: result.spent, stop: result.stop ?? null, ...judge(world, picks[rule], stream(world.name, arm, B, seed, rule, 'reeval')) });
        }
      }
    }
  }
  return { rows, disagreements, confidence };
}

function aggregate(rows) {
  const groups = new Map();
  for (const r of rows) { const key = `${r.rule}|${r.arm}|${r.budget}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
  const out = [];
  for (const [key, list] of groups) {
    const [rule, arm, budget] = key.split('|'); const n = list.length;
    const count = (f) => list.filter(f).length;
    const regrets = list.map((r) => r.regret).sort((a, b) => a - b);
    const picks = list.filter((r) => r.category !== 'none');
    const spent = list.map((r) => r.spent).sort((a, b) => a - b);
    const cell = (k) => ({ k, n, p: k / n, ci: wilson(k, n) });
    out.push({ rule, arm, budget: Number(budget), seeds: n,
      pcs: cell(count((r) => r.category === 'optimal')), successEps: cell(count((r) => r.success)),
      none: cell(count((r) => r.category === 'none')), trueViolation: cell(count((r) => r.category === 'infeasible')),
      reevalViolationOfPicks: { k: picks.filter((r) => r.reevalViolation).length, n: picks.length, p: picks.length ? picks.filter((r) => r.reevalViolation).length / picks.length : null },
      trueViolationOfPicks: { k: picks.filter((r) => r.trueViolation).length, n: picks.length, p: picks.length ? picks.filter((r) => r.trueViolation).length / picks.length : null },
      regret: { median: quantile(regrets, 0.5), q1: quantile(regrets, 0.25), q3: quantile(regrets, 0.75), mean: regrets.reduce((s, v) => s + v, 0) / n },
      spentMedian: quantile(spent, 0.5), spentMax: spent[spent.length - 1] });
  }
  return out;
}

/** Newcombe-style comparison of two independent proportions: better / equal / worse for `a` by the 95% interval of the difference. */
function compare(a, b) {
  const [la, ua] = a.ci; const [lb, ub] = b.ci;
  const d = a.p - b.p;
  const lower = d - Math.sqrt((a.p - la) ** 2 + (ub - b.p) ** 2); const upper = d + Math.sqrt((ua - a.p) ** 2 + (b.p - lb) ** 2);
  return { diff: d, lower, upper, verdict: lower > 0 ? 'better' : upper < 0 ? 'worse' : 'equal' };
}

const pct = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
function tables(worlds, results) {
  const lines = [];
  for (const w of worlds) {
    const agg = results[w.name].aggregate; const budgets = FROZEN.budgets;
    lines.push(`## ${w.name} world`, '', `${w.items.length} designs; ${w.feasibleCount} truly feasible, ${w.optimalCount} of them optimal (${w.bestPatients} patients); ${results[w.name].seeds} seeds per arm and budget; ε = ${FROZEN.epsilonPatients} patients; penalty score ${w.penaltyScore} patients (regret ${w.penaltyScore - w.bestPatients} for no pick or an infeasible pick).`, '');
    for (const rule of ['point', 'platform']) {
      const title = rule === 'point' ? 'Rule S (point estimates meet both constraints; the same pick rule for every arm)' : 'Rule P (the platform\'s verdict: Clopper–Pearson bounds pass both constraints)';
      const metric = (name, f) => {
        lines.push(`**${name}** (${title})`, '', `| Arm | ${budgets.map((b) => `${b / 1000}k`).join(' | ')} |`, `| --- | ${budgets.map(() => '---').join(' | ')} |`);
        for (const arm of FROZEN.arms) lines.push(`| ${arm} | ${budgets.map((b) => f(agg.find((x) => x.rule === rule && x.arm === arm && x.budget === b))).join(' | ')} |`);
        lines.push('');
      };
      metric('Probability of correct selection (a truly feasible design with the fewest patients)', (x) => `${pct(x.pcs.p)} [${pct(x.pcs.ci[0])}, ${pct(x.pcs.ci[1])}]`);
      metric('Success within ε (truly feasible and at most ε patients above the optimum)', (x) => pct(x.successEps.p));
      metric('Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty', (x) => `${x.regret.median} (${x.regret.q1}–${x.regret.q3})`);
      metric('No pick', (x) => pct(x.none.p));
      metric('Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)', (x) => `${pct(x.trueViolationOfPicks.p)} / ${pct(x.reevalViolationOfPicks.p)}`);
      lines.push(`**Budget to success within ε** (smallest budget at which at least ${pct(FROZEN.successLevel)} of seeds succeed, ${title.split(' (')[0]}): ` +
        FROZEN.arms.map((arm) => { const hit = budgets.find((b) => agg.find((x) => x.rule === rule && x.arm === arm && x.budget === b).successEps.p >= FROZEN.successLevel); return `${arm} ${hit ? `${hit / 1000}k` : 'not reached'}`; }).join(', '), '');
    }
    lines.push('**Trials actually spent (median) at each budget**', '', `| Arm | ${budgets.map((b) => `${b / 1000}k`).join(' | ')} |`, `| --- | ${budgets.map(() => '---').join(' | ')} |`);
    for (const arm of FROZEN.arms) lines.push(`| ${arm} | ${budgets.map((b) => Math.round(agg.find((x) => x.rule === 'point' && x.arm === arm && x.budget === b).spentMedian / 1000) + 'k').join(' | ')} |`);
    lines.push('', '**Ours against each baseline: probability of correct selection, 95% interval of the difference (better / equal / worse)**', '');
    for (const rule of ['point', 'platform']) {
      lines.push(`Rule ${rule === 'point' ? 'S' : 'P'}:`, '', `| Baseline | ${budgets.map((b) => `${b / 1000}k`).join(' | ')} |`, `| --- | ${budgets.map(() => '---').join(' | ')} |`);
      for (const arm of FROZEN.arms.filter((a) => a !== 'ours')) {
        lines.push(`| ${arm} | ${budgets.map((b) => { const c = compare(agg.find((x) => x.rule === rule && x.arm === 'ours' && x.budget === b).pcs, agg.find((x) => x.rule === rule && x.arm === arm && x.budget === b).pcs);
          return `${c.verdict} (${(100 * c.diff).toFixed(0)} pts [${(100 * c.lower).toFixed(0)}, ${(100 * c.upper).toFixed(0)}])`; }).join(' | ')} |`);
      }
      lines.push('');
    }
    lines.push(`Check: ours' own verdict and the rule-P pick recomputed from its final estimates disagreed in ${results[w.name].disagreements} of ${results[w.name].seeds * budgets.length} runs.`, '');
    const stops = {};
    for (const r of results[w.name].rows.filter((x) => x.arm === 'ours' && x.rule === 'platform')) stops[`${r.budget / 1000}k ${r.stop}`] = (stops[`${r.budget / 1000}k ${r.stop}`] ?? 0) + 1;
    lines.push(`Ours' stop reasons: ${Object.entries(stops).map(([k, v]) => `${k} x${v}`).join('; ')}.`, '');
  }
  return lines.join('\n');
}

/** One SVG per world: probability of correct selection, success within epsilon and violation rate against the budget (log scale), rule S. */
function svg(world, agg) {
  const colors = { grid: '#8a8d93', random: '#c98a2b', halving: '#2a9d8f', ocba: '#9b5de5', ours: '#1f5fbf' };
  const W = 300; const H = 190; const pad = { l: 44, r: 12, t: 28, b: 38 };
  const panels = [['Correct selection', (x) => x.pcs.p, 'point'], ['Success within epsilon', (x) => x.successEps.p, 'point'], ['Violation of picks (truth)', (x) => x.trueViolationOfPicks.p ?? 0, 'point']];
  const lx = (b) => pad.l + (Math.log(b) - Math.log(FROZEN.budgets[0])) / (Math.log(FROZEN.budgets.at(-1)) - Math.log(FROZEN.budgets[0])) * (W - pad.l - pad.r);
  const ly = (v) => H - pad.b - v * (H - pad.t - pad.b);
  let body = '';
  panels.forEach(([title, f, rule], i) => {
    const ox = i * W;
    body += `<g transform="translate(${ox},0)"><text x="${pad.l}" y="16" font-size="12" font-family="sans-serif" fill="#222">${title}</text>`;
    for (const v of [0, 0.25, 0.5, 0.75, 1]) body += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${ly(v)}" y2="${ly(v)}" stroke="#e3e3e3"/><text x="${pad.l - 4}" y="${ly(v) + 3}" font-size="9" text-anchor="end" font-family="sans-serif" fill="#555">${v}</text>`;
    for (const b of FROZEN.budgets) body += `<text x="${lx(b)}" y="${H - pad.b + 13}" font-size="9" text-anchor="middle" font-family="sans-serif" fill="#555">${b / 1000}k</text>`;
    body += `<text x="${(pad.l + W - pad.r) / 2}" y="${H - 6}" font-size="9" text-anchor="middle" font-family="sans-serif" fill="#555">budget (simulated trials)</text>`;
    for (const arm of FROZEN.arms) {
      const pts = FROZEN.budgets.map((b) => [lx(b), ly(f(agg.find((x) => x.rule === rule && x.arm === arm && x.budget === b)))]);
      body += `<polyline fill="none" stroke="${colors[arm]}" stroke-width="${arm === 'ours' ? 2.6 : 1.6}" points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`;
      for (const p of pts) body += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.4" fill="${colors[arm]}"/>`;
    }
    body += '</g>';
  });
  const legend = FROZEN.arms.map((arm, i) => `<g transform="translate(${60 + i * 110},${H + 10})"><rect width="14" height="3" y="4" fill="${colors[arm]}"/><text x="20" y="9" font-size="11" font-family="sans-serif" fill="#222">${arm}</text></g>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 3}" height="${H + 30}" viewBox="0 0 ${W * 3} ${H + 30}"><rect width="100%" height="100%" fill="#fff"/><text x="4" y="12" font-size="11" font-family="sans-serif" fill="#222">${world.name} world, rule S, ${FROZEN.seeds} seeds</text>${body}${legend}</svg>\n`;
}

// --- calibration against the real engine --------------------------------------------------------------------------------------------
async function calibrate() {
  const world = await loadWorld('survival');
  const index = world.items.findIndex((c) => c.set['design.nTreat'] === 200 && c.set['accrual.duration'] === 24);
  const truth = world.items[index];
  const { manifest } = vcrCampaignManifest(baseManifest({ label: 'survival', candidates: SPACES.survival.candidates(), screeningReplicates: FROZEN.calibration.screeningReplicates, finalCount: 3, cpuSeconds: 3600, ...SPACES.survival.scenario }));
  const identity = sha256(vcrCampaignCanonical(manifest));
  const candidate = vcrCampaignCandidates(manifest)[index];
  const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'vcr-search-calib-'));
  const cases = [['screening', 'alternative', FROZEN.calibration.screeningSeeds, 'power'], ['final', 'alternative', FROZEN.calibration.finalAltSeeds, 'power'], ['final', 'null', FROZEN.calibration.finalNullSeeds, 'type_one_error']];
  const out = { candidate: truth.set, truth: { power: truth.power, typeOne: truth.typeOne }, cases: [], startedAt: new Date().toISOString() };
  try {
    for (const [stage, name, count, measure] of cases) {
      const unit = vcrCampaignUnit(manifest, identity, candidate, stage, name);
      const values = []; let replicates = null;
      for (let s = 1; s <= count; s++) {
        const dir = path.join(scratch, `${stage}-${name}-${s}`); await fs.mkdir(dir, { recursive: true });
        const job = { jobId: `job_calib_${stage}_${name}_${s}`, studyId: 'std_bench', kind: unit.kind, method: unit.method, methodVersion: unit.version, protocolVersion: 1, scenario: unit.scenario,
          inputs: [{ kind: 'assumption', id: 'asm_bench@1' }], seed: 1000 + s, cpuSecondsLimit: 3600, cores: Number(process.env.VCR_TEST_CORES ?? 2) };
        await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
        try { await run('Rscript', [path.join(engineRoot, 'service/run_job.R'), path.join(dir, 'job.json'), path.join(dir, 'out')], { env: { ...process.env, VCR_ENGINE_ROOT: engineRoot, VCR_ENGINE_CORES: String(job.cores) }, timeout: 3_600_000, maxBuffer: 16 * 1024 * 1024 }); } catch (error) { if (!(await fs.stat(path.join(dir, 'out', 'result.json')).catch(() => null))) throw error; }
        const result = JSON.parse(await fs.readFile(path.join(dir, 'out', 'result.json'), 'utf8'));
        replicates = result.replicates; values.push(Number(result.measures.find((m) => m.name === measure).value));
        await fs.rm(dir, { recursive: true, force: true });
        process.stderr.write(`calibrate ${stage}/${name} seed ${s}: ${measure} ${values.at(-1)} (${replicates} replicates)\n`);
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
      const p = measure === 'power' ? truth.power : truth.typeOne;
      const expectedSd = Math.sqrt(p * (1 - p) / replicates);
      out.cases.push({ stage, truth: name, measure, replicates, seeds: values.length, values, mean, sd, binomialSd: expectedSd, sdRatio: sd / expectedSd,
        meanMinusTruth: mean - p, meanSe: sd / Math.sqrt(values.length) });
    }
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  out.finishedAt = new Date().toISOString();
  return out;
}

// --- the agent arm's slot ------------------------------------------------------------------------------------------------------------
async function scoreAgent() {
  const world = await loadWorld(option('--world'));
  const view = JSON.parse(await fs.readFile(option('--score-agent'), 'utf8'));
  const best = view.candidates?.find((c) => c.key === view.best);
  const index = best ? world.items.findIndex((c) => JSON.stringify(c.set) === JSON.stringify(best.set)) : -1;
  const verdict = judge(world, index >= 0 ? index : null, stream(world.name, 'agent', path.basename(option('--score-agent')), 'reeval'));
  const trials = Number(option('--trials', view.budget?.used?.replicatesCompleted ?? view.usage?.replicatesCompleted ?? NaN));
  process.stdout.write(`${JSON.stringify({ arm: 'agent', world: world.name, trials: Number.isFinite(trials) ? trials : null, pickedIndex: index >= 0 ? index : null, ...verdict, optimalPatients: world.bestPatients, note: 'rule P (the campaign verdict) pick; compare with the arms at the nearest budget in the RUN file' }, null, 2)}\n`);
}

// --- main ------------------------------------------------------------------------------------------------------------------------------
if (flag('--score-agent')) { await scoreAgent(); process.exit(0); }
if (flag('--calibrate')) {
  const result = await calibrate();
  if (option('--out')) await fs.writeFile(option('--out'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result.cases.map((c) => ({ stage: c.stage, truth: c.truth, seeds: c.seeds, mean: c.mean, sd: c.sd, binomialSd: c.binomialSd, sdRatio: c.sdRatio, meanMinusTruth: c.meanMinusTruth })), null, 2)}\n`);
  process.exit(0);
}
const seeds = Number(option('--seeds', FROZEN.seeds));
const worlds = [await loadWorld('survival'), await loadWorld('level'), await loadWorld('level85')];
const results = {};
for (const world of worlds) {
  const { rows, disagreements, confidence } = runWorld(world, seeds);
  results[world.name] = { seeds, disagreements, confidence, rows, aggregate: aggregate(rows) };
  process.stderr.write(`${world.name}: ${rows.length} rows, ${disagreements} rule-P disagreements\n`);
}
let revision = null;
try { revision = (await run('git', ['rev-parse', 'HEAD'], { cwd: here })).stdout.trim(); } catch { /* not a checkout */ }
const doc = { revision, frozen: FROZEN, referenceSha256: sha256(await fs.readFile(reference, 'utf8')), worlds: worlds.map((w) => ({ name: w.name, items: w.items, feasibleCount: w.feasibleCount, optimalCount: w.optimalCount, bestPatients: w.bestPatients, penaltyScore: w.penaltyScore })),
  ours: Object.fromEntries(worlds.map((w) => [w.name, FROZEN.budgets.map((B) => ({ budget: B, ...oursParameters(w, B) }))])),
  aggregate: Object.fromEntries(worlds.map((w) => [w.name, results[w.name].aggregate])), disagreements: Object.fromEntries(worlds.map((w) => [w.name, results[w.name].disagreements])) };
if (option('--out')) await fs.writeFile(option('--out'), `${JSON.stringify(doc, null, 1)}\n`);
const text = tables(worlds, results);
if (option('--tables')) await fs.writeFile(option('--tables'), `${text}\n`);
if (option('--svg-dir')) for (const w of worlds) await fs.writeFile(path.join(option('--svg-dir'), `search-benchmark-matched-${w.name}.svg`), svg(w, results[w.name].aggregate));
process.stdout.write(`${text}\n`);
