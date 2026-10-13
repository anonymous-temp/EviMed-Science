// One evaluation cell through the real control plane (verification scaffolding; a throwaway account and project per cell).
//
//   a cell = a registered local account, one project, the fixture files uploaded through POST /api/files/upload (the route the
//   web app's upload uses), one or more conversations, and every turn dispatched through POST /api/agent-runs/dispatch with the
//   line left to the platform's own routing (nothing is pinned: the route is part of what is measured).
//
// What is kept per turn: the run record (route, status, verification, tool and token counts, registered files), the reply and
// the tool calls read out of the transcript the control plane collected, a manifest of the workspace and a copy of every file the
// turn left new or changed. What is kept per cell: what the product shows of the run (the outputs list, the inbox, the memory
// overview), the sizes of the first model request, and the wall time.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';

const RUNNING = new Set(['queued', 'running', 'planned', 'dispatching', 'starting', 'waiting']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const SKIP_TOP = /^(\.openscience|\.evimed-|\.evimed$|runtime$|\.dsh|\.git$|node_modules$|__pycache__$|\.cache$)/;
const MAX_COPY_BYTES = 30 * 1024 * 1024;

/** A small HTTP client for one account: cookies, the CSRF token and the project header. */
export class Api {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; this.project = null; }
  async call(method, url, body, { project = this.project, timeoutMs = 120_000 } = {}) {
    const headers = {
      'Content-Type': 'application/json', Origin: this.base,
      ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.csrf ? { 'X-Open-Science-Csrf': this.csrf } : {}),
      ...(project ? { 'X-Open-Science-Project': project } : {}),
    };
    const response = await fetch(`${this.base}${url}`, { method, headers, signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const set = response.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = [...new Map([...this.cookie.split('; ').filter(Boolean), ...set.map((item) => item.split(';')[0])].map((pair) => [pair.split('=')[0], pair])).values()].join('; ');
    const raw = await response.text();
    let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: response.status, json, raw };
  }
}

/** Every file under a fixture path, as [relative path inside the fixture, absolute path]. */
async function fixtureFiles(fixtureRoot, name) {
  const full = path.join(fixtureRoot, name);
  const stat = await fs.stat(full);
  if (!stat.isDirectory()) return [['', full]];
  const out = [];
  const walk = async (dir, rel) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(next, rel ? `${rel}/${entry.name}` : entry.name);
      else out.push([rel ? `${rel}/${entry.name}` : entry.name, next]);
    }
  };
  await walk(full, '');
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** @param {string} dir @returns {Promise<{path:string,bytes:number,sha256:string,mtimeMs:number}[]>} */
export async function workspaceManifest(dir) {
  const out = [];
  const walk = async (current, rel) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (!rel && SKIP_TOP.test(entry.name)) continue;
      if (entry.name === '__pycache__' || entry.name === '.git' || entry.name === 'node_modules') continue;
      const next = path.join(current, entry.name);
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (out.length < 2000) await walk(next, relative); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(next).catch(() => null);
      if (!stat) continue;
      const hash = stat.size <= 200 * 1024 * 1024 ? sha256(await fs.readFile(next)) : 'too-large';
      out.push({ path: relative, bytes: stat.size, sha256: hash, mtimeMs: Math.round(stat.mtimeMs) });
    }
  };
  await walk(dir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The transcript lines of a run, parsed; the meta line first. */
async function readTranscript(projectDir, runId) {
  const file = `${projectDir}/.openscience/transcripts/${runId}.jsonl`;
  for (let i = 0; i < 25; i += 1) {
    try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { await sleep(1500); }
  }
  return null;
}

const TOOL_PREFIX = /^(mcp__evimed__|mcp__evimed-research__|evimed-research_|evimed_research__)/;
export const normalizeTool = (name) => String(name ?? '').replace(TOOL_PREFIX, '');

/** The reply (last assistant text of the last turn) and the tool calls of one run's transcript. */
export function digestTranscript(lines) {
  const messages = (lines ?? []).slice(1).filter((m) => m && m.role);
  const last = messages.reduce((n, m) => Math.max(n, Number(m.turn ?? 0)), 0);
  const mine = messages.filter((m) => Number(m.turn ?? 0) === last);
  let reply = '';
  for (const message of mine) {
    if (message.role !== 'assistant') continue;
    const text = (message.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
    if (text) reply = text;
  }
  const tools = [];
  for (const message of mine) {
    for (const part of message.parts ?? []) {
      if (part.type !== 'tool') continue;
      const output = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
      tools.push({ name: normalizeTool(part.tool), rawName: part.tool, status: part.status ?? null,
        input: JSON.stringify(part.input ?? {}).slice(0, 400), outputHead: output.slice(0, 400),
        outputChars: output.length, error: part.status === 'error' || /^\s*(error|\{"error")/i.test(output) });
    }
  }
  return { reply, tools, messages: mine.length };
}

/** Copy the files a turn left new or changed (against the manifest before it) beside the record. */
async function snapshotTurn(workspace, before, after, destination) {
  const known = new Map(before.map((f) => [f.path, f.sha256]));
  const changed = after.filter((f) => known.get(f.path) !== f.sha256);
  for (const file of changed) {
    if (file.bytes > MAX_COPY_BYTES) continue;
    const to = path.join(destination, file.path);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(path.join(workspace, file.path), to).catch(() => {});
  }
  return changed.map((f) => f.path);
}

/** The sizes of the first model request of the cell's window (the persona and tools the model was given). */
async function firstRequestOf(dataDir, since, until, evidenceDir) {
  try {
    const rows = (await fs.readFile(`${dataDir}/model-requests.jsonl`, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const window = rows.filter((r) => r.at >= since && r.at <= until);
    const first = window.find((r) => r.first && r.tools > 0);
    const summary = { requests: window.length, models: [...new Set(window.map((r) => r.model))] };
    if (!first) return summary;
    const file = `${dataDir}/first-requests/${String(first.seq).padStart(4, '0')}.json`;
    const body = JSON.parse(await fs.readFile(file, 'utf8'));
    const text = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((b) => b?.text ?? '').join('\n') : JSON.stringify(v ?? ''));
    const system = [text(body.system), ...(body.messages ?? []).filter((m) => m.role === 'system').map((m) => text(m.content))].filter(Boolean).join('\n');
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, 'first-request.json.gz'), zlib.gzipSync(JSON.stringify(body)));
    return { ...summary, model: first.model, systemChars: system.length, tools: first.tools, toolsChars: first.toolsChars, toolNames: first.toolNames,
      systemMentionsMedicalPersona: /医学研究助手|EviMed 科研助手|EviMed 的医学|evidence-based medicine/i.test(system),
      systemMentionsCatalogue: /目录里没有的能力|capability catalogue|evimed-specialist/i.test(system), systemHead: system.slice(0, 240) };
  } catch (error) { return { error: String(error?.message ?? error) }; }
}

const RUN_FIELDS = ['id', 'status', 'effectiveAgentId', 'effectiveRouteReason', 'effectiveAgentVersion', 'agentId', 'verification', 'qualityNotices', 'errorCode',
  'durationMs', 'observedMessages', 'observedToolCalls', 'artifacts', 'unverifiedArtifacts', 'outputFiles', 'presentedFiles', 'artifactKinds', 'artifactCounts',
  'usage', 'model', 'phase', 'estimatedMinutes', 'title'];

/**
 * @param {object} args
 * @param {Api} args.api a client that has not registered yet
 * @param {{id:string, family:string, inputs:any[], turns:any[], manual_trigger?:string, timeout_min?:number}} args.spec the case (cells that continue a case carry the turns of both)
 * @param {string} args.fixtureRoot @param {string} args.dataDir @param {string} args.outDir directory of this record @param {number} args.timeoutMs per turn
 * @param {(msg:string)=>void} args.log
 */
export async function runCell({ api, spec, fixtureRoot, dataDir, outDir, timeoutMs, log }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const suffix = randomBytes(3).toString('hex');
  const slug = spec.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const username = `evg${suffix}${Date.now().toString(36).slice(-4)}`;
  const projectId = `ev-${slug}-${suffix}`;
  const record = { schema: 1, cell: spec.id, startedAt, username, projectId, turns: [], inputs: [], notes: [] };

  const registered = await api.call('POST', '/api/auth/register', { username, password: 'eval-pass-1', name: username }, { project: null });
  if (registered.status !== 201) throw new Error(`register ${registered.status} ${registered.raw.slice(0, 300)}`);
  api.csrf = registered.json?.data?.csrfToken ?? registered.json?.data?.session?.csrfToken ?? '';
  if (!api.csrf) {
    const me = await api.call('GET', '/api/me', undefined, { project: null });
    api.csrf = me.json?.data?.csrfToken ?? '';
  }
  const me = await api.call('GET', '/api/me', undefined, { project: null });
  const userId = me.json?.data?.user?.id;
  if (!userId) throw new Error(`no user id from /api/me: ${me.raw.slice(0, 200)}`);
  api.project = projectId;
  const created = await api.call('POST', '/api/projects', { id: projectId, name: projectId });
  if (created.status !== 200) throw new Error(`project ${created.status} ${created.raw.slice(0, 300)}`);
  const projectDir = `${dataDir}/users/${userId}/projects/${projectId}`;
  const workspace = `${projectDir}/workspace`;
  await fs.mkdir(workspace, { recursive: true });
  record.userId = userId; record.projectDir = projectDir;

  // The inputs go in through the upload route the web app uses.
  const attached = [];
  for (const input of spec.inputs ?? []) {
    for (const [rel, abs] of await fixtureFiles(fixtureRoot, input.fixture)) {
      const to = rel ? `${input.to}/${rel}` : input.to;
      const buffer = await fs.readFile(abs);
      const response = await api.call('POST', '/api/files/upload', { root: input.root ?? 'workspace', path: to, data: buffer.toString('base64'), encoding: 'base64' }, { timeoutMs: 180_000 });
      record.inputs.push({ fixture: input.fixture, file: rel, to, root: input.root ?? 'workspace', bytes: buffer.length, sha256: sha256(buffer), status: response.status,
        registered: response.json?.data?.source?.id ?? null, error: response.status === 200 ? null : response.raw.slice(0, 300) });
    }
    if ((input.root ?? 'workspace') === 'workspace') attached.push(input.to.split('/')[0]);
  }
  const attachLine = attached.length ? `\n\n（附件已上传：${[...new Set(attached)].join('、')}）` : '';
  let before = await workspaceManifest(workspace);
  record.workspaceBefore = before;

  const sessions = new Map();
  const sessionFor = async (index) => {
    if (!sessions.has(index)) {
      const id = `s-${slug}-${index}-${suffix}`;
      await api.call('PUT', `/api/research-sessions/${id}`, { mode: 'open-domain' });
      sessions.set(index, id);
    }
    return sessions.get(index);
  };

  let firstTurnOfSession = new Set();
  for (const [index, turnSpec] of spec.turns.entries()) {
    const sessionIndex = turnSpec.session ?? 0;
    const sessionId = await sessionFor(sessionIndex);
    const text = turnSpec.text + (attachLine && !firstTurnOfSession.has(sessionIndex) ? attachLine : '');
    firstTurnOfSession.add(sessionIndex);
    const turn = { index, session: sessionIndex, sessionId, text, startedAt: new Date().toISOString() };
    const turnStart = Date.now();
    const dispatched = await api.call('POST', '/api/agent-runs/dispatch', { sessionId, dispatchId: `d_${slug}_${index}_${suffix}`, text });
    if (dispatched.status !== 202) { turn.error = `dispatch ${dispatched.status} ${dispatched.raw.slice(0, 500)}`; record.turns.push(turn); break; }
    let run = dispatched.json.data;
    turn.runId = run.id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const read = await api.call('GET', '/api/agent-runs');
      run = (read.json?.data ?? []).find((item) => item.id === run.id) ?? run;
      if (!RUNNING.has(String(run.status))) break;
      await sleep(3000);
    }
    turn.wallMs = Date.now() - turnStart;
    turn.finishedAt = new Date().toISOString();
    if (RUNNING.has(String(run.status))) { turn.timedOut = true; await api.call('POST', `/api/agent-runs/${run.id}/cancel`, {}); await sleep(5000); }
    // The transcript and the usage settle after the terminal status.
    await sleep(2500);
    const settled = await api.call('GET', '/api/agent-runs');
    run = (settled.json?.data ?? []).find((item) => item.id === turn.runId) ?? run;
    turn.run = Object.fromEntries(RUN_FIELDS.filter((k) => k in run).map((k) => [k, run[k]]));
    const lines = await readTranscript(projectDir, turn.runId);
    const digest = digestTranscript(lines);
    turn.reply = digest.reply; turn.tools = digest.tools; turn.transcriptMessages = digest.messages;
    if (lines) {
      await fs.mkdir(`${outDir}/transcripts`, { recursive: true });
      await fs.writeFile(`${outDir}/transcripts/t${index}-${turn.runId}.jsonl.gz`, zlib.gzipSync(lines.map((l) => JSON.stringify(l)).join('\n')));
    }
    const after = await workspaceManifest(workspace);
    turn.changed = await snapshotTurn(workspace, before, after, `${outDir}/ws-t${index}`);
    turn.workspaceAfter = after;
    before = after;
    record.turns.push(turn);
    log(`  turn ${index}: ${run.status} route=${run.effectiveAgentId}/${run.effectiveRouteReason} tools=${run.observedToolCalls} wall=${Math.round(turn.wallMs / 1000)}s files=${turn.changed.length}`);
    if (turn.timedOut || turn.error) break;
    if (turnSpec.wait_memory) record.memoryWait = await waitForMemory(api, 90_000);
  }

  // What the product shows of the cell.
  const get = async (url) => { const r = await api.call('GET', url); return { status: r.status, body: r.json ?? r.raw.slice(0, 300) }; };
  record.outputs = await get(`/api/sources/outputs?projectId=${encodeURIComponent(projectId)}`);
  record.inbox = await get('/api/inbox');
  record.overview = await get(`/api/memory/projects/${encodeURIComponent(projectId)}/overview?timeZone=Asia/Shanghai`);
  if (spec.family === 'knowledge') {
    await sleep(8000);
    record.sources = await get(`/api/sources?projectId=${encodeURIComponent(projectId)}&limit=100`);
    record.memoryRecords = await get('/api/memory/records?pageSize=100');
    record.memoryProfile = await get('/api/memory/profile');
  }
  if (spec.manual_trigger === 'schedule') record.schedule = await driveSchedule(api, projectId, userId, dataDir, outDir, timeoutMs, log);
  record.firstRequest = await firstRequestOf(dataDir, startedAt, new Date().toISOString(), outDir);
  await api.call('POST', '/api/commands/stop_runtime', {});
  record.finishedAt = new Date().toISOString();
  record.wallMs = Date.now() - t0;
  return record;
}

/** Poll for the memory a preference turn should have left (extraction is asynchronous). */
async function waitForMemory(api, ms) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    const r = await api.call('GET', '/api/memory/records?pageSize=50');
    last = r.json?.data;
    const items = Array.isArray(last) ? last : last?.items ?? last?.records ?? [];
    if (items.length > 0) return { waitedMs: ms - (until - Date.now()), records: items.length };
    await sleep(4000);
  }
  return { waitedMs: ms, records: 0 };
}

/** G20: the task the conversation created, one execution of it started by hand, and what it produced. */
async function driveSchedule(api, projectId, userId, dataDir, outDir, timeoutMs, log) {
  const out = { agendas: null, runNow: null, episodes: [], notes: [], executions: [] };
  const list = await api.call('GET', `/api/autopilot/agendas?projectId=${encodeURIComponent(projectId)}`);
  out.agendas = list.json?.data ?? list.raw.slice(0, 300);
  const agendas = Array.isArray(out.agendas) ? out.agendas : out.agendas?.items ?? [];
  if (!agendas.length) { out.notes.push('no task was created by the conversation'); return out; }
  const agenda = agendas[0];
  const started = await api.call('POST', `/api/autopilot/agendas/${encodeURIComponent(agenda.id)}/run-now`, { requestId: `eval-${randomBytes(4).toString('hex')}` });
  out.runNow = { status: started.status, body: started.json?.data ?? started.raw.slice(0, 400) };
  if (started.status >= 300) { out.notes.push(`run-now refused: ${started.status}`); return out; }
  const OPEN = new Set(['queued', 'running', 'planned', 'dispatching', 'starting', 'waiting', 'pending', 'scheduled', 'verifying']);
  const statusOf = (e) => String(e?.payload?.status ?? e?.status ?? '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(8000);
    const eps = await api.call('GET', `/api/autopilot/episodes?projectId=${encodeURIComponent(projectId)}&agendaId=${encodeURIComponent(agenda.id)}`);
    const items = Array.isArray(eps.json?.data) ? eps.json.data : eps.json?.data?.items ?? [];
    out.episodes = items;
    if (items.length && items.every((e) => !OPEN.has(statusOf(e)))) break;
  }
  const still = out.episodes.filter((e) => OPEN.has(statusOf(e)));
  for (const e of still) {
    out.notes.push(`execution ${e.id} still ${statusOf(e)} at the timeout; canceled`);
    await api.call('POST', `/api/autopilot/agendas/${encodeURIComponent(agenda.id)}/episodes/${encodeURIComponent(e.id)}/cancel`, { requestId: `eval-${randomBytes(4).toString('hex')}` });
  }
  log(`  schedule: ${out.episodes.length} execution(s), statuses ${out.episodes.map(statusOf).join(',')}`);
  // The execution runs in the platform's own background project: read its run record and transcript from the data directory.
  for (const e of out.episodes) {
    const runId = e?.payload?.runId;
    const execution = { episodeId: e.id, status: statusOf(e), runId: runId ?? null, taskType: e?.payload?.taskType ?? null };
    if (runId) {
      const root = `${dataDir}/users/${userId}/projects`;
      for (const dir of await fs.readdir(root).catch(() => [])) {
        const transcript = await fs.readFile(`${root}/${dir}/.openscience/transcripts/${runId}.jsonl`, 'utf8').catch(() => null);
        if (!transcript) continue;
        const lines = transcript.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const digest = digestTranscript(lines);
        Object.assign(execution, { project: dir, reply: digest.reply, tools: digest.tools.map((t) => t.name), toolCalls: digest.tools.length });
        const runs = await fs.readFile(`${root}/${dir}/.openscience/runs.jsonl`, 'utf8').catch(() => '');
        const row = runs.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r?.id === runId).pop();
        if (row) Object.assign(execution, { agent: row.effectiveAgentId ?? null, routeReason: row.effectiveRouteReason ?? null, verification: row.verification ?? null });
        await fs.mkdir(`${outDir}/transcripts`, { recursive: true });
        await fs.writeFile(`${outDir}/transcripts/execution-${runId}.jsonl.gz`, zlib.gzipSync(lines.map((l) => JSON.stringify(l)).join('\n')));
        // The files the execution wrote, so the judges can read what it delivered.
        const ws = `${root}/${dir}/workspace`;
        const manifest = await workspaceManifest(ws);
        execution.files = await snapshotTurn(ws, [], manifest, `${outDir}/ws-execution`);
        break;
      }
    }
    out.executions.push(execution);
  }
  const progress = await api.call('GET', `/api/autopilot/agendas/${encodeURIComponent(agenda.id)}/progress`);
  out.progress = progress.json?.data ?? progress.raw.slice(0, 400);
  return out;
}

export const _test = { digestTranscript, fixtureFiles };
export { fsSync };
