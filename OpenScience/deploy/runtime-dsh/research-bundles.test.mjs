import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { measureClosure } from './research-bundles.mjs';

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
