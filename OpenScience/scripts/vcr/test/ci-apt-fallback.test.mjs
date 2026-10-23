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
  const script = readFileSync(new URL('../ci-system-deps.sh', import.meta.url), 'utf8');
  const prefix = script.slice(0, script.indexOf('\nattempt apt-get'));
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
