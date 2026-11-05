import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measureClosure, orderNativeBundles } from './research-bundles.mjs';
import { orderLoopxProfileBundles } from './loopx-compat.mjs';
import { orderBundleBeforeSocket } from './install-openviking-plugin.mjs';

const nativeNames = ['virtual-trial', 'virtual-cohort', 'virtual-patient', 'synthetic-control', 'virtual-research-suite'].map(id => `@evimed/${id}`);

function pkg(root, name, dependencies = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '0.1.0', dependencies }));
  fs.writeFileSync(path.join(root, 'index.mjs'), 'export const value = 1');
}
test('receipt hashes the actual nested and transitive dependency bytes, not an unused hoisted shadow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-closure-'));
  const own = path.join(root, 'node_modules/@evimed/virtual-trial');
  const hoisted = path.join(root, 'node_modules/@evimed/domain');
  const nested = path.join(own, 'node_modules/@evimed/domain');
  const transitive = path.join(nested, 'node_modules/scientific-helper');
  try {
    pkg(own, '@evimed/virtual-trial', { '@evimed/domain': '0.1.0' });
    pkg(hoisted, '@evimed/domain');
    pkg(nested, '@evimed/domain', { 'scientific-helper': '0.1.0' });
    pkg(transitive, 'scientific-helper');
    const initial = measureClosure(root, 'virtual-trial').closureDigest;
    fs.writeFileSync(path.join(hoisted, 'index.mjs'), 'export const value = 222');
    assert.equal(measureClosure(root, 'virtual-trial').closureDigest, initial);
    fs.writeFileSync(path.join(nested, 'index.mjs'), 'export const value = 999');
    const changed = measureClosure(root, 'virtual-trial').closureDigest;
    assert.notEqual(changed, initial);
    fs.writeFileSync(path.join(transitive, 'index.mjs'), 'export const value = 333');
    assert.notEqual(measureClosure(root, 'virtual-trial').closureDigest, changed);
    fs.rmSync(transitive, { recursive: true });
    assert.throws(() => measureClosure(root, 'virtual-trial'), /research_dependency_identity_invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native ordering repairs the real legacy ordering interaction and is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-order-'));
  const file = path.join(root, 'package.json');
  const canonical = ['base', 'dsh-loopx-plugin', '@openviking/dsh-memory-plugin', ...nativeNames, '@evimed/dsh-socket', 'unrelated', '@evimed/dsh-search-topics'];
  try {
    fs.writeFileSync(file, JSON.stringify({ dsh: { profile: { bundles: canonical } } }));
    orderLoopxProfileBundles(file);
    orderBundleBeforeSocket(file, '@openviking/dsh-memory-plugin');
    const wrong = JSON.parse(fs.readFileSync(file, 'utf8')).dsh.profile.bundles;
    assert.deepEqual(wrong, ['base', ...nativeNames, 'dsh-loopx-plugin', '@openviking/dsh-memory-plugin', '@evimed/dsh-socket', 'unrelated', '@evimed/dsh-search-topics']);
    const ordered = orderNativeBundles(wrong);
    assert.deepEqual(ordered, canonical);
    assert.deepEqual(orderNativeBundles(ordered), canonical);
    assert.deepEqual(ordered.filter(name => !nativeNames.includes(name)), wrong.filter(name => !nativeNames.includes(name)));
    assert.notDeepEqual(wrong, ordered, 'the helper returns a new list without mutating the input');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const name of [...nativeNames, '@evimed/dsh-socket']) {
  for (const defect of ['missing', 'duplicated']) {
    test(`native ordering rejects a ${defect} ${name}`, () => {
      const bundles = [...nativeNames, '@evimed/dsh-socket'];
      const invalid = defect === 'missing' ? bundles.filter(value => value !== name) : [...bundles, name];
      assert.throws(() => orderNativeBundles(invalid), /research_bundle_order_invalid/);
    });
  }
}

test('the ordering CLI accepts no requested profile path', () => {
  const script = fileURLToPath(new URL('./research-bundles.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'order', '/tmp/untrusted-profile.json'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /research_command_invalid/);
});

test('fresh and offline builds finalize legacy, native and last-host ordering before dump and seal', () => {
  for (const name of ['install-runtime.sh', 'Dockerfile.delta']) {
    const source = fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    const steps = ['loopx-compat.mjs --order-profile', 'install-openviking-plugin.mjs order',
      'evimed-research-bundles.mjs order', 'profile.dsh.profile.bundles=[...bundles.filter(value=>value!==name),name]',
      'dsh --profile evimed-runtime --dump-config', 'evimed-profile-seed.mjs seal'];
    const offsets = steps.map(step => source.indexOf(step));
    assert.ok(offsets.every(offset => offset >= 0), `${name} keeps every ordering and verification phase`);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), `${name} finalizes ordering before dump and seal`);
  }
});
