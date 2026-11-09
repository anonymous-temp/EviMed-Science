/**
 * Tool dependency graph (ToolVerse's first step). Nodes are tools with typed inputs and output fields; an edge
 * A.field -> B.param means B can consume what A returns. The rule is deterministic and closed:
 *  1. both sides carry value kinds: the output's kind must be among the parameter's accepted kinds ('kind');
 *  2. neither carries a kind: the types are equal and the normalised names are equal ('name'), or the descriptions share
 *     at least three content words with Jaccard >= 0.6 ('description');
 * then `edgeOverrides.json` removes edges the rule gets wrong and adds the ones it misses. Both ends must be different tools.
 * @module capsule-proving/synthetic/toolverse/graph
 */
import { readFileSync } from 'node:fs';
import { DERIVED_KINDS } from './kinds.mjs';
import { EVIMED_TOOLS } from './evimedTools.mjs';
import { GENERAL_TOOLS } from './generalTools.mjs';

/**
 * @typedef {{ name: string, type: string, kind?: string, accepts?: string[], required?: boolean, desc?: string }} Param
 * @typedef {{ name: string, server: string, desc: string, inputs: Param[], outputs: Param[] }} Tool
 * @typedef {{ id: string, from: string, field: string, to: string, param: string, rule: string }} Edge
 */
export const OVERRIDES = JSON.parse(readFileSync(new URL('./edgeOverrides.json', import.meta.url), 'utf8'));

const norm = (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'by', 'with', 'is', 'as']);
const content = (s) => new Set((s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** @returns {string|null} the rule that links the output field to the input parameter, or null. */
export function edgeRule(out, inp) {
  if (out.type !== inp.type) return null;
  if (out.kind && inp.accepts) return inp.accepts.includes(out.kind) ? 'kind' : null;
  if (out.kind || inp.accepts) return null;
  if (norm(out.name) === norm(inp.name)) return 'name';
  const a = content(out.desc), b = content(inp.desc);
  const shared = [...a].filter((w) => b.has(w)).length;
  const jac = shared / (a.size + b.size - shared || 1);
  return shared >= 3 && jac >= 0.6 ? 'description' : null;
}

/** @param {{ name: string, tools: Tool[], overrides?: { remove?: string[], add?: string[] } }} spec */
export function buildGraph({ name, tools, overrides = {} }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  if (byName.size !== tools.length) throw new Error('duplicate tool names');
  /** @type {Map<string, Edge>} */
  const edges = new Map();
  const mk = (a, f, b, p, rule) => ({ id: `${a}.${f}->${b}.${p}`, from: a, field: f, to: b, param: p, rule });
  for (const a of tools) for (const o of a.outputs) for (const b of tools) {
    if (a === b) continue;
    for (const i of b.inputs) { const rule = edgeRule(o, i); if (rule) { const e = mk(a.name, o.name, b.name, i.name, rule); edges.set(e.id, e); } }
  }
  for (const id of overrides.remove || []) if (!edges.delete(id)) throw new Error(`override removes an edge that is not there: ${id}`);
  for (const id of overrides.add || []) {
    const m = /^(\w+)\.(\w+)->(\w+)\.(\w+)$/.exec(id);
    if (!m) throw new Error(`bad override ${id}`);
    const [, a, f, b, p] = m;
    if (!byName.get(a)?.outputs.some((o) => o.name === f) || !byName.get(b)?.inputs.some((i) => i.name === p)) throw new Error(`override names a missing field: ${id}`);
    edges.set(id, mk(a, f, b, p, 'override'));
  }
  const list = [...edges.values()];
  const degree = Object.fromEntries(tools.map((t) => [t.name, 0]));
  for (const e of list) { degree[e.from]++; degree[e.to]++; }
  return { name, tools, byName, edges: list, degree, edgesInto: (tool) => list.filter((e) => e.to === tool) };
}

export const loadGraphs = () => ({
  evimed: buildGraph({ name: 'evimed', tools: EVIMED_TOOLS, overrides: OVERRIDES.evimed }),
  general: buildGraph({ name: 'general', tools: GENERAL_TOOLS, overrides: OVERRIDES.general }),
});

/**
 * Roots: tools with no input of a derived kind (a handle only a tool can produce), so the user can start them cold. Depth
 * is the unlock round: a tool is unlocked when one of its derived-kind inputs has a feeder that is already unlocked.
 */
export function unlockDepths(g) {
  const needsDerived = (t) => t.inputs.some((i) => (i.accepts || []).some((k) => DERIVED_KINDS.has(k)));
  const depth = new Map(g.tools.filter((t) => !needsDerived(t)).map((t) => [t.name, 0]));
  for (let d = 1; d < 50; d++) {
    const add = g.tools.filter((t) => !depth.has(t.name) && g.edgesInto(t.name).some((e) => depth.has(e.from) && DERIVED_KINDS.has(g.byName.get(e.from).outputs.find((o) => o.name === e.field).kind))).map((t) => t.name);
    if (!add.length) break;
    for (const n of add) depth.set(n, d);
  }
  return depth;
}

export function graphStats(g) {
  const depth = unlockDepths(g);
  const top = Object.entries(g.degree).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([tool, degree]) => ({ tool, degree }));
  const byRule = {};
  for (const e of g.edges) byRule[e.rule] = (byRule[e.rule] || 0) + 1;
  return {
    name: g.name, nodes: g.tools.length, edges: g.edges.length, servers: new Set(g.tools.map((t) => t.server)).size, edgesByRule: byRule,
    roots: [...depth].filter(([, d]) => d === 0).length, maxDepth: Math.max(...depth.values()), unreachable: g.tools.filter((t) => !depth.has(t.name)).map((t) => t.name), top10Degree: top,
  };
}
