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

const LENGTH_METRES = new Map([['cm', 0.01], ['inch', 0.0254], ['m', 1], ['ft', 0.3048], ['km', 1000], ['mile', 1609.344]]);
const MASS_KILOGRAMS = new Map([['kg', 1], ['lb', 0.45359237], ['g', 0.001], ['oz', 0.028349523125]]);
// A fictional fixed market, not a quotation of real exchange rates.
const CURRENCY_PER_USD = new Map([['USD', 1], ['CNY', 7], ['EUR', 0.92], ['JPY', 150], ['GBP', 0.78]]);
/** @typedef {{events: Map<string, Record<string, unknown>>, messages: Map<string, Record<string, unknown>>, files: Map<string, string>}} World */

/** Keep arithmetic and created objects consistent within this seeded task.
 * @param {string} name @param {Record<string, unknown>} args @param {Record<string, unknown>} output @param {World} world */
function consistentOutput(name, args, output, world) {
  if (name === 'convert_length' || name === 'convert_mass') {
    const factors = name === 'convert_length' ? LENGTH_METRES : MASS_KILOGRAMS;
    const from = factors.get(String(args.from)), to = factors.get(String(args.to));
    if (from === undefined || to === undefined) throw new Error('simulation_unit_unknown');
    output.converted = Number(args.value) * from / to;
  } else if (name === 'convert_temperature') output.fahrenheit = Number(args.celsius) * 9 / 5 + 32;
  else if (name === 'convert_currency') output.converted = Number(args.amount) * Number(args.rate);
  else if (name === 'get_exchange_rate') output.rate = Number(CURRENCY_PER_USD.get(String(args.to))) / Number(CURRENCY_PER_USD.get(String(args.from)));
  else if (name === 'add_days') output.result = new Date(Date.parse(`${args.date}T00:00:00Z`) + Number(args.days) * 86400000).toISOString().slice(0, 10);
  else if (name === 'create_event') world.events.set(String(output.eventId), { title: args.title, date: args.date });
  else if (name === 'list_events') {
    const matches = [...world.events].filter(([, event]) => event.date === args.date);
    if (matches.length) output.firstEventId = matches[0][0];
    else world.events.set(String(output.firstEventId), { title: `Event ${output.firstEventId}`, date: args.date });
    output.eventCount = matches.length || 1;
  } else if (name === 'get_event') {
    Object.assign(output, world.events.get(String(args.eventId)));
    world.events.set(String(args.eventId), { ...output });
  } else if (name === 'send_email') world.messages.set(String(output.messageId), { body: args.body, recipient: args.to });
  else if (name === 'get_message') Object.assign(output, world.messages.get(String(args.messageId)));
  else if (name === 'write_file') {
    output.writtenPath = args.path;
    world.files.set(String(args.path), String(args.content));
  } else if (name === 'copy_file') {
    output.newPath = `${String(args.dir).replace(/\/$/u, '')}/${String(args.path).split('/').at(-1)}`;
    const content = world.files.get(String(args.path)) ?? `Fixture file ${args.path}`;
    world.files.set(String(args.path), content);
    world.files.set(String(output.newPath), content);
  } else if (name === 'read_file') {
    const content = world.files.get(String(args.path)) ?? String(output.content);
    output.content = content;
    output.lineCount = content.split('\n').length;
    world.files.set(String(args.path), content);
  } else if (name === 'file_stat' && world.files.has(String(args.path))) output.size = new TextEncoder().encode(world.files.get(String(args.path)) ?? '').length;
}

/**
 * Turn a list of tool names into a gold chain with consistent values. Returns null when user values duplicate each other
 * or reveal a complete, otherwise unknown intermediate value, so the caller can try the next seed.
 * @returns {{ steps: { tool: string, args: Record<string, any>, bind: Record<string, {step: number, field: string}>, user: string[], kinds: Record<string, string>, output: Record<string, any> }[] } | null}
 */
export function materialize(g, names, rng) {
  const steps = [];
  /** @type {World} */
  const world = { events: new Map(), messages: new Map(), files: new Map() };
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
    consistentOutput(t.name, args, output, world);
    steps.push({ tool: t.name, args, bind, user, kinds, output });
  }
  // A request may state a directory without revealing the complete copied-file path that a tool will return.
  const users = steps.flatMap((s) => s.user.flatMap((p) => flat(s.args[p])));
  // A readback may echo an original user input; that is already known, not leaked intermediate information.
  const inter = steps.flatMap((s) => Object.values(s.output).flatMap(flat)).filter(value => !users.includes(value));
  if (new Set(users).size !== users.length) return null;
  for (const u of users) for (const i of inter) if (u.includes(i)) return null;
  return { steps };
}

export const goldCalls = (task) => task.steps.map((s) => ({ tool: s.tool, args: s.args }));
/** The values a person states in the request: every user-supplied argument. */
export const userValues = (task) => task.steps.flatMap((s, i) => s.user.map((p) => ({ step: i, tool: s.tool, param: p, kind: s.kinds[p], value: s.args[p] })));
/** The values a tool must produce for a later call: bound arguments. */
export const intermediateValues = (task) => {
  const known = new Set(userValues(task).flatMap(value => flat(value.value)));
  return task.steps.flatMap((s, i) => Object.entries(s.bind).map(([p, b]) => ({ step: i, param: p, from: b.step, field: b.field, value: s.args[p] })))
    .filter(value => !flat(value.value).every(part => known.has(part)));
};

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
