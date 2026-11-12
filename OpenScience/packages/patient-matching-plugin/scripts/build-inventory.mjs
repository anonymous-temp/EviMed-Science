import { readFile, writeFile } from 'node:fs/promises'
import { TOOL_MANIFEST } from '../src/manifest.mjs'
const target = new URL('../../domain/src/patientMatchingTools.json', import.meta.url)
const generated = `${JSON.stringify(TOOL_MANIFEST.map(tool => tool.name), null, 2)}\n`
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== generated) throw new Error('Stale patient matching tool inventory; run the plugin build:inventory script')
} else await writeFile(target, generated)
