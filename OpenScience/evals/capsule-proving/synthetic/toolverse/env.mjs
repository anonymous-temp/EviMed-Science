/**
 * Simulated environment for a sampled chain. Code fabricates every tool's return value from a seeded stream; a value a
 * later call consumes is exactly the value the earlier call returned (the binding copies it). `simulate(task, call)`
 * answers a call that matches a gold step (tool and canonicalised arguments) with that step's canned output, and with a
 * structured error otherwise; the error names what is wrong with the call, never the expected values.
 * @module capsule-proving/synthetic/toolverse/env
 */
import { KINDS } from './kinds.mjs';
import { feedersFrom } from './samplers.mjs';

/** Canonical form of an argument value: trimmed strings, numbers as numbers (also "5.0" and "5"), sorted keys, no nulls. */
export function canon(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const t = v.trim(); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t; }
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) { const c = canon(v[k]); if (c !== undefined) o[k] = c; }
    return o;
  }
  return String(v);
}
export const sameArgs = (a, b) => JSON.stringify(canon(a ?? {})) === JSON.stringify(canon(b ?? {}));

const genValue = (rng, param) => {
  const k = KINDS[param.kind];
  if (param.type.endsWith('[]') && !Array.isArray(k.gen(rng))) {
    const out = [];
    while (out.length < 3) { const x = k.gen(rng); if (!out.includes(x)) out.push(x); }
    return out;
  }
  return k.gen(rng);
};

const flat = (v) => (Array.isArray(v) ? v.map(String) : [String(v)]);

/**
 * Turn a list of tool names into a gold chain with consistent values. Returns null when the values clash (a user value
 * equal to, or contained in, another value), so the caller can try the next seed.
 * @returns {{ steps: { tool: string, args: Record<string, any>, bind: Record<string, {step: number, field: string}>, user: string[], kinds: Record<string, string>, output: Record<string, any> }[] } | null}
 */
export function materialize(g, names, rng) {
  const steps = [];
  for (let j = 0; j < names.length; j++) {
    const t = g.byName.get(names[j]);
    const feeders = feedersFrom(g, names.slice(0, j), t.name);
    const args = {}, bind = {}, user = [], kinds = {};
    for (const p of t.inputs) {
      const opts = feeders.filter((e) => e.param === p.name);
      if (opts.length) {
        const e = opts[opts.length - 1 - Math.floor(rng() * opts.length)];
        const s = names.indexOf(e.from);
        args[p.name] = steps[s].output[e.field];
        bind[p.name] = { step: s, field: e.field };
      } else { args[p.name] = genValue(rng, p); user.push(p.name); kinds[p.name] = p.kind; }
    }
    const output = {};
    for (const o of t.outputs) output[o.name] = genValue(rng, o);
    steps.push({ tool: t.name, args, bind, user, kinds, output });
  }
  // value hygiene: the request must be able to state each user value without it being (part of) an intermediate one
  const users = steps.flatMap((s) => s.user.flatMap((p) => flat(s.args[p])));
  const inter = steps.flatMap((s) => Object.values(s.output).flatMap(flat));
  if (new Set(users).size !== users.length) return null;
  for (const u of users) for (const i of inter) if (u.includes(i) || i.includes(u)) return null;
  return { steps };
}

export const goldCalls = (task) => task.steps.map((s) => ({ tool: s.tool, args: s.args }));
/** The values a person states in the request: every user-supplied argument. */
export const userValues = (task) => task.steps.flatMap((s, i) => s.user.map((p) => ({ step: i, tool: s.tool, param: p, kind: s.kinds[p], value: s.args[p] })));
/** The values a tool must produce for a later call: bound arguments. */
export const intermediateValues = (task) => task.steps.flatMap((s, i) => Object.entries(s.bind).map(([p, b]) => ({ step: i, param: p, from: b.step, field: b.field, value: s.args[p] })));

export function simulate(task, call) {
  const known = task.steps.map((s) => s.tool);
  if (!call || typeof call.tool !== 'string' || !known.includes(call.tool)) {
    return { ok: false, error: { code: 'unknown_tool', message: `no such tool: ${call?.tool}` } };
  }
  const hit = task.steps.find((s) => s.tool === call.tool && sameArgs(s.args, call.args));
  if (hit) return { ok: true, output: hit.output };
  const step = task.steps.find((s) => s.tool === call.tool);
  const want = Object.keys(step.args), got = Object.keys(call.args || {});
  const missing = want.filter((k) => !got.includes(k)), extra = got.filter((k) => !want.includes(k));
  if (missing.length || extra.length) return { ok: false, error: { code: 'invalid_arguments', message: `missing: [${missing}] unexpected: [${extra}]` } };
  const bad = want.filter((k) => !sameArgs({ k: step.args[k] }, { k: call.args[k] }));
  return { ok: false, error: { code: 'not_found', message: `no result for the given value of: [${bad}]` } };
}
