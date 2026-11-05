// The evolution gateway's failures reach the server's failure funnel like every other gateway's
// (review of 「循证进化」, 2026-10-05, N4): the router handed it no recorder, so a refusal left no
// error record and no metric label.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createEvolutionGatewayHandler } from '../src/evolutionGateway.mjs';
import { HttpError } from '../src/security.mjs';

async function serve(t, { config = { evolutionEnabled: true }, admit = async (_scope, work) => work() } = {}) {
  const failures = [];
  const handler = createEvolutionGatewayHandler({ config, authenticateWorkload: async (token) => token === 'token' ? { userId: 'owner', projectId: 'project', runtimeGeneration: 'g' } : null,
    resolveRun: async () => ({ project: { id: 'project', userId: 'owner' }, runId: 'run', capabilityId: 'statistics' }),
    runtimeManager: { runtimePlatformSkills: () => [{ id: 'method', digest: `sha256:${'a'.repeat(64)}`, revision: 1, publicationKind: 'isolated-tool', capabilityIds: [] }] },
    controller: {}, supply: { executeIsolated: async () => ({}) }, admit });
  const server = http.createServer((req, res) => { handler(req, res, (failure) => failures.push(failure)).catch((error) => res.destroy(error)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = /** @type {any} */ (server.address());
  const post = (headers = { authorization: 'Bearer token', 'content-type': 'application/json' }, body = { toolId: 'method', digest: `sha256:${'a'.repeat(64)}`, args: {} }) =>
    fetch(`http://127.0.0.1:${address.port}/internal/evolution/v1/execute`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { failures, post };
}

test('a refusal at the gateway is handed to the failure funnel with its code and status', async (t) => {
  const off = await serve(t, { config: { evolutionEnabled: false } });
  assert.equal((await off.post()).status, 404);
  assert.deepEqual(off.failures, [{ code: 'not_found', status: 404 }]);
  const unauthenticated = await serve(t);
  assert.equal((await unauthenticated.post({ 'content-type': 'application/json' })).status, 401);
  assert.deepEqual(unauthenticated.failures, [{ code: 'unauthorized', status: 401 }]);
  const limited = await serve(t, { admit: async () => { throw new HttpError(429, 'evolution_tool_rate_limited', 'Too many.'); } });
  assert.equal((await limited.post()).status, 429);
  assert.deepEqual(limited.failures, [{ code: 'evolution_tool_rate_limited', status: 429 }]);
  const served = await serve(t);
  assert.equal((await served.post()).status, 200);
  assert.deepEqual(served.failures, [], 'a success records nothing');
});
