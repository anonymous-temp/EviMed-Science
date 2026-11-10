import { catalogue, sharedEvidenceMethods } from './catalogue.mjs'

/** Owned references returned by the host; the gateway reauthorizes each one. */
export const hostedReferenceParameters = Object.freeze({
  subjectId: { type: 'string', description: 'Existing hosted research object returned by the host. Required when the method operates on that object.' },
  modelId: { type: 'string', description: 'Hosted registered model identifier.' },
  modelVersion: { type: 'string', description: 'Exact immutable hosted model version returned with modelId.' },
  reconstructionResultId: { type: 'string', description: 'Hosted preserved reconstruction result identifier.' },
})

/** One projection shared by the runtime sender and native transcript verifier.
 * It grants nothing: the existing VCR gateway still authenticates the workload,
 * conversation, source grants and owned job on every operation.
 * @param {string} tool @param {Record<string,any>} args
 * @param {{jobMethods:Record<string,string>,methods:Record<string,any>}} registry */
export function projectResearchInvocation(tool, args, { jobMethods, methods }) {
  // The virtual lab's two trial-only tools: a design-search campaign and a comparison of named arms. The manifest and the
  // experiment are forwarded whole; the gateway validates and freezes them, and code evaluates every candidate.
  const lab = /^virtual_trial_(search|compare)$/.exec(tool)
  if (lab) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('research_invocation_invalid')
    const allowed = lab[1] === 'search' ? ['manifest', 'campaignId', 'cancel'] : ['experiment', 'experimentId']
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('research_invocation_invalid')
    const object = (/** @type {unknown} */ value) => value && typeof value === 'object' && !Array.isArray(value)
    const id = (/** @type {unknown} */ value) => typeof value === 'string' && value.length > 0 && value.length <= 200
    if (lab[1] === 'search') {
      if (args.manifest !== undefined) {
        if (!object(args.manifest) || args.campaignId !== undefined || args.cancel !== undefined) throw new Error('research_invocation_invalid')
        return { operation: 'simulate', body: { action: 'search', manifest: args.manifest } }
      }
      if (!id(args.campaignId) || (args.cancel !== undefined && typeof args.cancel !== 'boolean')) throw new Error('research_campaign_required')
      return { operation: 'simulate', body: { action: args.cancel === true ? 'search_cancel' : 'search_status', campaignId: args.campaignId } }
    }
    if (args.experiment !== undefined) {
      if (!object(args.experiment) || args.experimentId !== undefined) throw new Error('research_invocation_invalid')
      return { operation: 'simulate', body: { action: 'compare', experiment: args.experiment } }
    }
    if (!id(args.experimentId)) throw new Error('research_experiment_required')
    return { operation: 'simulate', body: { action: 'compare_status', experimentId: args.experimentId } }
  }
  const match = /^(virtual_trial|virtual_cohort|virtual_patient|synthetic_control)_(describe|start|read|cancel|report)$/.exec(tool)
  if (!match || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('research_invocation_invalid')
  const plugin = catalogue.find(item => item.id === match[1].replaceAll('_', '-'))
  const action = match[2]
  const allowed = action === 'start' ? ['method', 'scenario', 'version', 'inputs', 'seed', 'replicates', 'sources', 'cpuSecondsLimit', ...Object.keys(hostedReferenceParameters)]
    : action === 'describe' ? ['method'] : ['jobId']
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('research_invocation_invalid')
  if (action === 'start' || action === 'describe') {
    if (!plugin || ![...plugin.methods, ...sharedEvidenceMethods].includes(args.method) || !methods[args.method]) throw new Error('research_method_unavailable')
    const kind = Object.keys(jobMethods).find(key => jobMethods[key] === args.method)
    if (!kind || args.version !== undefined && args.version !== methods[args.method].version) throw new Error('research_method_version_unavailable')
    if (action === 'describe') return { operation: 'simulate', body: { action: 'shape', kind } }
    if (!args.scenario || typeof args.scenario !== 'object' || Array.isArray(args.scenario)) throw new Error('research_scenario_required')
    return { operation: 'simulate', body: { action: 'start', kind, scenario: args.scenario,
      ...Object.fromEntries(['inputs', 'seed', 'replicates', 'sources', 'cpuSecondsLimit', ...Object.keys(hostedReferenceParameters)].filter(key => args[key] !== undefined).map(key => [key, args[key]])) } }
  }
  if (typeof args.jobId !== 'string' || !args.jobId || args.jobId.length > 200) throw new Error('research_job_required')
  return { operation: 'simulate', body: { action: action === 'cancel' ? 'cancel' : 'status', jobId: args.jobId } }
}

/** @param {string} tool */
export function isResearchPluginTool(tool) {
  return /^(virtual_trial|virtual_cohort|virtual_patient|synthetic_control)_(describe|start|read|cancel|report)$/.test(tool) || /^virtual_trial_(search|compare)$/.test(tool)
}

/** The plugin a research tool belongs to (`virtual-trial`), for the selection check. @param {string} tool */
export function researchPluginOfTool(tool) {
  return tool.replace(/_(describe|start|read|cancel|report|search|compare)$/, '').replaceAll('_', '-')
}
