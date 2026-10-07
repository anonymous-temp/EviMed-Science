// 「循证 GEO」's evidence chain, the card side (flywheel F21, F28): a project's claims become the cards of its product zone —
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
  geoCardLayerMarkdown,
  geoCardPlan,
  geoCardProducer,
  geoClaimJourneyStage,
  geoClaimReferenceMarker,
  geoComparisonEvidenceType,
  geoDisclosurePerson,
  geoNumberTokens,
  geoProducerSettingsIssues,
  geoPublishableText,
  GEO_AI_LABEL_ZH,
  geoReferenceGraph,
  geoSentences,
  geoSourceUrl,
  geoStaleReferences,
  parseGeoClaimReferences,
  stripGeoClaimReferences,
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
  assert.equal(labelSays.text, '成人推荐起始剂量为每周一次 2.5 mg。对本品活性成分或辅料过敏者禁用。')
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

// ---------------------------------------------------------------------------------------------------------------------------
// The lower layers cite the cards

const CARD = 'ec_AbCd1234Ef'
/** The cards the graph resolves against: this card at revisions 1 (an old claim text) and 2 (the current one). */
const CARDS = {
  [CARD]: {
    currentRevision: 2,
    withdrawn: false,
    revisions: {
      1: { dose: { claim: '成人推荐起始剂量为每周一次 2.5 mg。', supportQuote: '成人推荐起始剂量为每周一次 2.5 mg', mark: '✓' } },
      2: {
        dose: { claim: '成人推荐起始剂量为每周一次 2.5 mg，4 周后增至 5 mg。', supportQuote: '2.5 mg，4 周后增至 5 mg', mark: '✓' },
        weight: { claim: '第 48 周体重下降 14.1%。', supportQuote: 'lost 14.1% of body weight at week 48', applicability: '比较证据类型：头对头比较', mark: '✓' },
        shaky: { claim: '另一个结论，样本量 1,200 人。', supportQuote: '1,200', mark: '⚠' },
      },
    },
  },
}
/** @param {{ cardId: string, revision: number }} reference */
const resolve = (reference) => {
  const card = /** @type {any} */ (CARDS)[reference.cardId]
  if (!card) return null
  return { currentRevision: card.currentRevision, withdrawn: card.withdrawn, claims: card.revisions[reference.revision] ?? null }
}
const ref = (/** @type {string} */ claimId, revision = 2, cardId = CARD) => geoClaimReferenceMarker({ cardId, claimId, revision })

test('a reference is a marker after the sentence; stripping it leaves the published text byte for byte', () => {
  const text = `起始剂量为每周一次 2.5 mg。${ref('dose')}\n\n4 周后增至 5 mg${ref('dose')}。 \n没有引用的一句。`
  assert.deepEqual(parseGeoClaimReferences(text).map(({ cardId, claimId, revision }) => [cardId, claimId, revision]), [[CARD, 'dose', 2], [CARD, 'dose', 2]])
  assert.equal(stripGeoClaimReferences(text), '起始剂量为每周一次 2.5 mg。\n\n4 周后增至 5 mg。\n没有引用的一句。')
  assert.equal(stripGeoClaimReferences('无引用的文字 14.1%。 \n'), '无引用的文字 14.1%。\n')
  assert.deepEqual(parseGeoClaimReferences('[[ref:notacard/x@1]] [[ref:ec_AbCd1234Ef/x@0]] [[ref:ec_AbCd1234Ef/x@1]]').length, 1, 'a marker of the wrong shape is not a reference')
})

test('sentences end at closing punctuation or a line, a marker after the full stop belongs to the sentence before, a decimal point is not a full stop', () => {
  const sentences = geoSentences(`每周一次 2.5 mg。${ref('dose')}下一句 14.1% 的人体重下降${ref('weight')}。\n- 列表项 3 个。\n结尾没有标点`)
  assert.deepEqual(sentences.map((entry) => entry.text), ['每周一次 2.5 mg。', '下一句 14.1% 的人体重下降。', '- 列表项 3 个。', '结尾没有标点'])
  assert.deepEqual(sentences.map((entry) => entry.references.map((/** @type {any} */ reference) => reference.claimId)), [['dose'], ['weight'], [], []])
})

test('numbers are read as values; a date, an address and a list number are not numbers a claim must support', () => {
  assert.deepEqual(geoNumberTokens('1. 每周 2.50 mg，共 1,200 人，14.1%'), [2.5, 1200, 14.1])
  assert.deepEqual(geoNumberTokens('说明书 2025 年 9 月 28 日版见 https://example.org/a/12345 与 2025-09-28'), [])
  assert.deepEqual(geoNumberTokens('## 第 3 步'), [3])
})

test('every cited claim must exist in the card revision it cites: the one rule over the reference graph', () => {
  const clean = geoReferenceGraph({ layer: 'popular', resolve,
    text: `成人起始剂量为每周一次 2.5 mg，4 周后增至 5 mg。${ref('dose')}\n第 48 周体重下降 14.1%。${ref('weight')}\n` })
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.issues, [])
  assert.deepEqual(clean.counts, { sentences: 2, referencedSentences: 2, references: 2, unresolved: 0, unverified: 0, numberUnsupported: 0, numberedWithoutReference: 0, malformed: 0 })
  const bad = geoReferenceGraph({ layer: 'popular', resolve, text: [
    `这句话引了一个不存在的结论。${ref('nope')}`,
    `这句话引了一个不存在的版本。${ref('dose', 9)}`,
    `这句话引了别人的卡片。${ref('dose', 2, 'ec_OtherCard99')}`,
    `这句话引了旧版本里的结论。${ref('weight', 1)}`,
  ].join('\n') })
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.references.map((entry) => entry.status), ['claim_not_in_revision', 'revision_not_found', 'card_not_found', 'claim_not_in_revision'])
  assert.equal(bad.counts.unresolved, 4)
  assert.deepEqual([...new Set(bad.issues.map((issue) => issue.code))], ['claim_reference_unresolved'])
  for (const issue of bad.issues) assert.equal(issue.severity, 'advisory', 'a label, never a block')
})

test('a number in a cited sentence must be one of the claim it cites, and a numbered sentence with no reference is named', () => {
  const result = geoReferenceGraph({ layer: 'qa', resolve, text: [
    `第 48 周体重下降 18.5%。${ref('weight')}`,
    `4 周后增至 5 mg，每周一次。${ref('dose')}`,
    `吃药后有 3 成的人会恶心。`,
    `这是一句没有数字的话。`,
  ].join('\n') })
  assert.deepEqual(result.issues.map((issue) => issue.code), ['sentence_number_not_in_claim', 'numbered_sentence_without_reference'])
  assert.match(result.issues[0].message, /18\.5/)
  assert.equal(result.counts.numberUnsupported, 1)
  assert.equal(result.counts.numberedWithoutReference, 1)
  // The deep analysis is the clinical layer's own prose: it is not asked to cite sentence by sentence.
  assert.deepEqual(geoReferenceGraph({ layer: 'deep', resolve, text: '共 1,200 人入组。' }).issues, [])
})

test('a claim the card marks unverified, and a malformed marker, are named; a withdrawn card is resolved and left to the staleness notice', () => {
  const unverified = geoReferenceGraph({ layer: 'popular', resolve, text: `样本量 1,200 人。${ref('shaky')}` })
  assert.deepEqual(unverified.issues.map((issue) => issue.code), ['claim_reference_unverified'])
  assert.equal(unverified.counts.unverified, 1)
  const malformed = geoReferenceGraph({ layer: 'popular', resolve, text: '一句话。[[ref:ec_AbCd1234Ef/dose]]' })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.counts.malformed, 1)
  const withdrawn = geoReferenceGraph({ layer: 'popular', text: `每周一次。${ref('dose')}`, resolve: (reference) => ({ ...(/** @type {any} */ (resolve(reference))), withdrawn: true }) })
  assert.equal(withdrawn.ok, true)
  assert.equal(withdrawn.references[0].status, 'card_withdrawn')
})

test('an article that cites a revision since corrected, updated in its conclusion or withdrawn is flagged; an older entry or another claim is not', () => {
  const references = [{ cardId: CARD, claimId: 'dose', revision: 1 }, { cardId: CARD, claimId: 'weight', revision: 2 }]
  const entries = [
    { cardId: CARD, category: 'correction', revisionAfter: 2, occurredAt: '2026-10-07T00:00:00Z', summary: '修正了该条结论', refs: { claimId: 'dose' } },
    { cardId: CARD, category: 'new_evidence_conclusion_unchanged', revisionAfter: 3, occurredAt: '2026-10-08T00:00:00Z', summary: '结论未变' },
    { cardId: CARD, category: 'correction', revisionAfter: 2, occurredAt: '2026-10-07T00:00:00Z', summary: '修正', refs: { claimId: 'other' } },
    { cardId: 'ec_Elsewhere1', category: 'withdrawal', revisionAfter: null, occurredAt: '2026-10-09T00:00:00Z', summary: '撤回' },
  ]
  assert.deepEqual(geoStaleReferences(references, entries).map((entry) => [entry.claimId, entry.revision, entry.category]), [['dose', 1, 'correction']],
    'weight@2 is current; the unchanged-conclusion entry and the other card are not corrections of what was cited')
  // A withdrawal is stale whatever revision was cited.
  assert.equal(geoStaleReferences([{ cardId: CARD, claimId: 'weight', revision: 5 }], [{ cardId: CARD, category: 'withdrawal', revisionAfter: null, occurredAt: '2026-10-09T00:00:00Z', summary: '撤回' }]).length, 1)
  assert.deepEqual(geoStaleReferences(references, []), [])
})

test('the card layer is the card: its public view in Markdown, the fact box computed from events and one denominator', () => {
  const view = {
    kind: 'public',
    header: { title: '用药后体重能降多少？', producer: { name: '某某制药有限公司' } },
    panels: [
      { key: 'oneLineAnswer', label: '一句话回答', status: 'written', text: '第 48 周体重平均下降 14.1%。', claimIds: ['weight'] },
      { key: 'whatItIs', label: '这是什么', status: 'missing', text: null, claimIds: [] },
      { key: 'sourcesAndCheckDate', label: '来源和核对日期', status: 'written', sources: [{ title: '关键试验', url: 'https://doi.org/10.1056/x' }], checkedAt: '2026-10-06T08:00:00.000Z' },
    ],
    factBox: { status: 'available', per: 1000, unit: 'people',
      benefits: [{ outcome: '体重下降 5% 以上', timeframe: '48 周', control: { per1000: 180 }, intervention: { per1000: 870 }, difference: 690 }], harms: [], excluded: [] },
  }
  const published = geoCardLayerMarkdown({ view, card: { id: CARD, revision: 2 } })
  assert.match(published, /^# 用药后体重能降多少？\n/)
  assert.match(published, /## 一句话回答\n\n第 48 周体重平均下降 14\.1%。\n/)
  assert.doesNotMatch(published, /这是什么/, 'a panel the author left empty is not shown as a heading with nothing under it')
  assert.match(published, /\| 获益：体重下降 5% 以上（48 周） \| 180 \| 870 \| 690 \|/)
  assert.match(published, /核对日期：2026-10-06/)
  const cited = geoCardLayerMarkdown({ view, card: { id: CARD, revision: 2 }, withReferences: true })
  assert.ok(cited.includes(ref('weight')))
  assert.equal(stripGeoClaimReferences(cited), published, 'with the markers stripped, the cited text is the published text')
  assert.deepEqual(geoReferenceGraph({ layer: 'card', resolve, text: cited }).issues, [])
})

test('an article leaves with its references off, its author named, the relation to the product said and the AI label — and its own words untouched', () => {
  const text = `起始剂量为每周一次 2.5 mg。${ref('dose')}\n第二段说明。${ref('weight')}\n`
  const doctor = geoPublishableText({ text, producer: { kind: 'doctor', name: '张医生', relation: 'user_of_therapy' },
    person: { name: '张医生', affiliation: '某某医院 内分泌科', title: '主任医师 · 糖尿病' } })
  assert.equal(doctor, `起始剂量为每周一次 2.5 mg。\n第二段说明。\n\n作者：张医生\u3000某某医院 内分泌科\u3000主任医师 · 糖尿病\n与产品的关系：出品方是该疗法的使用者\n${GEO_AI_LABEL_ZH}\n`)
  const company = geoPublishableText({ text: '一句话。', producer: { kind: 'enterprise', name: '某某制药有限公司', relation: 'own_product' } })
  assert.match(company, /出品：某某制药有限公司\n与产品的关系：涉及出品方自己的产品\n/)
  assert.ok(company.endsWith(`${GEO_AI_LABEL_ZH}\n`), 'a draft a run wrote always carries the label')
  const none = geoPublishableText({ text: '一句话。', producer: { kind: 'enterprise', name: '某某', relation: 'none' }, aiGenerated: false })
  assert.equal(none, '一句话。\n\n出品：某某\n', 'no relation line where there is none, and no label on text no AI wrote')
})
