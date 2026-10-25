/** The standing preset's native filesystem provider, with the project's captured optional-skill choices. */
import { configSchema, registerProjectSkillProvider } from '@evimed/harness-port'
const Schema = await configSchema()
export const name = 'evimed-project-skills'
export const inject = ['skills']
export const Config = Schema.object({
  includeDefaultRoots: Schema.boolean().default(false),
  watch: Schema.boolean().default(false),
  customSkillDirs: Schema.array(Schema.string()).required(),
  disabledSkills: Schema.array(Schema.string()).default([]),
})
/** @param {any} ctx @param {any} config */
export async function apply(ctx, config) { await registerProjectSkillProvider(ctx, config) }
