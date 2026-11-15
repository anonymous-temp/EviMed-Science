/** Validate the actual bundle/overlay/locale exports through DSH's read-only boot readers; never boots or installs a profile. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const install = process.argv[2] ?? '/home/coder/.npm-global/lib/node_modules/@deepseek-ai/dsh';
const bootUrl = pathToFileURL(`${install}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`);
const { bundlePatchPaths, loadOverlayPatches, composeEntries, evaluatePluginCompatibility, readPluginMeta } = await import(bootUrl.href);
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const layers = bundlePatchPaths(root, manifest.dsh.bundle).map(path => loadOverlayPatches('capsule-check', path));
const warnings = [];
const entries = composeEntries(layers, warning => warnings.push(warning));
assert.deepEqual(warnings, []);
assert.equal(entries.length, 1);
assert.equal(entries[0].id, 'evimed-memory-capsule');
assert.equal(entries[0].name, manifest.name);
assert.equal(evaluatePluginCompatibility(manifest), undefined);
assert.ok(evaluatePluginCompatibility(manifest, {}, '0.2.1'));
const metadata = readPluginMeta(manifest.name, import.meta.url);
assert.ok(!metadata?.error, metadata?.error);
assert.equal(metadata?.title.en, 'Memory capsule');
assert.equal(metadata?.title.zh, '记忆胶囊');
const configured = composeEntries([...layers, [{ id: entries[0].id, config: { baseUrl: 'https://memory.example.invalid', apiKeyFile: '/local/credential.txt' } }]]);
const plugin = await import(import.meta.resolve(configured[0].name));
assert.equal(plugin.name, entries[0].id);
assert.deepEqual(plugin.inject, ['tools', 'systemPrompt']);
const registered = []; const disposers = [];
const ctx = {
  tools: { register(tool) { registered.push(tool); return () => registered.splice(registered.indexOf(tool), 1); } },
  systemPrompt: { section(section) { assert.equal(section.interpolate, false); return () => {}; } },
  effect(effect) { disposers.push(effect()); },
};
plugin.apply(ctx, {});
assert.deepEqual(registered.map(tool => tool.name), ['capsule_recall', 'capsule_propose', 'capsule_method', 'capsule_status']);
assert.equal((await registered[3].execute({})).code, 'not_configured');
for (const dispose of disposers.reverse()) dispose();
assert.equal(registered.length, 0);
console.log('DSH bundle patch, profile override, exported locales, exact compatibility and plugin load valid (no profile boot/install).');
