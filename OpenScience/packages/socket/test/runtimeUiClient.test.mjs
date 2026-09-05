import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

test('the packaged native client registers a browser-safe synchronous plugin', async () => {
  execFileSync(process.execPath, [new URL('../scripts/build-client.mjs', import.meta.url).pathname]);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.files.includes('dist/client.js'));
  assert.equal(pkg.exports['./client'], './dist/client.js');
  const source = await readFile(new URL(pkg.exports['./client'], root), 'utf8');
  /** @type {any} */ let registration;
  vm.runInNewContext(source, { __ModuleLoader__: { load: (/** @type {any} */ value) => { registration = value; } } });
  assert.equal(registration.id, '@evimed/dsh-socket');
  const plugin = registration.factory();
  assert.deepEqual(Array.from(plugin.inject), ['sessions', 'conversation', 'connection', 'workspaces']);
  assert.equal(plugin.apply.constructor.name, 'Function');
  assert.equal(plugin.apply({}, {}, {}), undefined);
  assert.doesNotMatch(source, /(?:import|require)\s*\(?['"](?:node:|@deepseek-ai\/)/);
  const docker = await readFile(new URL('../../../deploy/runtime-dsh/Dockerfile', import.meta.url), 'utf8');
  assert.ok(docker.indexOf('RUN node /opt/evimed/socket/scripts/build-client.mjs') < docker.indexOf('chmod -R a-w /opt/evimed/socket'));
});
