import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = name => readFile(new URL(`../../../${name}`, import.meta.url), 'utf8');

test('every runtime image carries the optional topics bundle with its actual package version', async () => {
  const manifest = JSON.parse(await source('packages/search-topics/package.json'));
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'the offline delta must not acquire a dependency');
  for (const name of ['Dockerfile', 'Dockerfile.agentbay', 'Dockerfile.delta']) {
    const dockerfile = await source(`deploy/runtime-dsh/${name}`);
    assert.match(dockerfile, /^COPY packages\/search-topics \/opt\/evimed\/search-topics$/m, name);
    assert.equal(/^ARG SEARCH_TOPICS_VERSION=(\S+)$/m.exec(dockerfile)?.[1], manifest.version, name);
    assert.match(dockerfile, /test "\$\{SEARCH_TOPICS_VERSION\}" = "\$\(node -p 'require\("\/opt\/evimed\/search-topics\/package\.json"\)\.version'\)"/, name);
    assert.match(dockerfile, /^LABEL io\.open-science\.search-topics\.version="\$\{SEARCH_TOPICS_VERSION\}"$/m, name);
    assert.match(dockerfile, /install -d -m 0755 \/opt\/evimed\/search-topics-data/, name);
  }
  const install = await source('deploy/runtime-dsh/install-runtime.sh');
  assert.match(install, /dsh plugin --profile evimed-runtime add[^\n]*file:\/opt\/evimed\/search-topics/, 'full profile installation');
  assert.match(install, /Search topics bundle identity mismatch/, 'installed identity is checked');
  const delta = await source('deploy/runtime-dsh/Dockerfile.delta');
  assert.match(delta, /dsh plugin --profile evimed-runtime add --offline --ignore-scripts --store-dir "\$\{recorded_store\}" --save-prod --save-exact file:\/opt\/evimed\/search-topics/);
});

test('the installed topics bundle stays off until launch supplies explicit activation and data paths', async () => {
  const patch = await source('packages/search-topics/cordis.patch.yml');
  assert.match(patch, /disabled: !!js process\.env\.EVIMED_SEARCH_TOPICS_ENABLED !== '1'/);
  assert.match(patch, /topicsFile: !!js process\.env\.EVIMED_SEARCH_TOPICS_FILE \|\| ''/);
  assert.match(patch, /tokenFile: !!js process\.env\.EVIMED_SEARCH_TOPICS_TOKEN_FILE \|\| ''/);
  const baseline = await source('deploy/runtime-dsh/dump-config.baseline.json');
  assert.match(baseline, /# == @evimed\/dsh-search-topics\n- id: evimed-search-topics\n  name: '@evimed\/dsh-search-topics'\n  disabled: !!js process\.env\.EVIMED_SEARCH_TOPICS_ENABLED !== '1'/);
});
