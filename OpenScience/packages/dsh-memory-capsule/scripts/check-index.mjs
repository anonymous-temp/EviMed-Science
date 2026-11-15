/** Read-only check against the validator shipped by the approved local DSH install. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const install = process.argv[2] ?? '/home/coder/.npm-global/lib/node_modules/@deepseek-ai/dsh';
const validatorUrl = pathToFileURL(`${install}/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js`);
const { parseMarketIndex, marketInstallTarget } = await import(validatorUrl.href);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const example = JSON.parse(await readFile(new URL('../market-index.example.json', import.meta.url), 'utf8'));
const parsed = parseMarketIndex(example, 'https://example.invalid/dsh/index.json');
assert.equal(parsed.format, 1);
assert.equal(parsed.plugins.length, 1);
const plugin = parsed.plugins[0];
assert.equal(plugin.name, manifest.name);
assert.equal(plugin.versions[0].version, manifest.version);
assert.equal(plugin.versions[0].engines.dsh, manifest.engines.dsh);
assert.equal(marketInstallTarget(plugin.name, plugin.versions[0]).spec, `${manifest.name}@${manifest.version}`);
assert.equal(manifest.dsh.manifestVersion, 1);
assert.equal(manifest.private, true);
assert.ok(!manifest.dependencies && !manifest.peerDependencies, 'standalone package has no install-time dependencies');
const pin = JSON.parse(await readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8'));
assert.equal(manifest.engines.dsh, pin.dsh.version ?? pin.dsh);
for (const language of ['en', 'zh']) {
  const dictionary = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'));
  assert.ok(dictionary.meta.title && dictionary.meta.description);
}
console.log('DSH format-1 index valid; package identity, compatibility pin and locales agree (unpublished example).');
