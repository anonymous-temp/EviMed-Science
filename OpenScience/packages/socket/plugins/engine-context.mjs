/** Nonsecret specialist job policy, captured from the generating request. */
import { decorateEngineToolContext } from '@evimed/harness-port'

export const name = 'evimed-engine-context'
export const inject = ['tools']

/** @param {any} ctx */
export function apply(ctx) {
  ctx.effect(() => decorateEngineToolContext(ctx))
}
