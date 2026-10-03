/** Authenticated read-only platform catalogue, using the actual public scoped registry. */
import { configSchema, registerScopedSkillCatalogue } from '@evimed/harness-port'
const Schema = await configSchema()
export const name = 'evimed-skill-catalogue'
export const inject = ['agents', 'skills']
export const Config = Schema.object({})
/** @param {any} ctx */
export async function apply(ctx) { await registerScopedSkillCatalogue(ctx) }
