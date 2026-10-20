import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const run = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repository = path.dirname(sourceRoot);
const helper = path.join(sourceRoot, 'scripts/ops/prepare-host-ops-dependencies.mjs');
async function archiveFixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'evimed-host-ops-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ['OpenScience/packages/domain', 'OpenScience/apps/server/src/internalProjects.mjs',
    'OpenScience/apps/server/src/security.mjs', 'OpenScience/scripts/ops/backup-archive.mjs'];
  const archive = await run('git', ['archive', 'HEAD', ...paths], { cwd: repository, encoding: 'buffer', maxBuffer: 16 * 1024**2 });
  const tar = path.join(root, 'source.tar');
  await writeFile(tar, archive.stdout); await run('tar', ['-xf', tar, '-C', root]);
  const release = path.join(root, 'OpenScience');
  for (const folder of [release, path.join(release, 'packages'), path.join(release, 'packages/domain')]) await chmod(folder, 0o700);
  return { root, release, domain: path.join(release, 'packages/domain'), resolver: path.join(release, 'node_modules/@evimed/domain') };
}
const prepare = release => run('bash', ['-c', 'umask 077; exec "$@"', 'host-ops', process.execPath, helper, '--source-root', release]);
test('source-only Git archive backup fails without a resolver, then genuine inventory and archive pass after preparation', async t => {
  const f = await archiveFixture(t);
  const data = path.join(f.root, 'data'), manifest = path.join(f.root, 'inventory.json'), archive = path.join(f.root, 'backup.tar.gz');
  await mkdir(path.join(data, 'users/u/projects/p/workspace'), { recursive: true });
  await writeFile(path.join(data, 'users/u/projects/p/workspace/report.txt'), 'synthetic customer document\n');
  const writer = path.join(f.release, 'scripts/ops/backup-archive.mjs');
  await assert.rejects(run(process.execPath, [writer, 'inventory', data, manifest, 'true']), error => /ERR_MODULE_NOT_FOUND/.test(error.stderr) && /@evimed\/domain/.test(error.stderr));
  assert.equal(JSON.parse((await prepare(f.release)).stdout).createdLink, true);
  assert.equal(await realpath(f.resolver), f.domain);
  assert.equal((await lstat(path.join(f.release, 'node_modules'))).mode & 0o777, 0o755);
  assert.equal((await lstat(path.dirname(f.resolver))).mode & 0o777, 0o755);
  for (const folder of [f.release, path.join(f.release, 'packages'), f.domain]) assert.equal((await lstat(folder)).mode & 0o777, 0o700);
  await run(process.execPath, [writer, 'inventory', data, manifest, 'true']);
  await run(process.execPath, [writer, data, manifest, archive, 'true']);
  assert.match((await run('tar', ['-tzf', archive])).stdout, /users\/u\/projects\/p\/workspace\/report\.txt/);
  const before = await lstat(f.resolver), target = await readlink(f.resolver);
  assert.equal(JSON.parse((await prepare(f.release)).stdout).createdLink, false);
  assert.equal((await lstat(f.resolver)).ino, before.ino); assert.equal(await readlink(f.resolver), target);
});
test('a closer server resolver shadow is refused before any root resolver is prepared', async t => {
  const f = await archiveFixture(t), closer = path.join(f.release, 'apps/server/node_modules/@evimed/domain');
  await mkdir(path.dirname(closer), { recursive: true }); await symlink(path.join(f.root, 'wrong-package'), closer);
  await assert.rejects(prepare(f.release), error => /host_ops_dependency_invalid/.test(error.stderr));
  await assert.rejects(lstat(path.join(f.release, 'node_modules')), { code: 'ENOENT' });
  await rm(closer); await mkdir(closer);
  await assert.rejects(prepare(f.release), error => /host_ops_dependency_invalid/.test(error.stderr));
});
test('valid pnpm same-release resolvers are preserved, but root shadows and symlink parents are refused', async t => {
  const f = await archiveFixture(t), closer = path.join(f.release, 'apps/server/node_modules/@evimed/domain');
  await mkdir(path.dirname(closer), { recursive: true }); await symlink(path.relative(path.dirname(closer), f.domain), closer);
  const before = await lstat(closer); await prepare(f.release); assert.equal((await lstat(closer)).ino, before.ino);
  await rm(f.resolver); await writeFile(f.resolver, 'shadow');
  await assert.rejects(prepare(f.release), error => /host_ops_dependency_invalid/.test(error.stderr));
  await rm(path.join(f.release, 'node_modules'), { recursive: true });
  await symlink(path.join(f.root, 'elsewhere'), path.join(f.release, 'node_modules'));
  await assert.rejects(prepare(f.release), error => /host_ops_dependency_invalid/.test(error.stderr));
});
test('a domain package with runtime dependencies or escaping exports is refused without installation', async t => {
  const f = await archiveFixture(t), file = path.join(f.domain, 'package.json'), original = JSON.parse(await readFile(file, 'utf8'));
  for (const changed of [{ ...original, dependencies: { unexpected: '1.0.0' } }, { ...original, exports: { '.': '../escape.mjs' } }, { ...original, name: 'different-package' }]) {
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(prepare(f.release), error => /host_ops_dependency_invalid/.test(error.stderr));
    await assert.rejects(lstat(path.join(f.release, 'node_modules')), { code: 'ENOENT' });
  }
});
