/** Public RSI campaign contracts. Validation checks shape, never grants source or signing authority. */
export const RSI_CAMPAIGN_LIMITS = Object.freeze({ campaignCny: 1000, monthCny: 30000 })
export const RSI_CAMPAIGN_SCHEMA_VERSION = 1
export const RSI_CAMPAIGN_CLAIMS = Object.freeze(['efficiency', 'targeted-repair', 'absolute-contract'])
export const RSI_CAMPAIGN_SURFACES = Object.freeze({
  'frontier-selection': { kind: 'policy', consumer: 'frontier-mix', activation: 'shadow' },
  'frontier-screen': { kind: 'policy', consumer: 'frontier-screen', activation: 'shadow' },
  'frontier-edit': { kind: 'policy', consumer: 'frontier-edit', activation: 'shadow' },
  'autopilot-planner': { kind: 'policy', consumer: 'autopilot-planner', activation: 'cohort' },
  'geo-supplements': { kind: 'policy', consumer: 'geo-capability', activation: 'cohort' },
  'capability-skill': { kind: 'skill', consumer: 'dsh-capability', activation: 'cohort' },
  'isolated-tool': { kind: 'isolated-tool', consumer: 'isolated-executor', activation: 'cohort' },
})

/** @param {any} value */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value */
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
/** @param {unknown} value */
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
/** @param {unknown} value */
const finite = value => typeof value === 'number' && Number.isFinite(value)
/** @param {unknown} value */
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
/** @param {any} value @param {string[]} allowed */
const keysWithin = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key))
/** @param {any} model */
const modelIdentity = model => keysWithin(model, ['provider', 'model']) && ['deepseek', 'dashscope'].includes(model.provider)
  && identifier(model.model) && (model.provider === 'deepseek' ? /^deepseek/i.test(model.model) : /^qwen/i.test(model.model))

/** A manifest is a registration, not evidence that its hypothesis passed. @param {any} value @returns {string[]} */
export function rsiCampaignIssues(value) {
  if (!record(value)) return ['campaign_manifest_invalid']
  const issues = []
  if (!keysWithin(value, ['schemaVersion', 'id', 'surface', 'candidateKind', 'claim', 'automated', 'createdAt', 'deadline', 'budget', 'models', 'target', 'registration', 'data'])
    || value.schemaVersion !== RSI_CAMPAIGN_SCHEMA_VERSION || !identifier(value.id)) issues.push('campaign_manifest_invalid')
  const surface = Object.hasOwn(RSI_CAMPAIGN_SURFACES, value.surface ?? '') ? RSI_CAMPAIGN_SURFACES[/** @type {keyof typeof RSI_CAMPAIGN_SURFACES} */ (value.surface)] : null
  if (!surface || value.candidateKind !== surface.kind) issues.push('campaign_surface_invalid')
  if (!RSI_CAMPAIGN_CLAIMS.includes(value.claim) || value.claim === 'absolute-contract' && value.candidateKind !== 'isolated-tool') issues.push('campaign_claim_invalid')
  if (value.automated !== true) issues.push('campaign_automated_required')
  if (!instant(value.createdAt) || !instant(value.deadline) || Date.parse(value.deadline) <= Date.parse(value.createdAt)) issues.push('campaign_time_invalid')
  const budget = value.budget
  if (!keysWithin(budget, ['campaignCny', 'monthCny']) || !finite(budget.campaignCny) || budget.campaignCny <= 0 || budget.campaignCny > RSI_CAMPAIGN_LIMITS.campaignCny
    || !finite(budget.monthCny) || budget.monthCny <= 0 || budget.monthCny > RSI_CAMPAIGN_LIMITS.monthCny || budget.campaignCny > budget.monthCny) issues.push('campaign_budget_invalid')
  if (!keysWithin(value.models, ['solver', 'improver', 'reviewer']) || !['solver', 'improver', 'reviewer'].every(role => modelIdentity(value.models?.[role]))) issues.push('campaign_model_invalid')
  if (rsiCompatibilityIssues(value.target, value.target).length || value.target?.surface !== value.surface) issues.push('campaign_target_invalid')
  if (!keysWithin(value.registration, ['digest', 'procedure', 'claim']) || !digest(value.registration.digest) || !identifier(value.registration.procedure)
    || value.registration.claim !== value.claim) issues.push('campaign_registration_invalid')
  const data = value.data
  if (!keysWithin(data, ['classification', 'sources', 'authorization']) || !['public', 'synthetic', 'authorized-incident'].includes(data.classification)) issues.push('campaign_data_invalid')
  const sources = data?.sources
  if (!Array.isArray(sources) || !sources.length || sources.length > 10000 || new Set(sources.map(source => source?.id)).size !== sources.length
    || sources.some(source => !keysWithin(source, ['id', 'digest', 'role', 'exposure']) || !identifier(source.id) || !digest(source.digest)
      || !['development', 'confirmation', 'audit'].includes(source.role) || !['sealed', 'exposed', 'synthetic'].includes(source.exposure))) issues.push('campaign_sources_invalid')
  if (data?.classification === 'authorized-incident') {
    const authority = data.authorization
    if (!keysWithin(authority, ['id', 'sourceRunId', 'sourceRevision', 'purpose', 'minimized']) || !identifier(authority.id) || !identifier(authority.sourceRunId)
      || !identifier(authority.sourceRevision) || authority.purpose !== 'platform-quality' || authority.minimized !== true) issues.push('campaign_incident_authority_missing')
  } else if (data?.authorization !== undefined) issues.push('campaign_incident_authority_unexpected')
  return [...new Set(issues)]
}

/** Resource names are references, not embedded access keys. An empty binding is an intentional non-running state.
 * @param {any} binding @returns {string[]} */
export function rsiLabBindingIssues(binding) {
  const issues = []
  const host = binding?.host
  if (!record(host) || host.provider !== 'alibaba' || host.purpose !== 'rsi-lab' || !identifier(host.instanceId) || !identifier(host.region)) issues.push('campaign_host_unavailable')
  const transport = binding?.transport
  /** @param {unknown} value */
  const bucket = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)
  let endpoint = false
  try {
    const url = new URL(transport?.endpoint)
    endpoint = url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === '/'
      && /^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname) && identifier(transport?.region)
      && url.hostname === `oss-${transport.region}.aliyuncs.com` && transport.region === host?.region
  } catch { /* unbound or invalid endpoints never fall back to a production URL */ }
  if (!record(transport) || !endpoint || !bucket(transport.incidentBucket) || !bucket(transport.bundleBucket) || transport.incidentBucket === transport.bundleBucket) issues.push('campaign_transport_unavailable')
  if (!record(binding?.signer) || !identifier(binding.signer.keyId) || !digest(binding.signer.publicKeySha256)) issues.push('campaign_signer_unavailable')
  return issues
}

/** Full release/image identities are recorded separately; only qualified affected dependencies and the incumbent decide compatibility.
 * @param {any} expected @param {any} current @returns {string[]} */
export function rsiCompatibilityIssues(expected, current) {
  /** @param {any} value */
  const valid = value => record(value) && Object.hasOwn(RSI_CAMPAIGN_SURFACES, value.surface ?? '') && digest(value.dependencyDigest) && identifier(value.baselineRevision)
  if (!valid(expected) || !valid(current)) return ['campaign_target_invalid']
  const issues = []
  if (expected.surface !== current.surface) issues.push('campaign_surface_changed')
  if (expected.dependencyDigest !== current.dependencyDigest) issues.push('campaign_dependency_changed')
  if (expected.baselineRevision !== current.baselineRevision) issues.push('campaign_baseline_changed')
  return issues
}

/** @param {any} input @param {{campaignCny:number,monthCny:number}} [limits] @returns {{admitted:boolean,reason:string|null}} */
export function rsiBudgetAdmission(input, limits = RSI_CAMPAIGN_LIMITS) {
  const names = ['campaignActualCny', 'campaignReservedCny', 'monthActualCny', 'monthReservedCny', 'requestCny']
  if (!record(input) || names.some(name => !finite(input[name]) || input[name] < 0 || input[name] > 100000000) || input.requestCny <= 0) return { admitted: false, reason: 'campaign_budget_unknown' }
  if (!finite(limits?.campaignCny) || limits.campaignCny <= 0 || limits.campaignCny > RSI_CAMPAIGN_LIMITS.campaignCny
    || !finite(limits?.monthCny) || limits.monthCny <= 0 || limits.monthCny > RSI_CAMPAIGN_LIMITS.monthCny) return { admitted: false, reason: 'campaign_budget_unknown' }
  // Existing model settlement has sub-cent precision. Round commitments up to 1e-8 CNY; never under-reserve due to floating point addition.
  /** @param {number} value */
  const units = value => Math.ceil(value * 100000000)
  const request = units(input.requestCny)
  if (names.some(name => !Number.isSafeInteger(units(input[name])))) return { admitted: false, reason: 'campaign_budget_unknown' }
  if (units(input.campaignActualCny) + units(input.campaignReservedCny) + request > units(limits.campaignCny)) return { admitted: false, reason: 'campaign_budget_exceeded' }
  if (units(input.monthActualCny) + units(input.monthReservedCny) + request > units(limits.monthCny)) return { admitted: false, reason: 'campaign_month_budget_exceeded' }
  return { admitted: true, reason: null }
}

/** @param {string} value @returns {string} */
export function rsiCampaignMonth(value) {
  if (!instant(value)) throw new TypeError('Campaign time requires an explicit timezone')
  return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 7)
}
