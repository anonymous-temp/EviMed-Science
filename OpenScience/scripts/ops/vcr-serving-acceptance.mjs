#!/usr/bin/env node
/**
 * Observe a real module-owned VCR run, preserving partial work and the evidence of each step as it happens.
 *
 * It signs in as nobody: after the candidate release is verified it registers a throwaway account (`throwaway-account.mjs`), makes the
 * study in it from `--study-input`, observes the module's run, and deletes the account through the product at the end — on a result,
 * an error or an interrupt (exit 4 and a FAIL line when it cannot). The account is deleted, so what it made is too: the evidence this
 * writes under `--out` (`observation.json` after every step, the delivered bytes) is the whole record, a study cannot be named again
 * and a run still going when the observation ends is cancelled with its account (exit 3) — give a long study a long `--timeout-ms`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertCandidate } from './result-revision-acceptance.mjs';
import { fetchTransport, openThrowawayAccount } from './throwaway-account.mjs';

export const VCR_ACCEPTANCE_ACTIONS = Object.freeze({
  'vcr-protocol': { section: 'run', payload: { step: 'definition' } },
  'vcr-evidence': { section: 'run', payload: { step: 'evidence' } },
  'vcr-analysis': { section: 'run', payload: { step: 'trial' } },
  'vcr-matching': { section: 'run', payload: { step: 'matching' } },
  'vcr-package': { section: 'export', payload: { kind: 'study_package' } },
});
const terminal = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'timed_out']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function safeArtifactPath(value) {
  assert.ok(typeof value === 'string' && value.length < 1024 && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value));
  assert.ok(value.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe artifact path');
  assert.ok(!/^(?:patient-data|data-plane|vcr-data)(?:\/|$)/.test(value), 'protected data is not an acceptance deliverable');
  return value;
}
export function moduleRun(run, capability, projectId, previousIds = []) {
  return Boolean(run && run.effectiveAgentId === capability && String(run.dispatchId ?? '').startsWith('vcr-')
    && (!run.projectId || run.projectId === projectId) && !previousIds.includes(run.id));
}

/** api is authenticated and returns the actual platform data envelope's data. Tests inject protocol doubles only. */
export async function observeVcrRun({ api, manifest, expectedRevision, capability, create,
  persist, saveArtifact, timeoutMs = 1_800_000, pollMs = 3000, now = Date.now, pause = sleep }) {
  assert.ok(VCR_ACCEPTANCE_ACTIONS[capability], 'choose one of the five VCR capabilities');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 7_200_000);
  assert.ok(Number.isSafeInteger(pollMs) && pollMs > 0);
  const report = { schemaVersion: 1, scope: 'actual-hosted-module-native-vcr', capability,
    expectedRevision, releaseId: manifest.app.releaseId, startedAt: new Date(now()).toISOString(), accepted: false,
    qualified: false, artifacts: [] };
  assertCandidate(manifest, await api('/api/health'), await api('/api/ready'), expectedRevision);
  report.candidateVerified = true;
  assert.ok(create && typeof create.question === 'string' && create.question.length > 0 && create.question.length <= 2000,
    'a complete bounded study question is required; questions are never silently clipped');
  assert.equal(create.dataTier, 'T0', 'this create path contains no patient data; a T1 study needs the real data plane, which a throwaway account has not got');
  // Said before the request: a reply that never comes back leaves this line as the evidence that the study may exist.
  report.createAttempted = true; await persist(report);
  const made = await api('/api/vcr/studies', create);
  assert.ok(made.id && made.projectId, 'module creation omitted its actual study/project identity');
  report.studyId = made.id; report.projectId = made.projectId; report.created = made;
  await persist(report);
  const study = await api(`/api/vcr/studies/${encodeURIComponent(report.studyId)}`);
  assert.ok(study.projectId, 'study lacks its control project');
  if (report.projectId) assert.equal(study.projectId, report.projectId);
  report.projectId = study.projectId;
  report.study = { id: report.studyId, projectId: study.projectId, dataTier: study.dataTier, intendedUse: study.intendedUse };
  const runs = () => api('/api/agent-runs', undefined, report.projectId);
  // The study is new, so no run of it is a previous one. Creation already requests the programme; its first worker dispatch can race
  // this observer.
  report.previousRunIds = [];
  report.requestAttempted = true; report.requestedAt = new Date(now()).toISOString(); await persist(report);
  const action = VCR_ACCEPTANCE_ACTIONS[capability];
  const reply = await api(`/api/vcr/studies/${encodeURIComponent(report.studyId)}/${action.section}`, action.payload, report.projectId);
  // advance() can report a currently running upstream step while the requested step remains queued.
  // Correlate the reply to the requested capability rather than attributing that other step's work.
  if (reply.runId) {
    const returned = (await runs()).find(run => run.id === reply.runId);
    if (moduleRun(returned, capability, report.projectId, report.previousRunIds)) report.runId = reply.runId;
  }
  report.moduleReply = reply;
  await persist(report);
  // An uncertain POST is observed, never retried. Only this project's module runs can satisfy the request.
  const deadline = now() + timeoutMs;
  let run;
  do {
    const listed = await runs();
    if (report.runId) run = listed.find(item => item.id === report.runId);
    else {
      const candidates = listed.filter(item => moduleRun(item, capability, report.projectId, report.previousRunIds));
      assert.ok(candidates.length <= 1, 'more than one new module run matches; select the actual run ID before resuming');
      run = candidates[0];
    }
    if (run) {
      assert.ok(moduleRun(run, capability, report.projectId), 'response points outside the requested module/capability/project');
      report.runId = run.id;
      report.run = run; await persist(report);
      if (terminal.has(run.status)) break;
    }
    if (now() >= deadline) break;
    await pause(Math.min(pollMs, deadline - now()));
  } while (now() <= deadline);
  report.observation = run && terminal.has(run.status) ? 'terminal' : 'pending';
  // Archive bytes regardless of gate findings. Binary formats are downloaded directly, never text-decoded.
  const captureErrors = []; let total = 0;
  for (const relative of [...new Set([...(run?.artifacts ?? []), ...(run?.unverifiedArtifacts ?? [])])].slice(0, 40)) {
    try {
      safeArtifactPath(relative);
      const bytes = await api(`/api/files/download/${relative.split('/').map(encodeURIComponent).join('/')}`, undefined, report.projectId, true);
      assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32 * 1024 * 1024 && total + bytes.length <= 128 * 1024 * 1024, 'artifact exceeds capture budget or is empty');
      total += bytes.length;
      const record = { path: relative, sha256: sha(bytes), bytes: bytes.length };
      await saveArtifact(relative, bytes);
      report.artifacts = report.artifacts.filter(item => item.path !== relative); report.artifacts.push(record);
      await persist(report);
    } catch { captureErrors.push({ pathDigest: sha(String(relative)), reason: 'artifact_capture_unavailable' }); }
  }
  report.captureErrors = captureErrors;
  report.deliveryObserved = report.observation === 'terminal' && report.artifacts.length > 0;
  report.usableDelivery = report.artifacts.length > 0;
  // The run ledger uses null for completed checks, unverified for findings and unchecked for skipped checks.
  // Delivery measurement preserves both latter states and their actual findings.
  report.verificationComplete = report.observation === 'terminal' && run?.status === 'succeeded' && run.verification == null;
  report.acceptanceIndependent = report.candidateVerified && report.deliveryObserved && run?.status === 'succeeded'
    && captureErrors.length === 0;
  report.accepted = report.acceptanceIndependent;
  report.finishedAt = new Date(now()).toISOString(); await persist(report);
  return report;
}

async function main() {
  const args = {}; const entries = process.argv.slice(2);
  for (let index = 0; index < entries.length; index += 2) {
    assert.ok(entries[index].startsWith('--') && entries[index + 1], 'arguments use --name value');
    args[entries[index].slice(2)] = entries[index + 1];
  }
  // A missing setting is not a credential: say what to set rather than the fixed driver error below.
  const refuse = message => { process.stderr.write(`${message}\n`); process.exitCode = 2; };
  // A throwaway account holds no study: the one to observe is made in it from the input, and none can be named.
  if (!args['study-input'] || args.study) return refuse('A throwaway account holds no study: give --study-input <study json>; there is no --study.');
  const base = String(args.base ?? process.env.OPEN_SCIENCE_ACCEPTANCE_BASE_URL ?? '').replace(/\/+$/, '');
  const url = new URL(base);
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'use HTTPS or an SSH loopback tunnel');
  assert.equal(url.username + url.password + url.search + url.hash, '', 'base URL cannot contain credentials');
  const manifest = JSON.parse(await readFile(args['candidate-manifest'] ?? process.env.OPEN_SCIENCE_ACCEPTANCE_CANDIDATE_MANIFEST, 'utf8'));
  const expectedRevision = args['expected-revision'] ?? process.env.OPEN_SCIENCE_ACCEPTANCE_EXPECTED_REVISION;
  const out = path.resolve(args.out); await mkdir(out, { recursive: true, mode: 0o700 });
  const evidence = path.join(out, 'observation.json');
  // An earlier observation belongs to an account that is gone: its study cannot be resumed, and writing over it would lose it.
  if (existsSync(evidence)) return refuse('The output directory already holds an observation of an account that has been deleted: use a new --out.');
  const create = JSON.parse(await readFile(args['study-input'], 'utf8'));
  /** @type {Record<string, string>} */ let headers = {};
  const api = async (route, data, projectId, raw = false) => {
    const response = await fetch(`${base}${route}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers, ...(projectId ? { 'x-open-science-project': projectId } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `${route.split('?')[0]} returned ${response.status}`);
    if (raw) {
      assert.ok(response.body, 'artifact body is missing');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          size += item.value.length;
          assert.ok(size <= 32 * 1024 * 1024, 'artifact capture size exceeded');
          chunks.push(item.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return Buffer.concat(chunks, size);
    }
    return (await response.json()).data;
  };
  /** The newest evidence: what the account's deletion cancels if the observation ends with the run still going. @type {any} */ let latest = null;
  const persist = async report => { latest = report; await writeFile(`${evidence}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await rename(`${evidence}.tmp`, evidence); };
  const saveArtifact = async (relative, bytes) => { const target = path.join(out, 'deliverable', safeArtifactPath(relative)); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { mode: 0o600 }); };
  // Verify release before any account is made or any authenticated mutation is sent: a wrong release creates nothing.
  assertCandidate(manifest, await api('/api/health'), await api('/api/ready'), expectedRevision);
  const account = await openThrowawayAccount({ base, send: fetchTransport(base), prefix: 'acc', stop: async () => {
    if (!latest?.runId || terminal.has(latest.run?.status)) return;
    await api(`/api/agent-runs/${encodeURIComponent(latest.runId)}/cancel`, {}, latest.projectId);
  } });
  headers = { ...account.headers };
  /** @type {any} */ let report = null; let failed = false;
  try {
    report = await observeVcrRun({ api, manifest, expectedRevision, capability: args.capability,
      create, persist, saveArtifact, timeoutMs: Number(args['timeout-ms'] ?? 1_800_000) });
  } catch { failed = true; }
  // Deleted whatever happened above: the evidence is under --out, the account is not needed again.
  const outcome = await account.close();
  if (!outcome.deleted) { process.stderr.write('VCR acceptance driver left its throwaway account: see the FAIL line above.\n'); process.exitCode = 4; return; }
  if (failed) throw new Error('observation failed');
  process.stdout.write(JSON.stringify({ studyId: report.studyId, projectId: report.projectId, runId: report.runId ?? null,
    observation: report.observation, accepted: report.accepted, usableDelivery: report.usableDelivery,
    verificationComplete: report.verificationComplete, acceptanceIndependent: report.acceptanceIndependent,
    deliveryObserved: report.deliveryObserved, evidence }) + '\n');
  process.exitCode = report.observation === 'pending' ? 3 : report.accepted ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  // Upstream responses and authentication errors can contain credentials. Only a fixed driver error is printed.
  process.stderr.write('VCR acceptance driver failed; the evidence under --out is what was observed, and nothing is redispatched.\n'); process.exitCode = 2;
});
