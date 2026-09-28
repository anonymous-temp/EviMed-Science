/**
 * The port imports the kernel's own copy of a kernel package, never its own.
 *
 * In the runtime image the kernel runs from the CLI's global install and this
 * package from the profile seed, which carries a second copy of every kernel
 * package. At 0.1.5-rc.2 the port's bare imports reached the seed's copies
 * (measured on a seed projected the way a container boots): a `defineTool`
 * parameter error was then a `HarnessError` the kernel's `errorInfo` did not
 * recognise, and the tool result lost its `{ name, code }`. The fixture here is
 * that layout in miniature: a kernel install whose `dsh-tools` differs from
 * the one this workspace installs next to the port.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { kernelModuleUrl } from '../index.mjs'

/** A kernel install: `@deepseek-ai/dsh` with its own copy of two packages. */
async function fakeKernel(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'evimed-kernel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = path.join(root, 'lib/node_modules/@deepseek-ai/dsh')
  await mkdir(path.join(cli, 'lib'), { recursive: true })
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test', type: 'module' }))
  await writeFile(path.join(cli, 'lib/bin.js'), '')
  const tools = path.join(cli, 'node_modules/@deepseek-ai/dsh-tools')
  await mkdir(path.join(tools, 'lib'), { recursive: true })
  await writeFile(path.join(tools, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', type: 'module',
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './package.json': './package.json' },
  }))
  await writeFile(path.join(tools, 'lib/index.js'), 'export const copy = "kernel"\n')
  // A dual-format package, the shape `schemastery` has: the ESM entry is the
  // one the kernel imports, and the one the port must import too.
  const schema = path.join(cli, 'node_modules/@deepseek-ai/schemastery')
  await mkdir(path.join(schema, 'lib'), { recursive: true })
  await writeFile(path.join(schema, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/schemastery',
    exports: { '.': { types: './lib/types/index.d.ts', import: './lib/index.mjs', require: './lib/index.cjs' }, './package.json': './package.json' },
  }))
  await writeFile(path.join(schema, 'lib/index.mjs'), 'export default "esm"\n')
  await writeFile(path.join(schema, 'lib/index.cjs'), 'module.exports = "cjs"\n')
  // The bin, reached through a symlink the way `/usr/local/bin/dsh` is.
  const bin = path.join(root, 'bin')
  await mkdir(bin)
  const { symlink } = await import('node:fs/promises')
  await symlink(path.join(cli, 'lib/bin.js'), path.join(bin, 'dsh'))
  return { cli, entry: path.join(bin, 'dsh') }
}

test('a kernel package resolves inside the running kernel\'s own install, through the bin\'s symlink', async (t) => {
  const { cli, entry } = await fakeKernel(t)
  const url = await kernelModuleUrl('@deepseek-ai/dsh-tools', entry)
  assert.equal(url, pathToFileURL(path.join(cli, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href)
  assert.equal((await import(/** @type {string} */ (url))).copy, 'kernel')
  // The workspace's own copy is a different file: the fixture is not vacuous.
  assert.notEqual(import.meta.resolve('@deepseek-ai/dsh-tools'), url)
})

test('the ESM entry is the one taken, not a CommonJS twin the kernel never imports', async (t) => {
  const { cli, entry } = await fakeKernel(t)
  assert.equal(await kernelModuleUrl('@deepseek-ai/schemastery', entry),
    pathToFileURL(path.join(cli, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs')).href)
})

test('outside a kernel, or for a package the kernel does not carry, the port falls back to its own resolution', async (t) => {
  const { entry } = await fakeKernel(t)
  assert.equal(await kernelModuleUrl('@deepseek-ai/dsh-storage-domain', entry), null, 'not in the fake kernel')
  assert.equal(await kernelModuleUrl('@deepseek-ai/dsh-tools', path.join(tmpdir(), 'not-a-kernel.js')), null)
  assert.equal(await kernelModuleUrl('@deepseek-ai/dsh-tools', undefined), null)
  // node --test's own entry is not `@deepseek-ai/dsh`, so the suite itself
  // loads the workspace copies exactly as before.
  assert.equal(await kernelModuleUrl('@deepseek-ai/dsh-tools'), null)
})
