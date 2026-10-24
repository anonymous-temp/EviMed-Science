import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { pinGeoRunOutputs, createGeoArtifactRefresh } from '../src/geoPreservedRunImport.mjs';
const relative = 'deliverables/native/strategy.json';
const project = { userId: 'owner', id: 'project', workspaceDir: '/workspace' };
const run = { id: 'run', sessionId: 'session', kernelRequestIds: ['request'], startedAt: '2026-10-24T00:00:00Z', finishedAt: '2026-10-24T00:01:00Z', status: 'succeeded', artifacts: [relative], transcript: { sha256: 'a'.repeat(64) } };
const context = { mode: 'strategy', runId: run.id };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function transcript(tool = 'edit', content = null) { return { header: { runId: run.id, sessions: [{ sessionId: 'session', parentSessionId: null }] }, messages: [
  { sessionId: 'session', seq: 1, time: Date.parse(run.startedAt), role: 'user', source: 'user', sourceRequestId: 'request', turnStartSeq: 1, parts: [] },
  { sessionId: 'session', seq: 4, time: Date.parse(run.startedAt) + 100, turnStartSeq: 1, parts: [{ type: 'tool', tool, status: 'completed', callId: 'call-final', completedSeq: 5, input: { file_path: `/workspace/${relative}`, ...(content === null ? {} : { content }) } }] },
] }; }
function fixture(extra = []) {
  const bytes = Buffer.from('{"summary":"Original"}');
  const version = { versionId: 'original', path: relative, digest: digest(bytes), producer: { runId: run.id, sessionId: run.sessionId, kind: 'tool', eventId: '5', callId: 'call-final' }, coverage: { producer: 'observed', snapshot: 'complete' } };
  const versions = [version, ...extra];
  const results = { list: async (owner, scope) => { assert.equal(owner, 'owner'); assert.equal(scope.projectId, 'project'); assert.equal(scope.runId, 'run'); return { items: versions, nextCursor: null }; },
    raw: async (owner, projectId, id) => { assert.equal(owner, 'owner'); assert.equal(projectId, 'project'); assert.equal(id, 'original'); return { bytes }; } };
  return { results, versions, version, bytes };
}
test('pins final genuine native event before inventory changes; rejects workspace, other run/session and later unreceipted captures', async () => {
  const f = fixture();
  for (const producer of [{ ...f.version.producer, kind: 'workspace' }, { ...f.version.producer, runId: 'foreign' }, { ...f.version.producer, sessionId: 'foreign' }, { kind: 'deliverable', eventId: 'native', sessionId: 'session', runId: 'run' }]) f.versions.push({ ...f.version, versionId: 'later', digest: 'b'.repeat(64), capturedAt: '2099', producer });
  f.versions.push({ ...f.version, versionId: 'old-event', digest: 'c'.repeat(64), producer: { ...f.version.producer, eventId: '2', callId: 'call-old' } });
  const t = transcript();
  t.messages.splice(1, 0, { ...t.messages[1], seq: 2, parts: [{ ...t.messages[1].parts[0], callId: 'call-old', completedSeq: 2 }] });
  const pinned = await pinGeoRunOutputs({ results: f.results, project, run, context, transcript: t });
  f.versions.length = 0;
  assert.equal(String(await pinned.readFile(project, run, relative)), String(f.bytes));
  await assert.rejects(pinned.readFile({ ...project, userId: 'foreign' }, run, relative), { code: 'geo_plan_output_unavailable' });
});
test('same genuine event conflicting digests are unavailable; a write digest resolves only matching bytes', async () => {
  const f = fixture(); f.versions.push({ ...f.version, versionId: 'conflict', digest: 'b'.repeat(64) });
  const ambiguous = await pinGeoRunOutputs({ results: f.results, project, run, context, transcript: transcript() });
  await assert.rejects(ambiguous.readFile(project, run, relative), { code: 'geo_plan_output_ambiguous' });
  const bound = await pinGeoRunOutputs({ results: f.results, project, run, context, transcript: transcript('write', String(f.bytes)) });
  assert.equal(String(await bound.readFile(project, run, relative)), String(f.bytes));
});
test('a missing final event never falls back to older writes or an unreceipted presentation', async () => {
  const f = fixture(); f.versions[0] = { ...f.version, producer: { ...f.version.producer, eventId: '2', callId: 'old' } };
  const pinned = await pinGeoRunOutputs({ results: f.results, project, run, context, transcript: transcript() });
  await assert.rejects(pinned.readFile(project, run, relative), { code: 'geo_plan_output_unavailable' });
});
test('targeted refresh verifies and pins original row before no-change inventory refresh and invokes only scoped import', async () => {
  const f = fixture(), calls = [];
  const original = structuredClone(run);
  const geo = { store: { projectByControlProject: async () => ({ id: 'geo' }) }, importDelivery: async (p, r, options) => {
    calls.push('import'); assert.deepEqual(r, original); assert.equal(options.recovery, true); assert.equal(String(await options.readRunFile(p, r, relative)), String(f.bytes)); return { files: { strategies: 1 } } } };
  const recover = createGeoArtifactRefresh({ runs: { list: async () => [original], refreshArtifacts: async () => { calls.push('refresh'); f.versions.push({ ...f.version, versionId: 'late', digest: 'b'.repeat(64) }); return original; } },
    results: f.results, geo, contexts: { forRun: async () => { calls.push('context'); return context; } },
    readTranscript: async (_p, _r, expected) => { assert.equal(expected, 'a'.repeat(64)); calls.push('transcript'); return transcript(); } });
  const result = await recover(project, run.id, { expectedTranscriptSha256: 'a'.repeat(64) });
  assert.deepEqual(calls, ['transcript', 'context', 'refresh', 'import']); assert.equal(result.geoImport.files.strategies, 1);
  assert.deepEqual(run, original);
});
test('invalid transcript, running row, foreign row, revoked actor and ambiguous context fail before refresh/import', async () => {
  for (const failure of ['transcript', 'running', 'owner', 'actor', 'ambiguous']) {
    let imported = 0, refreshed = 0;
    const selected = failure === 'running' ? { ...run, status: 'running' } : failure === 'owner' ? null : run;
    const recover = createGeoArtifactRefresh({ runs: { list: async () => selected ? [selected] : [], refreshArtifacts: async () => { refreshed++; } }, results: fixture().results,
      geo: { store: { projectByControlProject: async () => ({ id: 'geo' }) }, importDelivery: async () => { imported++; } },
      contexts: { forRun: async () => { if (failure === 'actor' || failure === 'ambiguous') throw Object.assign(new Error(failure), { code: failure }); return context; } },
      readTranscript: async () => { if (failure === 'transcript') throw Object.assign(new Error(failure), { code: failure }); return transcript(); } });
    await assert.rejects(recover(project, run.id, { expectedTranscriptSha256: 'a'.repeat(64) }));
    assert.equal(imported, 0); assert.equal(refreshed, 0);
  }
});
