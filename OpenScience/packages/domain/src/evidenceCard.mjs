/**
 * The evidence card — the platform's single evidence unit (flywheel plan §4.1,
 * 2026-10-05).
 *
 * Hidden knowledge: what a card is, who may write one, and what may never be in
 * one. The contract grew up in `apps/server` beside the evidence-zone service
 * (`evidenceCardContent.mjs`); it lives here now so that the zone service, the
 * research run that publishes a result as a card, the platform's own programme,
 * the evidence-communication module and the public page all import the same
 * vocabulary and none restates it. The server file is a thin re-export that
 * turns this module's `EvidenceCardError` into an `HttpError`.
 *
 * Three rules (plan §4.3) are code here and nowhere else:
 *
 * 1. Say who made it. `producer` is required on every card and states the
 *    producer's relation to the products the card is about; a zone's kind
 *    decides which producer kinds may sign it, so a user cannot label their own
 *    card as the platform's. Writes reach a zone only through the origins
 *    `evidenceWriteAllowed` lists. Ordering reads only `EVIDENCE_RANKING_INPUTS`:
 *    no paid or commercial field exists, and adding one is a change to that list.
 * 2. Only an index (a card is cited as a pointer to its sources, never as
 *    evidence) — the platform-index notice lives with the gate in
 *    `clinicalEvidence.mjs`; a card's own claims quote the card's own sources.
 * 3. A simulation is never evidence. A value labelled predicted, assumed or
 *    synthetic is refused; imputed and reconstructed values appear only inside a
 *    derived claim that states its method (`evidenceValueSourceIssues`).
 *
 * Verification is a label, never a refusal: `verifyEvidenceCardClaims` calls the
 * very comparison the delivery gate and the reader's ✓/⚠ use (`claimVerification`
 * over `quoteIsPresent`) against each cited source's preserved text, so a card's
 * mark and a run's mark cannot disagree. Absolute effects and the public fact box
 * are computed from events and denominators here — a number a model typed is
 * never one a reader sees as arithmetic.
 *
 * Zero dependencies and no `node:` imports, like the rest of this package: the
 * hashes are made by a function the caller supplies (`createEvidenceCardHashing`).
 *
 * @module @evimed/domain/evidenceCard
 */

import { VCR_VALUE_SOURCES, VCR_VALUE_SOURCE_LABELS_ZH } from './vcrVocabulary.mjs'
import { attachClaimSourceLocations, claimVerification } from './clinicalEvidence.mjs'

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A refusal of one precise engineering operation, with the code a caller maps to
 * a response. `status` is the HTTP status the zone service answers with.
 */
export class EvidenceCardError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message)
    this.name = 'EvidenceCardError'
    /** @type {number} */
    this.status = status
    /** @type {string} */
    this.code = code
  }
}

/** @param {string} [detail] */
const invalid = (detail) => new EvidenceCardError(
  400,
  'evidence_invalid',
  detail ? `Invalid evidence content: ${detail}.` : 'Invalid evidence content or review receipt.',
)

/**
 * Every code this module raises, each with the sentence a reader is shown
 * (`errorCodes.mjs` registers them). Shape errors keep the zone service's
 * long-standing `evidence_invalid`.
 */
export const EVIDENCE_CARD_ERROR_MESSAGES_ZH = Object.freeze({
  evidence_write_origin_refused: '这个专区不接受这种来源的写入：官方专区只由平台写，产品专区只由出品方本人或其循证传播项目写，用户专区只由所有者及其研究结果写。',
  evidence_value_source_refused: '证据卡里不能出现“预测”“假设”“合成”的数值；“插补”“重建”的数值只能出现在写明方法的推算类结论里。这张卡没有保存。',
  evidence_producer_required: '这个专区里的证据卡必须写明出品方，以及出品方和所涉产品的关系。',
  evidence_producer_mismatch: '这个出品方类型不能在这类专区里署名：平台只在官方专区，企业和医生在产品专区，研究者在用户专区。',
  evidence_journey_stage_required: '产品专区里的证据卡必须标明它所在的患者旅程阶段。',
  evidence_disclosure_required: '产品专区的证据卡，以及企业和医生出品的证据卡，必须披露作者和审核人。',
  evidence_zone_kind_forbidden: '官方专区只能由平台的内部操作建立，专区类型建立之后也不能更改。',
  evidence_visibility_requires_publication: '专区先发布，才能公开到互联网；撤回发布后会自动回到平台内可见。',
  evidence_ranking_input_unknown: '排序只能读取已登记的输入（时效、核验比例、评议分、关注数）；付费等其他字段不能参与排序。',
})
export const EVIDENCE_CARD_ERROR_CODES = frozen(Object.keys(EVIDENCE_CARD_ERROR_MESSAGES_ZH))

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** Who owns the zone's voice: the platform (official), a company or doctor (product), a researcher (user). */
export const EVIDENCE_ZONE_KINDS = frozen(['official', 'product', 'user'])
export const EVIDENCE_ZONE_KIND_LABELS_ZH = Object.freeze({ official: '官方专区', product: '产品专区', user: '用户专区' })
/** Who can read a published zone: signed-in accounts (`platform`) or anyone (`internet`, the owner's own choice). */
export const EVIDENCE_ZONE_VISIBILITY = frozen(['platform', 'internet'])
export const EVIDENCE_ZONE_VISIBILITY_LABELS_ZH = Object.freeze({ platform: '平台内可见', internet: '公开到互联网' })

export const EVIDENCE_PRODUCER_KINDS = frozen(['platform', 'enterprise', 'doctor', 'user', 'external'])
export const EVIDENCE_PRODUCER_KIND_LABELS_ZH = Object.freeze({
  platform: '平台', enterprise: '企业', doctor: '医生', user: '用户', external: '外部导入',
})
/** The producer's relation to the products the card is about; it is read at the top of the card. */
export const EVIDENCE_PRODUCER_RELATIONS = frozen(['none', 'own_product', 'competitor_product', 'user_of_therapy', 'commercial_cooperation'])
export const EVIDENCE_PRODUCER_RELATION_LABELS_ZH = Object.freeze({
  none: '与所涉产品无利益关系', own_product: '涉及出品方自己的产品', competitor_product: '涉及出品方的竞品',
  user_of_therapy: '出品方是该疗法的使用者', commercial_cooperation: '与产品方有商业合作',
})
/** Which producer kinds may sign a card in each kind of zone. A label no one may borrow: only the platform writes `platform`. */
export const EVIDENCE_ZONE_PRODUCER_KINDS = Object.freeze({
  official: frozen(['platform', 'external']),
  product: frozen(['enterprise', 'doctor']),
  user: frozen(['user']),
})
/** The producer name a platform-written card carries until the publisher account names itself. */
export const EVIDENCE_PLATFORM_PRODUCER_NAME = 'EviMed 证据中心'

/** First-hand work: the platform's analysis of public data, a recalculation of a published study, a user's own research. */
export const EVIDENCE_PRIMARY_ORIGINALITY = frozen(['original_analysis', 'recalculation', 'original_research'])
/** Interpretation of someone else's research. Only first-hand work may stand as its own event in the feed. */
export const EVIDENCE_INTERPRETIVE_ORIGINALITY = frozen(['synthesis', 'brief'])
export const EVIDENCE_ORIGINALITY = frozen([...EVIDENCE_PRIMARY_ORIGINALITY, ...EVIDENCE_INTERPRETIVE_ORIGINALITY])
export const EVIDENCE_ORIGINALITY_LABELS_ZH = Object.freeze({
  original_analysis: '原创分析', recalculation: '复算核验', original_research: '原创研究', synthesis: '综合', brief: '速览',
})
/** @param {unknown} value */
export const evidenceOriginalityIsPrimary = (value) => EVIDENCE_PRIMARY_ORIGINALITY.includes(/** @type {any} */ (value))

/** What an AI did on the way to the card (the RAISE disclosure items). */
export const EVIDENCE_AI_STEPS = frozen(['search', 'screen', 'extract', 'synthesize', 'review'])
export const EVIDENCE_AI_STEP_LABELS_ZH = Object.freeze({ search: '检索', screen: '筛选', extract: '抽取', synthesize: '综合', review: '复核' })

/** The claim types of a research run's evidence matrix, reused unchanged. */
export const EVIDENCE_CLAIM_TYPES = frozen(['direct', 'synthesized', 'derived'])
export const EVIDENCE_CLAIM_CONFIDENCE = frozen(['high', 'moderate', 'low'])
/** Whether a comparison's outcome is a benefit or a harm, which is what the public fact box groups by. */
export const EVIDENCE_OUTCOME_ROLES = frozen(['benefit', 'harm'])

/** The six writers of a zone (plan §4.3 rule 1); `evidenceWriteAllowed` says which may write where. */
export const EVIDENCE_WRITE_ORIGINS = frozen(['owner', 'import', 'model', 'programme', 'result', 'geo'])
export const EVIDENCE_WRITE_ORIGIN_LABELS_ZH = Object.freeze({
  owner: '所有者本人', import: '运营者导入', model: 'AI 编辑', programme: '平台议程', result: '研究结果发布', geo: '循证传播项目',
})

/**
 * The only inputs ordering a zone list or a card list may read. A paid
 * placement is not a ranking input and cannot become one without changing this
 * list, which a test pins.
 */
export const EVIDENCE_RANKING_INPUTS = frozen(['recency', 'verified_share', 'review_score', 'follows'])

// ---------------------------------------------------------------------------
// Small shared checks
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
/** @param {Record<string, any>} value @param {readonly string[]} allowed */
const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key))
/** A non-empty string of at most `max`. @param {unknown} value @param {number} max @returns {value is string} */
const filled = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
/** An absent value or a string of at most `max`. @param {unknown} value @param {number} max */
const optionalText = (value, max) => value == null || (typeof value === 'string' && value.length <= max)
/** @param {unknown} value */
const isoDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
/** @param {string} value */
const hasControlCharacter = (value) => [...value].some((character) => /** @type {number} */ (character.codePointAt(0)) < 32)
/** @param {unknown} value @param {number} max @param {number} [limit] */
const stringList = (value, max, limit = 50) =>
  Array.isArray(value) && value.length <= limit && value.every((entry) => filled(entry, max))
/** @param {unknown} value @param {number} count */
const sourceIndexList = (value, count) =>
  Array.isArray(value) && value.every((index) => Number.isSafeInteger(index) && index >= 1 && index <= count)

// ---------------------------------------------------------------------------
// Hashes (the caller supplies sha-256; this package may not reach for node:crypto)
// ---------------------------------------------------------------------------

/**
 * JSONB sorts object keys; hashes must be stable before and after persistence.
 * @param {any} value @returns {any}
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

/**
 * Publisher status is evidence, not an AI judgement. Missing metadata never clears it.
 * @param {any} value
 */
export function evidencePublicationStatus(value) {
  if (value == null) return null
  if (!isRecord(value) || !onlyKeys(value, ['kind', 'notices'])
    || !['retracted', 'corrected', 'concern'].includes(value.kind)
    || !Array.isArray(value.notices) || value.notices.length > 10
    || value.notices.some((/** @type {unknown} */ notice) => typeof notice !== 'string' || !notice.trim() || notice.length > 1000)) throw invalid()
  return { kind: value.kind, notices: [...new Set(value.notices.map((/** @type {string} */ notice) => notice.trim()))].sort() }
}

/**
 * The hash functions of a card, over the caller's sha-256.
 *
 * The content hash is the scientific payload — excluding attribution and
 * volatile fetch timestamps — so a card with no claims and no public view
 * hashes exactly as it did before they existed: an AI review receipt written
 * against the old payload still binds to it.
 *
 * @param {(text: string) => string} sha256Hex
 */
export function createEvidenceCardHashing(sha256Hex) {
  /** @param {unknown} value */
  const evidenceHash = (value) => sha256Hex(typeof value === 'string' ? value : JSON.stringify(canonical(value)))
  /** @param {any} value */
  const evidenceContentHash = (value) => {
    const claims = Array.isArray(value.claims) ? value.claims : []
    const publicView = value.publicView ?? value.public_view ?? null
    return evidenceHash([
      value.title,
      value.summary,
      value.body,
      value.content ?? null,
      value.limitations,
      (value.sources ?? []).map((/** @type {any} */ s) => [
        s.title,
        s.url,
        s.excerpt,
        s.sha256 ?? null,
        s.coverage ?? 'excerpt',
        ...(s.publicationStatus ? [evidencePublicationStatus(s.publicationStatus)] : []),
      ]),
      ...(claims.length ? [claims] : []),
      ...(publicView ? [publicView] : []),
    ])
  }
  /** @param {any[]} sources */
  const evidenceSourceFingerprint = (sources) => evidenceHash(
    sources.map((s) => [
      s.url,
      s.sha256 ?? evidenceHash(s.documentText ?? s.excerpt ?? ''),
      s.coverage ?? 'excerpt',
      ...(s.publicationStatus ? [evidencePublicationStatus(s.publicationStatus)] : []),
    ]),
  )
  /** @param {any} value @param {any} card @param {number} revision */
  const evidenceEditorialReceipt = (value, card, revision) => {
    const contentHash = evidenceContentHash(card)
    const sourceFingerprint = evidenceSourceFingerprint(card.sources)
    if (value == null) return null
    if (!isRecord(value) || JSON.stringify(value).length > 20000) throw invalid()
    const lastEditor = value.lastEditor
    if (lastEditor != null && (
      !isRecord(lastEditor) || !onlyKeys(lastEditor, ['userId', 'name', 'editedAt'])
      || typeof lastEditor.userId !== 'string' || !lastEditor.userId.trim() || lastEditor.userId.length > 300
      || typeof lastEditor.name !== 'string' || !lastEditor.name.trim() || lastEditor.name.length > 300
      || typeof lastEditor.editedAt !== 'string' || !Number.isFinite(Date.parse(lastEditor.editedAt))
    )) throw invalid()
    const author = value.author
    if (
      !author
      || !['ai', 'human'].includes(author.kind)
      || typeof author.name !== 'string'
      || author.name.length > 300
      || (author.kind === 'ai' && typeof author.model !== 'string')
    ) throw invalid()
    const reviewed = value.status === 'ai-reviewed'
    if (!['ai-reviewed', 'review-pending'].includes(value.status)) throw invalid()
    if (
      reviewed
      && (value.contentHash !== contentHash
        || card.sources.some((/** @type {any} */ source) => source.publicationStatus)
        || value.reviewer?.kind !== 'ai'
        || typeof value.reviewer.name !== 'string'
        || typeof value.reviewer.model !== 'string')
    ) throw invalid()
    const findings = value.findings ?? []
    if (
      !Array.isArray(findings)
      || findings.length > 50
      || findings.some(
        (/** @type {any} */ f) => !f
          || typeof f.kind !== 'string'
          || f.kind.length > 100
          || typeof f.text !== 'string'
          || f.text.length > 4000
          || (f.sourceIndex != null
            && (!Number.isSafeInteger(f.sourceIndex) || f.sourceIndex < 1 || f.sourceIndex > card.sources.length)),
      )
    ) throw invalid()
    const sourceChecks = value.sourceChecks ?? []
    if (!Array.isArray(sourceChecks) || sourceChecks.length > card.sources.length || sourceChecks.some((/** @type {any} */ check) =>
      !check || typeof check !== 'object' || !Number.isSafeInteger(check.sourceIndex) || check.sourceIndex < 1 || check.sourceIndex > card.sources.length
      || !['checked', 'retained'].includes(check.status) || typeof check.attemptedAt !== 'string' || !Number.isFinite(Date.parse(check.attemptedAt))
      || (check.code != null && (typeof check.code !== 'string' || !/^[a-z0-9_]{2,100}$/.test(check.code))),
    ) || new Set(sourceChecks.map((/** @type {any} */ check) => check.sourceIndex)).size !== sourceChecks.length) throw invalid()
    for (const date of [value.sourceCheckedAt, value.sourceChangedAt, value.reviewedAt]) {
      if (date != null && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) throw invalid()
    }
    return {
      author,
      ...(lastEditor ? { lastEditor: { userId: lastEditor.userId, name: lastEditor.name, editedAt: lastEditor.editedAt } } : {}),
      reviewer: reviewed ? value.reviewer : null,
      contentHash,
      sourceFingerprint,
      sourceChecks,
      sourceCheckedAt: value.sourceCheckedAt ?? null,
      sourceChangedAt: value.sourceChangedAt ?? null,
      reviewedAt: reviewed ? (value.reviewedAt ?? new Date().toISOString()) : null,
      status: value.status,
      findings,
      reviewRevision: reviewed ? revision : null,
    }
  }
  return { evidenceHash, evidenceContentHash, evidenceSourceFingerprint, evidenceEditorialReceipt }
}

/**
 * Public source anchors stay short in languages that do not use spaces.
 * @param {string} documentText @param {string | null} [preserved]
 */
export function evidencePublicExcerpt(documentText, preserved = null) {
  const segmenter = new Intl.Segmenter('und', { granularity: 'word' })
  const words = (/** @type {string} */ value) => [...segmenter.segment(value)].filter((segment) => segment.isWordLike).length
  if (preserved && preserved.length <= 300 && words(preserved) <= 25 && documentText.includes(preserved)) return preserved
  const prefix = documentText.slice(0, 300)
  let count = 0
  let end = 0
  for (const segment of segmenter.segment(prefix)) {
    if (segment.isWordLike) count++
    end = segment.index + segment.segment.length
    if (count >= 25) break
  }
  return prefix.slice(0, end).trim()
}

// ---------------------------------------------------------------------------
// The structured content (question, answer, sections, tables, comparisons)
// ---------------------------------------------------------------------------

/**
 * @param {any} value @param {number} sourceCount
 * @returns {any}
 */
export function evidenceStructuredContent(value, sourceCount) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 50000) throw invalid()
  const string = (/** @type {any} */ v, max = 12000) => typeof v === 'string' && v.length <= max
  const indexes = (/** @type {any} */ v) => v == null || sourceIndexList(v, sourceCount)
  const count = (/** @type {any} */ v) => v == null || (Number.isSafeInteger(v) && v > 0)
  if (!onlyKeys(value, ['question', 'answer', 'population', 'context', 'nextStep', 'sections', 'tables', 'comparisons'])) throw invalid()
  for (const key of ['question', 'answer', 'population', 'context', 'nextStep']) {
    if (value[key] != null && !string(value[key])) throw invalid()
  }
  if (
    value.sections != null
    && (!Array.isArray(value.sections)
      || value.sections.length > 30
      || value.sections.some(
        (/** @type {any} */ s) => !s || typeof s !== 'object' || !string(s.title, 300) || !string(s.text) || !indexes(s.sourceIndexes),
      ))
  ) throw invalid()
  if (
    value.tables != null
    && (!Array.isArray(value.tables)
      || value.tables.length > 10
      || value.tables.some(
        (/** @type {any} */ t) => !t
          || typeof t !== 'object'
          || !string(t.title, 300)
          || !Array.isArray(t.columns)
          || !t.columns.length
          || t.columns.length > 12
          || !t.columns.every((/** @type {any} */ c) => string(c, 300))
          || !Array.isArray(t.rows)
          || t.rows.length > 100
          || t.rows.some((/** @type {any} */ r) => !Array.isArray(r) || r.length !== t.columns.length || !r.every((/** @type {any} */ c) => string(c, 3000)))
          || (t.caption != null && !string(t.caption))
          || !indexes(t.sourceIndexes),
      ))
  ) throw invalid()
  if (
    value.comparisons != null
    && (!Array.isArray(value.comparisons)
      || value.comparisons.length > 10
      || value.comparisons.some(
        (/** @type {any} */ c) => !c
          || typeof c !== 'object'
          || !string(c.title, 300)
          || !string(c.outcome, 500)
          || !string(c.timeframe, 500)
          || !Number.isFinite(c.denominator)
          || c.denominator <= 0
          || !['risk', 'rate'].includes(c.measure ?? 'risk')
          || (c.denominatorUnit != null && c.denominatorUnit !== ((c.measure ?? 'risk') === 'risk' ? 'people' : 'person-years'))
          || ![c.control, c.intervention].every(
            (/** @type {any} */ a) => a
              && string(a.label, 300)
              && Number.isFinite(a.events)
              && a.events >= 0
              && ((c.measure ?? 'risk') === 'rate' || a.events <= c.denominator),
          )
          || !indexes(c.sourceIndexes)
          || !c.sourceIndexes?.length
          || [c.relativeEffect, c.certainty, c.note].some((v) => v != null && !string(v))
          // The summary-of-findings columns a comparison may add (plan §4.1): the
          // people and studies behind the row, whether the outcome is a benefit
          // or a harm (the public fact box groups by it), and where the numbers
          // came from. All optional; a value never has to be explained to be left out.
          || !count(c.participants)
          || !count(c.studies)
          || (c.outcomeRole != null && !EVIDENCE_OUTCOME_ROLES.includes(c.outcomeRole))
          || (c.valueSource != null && !VCR_VALUE_SOURCES.includes(c.valueSource)),
      ))
  ) throw invalid()
  return value
}

// ---------------------------------------------------------------------------
// Producer, originality, lineage, entity keys, journey stage, disclosure
// ---------------------------------------------------------------------------

/** @param {any} value */
export function evidenceProducer(value) {
  if (!isRecord(value) || !onlyKeys(value, ['kind', 'name', 'relation', 'products'])) throw invalid('producer')
  if (!EVIDENCE_PRODUCER_KINDS.includes(value.kind)) throw invalid('producer kind')
  if (!filled(value.name, 300)) throw invalid('producer name')
  if (!EVIDENCE_PRODUCER_RELATIONS.includes(value.relation)) throw invalid('producer relation')
  if (value.products != null && !stringList(value.products, 200, 20)) throw invalid('producer products')
  const products = [...new Set((value.products ?? []).map((/** @type {string} */ name) => name.trim()))]
  return { kind: value.kind, name: value.name.trim(), relation: value.relation, ...(products.length ? { products } : {}) }
}

/**
 * The producer a card carries when its writer did not name one: the platform in
 * an official zone, the owner in a user zone, and none in a product zone —
 * where the producer is the company or doctor, and only they can say who.
 * @param {{ zoneKind: string, ownerName: string }} input
 */
export function evidenceDefaultProducer({ zoneKind, ownerName }) {
  if (zoneKind === 'official') return { kind: 'platform', name: EVIDENCE_PLATFORM_PRODUCER_NAME, relation: 'none' }
  if (zoneKind === 'user' && filled(ownerName, 300)) return { kind: 'user', name: ownerName.trim(), relation: 'none' }
  return null
}

/** @param {unknown} value */
export function evidenceOriginality(value) {
  if (!EVIDENCE_ORIGINALITY.includes(/** @type {any} */ (value))) throw invalid('originality')
  return /** @type {string} */ (value)
}

const FRONTIER_ITEM_ID = /^[a-z0-9]{12,32}$/
const LINEAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CARD_ID = /^ec_[A-Za-z0-9]{8,64}$/
const DOI = /^10\.\d{4,9}\/\S{1,200}$/
const PMID = /^[1-9]\d{0,8}$/
const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{3,39}$/
/** The lineage keys only the platform's own code paths may write: a user's session cannot vouch for a run. */
export const EVIDENCE_PLATFORM_LINEAGE_KEYS = frozen(['resultVersionId', 'runId', 'agendaId', 'episodeId'])

/**
 * Where a card came from. Every key is optional and validated by shape; an id
 * that looks right is not proof that it exists — the writer that knows (the
 * result publisher, the programme) is the one that stamps the run keys.
 * @param {any} value
 */
export function evidenceLineage(value) {
  if (value == null) return null
  if (!isRecord(value) || !onlyKeys(value, ['frontierItemId', 'resultVersionId', 'runId', 'agendaId', 'episodeId', 'previousCardId', 'originCardId', 'verifiedStudy'])) throw invalid('lineage')
  /** @type {Record<string, any>} */
  const out = {}
  if (value.frontierItemId != null) {
    if (typeof value.frontierItemId !== 'string' || !FRONTIER_ITEM_ID.test(value.frontierItemId)) throw invalid('lineage frontierItemId')
    out.frontierItemId = value.frontierItemId
  }
  for (const key of EVIDENCE_PLATFORM_LINEAGE_KEYS) {
    if (value[key] == null) continue
    if (typeof value[key] !== 'string' || !LINEAGE_ID.test(value[key])) throw invalid(`lineage ${key}`)
    out[key] = value[key]
  }
  for (const key of ['previousCardId', 'originCardId']) {
    if (value[key] == null) continue
    if (typeof value[key] !== 'string' || !CARD_ID.test(value[key])) throw invalid(`lineage ${key}`)
    out[key] = value[key]
  }
  if (value.verifiedStudy != null) {
    const study = value.verifiedStudy
    if (!isRecord(study) || !onlyKeys(study, ['doi', 'pmid', 'registryId'])) throw invalid('lineage verifiedStudy')
    /** @type {Record<string, string>} */
    const verified = {}
    if (study.doi != null) {
      if (typeof study.doi !== 'string' || !DOI.test(study.doi.trim())) throw invalid('lineage verifiedStudy doi')
      verified.doi = study.doi.trim().toLowerCase()
    }
    if (study.pmid != null) {
      if (!PMID.test(String(study.pmid))) throw invalid('lineage verifiedStudy pmid')
      verified.pmid = String(study.pmid)
    }
    if (study.registryId != null) {
      if (typeof study.registryId !== 'string' || !REGISTRY_ID.test(study.registryId.trim())) throw invalid('lineage verifiedStudy registryId')
      verified.registryId = study.registryId.trim()
    }
    if (Object.keys(verified).length) out.verifiedStudy = verified
  }
  return Object.keys(out).length ? out : null
}

/** The most keys a card carries, and the longest one. */
export const EVIDENCE_ENTITY_KEY_LIMITS = Object.freeze({ count: 40, length: 160 })

/**
 * Opaque entity keys from the frontier glossary (`<kind>:<name>`). The card
 * never interprets one; it only bounds them.
 * @param {unknown} value @returns {string[]}
 */
export function evidenceEntityKeys(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > EVIDENCE_ENTITY_KEY_LIMITS.count
    || value.some((key) => !filled(key, EVIDENCE_ENTITY_KEY_LIMITS.length) || hasControlCharacter(key))) throw invalid('entityKeys')
  return [...new Set(value.map((key) => key.trim()))]
}

/**
 * Keys given by the author, then those a resolver found, in a stable order and
 * within the bound — a resolver that over-finds loses its last keys, never the
 * author's.
 * @param {...unknown} lists @returns {string[]}
 */
export function evidenceMergeEntityKeys(...lists) {
  const keys = new Set()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const key of list) {
      if (typeof key === 'string' && filled(key, EVIDENCE_ENTITY_KEY_LIMITS.length) && !hasControlCharacter(key)) keys.add(key.trim())
    }
  }
  return [...keys].slice(0, EVIDENCE_ENTITY_KEY_LIMITS.count)
}

const JOURNEY_KEY = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,59}$/u

/**
 * A stage of the patient's journey, defined per disease and not from a fixed
 * table: `{ key, label }`.
 * @param {any} value
 */
export function evidenceJourneyStage(value) {
  if (value == null) return null
  if (!isRecord(value) || !onlyKeys(value, ['key', 'label'])) throw invalid('journeyStage')
  if (typeof value.key !== 'string' || !JOURNEY_KEY.test(value.key.trim())) throw invalid('journeyStage key')
  if (!filled(value.label, 80)) throw invalid('journeyStage label')
  return { key: value.key.trim(), label: value.label.trim() }
}

/** @param {unknown} value @param {string} what */
function people(value, what) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 20) throw invalid(what)
  return value.map((person) => {
    if (!isRecord(person) || !onlyKeys(person, ['name', 'affiliation', 'title']) || !filled(person.name, 200)
      || !optionalText(person.affiliation, 300) || !optionalText(person.title, 200)) throw invalid(what)
    return {
      name: person.name.trim(),
      ...(person.affiliation?.trim() ? { affiliation: person.affiliation.trim() } : {}),
      ...(person.title?.trim() ? { title: person.title.trim() } : {}),
    }
  })
}

/**
 * What a reader is told about how the card was made (RAISE: system, version,
 * date, which steps an AI took) and who stands behind it.
 * @param {any} value
 */
export function evidenceDisclosure(value) {
  if (value == null) return null
  if (!isRecord(value) || !onlyKeys(value, ['model', 'modelVersion', 'generatedAt', 'lastCheckedAt', 'aiSteps', 'authors', 'reviewers'])) throw invalid('disclosure')
  if (!optionalText(value.model, 200) || !optionalText(value.modelVersion, 200)) throw invalid('disclosure model')
  for (const key of ['generatedAt', 'lastCheckedAt']) {
    if (value[key] != null && !isoDate(value[key])) throw invalid(`disclosure ${key}`)
  }
  if (value.aiSteps != null && (!Array.isArray(value.aiSteps) || value.aiSteps.some((/** @type {any} */ step) => !EVIDENCE_AI_STEPS.includes(step)))) throw invalid('disclosure aiSteps')
  return {
    ...(value.model?.trim() ? { model: value.model.trim() } : {}),
    ...(value.modelVersion?.trim() ? { modelVersion: value.modelVersion.trim() } : {}),
    ...(value.generatedAt ? { generatedAt: value.generatedAt } : {}),
    ...(value.lastCheckedAt ? { lastCheckedAt: value.lastCheckedAt } : {}),
    aiSteps: EVIDENCE_AI_STEPS.filter((step) => (value.aiSteps ?? []).includes(step)),
    authors: people(value.authors, 'disclosure authors'),
    reviewers: people(value.reviewers, 'disclosure reviewers'),
  }
}

/**
 * The rules that join a card to the zone it sits in: who may sign it, that a
 * product card says where on the patient's journey it stands, and that a
 * company's or doctor's card names the people behind it. Each refusal names
 * its own code and touches only this write.
 *
 * Who may sign is judged when a producer is given. A write that keeps the
 * producer a card already has (`producerChanged: false`) is not asked again:
 * a card the platform signed in a zone that predates zone kinds stays signed.
 *
 * @param {{ zoneKind: string, producer: any, journeyStage: any, disclosure: any, producerChanged?: boolean }} card
 */
export function assertEvidenceCardForZone({ zoneKind, producer, journeyStage, disclosure, producerChanged = true }) {
  if (!producer) {
    throw new EvidenceCardError(400, 'evidence_producer_required', 'Every evidence card names its producer and the producer\'s relation to the products it concerns.')
  }
  const allowed = EVIDENCE_ZONE_PRODUCER_KINDS[/** @type {keyof typeof EVIDENCE_ZONE_PRODUCER_KINDS} */ (zoneKind)] ?? []
  if (producerChanged && !allowed.includes(producer.kind)) {
    throw new EvidenceCardError(400, 'evidence_producer_mismatch', `A ${zoneKind} zone's cards are signed by ${allowed.join(' or ') || 'no one'}, not by "${producer.kind}".`)
  }
  if (zoneKind === 'product' && !journeyStage) {
    throw new EvidenceCardError(400, 'evidence_journey_stage_required', 'A card in a product zone names its patient-journey stage.')
  }
  if (zoneKind === 'product' || producer.kind === 'enterprise' || producer.kind === 'doctor') {
    const missing = ['authors', 'reviewers'].filter((key) => !disclosure?.[key]?.length)
    if (missing.length) {
      throw new EvidenceCardError(400, 'evidence_disclosure_required', `A ${producer.kind} card discloses its ${missing.join(' and ')}.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** The most claims one card carries. */
export const EVIDENCE_CLAIM_LIMIT = 60
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/
const CLAIM_KEYS = ['claimId', 'claimType', 'claim', 'applicability', 'uncertainty', 'valueSource', 'sourceIndexes', 'supportQuote',
  'supportingSources', 'confidence', 'derivedFrom', 'method', 'assumptions', 'sensitivity']

/**
 * A card's claims, in the shape of a research run's evidence matrix adapted to
 * the card's own sources: a claim names the sources it stands on by 1-based
 * `sourceIndexes`.
 *
 * - `direct`: one source and a verbatim `supportQuote`.
 * - `synthesized`: a cross-source conclusion — at least two distinct sources, a
 *   quotation from each in `supportingSources`, and a `confidence`.
 * - `derived`: the analyst's own estimate. It names the claims it reasons from
 *   (`derivedFrom`, which must reach a quoted claim), its `method`, `assumptions`
 *   and `sensitivity`; it has no quotation to check.
 *
 * Shape is refused here; whether a quotation is in its source is a label
 * (`verifyEvidenceCardClaims`) and never a refusal.
 *
 * @param {unknown} value @param {number} sourceCount
 * @returns {any[]}
 */
export function evidenceCardClaims(value, sourceCount) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > EVIDENCE_CLAIM_LIMIT || JSON.stringify(value).length > 120000) throw invalid('claims')
  /** @type {any[]} */
  const claims = value.map((raw, position) => {
    const where = `claims[${position}]`
    if (!isRecord(raw) || !onlyKeys(raw, CLAIM_KEYS)) throw invalid(where)
    if (typeof raw.claimId !== 'string' || !CLAIM_ID.test(raw.claimId)) throw invalid(`${where}.claimId`)
    const claimType = raw.claimType ?? 'direct'
    if (!EVIDENCE_CLAIM_TYPES.includes(claimType)) throw invalid(`${where}.claimType`)
    if (!filled(raw.claim, 1500)) throw invalid(`${where}.claim`)
    if (!optionalText(raw.applicability, 800) || !optionalText(raw.uncertainty, 800)) throw invalid(`${where} text`)
    if (raw.valueSource != null && !VCR_VALUE_SOURCES.includes(raw.valueSource)) throw invalid(`${where}.valueSource`)
    const out = /** @type {Record<string, any>} */ ({
      claimId: raw.claimId,
      claimType,
      claim: raw.claim.trim(),
      ...(raw.applicability?.trim() ? { applicability: raw.applicability.trim() } : {}),
      ...(raw.uncertainty?.trim() ? { uncertainty: raw.uncertainty.trim() } : {}),
      ...(raw.valueSource ? { valueSource: raw.valueSource } : {}),
    })
    if (claimType === 'direct') {
      if (!sourceIndexList(raw.sourceIndexes, sourceCount) || raw.sourceIndexes.length !== 1) throw invalid(`${where}.sourceIndexes`)
      if (raw.supportQuote != null && !filled(raw.supportQuote, 2000)) throw invalid(`${where}.supportQuote`)
      if (raw.supportingSources != null || raw.derivedFrom != null || raw.method != null) throw invalid(`${where} fields of another claim type`)
      out.sourceIndexes = [...raw.sourceIndexes]
      if (raw.supportQuote != null) out.supportQuote = raw.supportQuote.trim()
    } else if (claimType === 'synthesized') {
      const bonds = raw.supportingSources
      if (!Array.isArray(bonds) || bonds.length < 2 || bonds.length > 12
        || bonds.some((/** @type {any} */ bond) => !isRecord(bond) || !onlyKeys(bond, ['sourceIndex', 'supportQuote'])
          || !Number.isSafeInteger(bond.sourceIndex) || bond.sourceIndex < 1 || bond.sourceIndex > sourceCount
          || (bond.supportQuote != null && !filled(bond.supportQuote, 2000)))
        || new Set(bonds.map((/** @type {any} */ bond) => bond.sourceIndex)).size !== bonds.length) throw invalid(`${where}.supportingSources`)
      if (!EVIDENCE_CLAIM_CONFIDENCE.includes(raw.confidence)) throw invalid(`${where}.confidence`)
      const indexes = bonds.map((/** @type {any} */ bond) => bond.sourceIndex).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b)
      if (raw.sourceIndexes != null && JSON.stringify([...raw.sourceIndexes].sort((/** @type {number} */ a, /** @type {number} */ b) => a - b)) !== JSON.stringify(indexes)) throw invalid(`${where}.sourceIndexes`)
      if (raw.supportQuote != null || raw.derivedFrom != null || raw.method != null) throw invalid(`${where} fields of another claim type`)
      out.confidence = raw.confidence
      out.sourceIndexes = indexes
      out.supportingSources = bonds.map((/** @type {any} */ bond) => ({ sourceIndex: bond.sourceIndex, ...(bond.supportQuote != null ? { supportQuote: bond.supportQuote.trim() } : {}) }))
    } else {
      if (!Array.isArray(raw.derivedFrom) || !raw.derivedFrom.length || raw.derivedFrom.length > 20
        || raw.derivedFrom.some((/** @type {unknown} */ id) => typeof id !== 'string' || !CLAIM_ID.test(id))) throw invalid(`${where}.derivedFrom`)
      for (const key of ['method', 'assumptions', 'sensitivity']) {
        if (!filled(raw[key], 3000)) throw invalid(`${where}.${key}`)
        out[key] = raw[key].trim()
      }
      if (raw.sourceIndexes != null || raw.supportQuote != null || raw.supportingSources != null) throw invalid(`${where} fields of another claim type`)
      if (raw.confidence != null && !EVIDENCE_CLAIM_CONFIDENCE.includes(raw.confidence)) throw invalid(`${where}.confidence`)
      if (raw.confidence != null) out.confidence = raw.confidence
      out.derivedFrom = [...new Set(raw.derivedFrom)]
    }
    return out
  })
  const ids = new Set(claims.map((claim) => claim.claimId))
  if (ids.size !== claims.length) throw invalid('claims have a repeated claimId')
  // A derived result stands on the quoted claims it reasons from. A chain of
  // derivations that ends in no measured evidence is not grounded.
  const grounded = new Set(claims.filter((claim) => claim.claimType !== 'derived').map((claim) => claim.claimId))
  const derived = claims.filter((claim) => claim.claimType === 'derived')
  for (const claim of derived) {
    if (claim.derivedFrom.some((/** @type {string} */ id) => id === claim.claimId || !ids.has(id))) throw invalid(`claim ${claim.claimId} derivedFrom`)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const claim of derived) {
      if (!grounded.has(claim.claimId) && claim.derivedFrom.some((/** @type {string} */ id) => grounded.has(id))) {
        grounded.add(claim.claimId)
        changed = true
      }
    }
  }
  const ungrounded = derived.find((claim) => !grounded.has(claim.claimId))
  if (ungrounded) throw invalid(`derived claim ${ungrounded.claimId} reaches no quoted claim`)
  return claims
}

const MARKS = Object.freeze({ verified: '✓', quote_not_found: '⚠', source_unavailable: '⚠', no_quote: '⚠', derived: null })
/** A status this build does not know is a warning, never a pass. @param {string} status @returns {'✓' | '⚠' | null} */
const markOf = (status) => (Object.hasOwn(MARKS, status) ? /** @type {any} */ (MARKS)[status] : '⚠')

/**
 * Whether each claim's quotation is in the source it names — per claim and per
 * source, counts and marks — by the same comparison the delivery gate and the
 * reader's ✓/⚠ use. A source's preserved text is its `documentText`, else its
 * `excerpt`; a source with neither is `source_unavailable`, never "not found".
 * `derived` claims have no quotation to check and carry `mark: null`.
 *
 * Statuses are labels. This function never refuses a card.
 *
 * @param {{ claims?: any[], sources?: any[] }} card
 * @param {{ locations?: boolean }} [options] `locations` adds each quotation's table, row, cell and page (best effort, time-boxed)
 * @returns {{ claims: { claimId: string, claimType: string, status: string, mark: '✓' | '⚠' | null, sources: { sourceIndex: number | null, status: string, mark: '✓' | '⚠' | null, location?: any }[] }[], counts: Record<string, number> }}
 */
export function verifyEvidenceCardClaims(card, options = {}) {
  const claims = Array.isArray(card?.claims) ? card.claims : []
  const sources = Array.isArray(card?.sources) ? card.sources : []
  const pathOf = (/** @type {number} */ index) => `.evimed-sources/card/source-${index}`
  /** @type {Map<string, string>} */
  const artifacts = new Map()
  /** @type {Map<string, number>} */
  const indexOfPath = new Map()
  sources.forEach((source, position) => {
    indexOfPath.set(pathOf(position + 1), position + 1)
    const preserved = typeof source?.documentText === 'string' && source.documentText ? source.documentText
      : typeof source?.excerpt === 'string' ? source.excerpt : ''
    if (preserved) artifacts.set(pathOf(position + 1), preserved)
  })
  const matrix = {
    claims: claims.map((claim) => {
      if (claim.claimType === 'synthesized') {
        return {
          claimId: claim.claimId,
          claimType: 'synthesized',
          supportingSources: (claim.supportingSources ?? []).map((/** @type {any} */ bond) => ({ artifactPath: pathOf(bond.sourceIndex), supportQuote: bond.supportQuote })),
        }
      }
      if (claim.claimType === 'derived') return { claimId: claim.claimId, claimType: 'derived' }
      return {
        claimId: claim.claimId,
        claimType: 'direct',
        ...(Array.isArray(claim.sourceIndexes) && claim.sourceIndexes.length ? { artifactPath: pathOf(claim.sourceIndexes[0]) } : {}),
        supportQuote: claim.supportQuote,
      }
    }),
  }
  const verdict = claimVerification({ matrix, sourceArtifacts: artifacts })
  if (options.locations && verdict.claims.length) attachClaimSourceLocations(verdict, { matrix, sourceArtifacts: artifacts })
  const counts = Object.fromEntries(['verified', 'quote_not_found', 'source_unavailable', 'no_quote', 'derived'].map((status) => [status, verdict.counts[status] ?? 0]))
  return {
    claims: verdict.claims.map((entry) => ({
      claimId: entry.claimId,
      claimType: entry.claimType,
      status: entry.status,
      mark: markOf(entry.status),
      sources: entry.sources.map((/** @type {any} */ source) => ({
        sourceIndex: indexOfPath.get(source.artifactPath) ?? null,
        status: source.status,
        mark: markOf(source.status),
        ...(source.location ? { location: source.location } : {}),
      })),
    })),
    counts: { total: verdict.claims.length, ...counts },
  }
}

// ---------------------------------------------------------------------------
// Rule 3: a simulation is never evidence
// ---------------------------------------------------------------------------

/** Value sources refused everywhere in a card. */
export const EVIDENCE_SIMULATED_VALUE_SOURCES = frozen(['predicted', 'assumed', 'synthetic'])
/** Value sources allowed only inside a derived claim that states its method. */
export const EVIDENCE_DERIVED_ONLY_VALUE_SOURCES = frozen(['imputed', 'reconstructed'])

/**
 * Every value in a card whose source label may not appear there, and where.
 * Comparisons and claims may carry a `valueSource` (the nine labels the
 * virtual-clinical-research module uses). A predicted, assumed or synthetic
 * value is refused anywhere; an imputed or reconstructed one only inside a
 * derived claim that states its method.
 *
 * @param {{ claims?: any[], content?: any }} card
 * @returns {{ code: 'evidence_value_source_refused', where: string, valueSource: string, reason: 'simulated' | 'derived_claim_only', message: string }[]}
 */
export function evidenceValueSourceIssues(card) {
  /** @type {any[]} */
  const issues = []
  /** @param {unknown} source @param {string} where @param {boolean} derivedWithMethod */
  const check = (source, where, derivedWithMethod) => {
    if (typeof source !== 'string') return
    const label = /** @type {Record<string, string>} */ (VCR_VALUE_SOURCE_LABELS_ZH)[source] ?? source
    if (EVIDENCE_SIMULATED_VALUE_SOURCES.includes(source)) {
      issues.push({
        code: 'evidence_value_source_refused', where, valueSource: source, reason: 'simulated',
        message: `${where} carries a value labelled "${source}" (${label}). A simulated value — predicted, assumed or synthetic — never enters an evidence card.`,
      })
    } else if (EVIDENCE_DERIVED_ONLY_VALUE_SOURCES.includes(source) && !derivedWithMethod) {
      issues.push({
        code: 'evidence_value_source_refused', where, valueSource: source, reason: 'derived_claim_only',
        message: `${where} carries a value labelled "${source}" (${label}). An imputed or reconstructed value appears only inside a derived claim that states its method.`,
      })
    }
  }
  const comparisons = Array.isArray(card?.content?.comparisons) ? card.content.comparisons : []
  comparisons.forEach((/** @type {any} */ comparison, /** @type {number} */ position) => check(comparison?.valueSource, `content.comparisons[${position}]`, false))
  for (const claim of Array.isArray(card?.claims) ? card.claims : []) {
    check(claim?.valueSource, `claim ${claim?.claimId}`, claim?.claimType === 'derived' && filled(claim?.method, 3000))
  }
  return issues
}

/** Refuses the card at its first simulated value, naming it. @param {{ claims?: any[], content?: any }} card */
export function assertEvidenceValueSources(card) {
  const [issue] = evidenceValueSourceIssues(card)
  if (issue) throw new EvidenceCardError(400, issue.code, issue.message)
}

// ---------------------------------------------------------------------------
// The two views of one card
// ---------------------------------------------------------------------------

/** @param {number} value */
const oneDecimal = (value) => Math.round(value * 10) / 10 + 0

/** The per-1000 figure a fact box and a summary-of-findings row use. */
export const EVIDENCE_ABSOLUTE_EFFECT_PER = 1000

/**
 * One comparison's absolute effect per 1000, computed from its events and its
 * denominator — the same denominator for both arms by construction. A figure a
 * model typed is never rendered as arithmetic. When the counts cannot give one,
 * the answer says why by a named reason.
 *
 * @param {any} comparison
 * @returns {{ status: 'computed', per: 1000, unit: 'people' | 'person-years', control: number, intervention: number, difference: number }
 *   | { status: 'unavailable', reason: 'no_comparison' | 'counts_missing' | 'events_exceed_denominator' }}
 */
export function evidenceAbsoluteEffect(comparison) {
  if (!isRecord(comparison)) return { status: 'unavailable', reason: 'no_comparison' }
  const denominator = comparison.denominator
  const control = comparison.control?.events
  const intervention = comparison.intervention?.events
  if (![denominator, control, intervention].every(Number.isFinite) || denominator <= 0 || control < 0 || intervention < 0) {
    return { status: 'unavailable', reason: 'counts_missing' }
  }
  const unit = (comparison.measure ?? 'risk') === 'rate' ? 'person-years' : 'people'
  if (unit === 'people' && (control > denominator || intervention > denominator)) return { status: 'unavailable', reason: 'events_exceed_denominator' }
  const per = EVIDENCE_ABSOLUTE_EFFECT_PER
  return {
    status: 'computed',
    per,
    unit,
    control: oneDecimal((control / denominator) * per),
    intervention: oneDecimal((intervention / denominator) * per),
    difference: oneDecimal(((intervention - control) / denominator) * per),
  }
}

/** Why a fact box has no row for a comparison, or none at all. */
export const EVIDENCE_FACT_BOX_REASONS = frozen(['no_comparisons', 'outcome_role_missing', 'counts_missing', 'events_exceed_denominator', 'not_per_people', 'nothing_usable'])

/**
 * The public fact box: per 1000 people, one denominator for both arms, benefits
 * and harms apart — every number computed here from the comparisons' events
 * and denominators. A comparison enters it only when it says whether its
 * outcome is a benefit or a harm and is a risk over people (a rate per
 * person-years is not a count of people). What cannot enter is listed with its
 * reason; when none can, the box is `unavailable` and says why.
 *
 * @param {any[]} comparisons
 */
export function evidenceFactBox(comparisons) {
  const list = Array.isArray(comparisons) ? comparisons : []
  /** @type {any[]} */ const benefits = []
  /** @type {any[]} */ const harms = []
  /** @type {{ index: number, reason: string }[]} */ const excluded = []
  list.forEach((comparison, position) => {
    const role = comparison?.outcomeRole
    if (!EVIDENCE_OUTCOME_ROLES.includes(role)) {
      excluded.push({ index: position, reason: 'outcome_role_missing' })
      return
    }
    const effect = evidenceAbsoluteEffect(comparison)
    if (effect.status !== 'computed') {
      excluded.push({ index: position, reason: effect.reason })
      return
    }
    if (effect.unit !== 'people') {
      excluded.push({ index: position, reason: 'not_per_people' })
      return
    }
    const row = {
      index: position,
      outcome: comparison.outcome,
      timeframe: comparison.timeframe,
      denominator: comparison.denominator,
      control: { label: comparison.control.label, per1000: effect.control },
      intervention: { label: comparison.intervention.label, per1000: effect.intervention },
      difference: effect.difference,
      sourceIndexes: comparison.sourceIndexes ?? [],
    }
    ;(role === 'benefit' ? benefits : harms).push(row)
  })
  const available = benefits.length + harms.length > 0
  return {
    status: available ? 'available' : 'unavailable',
    ...(available ? {} : { reason: list.length ? (excluded[0]?.reason ?? 'nothing_usable') : 'no_comparisons' }),
    per: EVIDENCE_ABSOLUTE_EFFECT_PER,
    unit: 'people',
    benefits,
    harms,
    excluded,
  }
}

/**
 * The author-filled panels of the public view — the seven of the evidence-card
 * layer, the seventh (sources and the date they were checked) being computed.
 */
export const EVIDENCE_PUBLIC_TEXT_PANELS = frozen(['oneLineAnswer', 'whatItIs', 'labelSays', 'notApplicable', 'seekCareWhen'])
export const EVIDENCE_PUBLIC_PANEL_LABELS_ZH = Object.freeze({
  oneLineAnswer: '一句话回答', whatItIs: '这是什么', labelSays: '说明书怎么说', notApplicable: '什么情况不适用',
  seekCareWhen: '出现什么情况立刻就医', commonMisunderstandings: '实测到的常见误解', sourcesAndCheckDate: '来源和核对日期',
})
export const EVIDENCE_PUBLIC_PANEL_LIMITS = Object.freeze({
  oneLineAnswer: 200, whatItIs: 800, labelSays: 1500, notApplicable: 1000, seekCareWhen: 1000, misunderstandings: 8, misunderstandingText: 300, correctionText: 600,
})

/** @param {unknown} value @param {Set<string>} claimIds @param {string} what */
function panelClaimIds(value, claimIds, what) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 12 || value.some((id) => typeof id !== 'string' || !claimIds.has(id))) throw invalid(`${what} claimIds name no claim of this card`)
  return [...new Set(value)]
}

/**
 * The content a card author fills for the public view (plan §4.1). Each panel
 * is `{ text, claimIds }` — or a plain string — and `claimIds` name the claims
 * of this card the panel's words stand on, which is how a plain-language
 * sentence is traced to a quotation. Length-limited so a panel stays a panel.
 *
 * @param {unknown} value @param {any[]} claims
 */
export function evidencePublicViewContent(value, claims) {
  if (value == null) return null
  const ids = new Set((Array.isArray(claims) ? claims : []).map((claim) => claim.claimId))
  if (!isRecord(value) || !onlyKeys(value, [...EVIDENCE_PUBLIC_TEXT_PANELS, 'commonMisunderstandings'])) throw invalid('publicView')
  /** @type {Record<string, any>} */
  const out = {}
  for (const key of EVIDENCE_PUBLIC_TEXT_PANELS) {
    const raw = value[key]
    if (raw == null) continue
    const panel = typeof raw === 'string' ? { text: raw } : raw
    const limit = /** @type {number} */ (EVIDENCE_PUBLIC_PANEL_LIMITS[/** @type {'oneLineAnswer'} */ (key)])
    if (!isRecord(panel) || !onlyKeys(panel, ['text', 'claimIds']) || !filled(panel.text, limit)) throw invalid(`publicView.${key}`)
    out[key] = { text: panel.text.trim(), claimIds: panelClaimIds(panel.claimIds, ids, `publicView.${key}`) }
  }
  if (value.commonMisunderstandings != null) {
    const items = value.commonMisunderstandings
    if (!Array.isArray(items) || items.length > EVIDENCE_PUBLIC_PANEL_LIMITS.misunderstandings) throw invalid('publicView.commonMisunderstandings')
    out.commonMisunderstandings = items.map((item) => {
      if (!isRecord(item) || !onlyKeys(item, ['misunderstanding', 'correction', 'observedIn', 'claimIds'])
        || !filled(item.misunderstanding, EVIDENCE_PUBLIC_PANEL_LIMITS.misunderstandingText)
        || !filled(item.correction, EVIDENCE_PUBLIC_PANEL_LIMITS.correctionText) || !optionalText(item.observedIn, 200)) throw invalid('publicView.commonMisunderstandings')
      return {
        misunderstanding: item.misunderstanding.trim(),
        correction: item.correction.trim(),
        ...(item.observedIn?.trim() ? { observedIn: item.observedIn.trim() } : {}),
        claimIds: panelClaimIds(item.claimIds, ids, 'publicView.commonMisunderstandings'),
      }
    })
  }
  return Object.keys(out).length ? out : null
}

/** @param {any} card @returns {any} */
const cardHeader = (card) => ({
  title: card?.title ?? null,
  producer: card?.producer ?? null,
  originality: card?.originality ?? null,
  primary: evidenceOriginalityIsPrimary(card?.originality),
  journeyStage: card?.journeyStage ?? null,
  disclosure: card?.disclosure ?? null,
})

/**
 * The card for doctors and pharmacists, in the layout of a GRADE
 * summary-of-findings table: one row per outcome with its time frame, the
 * relative effect as the author wrote it, the absolute effect per 1000 computed
 * here from events and denominators, the participants and studies behind it and
 * the certainty — beside the claims whose quotations were found in their
 * sources, and the producer and disclosure header.
 *
 * @param {any} card
 * @param {{ verification?: ReturnType<typeof verifyEvidenceCardClaims> }} [options]
 */
export function evidenceCardClinicalView(card, options = {}) {
  const verification = options.verification ?? verifyEvidenceCardClaims(card)
  const verified = new Set(verification.claims.filter((claim) => claim.status === 'verified').map((claim) => claim.claimId))
  const comparisons = Array.isArray(card?.content?.comparisons) ? card.content.comparisons : []
  return {
    kind: 'clinical',
    header: { ...cardHeader(card), lastCheckedAt: card?.disclosure?.lastCheckedAt ?? null },
    population: card?.content?.population ?? null,
    rows: comparisons.map((/** @type {any} */ comparison) => ({
      title: comparison.title,
      outcome: comparison.outcome,
      timeframe: comparison.timeframe,
      comparator: comparison.control?.label ?? null,
      intervention: comparison.intervention?.label ?? null,
      relativeEffect: comparison.relativeEffect ?? null,
      absoluteEffect: evidenceAbsoluteEffect(comparison),
      participants: comparison.participants ?? null,
      studies: comparison.studies ?? null,
      certainty: comparison.certainty ?? null,
      outcomeRole: comparison.outcomeRole ?? null,
      note: comparison.note ?? null,
      sourceIndexes: comparison.sourceIndexes ?? [],
    })),
    claims: /** @type {any[]} */ (Array.isArray(card?.claims) ? card.claims : []).filter((claim) => verified.has(claim.claimId)),
    counts: verification.counts,
  }
}

/**
 * The card for patients and the public: the six panels its author filled and a
 * seventh, sources and the date they were last checked, taken from the card —
 * plus a fact box computed in code. A panel says whether the claims it names
 * were all verified (`traced`); a panel the author left empty is `missing`.
 *
 * @param {any} card
 * @param {{ verification?: ReturnType<typeof verifyEvidenceCardClaims> }} [options]
 */
export function evidenceCardPublicView(card, options = {}) {
  const verification = options.verification ?? verifyEvidenceCardClaims(card)
  const verified = new Set(verification.claims.filter((claim) => claim.status === 'verified').map((claim) => claim.claimId))
  const traced = (/** @type {string[]} */ ids) => ids.length > 0 && ids.every((id) => verified.has(id))
  const authored = card?.publicView ?? card?.public_view ?? null
  /** @type {any[]} */
  const sources = Array.isArray(card?.sources) ? card.sources : []
  const checked = sources.map((source) => source?.checkedAt).filter((date) => isoDate(date)).sort()
  const labels = /** @type {Record<string, string>} */ (EVIDENCE_PUBLIC_PANEL_LABELS_ZH)
  /** @type {Record<string, any>[]} */
  const panels = [
    ...EVIDENCE_PUBLIC_TEXT_PANELS.map((key) => {
      const panel = authored?.[key]
      return panel
        ? { key, label: labels[key], status: 'written', text: panel.text, claimIds: panel.claimIds ?? [], traced: traced(panel.claimIds ?? []) }
        : { key, label: labels[key], status: 'missing', text: null, claimIds: [], traced: false }
    }),
    {
      key: 'commonMisunderstandings',
      label: labels.commonMisunderstandings,
      status: authored?.commonMisunderstandings?.length ? 'written' : 'missing',
      items: (authored?.commonMisunderstandings ?? []).map((/** @type {any} */ item) => ({ ...item, traced: traced(item.claimIds ?? []) })),
    },
    {
      key: 'sourcesAndCheckDate',
      label: labels.sourcesAndCheckDate,
      status: sources.length ? 'written' : 'missing',
      sources: sources.map((source) => ({ title: source.title, url: source.url ?? null })),
      checkedAt: card?.disclosure?.lastCheckedAt ?? card?.editorial?.sourceCheckedAt ?? checked.at(-1) ?? null,
    },
  ]
  return {
    kind: 'public',
    header: cardHeader(card),
    panels,
    factBox: evidenceFactBox(card?.content?.comparisons),
  }
}

// ---------------------------------------------------------------------------
// Identifiers and texts the entity-key resolver reads
// ---------------------------------------------------------------------------

/**
 * The DOIs, PMIDs, PMC ids and registry numbers a card is about, from the study
 * it verified and from the addresses of its sources — normalized to
 * `doi:`, `pmid:`, `pmcid:` and `registry:` and lower case, in a stable order.
 * Closed formats only; nothing here reads prose.
 *
 * @param {{ sources?: any[], lineage?: any }} card @returns {string[]}
 */
export function evidenceCardIdentifiers(card) {
  const found = new Set()
  const study = card?.lineage?.verifiedStudy
  if (study?.doi) found.add(`doi:${String(study.doi).toLowerCase()}`)
  if (study?.pmid) found.add(`pmid:${study.pmid}`)
  if (study?.registryId) found.add(`registry:${String(study.registryId).toLowerCase()}`)
  for (const source of Array.isArray(card?.sources) ? card.sources : []) {
    const url = typeof source?.url === 'string' ? source.url : ''
    let decoded = url
    try { decoded = decodeURIComponent(url) } catch { /* an address that does not decode is read as written */ }
    for (const match of decoded.matchAll(/(?:^|\/\/|\.)(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/gi)) found.add(`doi:${match[1].toLowerCase()}`)
    for (const match of decoded.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})/gi)) found.add(`pmid:${match[1]}`)
    for (const match of decoded.matchAll(/\b(PMC\d{4,10})\b/g)) found.add(`pmcid:${match[1].toLowerCase()}`)
    for (const match of decoded.matchAll(/\b(NCT\d{8})\b/gi)) found.add(`registry:${match[1].toLowerCase()}`)
  }
  return [...found].sort()
}

/**
 * The words of a card an entity resolver reads: title, summary, the question,
 * answer and population, each comparison's outcome and each claim. Bounded.
 * @param {any} card @returns {string[]}
 */
export function evidenceCardTexts(card) {
  const content = card?.content ?? {}
  const parts = [
    card?.title, card?.summary, content.question, content.answer, content.population, content.context,
    ...(Array.isArray(content.comparisons) ? content.comparisons.flatMap((/** @type {any} */ c) => [c?.title, c?.outcome]) : []),
    ...(Array.isArray(card?.claims) ? card.claims.map((/** @type {any} */ claim) => claim?.claim) : []),
  ]
  return parts.filter((part) => typeof part === 'string' && part.trim()).slice(0, 60).map((part) => part.trim().slice(0, 2000))
}

// ---------------------------------------------------------------------------
// Who may write where (plan §4.3 rule 1)
// ---------------------------------------------------------------------------

/**
 * Whether a write reaches a zone, by origin:
 *
 * - an official zone is written only by `import`, `model` and `programme`, and
 *   only as the platform's publisher;
 * - a product zone by `owner` and `geo`, and only by its owner;
 * - a user zone by `owner`, `result` and `model` (their own upkeep), and only
 *   by its owner.
 *
 * Everything else is refused with `evidence_write_origin_refused`, which names
 * the origin and the zone kind. The refusal touches this write and nothing else.
 *
 * @param {{ origin: string, zoneKind: string, actorIsZoneOwner: boolean, actorIsPlatformPublisher: boolean }} input
 * @returns {{ allowed: boolean, code?: 'evidence_write_origin_refused', origin?: string, zoneKind?: string, message?: string }}
 */
export function evidenceWriteAllowed({ origin, zoneKind, actorIsZoneOwner, actorIsPlatformPublisher }) {
  const allowed = (() => {
    if (zoneKind === 'official') return ['import', 'model', 'programme'].includes(origin) && Boolean(actorIsPlatformPublisher)
    if (zoneKind === 'product') return ['owner', 'geo'].includes(origin) && Boolean(actorIsZoneOwner)
    if (zoneKind === 'user') return ['owner', 'result', 'model'].includes(origin) && Boolean(actorIsZoneOwner)
    return false
  })()
  if (allowed) return { allowed: true }
  return {
    allowed: false,
    code: 'evidence_write_origin_refused',
    origin: String(origin),
    zoneKind: String(zoneKind),
    message: `A write from origin "${origin}" is not accepted by a ${zoneKind} zone.`,
  }
}

/** The throwing form of `evidenceWriteAllowed`. @param {Parameters<typeof evidenceWriteAllowed>[0]} input */
export function assertEvidenceWriteAllowed(input) {
  const verdict = evidenceWriteAllowed(input)
  if (!verdict.allowed) throw new EvidenceCardError(403, verdict.code ?? 'evidence_write_origin_refused', verdict.message ?? 'The write is refused.')
}

// ---------------------------------------------------------------------------
// Ordering (plan §4.3 rule 1: no paid field)
// ---------------------------------------------------------------------------

/**
 * A comparator over the closed list of ranking inputs. `order` lists the inputs
 * to compare by, in turn, each `'name'` (larger first) or `{ input, direction }`
 * with direction `'desc'` (default) or `'asc'`; a key outside
 * `EVIDENCE_RANKING_INPUTS` throws `evidence_ranking_input_unknown` when the
 * comparator is made. Items carry their input values in `ranking`; an absent
 * value sorts last, and ties fall to `id`.
 *
 * The factory is the only way ordering code reads an item, so a paid or
 * commercial field cannot influence an order without first being added to the
 * list — which is a visible change to this module, and to its test.
 *
 * @param {(string | { input: string, direction?: 'asc' | 'desc' })[]} order
 * @returns {(a: { id: string, ranking?: Record<string, number | null | undefined> }, b: { id: string, ranking?: Record<string, number | null | undefined> }) => number}
 */
export function evidenceRankingComparator(order) {
  if (!Array.isArray(order) || !order.length) {
    throw new EvidenceCardError(500, 'evidence_ranking_input_unknown', 'A ranking names at least one input.')
  }
  const keys = order.map((entry) => {
    const input = typeof entry === 'string' ? entry : entry?.input
    if (!EVIDENCE_RANKING_INPUTS.includes(input)) {
      throw new EvidenceCardError(500, 'evidence_ranking_input_unknown', `"${input}" is not a ranking input; ordering reads only ${EVIDENCE_RANKING_INPUTS.join(', ')}.`)
    }
    return { input, sign: typeof entry !== 'string' && entry?.direction === 'asc' ? -1 : 1 }
  })
  return (a, b) => {
    for (const { input, sign } of keys) {
      const left = a?.ranking?.[input]
      const right = b?.ranking?.[input]
      const leftKnown = typeof left === 'number' && Number.isFinite(left)
      const rightKnown = typeof right === 'number' && Number.isFinite(right)
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
      if (leftKnown && rightKnown && left !== right) return (right - left) * sign
    }
    return String(a?.id ?? '') < String(b?.id ?? '') ? -1 : String(a?.id ?? '') > String(b?.id ?? '') ? 1 : 0
  }
}
