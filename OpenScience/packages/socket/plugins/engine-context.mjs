/** Nonsecret specialist job policy, captured from the generating request. */
import { decorateEngineToolContext, configSchema } from '@evimed/harness-port'

const Schema = await configSchema()
export const Config = Schema.object({})
export const name = 'evimed-engine-context'
export const inject = ['tools']

/** @param {any} ctx */
export function apply(ctx) {
  ctx.effect(() => decorateEngineToolContext(ctx))
}
