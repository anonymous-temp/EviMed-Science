/** Internal, authenticated proof of the one approved project plugin. */
import { registerPluginProbe, configSchema } from '@evimed/harness-port'
const Schema = await configSchema()
export const Config = Schema.object({ disabledClientBundles: Schema.array(Schema.string()).default([]) })
export const name = 'evimed-plugin-probe'
// The loader is not injected: a context without it would never apply this plugin, and citation and extension proofs would
// stop with the one proof that needs it. `builtin()` reads it where it is (`builtinPluginState`) and degrades alone.
export const inject = ['agents', 'tools', 'agentPresets']
/** @param {any} ctx @param {any} config */
export async function apply(ctx, config) { await registerPluginProbe(ctx, config) }
