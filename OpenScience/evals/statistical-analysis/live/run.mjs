// Local acceptance through the real control plane, gateway and pinned DSH.
// Usage: node live/run.mjs --case continuity --base http://127.0.0.1:48861 --data /tmp/esa/data --out /tmp/esa/results
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { openThrowawayAccount, fetchTransport } from '../../../scripts/ops/throwaway-account.mjs';
import { workspaceManifest, digestTranscript } from '../../general-tasks/runner/cell.mjs';
import { driveTurns } from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), values[index + 1]]);
  return pairs;
}, []));
const base = args.base ?? 'http://127.0.0.1:48861';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('This candidate harness is local only.');
if (!args.data || !args.out || !args.case) throw new Error('Pass --case, --data and --out.');
const spec = JSON.parse(await fs.readFile(path.join(HERE, 'cases.json'), 'utf8')).cases.find((c) => c.id === args.case);
if (!spec) throw new Error('Unknown analysis case.');
const out = path.resolve(args.out, `${spec.id}-${Date.now()}`);
await fs.mkdir(out, { recursive: true });
let account;
let projectId;
let currentRun;
const api = async (method, route, body) => {
  const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(120_000),
    headers: { ...account.headers, 'Content-Type': 'application/json', ...(projectId ? { 'X-Open-Science-Project': projectId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${result.code ?? result.error?.code ?? 'request_failed'}`);
  if (route.endsWith('/dispatch')) currentRun = result.data?.id;
  return result.data;
};
const record = { schemaVersion: 1, case: spec.id, base, environment: 'local-host-kernel-real-control-plane', turns: [] };
let failure;
try {
  account = await openThrowawayAccount({ base, prefix: 'analysis', send: fetchTransport(base), stop: async () => {
    if (currentRun) await api('POST', `/api/agent-runs/${currentRun}/cancel`, {});
  } });
  const me = await api('GET', '/api/me');
  projectId = `analysis-${randomUUID().slice(0, 8)}`;
  await api('POST', '/api/projects', { id: projectId, name: spec.id });
  const sessionId = `analysis-${randomUUID().slice(0, 8)}`;
  await api('PUT', `/api/research-sessions/${sessionId}`, { mode: 'open-domain' });
  const project = path.join(path.resolve(args.data), 'users', me.user.id, 'projects', projectId);
  const workspace = path.join(project, 'workspace');
  record.projectId = projectId;
  record.sessionId = sessionId;
  record.inputs = [];
  const upload = async (names) => {
    for (const name of names) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Fixture names must be plain filenames.');
      const file = path.join(HERE, 'fixtures', name);
      const bytes = await fs.readFile(file);
      await api('POST', '/api/files/upload', { root: 'workspace', path: `data/${name}`, data: bytes.toString('base64'), encoding: 'base64' });
      record.inputs.push({ path: `data/${name}`, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  const capture = async (run, index) => {
    currentRun = null;
    const destination = path.join(out, `turn-${index}`);
    await fs.mkdir(destination, { recursive: true });
    let lines;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { lines = (await fs.readFile(path.join(project, '.openscience/transcripts', `${run.id}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); break; }
      catch { await sleep(1000); }
    }
    const manifest = await workspaceManifest(workspace);
    const failed = [];
    for (const file of manifest) {
      if (file.bytes > 30 * 1024 * 1024 || file.sha256 === 'too-large') { failed.push(file.path); continue; }
      const target = path.join(destination, 'workspace', file.path);
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const bytes = await fs.readFile(path.join(workspace, file.path));
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Workspace changed during capture.');
        await fs.writeFile(target, bytes);
      } catch { failed.push(file.path); }
    }
    await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (lines) await fs.writeFile(path.join(destination, 'transcript.json'), JSON.stringify(lines, null, 2));
    const digest = digestTranscript(lines);
    await fs.writeFile(path.join(destination, 'reply.md'), digest.reply);
    return { complete: Boolean(lines) && failed.length === 0 && manifest.length < 2000, failed, manifest, ...digest };
  };
  await driveTurns({ api, sessionId, turns: spec.turns, upload, capture,
    timeoutMs: Number(args['timeout-ms'] ?? 900_000),
    onTurn: async (turn, turns) => {
      record.turns = turns;
      await fs.writeFile(path.join(out, 'run.json'), JSON.stringify(record, null, 2));
      console.log(`${spec.id} turn ${turn.index}: ${turn.run.status}, route=${turn.run.effectiveAgentId}, tools=${turn.run.observedToolCalls}, capture=${turn.artifacts.complete}`);
    },
  });
  record.executionComplete = record.turns.length === spec.turns.length && record.turns.every((t) => !t.timedOut && t.run.status === 'succeeded' && t.artifacts.complete);
} catch (error) {
  failure = String(error?.message ?? error);
  record.error = failure;
} finally {
  record.cleanup = account ? await account.close() : { deleted: true, reason: 'not-created' };
  await fs.writeFile(path.join(out, 'run.json'), JSON.stringify(record, null, 2));
}
console.log(`Evidence: ${out}`);
if (failure) console.error(failure);
process.exitCode = record.executionComplete && record.cleanup.deleted ? 0 : 1;
