/**
 * Topic zones of 「证据专区」 (owner, 2026-10-29; plan `docs/superpowers/plans/2026-10-29-evidence-zone-topics.md` v1.2).
 *
 * A zone is one topic of two or three keywords — 「GLP-1 受体激动剂减重」, 「ADC 治疗 HER2 低表达乳腺癌」 — not a department and not a
 * whole disease. Its page gathers the frontier items that belong to it and, later, the evidence cards an external interface supplies.
 * Two kinds share one page: the platform's zones (`kind = 'official'`, signed 「EviMed 证据中心」, chosen by the planner) and a reader's
 * own (`kind = 'user'`, 「我的专区」: a sentence the reader typed, which the platform keeps collecting and summarising for them).
 *
 * Hidden knowledge:
 *
 * - **The model decides; these words guide it.** The owner (2026-10-29): rules cannot cover natural language, so which zones exist,
 *   how a zone's keywords read and whether an item belongs to a zone are the model's judgements. "Two or three keywords", the
 *   grammar 主体 × 限定 (× 视角) and the weekly band are written into the model's instructions as guidance (`EVIDENCE_ZONE_GUIDANCE`);
 *   no code refuses a zone for its width or its words. Code holds only the shape of a definition (closed lists, lengths) and the
 *   exact things — dates, counts, the order of a page's modules.
 * - **No approval anywhere.** A zone is live the moment it is made; publishing a reader's zone to the platform is one click and is
 *   not reviewed. The band is a hint a reader sees (`evidenceZoneBand`), never a refusal.
 * - **A page is composed by code, not by the model.** Which modules a zone's overview shows and in which order is a table per zone
 *   type (`EVIDENCE_ZONE_MODULE_ORDER`); a module with too little to show is left out (`EVIDENCE_ZONE_MODULE_RULES`). The only text the
 *   model writes on the page is 「最新进展」, checked like the hot topics' overview.
 * - **An item's role is its genre.** Which list an item stands in (研究, 指南共识, 审批监管, …) is read from the genre the pipeline
 *   already gave it (`evidenceZoneRole`), not judged again.
 *
 * @module evidenceZoneTopics
 */

import { frontierItemGenre } from './frontierGenres.mjs'

/**
 * @template {string} T
 * @param {readonly T[]} list
 * @returns {readonly T[]}
 */
const frozen = (list) => Object.freeze([...list])

/** The definition shape's version; a definition written under another is read again by the drafter. */
export const EVIDENCE_ZONE_DEFINITION_VERSION = 1

/**
 * The four kinds of standing zone (plan §4.2.1). A congress keeps its own page (`frontier/congress`), and a hot event its topic.
 * @typedef {'drug-indication' | 'disease-strategy' | 'technology-use' | 'policy'} EvidenceZoneType
 */
export const EVIDENCE_ZONE_TYPES = /** @type {readonly EvidenceZoneType[]} */ (frozen([
  'drug-indication', 'disease-strategy', 'technology-use', 'policy',
]))
export const EVIDENCE_ZONE_TYPE_LABELS_ZH = /** @type {Readonly<Record<EvidenceZoneType, string>>} */ (Object.freeze({
  'drug-indication': '药物类别 × 适应症',
  'disease-strategy': '疾病 × 治疗策略',
  'technology-use': '技术 × 临床应用',
  policy: '政策与支付',
}))

/**
 * The optional third keyword: the angle a zone reads its subject from, borrowed from MeSH qualifiers and PubMed Clinical Queries.
 * It is judged by the model (is the item's focus this angle?), never matched as words.
 * @typedef {'efficacy' | 'safety' | 'diagnosis' | 'prevention' | 'prognosis' | 'guideline' | 'access' | 'pipeline'} EvidenceZonePerspective
 */
export const EVIDENCE_ZONE_PERSPECTIVES = /** @type {readonly EvidenceZonePerspective[]} */ (frozen([
  'efficacy', 'safety', 'diagnosis', 'prevention', 'prognosis', 'guideline', 'access', 'pipeline',
]))
export const EVIDENCE_ZONE_PERSPECTIVE_LABELS_ZH = /** @type {Readonly<Record<EvidenceZonePerspective, string>>} */ (Object.freeze({
  efficacy: '疗效',
  safety: '安全性',
  diagnosis: '诊断与检测',
  prevention: '筛查与预防',
  prognosis: '预后',
  guideline: '指南与共识',
  access: '可及性与支付',
  pipeline: '研发管线',
}))

/**
 * A zone's life (plan §6.4). `none` is a zone with no topic definition — a 循证 GEO product zone, or a reader's container for the
 * cards a research result became — which no directory lists.
 * @typedef {'none' | 'active' | 'quiet' | 'archived'} EvidenceZoneLifecycle
 */
export const EVIDENCE_ZONE_LIFECYCLES = /** @type {readonly EvidenceZoneLifecycle[]} */ (frozen(['none', 'active', 'quiet', 'archived']))

/**
 * Where an item stands on a zone's page, read from its genre (plan §6.2 step 3).
 * @typedef {'research' | 'guideline' | 'approval' | 'policy' | 'safety' | 'conference' | 'industry' | 'news'} EvidenceZoneRole
 */
export const EVIDENCE_ZONE_ROLES = /** @type {readonly EvidenceZoneRole[]} */ (frozen([
  'research', 'guideline', 'approval', 'policy', 'safety', 'conference', 'industry', 'news',
]))
export const EVIDENCE_ZONE_ROLE_LABELS_ZH = /** @type {Readonly<Record<EvidenceZoneRole, string>>} */ (Object.freeze({
  research: '研究',
  guideline: '指南共识',
  approval: '审批监管',
  policy: '医保与政策',
  safety: '药物安全',
  conference: '会议',
  industry: '产业',
  news: '资讯观点',
}))

/** @type {Readonly<Record<string, EvidenceZoneRole>>} */
const ROLE_BY_GENRE = Object.freeze({
  paper: 'research',
  preprint: 'research',
  trial: 'research',
  guideline: 'guideline',
  approval: 'approval',
  policy: 'policy',
  safety: 'safety',
  conference: 'conference',
  industry: 'industry',
})

/**
 * An item's role on a zone page, from the one reading rule for its genre (`frontierItemGenre`: the stored genre, code's fallback
 * from the item's columns when none was written). A safety alert is 药物安全 whatever its genre.
 * @param {Parameters<typeof frontierItemGenre>[0] & { safetyAlert?: boolean | null }} item
 * @returns {EvidenceZoneRole}
 */
export function evidenceZoneRole(item) {
  if (item?.safetyAlert === true || item?.safety_alert === true) return 'safety'
  return ROLE_BY_GENRE[frontierItemGenre(item)] ?? 'news'
}

/** How strongly the model judged an item to belong: `core` stands in every module, `related` only in the full list. */
export const EVIDENCE_ZONE_RELEVANCE = frozen(['core', 'related'])

/**
 * A zone–item row's state. `pending` waits for the model; `out` is kept so the same pair is not judged again; `pinned` and
 * `excluded` are overrides (an operator, or a reader's 「不属于这个专区」 the model agreed with) that no automatic pass rewrites.
 */
export const EVIDENCE_ZONE_ITEM_STATES = frozen(['in', 'pending', 'out', 'pinned', 'excluded'])

/** The recall leg that offered an item to a zone (the model decided membership either way). */
export const EVIDENCE_ZONE_ITEM_VIAS = frozen(['tag', 'entity', 'words', 'vector', 'editor', 'reader'])

/** What `zone_changes` records: the planner's actions, an owner's edits, an operator's overrides. */
export const EVIDENCE_ZONE_CHANGE_KINDS = frozen([
  'created', 'definition', 'published', 'unpublished', 'quiet', 'active', 'archived', 'merged', 'split', 'pinned', 'excluded', 'deleted', 'reset',
])

/**
 * The modules a zone's overview is composed of (plan §4.3.2). Each holds one kind of thing.
 * @typedef {'progress' | 'cards' | 'key-updates' | 'approved-drugs' | 'guidelines' | 'key-studies' | 'safety' | 'trials' | 'policy' | 'industry' | 'congress' | 'multi-source' | 'latest'} EvidenceZoneModule
 */
export const EVIDENCE_ZONE_MODULES = /** @type {readonly EvidenceZoneModule[]} */ (frozen([
  'progress', 'cards', 'key-updates', 'approved-drugs', 'guidelines', 'key-studies', 'safety', 'trials', 'policy', 'industry',
  'congress', 'multi-source', 'latest',
]))
export const EVIDENCE_ZONE_MODULE_LABELS_ZH = /** @type {Readonly<Record<EvidenceZoneModule, string>>} */ (Object.freeze({
  progress: '最新进展',
  cards: '证据卡片',
  'key-updates': '重要更新',
  'approved-drugs': '已获批药物',
  guidelines: '指南与共识',
  'key-studies': '关键研究',
  safety: '安全信号',
  trials: '在研试验',
  policy: '医保与政策',
  industry: '产业动态',
  congress: '会议速递',
  'multi-source': '多方报道',
  latest: '最新动态',
}))

/**
 * Each zone type's overview order (plan §4.3.3): state first (what can be used, what is recommended), then what happened, then the
 * evidence, then what is coming, and the full stream last. A drug-class zone leads with the approved drugs; a disease × strategy
 * zone with the guidelines; a technology zone with the validation studies; a policy zone with the policy documents.
 * @type {Readonly<Record<EvidenceZoneType, readonly EvidenceZoneModule[]>>}
 */
export const EVIDENCE_ZONE_MODULE_ORDER = Object.freeze({
  'drug-indication': frozen(/** @type {EvidenceZoneModule[]} */ ([
    'progress', 'cards', 'key-updates', 'approved-drugs', 'guidelines', 'key-studies', 'safety', 'policy', 'trials', 'congress',
    'multi-source', 'latest',
  ])),
  'disease-strategy': frozen(/** @type {EvidenceZoneModule[]} */ ([
    'progress', 'cards', 'key-updates', 'guidelines', 'key-studies', 'approved-drugs', 'safety', 'trials', 'congress', 'multi-source',
    'latest',
  ])),
  'technology-use': frozen(/** @type {EvidenceZoneModule[]} */ ([
    'progress', 'cards', 'key-updates', 'key-studies', 'guidelines', 'safety', 'policy', 'industry', 'multi-source', 'latest',
  ])),
  policy: frozen(/** @type {EvidenceZoneModule[]} */ (['progress', 'cards', 'policy', 'key-updates', 'industry', 'multi-source', 'latest'])),
})

/**
 * Each module's limits: the most rows it shows, the days it looks back, and the fewest it needs to be shown at all (a module with
 * fewer is left out — an overview never shows an empty heading). `progress` needs `minItems` core items in its window to be
 * written; `cards` shows whatever the card port returns; `latest` is always shown.
 * @type {Readonly<Record<EvidenceZoneModule, Readonly<{ limit: number, windowDays: number | null, minItems: number }>>>}
 */
export const EVIDENCE_ZONE_MODULE_RULES = Object.freeze({
  progress: Object.freeze({ limit: 30, windowDays: 14, minItems: 3 }),
  cards: Object.freeze({ limit: 3, windowDays: null, minItems: 1 }),
  'key-updates': Object.freeze({ limit: 6, windowDays: 30, minItems: 1 }),
  'approved-drugs': Object.freeze({ limit: 8, windowDays: 365, minItems: 3 }),
  guidelines: Object.freeze({ limit: 5, windowDays: 180, minItems: 2 }),
  'key-studies': Object.freeze({ limit: 5, windowDays: 30, minItems: 2 }),
  safety: Object.freeze({ limit: 5, windowDays: 90, minItems: 2 }),
  trials: Object.freeze({ limit: 5, windowDays: 90, minItems: 2 }),
  policy: Object.freeze({ limit: 5, windowDays: 90, minItems: 2 }),
  industry: Object.freeze({ limit: 5, windowDays: 30, minItems: 2 }),
  congress: Object.freeze({ limit: 6, windowDays: null, minItems: 2 }),
  'multi-source': Object.freeze({ limit: 5, windowDays: 7, minItems: 1 }),
  latest: Object.freeze({ limit: 10, windowDays: null, minItems: 0 }),
})

/** A congress counts as "on" for a zone from this many days before it opens to this many after it closes (module `congress`). */
export const EVIDENCE_ZONE_CONGRESS_WINDOW = Object.freeze({ beforeDays: 3, afterDays: 14 })

/** The overview order of a zone type; an unknown type reads as a drug-class zone. @param {string | null | undefined} type */
export function evidenceZoneModuleOrder(type) {
  return EVIDENCE_ZONE_MODULE_ORDER[/** @type {EvidenceZoneType} */ (type)] ?? EVIDENCE_ZONE_MODULE_ORDER['drug-indication']
}

/**
 * Guidance for the model, written into its instructions — never a rule code enforces (owner 2026-10-29). Measured on production
 * (2026-10-29, 30 days): 乳腺癌 ~225 items a week (too broad); GLP-1 受体激动剂减重 ~58; ADC 治疗肺癌 ~41; SGLT2 抑制剂心肾保护 ~18;
 * CAR-T 治疗自身免疫病 ~6.
 */
export const EVIDENCE_ZONE_GUIDANCE = Object.freeze({
  keywordsMin: 2,
  keywordsMax: 3,
  perWeekLow: 5,
  perWeekHigh: 60,
  titleChars: 14,
})

/**
 * A hint about a zone's width from its items per week (the same event counted once): `narrow` below the guidance's low end,
 * `broad` above its high end. Shown to a reader as a suggestion beside the preview; it never refuses a zone.
 * @param {number | null | undefined} perWeek
 * @returns {'narrow' | 'normal' | 'broad' | null}
 */
export function evidenceZoneBand(perWeek) {
  if (typeof perWeek !== 'number' || !Number.isFinite(perWeek) || perWeek < 0) return null
  if (perWeek < EVIDENCE_ZONE_GUIDANCE.perWeekLow) return 'narrow'
  if (perWeek > EVIDENCE_ZONE_GUIDANCE.perWeekHigh) return 'broad'
  return 'normal'
}

/**
 * Bounds that protect storage and the model's input — lengths and counts, never language. `userZonesMax` is the default of
 * `OPEN_SCIENCE_EVIDENCE_USER_ZONES_MAX` (owner 2026-10-29: 30 a reader, every one written daily); `platformSeed` is how many
 * platform zones the planner makes when there are none.
 */
export const EVIDENCE_ZONE_LIMITS = Object.freeze({
  titleChars: 30,
  scopeChars: 200,
  criteriaChars: 800,
  keywordsMin: 1,
  keywordsMax: 4,
  termsPerKeyword: 30,
  termChars: 60,
  excludeTerms: 20,
  specialties: 2,
  groupChars: 16,
  seeds: 20,
  draftTextChars: 200,
  userZonesMax: 30,
  platformSeed: 30,
})

/**
 * @typedef {{ label: string, terms: string[], tagIds: number[], entityKeys: string[] }} EvidenceZoneKeyword
 * @typedef {{
 *   version: number,
 *   type: EvidenceZoneType,
 *   keywords: EvidenceZoneKeyword[],
 *   perspective: EvidenceZonePerspective | null,
 *   scope: string,
 *   include: string,
 *   exclude: string,
 *   excludeTerms: string[],
 *   specialties: string[],
 *   group: string,
 *   seeds: { positive: string[], negative: string[] },
 * }} EvidenceZoneDefinition
 */

/** @param {unknown} value @param {number} max */
const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** @param {unknown} value @param {number} maxItems @param {number} maxChars */
function cleanList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const entry of value) {
    const text = cleanText(entry, maxChars)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

/**
 * The shape of a zone definition, cleaned: closed lists checked, lengths cut, duplicates dropped. It never judges words — a
 * definition the model or a reader wrote is kept as written within its bounds. Returns the issues it found so a writer can be told
 * (a definition with no keyword at all, or an unknown type, cannot be stored).
 * @param {unknown} input
 * @returns {{ definition: EvidenceZoneDefinition | null, issues: string[] }}
 */
export function normalizeEvidenceZoneDefinition(input) {
  /** @type {string[]} */
  const issues = []
  const raw = /** @type {Record<string, any>} */ (input && typeof input === 'object' && !Array.isArray(input) ? input : {})
  const type = EVIDENCE_ZONE_TYPES.includes(raw.type) ? /** @type {EvidenceZoneType} */ (raw.type) : null
  if (!type) issues.push('type')
  /** @type {EvidenceZoneKeyword[]} */
  const keywords = []
  for (const entry of Array.isArray(raw.keywords) ? raw.keywords : []) {
    if (!entry || typeof entry !== 'object') continue
    const label = cleanText(entry.label, EVIDENCE_ZONE_LIMITS.termChars)
    if (!label) continue
    const terms = cleanList([label, ...(Array.isArray(entry.terms) ? entry.terms : [])], EVIDENCE_ZONE_LIMITS.termsPerKeyword, EVIDENCE_ZONE_LIMITS.termChars)
    const tagIds = Array.isArray(entry.tagIds)
      ? [...new Set(entry.tagIds.filter((/** @type {unknown} */ id) => Number.isSafeInteger(id) && /** @type {number} */ (id) > 0))].slice(0, 50)
      : []
    const entityKeys = cleanList(entry.entityKeys, 50, 200).filter((key) => /^[a-z]+:.+/.test(key))
    keywords.push({ label, terms, tagIds: /** @type {number[]} */ (tagIds), entityKeys })
    if (keywords.length >= EVIDENCE_ZONE_LIMITS.keywordsMax) break
  }
  if (keywords.length < EVIDENCE_ZONE_LIMITS.keywordsMin) issues.push('keywords')
  const perspective = EVIDENCE_ZONE_PERSPECTIVES.includes(raw.perspective) ? /** @type {EvidenceZonePerspective} */ (raw.perspective) : null
  const scope = cleanText(raw.scope, EVIDENCE_ZONE_LIMITS.scopeChars)
  if (!scope) issues.push('scope')
  const seeds = raw.seeds && typeof raw.seeds === 'object' ? raw.seeds : {}
  const definition = issues.includes('type') || issues.includes('keywords') || issues.includes('scope')
    ? null
    : {
        version: EVIDENCE_ZONE_DEFINITION_VERSION,
        type: /** @type {EvidenceZoneType} */ (type),
        keywords,
        perspective,
        scope,
        include: cleanText(raw.include, EVIDENCE_ZONE_LIMITS.criteriaChars),
        exclude: cleanText(raw.exclude, EVIDENCE_ZONE_LIMITS.criteriaChars),
        excludeTerms: cleanList(raw.excludeTerms, EVIDENCE_ZONE_LIMITS.excludeTerms, EVIDENCE_ZONE_LIMITS.termChars),
        specialties: cleanList(raw.specialties, EVIDENCE_ZONE_LIMITS.specialties, 40),
        group: cleanText(raw.group, EVIDENCE_ZONE_LIMITS.groupChars),
        seeds: {
          positive: cleanList(seeds.positive, EVIDENCE_ZONE_LIMITS.seeds, 40),
          negative: cleanList(seeds.negative, EVIDENCE_ZONE_LIMITS.seeds, 40),
        },
      }
  return { definition, issues }
}

/**
 * Whether an item is a 重要更新 of a zone (module `key-updates`): a practice change the pipeline flagged, a guideline, an
 * approval, a safety notice, or a retraction or correction of something already reported.
 * @param {{ genre?: string | null, practiceChanging?: boolean | null, safetyAlert?: boolean | null, flags?: readonly (string | { key?: string })[] | null }} item
 */
export function evidenceZoneIsKeyUpdate(item) {
  if (item?.practiceChanging === true || item?.safetyAlert === true) return true
  if (['guideline', 'approval', 'safety'].includes(String(item?.genre ?? ''))) return true
  const flags = Array.isArray(item?.flags) ? item.flags.map((flag) => (typeof flag === 'string' ? flag : flag?.key)) : []
  return flags.includes('retracted') || flags.includes('corrected')
}
