import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { ClientModuleRegistry, bootInjections } from '@deepseek-ai/dsh-client-modules';

/**
 * Inspect an installed profile through the pinned native scanner. No profile
 * files are executed or changed, and no credential/configuration values print.
 * @param {string} profileDir Directory containing the profile's package.json.
 * @returns {{ discovered: boolean, clientPath: string | null, bootGraphIncludesClient: boolean }}
 */
export function probeRuntimeUiProfile(profileDir) {
  const bundleId = '@evimed/dsh-socket';
  const context = new Context();
  const entries = [
    { name: bundleId, baseUrl: pathToFileURL(path.join(path.resolve(profileDir), 'package.json')).href },
    { name: '@deepseek-ai/dsh-client-modules', baseUrl: new URL('../../package.json', import.meta.url).href },
  ].map(({ name, baseUrl }) => ({ options: { name }, fiber: {}, disabled: false,
    parent: { tree: { ctx: { baseUrl } } } }));
  context.provide('loader', { entries: () => entries });
  context.provide('webServer', { register: () => () => {} });
  const registry = new ClientModuleRegistry(context);
  const graph = registry.graph();
  const clientPath = registry.clientPath(bundleId) ?? null;
  return {
    discovered: clientPath !== null,
    clientPath,
    bootGraphIncludesClient: graph.entries.some(row => row.id === bundleId)
      && graph.batches.some(batch => batch.entries.includes(bundleId))
      && bootInjections(graph).some(row => JSON.stringify(row).includes(bundleId)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('A profile directory argument is required');
  process.stdout.write(`${JSON.stringify(probeRuntimeUiProfile(process.argv[2]))}\n`);
}
