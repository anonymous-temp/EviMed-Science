import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
test('unverified terminal deliverable is preserved without claiming acceptance', async () => {
  const f = fixture({ verification: 'unverified' }); const report = await observeVcrRun(f.options);
  assert.equal(report.deliveryObserved, true); assert.equal(report.accepted, false); assert.equal(f.artifacts.length, 1);
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
