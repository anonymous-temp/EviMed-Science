import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { AgentRunStore } from '../src/agentRuns.mjs';
import { persistRunTranscript } from '../src/runTranscripts.mjs';
import { createResultProducerCapture } from '../src/resultProducerCapture.mjs';
import { ResultProvenanceService } from '../src/resultProvenanceService.mjs';
import { createGeoDeliveryImport } from '../src/geoDeliveryImport.mjs';
import { createGeoArtifactRefresh } from '../src/geoPreservedRunImport.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl && 'Disposable PostgreSQL required' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual ledger refresh and immutable PG results recover only the frozen native scope with no completion/capture side effects', options, async t => {
  const isolated = await createGeoTestDatabase(databaseUrl, 'geonativeimport');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-native-import-'));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', devAuth: true, geoEnabled: true, geoAudience: 'all' });
  const accounts = new PostgresStore(config);
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await accounts.devUser(), control = await accounts.requireProject(user, 'default');
  await accounts.createUser('editor', 'local-fixture-password', 'Editor');
  const store = new GeoStore({ database: accounts.database }); await store.ready();
  const geoProject = await store.createProject({ userId: user.id, projectId: control.id, engines: ['deepseek'], coverageDays: 90 });
  await store.addMember({ geoId: geoProject.id, userId: 'editor', role: 'editor', invitedBy: user.id });
  await store.query(`INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name,is_control) VALUES ('g1',$1,$2,1,'P2','Selected',false),('g2',$1,$2,1,'P2','Control',true)`, [user.id, geoProject.id]);
  const beforeGroups = (await store.query('SELECT * FROM evimed_geo.question_groups WHERE geo_project_id=$1 ORDER BY id', [geoProject.id])).rows;
  const beforeTargets = await store.latestTargets(geoProject.id);
  const basis = { schemaVersion: 1, groups: [{ id: 'g1', setVersion: 1 }], scope: { round: 'original-round', groupIds: ['g1'], engines: ['deepseek'] },
    sources: [{ id: 'original-source', url: 'https://original.example.invalid/g1', availability: 'unknown' }], focus: { sourceId: 'original-source', url: 'https://original.example.invalid/g1' } };
  const documents = new ProductDocuments(accounts.database), service = new GeoService({ store, config });
  const contexts = new GeoPlanContext({ documents, store, service, authorizeSession: async () => {}, runs: async () => [] });
  const context = { recordType: 'geo-plan-context', state: 'bound', mode: 'strategy', geoId: geoProject.id, actorId: 'editor', sessionId: 'native-session', requestId: 'actual-request', scopeKey: 'original-scope', basis };
  await documents.put(user.id, 'geo-plan-context', `gpc_${'a'.repeat(64)}`, context, { projectId: control.id, expectedRevision: 0 });
  const end = new Date(), start = new Date(end.getTime() - 10000);
  const runs = new AgentRunStore({}, { model: 'test-model', now: () => end, id: () => 'native-run' });
  const reserved = await runs.reserveRun(control, { mode: 'open-domain', sessionId: 'native-session', agentId: null, agentVersion: null, runtimeAgent: null }, {
    startedAt: start.toISOString(), nativeTurn: { startSeq: 1, userSeq: 2 }, kernelRequestIds: ['actual-request'],
    effectiveAgentId: 'geo-strategy', effectiveAgentVersion: '1', effectiveRuntimeAgent: 'evimed-geo-strategy' });
  const relative = 'deliverables/native/strategy.json';
  const original = JSON.stringify({ summary: 'Original captured strategy', gaps: [{ gapId: 'g1-gap', class: 'benefit_only', groupId: 'g1', text: 'Selected only' }] });
  const put = async bytes => { await mkdir(path.dirname(path.join(control.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(control.workspaceDir, relative), bytes); await utimes(path.join(control.workspaceDir, relative), start, start); };
  await put(original);
  const finished = await runs.finishInternal(control, reserved.run.id, { status: 'succeeded', artifacts: [relative], presentedFiles: [relative], verification: 'unverified', qualityNotices: ['Preserved notice'] });
  const transcript = { messages: [
    { seq: 2, role: 'user', source: 'user', sourceRequestId: 'actual-request', turnStartSeq: 1, time: start.getTime(), parts: [] },
    { seq: 4, role: 'tool', source: 'system', turnStartSeq: 1, time: start.getTime() + 10, parts: [{ type: 'tool', tool: 'edit', status: 'completed', callId: 'actual-edit', completedSeq: 5, completedAt: start.getTime() + 20, input: { file_path: `/workspace/${relative}` }, output: 'Edited' }] },
    { seq: 6, role: 'tool', source: 'system', turnStartSeq: 1, time: start.getTime() + 30, parts: [{ type: 'tool', tool: 'present', status: 'completed', callId: 'present', completedSeq: 7, input: { files: [relative] }, output: 'Presented' }] },
  ], exhausted: true, lastSeq: 8 };
  const receipt = await persistRunTranscript({ project: control, run: finished, sessions: [{ sessionId: finished.sessionId, parentSessionId: null, label: 'root', capability: null, transcript, error: null }] });
  await runs.recordLearning(control, finished.id, { transcript: receipt });
  const historical = (await runs.list(control))[0];
  assert.equal(historical.outputFiles, undefined); assert.deepEqual(historical.deliverables ?? [], []);
  const results = new ResultProvenanceService({ documents, config, authorizeProject: async (owner, id) => accounts.requireProject(await accounts.userById(owner), id) });
  await put('{"summary":"Foreign or unreceipted bytes"}');
  for (const producer of [
    { kind: 'tool', runId: 'other-run', sessionId: historical.sessionId, callId: 'actual-edit', eventId: '5' },
    { kind: 'tool', runId: historical.id, sessionId: 'other-session', callId: 'actual-edit', eventId: '5' },
    { kind: 'workspace', runId: historical.id, sessionId: historical.sessionId, eventId: '5' },
    { kind: 'deliverable', runId: historical.id, sessionId: historical.sessionId, eventId: 'native' },
  ]) await results.captureFile({ userId: user.id, project: control, relativePath: relative, producer });
  const sideEffects = [];
  runs.onRunFinished = async () => sideEffects.push('completion'); runs.onRunLearning = async () => sideEffects.push('learning');
  const make = () => {
    const importDelivery = createGeoDeliveryImport({ store, planningContext: (project, run) => contexts.forRun(project, run),
      beforeImport: async () => sideEffects.push('capture'), readFile: async () => { throw new Error('No workspace reads'); } });
    return createGeoArtifactRefresh({ runs, results, contexts, geo: { store, importDelivery } });
  };
  const recover = make();
  const first = await recover(control, historical.id, { expectedTranscriptSha256: receipt.sha256 });
  assert.ok(first.geoImport.failed.includes('geo_plan_output_unavailable'));
  const firstInventory = await readFile(path.join(control.metaDir, 'runs.jsonl'), 'utf8');
  const noChange = await recover(control, historical.id, { expectedTranscriptSha256: receipt.sha256 });
  assert.ok(noChange.geoImport.failed.includes('geo_plan_output_unavailable'));
  assert.equal(await readFile(path.join(control.metaDir, 'runs.jsonl'), 'utf8'), firstInventory);
  await put(original);
  // The original owned producer resolves a container path against its trusted runtime root; recovery later has no live runtime.
  const originalCapture = createResultProducerCapture({ service: results, runtimeWorkspaceRoot: () => '/workspace' });
  await originalCapture.observe(control, historical.id, { sessionId: historical.sessionId, event: { type: 'tool/call', seq: 4, tool: 'edit', callId: 'actual-edit', input: { file_path: `/workspace/${relative}` } } });
  const captured = await originalCapture.observe(control, historical.id, { sessionId: historical.sessionId, event: { type: 'tool/result', seq: 5, callId: 'actual-edit', status: 'completed' } });
  await originalCapture.observe(control, historical.id, { sessionId: historical.sessionId, event: { type: 'tool/call', seq: 8, tool: 'edit', callId: 'foreign-edit', input: { file_path: `/foreign/${relative}` } } });
  assert.equal(await originalCapture.observe(control, historical.id, { sessionId: historical.sessionId, event: { type: 'tool/result', seq: 9, callId: 'foreign-edit', status: 'completed' } }), null);

  assert.equal(captured.coverage.producer, 'observed'); assert.equal(captured.digest, sha(original));
  await put('{"summary":"Mutable later bytes"}');
  const realCapture = results.captureFile.bind(results); results.captureFile = async (...args) => { sideEffects.push('capture'); return realCapture(...args); };
  await Promise.all([recover(control, historical.id, { expectedTranscriptSha256: receipt.sha256 }), recover(control, historical.id, { expectedTranscriptSha256: receipt.sha256 })]);
  await make()(control, historical.id, { expectedTranscriptSha256: receipt.sha256 });
  const stored = await store.latestStrategy(geoProject.id, { scopeKey: context.scopeKey });
  assert.deepEqual([stored.runId, stored.summary, stored.gaps[0].groupId], [historical.id, 'Original captured strategy', 'g1']); assert.deepEqual(stored.basis, basis);
  assert.equal((await store.query('SELECT count(*)::int AS n FROM evimed_geo.strategy WHERE geo_project_id=$1', [geoProject.id])).rows[0].n, 1);
  assert.deepEqual((await store.query('SELECT * FROM evimed_geo.question_groups WHERE geo_project_id=$1 ORDER BY id', [geoProject.id])).rows, beforeGroups);
  assert.deepEqual(await store.latestTargets(geoProject.id), beforeTargets);
  const current = (await runs.list(control))[0];
  for (const field of ['status', 'finishedAt', 'verification', 'qualityNotices', 'usage', 'attempts']) assert.deepEqual(current[field], historical[field], field);
  assert.deepEqual(sideEffects, []);
  await assert.rejects(recover(control, historical.id, { expectedTranscriptSha256: '0'.repeat(64) }), { code: 'run_transcript_changed' });
  await documents.put(user.id, 'geo-plan-context', `gpc_${'b'.repeat(64)}`, context, { projectId: control.id, expectedRevision: 0 });
  await assert.rejects(recover(control, historical.id, { expectedTranscriptSha256: receipt.sha256 }), { code: 'geo_plan_context_ambiguous' });
  await documents.remove(user.id, 'geo-plan-context', `gpc_${'b'.repeat(64)}`, 1);
  await store.removeMember({ geoId: geoProject.id, userId: 'editor', role: 'editor' });
  await assert.rejects(recover(control, historical.id, { expectedTranscriptSha256: receipt.sha256 }), error => [403, 404].includes(error.status));
  assert.deepEqual(sideEffects, []);
});
