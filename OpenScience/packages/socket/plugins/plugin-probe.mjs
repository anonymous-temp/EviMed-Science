/** Internal, authenticated proof of the one approved project plugin. */
import { registerPluginProbe, configSchema } from '@evimed/harness-port'
const Schema = await configSchema()
export const Config = Schema.object({})
export const name = 'evimed-plugin-probe'
export const inject = ['agents', 'tools', 'agentPresets']
/** @param {any} ctx */
export async function apply(ctx) { await registerPluginProbe(ctx) }
