/** Internal, authenticated proof of the one approved project plugin. */
import { registerPluginProbe, configSchema } from '@evimed/harness-port'
const Schema = await configSchema()
export const Config = Schema.object({ disabledClientBundles: Schema.array(Schema.string()).default([]) })
export const name = 'evimed-plugin-probe'
export const inject = ['agents', 'tools', 'agentPresets', 'loader']
/** @param {any} ctx @param {any} config */
export async function apply(ctx, config) { await registerPluginProbe(ctx, config) }
