/**
 * Driver: `node run.mjs graphs|c3|l8 <dev|sealed> [--out DIR]`. Every step writes its own file and is skipped when that file
 * exists; the model-written wording comes from Kimi through `../kimi.mjs`. Prints counts only (sealed content never printed).
 * Set SYNTH_MIN_FREE_MB=1200; at most two Kimi calls run at once.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callKimi } from '../kimi.mjs';
import { graphStats, loadGraphs } from './graph.mjs';
import { loadToucanGraph } from './toucan.mjs';
import { LEVEL_PLAN, buildC3Chains, buildL8Chains, c3Stats, taskKey } from './build.mjs';
import { cardProblems, requestProblems, sessionsProblems } from './checks.mjs';
import { c3Prompt, l8Prompt } from './prompts.mjs';

const [, , cmd, split = 'dev', ...rest] = process.argv;
const OUT = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : (process.env.CAPSULE_PROVING_DATA ?? '.');
const CONCURRENCY = 2;
const ATTEMPTS = 3;
const status = (line) => appendFileSync(join(OUT, 'STATUS'), `${new Date().toISOString()} ${line}\n`);
const writeOnce = (file, data) => { if (!existsSync(file)) { writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return true; } return false; };
const TOUCAN_DIR = join(OUT, 'public', 'toucan-servers', 'mcp_servers');
const graphs = loadGraphs();
const calls = { total: 0, ok: 0, failed: 0 };

async function ask(logFile, id, promptFor, check) {
  let feedback = '';
  for (let a = 1; a <= ATTEMPTS; a++) {
    const r = await callKimi(promptFor(feedback), { timeoutMs: 8 * 60_000 });
    calls.total++;
    const problems = r.ok ? check(r.value) : [r.error];
    appendFileSync(logFile, `${JSON.stringify({ id, attempt: a, ok: r.ok && !problems.length, ms: r.ms, problems: problems.slice(0, 3) })}\n`);
    if (r.ok && !problems.length) { calls.ok++; return r.value; }
    calls.failed++;
    feedback = problems.slice(0, 4).join('; ');
  }
  return null;
}

async function pool(items, work) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (next < items.length) { const it = items[next++]; await work(it); } }));
}

function assemble(dir, ids, file) {
  const items = ids.map((id) => join(dir, 'items', `${id}.json`)).filter(existsSync).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  writeFileSync(join(dir, file), items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return items.length;
}

if (cmd === 'graphs') {
  const dir = join(OUT, 'toolverse-graphs'); mkdirSync(dir, { recursive: true });
  for (const [name, g] of Object.entries(graphs)) {
    if (writeOnce(join(dir, `${name}.json`), { stats: graphStats(g), tools: g.tools, edges: g.edges })) status(`public DONE toolverse graph-${name} ${g.tools.length} nodes ${g.edges.length} edges`);
    console.log(name, g.tools.length, g.edges.length);
  }
} else if (cmd === 'toucan-graph') {
  const dir = join(OUT, 'toolverse-graphs'); mkdirSync(dir, { recursive: true });
  const g = loadToucanGraph(TOUCAN_DIR);
  if (writeOnce(join(dir, 'toucan.json'), { stats: graphStats(g), tools: g.tools, edges: g.edges })) status(`public DONE toolverse graph-toucan ${g.tools.length} nodes ${g.edges.length} edges`);
  console.log('toucan', g.tools.length, g.edges.length);
} else if (cmd === 'c3-toucan') {
  const g = loadToucanGraph(TOUCAN_DIR);
  const gs = { toucan: g };
  const dir = join(OUT, 'c3-toucan'); mkdirSync(join(dir, 'items'), { recursive: true });
  const chains = buildC3Chains(gs, { seed: 'c3-toucan', deepen: true, plan: LEVEL_PLAN });
  writeOnce(join(dir, 'chains.json'), chains);
  writeOnce(join(dir, 'stats.json'), c3Stats(gs, chains));
  if (rest.includes('--chains-only')) { console.log('c3-toucan chains', chains.length); process.exit(0); }
  const log = join(dir, 'kimi.jsonl');
  await pool(chains.filter((t) => !existsSync(join(dir, 'items', `${t.id}.json`))), async (t) => {
    const v = await ask(log, t.id, (fb) => c3Prompt(g, t, fb, 'en'), (v) => requestProblems(t, v.request, { lang: 'en' }));
    if (v) writeFileSync(join(dir, 'items', `${t.id}.json`), JSON.stringify({ ...t, request: v.request, gold: { steps: t.steps.map((s) => ({ tool: s.tool, args: s.args })) } }));
  });
  const n = assemble(dir, chains.map((t) => t.id), 'tasks.jsonl');
  status(`all DONE c3-toucan ${n}/${chains.length} tasks`);
  console.log('c3-toucan tasks', n, '/', chains.length, 'kimi', JSON.stringify(calls));
} else if (cmd === 'c3') {
  const dir = join(OUT, 'c3'); mkdirSync(join(dir, 'items'), { recursive: true });
  const chains = buildC3Chains(graphs);
  writeOnce(join(dir, 'chains.json'), chains);
  writeOnce(join(dir, 'stats.json'), c3Stats(graphs, chains));
  const log = join(dir, 'kimi.jsonl');
  await pool(chains.filter((t) => !existsSync(join(dir, 'items', `${t.id}.json`))), async (t) => {
    const v = await ask(log, t.id, (fb) => c3Prompt(graphs[t.graph], t, fb), (v) => requestProblems(t, v.request));
    if (v) writeFileSync(join(dir, 'items', `${t.id}.json`), JSON.stringify({ ...t, request: v.request, gold: { steps: t.steps.map((s) => ({ tool: s.tool, args: s.args })) } }));
  });
  const n = assemble(dir, chains.map((t) => t.id), 'tasks.jsonl');
  status(`all DONE c3 ${n}/${chains.length} tasks`);
  console.log('c3 tasks', n, '/', chains.length, 'kimi', JSON.stringify(calls));
} else if (cmd === 'l8') {
  const count = split === 'dev' ? 40 : 160;
  const dir = join(OUT, `l8-${split}`); mkdirSync(join(dir, 'items'), { recursive: true });
  const exclude = new Set();
  if (split !== 'dev') {
    const devItems = join(OUT, 'l8-dev', 'items');
    if (existsSync(devItems)) for (const f of readdirSync(devItems)) exclude.add(JSON.parse(readFileSync(join(devItems, f), 'utf8')).key);
  }
  const chains = buildL8Chains(graphs, { split, count, exclude });
  writeOnce(join(dir, 'chains.json'), chains);
  const log = join(dir, 'kimi.jsonl');
  await pool(chains.filter((t) => !existsSync(join(dir, 'items', `${t.id}.json`))), async (t) => {
    const check = (v) => {
      const p = requestProblems(t, v.request, { removed: t.removed });
      if (t.source === 'sessions') p.push(...sessionsProblems(t, v.sessions, t.removed));
      else { p.push(...cardProblems(t, v.card, t.removed)); p.push(...sessionsProblems(t, v.distractorSessions, t.removed, { carryValues: false })); }
      return p;
    };
    const v = await ask(log, t.id, (fb) => l8Prompt(graphs[t.graph], t, t.removed, t.source, fb), check);
    if (!v) return;
    const sessions = t.source === 'sessions' ? v.sessions : v.distractorSessions;
    const card = t.source === 'card' ? v.card : null;
    const { arms, ...base } = t;
    const input = { request: v.request };
    writeFileSync(join(dir, 'items', `${t.id}.json`), JSON.stringify({
      ...base, request: v.request, sessions, card,
      arms: {
        'no-memory': { ...arms['no-memory'], input },
        memory: { ...arms.memory, input: { ...input, sessions } },
        'memory+method': { ...arms['memory+method'], input: { ...input, sessions, card } },
      },
    }));
  });
  const n = assemble(dir, chains.map((t) => t.id), 'tasks.jsonl');
  status(`${split} DONE l8 ${n}/${chains.length} tasks`);
  console.log(`l8-${split} tasks`, n, '/', chains.length, 'kimi', JSON.stringify(calls));
} else { console.error('usage: run.mjs graphs|c3|l8 <dev|sealed>'); process.exit(2); }
