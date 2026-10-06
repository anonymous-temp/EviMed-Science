/**
 * Keeping evidence current: the vocabulary of the public change log, of a reader's challenge, and the one rule that says who
 * answers when something that bears on a card turns up (evidence-flywheel plan 2026-10-05 §2.5, §5.4, §8, F13, F14).
 *
 * The change log is the card's public history in Cochrane's terms (the "What's new" event categories, RevMan knowledge
 * base, plan appendix A item 63): re-searched and nothing changed, new evidence with the conclusion changed or unchanged,
 * a correction, a withdrawal, retirement. Its trigger — a source change, new evidence, a reader's challenge, the
 * producer's own edit, a scheduled check — says what made the entry. Both lists are closed, and the SQL CHECKs of
 * `apps/server/src/evidenceZonePersistence.mjs` are made from them, so the table and the contract cannot disagree.
 *
 * Hidden knowledge:
 *
 * - **A reader-facing sentence is made by code from facts, never by a model.** `evidenceChangeSummaryZh` is the only
 *   author of a log entry's text: a model that wrote the public history of a card could be wrong in the one place a
 *   reader goes to check whether it was.
 * - **Who answers is decided by who made the card.** An AI-written card (the platform's brief, or the owner's own upkeep of
 *   their zone) is revised by the editor; a card of a user, a company or a doctor is never rewritten by the platform — its
 *   producer is told; an official synthesis is the platform's topic programme's to redo, not the editor's.
 * - **"Conclusion changed" is a comparison of what the card concludes, not of its prose.** `evidenceConclusionChanged`
 *   compares the answer, the summary, the claims and the comparisons' numbers; a rewritten paragraph that says the same
 *   thing is not a changed conclusion, and a changed hazard ratio is.
 *
 * Pure, browser-safe, no I/O, no clock (callers pass times).
 * @module @evimed/domain/evidenceUpkeep
 */

import { SOURCE_CHANGE_LABELS_ZH } from './sourceChange.mjs'

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

/**
 * What an entry of the change log says happened (plan §8, after Cochrane): the search was repeated and the conclusion
 * stands; new studies were taken in and the conclusion changed, or did not; something was corrected; something was withdrawn;
 * the card is no longer kept up to date.
 */
export const EVIDENCE_CHANGE_CATEGORIES = frozen([
  'searched_no_change', 'new_evidence_conclusion_changed', 'new_evidence_conclusion_unchanged', 'correction', 'withdrawal', 'retired',
])
export const EVIDENCE_CHANGE_CATEGORY_LABELS_ZH = Object.freeze({
  searched_no_change: '已重新检索，结论未变',
  new_evidence_conclusion_changed: '有新研究，结论改变',
  new_evidence_conclusion_unchanged: '有新研究，结论未变',
  correction: '更正',
  withdrawal: '撤回',
  retired: '不再更新',
})

/** What made the entry. */
export const EVIDENCE_CHANGE_TRIGGERS = frozen(['source_change', 'new_evidence', 'challenge', 'producer_edit', 'scheduled_check'])
export const EVIDENCE_CHANGE_TRIGGER_LABELS_ZH = Object.freeze({
  source_change: '来源变更',
  new_evidence: '新证据',
  challenge: '读者质疑',
  producer_edit: '出品方修改',
  scheduled_check: '定期核对',
})

/** The longest reader-facing summary an entry carries. */
export const EVIDENCE_CHANGE_SUMMARY_MAX_CHARS = 600

/**
 * A challenge is `open` until the platform's re-check has judged it, `notified` while a producer who is not the platform
 * has been told and has not answered, `resolved` once the platform judged it, and `closed` when the producer's own later
 * edit (or withdrawal) closed it.
 */
export const EVIDENCE_CHALLENGE_STATES = frozen(['open', 'notified', 'resolved', 'closed'])
/** What the re-check of a platform card may conclude: the claim stands, its wording is amended, or it is withdrawn. */
export const EVIDENCE_CHALLENGE_OUTCOMES = frozen(['uphold', 'amend', 'withdraw'])
export const EVIDENCE_CHALLENGE_OUTCOME_LABELS_ZH = Object.freeze({ uphold: '维持', amend: '修正', withdraw: '撤回' })
/** Who re-checks a challenge: the platform for its own cards, the producer for everyone else's. */
export const EVIDENCE_CHALLENGE_ROUTES = frozen(['platform_recheck', 'producer_notice'])
/** What a reader may write with a challenge. */
export const EVIDENCE_CHALLENGE_REASON_LIMITS = Object.freeze({ min: 4, max: 1000 })

/** Who answers when something bears on a card (`evidenceUpkeepRoute`). */
export const EVIDENCE_UPKEEP_ROUTES = frozen(['editor', 'producer_notice', 'programme'])

/** The `producer.kind` of the platform's own cards; the only cards the platform re-checks itself on a challenge. */
const PLATFORM_PRODUCER = 'platform'
/** Lineage keys only the platform's programme and results stamp (`EVIDENCE_PLATFORM_LINEAGE_KEYS`). */
const PROGRAMME_LINEAGE_KEYS = frozen(['resultVersionId', 'runId', 'agendaId', 'episodeId'])

/**
 * Who answers when new evidence, or a changed source, bears on a card.
 *
 * - `editor` — the card was written by an AI and is kept by one: the platform's brief in an official zone, or a card the
 *   owner's own AI upkeep wrote in their zone. The existing editor flow writes the follow-up revision.
 * - `programme` — an official card the platform's topic programme made (a synthesis, an original analysis, a
 *   recalculation, or anything stamped with a run, agenda or result): the editor does not rewrite it, it stays labelled
 *   until the programme redoes it.
 * - `producer_notice` — everything else: a user's, company's or doctor's card (and an external import). It is never
 *   rewritten; its producer is told once per batch.
 *
 * @param {{ zoneKind?: string | null, producerKind?: string | null, authorKind?: string | null, originality?: string | null, lineage?: Record<string, any> | null }} card
 * @returns {'editor' | 'producer_notice' | 'programme'}
 */
export function evidenceUpkeepRoute({ zoneKind = null, producerKind = null, authorKind = null, originality = null, lineage = null } = {}) {
  if (zoneKind === 'product') return 'producer_notice'
  const stamped = PROGRAMME_LINEAGE_KEYS.some((key) => lineage?.[key] != null)
  if (zoneKind === 'official') {
    if (stamped || (originality && originality !== 'brief')) return 'programme'
    return authorKind === 'ai' ? 'editor' : 'producer_notice'
  }
  return authorKind === 'ai' && producerKind !== 'enterprise' && producerKind !== 'doctor' ? 'editor' : 'producer_notice'
}

/** Whether a challenge on this card is re-checked by the platform: only the platform's own cards are. @param {{ producerKind?: string | null }} card */
export const evidenceChallengeRoute = ({ producerKind = null } = {}) => (producerKind === PLATFORM_PRODUCER ? 'platform_recheck' : 'producer_notice')

/**
 * What a card concludes, as a value two versions can be compared by: its answer and summary, each claim's id and statement,
 * and each comparison's outcome, counts and effect. Prose elsewhere (sections, limitations, body) is not part of it.
 * @param {any} card
 */
export function evidenceConclusionOf(card) {
  const content = card?.content ?? {}
  const comparison = (/** @type {any} */ entry) => [
    entry?.outcome ?? null, entry?.timeframe ?? null, entry?.denominator ?? null, entry?.control?.events ?? null,
    entry?.intervention?.events ?? null, entry?.relativeEffect ?? null, entry?.certainty ?? null,
  ]
  return {
    answer: typeof content.answer === 'string' ? content.answer.trim() : null,
    summary: typeof card?.summary === 'string' ? card.summary.trim() : null,
    claims: (Array.isArray(card?.claims) ? card.claims : []).map((/** @type {any} */ claim) => [claim?.claimId ?? null, typeof claim?.claim === 'string' ? claim.claim.trim() : null]),
    comparisons: (Array.isArray(content.comparisons) ? content.comparisons : []).map(comparison),
  }
}

/** @param {any} value @returns {string} a JSON text that does not depend on key order */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

/** Whether the second version concludes something different from the first. @param {any} before @param {any} after */
export function evidenceConclusionChanged(before, after) {
  return stable(evidenceConclusionOf(before)) !== stable(evidenceConclusionOf(after))
}

/** @param {unknown} value */
const day = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null)
/** @param {any} facts */
const revisions = (facts) => (Number.isSafeInteger(facts?.revisionBefore) && Number.isSafeInteger(facts?.revisionAfter) ? `（第 ${facts.revisionBefore} 版 → 第 ${facts.revisionAfter} 版）` : '')
/** @param {unknown} value */
const count = (value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) > 0 ? /** @type {number} */ (value) : 0)

/**
 * The sentence a reader sees for one entry of the change log, made from structured facts.
 *
 * `facts` may carry: `sourceChangeKinds` (`SOURCE_CHANGE_KINDS` of the notices), `sourceCount`, `itemCount`,
 * `sameWork` (the new items name a study the card already cites), `claimId`, `outcome` (a challenge's), `cardWithdrawn`,
 * `calculated` (the challenged claim states a platform calculation, which is checked against its receipt and not against a source),
 * `lostCalculationBasis` (the card was taken back because its last calculated claim was withdrawn), `revisionBefore`/`revisionAfter`, `retiredBy` (`producer` | `inactivity`), `lastCheckedAt`, `reviewed` (the producer
 * judged the new evidence and changed nothing).
 *
 * @param {{ category: string, trigger: string, facts?: Record<string, any> }} entry
 * @returns {string}
 */
export function evidenceChangeSummaryZh({ category, trigger, facts = {} }) {
  const claim = typeof facts.claimId === 'string' && facts.claimId ? `结论 ${facts.claimId}` : '一条结论'
  const items = count(facts.itemCount)
  const kinds = [...new Set((Array.isArray(facts.sourceChangeKinds) ? facts.sourceChangeKinds : [])
    .map((/** @type {string} */ kind) => /** @type {Record<string, string>} */ (SOURCE_CHANGE_LABELS_ZH)[kind]).filter(Boolean))]
  const text = (() => {
    if (category === 'retired') {
      const checked = day(facts.lastCheckedAt)
      return `${facts.retiredBy === 'producer' ? '出品方说明这张卡不再更新' : '连续多次核对都没有出现与本卡对得上的新研究，也没有读者关注，本卡转为不再更新'}${checked ? `，最后核对日期 ${checked}` : ''}。`
    }
    if (trigger === 'challenge') {
      if (category === 'withdrawal') {
        const ground = facts.calculated ? '它的计算依据对不上平台保存的回执' : '原文不能支持'
        const card = facts.cardWithdrawn ? (facts.lostCalculationBasis ? '，本卡的结论里已没有一条带计算依据，一手分析无法成立，本卡一并撤回' : '，本卡因没有保留任何结论而一并撤回') : ''
        return `读者对${claim}提出质疑；复核认定${ground}，已撤回该条结论${card}${revisions(facts)}。`
      }
      if (category === 'correction') return `读者对${claim}提出质疑；复核后修正了该条结论的表述${facts.calculated ? '，数字仍与平台保存的回执一致' : '和所依据的原文句子'}${revisions(facts)}。`
      return `读者对${claim}提出质疑；复核后维持原结论，${facts.calculated ? '数字已按平台保存的回执重新核对' : '所依据的原文句子已重新核对'}。`
    }
    if (trigger === 'source_change') {
      const sources = count(facts.sourceCount)
      return `本卡引用的${sources > 1 ? ` ${sources} 个` : ''}来源${kinds.length ? `出现了「${kinds.join('」「')}」` : '出现了变更'}，本卡已标注，依据这些来源的结论待复核。`
    }
    if (trigger === 'producer_edit') {
      if (category === 'new_evidence_conclusion_unchanged' && facts.reviewed) return `出品方核对了${items ? ` ${items} 项` : ''}新研究，认为不影响本卡，结论未变。`
      // An edit that answers new studies the platform had pointed to says so, and whether the conclusion moved.
      if (category === 'new_evidence_conclusion_changed') return `出品方核对了${items ? ` ${items} 项` : ''}新研究并更新了本卡；结论有变化${revisions(facts)}。`
      if (category === 'new_evidence_conclusion_unchanged') return `出品方核对了${items ? ` ${items} 项` : ''}新研究并更新了本卡；结论未变${revisions(facts)}。`
      return `出品方更新了本卡${revisions(facts)}。`
    }
    if (category === 'new_evidence_conclusion_changed') return `${items ? `有 ${items} 项` : '有'}${facts.sameWork ? '关于本卡所引研究的新报道' : '与本卡对得上的新研究'}，已纳入并更新；结论有变化${revisions(facts)}。`
    if (category === 'new_evidence_conclusion_unchanged') return `${items ? `有 ${items} 项` : '有'}${facts.sameWork ? '关于本卡所引研究的新报道' : '与本卡对得上的新研究'}，已核对并纳入；结论未变${revisions(facts)}。`
    return '平台重新比对了前沿动态里的新研究，没有发现与本卡对得上的新证据，结论未变。'
  })()
  return text.slice(0, EVIDENCE_CHANGE_SUMMARY_MAX_CHARS)
}

/** The notice a producer reads when new studies may affect a card of theirs the platform will not rewrite (F13). @param {{ count: number }} input */
export const evidenceNewEvidenceNoticeTitleZh = ({ count: n }) => `有 ${count(n) || 1} 项新研究可能影响你的卡片`

/**
 * Every refusal of this module, in the words a reader is shown (`errorCodes.mjs` registers them). Each refuses one precise
 * operation: enabling a rewrite the platform may not make, filing a challenge that cannot be filed.
 */
export const EVIDENCE_UPKEEP_ERROR_MESSAGES_ZH = Object.freeze({
  evidence_automation_product_zone: '产品专区的卡片由出品方自己写，AI 不会代写，所以这里不能开启自动更新；有新研究可能影响卡片时，平台会用站内通知告诉出品方。',
  evidence_upkeep_not_enabled: '这个部署没有开启证据卡的持续更新与质疑。',
  evidence_challenge_invalid: '质疑需要指明一条结论，并写明理由（4 到 1000 个字）。',
  evidence_challenge_claim_unknown: '这张卡里没有你要质疑的那条结论，可能已经被修改，请刷新后再试。',
  evidence_challenge_exists: '你已经对这条结论提出过质疑，还在处理中；处理完之后可以再提。',
  evidence_challenge_rate_limited: '你今天提出的质疑已达上限，明天再试；已提出的质疑仍在处理。',
  evidence_challenge_own_card: '这是你自己的卡片，请直接修改。',
  evidence_card_withdrawn: '这张卡已经撤回，不再接受质疑；撤回的原因写在卡片的说明页上。',
  evidence_upkeep_action_invalid: '这个操作不对：只能把自己的卡片标为“不再更新”、重新开启更新，或标明已核对过新研究。',
})
export const EVIDENCE_UPKEEP_ERROR_CODES = frozen(Object.keys(EVIDENCE_UPKEEP_ERROR_MESSAGES_ZH))
