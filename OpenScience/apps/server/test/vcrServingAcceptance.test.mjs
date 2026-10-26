import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
    options: { manifest, expectedRevision: revision, capability: 'vcr-protocol', create: { question: 'A bounded synthetic study question', dataTier: 'T0' }, timeoutMs: 2, pollMs: 1,
      now: () => clock, pause: async ms => { clock += ms; },
      persist: async value => persisted.push(structuredClone(value)), saveArtifact: async (file, value) => artifacts.push({ file, value }),
      api: async (route, data, project, raw) => {
        requests.push({ route, data, project, raw });
        if (route === '/api/health') return { releaseId: wrongRelease ? 'old' : 'candidate' };
        if (route === '/api/ready') return { ok: true, checks: { release: { ok: true, releaseId: 'candidate', revision: revision.slice(0,12) } } };
        if (route === '/api/vcr/studies') return { id: 'actual-study', projectId: 'actual-project' };
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
test('an unknown reply to the module request is never answered with another one, and the attempt is in the evidence', async () => {
  const f = fixture({ lostPost: true }); await assert.rejects(observeVcrRun(f.options), /lost reply/);
  const checkpoint = f.persisted.at(-1); assert.equal(checkpoint.requestAttempted, true); assert.equal(checkpoint.studyId, 'actual-study');
  assert.equal(f.requests.filter(item => item.route.endsWith('/run')).length, 1, 'the module is asked once');
});
test('the study is made from the input by the module, and nothing else makes one', async () => {
  const f = fixture(); const report = await observeVcrRun(f.options);
  const made = f.requests.filter(item => item.route === '/api/vcr/studies');
  assert.equal(made.length, 1); assert.deepEqual(made[0].data, f.options.create);
  assert.equal(report.createAttempted, true); assert.deepEqual(report.previousRunIds, []);
  await assert.rejects(observeVcrRun({ ...fixture().options, create: { question: 'x', dataTier: 'T1' } }), /T1 study needs the real data plane/);
  await assert.rejects(observeVcrRun({ ...fixture().options, create: undefined }), /complete bounded study question/);
});
test('pending bounded observation preserves partial bytes and cancels nothing: the caller does, with the account', async () => {
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

/** A local control plane for the CLI: the product's own registration, deletion and module routes, as far as the driver meets them. */
async function controlPlane(t, { status = 'succeeded', deleteStatus = 200 } = {}) {
  const bytes = Buffer.from([37,80,68,70,45,49,0,255,10]); let requested = false; const calls = []; const bodies = {};
  const run = { id: 'cli-run', projectId: 'actual-project', effectiveAgentId: 'vcr-protocol', dispatchId: 'vcr-cli-actual-route',
    status, verification: status === 'succeeded' ? 'unverified' : undefined, qualityNotices: ['Synthetic preserved finding'], artifacts: ['deliverables/report.pdf'] };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push(`${req.method} ${req.url}`); if (raw) bodies[`${req.method} ${req.url}`] = JSON.parse(raw);
    const reply = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })); };
    if (req.url === '/api/health') return reply({ releaseId: 'candidate' });
    if (req.url === '/api/ready') return reply({ ok: true, checks: { release: { ok: true, releaseId: 'candidate', revision: revision.slice(0,12) } } });
    if (req.url === '/api/auth/register') { res.setHeader('set-cookie', 'synthetic-session=owned; HttpOnly'); return reply({ csrfToken: 'synthetic-csrf' }, 201); }
    if (req.url === '/api/account' && req.method === 'DELETE') {
      assert.equal(req.headers.cookie, 'synthetic-session=owned'); assert.equal(req.headers['x-open-science-csrf'], 'synthetic-csrf');
      if (deleteStatus !== 200) { res.writeHead(deleteStatus, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 'account_busy' })); }
      return reply(true);
    }
    assert.equal(req.headers.cookie, 'synthetic-session=owned', `${req.url} is sent in the account's session`);
    if (req.url === '/api/vcr/studies' && req.method === 'POST') return reply({ id: 'actual-study', projectId: 'actual-project' });
    if (req.url === '/api/vcr/studies/actual-study') return reply({ id: 'actual-study', projectId: 'actual-project', dataTier: 'T0' });
    assert.equal(req.headers['x-open-science-project'], 'actual-project');
    if (req.url === '/api/agent-runs') return reply(requested ? [run] : []);
    if (req.url === '/api/vcr/studies/actual-study/run') { requested = true; return reply({ runId: run.id }); }
    if (req.url === '/api/agent-runs/cli-run/cancel') return reply({ run: { ...run, status: 'canceled' } });
    if (req.url === '/api/files/download/deliverables/report.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(bytes); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, bodies, run, bytes };
}
async function cli(directory, base, extra = [], { out = path.join(directory, 'evidence') } = {}) {
  const manifestFile = path.join(directory, 'manifest.json'), studyFile = path.join(directory, 'study.json');
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(studyFile, JSON.stringify({ question: 'A bounded synthetic study question', dataTier: 'T0' }), { mode: 0o600 });
  const entry = fileURLToPath(new URL('../../../scripts/ops/vcr-serving-acceptance.mjs', import.meta.url));
  const args = [entry, '--base', base, '--candidate-manifest', manifestFile, '--expected-revision', revision, '--capability', 'vcr-protocol', '--study-input', studyFile, '--out', out, ...extra];
  try { return { code: 0, out, ...(await promisify(execFile)(process.execPath, args, { timeout: 15000, maxBuffer: 65536, env: { PATH: process.env.PATH } })) }; }
  catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, out, stdout: error.stdout, stderr: error.stderr }; }
}
test('actual CLI uses native HTTP fetch properties, preserves an unverified binary delivery with findings, and deletes its account', async t => {
  // Real local HTTP/CLI transport; response fixtures measure the driver, not hosted VCR qualification.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vcr-acceptance-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plane = await controlPlane(t);
  const result = await cli(directory, plane.base);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const evidence = JSON.parse(await readFile(path.join(result.out, 'observation.json'), 'utf8'));
  const summary = JSON.parse(result.stdout.split('\n').filter(line => line.startsWith('{')).at(-1));
  assert.equal(summary.usableDelivery, true); assert.equal(summary.verificationComplete, false); assert.equal(summary.acceptanceIndependent, true);
  assert.equal(evidence.qualified, false); assert.equal(evidence.run.verification, 'unverified'); assert.deepEqual(evidence.run.qualityNotices, plane.run.qualityNotices);
  assert.deepEqual(await readFile(path.join(result.out, 'deliverable/deliverables/report.pdf')), plane.bytes);
  assert.equal(plane.calls.filter(route => route.endsWith('/run')).length, 1);
  // The release is verified before any account exists, and the account is the last thing that goes.
  const order = ['GET /api/health', 'GET /api/ready', 'POST /api/auth/register', 'POST /api/vcr/studies', 'POST /api/vcr/studies/actual-study/run', 'DELETE /api/account'].map(call => plane.calls.indexOf(call));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), `order of calls: ${plane.calls.join(', ')}`);
  assert.equal(plane.calls.at(-1), 'DELETE /api/account');
  assert.equal(plane.calls.some(call => call.includes('/api/auth/login')), false, 'no sign-in as anyone');
  const registered = plane.bodies['POST /api/auth/register'], removed = plane.bodies['DELETE /api/account'];
  assert.match(registered.username, /^acc-\d{12}-[0-9a-f]{6}$/); assert.ok(registered.password.length >= 24);
  assert.deepEqual(removed, { confirm: registered.username, password: registered.password });
  assert.match(result.stdout, new RegExp(`account created: ${registered.username}`)); assert.match(result.stdout, new RegExp(`account deleted: ${registered.username}`));
  assert.equal(result.stdout.includes(registered.password) || result.stderr.includes(registered.password), false, 'the password is never printed');
});
test('a run still going when the observation ends is cancelled before its account is deleted, and the evidence stays', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vcr-acceptance-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plane = await controlPlane(t, { status: 'running' });
  const result = await cli(directory, plane.base, ['--timeout-ms', '300']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  assert.equal(JSON.parse(await readFile(path.join(result.out, 'observation.json'), 'utf8')).observation, 'pending');
  assert.ok(plane.calls.indexOf('POST /api/agent-runs/cli-run/cancel') > 0 && plane.calls.indexOf('POST /api/agent-runs/cli-run/cancel') < plane.calls.indexOf('DELETE /api/account'), plane.calls.join(', '));
});
test('an account that cannot be deleted is exit 4 and a FAIL line naming it, whatever the observation found', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vcr-acceptance-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plane = await controlPlane(t, { deleteStatus: 403 });
  const result = await cli(directory, plane.base);
  assert.equal(result.code, 4, result.stderr + result.stdout);
  const registered = plane.bodies['POST /api/auth/register'];
  assert.match(result.stdout, new RegExp(`FAIL account ${registered.username} was NOT deleted`));
  assert.equal(result.stdout.includes(registered.password) || result.stderr.includes(registered.password), false);
});
test('a wrong release creates no account', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vcr-acceptance-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plane = await controlPlane(t);
  const result = await cli(directory, plane.base, ['--expected-revision', 'f'.repeat(40)]);
  assert.equal(result.code, 2);
  assert.equal(plane.calls.some(call => call.includes('/api/auth/') || call.includes('/api/account')), false, plane.calls.join(', '));
});
test('actual CLI names a study that does not exist in a new account, and an output that holds an earlier observation, before any request', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vcr-acceptance-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plane = await controlPlane(t);
  const named = await cli(directory, plane.base, ['--study', 'actual-study']);
  assert.equal(named.code, 2); assert.match(named.stderr, /holds no study.*--study-input/);
  const out = path.join(directory, 'earlier'); await mkdir(out); await writeFile(path.join(out, 'observation.json'), '{}');
  const reused = await cli(directory, plane.base, [], { out });
  assert.equal(reused.code, 2); assert.match(reused.stderr, /already holds an observation of an account that has been deleted: use a new --out/);
  assert.deepEqual(plane.calls, [], 'nothing was asked of the deployment');
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
