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

test('content pins both manifest and the actual handed article in its deliverable folder', async () => {
  const article = 'deliverables/native/articles/a.md';
  const produced = { ...run, artifacts: [relative.replace('strategy.json', 'articles.json'), article] };
  const f = fixture(), bytes = Buffer.from('# Original');
  const version = { ...f.version, path: article, versionId: 'article', digest: digest(bytes) };
  f.versions.splice(0, 1, version); f.results.raw = async () => ({ bytes });
  const t = transcript(); t.messages[1].parts[0].input.file_path = `/workspace/${article}`;
  const pinned = await pinGeoRunOutputs({ results: f.results, project, run: produced, context: { mode: 'content' }, transcript: t });
  assert.equal(String(await pinned.readFile(project, produced, article)), String(bytes));
});

test('SPEC-3: bound signal review pins only handed canonical geo-value bytes of its actual supported capability', async () => {
  const relative = 'deliverables/native/geo-value.json', f = fixture();
  const reviewRun = { ...run, effectiveAgentId: 'geo-insight', artifacts: [relative], deliverables: [{ id: 'native', capability: 'geo-insight' }] };
  f.versions[0] = { ...f.version, path: relative };
  const t = transcript(); t.messages[1].parts[0].input.file_path = `/workspace/${relative}`;
  const pinned = await pinGeoRunOutputs({ project, run: reviewRun, context: { mode: 'signal' }, transcript: t, results: f.results });
  assert.equal(String(await pinned.readFile(project, reviewRun, relative)), String(f.bytes));
  for (const unqualified of [{ ...reviewRun, effectiveAgentId: 'open-domain-answer', deliverables: [] }, { ...reviewRun, artifacts: [] }]) {
    const refused = await pinGeoRunOutputs({ project, run: unqualified, context: { mode: 'signal' }, transcript: t, results: f.results });
    await assert.rejects(refused.readFile(project, unqualified, relative), { code: 'geo_plan_output_unavailable' });
  }
  const analysis = await pinGeoRunOutputs({ project, run: reviewRun, context: { mode: 'analysis' }, transcript: t, results: f.results });
  await assert.rejects(analysis.readFile(project, reviewRun, relative), { code: 'geo_plan_output_unavailable' });
});

test('QUALITY-Q1: historical Docker witnesses reuse only their exact original capture path association without a live runtime', async () => {
  const f = fixture(), host = { ...project, workspaceDir: '/owned/project/workspace' };
  const frozen = transcript('write', String(f.bytes));
  const pinned = await pinGeoRunOutputs({ results: f.results, project: host, run, context, transcript: frozen });
  assert.equal(String(await pinned.readFile(host, run, relative)), String(f.bytes));
  for (const patch of [{ path: 'deliverables/foreign/strategy.json' }, { producer: { ...f.version.producer, callId: 'foreign' } },
    { producer: { ...f.version.producer, eventId: '6' } }, { producer: { ...f.version.producer, kind: 'workspace' } },
    { producer: { ...f.version.producer, kind: 'deliverable', eventId: 'native' } }, { producer: { ...f.version.producer, runId: 'foreign' } },
    { producer: { ...f.version.producer, sessionId: 'foreign' } }]) {
    const version = { ...f.version, ...patch };
    const refused = await pinGeoRunOutputs({ results: { ...f.results, list: async () => ({ items: [version], nextCursor: null }) }, project: host, run, context, transcript: frozen });
    await assert.rejects(refused.readFile(host, run, relative), { code: 'geo_plan_output_unavailable' });
  }
  const wrongPath = structuredClone(frozen); wrongPath.messages[1].parts[0].input.file_path = '/workspace/deliverables/foreign/strategy.json';
  const other = await pinGeoRunOutputs({ results: f.results, project: host, run, context, transcript: wrongPath });
  await assert.rejects(other.readFile(host, run, relative), { code: 'geo_plan_output_unavailable' });
  await assert.rejects(pinned.readFile(host, run, 'deliverables/foreign/strategy.json'), { code: 'geo_plan_output_unavailable' });
  const later = structuredClone(frozen);
  later.messages.push({ ...later.messages[1], seq: 7, parts: [{ ...later.messages[1].parts[0], tool: 'edit', callId: 'later-without-snapshot', completedSeq: 8 }] });
  const missingFinal = await pinGeoRunOutputs({ results: f.results, project: host, run, context, transcript: later });
  await assert.rejects(missingFinal.readFile(host, run, relative), { code: 'geo_plan_output_unavailable' }, 'An older original mapping cannot hide the final genuine event without a snapshot');
});
