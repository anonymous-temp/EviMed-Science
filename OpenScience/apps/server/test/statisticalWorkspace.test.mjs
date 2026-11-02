import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StatisticalWorkspaceService, isStatisticalWorkspaceProject } from '../src/statisticalWorkspaceService.mjs';
import { ResearchSessionStore } from '../src/researchSessions.mjs';
import { HttpError } from '../src/security.mjs';
import { isInternalProject } from '../src/internalProjects.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'statistical-workspace-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rows = new Map(), projects = new Map();
  const documents = {
    get: async (user, kind, id) => structuredClone(rows.get(`${user}:${kind}:${id}`) ?? null),
    put: async (user, kind, id, payload, options) => {
      const key = `${user}:${kind}:${id}`, old = rows.get(key);
      if ((old?.revision ?? 0) !== options.expectedRevision) throw new HttpError(409, 'product_revision_conflict', 'Conflict');
      const record = { id, revision: (old?.revision ?? 0) + 1, payload: structuredClone(payload) };
      rows.set(key, record); return structuredClone(record);
    },
  };
  const registry = { get: id => id === 'statistical-analysis' ? { id, version: '1.0.0', runtimeAgent: 'statistical-analysis' } : null };
  const deps = { documents, registry, sessions: new ResearchSessionStore(registry),
    store: { requireProject: async (user, id) => {
      const project = projects.get(`${user.id}:${id}`);
      if (!project) throw new HttpError(404, 'project_not_found', 'Missing');
      return project;
    } },
    createProject: async (user, body) => {
      const key = `${user.id}:${body.id}`;
      if (projects.has(key)) throw new HttpError(409, 'project_exists', 'Exists');
      const rootDir = path.join(directory, user.id, body.id), metaDir = path.join(rootDir, '.evimed');
      projects.set(key, { id: body.id, userId: user.id, rootDir, metaDir });
      await fs.mkdir(metaDir, { recursive: true });
    },
  };
  return { deps, rows, projects, user: { id: 'alice' }, service: new StatisticalWorkspaceService(deps) };
}

test('fresh card records one ordinary project and real specialist binding, survives restart and isolates owners', async t => {
  const f = await fixture(t), body = { requestId: 'open-1' };
  const created = await f.service.create(f.user, body);
  assert.match(created.projectId, /^stat-[a-f0-9]{40}$/);
  assert.equal(isInternalProject(created.projectId), false);
  const project = await f.deps.store.requireProject(f.user, created.projectId);
  const binding = await f.deps.sessions.get(project, created.sessionId);
  assert.equal(binding.agentId, 'statistical-analysis');
  assert.equal(binding.runtimeAgent, 'statistical-analysis');
  const restarted = new StatisticalWorkspaceService({ ...f.deps, sessions: new ResearchSessionStore(f.deps.registry) });
  assert.deepEqual(await restarted.create(f.user, body), created);
  await restarted.authorizeSession(project, created.sessionId);
  await assert.rejects(restarted.authorizeSession(project, 'another-root'), { code: 'statistical_workspace_session_reserved' });
  await assert.rejects(restarted.authorizeSession({ ...project, userId: 'bob' }, created.sessionId), { code: 'statistical_workspace_session_reserved' });
  assert.notEqual((await restarted.create({ id: 'bob' }, body)).projectId, created.projectId);
  assert.equal(f.projects.size, 2);
  await assert.rejects(restarted.create(f.user, { ...body, name: 'Changed' }), { code: 'analysis_request_conflict' });
});

test('binding failure and concurrent retries reuse the recorded root and never allocate a second project', async t => {
  const f = await fixture(t), real = f.deps.sessions;
  const failing = new StatisticalWorkspaceService({ ...f.deps, sessions: { put: async () => { throw new Error('Binding interrupted'); } } });
  await assert.rejects(failing.create(f.user, { requestId: 'retry' }), /interrupted/);
  const recorded = [...f.rows.values()][0].payload;
  const project = await f.deps.store.requireProject(f.user, recorded.projectId);
  await assert.rejects(f.service.authorizeSession(project, recorded.sessionId), { code: 'statistical_workspace_session_reserved' });
  const results = await Promise.all(Array.from({ length: 4 }, () => f.service.create(f.user, { requestId: 'retry' })));
  assert(results.every(item => item.sessionId === recorded.sessionId));
  assert.equal(f.projects.size, 1);
  assert.equal((await real.list(project)).length, 1);
});

test('only dedicated GUI projects are guarded and caller identity fields are closed', async t => {
  const f = await fixture(t);
  for (const project of [{ id: 'regular' }, { id: `da-${'a'.repeat(40)}` }]) await f.service.authorizeSession(project, 'other');
  assert.equal(isStatisticalWorkspaceProject(`stat-${'f'.repeat(40)}`), true);
  for (const body of [{ requestId: '../bad' }, { requestId: 'ok', sessionId: 'chosen' }, { requestId: 'ok', projectId: 'chosen' }]) {
    await assert.rejects(f.service.create(f.user, body), { code: 'analysis_payload_invalid' });
  }
});
