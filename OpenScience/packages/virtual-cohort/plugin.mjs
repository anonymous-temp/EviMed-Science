import { configSchema } from '@evimed/harness-port'
import { registerResearchTools } from '@evimed/research-plugin-runtime'
import { methods } from './index.mjs'
const Schema = await configSchema()
export const name = 'virtual-cohort'
export const inject = ['tools']
export const Config = Schema.object({ mode: Schema.string().default('hosted'), workspace: Schema.string().default(''), engineRoot: Schema.string().default(''), rscript: Schema.string().default('Rscript') })
/** @param {any} ctx @param {{mode: string, workspace: string, engineRoot: string, rscript?: string}} config */
export async function apply(ctx, config) { await registerResearchTools(ctx, { name: 'virtual_cohort', methods, skillUrl: new URL('./SKILL.md', import.meta.url), ...config }) }
