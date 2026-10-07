import { configSchema, onToolWrap } from '@evimed/harness-port'
import { compactCommandResult } from '../src/duplicateLines.mjs'

const Schema = await configSchema()
export const name = 'evimed-duplicate-lines'
export const inject = ['tools']
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Collapse exact consecutive command log lines only.'),
})
/** @param {any} ctx @param {{enabled?:boolean}} config */
export function apply(ctx, config) {
  if (config.enabled === false) return
  ctx.effect(() => onToolWrap(ctx, async (call, proceed) => compactCommandResult(call.name, await proceed(), call.args)))
}
