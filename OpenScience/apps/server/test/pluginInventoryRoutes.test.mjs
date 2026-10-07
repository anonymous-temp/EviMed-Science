import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { MCP_TOOL_BASE_NAMES } from '@evimed/domain';
import { HttpError } from '../src/security.mjs';
import { createPluginInventoryRoutes } from '../src/pluginInventoryRoutes.mjs';

function fixture(config = { runtimeAnnotationEnabled: true, runtimeMermaidEnabled: false }, engines = null) {
  const user = { id: 'owned-user', accountCreatedAt: 'captured-epoch' }, project = { id: 'owned-project', userId: user.id }, calls = [];
  const store = { ensureSessionUser: async (_req, _res, options) => { assert.equal(options.allowDevAuth, false); return { user }; }, assertCsrf: async () => calls.push('csrf'),
    requireProject: async (actual, id) => { assert.equal(actual, user); if (id !== project.id) throw new HttpError(404, 'project_not_found', 'missing'); return project; } };
  const pluginService = { list: async (actual, current) => { assert.equal(actual, user); assert.equal(current, project);
    return { plugins: [{ id: 'dsh-cite', binaryVersion: '9.9.9', desired: { enabled: true, revision: 0, settings: { timeoutMs: 15000 } }, effective: null, phase: 'pending', settingsSchema: {} }] }; } };
  return { store, pluginService, user, project, calls, handler: createPluginInventoryRoutes({ store, pluginService, config, engines }) };
}
async function request(f, url = '/api/projects/owned-project/plugin-inventory', method = 'GET') {
  const req = Readable.from([]); req.url = url; req.method = method; req.headers = {}; let data; const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; }, writeHead: status => { res.status = status; }, end: bytes => { data = JSON.parse(String(bytes)); } };
  const handled = await f.handler(req, res); return { handled, status: res.status, data, headers };
}

test('the inventory says what is on and nothing about versions, phases or a state it cannot know', async () => {
  const f = fixture(), result = await request(f);
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.data.data.projectId, f.project.id);
  assert.deepEqual(result.data.data.items, [
    { id: 'dsh-cite', management: 'project', enabled: true },
    { id: 'dsh-annotation', management: 'deployment', enabled: true },
    { id: 'dsh-mermaid', management: 'deployment', enabled: false },
  ]);
  const text = JSON.stringify(result.data);
  for (const word of ['version', 'observation', 'configurationPhase', 'unknown', '9.9.9', 'runtime-ready']) assert.equal(text.includes(word), false, `${word} is not sent`);
  assert.equal(f.calls.length, 1);
});

test('the research tool set arrives already grouped in Chinese, one sentence per tool, and counts every tool the server publishes', async () => {
  const { data } = (await request(fixture())).data;
  assert.equal(data.researchTools.count, MCP_TOOL_BASE_NAMES.length);
  assert.equal(data.researchTools.groups.reduce((sum, group) => sum + group.tools.length, 0), MCP_TOOL_BASE_NAMES.length);
  assert.ok(data.researchTools.groups.every((group) => /[㐀-鿿]/.test(group.title) && group.tools.every((tool) => /[㐀-鿿]/.test(tool))));
  assert.equal(JSON.stringify(data.researchTools).includes('literature_search'), false, 'no tool identifier reaches the page');
});

test('web reading is on offer unless the deployment turns it off', async () => {
  assert.equal((await request(fixture())).data.data.webRead, true);
  assert.equal((await request(fixture({ webReadEnabled: false }))).data.data.webRead, false);
});

test('the engines are one yes or no each; a reading that cannot be made draws no rows rather than a guess', async () => {
  const f = fixture({}, async user => { assert.equal(user.id, 'owned-user'); return [{ id: 'meta_analysis', available: true }, { id: 'peer_review', available: 'maybe' }]; });
  assert.deepEqual((await request(f)).data.data.engines, [{ id: 'meta_analysis', available: true }, { id: 'peer_review', available: false }]);
  const broken = fixture({}, async () => { throw new Error('probe down'); });
  assert.deepEqual((await request(broken)).data.data.engines, []);
  assert.deepEqual((await request(fixture())).data.data.engines, []);
});

test('a missing deployment switch stays unknown, and an optional citation 503 cannot hide the rest', async () => {
  const f = fixture({}); f.pluginService.list = async () => { throw new HttpError(503, 'product_state_unavailable', 'fixture'); };
  const { items } = (await request(f)).data.data;
  assert.equal(items[0].enabled, null); assert.equal(items[1].enabled, null); assert.equal(items[2].enabled, null);
});

test('authenticated captured actor/current project and closed read-only routes reject caller flags', async () => {
  const f = fixture(); await assert.rejects(request(f, '/api/projects/foreign/plugin-inventory'), { status: 404 }); await assert.rejects(request(f, '/api/projects/owned-project/plugin-inventory?enabled=true'), { status: 400 }); await assert.rejects(request(f, undefined, 'POST'), { status: 404 });
  f.store.ensureSessionUser = async () => { throw new HttpError(401, 'unauthorized', 'fixture'); }; await assert.rejects(request(f), { status: 401 });
});

test('citation authorization failures cannot become a successful inventory response', async () => { const f = fixture(); f.pluginService.list = async () => { throw new HttpError(404, 'project_not_found', 'retired project'); }; await assert.rejects(request(f), { status: 404 }); });

test('a verified citation configuration does not expose deployment secrets or the server\'s own error text', async () => {
  const f = fixture({ runtimeAnnotationEnabled: true, runtimeMermaidEnabled: true, providerKey: 'must-not-forward', runtimeToken: 'must-not-forward' });
  f.pluginService.list = async () => ({ plugins: [{ id: 'dsh-cite', phase: 'effective', desired: { enabled: false }, effective: { enabled: true }, error: '/private/must-not-forward' }] });
  const result = await request(f);
  assert.equal(result.data.data.items[0].enabled, false, 'the saved choice is what the switch shows');
  assert.equal(JSON.stringify(result.data).includes('must-not-forward'), false);
});
