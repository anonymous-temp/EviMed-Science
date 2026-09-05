import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'yaml';
import { Context } from '@deepseek-ai/cordis';
import { ClientModuleRegistry, bootInjections } from '@deepseek-ai/dsh-client-modules';

const socketRoot = new URL('../../socket/', import.meta.url);

test('the published native scanner discovers the socket client from the fresh host composition', async () => {
  execFileSync(process.execPath, [new URL('scripts/build-client.mjs', socketRoot).pathname]);
  const patch = parse(await readFile(new URL('cordis.patch.yml', socketRoot), 'utf8'));
  const rows = patch.flatMap((/** @type {any} */ row) => row.insert ?? []);
  const context = new Context();
  // Loader entries are the scanner's public host input. Resolution, package
  // metadata, source identity, bundle reading and graph composition below are
  // the published pinned implementation, not a transcription of its filters.
  const entries = rows.map((/** @type {any} */ options) => ({
    options, fiber: {}, disabled: false, parent: { tree: { ctx: { baseUrl: new URL('package.json', socketRoot).href } } },
  }));
  entries.push({ options: { name: '@deepseek-ai/dsh-client-modules' }, fiber: {}, disabled: false,
    parent: { tree: { ctx: { baseUrl: new URL('../package.json', import.meta.url).href } } } });
  context.provide('loader', { entries: () => entries });
  context.provide('webServer', { register: () => () => {} });
  const registry = new ClientModuleRegistry(context);
  const graph = registry.graph();
  const client = graph.entries.find(row => row.id === '@evimed/dsh-socket');
  assert.ok(client, 'the native scanner omitted the socket client from __DSH_BOOT__');
  assert.ok(graph.batches.some(batch => batch.ids.includes(client.id)));
  assert.equal(registry.clientPath(client.id), new URL('dist/client.js', socketRoot).pathname);
  const injections = bootInjections(graph);
  assert.ok(injections.some(row => JSON.stringify(row).includes('@evimed/dsh-socket')));
  /** @type {any} */ let registration;
  vm.runInNewContext(await readFile(registry.clientPath(client.id), 'utf8'), {
    __ModuleLoader__: { load: (/** @type {any} */ value) => { registration = value; } },
  });
  assert.equal(registration.id, client.id);
  assert.equal(typeof registration.factory().apply, 'function');
});
