import { configSchema, defineTool, registerTool, registerResearchConfiguration } from '@evimed/harness-port'

export const name = 'virtual-research-suite'
export const inject = ['tools']
const Schema = await configSchema()
export const Config = Schema.object({ mode: Schema.string().default('hosted'), workspace: Schema.string().default(''), engineRoot: Schema.string().default(''), rscript: Schema.string().default('Rscript') })

/** The suite discovers the tools actually visible in this scope; it installs none.
 * @param {any} ctx @param {{mode:string}} config
 */
export async function apply(ctx, config) {
  if (config.mode === 'standalone') return registerSuite(ctx, registerResearchConfiguration)
  ctx.inject(['evimedResearchAdapter'], (/** @type {any} */ scoped) => registerSuite(scoped, scoped.get('evimedResearchAdapter').registerConfiguration))
}
/** @param {any} ctx @param {Function} register */
async function registerSuite(ctx, register) {
  if (typeof register !== 'function') throw new Error('research_registration_not_configured')
  const tool = await defineTool({
    name: 'virtual_research_available',
    description: 'List the installed virtual research tools visible in this conversation. Combine their methods as the research question requires.',
    parameters: {},
    execute: async () => {
      const visible = ctx.tools.view().visible
      const tools = [...visible.keys()].filter(name => /^(virtual_trial|virtual_cohort|virtual_patient|synthetic_control)_(describe|start|read|report|cancel)$|^virtual_trial_(search|compare)$/.test(name)).sort()
      return { ok: true, data: { tools } }
    },
  })
  ctx.effect(() => registerTool(ctx, tool))
  await register(ctx, { extensionId: 'virtual-research-suite', definitions: new Map([['virtual_research_available', tool]]) })
}
