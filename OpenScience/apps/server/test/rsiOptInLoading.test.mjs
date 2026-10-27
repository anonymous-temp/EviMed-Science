// A deployment that did not opt into the RSI layer does not load its serving adapters, and with them the source-graph reader and the
// lockfile parser behind the dependency closure: they are imported only when OPEN_SCIENCE_RSI_ONLINE_CONFIG_FILE is set.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('server.mjs and its static imports never load the RSI serving adapters or the dependency closure', async () => {
  const visited = new Set(), reached = []
  async function visit(url) {
    if (visited.has(url.href)) return
    visited.add(url.href); reached.push(url.pathname.split('/').pop())
    const text = await readFile(url, 'utf8')
    // Static edges only: a dynamic import() is the opt-in path itself.
    for (const match of text.matchAll(/^\s*(?:import|export)\s[^'"\n]*?from\s*['"](\.\.?\/[^'"]+\.mjs)['"]/gm)) await visit(new URL(match[1], url))
    for (const match of text.matchAll(/^\s*import\s*['"](\.\.?\/[^'"]+\.mjs)['"]/gm)) await visit(new URL(match[1], url))
  }
  await visit(new URL('../src/server.mjs', import.meta.url))
  assert.ok(reached.length > 100 && reached.includes('rsiOnlineRuntime.mjs'), `the walk found ${reached.length} modules`)
  assert.deepEqual(reached.filter(name => ['rsiServingAdapters.mjs', 'rsiDependencyClosure.mjs'].includes(name)), [])
})

test('the adapters are imported dynamically, behind the deployment file', async () => {
  const code = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')
  assert.match(code, /config\.rsiOnlineConfigFile \? \(await import\("\.\/rsiServingAdapters\.mjs"\)\)\.createRsiServingAdapters\(/)
})
