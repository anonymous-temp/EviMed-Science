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
  return /^(virtual_trial|virtual_cohort|virtual_patient|synthetic_control)_(describe|start|read|cancel|report)$/.test(tool)
}
