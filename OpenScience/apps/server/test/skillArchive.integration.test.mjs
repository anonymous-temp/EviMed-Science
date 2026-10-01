import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { parsePersonalSkill } from '@evimed/harness-port/personal-skills'
import { SkillLibraryArtifacts } from '../src/skillLibraryArtifacts.mjs'
import { decodeSkillArchive } from '../src/skillArchive.mjs'

test('real ZIP upload, owned artifact hydration and pinned native provider preserve the skill and resources', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'evimed-skill-import-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifacts = new SkillLibraryArtifacts({ root, parseSkill: parsePersonalSkill, decodeArchive: decodeSkillArchive })
  const file = Buffer.from('---\nname: imported-method\ndescription: Evidence method\n---\n# Method\nRead the preserved evidence.\n')
  const resource = Buffer.from('study,event_count\nexample,4\n')
  const archived = Buffer.from(zipSync({ 'repository/SKILL.md': file, 'repository/references/studies.csv': resource }))
  const upload = await artifacts.upload({ id: 'alice' }, 'zip', archived)
  const imported = await artifacts.import({ id: 'alice' }, { resourceId: upload.resourceId, skillId: 'archive-import-test', nativeName: 'personal-example' })
  assert.equal(imported.description, 'Evidence method')
  assert.equal(imported.instructions, '# Method\nRead the preserved evidence.')
  assert.equal(imported.resources.length, 1)
  assert.equal(imported.resources[0].path, 'references/studies.csv')
  assert.deepEqual(await artifacts.read({ id: 'alice' }, { resource: imported.resources[0] }), resource)
  await assert.rejects(artifacts.uploadEntries({ id: 'bob' }, upload.resourceId), error => {
    assert.equal(error.status, 404)
    return true
  })
})
