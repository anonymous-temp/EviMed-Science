import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const socketRoot = new URL('../../socket/', import.meta.url);
const helper = new URL('./helpers/runtimeUiProfileProbe.mjs', import.meta.url);

test('the profile probe reports real installed client metadata as JSON without other output', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'evimed profile probe '));
  try {
    execFileSync(process.execPath, [new URL('scripts/build-client.mjs', socketRoot).pathname]);
    const packageDir = path.join(profileDir, 'node_modules', '@evimed', 'dsh-socket');
    await mkdir(path.join(packageDir, 'dist'), { recursive: true });
    await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'profile-fixture', private: true }));
    const pkg = JSON.parse(await readFile(new URL('package.json', socketRoot), 'utf8'));
    const clientMetadata = pkg.dsh.client;
    delete pkg.dsh.client;
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify(pkg));
    const run = () => JSON.parse(execFileSync(process.execPath, [helper.pathname, profileDir], { encoding: 'utf8' }));
    assert.deepEqual(run(), { discovered: false, clientPath: null, bootGraphIncludesClient: false });
    pkg.dsh.client = clientMetadata;
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify(pkg));
    await writeFile(path.join(packageDir, 'dist/client.js'), await readFile(new URL('dist/client.js', socketRoot)));
    assert.deepEqual(run(), {
      discovered: true, clientPath: await realpath(path.join(packageDir, 'dist/client.js')), bootGraphIncludesClient: true,
    });
  } finally { await rm(profileDir, { recursive: true, force: true }); }
});
