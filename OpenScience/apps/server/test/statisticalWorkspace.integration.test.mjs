import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebApiApp } from '../src/server.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { StatisticalWorkspaceService } from '../src/statisticalWorkspaceService.mjs';
import { DataAnalysisService } from '../src/dataAnalysisService.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test('native statistical workspace HTTP auth, durable root admission, restart and ordinary quotas', { skip: !databaseUrl, timeout: 60000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statistical-native-'));
  const userId = `stat${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const config = { dataDir, stateStore: 'postgres', databaseUrl, runtimeMode: 'mock', authMode: 'local', devAuth: false,
    bootstrapUser: '', bootstrapPassword: '', frontierEnabled: false, maxProjectsPerUser: 2, runtimeWarmOnSignIn: false };
  let app = createWebApiApp(config);
  try {
    await app.store.createUser(userId, 'test-only-statistical-password', 'Statistical test');
    let address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: userId, password: 'test-only-statistical-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).data.csrfToken;
    const headers = { 'content-type': 'application/json', cookie, 'x-open-science-csrf': csrf };
    const post = (route, body, extra = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const request = { requestId: 'owned-analysis', name: 'One analysis' };
    const anonymous = await fetch(`${base}/api/statistical-workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(anonymous.status, 401);
    assert.equal((await post('/api/statistical-workspaces', request, { 'x-open-science-csrf': '' })).status, 403);
    const response = await post('/api/statistical-workspaces', request);
    const responseBody = await response.json();
    assert.equal(response.status, 201, JSON.stringify(responseBody));
    const created = responseBody.data;
    const concurrent = await Promise.all([post('/api/statistical-workspaces', request), post('/api/statistical-workspaces', request)]);
    for (const repeated of concurrent) { assert.equal(repeated.status, 201); assert.deepEqual((await repeated.json()).data, created); }
    const user = await app.store.userById(userId), project = await app.store.requireProject(user, created.projectId);
    const binding = await app.researchSessions.get(project, created.sessionId);
    assert.equal(binding.agentId, 'statistical-analysis');
    const documents = new ProductDocuments(app.store.database);
    const recordId = `gui_${created.projectId.slice(5)}`;
    const record = await documents.get(userId, 'data-analysis', recordId);
    assert.equal(record.payload.sessionId, created.sessionId);
    await assert.rejects(new DataAnalysisService({ documents, store: app.store }).record(user, recordId), { code: 'analysis_not_found' });
    assert.equal((await post('/api/projects', { id: `stat-${'f'.repeat(40)}`, name: 'Spoofed' })).status, 409);
    const quota = await post('/api/statistical-workspaces', { requestId: 'second-analysis' });
    assert.equal((await quota.json()).code, 'project_limit_reached');
    const listed = await fetch(`${base}/api/projects`, { headers });
    assert((await listed.json()).data.some(item => item.id === created.projectId));
    const refusedBinding = await fetch(`${base}/api/research-sessions/another-root`, { method: 'PUT',
      headers: { ...headers, 'x-open-science-project': project.id }, body: JSON.stringify({ mode: 'open-domain' }) });
    assert.equal(refusedBinding.status, 409);
    assert.equal(await app.researchSessions.get(project, 'another-root'), null);
    // Shared admission is reached even by internal/scheduled callers that bypass the public HTTP prompt route.
    await assert.rejects(app.agentRuns.reserveRun(project, { ...binding, sessionId: 'another-root' }, { automated: true }), { code: 'statistical_workspace_session_reserved' });
    const rejected = await post('/api/agent-runs/dispatch', { sessionId: 'another-root', dispatchId: 'another-dispatch', text: 'Analyze' }, { 'x-open-science-project': project.id });
    assert.equal(rejected.status, 409); assert.equal((await rejected.json()).code, 'statistical_workspace_session_reserved');
    // The original root still uses the unchanged ledger (including its native children within this run).
    const reserved = await app.agentRuns.reserveRun(project, binding, { baselineCursor: { messages: [] }, dispatchId: 'root-dispatch' });
    assert.equal(reserved.run.sessionId, binding.sessionId);
    await app.close();
    app = createWebApiApp(config);
    address = await app.listen(0, '127.0.0.1'); base = `http://127.0.0.1:${address.port}`;
    const recovered = await post('/api/statistical-workspaces', request);
    assert.equal(recovered.status, 201); assert.deepEqual((await recovered.json()).data, created);
    const restored = await app.store.requireProject(await app.store.userById(userId), created.projectId);
    await assert.rejects(app.agentRuns.reserveRun(restored, { ...binding, sessionId: 'second-after-restart' }), { code: 'statistical_workspace_session_reserved' });
    const admission = new StatisticalWorkspaceService({ documents: new ProductDocuments(app.store.database), store: app.store,
      registry: app.agentRegistry, sessions: app.researchSessions, createProject: async () => { throw new Error('Must not reallocate'); } });
    await admission.authorizeSession(restored, created.sessionId);
  } finally {
    await app.store.database.query('DELETE FROM evimed_control.users WHERE id=$1', [userId]);
    await app.close(); await fs.rm(dataDir, { recursive: true, force: true });
  }
});
