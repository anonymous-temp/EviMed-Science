// 「循证传播」's evidence chain, the card side (flywheel F21, F28): a project's claims become the cards of its product zone —
// only the claims the card's own ruler marks ✓, one card per clinical question on the patient journey, every closed word
// from the domain's vocabulary, nothing typed by hand.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GEO_COMPARISON_EVIDENCE_TYPES,
  GEO_COMPARISON_EVIDENCE_TYPE_LABELS_ZH,
  evidenceCardClaims,
  evidenceCardClinicalView,
  evidenceCardPublicView,
  evidenceProducer,
  evidencePublicViewContent,
  evidenceWriteAllowed,
  isFeedEligibleCard,
  isFeedEligibleZone,
  geoCardClaimId,
  geoCardPlan,
  geoCardProducer,
  geoClaimJourneyStage,
  geoComparisonEvidenceType,
  geoDisclosurePerson,
  geoProducerSettingsIssues,
  geoSourceUrl,
  normalizeGeoProducerSettings,
  verifyEvidenceCardClaims,
} from '../index.mjs'

const NOW = new Date('2026-10-06T08:00:00Z')
const LABEL_TEXT = '【用法用量】成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg。【禁忌】对本品活性成分或辅料过敏者禁用。'
const TRIAL_TEXT = 'In the randomized trial, participants on the drug lost 14.1% of body weight at week 48 versus 2.3% with placebo.'
const producer = { kind: 'enterprise', name: '某某制药有限公司', relation: 'own_product', products: ['信尔美'] }
const authors = [{ name: '王编辑' }]
const reviewers = [{ name: '李医生', affiliation: '某某医院 内分泌科' }]

/** @param {Record<string, any>} over @returns {any} */
const claim = (over) => ({
  id: `gcl_${over.claimKey}`,
  statement: '成人推荐起始剂量为每周一次 2.5 mg。',
  quote: '成人推荐起始剂量为每周一次 2.5 mg',
  sourceRef: '信尔美说明书 2025 版',
  sourceLabel: '信尔美说明书（国家药监局 2025）',
  sourceKind: 'label',
  inLabel: true,
  status: 'active',
  sourceText: LABEL_TEXT,
  ...over,
})

test('only the claims the card ruler marks verified are written, the rest are held with the reason', () => {
  const { cards, held } = geoCardPlan({
    claims: [
      claim({ claimKey: 'dose' }),
      claim({ claimKey: 'not-there', quote: '每日三次，每次 10 mg' }),
      claim({ claimKey: 'unreadable', sourceText: null }),
      claim({ claimKey: 'retired', status: 'retired' }),
      claim({ claimKey: 'old', validUntil: '2026-01-01T00:00:00Z' }),
      claim({ claimKey: 'no-quote', quote: ' ' }),
    ],
    producer, authors, reviewers, now: NOW,
  })
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].map.map((entry) => entry.claimKey), ['dose'])
  assert.deepEqual(Object.fromEntries(held.map((entry) => [entry.claimKey, entry.reason])), {
    'not-there': 'quote_not_found', unreadable: 'source_unavailable', retired: 'claim_not_active', old: 'claim_expired', 'no-quote': 'no_quote',
  })
  for (const entry of held) assert.ok(entry.message.length > 4, entry.claimKey)
})

test('the card the plan makes is a card the contract accepts and its own ✓ agrees with the ruler that admitted the claim', () => {
  const { cards } = geoCardPlan({ claims: [claim({ claimKey: 'dose' }), claim({ claimKey: 'trial:weight', statement: '第 48 周体重下降 14.1%。', quote: 'lost 14.1% of body weight at week 48', sourceRef: '10.1056/NEJMoa0000000', sourceLabel: '关键试验', sourceKind: 'trial', sourceText: TRIAL_TEXT, inLabel: false, journeyStage: '治疗选择', clinicalQuestion: '用药后体重能降多少？', comparisonType: 'unanchored_reference' })], producer, authors, reviewers, now: NOW })
  assert.equal(cards.length, 2, 'one card per clinical question: the label stage and the treatment-choice stage')
  const trial = cards.find((card) => card.journeyStage.key === '治疗选择')
  assert.ok(trial)
  const payload = trial.payload
  // The card contract accepts every field the plan wrote.
  assert.equal(evidenceCardClaims(payload.claims, payload.sources.length).length, 1)
  assert.ok(evidenceProducer(payload.producer))
  assert.ok(evidencePublicViewContent(payload.publicView, payload.claims) === null)
  assert.equal(payload.sources[0].url, 'https://doi.org/10.1056/NEJMoa0000000')
  assert.equal(payload.sources[0].coverage, 'full-text')
  assert.equal(payload.claims[0].claimId, 'trial-weight', 'a claim key with a colon becomes a legal card claim id')
  assert.match(payload.claims[0].applicability, /比较证据类型：无锚定的比较，仅供参考/)
  const verdict = verifyEvidenceCardClaims({ claims: payload.claims, sources: payload.sources })
  assert.deepEqual(verdict.claims.map((entry) => entry.mark), ['✓'])
  // Numbers are the claim's own: nothing the plan wrote contains a figure that is not in the claim or its quotation.
  const figures = (/** @type {string} */ value) => value.match(/\d+(?:\.\d+)?/g) ?? []
  const allowed = new Set(figures(`${payload.claims[0].claim} ${payload.claims[0].supportQuote}`))
  for (const figure of figures(JSON.stringify([payload.title, payload.summary, payload.body, payload.content, payload.publicView]).replace(/\\n/g, ' ').replace(/\d+ 条/, ''))) assert.ok(allowed.has(figure), figure)
  assert.equal(evidenceCardClinicalView({ ...payload, sources: payload.sources }).claims.length, 1)
  assert.equal(evidenceCardPublicView({ ...payload, sources: payload.sources }).factBox.status, 'unavailable', 'no comparison row is invented')
})

test('the public view says what the label says from the in-label claims, joined by code', () => {
  const { cards } = geoCardPlan({ claims: [claim({ claimKey: 'a-dose' }), claim({ claimKey: 'b-contra', statement: '对本品活性成分或辅料过敏者禁用。', quote: '对本品活性成分或辅料过敏者禁用' })], producer, authors, reviewers, now: NOW })
  assert.equal(cards.length, 1)
  const { labelSays } = cards[0].payload.publicView
  assert.equal(labelSays.text, '成人推荐起始剂量为每周一次 2.5 mg。；对本品活性成分或辅料过敏者禁用。')
  assert.deepEqual(labelSays.claimIds, ['a-dose', 'b-contra'])
  assert.deepEqual(cards[0].journeyStage, { key: 'label', label: '说明书与基本信息' })
})

test('the same input gives the same plan, in the same order, whatever order the claims arrive in', () => {
  const claims = [claim({ claimKey: 'b' }), claim({ claimKey: 'a' }), claim({ claimKey: 'c', clinicalQuestion: '另一个问题' })]
  const first = geoCardPlan({ claims, producer, authors, reviewers, now: NOW })
  const second = geoCardPlan({ claims: [...claims].reverse(), producer, authors, reviewers, now: NOW })
  assert.deepEqual(first, second)
})

test('card claim ids are legal, stable and unique inside a card', () => {
  const taken = new Set()
  assert.equal(geoCardClaimId('dose:adult', taken), 'dose-adult')
  assert.equal(geoCardClaimId('dose-adult', taken), 'dose-adult-2')
  assert.equal(geoCardClaimId('::', taken), 'claim')
  assert.equal(geoCardClaimId('x'.repeat(100), taken).length, 54)
})

test('the comparison evidence types are a closed list with a label each', () => {
  assert.deepEqual([...GEO_COMPARISON_EVIDENCE_TYPES], ['head_to_head', 'anchored_indirect', 'unanchored_reference'])
  for (const type of GEO_COMPARISON_EVIDENCE_TYPES) assert.ok(/** @type {Record<string, string>} */ (GEO_COMPARISON_EVIDENCE_TYPE_LABELS_ZH)[type])
  assert.equal(geoComparisonEvidenceType(' head_to_head '), 'head_to_head')
  assert.equal(geoComparisonEvidenceType('network_meta'), null)
  assert.equal(geoComparisonEvidenceType(null), null)
})

test('producer settings: a kind from the closed list, a doctor named, the relation defaulted by kind', () => {
  assert.deepEqual(geoProducerSettingsIssues({ kind: 'agency' }), ['producer.kind is one of enterprise, doctor'])
  assert.match(geoProducerSettingsIssues({ kind: 'doctor' })[0], /names the doctor/)
  assert.match(geoProducerSettingsIssues({ kind: 'enterprise', salary: 1 })[0], /not a setting/)
  assert.match(geoProducerSettingsIssues({ kind: 'enterprise', relation: 'sponsor' })[0], /relation is one of/)
  assert.equal(normalizeGeoProducerSettings({ kind: 'enterprise' }).relation, 'own_product')
  assert.deepEqual(normalizeGeoProducerSettings({ kind: 'doctor', name: ' 张医生 ', hospital: '某某医院', specialty: '内分泌' }),
    { kind: 'doctor', name: '张医生', relation: 'user_of_therapy', hospital: '某某医院', specialty: '内分泌' })
  assert.throws(() => normalizeGeoProducerSettings({ kind: 'doctor' }), (error) => Array.isArray(/** @type {any} */ (error).issues))
})

test('an enterprise is named by its settings, else by the holder the run verified; with neither no card is made', () => {
  assert.deepEqual(geoCardProducer({ kind: 'enterprise' }, { holder: '某某制药', brandName: '信尔美', genericName: '玛仕度肽' }),
    { kind: 'enterprise', name: '某某制药', relation: 'own_product', products: ['信尔美', '玛仕度肽'] })
  assert.equal(geoCardProducer({ kind: 'enterprise', name: '设定的公司' }, { holder: '某某制药' })?.name, '设定的公司')
  assert.equal(geoCardProducer({ kind: 'enterprise' }, { brandName: '信尔美' }), null)
  assert.equal(geoCardProducer(null, { holder: 'x' }), null)
  assert.equal(geoCardProducer({ kind: 'doctor', name: '张医生' }, {})?.relation, 'user_of_therapy')
})

test('a doctor is shown by hospital, department and specialty', () => {
  assert.deepEqual(geoDisclosurePerson({ name: '张医生', hospital: '某某医院', department: '内分泌科', specialty: '糖尿病', title: '主任医师' }),
    { name: '张医生', affiliation: '某某医院 内分泌科', title: '主任医师 · 糖尿病' })
  assert.deepEqual(geoDisclosurePerson({ name: '王编辑' }), { name: '王编辑' })
})

test('a journey stage is read from the label the question map writes, or an object, or not at all', () => {
  assert.deepEqual(geoClaimJourneyStage('治疗选择'), { key: '治疗选择', label: '治疗选择' })
  assert.deepEqual(geoClaimJourneyStage({ key: 'dx', label: '诊断' }), { key: 'dx', label: '诊断' })
  assert.equal(geoClaimJourneyStage(''), null)
  assert.equal(geoClaimJourneyStage({ key: 'bad key!', label: 'x' }), null)
})

test('a source reference becomes an address only when it is one', () => {
  assert.equal(geoSourceUrl('doi:10.1056/NEJMoa2206038'), 'https://doi.org/10.1056/NEJMoa2206038')
  assert.equal(geoSourceUrl('PMID: 12345678'), 'https://pubmed.ncbi.nlm.nih.gov/12345678/')
  assert.equal(geoSourceUrl('NCT04567890'), 'https://clinicaltrials.gov/study/NCT04567890')
  assert.equal(geoSourceUrl('https://example.org/label.pdf'), 'https://example.org/label.pdf')
  assert.equal(geoSourceUrl('信尔美说明书 2025 版'), null)
})

test('the product zone takes writes from its owner and from the project, and from no one else', () => {
  const base = { zoneKind: 'product', actorIsZoneOwner: true, actorIsPlatformPublisher: false }
  assert.equal(evidenceWriteAllowed({ ...base, origin: 'geo' }).allowed, true)
  assert.equal(evidenceWriteAllowed({ ...base, origin: 'owner' }).allowed, true)
  assert.equal(evidenceWriteAllowed({ ...base, origin: 'geo', actorIsZoneOwner: false }).allowed, false, 'another account may not write a project into this zone')
  for (const origin of ['import', 'model', 'programme', 'result']) assert.equal(evidenceWriteAllowed({ ...base, origin }).allowed, false, origin)
  // And the project writes into no other kind of zone: not the platform's, not a researcher's.
  assert.equal(evidenceWriteAllowed({ zoneKind: 'official', origin: 'geo', actorIsZoneOwner: true, actorIsPlatformPublisher: true }).allowed, false)
  assert.equal(evidenceWriteAllowed({ zoneKind: 'user', origin: 'geo', actorIsZoneOwner: true, actorIsPlatformPublisher: false }).allowed, false)
})

test('product-zone content never enters the frontier feed: the guard the feed reads', () => {
  assert.equal(isFeedEligibleZone({ kind: 'product' }), false)
  assert.equal(isFeedEligibleZone({ kind: 'official' }), true)
  assert.equal(isFeedEligibleZone({ kind: 'user' }), true)
  assert.equal(isFeedEligibleZone(null), false)
  assert.equal(isFeedEligibleZone({ kind: 'unheard-of' }), false, 'a kind the guard does not know is not carried')
  assert.equal(isFeedEligibleCard({ kind: 'product' }, { originality: 'original_research' }), false, 'not even first-hand work')
  assert.equal(isFeedEligibleCard({ kind: 'user' }, { originality: 'synthesis' }), false)
  assert.equal(isFeedEligibleCard({ kind: 'user' }, { originality: 'original_research' }), true)
  assert.equal(isFeedEligibleCard({ kind: 'official' }, { originality: 'brief' }), true)
})
