import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Composition roots must enable the same store contract as their gateway.
for (const path of ['../run/lab.mjs', '../../../apps/server/src/server.mjs']) {
  test(`${path} passes the targeted-forget switch to the real store`, async () => {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const constructor = source.match(/new NativeMemoryStore\(\{([\s\S]*?)\}\)/)?.[1];
    assert.match(constructor, /forgetTargetsEnabled:\s*config\.memoryForgetTargetsEnabled/);
  });
}


test('lab history ingestion uses the same privacy judge as the store and worker', async () => {
  const source = await readFile(new URL('../run/lab.mjs', import.meta.url), 'utf8');
  assert.match(source.match(/new MemoryHistory\(\{([\s\S]*?)resolveSource/)?.[1], /rejectionJudge: productRejectionJudge/);
});
