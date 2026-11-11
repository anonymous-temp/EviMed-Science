import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCell } from '../../../general-tasks/runner/cell.mjs';

test('seed preparation uses the task project and is excluded from its first provider request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eg-seed-scope-'));
  const requests = [], routes = [];
  const writeRequest = async (seq, model) => {
    requests.push({ at: new Date().toISOString(), seq, model, first: true, tools: 1, toolNames: ['memory'] });
    await fs.mkdir(`${root}/first-requests`, { recursive: true });
    await fs.writeFile(`${root}/first-requests/${String(seq).padStart(4, '0')}.json`, JSON.stringify({ system: model }));
    await fs.writeFile(`${root}/model-requests.jsonl`, requests.map(r => JSON.stringify(r)).join('\n'));
  };
  const api = { async call(_method, route) {
    routes.push(route);
    if (route.startsWith('/api/sources/outputs')) await writeRequest(2, 'task');
    return { status: 200, json: { data: [] } };
  } };
  try {
    const record = await runCell({ api, account: { userId: 'seed-test', username: 'seed-test' },
      spec: { id: 'G01', family: 'general', turns: [], inputs: [] }, fixtureRoot: root, dataDir: root, outDir: `${root}/out`,
      timeoutMs: 1, log: () => {}, beforeTask: async ({ projectId, projectDir }) => {
        assert.equal(api.project, projectId);
        assert.ok((await fs.stat(`${projectDir}/workspace`)).isDirectory());
        assert.deepEqual(routes, ['/api/projects']);
        await writeRequest(1, 'seed');
        await new Promise(resolve => setTimeout(resolve, 5));
        return { seedProjectId: projectId };
      } });
    assert.equal(record.preparation.seedProjectId, record.projectId);
    assert.equal(record.firstRequest.model, 'task');
    assert.equal(record.firstRequest.requests, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
