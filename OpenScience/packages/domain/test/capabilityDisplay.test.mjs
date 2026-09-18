import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { CAPABILITY_DISPLAY, capabilityTitle, validateCapabilityManifest } from '../index.mjs'

const capabilitiesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../capabilities')

/** Public capability ids in the tree, read without a YAML parser (the domain has none). */
function publicCapabilityIds() {
  const ids = []
  for (const entry of readdirSync(capabilitiesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = readFileSync(path.join(capabilitiesDir, entry.name, 'capability.yaml'), 'utf8')
    const id = manifest.match(/^id:\s*(\S+)\s*$/m)?.[1]
    assert.ok(id, `${entry.name}/capability.yaml has no id`)
    if (/^visibility:\s*internal\s*$/m.test(manifest)) continue
    ids.push(id)
  }
  return ids.sort()
}

const base = {
  id: 'clinical-evidence-synthesis',
  version: '1.0.0',
  title: 'Clinical Evidence Synthesis',
  description: 'Evidence synthesis.',
  whenToUse: '需要证据综述时。',
  persona: 'You are a clinical evidence analyst.',
  skills: ['clinical-evidence-synthesis'],
  tools: ['mcp__evimed__literature_search'],
  produces: [{ contractKind: 'clinical-evidence-report', outputs: [{ path: 'clinical-evidence-report.md', required: true }], checks: ['requiredOutputsExist'] }],
  safetyClass: 'clinical',
  estimatedMinutes: [30, 120],
}

const display = {
  title: '临床证据深度分析',
  category: '临床证据',
  description: '把一个开放的临床问题做成可复核的证据分析。',
  starterPrompts: ['≥70 岁人群阿司匹林一级预防的获益与出血风险。'],
  estimatedMinutes: { min: 30, max: 70 },
  outputs: ['证据综述报告'],
  knownLimits: ['不提供个体诊疗建议。'],
}

test('every public capability in the tree has a reader-facing entry', () => {
  const ids = publicCapabilityIds()
  // Prove the walk walked: a wrong path yields [] and passes vacuously.
  assert.ok(ids.length >= 15, `found only ${ids.length} public capabilities`)
  assert.ok(ids.includes('clinical-evidence-synthesis'))
  const missing = ids.filter((id) => !CAPABILITY_DISPLAY[id])
  assert.deepEqual(missing, [], 'run scripts/build/generate-capability-manifests.mjs after adding a display: block')
  for (const id of ids) {
    const entry = CAPABILITY_DISPLAY[id]
    assert.match(entry.title, /[一-鿿]/, `${id} has no Chinese title`)
    assert.ok(entry.starterPrompts.length >= 1, `${id} has no starter question`)
    assert.ok(entry.estimatedMinutes.min <= entry.estimatedMinutes.max, `${id} has an inverted duration`)
    assert.equal(capabilityTitle(id), entry.title)
  }
})

test('a display block is validated and normalized, and validating it again changes nothing', () => {
  const first = validateCapabilityManifest({ ...base, display })
  assert.ok(first.ok, JSON.stringify(first.issues))
  assert.deepEqual(first.manifest?.display, display)
  const again = validateCapabilityManifest({ ...base, display: first.manifest?.display })
  assert.ok(again.ok)
  assert.deepEqual(again.manifest?.display, first.manifest?.display)
})

test('display is optional in the validator, so a manifest built inline stays valid', () => {
  const result = validateCapabilityManifest(base)
  assert.ok(result.ok, JSON.stringify(result.issues))
  assert.equal(result.manifest?.display, undefined)
})

test('a display block refuses what would render as nothing or as nonsense', () => {
  /** @type {Array<[unknown, RegExp]>} */
  const cases = [
    [{ ...display, subtitle: '拼错的字段' }, /display\.subtitle is not a display field/],
    [{ ...display, estimatedMinutes: [30, 70] }, /display\.estimatedMinutes/],
    [{ ...display, estimatedMinutes: { min: 70, max: 30 } }, /display\.estimatedMinutes/],
    [{ ...display, title: '' }, /display\.title/],
    [{ ...display, starterPrompts: [] }, /display\.starterPrompts/],
    [{ ...display, outputs: ['同一件', '同一件'] }, /display\.outputs repeats/],
    ['临床证据', /display must be a mapping/],
  ]
  for (const [value, message] of cases) {
    const result = validateCapabilityManifest({ ...base, display: value })
    assert.equal(result.ok, false, `accepted ${JSON.stringify(value)}`)
    assert.ok(result.issues.some((issue) => message.test(issue.message)), JSON.stringify(result.issues))
  }
})

test('evaluation facts carry only what evals/ can say', () => {
  const allowed = new Set(['lastStatus', 'lastRunAt', 'runs', 'delivered', 'typicalMinutes'])
  let seen = 0
  for (const [id, entry] of Object.entries(CAPABILITY_DISPLAY)) {
    if (!entry.evaluation) continue
    seen += 1
    for (const key of Object.keys(entry.evaluation)) assert.ok(allowed.has(key), `${id}: unexpected evaluation.${key}`)
    const { runs, delivered } = entry.evaluation
    if (runs != null) assert.ok(delivered != null && delivered <= runs, `${id}: delivered exceeds runs`)
    if (entry.evaluation.lastStatus === 'not-run') assert.equal(entry.evaluation.lastRunAt, null)
  }
  assert.ok(seen > 0, 'no capability carries an evaluation; the generator did not read evals/')
})
