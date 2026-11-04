import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = ['domain', 'harness-port', 'design-tokens'];

for (const dockerfile of ['Dockerfile', 'Dockerfile.agentbay', 'Dockerfile.delta']) {
  test(`${dockerfile} can build the socket from the source trees it copies`, t => {
    const recipe = readFileSync(path.join(root, 'deploy/runtime-dsh', dockerfile), 'utf8');
    const build = recipe.indexOf(dockerfile === 'Dockerfile.delta'
      ? 'node /opt/evimed/socket/scripts/build-client.mjs'
      : 'RUN bash /usr/local/lib/evimed/install-runtime.sh socket-client');
    assert.notEqual(build, -1, 'the runtime must build its socket client');
    for (const name of packages) {
      const copy = recipe.match(new RegExp(`^COPY packages/${name} /opt/evimed/socket/node_modules/@evimed/${name}$`, 'm'));
      assert.ok(copy && copy.index < build, `the runtime must copy ${name} before building the socket`);
    }
    const base = mkdtempSync(path.join(tmpdir(), 'evimed-runtime-socket-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const socket = path.join(base, 'socket');
    const copySource = (from, to) => cpSync(from, to, { recursive: true,
      filter: source => !path.relative(from, source).split(path.sep).some(part => part === 'node_modules' || part === 'dist' || part === 'test') });
    copySource(path.join(root, 'packages/socket'), socket);
    for (const name of packages) copySource(path.join(root, 'packages', name), path.join(socket, 'node_modules/@evimed', name));
    const run = spawnSync(process.execPath, [path.join(socket, 'scripts/build-client.mjs')], { cwd: base,
      env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, `source-only socket build failed: ${run.stderr || run.error?.message}`);
    assert.ok(statSync(path.join(socket, 'dist/client.js')).size > 0);
  });
}
