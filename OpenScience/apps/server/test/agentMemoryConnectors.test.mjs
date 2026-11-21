import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AGENT_MEMORY_ENDPOINTS, AGENT_MEMORY_PATH } from '../src/agentMemoryRoutes.mjs';
import { AGENT_KEY_REQUESTS_PER_MINUTE } from '../src/agentApiKeys.mjs';
import { agentMemoryOpenApi } from '../src/agentMemoryOpenApi.mjs';
import { connectorSpecs } from '../src/agentMemoryConnectorSpecs.mjs';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');

test('installed clients and the anonymous guide agree with the authenticated server contract', async () => {
  const spec = agentMemoryOpenApi({basePath:AGENT_MEMORY_PATH,rateLimitPerMinute:AGENT_KEY_REQUESTS_PER_MINUTE});
  assert.deepEqual(JSON.parse(await read('../../web/public/static/agent-memory.openapi.json')), spec);
  const catalog = connectorSpecs();
  const primary = ['POST /recall','POST /note','GET /context','POST /remember','POST /forget','GET /forgotten'];
  assert.deepEqual([...primary,...catalog.map(s => s.method + ' ' + s.path)].sort(), [...AGENT_MEMORY_ENDPOINTS].sort());
  for (const file of ['../../../packages/dsh-memory-capsule/operations.json','../../../runtime/mcp/evimed-memory/operations.json']) {
    assert.deepEqual(JSON.parse(await read(file)), catalog);
  }
  assert.match(await read('../../web/public/static/agent-memory.html'), /href="agent-memory.openapi.json"/);
});
