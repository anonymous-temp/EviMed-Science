import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { MCP_TOOL_BASE_NAMES } from '@evimed/domain';
import { RUNTIME_INVENTORY_WORDS } from '@evimed/domain/runtime-inventory';
import { HttpError } from '../src/security.mjs';
import { createInventoryRoutes } from '../src/inventoryRoutes.mjs';

/** A deployment with the public-source gateway addressed, so a tool is declined only for the reason a test names. */
const DEPLOYED = {
  publicSourceGatewayInternalUrl: 'http://127.0.0.1:8787/internal/sources/v1/fetch',
  modelGatewayInternalUrl: 'http://127.0.0.1:8787/internal/model/v1',
  modelGatewaySigningSecret: 'model-gateway-signing-secret-with-at-least-32-bytes',
  operatorUsers: [], frontierPreviewUsers: [], geoPreviewUsers: [], vcrPreviewUsers: [],
  runtimeAnnotationEnabled: true, runtimeMermaidEnabled: true, loopxEnabled: true, memoryEnabled: true,
};

function fixture(config = DEPLOYED) {
  const user = { id: 'owned-user', accountCreatedAt: 'captured-epoch' }, project = { id: 'owned-project', userId: user.id }, calls = [];
  const store = { ensureSessionUser: async (_req, _res, options) => { assert.equal(options.allowDevAuth, false); return { user }; }, assertCsrf: async () => calls.push('csrf'),
    requireProject: async (actual, id) => { assert.equal(actual, user); if (id !== project.id) throw new HttpError(404, 'project_not_found', 'missing'); return project; } };
  const pluginService = { list: async (actual, current) => { assert.equal(actual, user); assert.equal(current, project);
    return { plugins: [{ id: 'dsh-cite', binaryVersion: '9.9.9', desired: { enabled: true, revision: 0, settings: { timeoutMs: 15000 } }, effective: null, phase: 'pending', settingsSchema: {} }] }; } };
  return { store, pluginService, user, project, calls, handler: createInventoryRoutes({ store, pluginService, config }) };
}
async function request(f, url = '/api/projects/owned-project/inventory', method = 'GET') {
  const req = Readable.from([]); req.url = url; req.method = method; req.headers = {}; let data; const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; }, writeHead: status => { res.status = status; }, end: bytes => { data = JSON.parse(String(bytes)); } };
  const handled = await f.handler(req, res); return { handled, status: res.status, data, headers };
}
const items = result => result.data.data.groups.flatMap(group => group.items);

test('the inventory is the vocabulary\'s items for this project, each with its words, and nothing about versions, phases or a state a person cannot change', async () => {
  const f = fixture(), result = await request(f);
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.data.data.projectId, f.project.id);
  assert.deepEqual(result.data.data.groups.map(group => group.id), ['conversation']);
  assert.deepEqual(items(result).map(item => item.id), ['loopx', 'memory', 'citations', 'annotation', 'diagrams', 'web', 'basics', 'research-tools']);
  const loopx = items(result).find(item => item.id === 'loopx');
  assert.equal(loopx.title, '长任务');
  assert.equal(loopx.use, RUNTIME_INVENTORY_WORDS.items.loopx.use, 'the words are the vocabulary\'s, not the server\'s');
  assert.match(loopx.does, /消耗灵豆，可随时暂停/);
  const text = JSON.stringify(result.data);
  for (const word of ['9.9.9', 'binaryVersion', 'observation', 'configurationPhase', 'runtime-ready', 'engines', '始终开启', '计算引擎']) assert.equal(text.includes(word), false, `${word} is not sent`);
  assert.equal(f.calls.length, 1);
});

test('the citation check says what the project holds; every other row is on, because a person can change nothing else', async () => {
  const f = fixture(); const on = items(await request(f));
  assert.deepEqual(on.map(item => [item.id, item.state]), [
    ['loopx', 'on'], ['memory', 'on'], ['citations', 'on'], ['annotation', 'on'], ['diagrams', 'on'], ['web', 'on'], ['basics', 'on'], ['research-tools', 'on'],
  ]);
  assert.deepEqual(on.find(item => item.id === 'citations').control, { kind: 'switch', setting: 'dsh-cite' });
  assert.deepEqual(on.find(item => item.id === 'memory').opens, { kind: 'page', to: '/app/memory' });
  f.pluginService.list = async () => ({ plugins: [{ id: 'dsh-cite', phase: 'effective', desired: { enabled: false }, effective: { enabled: true } }] });
  assert.equal(items(await request(f)).find(item => item.id === 'citations').state, 'off', 'the saved choice is what the switch shows');
});

test('what the deployment switched off is not a row, and web reading follows the tool the account is given', async () => {
  const off = fixture({ ...DEPLOYED, loopxEnabled: false, runtimeAnnotationEnabled: false, runtimeMermaidEnabled: false, memoryEnabled: false, webReadEnabled: false });
  assert.deepEqual(items(await request(off)).map(item => item.id), ['citations', 'basics', 'research-tools']);
  // A switch the deployment did not state is not an off.
  const unstated = fixture({ publicSourceGatewayInternalUrl: DEPLOYED.publicSourceGatewayInternalUrl });
  assert.deepEqual(items(await request(unstated)).map(item => item.id), ['loopx', 'memory', 'citations', 'annotation', 'diagrams', 'web', 'basics', 'research-tools']);
});

test('the research tool set arrives grouped in Chinese, one sentence per tool, without the tools this account\'s runtime is not given', async () => {
  const all = (await request(fixture({ ...DEPLOYED, geoEnabled: true, geoAudience: 'all', vcrEnabled: true, vcrAudience: 'all', vcrEngineConfigured: true }))).data.data.researchTools;
  const closed = (await request(fixture(DEPLOYED))).data.data.researchTools;
  assert.equal(all.groups.reduce((sum, group) => sum + group.tools.length, 0), all.count);
  assert.ok(all.count <= MCP_TOOL_BASE_NAMES.length);
  assert.ok(all.groups.every(group => /[㐀-鿿]/.test(group.title) && group.tools.every(tool => /[㐀-鿿]/.test(tool))));
  assert.equal(JSON.stringify(all).includes('literature_search'), false, 'no tool identifier reaches the page');
  assert.ok(all.groups.some(group => group.title === '循证 GEO'), 'a module the account has is a group');
  assert.ok(all.groups.some(group => group.title === '虚拟临床研究'));
  assert.equal(closed.groups.some(group => group.title === '循证 GEO'), false, 'a module the deployment has off is not');
  assert.equal(closed.groups.some(group => group.title === '虚拟临床研究'), false);
  assert.ok(closed.count < all.count);
});

test('a citation authorization failure cannot become a successful inventory, and an optional citation 503 cannot hide the rest', async () => {
  const f = fixture(); f.pluginService.list = async () => { throw new HttpError(404, 'project_not_found', 'retired project'); };
  await assert.rejects(request(f), { status: 404 });
  const soft = fixture(); soft.pluginService.list = async () => { throw new HttpError(503, 'product_state_unavailable', 'fixture'); };
  const rows = items(await request(soft));
  assert.equal(rows.find(item => item.id === 'citations').state, 'off', 'nothing known: the switch is off, the page still draws');
  assert.ok(rows.length >= 7);
});

test('authenticated captured actor/current project and closed read-only routes reject caller flags', async () => {
  const f = fixture();
  await assert.rejects(request(f, '/api/projects/foreign/inventory'), { status: 404 });
  await assert.rejects(request(f, '/api/projects/owned-project/inventory?enabled=true'), { status: 400 });
  await assert.rejects(request(f, undefined, 'POST'), { status: 404 });
  assert.equal((await request(f, '/api/projects/owned-project/something-else')).handled, false);
  f.store.ensureSessionUser = async () => { throw new HttpError(401, 'unauthorized', 'fixture'); };
  await assert.rejects(request(f), { status: 401 });
});

test('the old path answers the same payload with the old fields beside it, for the tab that was opened before the release', async () => {
  const old = (await request(fixture(), '/api/projects/owned-project/plugin-inventory')).data.data;
  const next = (await request(fixture())).data.data;
  assert.deepEqual(old.groups, next.groups);
  assert.deepEqual(old.researchTools, next.researchTools);
  assert.deepEqual(old.items, [
    { id: 'dsh-cite', management: 'project', enabled: true },
    { id: 'dsh-annotation', management: 'deployment', enabled: true },
    { id: 'dsh-mermaid', management: 'deployment', enabled: true },
  ]);
  assert.equal(old.webRead, true);
  assert.deepEqual(old.engines, [], 'no engine rows: the old page then draws none');
  assert.equal(Object.hasOwn(next, 'items'), false, 'the new path carries none of the old fields');
});

test('a verified citation configuration does not expose deployment secrets or the server\'s own error text', async () => {
  const f = fixture({ ...DEPLOYED, providerKey: 'must-not-forward', runtimeToken: 'must-not-forward' });
  f.pluginService.list = async () => ({ plugins: [{ id: 'dsh-cite', phase: 'effective', desired: { enabled: false }, effective: { enabled: true }, error: '/private/must-not-forward' }] });
  const result = await request(f);
  assert.equal(JSON.stringify(result.data).includes('must-not-forward'), false);
});
