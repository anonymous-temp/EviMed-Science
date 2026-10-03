import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleRun, observeVcrRun, safeArtifactPath, VCR_ACCEPTANCE_ACTIONS } from '../../../scripts/ops/vcr-serving-acceptance.mjs';
const revision = 'a'.repeat(40);
const manifest = { app: { releaseId: 'candidate' }, runtime: { image: 'runtime:exact', imageId: 'sha256:' + 'b'.repeat(64) },
  services: [{ name: 'result-replay', image: 'replay:exact', imageId: 'sha256:' + 'c'.repeat(64) }], source: { revision } };
function fixture({ wrongRelease = false, lostPost = false, status = 'succeeded', verification, artifactError = false } = {}) {
  let requested = false; let clock = 0; const requests = []; const persisted = []; const artifacts = [];
  const run = { id: 'actual-run', projectId: 'actual-project', effectiveAgentId: 'vcr-protocol', dispatchId: 'vcr-real-1',
    status, verification, question: 'actual module brief', artifacts: ['deliverables/report.pdf'] };
  const bytes = Buffer.from([37,80,68,70,45,49,0,255,10]);
  return { run, bytes, requests, persisted, artifacts,
    options: { manifest, expectedRevision: revision, capability: 'vcr-protocol', studyId: 'actual-study', timeoutMs: 2, pollMs: 1,
      now: () => clock, pause: async ms => { clock += ms; },
      persist: async value => persisted.push(structuredClone(value)), saveArtifact: async (file, value) => artifacts.push({ file, value }),
      api: async (route, data, project, raw) => {
        requests.push({ route, data, project, raw });
        if (route === '/api/health') return { releaseId: wrongRelease ? 'old' : 'candidate' };
        if (route === '/api/ready') return { ok: true, checks: { release: { ok: true, releaseId: 'candidate', revision: revision.slice(0,12) } } };
        if (route === '/api/vcr/studies/actual-study') return { id: 'actual-study', projectId: 'actual-project', dataTier: 'T0' };
        if (route === '/api/agent-runs') { assert.equal(project, 'actual-project'); return requested ? [run] : []; }
        if (route.endsWith('/run')) { requested = true; if (lostPost) throw new Error('lost reply'); return { runId: 'actual-run' }; }
        if (route.startsWith('/api/files/download/')) { if (artifactError) throw new Error('not readable'); return bytes; }
        throw new Error(`unhandled protocol ${route}`);
      } },
  };
}
test('refuses an old candidate before authenticated module writes', async () => {
  const f = fixture({ wrongRelease: true }); await assert.rejects(observeVcrRun(f.options));
  assert.ok(f.requests.every(item => item.data === undefined)); assert.equal(f.persisted.length, 0);
});
test('dispatches through the real module route and preserves exact binary delivery hashes', async () => {
  const f = fixture(); const report = await observeVcrRun(f.options);
  assert.equal(report.runId, 'actual-run'); assert.equal(report.accepted, true); assert.equal(report.qualified, false);
  assert.deepEqual(f.artifacts[0].value, f.bytes);
  assert.equal(report.artifacts[0].sha256, createHash('sha256').update(f.bytes).digest('hex'));
  assert.ok(f.requests.some(item => item.route === '/api/vcr/studies/actual-study/run'));
  assert.ok(f.requests.every(item => item.route !== '/api/agent-runs/dispatch'));
});
test('unknown POST result resumes observation without buying another module run', async () => {
  const f = fixture({ lostPost: true }); await assert.rejects(observeVcrRun(f.options), /lost reply/);
  const checkpoint = f.persisted.at(-1); assert.equal(checkpoint.requestAttempted, true);
  const report = await observeVcrRun({ ...f.options, checkpoint });
  assert.equal(report.runId, 'actual-run'); assert.equal(f.requests.filter(item => item.data).length, 1);
});
test('pending bounded observation preserves partial bytes and never cancels', async () => {
  const f = fixture({ status: 'running' }); const report = await observeVcrRun(f.options);
  assert.equal(report.observation, 'pending'); assert.equal(report.artifacts.length, 1); assert.equal(report.accepted, false);
  assert.ok(f.requests.every(item => !item.route.includes('cancel')));
});
test('unverified terminal deliverable is usable independent delivery evidence while its findings remain unverified', async () => {
  const f = fixture({ verification: 'unverified' }); const report = await observeVcrRun(f.options);
  assert.equal(report.deliveryObserved, true); assert.equal(report.accepted, true); assert.equal(f.artifacts.length, 1);
  assert.equal(report.usableDelivery, true); assert.equal(report.verificationComplete, false);
  assert.equal(report.acceptanceIndependent, true); assert.equal(report.qualified, false); assert.equal(report.run.verification, 'unverified');
});

test('actual CLI uses native HTTP fetch properties and preserves an unverified binary delivery with findings', async t => {
  // Real local HTTP/CLI transport; response fixtures measure the driver, not hosted VCR qualification.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vcr-acceptance-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestFile = path.join(directory, 'manifest.json'), passwordFile = path.join(directory, 'password');
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(passwordFile, 'synthetic-acceptance-password', { mode: 0o600 });
  const bytes = Buffer.from([37,80,68,70,45,49,0,255,10]); let requested = false; const calls = [];
  const run = { id: 'cli-run', projectId: 'actual-project', effectiveAgentId: 'vcr-protocol', dispatchId: 'vcr-cli-actual-route',
    status: 'succeeded', verification: 'unverified', qualityNotices: ['Synthetic preserved finding'], artifacts: ['deliverables/report.pdf'] };
  const server = http.createServer(async (req, res) => {
    calls.push(req.url); for await (const _chunk of req) { /* consume the actual request */ }
    const reply = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })); };
    if (req.url === '/api/health') return reply({ releaseId: 'candidate' });
    if (req.url === '/api/ready') return reply({ ok: true, checks: { release: { ok: true, releaseId: 'candidate', revision: revision.slice(0,12) } } });
    if (req.url === '/api/auth/login') { res.setHeader('set-cookie', 'synthetic-session=owned; HttpOnly'); return reply({ csrfToken: 'synthetic-csrf' }); }
    if (req.url === '/api/vcr/studies/actual-study') return reply({ id: 'actual-study', projectId: 'actual-project', dataTier: 'T0' });
    assert.equal(req.headers['x-open-science-project'], 'actual-project');
    if (req.url === '/api/agent-runs') return reply(requested ? [run] : []);
    if (req.url === '/api/vcr/studies/actual-study/run') { requested = true; return reply({ runId: run.id }); }
    if (req.url === '/api/files/download/deliverables/report.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(bytes); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const out = path.join(directory, 'evidence'), entry = fileURLToPath(new URL('../../../scripts/ops/vcr-serving-acceptance.mjs', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [entry, '--base', `http://127.0.0.1:${server.address().port}`,
    '--candidate-manifest', manifestFile, '--expected-revision', revision, '--capability', 'vcr-protocol', '--study', 'actual-study', '--out', out],
  { timeout: 10000, maxBuffer: 65536, env: { PATH: process.env.PATH, OPEN_SCIENCE_ACCEPTANCE_PASSWORD_FILE: passwordFile } });
  const summary = JSON.parse(result.stdout), evidence = JSON.parse(await readFile(path.join(out, 'observation.json'), 'utf8'));
  assert.equal(summary.usableDelivery, true); assert.equal(summary.verificationComplete, false); assert.equal(summary.acceptanceIndependent, true);
  assert.equal(evidence.qualified, false); assert.equal(evidence.run.verification, 'unverified'); assert.deepEqual(evidence.run.qualityNotices, run.qualityNotices);
  assert.deepEqual(await readFile(path.join(out, 'deliverable/deliverables/report.pdf')), bytes);
  assert.equal(calls.filter(route => route.endsWith('/run')).length, 1);
  assert.ok(calls.indexOf('/api/health') < calls.indexOf('/api/auth/login'));
});
test('missing downloadable artifact cannot establish delivery', async () => {
  const report = await observeVcrRun(fixture({ artifactError: true }).options);
  assert.equal(report.deliveryObserved, false); assert.equal(report.accepted, false); assert.equal(report.captureErrors.length, 1);
});
test('module/capability/project binding and safe paths reject false cross-scope evidence', () => {
  const f = fixture(); assert.equal(moduleRun(f.run, 'vcr-evidence', 'actual-project'), false);
  assert.equal(moduleRun({ ...f.run, projectId: 'other' }, 'vcr-protocol', 'actual-project'), false);
  assert.equal(moduleRun({ ...f.run, dispatchId: 'ordinary' }, 'vcr-protocol', 'actual-project'), false);
  assert.equal(moduleRun(f.run, 'vcr-protocol', 'actual-project', [f.run.id]), false);
  for (const file of ['../secret', '/secret', 'deliverables/../secret', 'vcr-data/patients.csv', 'folder\\file']) assert.throws(() => safeArtifactPath(file));
  assert.equal(Object.keys(VCR_ACCEPTANCE_ACTIONS).length, 5);
  assert.equal(VCR_ACCEPTANCE_ACTIONS['vcr-package'].section, 'export');
});
