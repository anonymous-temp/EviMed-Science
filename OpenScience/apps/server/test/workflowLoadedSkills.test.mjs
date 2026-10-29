import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { SKILL_PACKAGES } from '@evimed/domain/skill-packages'
import { WORKFLOW_LOADED_PLATFORM_SKILLS, platformSkillRequirement } from '@evimed/domain/platform-skill-policy'

const repo = new URL('../../..', import.meta.url).pathname
/** The roots whose skills a project may switch off, as `normalizeDisabledPlatformSkills` admits them. */
const SWITCHABLE = new Set(['core', 'curated', 'office', 'community'])

/**
 * Every switchable platform skill a capability tells the model to load by name: a backticked name in its own body or in
 * a shared body its manifest injects, that the manifest does not inject itself. @returns {Promise<Map<string, Set<string>>>}
 */
async function derive() {
  /** @type {Map<string, string[]>} */ const ids = new Map()
  for (const record of SKILL_PACKAGES.values()) {
    if (!SWITCHABLE.has(record.origin)) continue
    ids.set(record.name, [...(ids.get(record.name) ?? []), `${record.origin}:${record.name}`])
  }
  /** @type {Map<string, Set<string>>} */ const found = new Map()
  for (const capability of (await fs.readdir(path.join(repo, 'capabilities'))).sort()) {
    const manifestFile = path.join(repo, 'capabilities', capability, 'capability.yaml')
    const manifest = parse(await fs.readFile(manifestFile, 'utf8').catch(() => 'null'))
    if (!manifest) continue
    const injected = new Set(manifest.skills ?? [])
    const bodies = [path.join(repo, 'capabilities', capability, 'SKILL.md'), ...[...injected].map(skill => path.join(repo, 'capability-skills', skill, 'SKILL.md'))]
    for (const body of bodies) {
      const text = await fs.readFile(body, 'utf8').catch(() => '')
      for (const [, name] of text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)) {
        if (injected.has(name)) continue
        for (const id of ids.get(name) ?? []) found.set(id, (found.get(id) ?? new Set()).add(capability))
      }
    }
  }
  return found
}

test('every platform skill a professional workflow loads by name is one a project cannot switch off', async () => {
  const derived = await derive()
  // The few standing platform methods are required for their own reason; the workflow list holds the rest.
  const missing = [...derived.keys()].filter(id => !platformSkillRequirement(id).required)
  assert.deepEqual(missing, [], `capabilities name skills a project could switch off: ${missing.map(id => `${id} (${[...derived.get(id)].join(', ')})`).join('; ')} — add them to WORKFLOW_LOADED_PLATFORM_SKILLS`)
  const unused = WORKFLOW_LOADED_PLATFORM_SKILLS.filter(id => !derived.has(id))
  assert.deepEqual(unused, [], 'no capability names these any more: take them off WORKFLOW_LOADED_PLATFORM_SKILLS')
  for (const id of WORKFLOW_LOADED_PLATFORM_SKILLS) assert.equal(platformSkillRequirement(id).reason, 'workflow')
  // The derivation reads what it should: geo-proposal's office producers and the humanize pass are among what it finds.
  assert.ok(derived.get('office:docx')?.has('geo-proposal'))
  assert.ok(derived.get('core:humanizer-zh')?.size)
  assert.equal(platformSkillRequirement('core:deep-research').required, false)
})
