import assert from 'node:assert/strict'
import test from 'node:test'
import { WORKFLOW_LOADED_PLATFORM_SKILLS, currentDisabledPlatformSkills, platformSkillRequirement } from '../src/platformSkillPolicy.mjs'

test('a saved disabled id that left the catalogue or became required is stale, never carried', () => {
  const known = new Set(['curated:matplotlib', 'office:docx', 'core:domain-check'])
  assert.deepEqual(currentDisabledPlatformSkills(['community:gone', 'core:domain-check', 'curated:matplotlib', 'office:docx'], known),
    { disabled: ['curated:matplotlib'], stale: ['community:gone', 'core:domain-check', 'office:docx'] })
  // A catalogue that could not be read keeps every id that is not required.
  assert.deepEqual(currentDisabledPlatformSkills(['community:gone', 'office:docx'], null), { disabled: ['community:gone'], stale: ['office:docx'] })
})

test('the skills a professional workflow loads by name are required for that reason', () => {
  for (const id of WORKFLOW_LOADED_PLATFORM_SKILLS) assert.deepEqual(platformSkillRequirement(id), { required: true, reason: 'workflow' })
  assert.deepEqual(platformSkillRequirement('core:stats-integrity'), { required: true, reason: 'system' })
  assert.deepEqual(platformSkillRequirement('curated:matplotlib'), { required: false, reason: null })
})
