/** Real, local-only API acceptance. Saves failures and bytes; scientific judging is a separate step. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { digestTranscript } from "../../general-tasks/runner/cell.mjs";
import { workspaceChangedFiles } from '../../../apps/server/src/runWorkspaceChanges.mjs';
import { fetchWithRetry } from './transport.mjs';
import { openThrowawayAccount, fetchTransport } from '../../../scripts/ops/throwaway-account.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((out, item, index, all) => {
  if (index % 2 === 0) out.push([item.replace(/^--/, ''), all[index + 1]]);
  return out;
}, []));
const base = args.base ?? 'http://127.0.0.1:8787';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw new Error('Acceptance only runs on a local candidate.');
const specPath = args.spec ? path.resolve(args.spec) : path.join(here, 'cases.json');
const fixtureBase = args['fixture-root'] ? await fs.realpath(path.resolve(args['fixture-root'])) : here;
const allowedFixtures = args['fixture-root'] ? fixtureBase : await fs.realpath(path.resolve(here, '..'));
const spec = JSON.parse(await fs.readFile(specPath, 'utf8')).cases.find(item => item.id === args.case);
if (!spec || !args.out) throw new Error('Pass --case and --out.');
const directory = path.resolve(args.out, `${spec.id}-${Date.now()}`);
await fs.mkdir(directory, { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const record = { schemaVersion: 1, case: spec.id, startedAt: new Date().toISOString(), environment: 'local-linux-control-plane-docker-runtime', inputs: [], turns: [], cleanup: null };
const writeRecord = () => fs.writeFile(path.join(directory, 'run.json'), JSON.stringify(record, null, 2));
let account, key, analysis, active, userId;
async function request(route, { method = 'GET', body, raw, headers = {}, cookie = false } = {}) {
  const response = await fetchWithRetry(`${base}${route}`, {
    method, redirect: 'error',
    headers: { ...(cookie ? account.headers : { authorization: `Bearer ${key}` }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  }, { timeoutMs: method === 'GET' ? 30_000 : 120_000,
    retryable: method === 'GET' || Boolean(body?.requestId) || Boolean(raw) || route.endsWith('/cancel'),
    onRetry: fault => { (record.transportRetries ??= []).push({ route, method, ...fault }); },
  });
  const answer = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${method} ${route}: ${response.status} ${answer.code ?? 'request_failed'}`), { status: response.status, code: answer.code });
  return answer.data;
}
const api = (suffix, options) => request(`/api/data-analysis/v1${suffix}`, options);
async function download(artifact, target) {
  if (!artifact.downloadUrl?.startsWith(`/api/data-analysis/v1/analyses/${analysis.id}/artifacts/`)) throw new Error('Unowned artifact URL.');
  const response = await fetchWithRetry(`${base}${artifact.downloadUrl}`, { redirect: 'error', headers: { authorization: `Bearer ${key}` } }, { timeoutMs: 60_000, onRetry: fault => { (record.transportRetries ??= []).push({ route: artifact.downloadUrl, method: 'GET', ...fault }); } });
  if (!response.ok) throw new Error(`Artifact download: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw new Error('Artifact digest or size mismatch.');
  if (target) await fs.writeFile(target, bytes);
  return { id: artifact.id, filename: artifact.filename, bytes: bytes.length, sha256: digest(bytes), role: artifact.role, disposition: response.headers.get('content-disposition') };
}
try {
  account = await openThrowawayAccount({ base, prefix: 'analysisapi', send: fetchTransport(base), stop: async () => {
    if (active && analysis && key) await api(`/analyses/${analysis.id}/turns/${active}/cancel`, { method: 'POST', body: {} });
  } });
  userId = (await request('/api/me', { cookie: true })).user.id;
  const readyResponse = await fetch(`${base}/api/ready`, { headers: account.headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  const readiness = (await readyResponse.json()).data;
  record.readinessStatus = readyResponse.status;
  record.runtime = readiness?.checks?.runtime;
  record.model = readiness?.checks?.modelGateway?.model;
  record.sourceDigests = {};
  for (const relative of ['capabilities/statistical-analysis/SKILL.md', 'capabilities/statistical-analysis/scripts/analysis_checks.py', 'apps/server/src/dataAnalysisService.mjs', 'apps/server/src/dataAnalysisArtifacts.mjs']) {
    record.sourceDigests[relative] = digest(await fs.readFile(path.resolve(here, '../../..', relative)));
  }
  key = (await request('/api/agent-keys', { method: 'POST', cookie: true, body: { name: 'Isolated analysis acceptance', scopes: ['analysis.read', 'analysis.write'] } })).key;
  analysis = await api('/analyses', { method: 'POST', body: { name: `Acceptance ${spec.id}`, requestId: `${spec.id}-create` } });
  record.analysisId = analysis.id;
  record.projectId = analysis.projectId;
  const duplicate = await api('/analyses', { method: 'POST', body: { name: `Acceptance ${spec.id}`, requestId: `${spec.id}-create` } });
  if (duplicate.id !== analysis.id) throw new Error('Create retry changed identity.');
  for (const input of spec.inputs) {
    let saved;
    if (input.file) {
      const filename = path.basename(input.file), full = await fs.realpath(path.resolve(fixtureBase, input.file));
      if (!full.startsWith(allowedFixtures + path.sep)) throw new Error('Fixture escapes its explicitly authorized input directory.');
      const bytes = await fs.readFile(full);
      saved = await api(`/analyses/${analysis.id}/inputs?filename=${encodeURIComponent(filename)}`, { method: 'POST', raw: bytes, headers: { 'content-type': 'application/octet-stream' } });
      if (saved.sha256 !== digest(bytes)) throw new Error('Input digest mismatch.');
    } else saved = await api(`/analyses/${analysis.id}/inputs`, { method: 'POST', body: input });
    record.inputs.push(saved);
  }
  await writeRecord();
  const historical = [];
  for (const [index, question] of spec.turns.entries()) {
    const startedAt = Date.now();
    let turn = await api(`/analyses/${analysis.id}/turns`, { method: 'POST', body: { requestId: `${spec.id}-turn-${index}`, question } });
    active = turn.id;
    record.activeTurn = { index, id: turn.id, runId: turn.runId, startedAt: new Date(startedAt).toISOString() };
    await writeRecord();
    const repeated = await api(`/analyses/${analysis.id}/turns`, { method: 'POST', body: { requestId: `${spec.id}-turn-${index}`, question } });
    if (repeated.id !== turn.id) throw new Error('Turn retry changed identity.');
    const destination = path.join(directory, `turn-${index}`);
    await fs.mkdir(destination);
    let lastProgress = 0;
    let cancellationRequested = false;
    while (!turn.result && !['failed', 'cancelled', 'canceled'].includes(turn.status)) {
      if (Date.now() - startedAt > 900_000) {
        await api(`/analyses/${analysis.id}/turns/${turn.id}/cancel`, { method: 'POST', body: {} });
        throw new Error('Real analysis exceeded the 15-minute case limit; cancellation requested.');
      }
      if (args['cancel-after-output'] === 'true' && !cancellationRequested) {
        if (!args.data) throw new Error('Cancellation acceptance requires --data for local artifact observation.');
        const workspace = path.join(path.resolve(args.data), 'users', userId, 'projects', analysis.projectId, 'workspace');
        const changed = await workspaceChangedFiles(workspace, { since: startedAt });
        const partial = changed.filter(file => file.startsWith('deliverables/') && /\.(csv|json|png)$/i.test(file));
        if (partial.length) {
          turn = await api(`/analyses/${analysis.id}/turns/${turn.id}/cancel`, { method: 'POST', body: {} });
          cancellationRequested = true;
          record.cancellationObservedFiles = partial;
        }
      }
      if (Date.now() - lastProgress > 45_000) { console.log(`${spec.id} turn ${index}: ${turn.status}`); lastProgress = Date.now(); }
      await sleep(3000);
      turn = await api(`/analyses/${analysis.id}/turns/${turn.id}/results`);
    }
    await fs.writeFile(path.join(destination, 'result.json'), JSON.stringify(turn, null, 2));
    if (args.data && turn.runId) {
      const transcriptPath = path.join(path.resolve(args.data), 'users', userId, 'projects', analysis.projectId, '.openscience', 'transcripts', `${turn.runId}.jsonl`);
      try {
        const text = await fs.readFile(transcriptPath, 'utf8');
        const lines = text.split('\n').filter(Boolean).map(JSON.parse);
        const digestRecord = digestTranscript(lines);
        await fs.writeFile(path.join(destination, 'transcript-digest.json'), JSON.stringify(digestRecord, null, 2));
        // Raw transcripts stay in this explicitly local acceptance directory, never the published evidence pack.
        await fs.writeFile(path.join(destination, 'transcript.json'), JSON.stringify(lines), { mode: 0o600 });
      } catch (error) {
        await fs.writeFile(path.join(destination, 'transcript-unavailable.json'), JSON.stringify({ code: error.code ?? 'capture_failed' }));
      }
    }
    const downloads = [];
    for (const artifact of turn.result?.artifacts ?? []) {
      if (!/^[a-zA-Z0-9_-]+$/.test(artifact.id)) throw new Error('Invalid artifact identity.');
      const ext = path.extname(artifact.filename).replace(/[^.a-zA-Z0-9]/g, '');
      const stored = `${artifact.id}${ext}`;
      downloads.push({ ...await download(artifact, path.join(destination, stored)), stored });
    }
    const oldDownloads = [];
    for (const artifact of historical) oldDownloads.push(await download(artifact));
    historical.push(...(turn.result?.artifacts ?? []));
    await fs.writeFile(path.join(destination, 'downloads.json'), JSON.stringify(downloads, null, 2));
    const row = { index, turnId: turn.id, runId: turn.runId, status: turn.status, durationMs: Date.now() - startedAt,
      downloadedArtifacts: downloads.length, priorArtifactsRechecked: oldDownloads.length,
      figures: downloads.filter(item => item.role === 'figure').length, structuredResults: Boolean(turn.result?.structuredResults), notices: turn.result?.notices ?? [] };
    if (cancellationRequested) row.cancellationRequested = true;
    record.turns.push(row);
    console.log(`${spec.id} turn ${index}: ${row.status}; artifacts=${row.downloadedArtifacts}; figures=${row.figures}`);
    await writeRecord();
    active = null;
    record.activeTurn = null;
    if (args['cancel-after-output'] === 'true') {
      if (!cancellationRequested || !['cancelled', 'canceled'].includes(turn.status) || !downloads.length) throw new Error('Cancellation did not retain a useful partial artifact.');
      record.cancellationComplete = true;
      break;
    }
    if (turn.status !== 'succeeded' || !downloads.length) throw new Error('Run did not complete with downloadable output; dependent turns stopped.');
  }
  record.executionComplete = true;
} catch (error) {
  record.failure = { code: error.code ?? 'acceptance_failed', message: error.message };
  record.executionComplete = false;
  process.exitCode = 1;
} finally {
  if (account) {
    try { record.cleanup = await account.close(); }
    catch (error) { record.cleanup = { deleted: false, error: error.message }; process.exitCode = 1; }
  }
  record.finishedAt = new Date().toISOString();
  await writeRecord();
  console.log(`Evidence: ${directory}`);
  if (record.failure) console.error(record.failure.message);
}
