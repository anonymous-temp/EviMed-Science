/**
 * 「循证传播」 as one evidence chain (flywheel plan §5.6, F21, F28, 2026-10-06):
 * the project's verified claims become evidence cards in its product zone, and
 * every sentence of a lower layer cites a claim of a card revision.
 *
 * Hidden knowledge:
 *
 * - **The project keeps its claim table; the card is what leaves it.** A claim
 *   row of `evimed_geo.claims` is the working index a run writes. A card of the
 *   product zone is the unit the platform shows, versions and corrects. Only a
 *   claim the card's own ruler marks ✓ (`verifyEvidenceCardClaims`, the call
 *   the delivery gate and the reader's ✓/⚠ share) is written into a card; one
 *   it marks ⚠ stays in the project and is reported as held, with the reason —
 *   never silently dropped and never published.
 * - **Numbers come from the claim's own words.** A card built here carries no
 *   comparison row and no typed figure: a claim is its statement, its verbatim
 *   quotation and its source, and the public view's 「说明书怎么说」 panel is the
 *   statements of the in-label claims, joined by code. A figure a model wrote
 *   into an article is traced to the claim it cites by `geoReferenceIssues`.
 * - **One closed vocabulary for how a difference is known.** A product's
 *   differentiation claims say whether the comparison was head to head,
 *   anchored through a common comparator, or unanchored and only for
 *   reference (`GEO_COMPARISON_EVIDENCE_TYPES`). The HTA methodological
 *   guidance treats an unanchored indirect comparison as resting on an
 *   assumption that very rarely holds, so the label is part of the claim a
 *   reader sees, written by code from the word and not by the model's phrasing.
 * - **Every card names a producer and who stands behind it.** The producer is
 *   an enterprise or a doctor with the stated relation to the product, and
 *   the disclosure block carries real named authors and reviewers; the card
 *   contract refuses a product-zone card without them
 *   (`assertEvidenceCardForZone`), and this file only shapes the people it is
 *   given.
 *
 * Zero dependencies beyond this package, like the rest of it.
 *
 * @module @evimed/domain/geoEvidenceChain
 */

import {
  EVIDENCE_PRODUCER_RELATIONS,
  EVIDENCE_PRODUCER_RELATION_LABELS_ZH,
  EVIDENCE_PUBLIC_PANEL_LIMITS,
  evidenceJourneyStage,
  evidenceOriginalityIsPrimary,
  evidencePublicExcerpt,
  verifyEvidenceCardClaims,
} from './evidenceCard.mjs'

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * How a difference between the product and a comparator is known, in the order
 * of how much it can bear: a randomized head-to-head comparison, an indirect
 * comparison anchored on a common comparator, and an unanchored comparison
 * that is shown only so a reader can see what it is.
 */
export const GEO_COMPARISON_EVIDENCE_TYPES = frozen(['head_to_head', 'anchored_indirect', 'unanchored_reference'])
export const GEO_COMPARISON_EVIDENCE_TYPE_LABELS_ZH = Object.freeze({
  head_to_head: '头对头比较',
  anchored_indirect: '锚定的间接比较',
  unanchored_reference: '无锚定的比较，仅供参考',
})

/**
 * The comparison evidence type a value names, or null. A word outside the list
 * is not guessed at.
 * @param {unknown} value @returns {string | null}
 */
export function geoComparisonEvidenceType(value) {
  return typeof value === 'string' && GEO_COMPARISON_EVIDENCE_TYPES.includes(value.trim()) ? value.trim() : null
}

/** Who makes a product-zone card: a company, or a doctor speaking about their own specialty. */
export const GEO_PRODUCER_KINDS = frozen(['enterprise', 'doctor'])
export const GEO_PRODUCER_KIND_LABELS_ZH = Object.freeze({ enterprise: '企业', doctor: '医生' })
/** The relation each kind has until its project says otherwise. */
export const GEO_DEFAULT_PRODUCER_RELATION = Object.freeze({ enterprise: 'own_product', doctor: 'user_of_therapy' })

/** The keys of a project's producer settings. */
const PRODUCER_KEYS = ['kind', 'name', 'relation', 'hospital', 'department', 'specialty', 'title']
/** A longest value of each. */
const PRODUCER_LIMITS = Object.freeze({ name: 200, hospital: 200, department: 120, specialty: 120, title: 120 })

/**
 * What is wrong with a project's producer settings, as codes: the settings are
 * how a card says who is speaking, so a kind outside the closed list or a
 * doctor without a name is refused for this write and the rest of the project
 * is untouched.
 * @param {unknown} value @returns {string[]}
 */
export function geoProducerSettingsIssues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['producer is an object']
  const record = /** @type {Record<string, unknown>} */ (value)
  /** @type {string[]} */
  const issues = []
  for (const key of Object.keys(record)) if (!PRODUCER_KEYS.includes(key)) issues.push(`producer.${key} is not a setting`)
  if (!GEO_PRODUCER_KINDS.includes(/** @type {any} */ (record.kind))) issues.push(`producer.kind is one of ${GEO_PRODUCER_KINDS.join(', ')}`)
  if (record.relation != null && !EVIDENCE_PRODUCER_RELATIONS.includes(/** @type {any} */ (record.relation))) {
    issues.push(`producer.relation is one of ${EVIDENCE_PRODUCER_RELATIONS.join(', ')}`)
  }
  for (const [key, max] of Object.entries(PRODUCER_LIMITS)) {
    const entry = record[key]
    if (entry != null && (typeof entry !== 'string' || [...entry.trim()].length > max)) issues.push(`producer.${key} is text of at most ${max} characters`)
  }
  if (record.kind === 'doctor' && !(typeof record.name === 'string' && record.name.trim())) issues.push('a doctor project names the doctor (producer.name)')
  return issues
}

/**
 * The settings in their stored shape: trimmed, the relation defaulted by kind,
 * nothing added. Throws a `TypeError` whose `issues` lists what
 * `geoProducerSettingsIssues` found, so a caller that has not validated learns
 * why.
 * @param {unknown} value
 * @returns {{ kind: 'enterprise' | 'doctor', name: string | null, relation: string, hospital?: string, department?: string, specialty?: string, title?: string }}
 */
export function normalizeGeoProducerSettings(value) {
  const issues = geoProducerSettingsIssues(value)
  if (issues.length) throw Object.assign(new TypeError(`Invalid producer settings: ${issues.join('; ')}.`), { issues })
  const record = /** @type {Record<string, any>} */ (value)
  const kind = /** @type {'enterprise' | 'doctor'} */ (record.kind)
  /** @type {Record<string, string>} */
  const optional = {}
  for (const key of ['hospital', 'department', 'specialty', 'title']) {
    const entry = typeof record[key] === 'string' ? record[key].trim() : ''
    if (entry) optional[key] = entry
  }
  return {
    kind,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null,
    relation: record.relation ?? GEO_DEFAULT_PRODUCER_RELATION[kind],
    ...optional,
  }
}

/**
 * The producer a card carries, from the project's settings and its product: an
 * enterprise is named by the settings, else the marketing-authorization holder
 * the run verified; a doctor by the doctor's own name. Null when nobody can be
 * named — the card is not written, because only the producer can say who they
 * are.
 * @param {unknown} settings @param {Record<string, any>} [product]
 * @returns {{ kind: string, name: string, relation: string, products?: string[] } | null}
 */
export function geoCardProducer(settings, product = {}) {
  if (!settings || typeof settings !== 'object') return null
  let normalized
  try { normalized = normalizeGeoProducerSettings(settings) } catch { return null }
  const name = normalized.name ?? (normalized.kind === 'enterprise' && typeof product.holder === 'string' && product.holder.trim() ? product.holder.trim() : null)
  if (!name) return null
  const products = [...new Set([product.brandName, product.genericName].filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))]
  return { kind: normalized.kind, name, relation: normalized.relation, ...(products.length ? { products } : {}) }
}

/**
 * A person of a disclosure block. A doctor is shown with the hospital and
 * department and the specialty, as the byline page reads.
 * @param {{ name: string, hospital?: string, department?: string, specialty?: string, title?: string }} person
 * @returns {{ name: string, affiliation?: string, title?: string }}
 */
export function geoDisclosurePerson(person) {
  const affiliation = [person.hospital, person.department].filter((part) => typeof part === 'string' && part.trim()).join(' ')
  const title = [person.title, person.specialty].filter((part) => typeof part === 'string' && part.trim()).join(' · ')
  return { name: person.name.trim(), ...(affiliation ? { affiliation } : {}), ...(title ? { title } : {}) }
}

// ---------------------------------------------------------------------------
// What may enter the frontier feed
// ---------------------------------------------------------------------------

/**
 * The zone kinds whose cards the 前沿动态 feed may carry: the platform's own and a researcher's own. A product zone is a
 * company's or a doctor's own voice about its product — corporate news is already a source class of the feed under its own
 * name — so its cards never enter (plan §5.6, ruling 15). The frontier package reads this, not a list of its own.
 */
export const EVIDENCE_FEED_ZONE_KINDS = frozen(['official', 'user'])

/**
 * Whether a zone's cards may enter the frontier feed.
 * @param {{ kind?: unknown } | null | undefined} zone
 */
export function isFeedEligibleZone(zone) {
  return EVIDENCE_FEED_ZONE_KINDS.includes(/** @type {any} */ (zone?.kind))
}

/**
 * Whether one card may enter the feed: its zone may, and in a researcher's zone only first-hand work does (an interpretation of
 * someone else's research is not an event of its own).
 * @param {{ kind?: unknown } | null | undefined} zone @param {{ originality?: unknown } | null | undefined} card
 */
export function isFeedEligibleCard(zone, card) {
  if (!isFeedEligibleZone(zone)) return false
  return zone?.kind === 'official' || evidenceOriginalityIsPrimary(card?.originality)
}

// ---------------------------------------------------------------------------
// Claims into cards
// ---------------------------------------------------------------------------

/** Claim keys carry `:`; a card's claim id does not. */
const CARD_CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/

/**
 * The card claim id of a claim key, unique inside one card. The characters a
 * card id forbids become `-`; an id that is taken, or a key that leaves nothing
 * to name, takes a counter. The same key always gets the same id when the same
 * keys are given.
 * @param {string} claimKey @param {Set<string>} taken
 */
export function geoCardClaimId(claimKey, taken) {
  const base = String(claimKey ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 54) || 'claim'
  let candidate = base
  for (let counter = 2; taken.has(candidate) || !CARD_CLAIM_ID.test(candidate); counter += 1) candidate = `${base}-${counter}`
  taken.add(candidate)
  return candidate
}

/**
 * A stage of the patient's journey from a claim's own word: an object
 * `{ key, label }`, or the label alone (how the question map writes it).
 * Returns null when the claim names none.
 * @param {unknown} value @returns {{ key: string, label: string } | null}
 */
export function geoClaimJourneyStage(value) {
  if (value == null || value === '') return null
  try {
    if (typeof value === 'string') {
      const label = value.trim()
      const key = label.replace(/\s+/g, '-').slice(0, 60)
      return label ? evidenceJourneyStage({ key, label }) : null
    }
    return evidenceJourneyStage(value)
  } catch {
    return null
  }
}

/** The stage a claim lands in when the run named none: a label claim reads as the label, everything else as general. */
const DEFAULT_STAGES = Object.freeze({
  label: Object.freeze({ key: 'label', label: '说明书与基本信息' }),
  general: Object.freeze({ key: 'general', label: '综合证据' }),
})
/** A claim whose source is the label or the regulator. */
const LABEL_SOURCE_KINDS = frozen(['label', 'regulator'])

/**
 * An address a reader can open for a claim's source reference: a DOI, a PMID, a
 * trial registry number or an http(s) address as written; null for a label
 * version or a guideline name, which the card cites by title.
 * @param {string} reference @returns {string | null}
 */
export function geoSourceUrl(reference) {
  const text = String(reference ?? '').trim()
  if (/^https?:\/\/\S+$/i.test(text) && !/[\s"<>]/.test(text)) return text
  const doi = /(?:^|\b)(?:doi:\s*)?(10\.\d{4,9}\/[^\s"<>]+)/i.exec(text)
  if (doi) return `https://doi.org/${doi[1].replace(/[).,;]+$/, '')}`
  const pmid = /^(?:pmid:?\s*)?(\d{1,9})$/i.exec(text)
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid[1]}/`
  const trial = /^(?:registry:\s*)?(NCT\d{8})$/i.exec(text)
  if (trial) return `https://clinicaltrials.gov/study/${trial[1].toUpperCase()}`
  return null
}

/**
 * @typedef {object} GeoCardInputClaim
 * @property {string} id the claim row's id
 * @property {string} claimKey
 * @property {string} statement
 * @property {string} quote
 * @property {string} sourceRef
 * @property {string | null} [sourceLabel]
 * @property {string | null} [sourceKind]
 * @property {string | null} [evidenceLevel]
 * @property {string | null} [population]
 * @property {boolean | null} [inLabel]
 * @property {string | null} [status]
 * @property {string | null} [validUntil]
 * @property {unknown} [journeyStage]
 * @property {string | null} [clinicalQuestion]
 * @property {string | null} [comparisonType]
 * @property {string | null} [sourceText] the preserved text the quotation is looked for in; null when it cannot be read
 */

/**
 * The reasons a claim is held back from a card, with the sentence a reader is
 * shown. Each is a label on the claim, not a verdict on the run.
 */
export const GEO_CARD_HELD_REASONS_ZH = Object.freeze({
  claim_not_active: '这条结论已过期或已撤下',
  claim_expired: '这条结论超过了有效期',
  source_unavailable: '读不到这条结论所依据的原文，无法核对引文',
  quote_not_found: '引文在所依据的原文里找不到',
  no_quote: '这条结论没有引文',
  claim_unusable: '这条结论的内容不符合证据卡的格式',
})

/** The longest title and summary a card carries (the zone service's own bound is 300). */
const CARD_TITLE_MAX = 200

/** @param {string} value @param {number} max */
const clip = (value, max) => ([...value].length <= max ? value : `${[...value].slice(0, max - 1).join('')}…`)
/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * The claim as a card holds it: the statement and its verbatim quotation, the
 * source it stands on by index, the population and the comparison evidence
 * type as the claim's own applicability line. Nothing is rephrased.
 * @param {GeoCardInputClaim} claim @param {string} cardClaimId @param {number} sourceIndex
 */
function cardClaim(claim, cardClaimId, sourceIndex) {
  const type = geoComparisonEvidenceType(claim.comparisonType)
  const applicability = [
    type ? `比较证据类型：${/** @type {Record<string, string>} */ (GEO_COMPARISON_EVIDENCE_TYPE_LABELS_ZH)[type]}` : '',
    text(claim.population) ? `人群：${text(claim.population)}` : '',
  ].filter(Boolean).join('；')
  const uncertainty = text(claim.evidenceLevel) ? `证据等级：${text(claim.evidenceLevel)}` : ''
  return {
    claimId: cardClaimId,
    claimType: 'direct',
    claim: clip(claim.statement.trim(), 1500),
    ...(applicability ? { applicability: clip(applicability, 800) } : {}),
    ...(uncertainty ? { uncertainty } : {}),
    sourceIndexes: [sourceIndex],
    supportQuote: clip(claim.quote.trim(), 2000),
  }
}

/**
 * Whether one claim's quotation is in the text of its source, by the card's
 * ruler: the status `verifyEvidenceCardClaims` gives it as a card of one claim
 * and one source.
 * @param {GeoCardInputClaim} claim
 */
function rulerStatus(claim) {
  const sourceText = typeof claim.sourceText === 'string' ? claim.sourceText : ''
  const verdict = verifyEvidenceCardClaims({
    claims: [{ claimId: 'c', claimType: 'direct', claim: claim.statement, sourceIndexes: [1], supportQuote: claim.quote }],
    sources: [{ documentText: sourceText }],
  })
  return verdict.claims[0]?.status ?? 'source_unavailable'
}

/**
 * The cards a project's verified claims make, one per key clinical question on
 * the patient journey (a claim's own `clinicalQuestion` inside its stage; the
 * stage's general question when it names none).
 *
 * Each card holds only claims whose quotation the card's ruler finds in the
 * preserved source text the caller read; the rest are listed with the reason.
 * The result says what to write, not that it was written: the same input
 * gives the same plan, so a write that finds the card as planned changes
 * nothing.
 *
 * @param {{ claims: readonly GeoCardInputClaim[], producer: { kind: string, name: string, relation: string, products?: string[] },
 *   authors: readonly { name: string, affiliation?: string, title?: string }[], reviewers: readonly { name: string, affiliation?: string, title?: string }[],
 *   entityKeys?: readonly string[], now: Date }} input
 * @returns {{ cards: Array<{ groupKey: string, journeyStage: { key: string, label: string }, question: string, payload: Record<string, any>,
 *   map: Array<{ claimId: string, claimKey: string, cardClaimId: string }> }>,
 *   held: Array<{ claimKey: string, claimId: string, reason: string, message: string }> }}
 */
export function geoCardPlan({ claims, producer, authors, reviewers, entityKeys = [], now }) {
  /** @type {Array<{ claimKey: string, claimId: string, reason: string, message: string }>} */
  const held = []
  const hold = (/** @type {GeoCardInputClaim} */ claim, /** @type {keyof typeof GEO_CARD_HELD_REASONS_ZH} */ reason) =>
    held.push({ claimKey: claim.claimKey, claimId: claim.id, reason, message: GEO_CARD_HELD_REASONS_ZH[reason] })
  /** @type {Map<string, { stage: { key: string, label: string }, question: string, claims: GeoCardInputClaim[] }>} */
  const groups = new Map()
  const ordered = [...claims].sort((left, right) => left.claimKey.localeCompare(right.claimKey))
  for (const claim of ordered) {
    if (!text(claim.statement) || !text(claim.sourceRef) || !CARD_CLAIM_ID.test(String(claim.claimKey ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'c')) {
      hold(claim, 'claim_unusable')
      continue
    }
    if (claim.status && claim.status !== 'active') { hold(claim, 'claim_not_active'); continue }
    if (claim.validUntil && Date.parse(claim.validUntil) < now.getTime()) { hold(claim, 'claim_expired'); continue }
    if (!text(claim.quote)) { hold(claim, 'no_quote'); continue }
    const status = rulerStatus(claim)
    if (status !== 'verified') { hold(claim, status === 'quote_not_found' || status === 'no_quote' ? status : 'source_unavailable'); continue }
    const stage = geoClaimJourneyStage(claim.journeyStage)
      ?? (LABEL_SOURCE_KINDS.includes(/** @type {any} */ (claim.sourceKind)) ? DEFAULT_STAGES.label : DEFAULT_STAGES.general)
    const question = text(claim.clinicalQuestion) || `${stage.label}：关键结论`
    const groupKey = `${stage.key}\u0000${question.toLowerCase()}`
    const group = groups.get(groupKey) ?? { stage, question, claims: /** @type {GeoCardInputClaim[]} */ ([]) }
    group.claims.push(claim)
    groups.set(groupKey, group)
  }
  const cards = []
  for (const [groupKey, group] of groups) {
    /** @type {Map<string, number>} */
    const sourceIndex = new Map()
    /** @type {any[]} */
    const sources = []
    const taken = new Set()
    /** @type {any[]} */
    const cardClaims = []
    /** @type {Array<{ claimId: string, claimKey: string, cardClaimId: string }>} */
    const map = []
    for (const claim of group.claims) {
      let index = sourceIndex.get(claim.sourceRef)
      if (index == null) {
        const documentText = String(claim.sourceText)
        const url = geoSourceUrl(claim.sourceRef)
        sources.push({
          title: clip(text(claim.sourceLabel) || claim.sourceRef.trim(), 500),
          ...(url ? { url } : {}),
          excerpt: evidencePublicExcerpt(documentText, claim.quote.trim()),
          documentText,
          coverage: 'full-text',
          checkedAt: now.toISOString(),
        })
        index = sources.length
        sourceIndex.set(claim.sourceRef, index)
      }
      const cardClaimId = geoCardClaimId(claim.claimKey, taken)
      cardClaims.push(cardClaim(claim, cardClaimId, index))
      map.push({ claimId: claim.id, claimKey: claim.claimKey, cardClaimId })
    }
    const inLabel = group.claims.filter((claim) => claim.inLabel === true)
    /** @type {string[]} */
    const labelClaims = []
    let labelText = ''
    for (const claim of inLabel) {
      const entry = cardClaims[group.claims.indexOf(claim)]
      // Statements are joined as they are written: after a full stop nothing is added, otherwise a semicolon.
      const next = labelText ? `${labelText}${/[。！？.!?]$/.test(labelText) ? '' : '；'}${entry.claim}` : entry.claim
      if ([...next].length > EVIDENCE_PUBLIC_PANEL_LIMITS.labelSays) break
      labelText = next
      labelClaims.push(entry.claimId)
    }
    const populations = [...new Set(group.claims.map((claim) => text(claim.population)).filter(Boolean))]
    const kinds = new Set(group.claims.map((claim) => claim.sourceKind))
    const academic = ['trial', 'review', 'literature', 'guideline'].some((kind) => kinds.has(kind))
    cards.push({
      groupKey,
      journeyStage: group.stage,
      question: group.question,
      payload: {
        title: clip(group.question, CARD_TITLE_MAX),
        subtype: academic ? 'academic' : 'knowledge',
        summary: clip(`${group.stage.label}：${group.claims.length} 条已核对的结论`, 500),
        body: cardClaims.map((claim) => `- ${claim.claim}`).join('\n'),
        limitations: '',
        provenance: '出自循证传播项目的结论库：每条结论的引文已在其原文中逐字核对。',
        sources,
        claims: cardClaims,
        content: { question: clip(group.question, 1000), ...(populations.length === 1 ? { population: clip(populations[0], 1000) } : {}) },
        publicView: labelText ? { labelSays: { text: labelText, claimIds: labelClaims } } : null,
        producer,
        originality: 'synthesis',
        journeyStage: group.stage,
        disclosure: {
          generatedAt: now.toISOString(),
          lastCheckedAt: now.toISOString(),
          aiSteps: ['search', 'extract'],
          authors: [...authors],
          reviewers: [...reviewers],
        },
        entityKeys: [...entityKeys],
      },
      map,
    })
  }
  return { cards, held }
}

// ---------------------------------------------------------------------------
// The lower layers cite the cards (flywheel F21)
// ---------------------------------------------------------------------------

/**
 * The layers whose sentences cite a card claim: the popular text, the question-and-answer and the correction. The deep
 * analysis is the clinical layer's own prose, and the card layer is rendered from the card (`geoCardLayerMarkdown`), so neither
 * has a sentence of its own to cite.
 */
export const GEO_CITING_LAYERS = frozen(['popular', 'qa', 'correction'])

/**
 * A claim reference, written after the sentence it supports: the card, the card's own claim id and the card revision the
 * claim was read in. It is a format and nothing else — the platform strips it before a word of the article is published.
 */
const REFERENCE_SOURCE = String.raw`\[\[ref:(ec_[A-Za-z0-9]{8,64})\/([A-Za-z0-9][A-Za-z0-9._-]{0,59})@([1-9]\d{0,5})\]\]`
/** Any marker that opens with the reference prefix, valid or not: a malformed one is reported, not guessed at. */
const ANY_MARKER = /\[\[ref:[^\]\n]*\]\]/g

/**
 * The marker for one reference.
 * @param {{ cardId: string, claimId: string, revision: number }} reference
 */
export function geoClaimReferenceMarker({ cardId, claimId, revision }) {
  return `[[ref:${cardId}/${claimId}@${revision}]]`
}

/**
 * Every well-formed claim reference of a text, in the order written.
 * @param {string} source
 * @returns {{ cardId: string, claimId: string, revision: number, index: number }[]}
 */
export function parseGeoClaimReferences(source) {
  const found = []
  for (const match of String(source ?? '').matchAll(new RegExp(REFERENCE_SOURCE, 'g'))) {
    found.push({ cardId: match[1], claimId: match[2], revision: Number(match[3]), index: match.index ?? 0 })
  }
  return found
}

/**
 * The text as it is published: the markers gone, and the space a marker left at the end of a line with them. Everything else is
 * byte for byte what was written, so the protected spans a placement checks (numbers, names, quotations) are not touched.
 * @param {string} source
 */
export function stripGeoClaimReferences(source) {
  return String(source ?? '').replace(new RegExp(REFERENCE_SOURCE, 'g'), '').replace(/[ \t]+(?=\n|$)/g, '')
}

/** @param {string} value */
const sentenceTerminator = (value) => /[。！？；!?;\n]/.test(value)

/**
 * The sentences of a text, each with the markers that follow or sit in it. A sentence ends at 。！？；!?; or a line end, or at a
 * full stop followed by a space; a marker written after the closing punctuation belongs to the sentence before it. This is a
 * format split, not a reading: what a sentence says is never looked at here.
 * @param {string} body
 * @returns {{ text: string, references: { cardId: string, claimId: string, revision: number }[] }[]}
 */
export function geoSentences(body) {
  const source = String(body ?? '')
  /** @type {{ text: string, references: any[] }[]} */
  const out = []
  let buffer = ''
  const flush = () => {
    const bare = stripGeoClaimReferences(buffer)
    if (/[\p{L}\p{N}]/u.test(bare)) out.push({ text: bare.trim(), references: parseGeoClaimReferences(buffer).map(({ cardId, claimId, revision }) => ({ cardId, claimId, revision })) })
    buffer = ''
  }
  /** Take a marker at `at`, if there is one. @param {number} at */
  const marker = (at) => {
    if (!source.startsWith('[[ref:', at)) return 0
    const end = source.indexOf(']]', at)
    return end > at && !source.slice(at, end).includes('\n') ? end + 2 - at : 0
  }
  let position = 0
  while (position < source.length) {
    const taken = marker(position)
    if (taken) { buffer += source.slice(position, position + taken); position += taken; continue }
    const character = source[position]
    buffer += character
    position += 1
    const stops = sentenceTerminator(character) || (character === '.' && (position >= source.length || /\s/.test(source[position])))
    if (!stops) continue
    for (;;) {
      const next = marker(position)
      if (next) { buffer += source.slice(position, position + next); position += next; continue }
      if (position < source.length && /[”’」』）)\]]/.test(source[position])) { buffer += source[position]; position += 1; continue }
      break
    }
    flush()
  }
  flush()
  return out
}

/**
 * The numbers a sentence states, by value. Dates, addresses and a list's own numbering are not numbers a claim has to support.
 * @param {string} sentence @returns {number[]}
 */
export function geoNumberTokens(sentence) {
  const cleaned = String(sentence ?? '').normalize('NFKC')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\d{4}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*[日号])?/g, ' ')
    .replace(/\d{4}-\d{1,2}(?:-\d{1,2})?/g, ' ')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)、]\s+|[（(]\d{1,3}[）)]\s*)/, '')
  return [...cleaned.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, ''))).filter(Number.isFinite)
}

/** What a reference's card claim says, for resolving it. @typedef {{ claim: string, supportQuote?: string | null, applicability?: string | null, mark?: string | null }} GeoResolvedClaim */
/**
 * What the cards say about one reference: `null` when the card is not one of the project's; otherwise the card's current
 * revision, whether it was taken back, and the claims of the cited revision — `null` when that revision is unknown.
 * @typedef {{ currentRevision: number, withdrawn?: boolean, claims: Record<string, GeoResolvedClaim> | null } | null} GeoCardLookup
 */

/**
 * The reference graph of one article: every sentence's claim must exist in the card revision it cites ("a lower layer never says
 * what the upper layer does not"), a number in a cited sentence must be a number of the claims it cites, and a sentence that
 * states a number with no reference is named. Everything is a label — `ok` is the one yes or no about whether every
 * reference resolves — and a text of no reference at all in a citing layer is `references: 0`, not a verdict.
 *
 * @param {{ text: string, layer: string, resolve: (reference: { cardId: string, claimId: string, revision: number }) => GeoCardLookup }} input
 * @returns {{ ok: boolean, counts: { sentences: number, referencedSentences: number, references: number, unresolved: number, unverified: number,
 *   numberUnsupported: number, numberedWithoutReference: number, malformed: number },
 *   references: { cardId: string, claimId: string, revision: number, status: string, mark: string | null }[],
 *   issues: { code: string, severity: 'advisory', message: string, sentence?: string, cardId?: string, claimId?: string, revision?: number }[] }}
 */
export function geoReferenceGraph({ text: body, layer, resolve }) {
  const source = String(body ?? '')
  const citing = GEO_CITING_LAYERS.includes(/** @type {any} */ (layer))
  /** @type {ReturnType<typeof geoReferenceGraph>['issues']} */
  const issues = []
  const wellFormed = new Set(parseGeoClaimReferences(source).map((reference) => source.slice(reference.index, reference.index + geoClaimReferenceMarker(reference).length)))
  const malformed = (source.match(ANY_MARKER) ?? []).filter((marker) => !wellFormed.has(marker))
  for (const marker of malformed.slice(0, 5)) issues.push({ code: 'claim_reference_malformed', severity: 'advisory', message: `${marker} is not a claim reference: write [[ref:<cardId>/<claimId>@<revision>]].` })
  const sentences = geoSentences(source)
  /** @type {Map<string, ReturnType<typeof geoReferenceGraph>['references'][number]>} */
  const resolved = new Map()
  let referencedSentences = 0
  let unverified = 0
  let numberUnsupported = 0
  let numberedWithoutReference = 0
  for (const sentence of sentences) {
    const numbers = geoNumberTokens(sentence.text)
    if (!sentence.references.length) {
      if (citing && numbers.length) {
        numberedWithoutReference += 1
        if (numberedWithoutReference <= 5) issues.push({ code: 'numbered_sentence_without_reference', severity: 'advisory', sentence: clip(sentence.text, 80), message: `"${clip(sentence.text, 80)}" states a number and cites no card claim.` })
      }
      continue
    }
    referencedSentences += 1
    /** @type {Set<number>} */
    const supported = new Set()
    for (const reference of sentence.references) {
      const key = `${reference.cardId}/${reference.claimId}@${reference.revision}`
      let entry = resolved.get(key)
      if (!entry) {
        const lookup = resolve(reference)
        let status = 'ok'
        /** @type {GeoResolvedClaim | null} */
        let claim = null
        if (!lookup) status = 'card_not_found'
        else if (!lookup.claims) status = 'revision_not_found'
        else if (!Object.hasOwn(lookup.claims, reference.claimId)) status = 'claim_not_in_revision'
        else { claim = lookup.claims[reference.claimId]; if (lookup.withdrawn) status = 'card_withdrawn' }
        entry = { ...reference, status, mark: claim?.mark ?? null }
        resolved.set(key, entry)
        if (status !== 'ok' && status !== 'card_withdrawn') {
          issues.push({ code: 'claim_reference_unresolved', severity: 'advisory', ...reference, message: `${key}: ${/** @type {Record<string, string>} */ ({
            card_not_found: 'the card is not one of this project\'s',
            revision_not_found: 'the card has no such revision',
            claim_not_in_revision: 'that revision of the card has no such claim',
          })[status]}.` })
        } else if (claim && claim.mark && claim.mark !== '✓') {
          unverified += 1
          issues.push({ code: 'claim_reference_unverified', severity: 'advisory', ...reference, message: `${key}: the card marks this claim ⚠ in that revision.` })
        }
        if (claim) for (const figure of geoNumberTokens(`${claim.claim} ${claim.supportQuote ?? ''} ${claim.applicability ?? ''}`)) supported.add(figure)
      } else if (entry.status === 'ok' || entry.status === 'card_withdrawn') {
        const lookup = resolve(reference)
        const claim = lookup?.claims?.[reference.claimId]
        if (claim) for (const figure of geoNumberTokens(`${claim.claim} ${claim.supportQuote ?? ''} ${claim.applicability ?? ''}`)) supported.add(figure)
      }
    }
    const loose = numbers.filter((figure) => !supported.has(figure))
    const everyResolved = sentence.references.every((reference) => ['ok', 'card_withdrawn'].includes(resolved.get(`${reference.cardId}/${reference.claimId}@${reference.revision}`)?.status ?? ''))
    // A number can only be traced to a claim that was found; an unresolved reference has said what is wrong already.
    if (everyResolved && loose.length) {
      numberUnsupported += 1
      issues.push({ code: 'sentence_number_not_in_claim', severity: 'advisory', sentence: clip(sentence.text, 80),
        message: `"${clip(sentence.text, 80)}" states ${[...new Set(loose)].join(', ')}, which the claim it cites does not.` })
    }
  }
  const references = [...resolved.values()]
  const unresolved = references.filter((reference) => !['ok', 'card_withdrawn'].includes(reference.status)).length
  return {
    ok: unresolved === 0 && malformed.length === 0,
    counts: { sentences: sentences.length, referencedSentences, references: references.length, unresolved, unverified, numberUnsupported, numberedWithoutReference, malformed: malformed.length },
    references,
    issues,
  }
}

/** The change-log categories after which a card's earlier revision no longer says what it said. */
export const GEO_STALE_CHANGE_CATEGORIES = frozen(['correction', 'withdrawal', 'new_evidence_conclusion_changed'])

/**
 * The references an article makes that the card's change log has since corrected, updated in its conclusion or withdrawn: the
 * log entry that came after the cited revision (a withdrawal at any revision), and, when it names a claim, that claim. The
 * article is flagged 「被引结论已更新」 on its project's page — a notice for the researcher, never a block — because a number or
 * a conclusion that was since corrected is the thing the 《广告引证内容执法指南》 asks content to follow.
 *
 * @param {readonly { cardId: string, claimId: string, revision: number }[]} references
 * @param {readonly { cardId: string, category: string, revisionAfter: number | null, occurredAt: string, summary: string, refs?: { claimId?: string } }[]} entries
 * @returns {{ cardId: string, claimId: string, revision: number, category: string, occurredAt: string, summary: string }[]}
 */
export function geoStaleReferences(references, entries) {
  /** @type {Map<string, { cardId: string, claimId: string, revision: number, category: string, occurredAt: string, summary: string }>} */
  const stale = new Map()
  for (const reference of references) {
    for (const entry of entries) {
      if (entry.cardId !== reference.cardId || !GEO_STALE_CHANGE_CATEGORIES.includes(/** @type {any} */ (entry.category))) continue
      if (entry.category !== 'withdrawal' && !(entry.revisionAfter == null || entry.revisionAfter > reference.revision)) continue
      if (entry.refs?.claimId && entry.refs.claimId !== reference.claimId) continue
      const key = `${reference.cardId}/${reference.claimId}@${reference.revision}`
      const known = stale.get(key)
      if (!known || known.occurredAt < entry.occurredAt) stale.set(key, { ...reference, category: entry.category, occurredAt: entry.occurredAt, summary: entry.summary })
    }
  }
  return [...stale.values()]
}

// ---------------------------------------------------------------------------
// The card layer is the card
// ---------------------------------------------------------------------------

/** @param {unknown} value */
const day = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : null)

/**
 * The 证据卡片 article of a card: the public view's panels as written, the fact box computed from the card's comparisons, the
 * sources with the date they were checked — in Markdown, from `evidenceCardPublicView` and nothing else. The card layer used to
 * be stored text of its own beside the claims; it is the card's second view, so a correction of the card is a correction of it.
 *
 * With `withReferences` each panel line carries the claim references of the claims it stands on, for the check that reads
 * them; without it, the text is what is published.
 *
 * @param {{ view: { kind: string, header: any, panels: any[], factBox: any }, card: { id: string, revision: number }, withReferences?: boolean }} input
 * @returns {string}
 */
export function geoCardLayerMarkdown({ view, card, withReferences = false }) {
  const cite = (/** @type {string[] | undefined} */ ids) => (withReferences ? (ids ?? []).map((claimId) => geoClaimReferenceMarker({ cardId: card.id, claimId, revision: card.revision })).join('') : '')
  const lines = [`# ${view.header?.title ?? ''}`.trimEnd()]
  const producer = view.header?.producer
  if (producer?.name) lines.push('', `出品方：${producer.name}`)
  for (const panel of view.panels ?? []) {
    if (panel.status !== 'written') continue
    if (panel.key === 'commonMisunderstandings') {
      lines.push('', `## ${panel.label}`)
      for (const item of panel.items ?? []) lines.push('', `- 误解：${item.misunderstanding}`, `  更正：${item.correction}${cite(item.claimIds)}`)
    } else if (panel.key === 'sourcesAndCheckDate') {
      lines.push('', `## ${panel.label}`)
      for (const source of panel.sources ?? []) lines.push(`- ${source.title}${source.url ? `（${source.url}）` : ''}`)
      const checked = day(panel.checkedAt)
      if (checked) lines.push('', `核对日期：${checked}`)
    } else {
      lines.push('', `## ${panel.label}`, '', `${panel.text}${cite(panel.claimIds)}`)
    }
  }
  const box = view.factBox
  if (box?.status === 'available') {
    lines.push('', `## 每 ${box.per} 人中的情况`, '', '| 结局 | 对照 | 干预 | 差异 |', '| --- | --- | --- | --- |')
    for (const row of [...box.benefits.map((/** @type {any} */ entry) => ({ ...entry, role: '获益' })), ...box.harms.map((/** @type {any} */ entry) => ({ ...entry, role: '不良反应' }))]) {
      lines.push(`| ${row.role}：${row.outcome}（${row.timeframe}） | ${row.control.per1000} | ${row.intervention.per1000} | ${row.difference} |`)
    }
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Signed, labelled text (flywheel F29)
// ---------------------------------------------------------------------------

/**
 * The line every article a run drafted carries when it is read out for publication: that an AI helped write it, that every
 * statement stands on a verified claim of a card, and that a named person answers for it. The national rules for AI-generated content
 * and the internet health-science conduct list for medical staff both ask for it; it is written by code, so a draft cannot leave
 * without it and a model cannot word it away.
 */
export const GEO_AI_LABEL_ZH = '本文由 AI 辅助生成，每条陈述都依据已核对的证据卡片结论，由署名作者审核。'

/**
 * An article as it leaves the platform: its claim references taken off, the author named at the foot — a doctor by hospital,
 * department and specialty, a company by name, with how it stands to the product — and the AI label. The article's own words are
 * untouched, byte for byte.
 *
 * @param {{ text: string, producer: { kind: string, name: string, relation?: string } | null, person?: { name: string, affiliation?: string, title?: string } | null,
 *   aiGenerated?: boolean }} input
 */
export function geoPublishableText({ text: draft, producer, person = null, aiGenerated = true }) {
  const body = stripGeoClaimReferences(draft).trimEnd()
  const lines = [body, '']
  if (person?.name) {
    lines.push(`作者：${[person.name, person.affiliation, person.title].filter(Boolean).join('\u3000')}`)
  } else if (producer?.name) {
    lines.push(`出品：${producer.name}`)
  }
  if (producer?.relation && producer.relation !== 'none') {
    const label = /** @type {Record<string, string>} */ (EVIDENCE_PRODUCER_RELATION_LABELS_ZH)[producer.relation]
    if (label) lines.push(`与产品的关系：${label}`)
  }
  if (aiGenerated) lines.push(GEO_AI_LABEL_ZH)
  return `${lines.join('\n')}\n`
}
