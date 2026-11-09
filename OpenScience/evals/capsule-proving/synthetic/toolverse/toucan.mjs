/**
 * The `toucan` graph: a seeded subset of the Toucan MCP tool catalogue (Agent Ark, MIT), chosen for derived-value depth.
 * Toucan publishes input schemas only, so output fields are inferred by a closed rule: a tool whose name holds a producing
 * verb (create, add, search, list, find, ...) returns the id of the thing it names (`<noun>Id`, kind `id:<server>:<noun>`);
 * every other tool returns an opaque `result`. An input parameter named `*_id` / `*Id` / `id` accepts the id kind of its noun
 * (read from the name, else the word before "id" in its description) and the server's generic `item` id. Ids only link
 * tools of the same server. Tools with a required parameter that is not a string, number, integer, boolean or enum are skipped.
 * @module capsule-proving/synthetic/toolverse/toucan
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildGraph, unlockDepths } from './graph.mjs';
import { DERIVED_KINDS, KINDS } from './kinds.mjs';
import { digits, hex, int, pick } from './rng.mjs';

const PRODUCING = new Set(['create', 'add', 'new', 'search', 'list', 'find', 'query', 'upload', 'insert', 'post', 'send', 'start', 'open', 'register', 'submit', 'generate', 'make', 'build', 'import', 'fork', 'clone']);
const VERBS = new Set([...PRODUCING, 'get', 'fetch', 'read', 'update', 'delete', 'remove', 'edit', 'set', 'run', 'check', 'show', 'view', 'describe', 'details', 'detail', 'info']);
const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const sing = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const slugOf = (file, name) => (name || file).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28);

const PHRASES = ['quarterly sales report', 'machine learning basics', 'tokyo travel guide', 'open source licensing', 'customer onboarding checklist', 'solar panel efficiency', 'react performance tips', 'weekly team update'];
const NAMES = ['Project Alpha', 'Orion', 'Blue Harbor', 'Maple Street', 'Nimbus', 'Atlas'];
const valueGen = (name, schema) => {
  const n = name.toLowerCase();
  if (schema.enum?.length) return (g) => pick(g, schema.enum);
  if (schema.type === 'boolean') return (g) => g() < 0.5;
  if (schema.type === 'integer' || schema.type === 'number') {
    const lo = Number.isFinite(schema.minimum) ? schema.minimum : 1, hi = Number.isFinite(schema.maximum) ? Math.min(schema.maximum, lo + 100) : lo + 49;
    return (g) => int(g, Math.ceil(lo), Math.max(Math.ceil(lo), Math.floor(hi)));
  }
  if (/query|search|keyword|^q$|term|prompt|topic|text|message|content|description|question/.test(n)) return (g) => pick(g, PHRASES);
  if (/name|title|label/.test(n)) return (g) => pick(g, NAMES);
  if (/url|uri|link/.test(n)) return (g) => `https://docs.${pick(g, ['alpha', 'orion', 'nimbus'])}-${int(g, 10, 99)}.example.org/page${int(g, 1, 9)}`;
  if (/path|file|dir|folder/.test(n)) return (g) => `reports/${pick(g, ['q3', 'draft', 'notes'])}-${int(g, 10, 99)}.txt`;
  if (/email/.test(n)) return (g) => `${pick(g, ['lena', 'omar', 'yuki'])}${int(g, 1, 99)}@example.org`;
  if (/date|time/.test(n)) return (g) => `2026-${String(int(g, 1, 12)).padStart(2, '0')}-${String(int(g, 1, 28)).padStart(2, '0')}`;
  return (g) => `${pick(g, ['alpha', 'orion', 'delta', 'nimbus'])}-${int(g, 10, 99)}`;
};

function ensureKind(k, def) { if (!KINDS[k]) KINDS[k] = def; if (def.derived) DERIVED_KINDS.add(k); return k; }
const idKind = (server, noun) => ensureKind(`id:${server}:${noun}`, { type: 'string', derived: true, gen: (g) => `${noun.slice(0, 6)}_${hex(g, 8)}`, label: `a ${noun} id` });

/** Parse one server file into candidate tool nodes (inputs are the required parameters; a non-required id parameter is kept too). */
export function parseServer(file, json) {
  const meta = json?.metadata, tools = meta?.remote_server_response?.tools;
  if (!Array.isArray(tools)) return [];
  const server = slugOf(file.replace(/^(cf_)?\d+\./, '').replace(/_labeled\.json$/, ''), meta.server_name);
  const out = [];
  for (const t of tools) {
    const sch = t.input_schema || {};
    const props = sch.properties || {};
    const required = sch.required || [];
    if (!t.name || required.length > 4) continue;
    const tw = words(t.name);
    const vi = tw.findIndex((w) => PRODUCING.has(w));
    const noun = sing([...tw.slice(vi + 1)].filter((w) => !VERBS.has(w)).pop() || '') || 'item';
    const nodeName = `${server}__${t.name}`.replace(/[^A-Za-z0-9_]/g, '_');
    const inputs = [];
    let ok = true;
    for (const [pn, ps] of Object.entries(props)) {
      const isId = /(^|[_\-a-z])id$/i.test(pn) || /[a-z]Id$/.test(pn);
      if (!required.includes(pn) && !isId) continue;
      if (!['string', 'number', 'integer', 'boolean'].includes(ps.type)) { ok = false; break; }
      if (isId && ps.type === 'string') {
        const prefix = words(pn.replace(/id$/i, '')).pop();
        const fromDesc = /([a-z]+)\s+(?:id|identifier)\b/i.exec(ps.description || '')?.[1]?.toLowerCase();
        const pnoun = sing(prefix || (fromDesc && !['the', 'a', 'unique', 'of'].includes(fromDesc) ? fromDesc : '') || 'item');
        const accepts = [...new Set([idKind(server, pnoun), idKind(server, 'item')])];
        inputs.push({ name: pn, type: 'string', kind: accepts[0], accepts, required: true, desc: ps.description });
        continue;
      }
      if (!required.includes(pn)) continue;
      const kind = ensureKind(`v:${nodeName}.${pn}`, { type: ps.type === 'integer' ? 'integer' : ps.type, gen: valueGen(pn, ps), label: `the ${pn} argument${ps.description ? ` (${String(ps.description).replace(/\s+/g, ' ').slice(0, 90)})` : ''}` });
      inputs.push({ name: pn, type: KINDS[kind].type, kind, accepts: [kind], required: true, desc: ps.description });
    }
    if (!ok) continue;
    const outputs = PRODUCING.has(tw[vi]) ? [{ name: `${noun}Id`, type: 'string', kind: idKind(server, noun) }] : [];
    outputs.push({ name: 'result', type: 'string', kind: ensureKind('en_text', { type: 'string', gen: (g) => `${pick(g, ['ready', 'done', 'accepted'])} ${digits(g, 4)}`, label: 'a result text' }) });
    out.push({ name: nodeName, server, desc: `[${meta.server_name}] ${t.name}: ${String(t.description || '').replace(/\s+/g, ' ').slice(0, 220)}`, inputs, outputs });
  }
  return out;
}

const h = (s) => createHash('sha256').update(s).digest('hex');
/** Seeded subset: servers ranked by the depth their own tools can reach, then ids consumed; per server the most-linked tools first. */
export function selectToucan(dir, { seed = 'toucan', servers = 30, perServer = 5 } = {}) {
  const ranked = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let json; try { json = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const tools = parseServer(f, json);
    if (tools.length < 3) continue;
    const names = new Set();
    const uniq = tools.filter((t) => !names.has(t.name) && names.add(t.name));
    let g; try { g = buildGraph({ name: 's', tools: uniq }); } catch { continue; }
    if (!g.edges.length) continue;
    const depth = unlockDepths(g);
    const linked = new Map(uniq.map((t) => [t.name, 0]));
    for (const e of g.edges) { linked.set(e.from, linked.get(e.from) + 1); linked.set(e.to, linked.get(e.to) + 1); }
    const chosen = [...uniq].sort((a, b) => linked.get(b.name) - linked.get(a.name) || h(`${seed}${a.name}`).localeCompare(h(`${seed}${b.name}`))).slice(0, perServer);
    const sub = buildGraph({ name: 's', tools: chosen });
    const d2 = unlockDepths(sub);
    ranked.push({ server: uniq[0].server, score: Math.max(...d2.values()) * 1000 + sub.edges.length * 10 + chosen.length, depth: Math.max(...depth.values()), tools: chosen });
  }
  ranked.sort((a, b) => b.score - a.score || h(`${seed}${a.server}`).localeCompare(h(`${seed}${b.server}`)));
  const seen = new Set();
  return ranked.slice(0, servers).flatMap((r) => r.tools).filter((t) => !seen.has(t.name) && seen.add(t.name));
}

export const loadToucanGraph = (dir, opts) => buildGraph({ name: 'toucan', tools: selectToucan(dir, opts) });
