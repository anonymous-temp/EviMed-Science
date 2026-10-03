import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import tar from 'tar-stream';
import { securityYamlPin, extractVerifiedYamlPackage, patchYamlInstallation, verifyYamlInstallation } from '../../../deploy/runtime-dsh/runtime-yaml-security.mjs';
const pin = securityYamlPin(new URL('../../../deps-version.json', import.meta.url));
const require = createRequire(import.meta.resolve('eslint/package.json'));
const installed = path.dirname(require.resolve('js-yaml/package.json'));
async function archive(entries) {
  const pack = tar.pack(), chunks = [];pack.on('data', chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { pack.on('end', resolve);pack.on('error', reject); });
  for (const e of entries) await new Promise((resolve, reject) => pack.entry(e.header, e.bytes ?? Buffer.alloc(0), error => error ? reject(error) : resolve()));
  pack.finalize();await done;return gzipSync(Buffer.concat(chunks));
}
function fixture(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-yaml-security-')));t.after(() => fs.rmSync(root, { recursive: true, force: true }));return root; }
function put(dir, value) { fs.mkdirSync(dir, { recursive: true });fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(value)); }
// Archive SRI in these relocation controls is synthetic. Separate Linux controls acquire the production-SRI tar.
test('complete replacement preserves provider/native bytes, works and is idempotent', t => {
  const root = fixture(t), official = path.join(root, 'official'), modules = path.join(root, 'node_modules');
  fs.cpSync(installed, official, { recursive: true, filter: file => !file.includes('/js-yaml/node_modules') });
  for (const suffix of ['js-yaml', 'nested/node_modules/js-yaml']) {
    const target = path.join(modules, suffix);fs.cpSync(official, target, { recursive: true });
    const value = JSON.parse(fs.readFileSync(path.join(target, 'package.json')));value.version = '4.3.0';fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(value));
  }
  put(path.join(modules, 'argparse'), { name: 'argparse', version: '2.0.1' });
  put(path.join(modules, '@deepseek-ai/fixture-consumer'), { name: '@deepseek-ai/fixture-consumer', version: '0.1.7-rc.2', dependencies: { 'js-yaml': '^4.0.0' } });
  const before = fs.readFileSync(path.join(modules, '@deepseek-ai/fixture-consumer/package.json'));
  const result = patchYamlInstallation(modules, official, pin);assert.equal(result.copies, 2);assert.equal(result.consumers, 1);
  assert.deepEqual(fs.readFileSync(path.join(modules, '@deepseek-ai/fixture-consumer/package.json')), before);
  assert.deepEqual(patchYamlInstallation(modules, official, pin), result);
  const yaml = createRequire(path.join(modules, '@deepseek-ai/fixture-consumer/package.json'))('js-yaml');
  assert.deepEqual(yaml.load('title: 中文\nvalue: 12.5\n'), { title: '中文', value: 12.5 });
  fs.appendFileSync(path.join(modules, 'js-yaml/lib/loader.js'), '\n// drift');
  assert.throws(() => verifyYamlInstallation(modules, official, pin), /full bytes mismatch/);
});
test('unsupported security/old dependencies refuse without silently changing package semantics', t => {
  const root = fixture(t), file = path.join(root, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ $runtimeSecurity: { 'js-yaml': { ...pin, version: '5.0.0' } } }));assert.throws(() => securityYamlPin(file), /single-source/);
  fs.writeFileSync(file, JSON.stringify({ $runtimeSecurity: { 'js-yaml': pin, arbitrary: {} } }));assert.throws(() => securityYamlPin(file), /single-source/);
  const target = path.join(root, 'modules/js-yaml');put(target, { name: 'js-yaml', version: '3.15.0', dependencies: {} });
  assert.throws(() => patchYamlInstallation(path.join(root, 'modules'), installed, pin), /dependency semantics/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).version, '3.15.0');
});
test('integrity, links, traversal, case aliases and byte bounds refuse before publication', async t => {
  const root = fixture(t), manifest = Buffer.from(JSON.stringify({ name: 'js-yaml', version: pin.version, dependencies: { argparse: '^2.0.1' } }));
  const base = { header: { name: 'package/package.json', type: 'file' }, bytes: manifest };
  const cases = [
    [base, { header: { name: 'package/link', type: 'symlink', linkname: 'package.json' } }],
    [base, { header: { name: 'package/link', type: 'link', linkname: 'package/package.json' } }],
    [base, { header: { name: 'package/../escape', type: 'file' }, bytes: Buffer.from('x') }],
    [base, { header: { name: 'package/C:\\escape', type: 'file' }, bytes: Buffer.from('x') }],
    [base, { header: { name: 'package/PACKAGE.JSON', type: 'file' }, bytes: manifest }],
    [base, { header: { name: 'package/big', type: 'file' }, bytes: Buffer.alloc(512 * 1024 + 1) }],
  ];
  for (const [i, entries] of cases.entries()) {
    const bytes = await archive(entries), file = path.join(root, 'archive-' + i), destination = path.join(root, 'out-' + i);fs.writeFileSync(file, bytes);
    assert.throws(() => extractVerifiedYamlPackage(file, { ...pin, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }, destination), /decoder refused/);
    assert.equal(fs.existsSync(destination), false);
  }
  const bytes = await archive([base]), file = path.join(root, 'good.tgz');fs.writeFileSync(file, bytes);
  assert.throws(() => extractVerifiedYamlPackage(file, pin, path.join(root, 'wrong')), /integrity/);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  extractVerifiedYamlPackage(file, { ...pin, integrity }, path.join(root, 'valid'));
  assert.throws(() => extractVerifiedYamlPackage(file, { ...pin, integrity }, path.join(root, 'valid')), /fresh extraction/);
  assert(fs.existsSync(path.join(root, 'valid/package.json')));
  const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1));fs.writeFileSync(file, bomb);
  assert.throws(() => extractVerifiedYamlPackage(file, { ...pin, integrity: 'sha512-' + createHash('sha512').update(bomb).digest('base64') }, path.join(root, 'bomb')), /decoder refused/);
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => extractVerifiedYamlPackage(file, pin, path.join(root, 'oversize')), /size\/type/);
});
test('both recipes patch global late, independently pin profile and verify before smoke', () => {
  for (const name of ['Dockerfile', 'Dockerfile.agentbay']) {
    const recipe = fs.readFileSync(new URL('../../../deploy/runtime-dsh/' + name, import.meta.url), 'utf8');
    const global = recipe.indexOf('RUN node /usr/local/bin/runtime-yaml-security.mjs global'), seed = recipe.indexOf('RUN bash /usr/local/lib/evimed/install-runtime.sh profile-seed'), verify = recipe.indexOf('RUN node /usr/local/bin/runtime-yaml-security.mjs verify'), smoke = recipe.indexOf('RUN bash /usr/local/lib/evimed/install-runtime.sh smoke');
    assert(global > recipe.indexOf('RUN bash /usr/local/lib/evimed/install-runtime.sh preset-row'));assert(global < seed && seed < verify && verify < smoke);
    assert(recipe.includes('COPY deps-version.json /opt/evimed/runtime-deps-version.json'));
    assert(recipe.includes('COPY deploy/runtime-dsh/profile-seed.mjs /usr/local/bin/profile-seed.mjs'));
  }
});
