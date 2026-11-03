/** Public RSI campaign contracts. Validation checks shape, never grants source or signing authority. */
export const RSI_CAMPAIGN_LIMITS = Object.freeze({ campaignCny: 1000, monthCny: 30000 })
/** 2 (2026-11-03): `models` names every role, `{solver, improvers, judges}`; a version-1 manifest (`{solver, improver, reviewer}`) is refused. */
export const RSI_CAMPAIGN_SCHEMA_VERSION = 2
/** `superiority` is for a deterministic consumer whose arms make no model call: quality alone is claimed, cost is not. */
export const RSI_CAMPAIGN_CLAIMS = Object.freeze(['efficiency', 'targeted-repair', 'superiority', 'absolute-contract'])
/** `consumer` is also the key of a quarter's error budget (campaign_runner.mjs): surfaces that change one consumer draw on one ledger, and renaming a consumer starts a new one. */
export const RSI_CAMPAIGN_SURFACES = Object.freeze({
  'frontier-selection': { kind: 'policy', consumer: 'frontier-mix', activation: 'shadow' },
  'frontier-screen': { kind: 'policy', consumer: 'frontier-screen', activation: 'shadow' },
  'frontier-edit': { kind: 'policy', consumer: 'frontier-edit', activation: 'shadow' },
  'autopilot-planner': { kind: 'policy', consumer: 'autopilot-planner', activation: 'cohort' },
  'geo-supplements': { kind: 'policy', consumer: 'geo-capability', activation: 'cohort' },
  'capability-skill': { kind: 'skill', consumer: 'dsh-capability', activation: 'cohort' },
  // A patched runtime image (guidance supplement + skills) measured offline on lane runs (2026-11-01). Shadow only: nothing of it is imported into production in this round, a qualified result is a pull-request proposal.
  'harness-patch': { kind: 'harness-patch', consumer: 'dsh-harness', activation: 'shadow' },
  // The same consumer (the runtime image) for a candidate that holds code (a tool, a connector) as well as text, with a consumer identity of its own (2026-11-02);
  // its error budget is the runtime image's, shared with harness-patch (2026-11-03).
  'tool-patch': { kind: 'tool-patch', consumer: 'dsh-harness', activation: 'shadow' },
  'isolated-tool': { kind: 'isolated-tool', consumer: 'isolated-executor', activation: 'cohort' },
})
/** Surfaces whose candidates come from a registered grid (a threshold sweep) with no model call: the only ones whose manifest may name no improver. */
export const RSI_REGISTERED_GRID_SURFACES = Object.freeze(['frontier-selection'])
/**
 * The owner's role policy (2026-11-03): the solver of every measured arm is DeepSeek (EviMed Science is DSH + DeepSeek Flash); every offline
 * improver (proposing, editing, composing, selecting, reflecting, distilling, writing candidates) and every adjudicator (judging, labelling,
 * a jury) is Claude, pinned by its model id. DeepSeek and Qwen are neither improvers nor judges offline, with the one exception below.
 */
export const RSI_SOLVER_PROVIDER = 'deepseek'
export const RSI_OFFLINE_ROLE_PROVIDER = 'anthropic'
export const RSI_OFFLINE_ROLE_MODEL = /^claude-[a-z0-9-]+$/
/**
 * The one adjudicator that is not Claude (owner ruling 2026-11-03, the second one, after a measurement): the jury of the frontier-selection campaign.
 * On the same 124 anchor rows Qwen 3.8 Max scored pick kappa 0.875 (precision 0.944, recall 0.85, abstention 2.4%) against the best Claude setting's
 * 0.686 (claude-sonnet-5-5, low effort, rubric v2; paired difference 0.189, 95% CI [0.011, 0.391], McNemar p 0.035), so this jury alone stays Qwen.
 * It is admitted as a judge with role `jury`, this provider and this model, on this surface and nowhere else: not on another surface, not as another
 * role, not as another Qwen or a DeepSeek model, and never as an improver.
 */
export const RSI_FRONTIER_JURY = Object.freeze({ role: 'jury', provider: 'dashscope', model: 'qwen3.8-max', surface: 'frontier-selection' })

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
/** @param {unknown} value */
const roleName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)

/**
 * One offline improver (`{role, provider, model}`) or adjudicator (`{role, provider, model, id?}`, `id` the registered judge or jury identity),
 * or the closed code that refuses it: a malformed record is `campaign_model_invalid`, anything but Anthropic with a pinned claude-* model id is
 * `campaign_improver_refused` / `campaign_judge_refused` — except the frontier jury (`RSI_FRONTIER_JURY`) as a judge on its own surface, which `surface` names.
 * @param {'improver'|'judge'} kind @param {any} value @param {string} [surface] the campaign surface the role serves
 * @returns {string|null}
 */
export function rsiOfflineRoleIssue(kind, value, surface) {
  if (!keysWithin(value, kind === 'judge' ? ['role', 'provider', 'model', 'id'] : ['role', 'provider', 'model']) || !roleName(value.role) || typeof value.provider !== 'string'
    || !identifier(value.model) || (value.id !== undefined && !identifier(value.id))) return 'campaign_model_invalid'
  if (kind === 'judge' && surface === RSI_FRONTIER_JURY.surface && value.role === RSI_FRONTIER_JURY.role && value.provider === RSI_FRONTIER_JURY.provider && value.model === RSI_FRONTIER_JURY.model) return null
  return value.provider === RSI_OFFLINE_ROLE_PROVIDER && RSI_OFFLINE_ROLE_MODEL.test(value.model) ? null : `campaign_${kind}_refused`
}

/** The issues of a manifest's `models`: who solved, who wrote the candidates and who adjudicated. @param {any} models @param {string} surface @returns {string[]} */
function modelIssues(models, surface) {
  if (!keysWithin(models, ['solver', 'improvers', 'judges']) || !Array.isArray(models.improvers) || !Array.isArray(models.judges) || models.improvers.length > 16 || models.judges.length > 16
    || !keysWithin(models.solver, ['provider', 'model']) || !identifier(models.solver.model)) return ['campaign_model_invalid']
  const issues = []
  if (models.solver.provider !== RSI_SOLVER_PROVIDER || !/^deepseek/i.test(models.solver.model)) issues.push('campaign_solver_refused')
  for (const improver of models.improvers) { const issue = rsiOfflineRoleIssue('improver', improver); if (issue) issues.push(issue) }
  for (const judge of models.judges) { const issue = rsiOfflineRoleIssue('judge', judge, surface); if (issue) issues.push(issue) }
  // An empty `judges` is the consumer's to accept (a deterministic scorer); its validation compares it with the registration.
  if (!models.improvers.length && !RSI_REGISTERED_GRID_SURFACES.includes(surface)) issues.push('campaign_improver_missing')
  return issues
}

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
  issues.push(...modelIssues(value.models, value.surface))
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
    if (!keysWithin(authority, ['id', 'incidentId', 'incidentDigest', 'sourceRunId', 'sourceRevision', 'purpose', 'minimized']) || !identifier(authority.id) || !identifier(authority.sourceRunId)
      || !identifier(authority.incidentId) || !digest(authority.incidentDigest)
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
  // `{kind: 'none'}` is a lab without the incident/bundle channels: public and synthetic campaigns run, an incident campaign does not.
  const none = record(transport) && transport.kind === 'none' && Object.keys(transport).length === 1
  if (!none && (!record(transport) || !endpoint || !bucket(transport.incidentBucket) || !bucket(transport.bundleBucket) || transport.incidentBucket === transport.bundleBucket)) issues.push('campaign_transport_unavailable')
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
  if (!finite(limits?.campaignCny) || limits.campaignCny < 1e-8 || limits.campaignCny > RSI_CAMPAIGN_LIMITS.campaignCny
    || !finite(limits?.monthCny) || limits.monthCny < 1e-8 || limits.monthCny > RSI_CAMPAIGN_LIMITS.monthCny) return { admitted: false, reason: 'campaign_budget_unknown' }
  // Existing model settlement has sub-cent precision. Round commitments up to 1e-8 CNY; never under-reserve due to floating point addition.
  /** @param {number} value */
  const units = value => Math.ceil(value * 100000000)
  const request = units(input.requestCny)
  if (names.some(name => !Number.isSafeInteger(units(input[name])))) return { admitted: false, reason: 'campaign_budget_unknown' }
  if (units(input.campaignActualCny) + units(input.campaignReservedCny) + request > Math.floor(limits.campaignCny * 100000000)) return { admitted: false, reason: 'campaign_budget_exceeded' }
  if (units(input.monthActualCny) + units(input.monthReservedCny) + request > Math.floor(limits.monthCny * 100000000)) return { admitted: false, reason: 'campaign_month_budget_exceeded' }
  return { admitted: true, reason: null }
}

/** @param {string} value @returns {string} */
export function rsiCampaignMonth(value) {
  if (!instant(value)) throw new TypeError('Campaign time requires an explicit timezone')
  return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 7)
}
