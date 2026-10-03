import process from 'node:process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// This fixed entry only reads the isolated /input mount. Source scripts stay data.
try {
  if (process.argv.length !== 3 || (process.argv[2] !== '' && !/^personal-[a-f0-9]{16}-[a-f0-9]{32}$/u.test(process.argv[2]))) throw new Error('invalid_reference')
  // The sealed profile carries the installed pinned SDK closure. The image's
  // source COPY does not; resolving through this fixed image-owned anchor keeps
  // preparation independent of any customer profile or environment selection.
  const require = createRequire('/opt/evimed/dsh-home-seed/profiles/evimed-runtime/node_modules/@evimed/dsh-socket/package.json')
  const { parsePersonalSkill } = await import(pathToFileURL(require.resolve('@evimed/harness-port/personal-skills')).href)
  const skill = await parsePersonalSkill('/input', process.argv[2] ? { expectedName: process.argv[2] } : {})
  const normalized = { name: skill.name, description: skill.description, instructions: skill.instructions,
    invocation: skill.invocation, metadata: skill.metadata, ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }) }
  const output = JSON.stringify(normalized)
  if (Buffer.byteLength(output) > 512 * 1024) throw new Error('output_limit')
  process.stdout.write(output)
} catch {
  process.stderr.write('Native skill validation failed.\n')
  process.exitCode = 1
}
