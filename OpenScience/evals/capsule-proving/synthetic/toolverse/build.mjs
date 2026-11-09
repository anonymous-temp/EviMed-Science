/**
 * Chain-level builders (no model calls): the C3 sampler comparison and the L8 information-gap tasks as far as code decides
 * them (chains, values, withheld parameters, gold per arm). The model writes the wording afterwards (`run.mjs`).
 * @module capsule-proving/synthetic/toolverse/build
 */
import { createHash } from 'node:crypto';
import { materialize, goldCalls } from './env.mjs';
import { dynamicUnlock, randomWalk } from './samplers.mjs';
import { unlockDepths } from './graph.mjs';
import { makeRng, shuffle } from './rng.mjs';
import { GAP_KINDS } from './kinds.mjs';

/** Level counts for 25 tasks: lengths 2..5 (level = length - 1). */
export const LEVEL_PLAN = [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4];

const sig = (names) => names.join('>');
const materializeRetry = (g, names, seed, tries = 60) => {
  for (let n = 0; n < tries; n++) { const m = materialize(g, names, makeRng(`${seed}#${n}`)); if (m) return m; }
  return null;
};

/** Coverage of tools and edges (bound links) by a set of chain tasks over graph g. */
export function coverage(g, tasks) {
  const tools = new Set(), edges = new Set();
  for (const t of tasks) for (const s of t.steps) {
    tools.add(s.tool);
    for (const [p, b] of Object.entries(s.bind)) edges.add(`${t.steps[b.step].tool}.${b.field}->${s.tool}.${p}`);
  }
  return { tools: tools.size, toolShare: +(tools.size / g.tools.length).toFixed(3), edges: edges.size, edgeShare: +(edges.size / g.edges.length).toFixed(3) };
}

/** C3: for each graph, `n` tasks by dynamicUnlock and `n` by randomWalk with the same multiset of lengths. */
/** Real depth of a chain: the longest path of bound values (a tool fed by a tool that was itself fed ...). */
export function bindDepth(steps) {
  const d = [];
  steps.forEach((s, j) => { d[j] = Object.values(s.bind).reduce((m, b) => Math.max(m, d[b.step] + 1), 0); });
  return Math.max(...d);
}

export function buildC3Chains(graphs, { n = 25, seed = 'c3', deepen = false, plan = LEVEL_PLAN } = {}) {
  const items = [];
  for (const [gname, g] of Object.entries(graphs)) {
    const depth = unlockDepths(g);
    const levels = shuffle(makeRng(`${seed}:${gname}:levels`), plan).slice(0, n);
    const seen = { dynamicUnlock: new Set(), randomWalk: new Set() };
    levels.forEach((level, i) => {
      for (const sampler of ['dynamicUnlock', 'randomWalk']) {
        let task = null;
        for (let a = 0; a < 400 && !task; a++) {
          const rng = makeRng(`${seed}:${gname}:${sampler}:${i}:${a}`);
          const names = sampler === 'dynamicUnlock' ? dynamicUnlock(g, rng, level, { deepen }) : randomWalk(g, rng, level + 1);
          if (!names || seen[sampler].has(sig(names))) continue;
          const m = materializeRetry(g, names, `${seed}:${gname}:${sampler}:${i}:${a}:v`);
          if (!m) continue;
          seen[sampler].add(sig(names));
          task = { id: `c3-${gname}-${sampler === 'dynamicUnlock' ? 'dyn' : 'rnd'}-${String(i + 1).padStart(2, '0')}`, graph: gname, sampler, level, length: names.length, maxDepth: Math.max(...names.map((x) => depth.get(x) ?? 0)), chain: names, ...m, bindDepth: bindDepth(m.steps) };
        }
        if (!task) throw new Error(`no chain for ${gname} ${sampler} level ${level}`);
        items.push(task);
      }
    });
  }
  return items;
}

export function c3Stats(graphs, items) {
  const out = {};
  for (const [gname, g] of Object.entries(graphs)) for (const sampler of ['dynamicUnlock', 'randomWalk']) {
    const set = items.filter((t) => t.graph === gname && t.sampler === sampler);
    const lens = set.map((t) => t.length);
    const mean = (xs) => +(xs.reduce((a, b) => a + b, 0) / (xs.length || 1)).toFixed(3);
    const byLevel = {};
    for (const t of set) (byLevel[t.level] ||= []).push(t.length);
    out[`${gname}/${sampler}`] = { n: set.length, meanLength: mean(lens), lengthHistogram: Object.fromEntries([...new Set(lens)].sort().map((l) => [l, lens.filter((x) => x === l).length])), meanLengthByLevel: Object.fromEntries(Object.entries(byLevel).map(([k, v]) => [k, mean(v)])), meanMaxDepth: mean(set.map((t) => t.maxDepth)), meanBindDepth: mean(set.map((t) => t.bindDepth ?? bindDepth(t.steps))), bindDepthHistogram: Object.fromEntries([...new Set(set.map((t) => t.bindDepth ?? bindDepth(t.steps)))].sort().map((d) => [d, set.filter((t) => (t.bindDepth ?? bindDepth(t.steps)) === d).length])), meanBindDepthByLevel: Object.fromEntries(Object.entries(Object.groupBy(set, (t) => t.level)).map(([k, v]) => [k, mean(v.map((t) => t.bindDepth ?? bindDepth(t.steps)))])), ...coverage(g, set) };
  }
  return out;
}

const sha = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12);
/** Signature of a task's content (tools plus user values) for dev/sealed disjointness. */
export const taskKey = (task) => sha([task.chain, task.steps.map((s) => s.args)]);

/** Gold per arm. Removed parameters are asked about where first needed in arms that cannot know them. */
export function l8Arms(task, removed, source) {
  const full = goldCalls(task);
  const names = [...new Set(removed.map((r) => r.param))];
  const askSteps = [...new Set(removed.map((r) => r.step))].sort((a, b) => a - b);
  const withAsks = [];
  full.forEach((c, i) => {
    if (askSteps.includes(i)) withAsks.push({ ask: { params: removed.filter((r) => r.step === i).map((r) => r.param).sort() } });
    withAsks.push(c);
  });
  const direct = { steps: full, askedAboutKnown: names };
  const ask = { steps: withAsks, askedAboutKnown: [] };
  return { 'no-memory': { expect: 'ask', gold: ask }, memory: { expect: source === 'sessions' ? 'direct' : 'ask', gold: source === 'sessions' ? direct : ask }, 'memory+method': { expect: 'direct', gold: direct } };
}

/** L8 chains: balanced graph x source, one or two withheld parameters, at least one value left in the request. */
export function buildL8Chains(graphs, { split, count, seed = 'l8', exclude = new Set() }) {
  const out = [];
  const used = new Set(exclude);
  const gnames = Object.keys(graphs);
  for (let i = 0; i < count; i++) {
    const gname = gnames[i % gnames.length];
    const source = Math.floor(i / gnames.length) % 2 === 0 ? 'sessions' : 'card';
    const g = graphs[gname];
    const wantRemoved = i % 3 === 2 ? 2 : 1;
    let found = null;
    for (let a = 0; a < 600 && !found; a++) {
      const rng = makeRng(`${seed}:${split}:${i}:${a}`);
      const level = 1 + Math.floor(rng() * 3);
      const names = dynamicUnlock(g, rng, level);
      if (!names) continue;
      const m = materializeRetry(g, names, `${seed}:${split}:${i}:${a}:v`);
      if (!m) continue;
      const task = { chain: names, ...m, bindDepth: bindDepth(m.steps) };
      const cand = task.steps.flatMap((s, step) => s.user.filter((p) => GAP_KINDS.includes(s.kinds[p]) && !Array.isArray(s.args[p])).map((param) => ({ step, param, kind: s.kinds[param], value: s.args[param] })));
      const totalUser = task.steps.reduce((n, s) => n + s.user.length, 0);
      if (cand.length < wantRemoved || totalUser - wantRemoved < 1) continue;
      const removed = shuffle(rng, cand).slice(0, wantRemoved).sort((x, y) => x.step - y.step || x.param.localeCompare(y.param));
      const k = taskKey(task);
      if (used.has(k)) continue;
      used.add(k);
      found = { id: `L8-${split}-${String(i + 1).padStart(3, '0')}`, split, graph: gname, level, length: names.length, source, key: k, removed, ...task };
    }
    if (!found) throw new Error(`no L8 chain for item ${i}`);
    found.arms = l8Arms(found, found.removed, found.source);
    out.push(found);
  }
  return out;
}
