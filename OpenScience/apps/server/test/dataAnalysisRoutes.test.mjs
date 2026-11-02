import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDataAnalysisRoutes, DATA_ANALYSIS_PATH } from '../src/dataAnalysisRoutes.mjs';
import { dataAnalysisOpenApi } from '../src/dataAnalysisOpenApi.mjs';
import { HttpError, sendJson, sendError } from '../src/security.mjs';
import { dataAnalysisMetricFamilies, resetDataAnalysisMetrics } from '../src/dataAnalysisMetrics.mjs';

async function fixture(t, options = {}) {
  const calls = [];
  const config = { dataAnalysisApiEnabled: true, maxJsonBytes: 2048, dataAnalysisMaxInputBytes: 16, ...options.config };
  const identity = { userId: 'account-a', keyId: 'key-a', projectId: null, scopes: ['analysis.read', 'analysis.write'], ...options.identity };
  const service = {
    async create(user, body) { calls.push(['create', user.id, body]); return { id: 'analysis-a', projectId: 'project-a' }; },
    async get(user, id) { if (id === 'foreign') throw new HttpError(404, 'analysis_not_found', 'Analysis not found.'); return { id, projectId: 'project-a' }; },
    async rawInput(user, id, filename, buffer) { calls.push(['raw', user.id, id, filename, buffer.toString('hex')]); return { id: 'input-a', bytes: buffer.length }; },
    async input(user, id, body) { calls.push(['input', user.id, id, body]); return { id: 'input-a' }; },
    async turn(user, id, body) { calls.push(['turn', user.id, id, body]); return { id: 'turn-a', status: 'running' }; },
    async result(user, id, turnId) { calls.push(['result', user.id, id, turnId]); return { id: turnId, status: 'succeeded' }; },
    async cancel(user, id, turnId) { calls.push(['cancel', user.id, id, turnId]); return { id: turnId, status: 'cancelled' }; },
    async artifact(user, id, artifactId) { calls.push(['artifact', user.id, id, artifactId]); return { artifact: { filename: 'figure.svg', sha256: 'a'.repeat(64) }, buffer: Buffer.from('<svg/>') }; },
    async remove(user, id, keyProjectId) { calls.push(['remove', user.id, id, keyProjectId]); return { id, deleted: true }; },
    ...options.service,
  };
  const tokens = options.tokens ?? { evk_test: { userId: identity.userId, keyId: identity.keyId } };
  const routes = createDataAnalysisRoutes({ config, service,
    apiKeys: { async resolve(token) { if (!tokens[token]) throw new HttpError(401, 'agent_key_invalid', 'Invalid key.'); return { ...identity, ...tokens[token] }; } },
    store: { async userById(id) { return options.deleted ? null : { id }; } },
    mutation: async operation => { if (options.maintenance) throw new HttpError(503, 'maintenance', 'Maintenance.'); calls.push(['admission']); return operation(); },
  });
  const server = createServer(async (req, res) => {
    try { if (!await routes(req, res)) sendJson(res, 404, { code: 'not_found', message: 'No route.' }); }
    catch (error) { sendError(res, error, { requestId: 'analysis-http-test' }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}${DATA_ANALYSIS_PATH}`;
  return { calls, async api(path, { method = 'GET', json, raw, headers = {} } = {}) {
    return fetch(`${base}${path}`, { method, headers: { authorization: 'Bearer evk_test', ...(json ? { 'content-type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : raw });
  } };
}

test('HTTP API uploads binary bytes without JSON corruption and returns asynchronous turns', async t => {
  const { api, calls } = await fixture(t);
  assert.equal((await api('/analyses', { method: 'POST', json: { name: 'Study', requestId: 'c1' } })).status, 201);
  const raw = Buffer.from([0, 10, 255, 34]);
  const upload = await api('/analyses/analysis-a/inputs?filename=data.parquet', { method: 'POST', raw, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(upload.status, 201);
  assert.deepEqual(calls.find(row => row[0] === 'raw'), ['raw', 'account-a', 'analysis-a', 'data.parquet', raw.toString('hex')]);
  const turn = await api('/analyses/analysis-a/turns', { method: 'POST', json: { requestId: 't1', question: 'Analyze these measurements.' } });
  assert.equal(turn.status, 202);
  assert.equal((await turn.json()).data.status, 'running');
  assert.equal((await api('/analyses/analysis-a/turns/turn-a')).status, 200);
  assert.equal((await api('/analyses/analysis-a/turns/turn-a/cancel', { method: 'POST', json: {} })).status, 200);
});

test('scope, revoked credentials, missing account, subject and project boundaries are enforced', async t => {
  const readOnly = await fixture(t, { identity: { scopes: ['analysis.read'] } });
  assert.equal((await readOnly.api('/analyses', { method: 'POST', json: { name: 'x', requestId: 'x' } })).status, 403);
  const revoked = await readOnly.api('/analyses/analysis-a', { headers: { authorization: 'Bearer revoked' } });
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), { error: 'Invalid key.', code: 'agent_key_invalid', requestId: 'analysis-http-test' });
  assert.equal((await readOnly.api('/analyses/analysis-a', { headers: { 'x-subject': 'doctor' } })).status, 400);
  assert.equal((await readOnly.api('/analyses/foreign')).status, 404);
  assert.equal((await (await fixture(t, { deleted: true })).api('/analyses/analysis-a')).status, 401);
  const bound = await fixture(t, { identity: { projectId: 'project-b' } });
  assert.equal((await bound.api('/analyses', { method: 'POST', json: { name: 'x', requestId: 'x' } })).status, 403);
  assert.equal((await bound.api('/analyses/analysis-a/artifacts/file-a')).status, 403);
  assert.ok(!bound.calls.some(row => row[0] === 'create' || row[0] === 'artifact'));
});

test('maintenance covers input and result snapshot mutations; raw input has a real byte limit', async t => {
  const held = await fixture(t, { maintenance: true });
  assert.equal((await held.api('/analyses/analysis-a/turns/turn-a')).status, 503);
  assert.equal((await held.api('/analyses/analysis-a/inputs?filename=a.csv', { method: 'POST', raw: 'a', headers: { 'content-type': 'application/octet-stream' } })).status, 503);
  const limited = await fixture(t);
  assert.equal((await limited.api('/analyses/analysis-a/inputs?filename=a.csv', { method: 'POST', raw: 'x'.repeat(17), headers: { 'content-type': 'application/octet-stream' } })).status, 413);
  assert.ok(!limited.calls.some(row => row[0] === 'raw'));
});

test('active content downloads as an attachment and schema is available without granting data access', async t => {
  const { api } = await fixture(t);
  const download = await api('/analyses/analysis-a/artifacts/art-a');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await download.text(), '<svg/>');
  const doc = await api('/openapi.json', { headers: { authorization: '' } });
  assert.equal(doc.status, 200);
  assert.equal((await doc.json()).openapi, '3.1.0');
  assert.equal((await api('/analyses/analysis-a', { headers: { authorization: '' } })).status, 401);
  assert.equal(dataAnalysisOpenApi().components.schemas.TurnRequest.properties.question.maxLength, 16000);
});

test('offline OpenAPI handoff is the contract actually served', async () => {
  const saved = JSON.parse(await readFile(new URL('../../../docs/data-analysis.openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(saved, dataAnalysisOpenApi());
});

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('timed out waiting for the held input');
}
const refusals = () => Object.fromEntries(dataAnalysisMetricFamilies()[0].series.map(row => [row.labels.reason, row.value]));
const raw = (api, token, headers = {}) => api('/analyses/analysis-a/inputs?filename=a.csv', { method: 'POST', raw: 'x', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', ...headers } });

test('inputs in flight are bounded per account and across the server, whatever keys exist; the refusal is named, counted and freed with the work', { timeout: 20000 }, async t => {
  resetDataAnalysisMetrics();
  let release; const gate = new Promise(resolve => { release = resolve; }); const entered = [];
  t.after(() => release());
  const { api } = await fixture(t, {
    config: { dataAnalysisMaxInputsInFlightPerAccount: 1, dataAnalysisMaxInputsInFlight: 2, dataAnalysisMaxInputBytes: 1024 },
    tokens: { evk_a: { userId: 'account-a', keyId: 'key-a' }, evk_a2: { userId: 'account-a', keyId: 'key-a2' }, evk_b: { userId: 'account-b', keyId: 'key-b' }, evk_c: { userId: 'account-c', keyId: 'key-c' } },
    service: { async rawInput(user, id, filename, buffer) { entered.push(user.id); await gate; return { id: 'input-a', bytes: buffer.length }; } },
  });
  const first = raw(api, 'evk_a'); await until(() => entered.length === 1);
  const sameAccount = await raw(api, 'evk_a2');
  assert.equal(sameAccount.status, 429);
  assert.equal((await sameAccount.json()).code, 'analysis_input_busy', 'a second key of the same account shares its limit');
  const second = raw(api, 'evk_b'); await until(() => entered.length === 2);
  const server = await raw(api, 'evk_c');
  assert.equal(server.status, 429, 'a third account is refused by the server-wide limit though it holds nothing');
  assert.equal((await server.json()).code, 'analysis_input_busy');
  assert.deepEqual(refusals(), { input_account: 1, input_server: 1, analysis_limit: 0 });
  release();
  assert.equal((await first).status, 201); assert.equal((await second).status, 201);
  assert.equal((await raw(api, 'evk_a')).status, 201, 'the slots were released with the work');
});

test('a failed or refused input frees its slot, and JSON inputs share the same slots', async t => {
  resetDataAnalysisMetrics();
  let mode = 'fail';
  const { api } = await fixture(t, {
    config: { dataAnalysisMaxInputsInFlightPerAccount: 1, dataAnalysisMaxInputsInFlight: 1, dataAnalysisMaxInputBytes: 16 },
    service: {
      async rawInput() { if (mode === 'fail') throw new HttpError(409, 'analysis_busy', 'Busy.'); return { id: 'input-a' }; },
      async input() { throw new HttpError(409, 'analysis_busy', 'Busy.'); },
    },
  });
  for (let round = 0; round < 3; round++) assert.equal((await raw(api, 'evk_test')).status, 409, 'a failure is the work\'s answer, never a leaked slot');
  assert.equal((await raw(api, 'evk_test', {}).then(response => response.status)), 409);
  const tooBig = await api('/analyses/analysis-a/inputs?filename=a.csv', { method: 'POST', raw: 'x'.repeat(40), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(tooBig.status, 413);
  for (let round = 0; round < 3; round++) assert.equal((await api('/analyses/analysis-a/inputs', { method: 'POST', json: { filename: 'a.csv', base64: 'eA==' } })).status, 409);
  mode = 'ok';
  assert.equal((await raw(api, 'evk_test')).status, 201);
  assert.deepEqual(refusals(), { input_account: 0, input_server: 0, analysis_limit: 0 });
});

test('DELETE removes one analysis through the service, with the key project for scope', async t => {
  const { api, calls } = await fixture(t, { identity: { projectId: 'project-a' } });
  const response = await api('/analyses/analysis-a', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { id: 'analysis-a', deleted: true });
  assert.deepEqual(calls.find(row => row[0] === 'remove'), ['remove', 'account-a', 'analysis-a', 'project-a']);
  const readOnly = await fixture(t, { identity: { scopes: ['analysis.read'] } });
  assert.equal((await readOnly.api('/analyses/analysis-a', { method: 'DELETE' })).status, 403, 'deleting needs the write scope');
});

test('the offline OpenAPI document describes the delete', () => {
  const doc = dataAnalysisOpenApi();
  assert.ok(doc.paths['/analyses/{analysisId}'].delete, 'DELETE /analyses/{analysisId} is part of the contract');
});
