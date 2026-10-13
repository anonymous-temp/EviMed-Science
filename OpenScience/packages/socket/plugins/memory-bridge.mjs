/**
 * The loopback bridge the official OpenViking memory plugin dials instead of a server.
 *
 * Hidden knowledge: the plugin keeps the credential it resolved at start and reads no token file, while every gateway of
 * ours accepts only the workload token the runtime's file holds now. So the plugin's row is given this process's own
 * loopback as its endpoint and no key, and this row forwards each request to the control plane's memory gateway with the
 * token of that moment. The listener, its deadlines and the settings it pins for the plugin are the port's
 * (`@evimed/harness-port`, `src/memoryBridge.mjs`); this file is the row.
 *
 * On only for a session whose account is on the native memory engine: the control plane's launch plan then gives the
 * runtime the memory gateway's base as EVIMED_MEMORY_GATEWAY_URL, empty for every other account. Off, it listens on nothing
 * and provides nothing, and the plugin's own row is disabled by the same variable.
 *
 * @module @evimed/dsh-socket/plugins/memory-bridge
 */

import { MEMORY_BRIDGE_PORT, configSchema, registerMemoryBridge } from '@evimed/harness-port'

const Schema = await configSchema()

export const name = 'evimed-memory-bridge'

export const inject = ['skills']

/**
 * @typedef {object} Config
 * @property {boolean} enabled
 * @property {string} gatewayUrl
 * @property {string} tokenFile
 * @property {number} port
 */

export const Config = Schema.object({
  enabled: Schema.boolean().default(false)
    .description('Whether this session uses the native memory engine. Off registers nothing and listens on nothing.'),
  gatewayUrl: Schema.string().default('')
    .description('Control-plane memory gateway. The runtime never names a host of its own; this is injected by the deployment.'),
  tokenFile: Schema.string().default('')
    .description('Path to the short-lived workload token file, read on every forwarded request. The container never holds a real key.'),
  port: Schema.number().default(MEMORY_BRIDGE_PORT)
    .description('Loopback port the bridge listens on; the plugin row\'s endpoint names the same one.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  await registerMemoryBridge(ctx, config)
}
