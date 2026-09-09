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
  // The loader hands the factory its `require`; React reaches the shell that
  // way and nowhere else.
  /** @type {string[]} */ const required = [];
  const plugin = registration.factory((/** @type {string} */ id) => { required.push(id); return undefined; });
  assert.deepEqual(Array.from(plugin.inject), ['sessions', 'conversation', 'connection', 'workspaces', 'slots', 'locale']);
  assert.equal(plugin.apply.constructor.name, 'Function');
  assert.equal(plugin.apply({}, {}), undefined);
  assert.deepEqual(required, [], 'outside a hosted frame neither body touches the loader');
  // Every service the bodies inject has its provider named for the module
  // scanner, so the bundle is ordered after them rather than racing them.
  for (const provider of ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-sidebar']) {
    assert.ok(pkg.dsh.client.inject.includes(provider), `${provider} must be listed under dsh.client.inject`);
  }
  assert.doesNotMatch(source, /(?:import|require)\s*\(?['"](?:node:|@deepseek-ai\/)/);
  const docker = await readFile(new URL('../../../deploy/runtime-dsh/Dockerfile', import.meta.url), 'utf8');
  assert.ok(docker.indexOf('RUN node /opt/evimed/socket/scripts/build-client.mjs') < docker.indexOf('chmod -R a-w /opt/evimed/socket'));
});
