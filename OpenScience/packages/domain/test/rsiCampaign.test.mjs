import assert from 'node:assert/strict'
import test from 'node:test'
import { RSI_CAMPAIGN_LIMITS, RSI_CAMPAIGN_SCHEMA_VERSION, RSI_CAMPAIGN_SURFACES, RSI_FRONTIER_JURY, RSI_REGISTERED_GRID_SURFACES, rsiCampaignIssues, rsiLabBindingIssues, rsiCompatibilityIssues, rsiBudgetAdmission, rsiCampaignMonth,
  rsiOfflineRoleIssue } from '../src/rsiCampaign.mjs'

const digest = 'a'.repeat(64)
const OPUS = { role: 'writing-candidates', provider: 'anthropic', model: 'claude-opus-5-5' }
const SONNET_JUDGE = { role: 'judge', provider: 'anthropic', model: 'claude-sonnet-5-5', id: 'claude-sonnet-5-5-drb-pairwise' }
const manifest = () => ({ schemaVersion: 2, id: 'campaign-20261026', surface: 'frontier-selection', candidateKind: 'policy', claim: 'targeted-repair',
  automated: true, createdAt: '2026-10-26T01:00:00Z', deadline: '2026-10-27T01:00:00Z',
  budget: { campaignCny: 1000, monthCny: 30000 },
  models: /** @type {{solver:{provider:string,model:string}, improvers:any[], judges:any[]}} */ ({ solver: { provider: 'deepseek', model: 'deepseek-flash' }, improvers: [{ ...OPUS }], judges: [{ ...SONNET_JUDGE }] }),
  target: { surface: 'frontier-selection', dependencyDigest: digest, baselineRevision: 'default:selection-v1' },
  registration: { digest, procedure: 'paired-group-t-fixed-v1', claim: 'targeted-repair' },
  data: /** @type {{ classification: string, sources: { id: string, digest: string, role: string, exposure: string }[], authorization?: { id: string, incidentId: string, incidentDigest: string, sourceRunId: string, sourceRevision: string, purpose: string, minimized: boolean } }} */ ({ classification: 'public', sources: [{ id: 'sealed-pool', digest, role: 'confirmation', exposure: 'sealed' }] }) })

test('campaign manifests preserve owner budgets and permit preregistered repair without requiring savings', () => {
  assert.deepEqual(RSI_CAMPAIGN_LIMITS, { campaignCny: 1000, monthCny: 30000 })
  assert.deepEqual(rsiCampaignIssues(manifest()), [])
  /** @type {[keyof ReturnType<typeof manifest>['budget'], number][]} */
  const invalidBudgets = [['campaignCny', 1000.01], ['monthCny', 30000.01]]
  for (const [field, value] of invalidBudgets) {
    const input = manifest(); input.budget[field] = value
    assert.ok(rsiCampaignIssues(input).includes('campaign_budget_invalid'))
  }
})

test('non-automated, changed claim, hidden raw tenant scope and unknown candidate surfaces are refused', () => {
  /** @type {Array<(m: ReturnType<typeof manifest>) => void>} */
  const mutations = [m => { m.automated = false }, m => { m.registration.claim = 'efficiency' },
    m => { m.data.classification = 'tenant-database' }, m => { m.candidateKind = 'plugin' }, m => { m.surface = 'root-permissions' }]
  for (const mutate of mutations) {
    const input = manifest(); mutate(input); assert.notEqual(rsiCampaignIssues(input).length, 0)
  }
})

test('an anthropic improver with a pinned claude model id is admitted, because the owner\'s role policy (2026-11-03) makes every offline improver and judge Claude', () => {
  assert.equal(RSI_CAMPAIGN_SCHEMA_VERSION, 2)
  assert.deepEqual(rsiCampaignIssues(manifest()), [])
  const several = manifest(); several.models.improvers = [{ ...OPUS }, { role: 'selecting', provider: 'anthropic', model: 'claude-sonnet-5-5' }]
  several.models.judges = [{ role: 'jury', provider: 'anthropic', model: 'claude-sonnet-5-5', id: 'frontier-jury-v1:0123456789ab' }]
  assert.deepEqual(rsiCampaignIssues(several), [])
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']) assert.equal(rsiOfflineRoleIssue('improver', { ...OPUS, model }), null, model)
})

test('the solver is DeepSeek; DeepSeek, Qwen or an unpinned model as an improver or a judge is refused by name (the frontier jury, below, is the one exception)', () => {
  /** @type {[(m: ReturnType<typeof manifest>) => void, string][]} */
  const refusals = [
    [m => { m.models.solver = { provider: 'dashscope', model: 'qwen3.8-max' } }, 'campaign_solver_refused'],
    [m => { m.models.solver = { provider: 'anthropic', model: 'claude-opus-5-5' } }, 'campaign_solver_refused'],
    [m => { m.models.improvers = [{ ...OPUS, provider: 'deepseek', model: 'deepseek-v4-pro' }] }, 'campaign_improver_refused'],
    [m => { m.models.improvers = [{ ...OPUS, provider: 'dashscope', model: 'qwen3.8-max' }] }, 'campaign_improver_refused'],
    [m => { m.models.improvers = [{ ...OPUS, model: 'claude' }] }, 'campaign_improver_refused'],
    [m => { m.models.improvers = [{ ...OPUS, model: 'claude-3.5-sonnet' }] }, 'campaign_improver_refused'],
    [m => { m.models.improvers = [{ ...OPUS, provider: 'Anthropic' }] }, 'campaign_improver_refused'],
    [m => { m.models.judges = [{ ...SONNET_JUDGE, provider: 'dashscope', model: 'qwen3.8-max' }] }, 'campaign_judge_refused'],
    [m => { m.models.judges = [{ ...SONNET_JUDGE, provider: 'deepseek', model: 'deepseek-v4-pro' }] }, 'campaign_judge_refused'],
    [m => { m.models.improvers = [{ provider: 'anthropic', model: 'claude-opus-5-5' }] }, 'campaign_model_invalid'],
    [m => { m.models.improvers = [{ ...OPUS, id: 'not-an-improver-field' }] }, 'campaign_model_invalid'],
    [m => { m.models.judges = [{ ...SONNET_JUDGE, id: '' }] }, 'campaign_model_invalid'],
    [m => { /** @type {any} */ (m.models).reviewer = { provider: 'dashscope', model: 'qwen3.8-max' } }, 'campaign_model_invalid'],
  ]
  for (const [mutate, code] of refusals) {
    const input = manifest(); mutate(input); assert.ok(rsiCampaignIssues(input).includes(code), `${code}: ${JSON.stringify(input.models)}`)
  }
})

const QWEN_JURY = { role: 'jury', provider: 'dashscope', model: 'qwen3.8-max', id: 'frontier-jury-v1:7ac3c0f634c5' }
/** The manifest of a surface other than frontier-selection (its kind and target follow the surface; a non-grid surface names an improver, which the manifest() default does).
 * @param {string} surface @param {any[]} judges */
const onSurface = (surface, judges) => {
  const base = manifest(), kind = RSI_CAMPAIGN_SURFACES[/** @type {keyof typeof RSI_CAMPAIGN_SURFACES} */ (surface)].kind
  return { ...base, surface, candidateKind: kind, target: { ...base.target, surface }, models: { ...base.models, judges } }
}

test('the frontier jury is the one non-Claude adjudicator (owner 2026-11-03, after the measurement): Qwen 3.8 Max as a judge with role jury, on frontier-selection and nowhere else', () => {
  assert.deepEqual(RSI_FRONTIER_JURY, { role: 'jury', provider: 'dashscope', model: 'qwen3.8-max', surface: 'frontier-selection' })
  // admitted on its own surface, in the manifest and as a role
  const grid = manifest(); grid.models.improvers = []; grid.models.judges = [{ ...QWEN_JURY }]
  assert.deepEqual(rsiCampaignIssues(grid), [])
  assert.equal(rsiOfflineRoleIssue('judge', QWEN_JURY, 'frontier-selection'), null)
  assert.equal(rsiOfflineRoleIssue('judge', { role: 'jury', provider: 'dashscope', model: 'qwen3.8-max' }, 'frontier-selection'), null, 'its id is optional like any judge\'s')
  // refused on every other surface, in the manifest and as a role
  for (const surface of ['harness-patch', 'tool-patch', 'capability-skill', 'frontier-screen']) {
    assert.ok(rsiCampaignIssues(onSurface(surface, [{ ...QWEN_JURY }])).includes('campaign_judge_refused'), surface)
    assert.equal(rsiOfflineRoleIssue('judge', QWEN_JURY, surface), 'campaign_judge_refused', surface)
  }
  assert.equal(rsiOfflineRoleIssue('judge', QWEN_JURY), 'campaign_judge_refused', 'no surface named, no exception')
  // refused on its own surface when it is not exactly that judge: another role, another Qwen, a DeepSeek model, another provider for the model
  /** @type {any[]} */
  const others = [{ ...QWEN_JURY, role: 'judge' }, { ...QWEN_JURY, role: 'labelling' }, { ...QWEN_JURY, model: 'qwen3.8-plus' }, { ...QWEN_JURY, model: 'qwen3.8-max-preview' }, { ...QWEN_JURY, model: 'qwen-max' },
    { ...QWEN_JURY, provider: 'deepseek', model: 'deepseek-flash' }, { ...QWEN_JURY, provider: 'deepseek', model: 'deepseek-v4-pro' }, { ...QWEN_JURY, provider: 'anthropic' }, { ...QWEN_JURY, provider: 'Dashscope' },
    { ...QWEN_JURY, provider: 'openai', model: 'gpt-5' }]
  for (const judge of others) {
    const input = manifest(); input.models.improvers = []; input.models.judges = [judge]
    assert.ok(rsiCampaignIssues(input).includes('campaign_judge_refused'), JSON.stringify(judge))
    assert.equal(rsiOfflineRoleIssue('judge', judge, 'frontier-selection'), 'campaign_judge_refused', JSON.stringify(judge))
  }
  // a malformed record stays malformed, exception or not
  assert.equal(rsiOfflineRoleIssue('judge', { ...QWEN_JURY, extra: 1 }, 'frontier-selection'), 'campaign_model_invalid')
  assert.equal(rsiOfflineRoleIssue('judge', { ...QWEN_JURY, id: '' }, 'frontier-selection'), 'campaign_model_invalid')
  // one admitted jury does not admit a second, refused judge beside it
  const mixed = manifest(); mixed.models.improvers = []; mixed.models.judges = [{ ...QWEN_JURY }, { role: 'judge', provider: 'dashscope', model: 'qwen3.8-max' }]
  assert.deepEqual(rsiCampaignIssues(mixed), ['campaign_judge_refused'])
})

test('an improver on Qwen is refused everywhere, whatever its role is called and whichever surface it serves', () => {
  for (const surface of ['frontier-selection', 'harness-patch', 'tool-patch', 'capability-skill']) {
    for (const role of ['jury', 'proposing', 'judge']) {
      const improver = { role, provider: 'dashscope', model: 'qwen3.8-max' }
      assert.equal(rsiOfflineRoleIssue('improver', improver, surface), 'campaign_improver_refused', `${surface}/${role}`)
      const input = onSurface(surface, [])
      input.models = { ...input.models, improvers: [improver] }
      assert.ok(rsiCampaignIssues(input).includes('campaign_improver_refused'), `${surface}/${role}`)
    }
  }
  assert.equal(rsiOfflineRoleIssue('improver', { role: 'proposing', provider: 'dashscope', model: 'qwen3.8-max' }), 'campaign_improver_refused')
  // and a Claude judge is still admitted on every surface, the frontier one included
  assert.equal(rsiOfflineRoleIssue('judge', SONNET_JUDGE, 'frontier-selection'), null)
  assert.equal(rsiOfflineRoleIssue('judge', SONNET_JUDGE, 'harness-patch'), null)
})

test('only a registered-grid surface names no improver; an empty judge list is the consumer\'s to accept, and a version-1 manifest is refused', () => {
  assert.deepEqual(RSI_REGISTERED_GRID_SURFACES, ['frontier-selection'])
  const grid = manifest(); grid.models.improvers = []; grid.models.judges = []
  assert.deepEqual(rsiCampaignIssues(grid), [])
  const harness = { ...manifest(), surface: 'harness-patch', candidateKind: 'harness-patch', target: { ...manifest().target, surface: 'harness-patch' } }
  assert.deepEqual(rsiCampaignIssues({ ...harness, models: { ...harness.models, judges: [] } }), [])
  assert.deepEqual(rsiCampaignIssues({ ...harness, models: { ...harness.models, improvers: [] } }), ['campaign_improver_missing'])
  // the shape every manifest had before 2026-11-03: its version and its models are both refused, and nothing reads it as a new campaign
  const old = { ...manifest(), schemaVersion: 1, models: { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improver: { provider: 'none', model: 'registered-grid' }, reviewer: { provider: 'dashscope', model: 'qwen3.8-max' } } }
  assert.deepEqual(rsiCampaignIssues(old), ['campaign_manifest_invalid', 'campaign_model_invalid'])
})

test('frontier-screen and frontier-edit change one class and one policy document, so they are one consumer, and one error budget', () => {
  assert.equal(RSI_CAMPAIGN_SURFACES['frontier-screen'].consumer, RSI_CAMPAIGN_SURFACES['frontier-edit'].consumer)
  assert.notEqual(RSI_CAMPAIGN_SURFACES['frontier-edit'].consumer, RSI_CAMPAIGN_SURFACES['frontier-selection'].consumer)
})

test('the harness-patch and tool-patch surfaces are two registered shadow surfaces of one consumer (the runtime image, so one error budget), each with its own kind, and a manifest names the kind of its own surface', () => {
  assert.deepEqual(RSI_CAMPAIGN_SURFACES['harness-patch'], { kind: 'harness-patch', consumer: 'dsh-harness', activation: 'shadow' })
  assert.deepEqual(RSI_CAMPAIGN_SURFACES['tool-patch'], { kind: 'tool-patch', consumer: 'dsh-harness', activation: 'shadow' })
  const harness = { ...manifest(), surface: 'harness-patch', candidateKind: 'harness-patch', target: { ...manifest().target, surface: 'harness-patch' } }
  assert.deepEqual(rsiCampaignIssues(harness), [])
  const tool = { ...manifest(), surface: 'tool-patch', candidateKind: 'tool-patch', target: { ...manifest().target, surface: 'tool-patch' } }
  assert.deepEqual(rsiCampaignIssues(tool), [])
  // a tool-patch manifest with a harness-patch kind, or the other way round, is another surface's candidate
  assert.ok(rsiCampaignIssues({ ...tool, candidateKind: 'harness-patch' }).includes('campaign_surface_invalid'))
  assert.ok(rsiCampaignIssues({ ...harness, candidateKind: 'tool-patch' }).includes('campaign_surface_invalid'))
  assert.ok(rsiCampaignIssues({ ...tool, target: { ...tool.target, surface: 'harness-patch' } }).includes('campaign_target_invalid'))
})

test('one authorized incident is eligible without a five-account gate, with explicit source authority', () => {
  const input = manifest()
  input.data.classification = 'authorized-incident'
  assert.ok(rsiCampaignIssues(input).includes('campaign_incident_authority_missing'))
  input.data.authorization = { id: 'agreement-1', incidentId: 'incident-1', incidentDigest: digest, sourceRunId: 'run-1', sourceRevision: 'revision-1', purpose: 'platform-quality', minimized: true }
  assert.deepEqual(rsiCampaignIssues(input), [])
})

test('unbound Alibaba resources fail explicitly and never fall back to production', () => {
  assert.deepEqual(rsiLabBindingIssues({}), ['campaign_host_unavailable', 'campaign_transport_unavailable', 'campaign_signer_unavailable'])
  const binding = { host: { provider: 'alibaba', instanceId: 'i-lab', region: 'cn-beijing', purpose: 'rsi-lab' },
    transport: { incidentBucket: 'rsi-input', bundleBucket: 'rsi-output', endpoint: 'https://oss-cn-beijing.aliyuncs.com', region: 'cn-beijing' },
    signer: { keyId: 'lab-signing-1', publicKeySha256: digest } }
  assert.deepEqual(rsiLabBindingIssues(binding), [])
  binding.transport.bundleBucket = 'rsi-input'
  assert.ok(rsiLabBindingIssues(binding).includes('campaign_transport_unavailable'))
  binding.host.purpose = 'production'
  assert.ok(rsiLabBindingIssues(binding).includes('campaign_host_unavailable'))
})

test('compatibility depends on affected closure and baseline, not the whole image or unrelated release', () => {
  const target = { ...manifest().target, sourceRevision: 'old', imageDigest: 'old-image' }
  const current = { ...target, sourceRevision: 'new-ui-only', imageDigest: 'new-image' }
  assert.deepEqual(rsiCompatibilityIssues(target, current), [])
  assert.deepEqual(rsiCompatibilityIssues(target, { ...current, dependencyDigest: 'b'.repeat(64) }), ['campaign_dependency_changed'])
  assert.deepEqual(rsiCompatibilityIssues(target, { ...current, baselineRevision: 'next' }), ['campaign_baseline_changed'])
  assert.ok(rsiCompatibilityIssues({}, {}).includes('campaign_target_invalid'))
})

test('reserve-before-spend uses finite money and accounts for outstanding reservations', () => {
  const input = { campaignActualCny: 900, campaignReservedCny: 50, monthActualCny: 29900, monthReservedCny: 50, requestCny: 50 }
  assert.equal(rsiBudgetAdmission(input).admitted, true)
  assert.equal(rsiBudgetAdmission({ ...input, requestCny: 50.01 }).admitted, false)
  assert.equal(rsiBudgetAdmission({ ...input, monthReservedCny: 51 }).reason, 'campaign_month_budget_exceeded')
  assert.equal(rsiBudgetAdmission({ ...input, campaignActualCny: 10, campaignReservedCny: 0 }, { campaignCny: 20, monthCny: 30000 }).admitted, false)
  assert.equal(rsiBudgetAdmission({ campaignActualCny: 0, campaignReservedCny: 0, monthActualCny: 0, monthReservedCny: 0, requestCny: 1e-8 }, { campaignCny: 1e-10, monthCny: 30000 }).admitted, false)
  for (const value of [NaN, Infinity, -1, '0', null]) assert.equal(rsiBudgetAdmission({ ...input, campaignActualCny: value }).reason, 'campaign_budget_unknown')
})

test('monthly accounting uses Beijing calendar boundaries, not a rolling thirty days', () => {
  assert.equal(rsiCampaignMonth('2026-10-31T15:59:59Z'), '2026-10')
  assert.equal(rsiCampaignMonth('2026-10-31T16:00:00Z'), '2026-11')
  assert.throws(() => rsiCampaignMonth('2026-11-01T00:00:00'), /explicit timezone/)
})
