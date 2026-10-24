import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const helper = new URL('../ci-apt-fallback.py', import.meta.url).pathname;
for (const [uri, changes] of [
  ['http://azure.archive.ubuntu.com/ubuntu/', true],
  ['https://azure.archive.ubuntu.com/ubuntu', true],
  ['http://azure.archive.ubuntu.com.evil/ubuntu/', false],
  ['http://azure.archive.ubuntu.com/ubuntu/bad', false],
  ['https://archive.ubuntu.com/ubuntu/', false],
]) test(`isolated source copy: ${uri}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-apt-test-'));
  try {
    const source = join(root, 'original');
    mkdirSync(join(source, 'sources.list.d'), { recursive: true });
    const original = `Types: deb\nURIs: ${uri}\nSuites: noble\nComponents: main\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n`;
    writeFileSync(join(source, 'sources.list.d/ubuntu.sources'), original);
    const result = spawnSync('python3', [helper, source, join(root, 'copy')]);
    assert.equal(result.status, changes ? 0 : 1);
    assert.equal(readFileSync(join(source, 'sources.list.d/ubuntu.sources'), 'utf8'), original);
    assert.equal(readFileSync(join(root, 'copy/sources.list.d/ubuntu.sources'), 'utf8'), changes ? original.replace(uri, 'https://archive.ubuntu.com/ubuntu/') : original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed mirror switches once; commands stay bounded and cleanup runs', () => {
  const script = readFileSync(new URL('../../ops/ci-apt.sh', import.meta.url), 'utf8');
  const prefix = script.slice(0, script.indexOf('\n# Known runner'));
  const root = mkdtempSync(join(tmpdir(), 'ci-apt-command-test-'));
  try {
    const program = `${prefix}\ncount=0\nsudo() {\n  count=$((count + 1))\n  printf '%s\\n' "$*" >> "$TEST_ROOT/commands"\n  [ "$count" -gt 1 ]\n}\nsleep() { :; }\nprepare_fallback() {\n  apt_fallback_dir="$TEST_ROOT/fallback"\n  mkdir -p "$apt_fallback_dir"\n  apt_sources=(-o "Dir::Etc::sourcelist=$apt_fallback_dir/sources.list")\n}\nattempt apt-get update\n[ "$count" = 2 ]\n`;
    const result = spawnSync('bash', ['-c', program], { env: { ...process.env, TEST_ROOT: root } });
    assert.equal(result.status, 0, result.stderr.toString());
    const commands = readFileSync(join(root, 'commands'), 'utf8').trim().split('\n');
    assert.match(commands[0], /timeout --signal=TERM --kill-after=30 600 apt-get update/);
    assert.doesNotMatch(commands[0], /sourcelist/);
    assert.match(commands[1], /Dir::Etc::sourcelist=/);
    assert.equal(spawnSync('test', ['-e', join(root, 'fallback')]).status, 1);
    const guarded = spawnSync('bash', ['-c', `${prefix}\nprepare_fallback`], { env: { ...process.env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' } });
    assert.equal(guarded.status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const format of ['list', 'sources']) test(`GitHub mirror+file ${format} preserves signatures and original`, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-apt-mirror-test-'));
  try {
    const source = join(root, 'original');
    mkdirSync(join(source, 'sources.list.d'), { recursive: true });
    const declaration = format === 'list'
      ? 'deb [signed-by=/usr/share/keyrings/ubuntu.gpg] mirror+file:/etc/apt/apt-mirrors.txt noble main\n'
      : 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt https://example.org/ubuntu/\nSuites: noble\nSigned-By: /usr/share/keyrings/ubuntu.gpg\n';
    const file = `sources.list.d/ubuntu.${format}`;
    writeFileSync(join(source, file), declaration);
    writeFileSync(join(source, 'apt-mirrors.txt'), 'http://azure.archive.ubuntu.com/ubuntu/\n');
    const copy = join(root, 'copy');
    assert.equal(spawnSync('python3', [helper, source, copy]).status, 0);
    assert.equal(readFileSync(join(source, file), 'utf8'), declaration);
    assert.equal(readFileSync(join(source, 'apt-mirrors.txt'), 'utf8'), 'http://azure.archive.ubuntu.com/ubuntu/\n');
    assert.equal(readFileSync(join(copy, file), 'utf8'), declaration.replace('mirror+file:/etc/apt/apt-mirrors.txt', `mirror+file:${copy}/apt-mirrors.txt`));
    assert.equal(readFileSync(join(copy, 'apt-mirrors.txt'), 'utf8'), 'https://archive.ubuntu.com/ubuntu/\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const uri of ['mirror+file:/tmp/apt-mirrors.txt', 'mirror+file:/etc/apt/../apt-mirrors.txt', 'mirror+file:/etc/apt/apt-mirrors.txt.evil']) test(`untrusted mirror reference untouched: ${uri}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-apt-outside-test-'));
  try {
    const source = join(root, 'original');
    mkdirSync(join(source, 'sources.list.d'), { recursive: true });
    const declaration = `deb ${uri} noble main\n`;
    writeFileSync(join(source, 'sources.list'), declaration);
    assert.equal(spawnSync('python3', [helper, source, join(root, 'copy')]).status, 1);
    assert.equal(readFileSync(join(root, 'copy/sources.list'), 'utf8'), declaration);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
