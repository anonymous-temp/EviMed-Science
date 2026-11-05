import { configSchema, readFileAt, registerResearchConfiguration } from '@evimed/harness-port'
import { createResearchGatewayAdapter } from '../src/researchGateway.mjs'

const Schema = await configSchema()
export const name = 'evimed-research-adapter'
/** @type {string[]} */
export const inject = []
export const Config = Schema.object({ enabled: Schema.boolean().default(true), gatewayUrl: Schema.string().default(''), tokenFile: Schema.string().default('') })
/** @param {any} ctx @param {{enabled?:boolean,gatewayUrl:string,tokenFile:string}} config */
export async function apply(ctx, config) {
  if (config.enabled === false) return
  if (!config.tokenFile || !config.gatewayUrl) throw new Error('research_gateway_unconfigured')
  const adapter = createResearchGatewayAdapter({ gatewayUrl: config.gatewayUrl,
    readToken: () => readFileAt(ctx, '/', config.tokenFile.replace(/^\/+/, '')) })
  // Registration and proof must use this host's port instance. Independently
  // installed bundles may resolve another physical copy of the port package.
  ctx.provide('evimedResearchAdapter', { ...adapter, registerConfiguration: registerResearchConfiguration })
}
