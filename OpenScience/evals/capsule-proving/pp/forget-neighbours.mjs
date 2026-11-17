#!/usr/bin/env node
// Product-path regression: a dated aside is forgotten, three neighbours survive.
// Uses an already-running local lab harness, its public API and collected transcripts.
// Never starts infrastructure, reads provider keys or calls the memory engine directly.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Api, digestTranscript } from '../../general-tasks/runner/cell.mjs';

const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (args.includes('--help')) {
  console.log('Usage: node evals/capsule-proving/pp/forget-neighbours.mjs --base http://127.0.0.1:PORT --data-dir /path/to/harness-data --out /path/to/results');
  console.log('Requires local registration, memory/forget enabled and the lab runtime already running. Creates one synthetic account; exits 1 for a failed precondition or probe.');
  process.exit(0);
}
const base = value('--base'), dataDir = value('--data-dir'), outDir = value('--out');
if (!base || !dataDir || !outDir || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
  throw new Error('Provide --base (local lab only), --data-dir and --out; see --help.');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const log = message => console.log(`${new Date().toISOString()} ${message}`);
const api = new Api(base);
const evidence = { startedAt: new Date().toISOString(), base, steps: [], probes: [], pass: false };
await fs.mkdir(outDir, { recursive: true });
const save = () => fs.writeFile(path.join(outDir, 'forget-neighbours.json'), JSON.stringify(evidence, null, 2));
const requireStatus = (response, expected, label) => {
  if (response.status !== expected) throw new Error(`${label}: HTTP ${response.status} ${response.raw.slice(0, 300)}`);
  return response.json?.data;
};
const neighbours = text => /青霉素/.test(text) && /蓝色鞋柜.{0,8}第二层/.test(text) && /(?:周三|星期三|礼拜三)/.test(text) && /游泳/.test(text);
const leakedAside = text => /(?:两|2)\s*(?:次|回).{0,8}夜班|夜班.{0,16}(?:两|2)\s*(?:次|回)/.test(text);
let projectDir;

async function turn(label, text) {
  const sessionId = `s_forget_neighbours_${label}_${randomBytes(4).toString('hex')}`;
  requireStatus(await api.call('PUT', `/api/research-sessions/${sessionId}`, { mode: 'open-domain' }), 200, 'session');
  const started = Date.now(), busy409 = [], dispatchId = `d_${sessionId}`;
  let response;
  // Only a definite, retryable admission refusal is retried. Reuse the same dispatch identity.
  for (;;) {
    response = await api.call('POST', '/api/agent-runs/dispatch', { sessionId, dispatchId, text, automated: true });
    if (response.status !== 409 || response.json?.code !== 'memory_source_cleanup_busy') break;
    busy409.push(new Date().toISOString());
    if (Date.now() - started >= 180_000) break;
    await sleep(2000);
  }
  let run = requireStatus(response, 202, `dispatch ${label}`);
  const runId = run.id;
  for (;;) {
    const runs = requireStatus(await api.call('GET', '/api/agent-runs'), 200, 'runs');
    run = runs.find(item => item.id === runId) ?? run;
    if (!['queued', 'running', 'planned', 'dispatching', 'starting', 'waiting'].includes(run.status)) break;
    if (Date.now() - started > 15 * 60_000) throw new Error(`Run ${label} did not finish within 15 minutes`);
    await sleep(1500);
  }
  if (run.status !== 'succeeded') throw new Error(`Run ${label}: ${run.status}`);
  let lines;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { lines = (await fs.readFile(path.join(projectDir, '.openscience/transcripts', `${runId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); break; }
    catch { await sleep(1000); }
  }
  if (!lines) throw new Error(`Transcript unavailable: ${runId}`);
  await fs.writeFile(path.join(outDir, `${label}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const lastTurn = Math.max(...lines.map(line => Number(line.turn) || 0));
  const tools = lines.filter(line => line.role === 'tool' && Number(line.turn ?? 0) === lastTurn).flatMap(line =>
    (line.parts ?? []).filter(part => part.type === 'tool').map(part => ({ tool: part.tool, status: part.status,
      input: part.input, output: part.output, completedAt: part.completedAt ?? line.time })));
  const opening = lines.filter(line => line.source === 'plugin:openviking-memory').map(line =>
    (line.parts ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n');
  const step = { label, sessionId, runId, status: run.status, startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(), busy409, reply: digestTranscript(lines).reply, tools, opening };
  evidence.steps.push(step); await save();
  log(`${label}: ${run.status}; retryable 409 count=${busy409.length}`);
  return step;
}

try {
  const username = `ff${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  requireStatus(await api.call('POST', '/api/auth/register', { username, password: `eval-${randomBytes(16).toString('hex')}`, name: 'Forget neighbours synthetic fixture' }, { project: null }), 201, 'registration');
  const me = requireStatus(await api.call('GET', '/api/me', undefined, { project: null }), 200, 'account');
  api.csrf = me.csrfToken ?? me.session?.csrfToken ?? '';
  api.project = `forget-neighbours-${Date.now().toString(36)}`;
  requireStatus(await api.call('POST', '/api/projects', { id: api.project, name: 'Forget neighbours regression' }), 200, 'project');
  evidence.account = { userId: me.user.id, projectId: api.project };
  projectDir = path.join(dataDir, 'users', String(me.user.id), 'projects', api.project);
  requireStatus(await api.call('POST', '/api/commands/start_runtime', {}, { timeoutMs: 300_000 }), 200, 'runtime');
  await turn('plant', '请记住：我对青霉素过敏；家里备用钥匙放在蓝色鞋柜第二层；我每周三晚上去游泳。另外随口说一句，上个月我临时顶了两次夜班。');
  // Run B did not store the aside at all. That does not exercise the defect and cannot pass this regression.
  const until = Date.now() + 180_000;
  for (;;) {
    const profile = requireStatus(await api.call('GET', '/api/memory/profile'), 200, 'memory profile');
    const active = (profile.records ?? []).filter(record => record.status === 'active');
    evidence.baseline = active;
    const text = active.map(record => record.value ?? '').join('\n');
    const aside = active.find(record => leakedAside(String(record.value ?? '')));
    if (neighbours(text) && aside && /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(String(aside.value))) break;
    if (Date.now() >= until) throw new Error('PRECONDITION FAIL: all three neighbours and a dated night-shift memory must exist; an unstored aside is not a passing run');
    await sleep(3000);
  }
  await save();
  const forgotten = await turn('forget', '上个月临时顶夜班这件事你忘掉，别的都别动。');
  const calls = forgotten.tools.filter(tool => /(?:^|__)forget$/.test(tool.tool));
  if (!calls.length || calls.some(tool => tool.status !== 'completed')) throw new Error('No completed forget tool call');
  const times = calls.map(tool => typeof tool.completedAt === 'number' ? tool.completedAt : Date.parse(tool.completedAt)).filter(Number.isFinite);
  const forgottenAt = times.length ? Math.max(...times) : Date.parse(forgotten.finishedAt);
  evidence.forgottenAt = new Date(forgottenAt).toISOString();
  evidence.emptyFileDeleted = calls.some(tool => /empty file was deleted/i.test(String(tool.output)));
  if (!evidence.emptyFileDeleted) throw new Error('PRECONDITION FAIL: the forget must empty and delete the aside file to exercise maintenance admission');
  for (const seconds of [10, 60, 180]) {
    await sleep(forgottenAt + seconds * 1000 - Date.now());
    const actualOffsetSeconds = (Date.now() - forgottenAt) / 1000;
    const probe = await turn(`probe-${seconds}`, '请先检索记忆，再读取找到的记录，分别回答：我对什么药过敏？备用钥匙放在哪里？我每周几去游泳？还有，上个月我临时顶过几次夜班？找不到的就说不知道，不要猜。');
    const memoryTools = probe.tools.filter(tool => /openviking.*(?:search|read)/.test(tool.tool));
    const memoryOutput = memoryTools.map(tool => typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output)).join('\n');
    const checks = { neighboursInReply: neighbours(probe.reply), neighboursInMemory: neighbours(`${probe.opening}\n${memoryOutput}`),
      searched: memoryTools.some(tool => /search$/.test(tool.tool)), read: memoryTools.some(tool => /read$/.test(tool.tool)),
      forgottenAbsent: !leakedAside(`${probe.reply}\n${memoryOutput}\n${probe.opening}`) };
    const pass = Object.values(checks).every(Boolean);
    evidence.probes.push({ seconds, actualOffsetSeconds, checks, pass, runId: probe.runId });
    log(`${pass ? 'PASS' : 'FAIL'} +${seconds}s (actual +${actualOffsetSeconds.toFixed(1)}s) ${JSON.stringify(checks)}`);
    await save();
  }
  evidence.pass = evidence.probes.length === 3 && evidence.probes.every(probe => probe.pass);
} catch (error) {
  evidence.error = String(error?.stack ?? error);
} finally {
  evidence.finishedAt = new Date().toISOString(); await save();
  console.log(`${evidence.pass ? 'PASS' : 'FAIL'} forget-neighbours: ${path.join(outDir, 'forget-neighbours.json')}`);
  if (evidence.error) console.error(evidence.error);
  process.exitCode = evidence.pass ? 0 : 1;
}
