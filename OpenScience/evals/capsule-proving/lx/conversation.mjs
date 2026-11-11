// One conversation on the product path for the LX learning-loop experiments: an existing account, a project (created when
// missing), one research session, turns dispatched one after another as ATTENDED turns (never `automated`: the learning loop
// refuses automated work), each read back from the product (run record, transcript, mounted-method selection, the product's
// read-only method observer). `next(turn, index)` decides the following user text from what the product replied (a scripted
// follow-up, a simulated person's correction) or returns null to end the conversation.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { digestTranscript, waitForMemoryTools } from '../../general-tasks/runner/cell.mjs';

const RUNNING = new Set(['queued', 'running', 'planned', 'dispatching', 'starting', 'waiting']);
const RUN_FIELDS = ['id', 'status', 'effectiveAgentId', 'effectiveRouteReason', 'verification', 'errorCode', 'durationMs', 'observedToolCalls',
  'artifacts', 'outputFiles', 'presentedFiles', 'usage', 'methodsLoaded', 'methodsInvoked', 'model', 'finishedAt', 'startedAt', 'automated', 'sessionId'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const learnedDirectory = methodId => `_lm${createHash('sha256').update(String(methodId ?? '')).digest('hex').slice(0, 32)}`;

/** @param {any} api @param {string} projectId @param {string} name */
export async function ensureProject(api, projectId, name) {
  // The catch-all is provisioned by the product; creating a named substitute changes memory scope.
  if (projectId === 'default') return 'default';
  const created = await api.call('POST', '/api/projects', { id: projectId, name: name ?? projectId }, { project: null });
  if (created.status === 200 || created.status === 201) return 'created';
  const list = await api.call('GET', '/api/projects', undefined, { project: null });
  const items = Array.isArray(list.json?.data) ? list.json.data : list.json?.data?.items ?? list.json?.data?.projects ?? [];
  if (items.some(p => p?.id === projectId)) return 'exists';
  throw new Error(`project ${projectId}: ${created.status} ${created.raw.slice(0, 200)}`);
}

async function readTranscript(projectDir, runId) {
  const file = `${projectDir}/.openscience/transcripts/${runId}.jsonl`;
  for (let i = 0; i < 25; i += 1) {
    try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { await sleep(1500); }
  }
  return null;
}
async function readSelection(projectDir) {
  try { return JSON.parse(await fs.readFile(`${projectDir}/runtime/capsule-methods/_selection.json`, 'utf8')); } catch { return null; }
}

/**
 * @param {{ api: any, userId: string, projectId: string, projectName?: string, sessionId: string, first: string, next: (turn: any, index: number) => Promise<string|null>|string|null,
 *   dataDir: string, outDir: string, timeoutMs: number, log: (m: string) => void, observeMethods?: (identity: any) => Promise<any>, waitMemoryTools?: boolean, maxTurns?: number,
 *   keepRuntime?: boolean, automated?: boolean, memoryBusyRetryMs?: number, continueAfterTimeout?: boolean, onTurn?: (record: any) => Promise<void> }} o
 */
export async function runConversation({ api, userId, projectId, projectName, sessionId, first, next, dataDir, outDir, timeoutMs, log, observeMethods = null, waitMemoryTools = true, maxTurns = 8, keepRuntime = false, automated = false, memoryBusyRetryMs = 0, continueAfterTimeout = false, onTurn = null }) {
  const t0 = Date.now();
  const record = { schema: 'lx-conversation/1', projectId, sessionId, startedAt: new Date().toISOString(), turns: [] };
  const admission = async (route, body) => {
    const deadline = Date.now() + memoryBusyRetryMs;
    while (true) {
      const response = await api.call('POST', route, body, route === '/api/commands/start_runtime' ? { timeoutMs: 300_000 } : undefined);
      if (response.status !== 409 || response.json?.code !== 'memory_source_cleanup_busy' || Date.now() >= deadline) return response;
      (record.admissionRetries ??= []).push({ at: new Date().toISOString(), route, code: response.json.code, requestId: response.json.requestId });
      log(`memory admission busy; retrying in 5s requestId=${response.json.requestId}`);
      await sleep(5000);
    }
  };
  api.project = projectId;
  record.project = await ensureProject(api, projectId, projectName);
  const projectDir = `${dataDir}/users/${userId}/projects/${projectId}`;
  await fs.mkdir(outDir, { recursive: true });
  if (waitMemoryTools && process.env.OPEN_SCIENCE_OPENVIKING_URL) {
    // A project reused across conversations keeps the previous kernel's tool list: wait for the new kernel's.
    await fs.rm(`${projectDir}/eval-memory-tools.json`, { force: true });
    const start = await admission('/api/commands/start_runtime', {});
    if (start.status !== 200) throw new Error(`start runtime: ${start.status} ${start.raw.slice(0, 200)}`);
    record.memoryToolsWait = await waitForMemoryTools(`${projectDir}/eval-memory-tools.json`);
  }
  const session = await api.call('PUT', `/api/research-sessions/${encodeURIComponent(sessionId)}`, { mode: 'open-domain' });
  if (session.status >= 400) throw new Error(`session ${sessionId}: ${session.status} ${session.raw.slice(0, 200)}`);
  let text = first;
  for (let index = 0; text && index < maxTurns; index += 1) {
    const turn = { index, text, startedAt: new Date().toISOString() };
    const t1 = Date.now();
    const dispatchId = `d_${sessionId}_${index}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
    const dispatched = await admission('/api/agent-runs/dispatch', { sessionId, dispatchId, text, ...(automated ? { automated: true } : {}) });
    if (dispatched.status !== 202) { turn.error = `dispatch ${dispatched.status} ${dispatched.raw.slice(0, 400)}`; record.turns.push(turn); break; }
    let run = dispatched.json.data;
    turn.runId = run.id;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const read = await api.call('GET', '/api/agent-runs');
      run = (read.json?.data ?? []).find(item => item.id === turn.runId) ?? run;
      if (!RUNNING.has(String(run.status))) break;
      await sleep(3000);
    }
    turn.wallMs = Date.now() - t1;
    if (RUNNING.has(String(run.status))) { turn.timedOut = true; await api.call('POST', `/api/agent-runs/${run.id}/cancel`, {}); await sleep(5000); }
    await sleep(2500);
    const settled = await api.call('GET', '/api/agent-runs');
    run = (settled.json?.data ?? []).find(item => item.id === turn.runId) ?? run;
    turn.run = Object.fromEntries(RUN_FIELDS.filter(k => k in run).map(k => [k, run[k]]));
    const lines = await readTranscript(projectDir, turn.runId);
    const digest = digestTranscript(lines);
    turn.reply = digest.reply; turn.tools = digest.tools.map(t => ({ name: t.name, status: t.status, error: t.error, input: t.input.slice(0, 200) }));
    if (lines) await fs.writeFile(`${outDir}/t${index}-${turn.runId}.jsonl.gz`, zlib.gzipSync(lines.map(l => JSON.stringify(l)).join('\n')));
    turn.selection = await readSelection(projectDir);
    if (observeMethods) {
      try { turn.methodObservation = await observeMethods({ userId, projectId, runId: turn.runId }); }
      catch (error) { turn.methodObservation = { error: String(error?.message ?? error) }; }
    }
    turn.finishedAt = new Date().toISOString();
    record.turns.push(turn);
    if (onTurn) await onTurn(record);
    log(`    turn ${index}: ${run.status} route=${run.effectiveAgentId}/${run.effectiveRouteReason} tools=${turn.tools.map(t => t.name).join('>') || '-'} wall=${Math.round(turn.wallMs / 1000)}s`);
    if (turn.timedOut && !continueAfterTimeout) break;
    text = await next(turn, index);
  }
  if (!keepRuntime) await api.call('POST', '/api/commands/stop_runtime', {}).catch(() => null);
  record.finishedAt = new Date().toISOString();
  record.wallMs = Date.now() - t0;
  return record;
}
