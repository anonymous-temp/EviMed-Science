/**
 * The frontier feed's closed vocabularies (「前沿动态」, plan §6.2, §10.3.8).
 *
 * Hidden knowledge:
 *
 * - **The values are the knowledge-source plugin's contract.** Lane, source
 *   type, egress, access, launch tier, source health, date precision and entry
 *   defect are enums of `contract/knowledge-plugin-openapi.yaml` (v1). The
 *   platform owns the words and writes them into the contract; the plugin may
 *   only use a new value after it has been added there (a minor contract
 *   version), and `test/frontierVocabulary.test.mjs` reads the YAML and fails
 *   when the two lists differ. A second hand-kept copy on either side would be a
 *   second truth that drifts — the drift would surface as a lane nobody can
 *   filter by.
 * - **Unknown values fall back, never refuse** (contract rule 1): a lane this
 *   build does not know is `mixed` (the screening model decides the item's
 *   lane), a source type is `media`, a health state is `degraded`. The ingest
 *   counts every fallback; a plugin one release ahead must never stop the feed.
 * - **`mixed` is not a reader's lane.** It is what a general-news source carries
 *   in the registry; every item it produces gets one of the eight lanes from the
 *   screening model. It has a label only so an operator page can say 「待定」.
 * - **Evidence type is decided by the most reliable party that can decide it.**
 *   PubMed publication types (NLM's closed vocabulary) are mapped by table
 *   (principle 5); only a type that names a study design replaces the model's
 *   pick. At publication time only about 9% of new journal articles carry one
 *   (MEDLINE indexing lags weeks, dry run 2026-09-21), so the model reads the
 *   abstract first and the table corrects it when the types arrive (plan
 *   §10.3.8, review finding #12).
 * - **Authority is arithmetic, not judgement.** Thirty points of a hundred are
 *   the registry's authority grade times a coefficient of the evidence type;
 *   the model scores only impact, novelty and relevance (plan §6.3).
 * - **A masthead is matched by exact title, never by resemblance.** Editorial
 *   boards, tables of contents and issue information pages are fixed names; a
 *   fuzzy match would drop the one real article whose title happens to contain
 *   「Cover」 (plan §10.3.2).
 *
 * @module @evimed/domain/frontierVocabulary
 */

/** @typedef {'evidence'|'guideline'|'regulatory'|'safety'|'pipeline'|'public-health'|'research'|'ai'} FrontierLane */
/** @typedef {FrontierLane|'mixed'} FrontierSourceLane */
/** @typedef {'journal'|'regulator'|'evidence-body'|'preprint'|'company'|'media'} FrontierSourceType */
/** @typedef {'rct'|'systematic-review'|'observational'|'real-world'|'guideline'|'regulatory-decision'|'safety-notice'|'press-release'|'review-opinion'|'other'} FrontierEvidenceType */
/** @typedef {'preprint'|'press-release'|'no-abstract'|'date-inferred'|'retracted'|'corrected'|'expression-of-concern'|'published-version'|'china'|'registry-unpublished'|'data-updated'} FrontierItemFlag */
/** @typedef {'new'|'healthy'|'degraded'|'unreadable'|'drifted'|'disabled'} FrontierHealthState */

/** The eight lanes a reader filters by, in display order. */
export const FRONTIER_LANES = /** @type {readonly FrontierLane[]} */ (Object.freeze([
  'evidence',
  'guideline',
  'regulatory',
  'safety',
  'pipeline',
  'public-health',
  'research',
  'ai',
]))

/** The contract's `Lane` enum: the eight plus `mixed`, which a source may
 *  carry and an item never does. */
export const FRONTIER_SOURCE_LANES = /** @type {readonly FrontierSourceLane[]} */ (Object.freeze([...FRONTIER_LANES, 'mixed']))

/** Chinese lane names. `mixed` reads 「待定」 on operator pages only. */
export const FRONTIER_LANE_LABELS_ZH = /** @type {Readonly<Record<FrontierSourceLane, string>>} */ (Object.freeze({
  evidence: '临床证据',
  guideline: '指南共识',
  regulatory: '审批监管',
  safety: '药物安全',
  pipeline: '研发产业',
  'public-health': '公共卫生',
  research: '科研与基金',
  ai: 'AI 与医学',
  mixed: '待定',
}))

/** Who published an entry. Decided by the registry, never by a model. */
export const FRONTIER_SOURCE_TYPES = /** @type {readonly FrontierSourceType[]} */ (Object.freeze([
  'journal',
  'regulator',
  'evidence-body',
  'preprint',
  'company',
  'media',
]))

export const FRONTIER_SOURCE_TYPE_LABELS_ZH = /** @type {Readonly<Record<FrontierSourceType, string>>} */ (Object.freeze({
  journal: '期刊',
  regulator: '监管',
  'evidence-body': '循证机构与学会',
  preprint: '预印本',
  company: '企业',
  media: '媒体',
}))

/** How hard the evidence behind an item is, strongest forms first. */
export const FRONTIER_EVIDENCE_TYPES = /** @type {readonly FrontierEvidenceType[]} */ (Object.freeze([
  'rct',
  'systematic-review',
  'observational',
  'real-world',
  'guideline',
  'regulatory-decision',
  'safety-notice',
  'press-release',
  'review-opinion',
  'other',
]))

export const FRONTIER_EVIDENCE_TYPE_LABELS_ZH = /** @type {Readonly<Record<FrontierEvidenceType, string>>} */ (Object.freeze({
  rct: 'RCT',
  'systematic-review': '系统评价与Meta分析',
  observational: '队列与病例对照',
  'real-world': '真实世界研究',
  guideline: '指南与共识',
  'regulatory-decision': '监管决定',
  'safety-notice': '安全通告',
  'press-release': '企业新闻稿',
  'review-opinion': '综述与观点',
  other: '其他',
}))

/** The specialties an item may carry (at most three). */
export const FRONTIER_SPECIALTIES = Object.freeze([
  'cardiology',
  'oncology',
  'endocrinology',
  'neurology',
  'psychiatry',
  'infectious-disease',
  'respiratory',
  'critical-care',
  'gastroenterology',
  'nephrology',
  'rheumatology',
  'hematology',
  'pediatrics',
  'obstetrics-gynecology',
  'geriatrics',
  'surgery-anesthesia',
  'radiology',
  'pharmacy',
  'tcm',
  'public-health',
  'general-practice',
])

export const FRONTIER_SPECIALTY_LABELS_ZH = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  cardiology: '心血管',
  oncology: '肿瘤',
  endocrinology: '内分泌代谢',
  neurology: '神经',
  psychiatry: '精神',
  'infectious-disease': '感染',
  respiratory: '呼吸',
  'critical-care': '重症',
  gastroenterology: '消化与肝病',
  nephrology: '肾脏',
  rheumatology: '风湿免疫',
  hematology: '血液',
  pediatrics: '儿科',
  'obstetrics-gynecology': '妇产',
  geriatrics: '老年',
  'surgery-anesthesia': '外科与麻醉',
  radiology: '影像',
  pharmacy: '药学',
  tcm: '中医药',
  'public-health': '公共卫生',
  'general-practice': '全科',
}))

/** The most specialties one item carries. */
export const FRONTIER_MAX_SPECIALTIES = 3

/** Where a request leaves from (the plugin's implementation detail, shown on
 *  the public sources page). */
export const FRONTIER_EGRESSES = Object.freeze(['direct', 'browser', 'relay', 'bridge', 'api'])

export const FRONTIER_EGRESS_LABELS_ZH = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  direct: '直连',
  browser: '无头浏览器',
  relay: '海外中继',
  bridge: '公众号桥接',
  api: '开放接口',
}))

/** The read methods, one plugin adapter each (「读法」 on the sources page). */
export const FRONTIER_ACCESSES = Object.freeze([
  'crossref-issn',
  'eutils-query',
  'europepmc',
  'json-api',
  'rss',
  'atom',
  'html-list',
  'browser-list',
  'relay',
  'wechat-bridge',
  'evimed-api',
])

export const FRONTIER_ACCESS_LABELS_ZH = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  'crossref-issn': 'Crossref 期刊接口',
  'eutils-query': 'PubMed 查询流',
  europepmc: 'Europe PMC',
  'json-api': '开放接口',
  rss: 'RSS 订阅源',
  atom: 'Atom 订阅源',
  'html-list': '网页列表',
  'browser-list': '浏览器渲染列表',
  relay: '海外中继',
  'wechat-bridge': '公众号桥接',
  'evimed-api': 'EviMed 接口',
}))

/** The registry's launch tiers. */
export const FRONTIER_LAUNCH_TIERS = Object.freeze(['P0', 'P1', 'P2'])

/** A source's health as the plugin reports it. */
export const FRONTIER_HEALTH_STATES = /** @type {readonly FrontierHealthState[]} */ (Object.freeze([
  'new',
  'healthy',
  'degraded',
  'unreadable',
  'drifted',
  'disabled',
]))

export const FRONTIER_HEALTH_LABELS_ZH = /** @type {Readonly<Record<FrontierHealthState, string>>} */ (Object.freeze({
  new: '新接入',
  healthy: '正常',
  degraded: '退化',
  unreadable: '暂时读不到',
  drifted: '漂移',
  disabled: '已停用',
}))

/** How exact an entry's publication time is. `inferred` is the first-seen time
 *  standing in for a date the source did not give (or gave in the future). */
export const FRONTIER_DATE_PRECISIONS = Object.freeze(['instant', 'day', 'inferred'])

/** What the plugin found wrong with an entry (plan §10.3.2), per entry. */
export const FRONTIER_ENTRY_DEFECTS = Object.freeze([
  'no-date',
  'future-date',
  'truncated-summary',
  'short-summary',
  'no-summary',
  'encoding',
  'link-derived',
  'oversize-truncated',
])

/** The only keys `Entry.facts` may carry (contract rule 4: anything else never
 *  exists past the adapter, and the platform re-checks on receipt). */
export const FRONTIER_FACT_KEYS = Object.freeze([
  'crossref_type',
  'update_to',
  'author_count',
  'journal',
  'issn',
  'trial_phase',
  'trial_status',
  'trial_event',
  'sponsor',
  'recall_class',
  'fda_application',
  'fda_supplement',
  'wx_biz',
  'wx_author',
  'wx_original',
  'is_correction_notice',
  'is_masthead',
])

/** The keys `EntryText.enrichment` may carry (`affiliation_countries` since
 *  contract 1.1.0: ISO 3166-1 alpha-2 codes of the authors' affiliations,
 *  the deterministic basis of the 「涉华」 flag). */
export const FRONTIER_ENRICHMENT_KEYS = Object.freeze([
  'publication_types',
  'mesh',
  'journal',
  'authors_short',
  'open_access',
  'oa_pdf_url',
  'impact_factor',
  'core_journal_tags',
  'preprint_of_doi',
  'published_version_doi',
  'trial_facts',
  'drug_label_excerpt',
  'affiliation_countries',
])

/** `EntryText.status`: whether the plugin has the text now. */
export const FRONTIER_TEXT_STATUSES = Object.freeze(['available', 'pending', 'unavailable'])

/** `EntryText.enrichment.open_access`, as Unpaywall classifies it. */
export const FRONTIER_OPEN_ACCESS_STATUSES = Object.freeze(['gold', 'green', 'bronze', 'closed', 'unknown'])

/** The marks an item card carries. Every one is decided by code (registry,
 *  defects, identifiers, links); only `press-release` may also come from the
 *  editor model, for a company release republished by a media source. */
export const FRONTIER_ITEM_FLAGS = /** @type {readonly FrontierItemFlag[]} */ (Object.freeze([
  'preprint',
  'press-release',
  'no-abstract',
  'date-inferred',
  'retracted',
  'corrected',
  'expression-of-concern',
  'published-version',
  'china',
  'registry-unpublished',
  'data-updated',
]))

export const FRONTIER_ITEM_FLAG_LABELS_ZH = /** @type {Readonly<Record<FrontierItemFlag, string>>} */ (Object.freeze({
  preprint: '未经同行评议',
  'press-release': '企业新闻稿·数据未发表',
  'no-abstract': '无摘要',
  'date-inferred': '日期为推断',
  retracted: '已撤稿',
  corrected: '已更正',
  'expression-of-concern': '关注声明',
  'published-version': '已正式发表',
  china: '涉华',
  'registry-unpublished': '注册，未发表结果',
  'data-updated': '数据已更新',
}))

/** The flags the editor model may propose; every other flag is code's. */
export const FRONTIER_MODEL_FLAGS = /** @type {readonly FrontierItemFlag[]} */ (Object.freeze(['press-release']))

/** Why an item is selected (`items.selected_rule`). */
export const FRONTIER_SELECTED_RULES = Object.freeze(['threshold', 'lane-floor', 'safety-bypass', 'operator-pin'])

/** What the number and format check concluded (`items.verification`):
 *  `pending` — not edited yet (published title-only, edit deferred);
 *  `passed` — the first answer passed; `repaired` — the one rewrite passed;
 *  `title-only` — it did not, and the summary and reason were dropped. */
export const FRONTIER_VERIFICATIONS = Object.freeze(['pending', 'passed', 'repaired', 'title-only'])

/** Who decided the evidence type: PubMed publication types, a registry-level
 *  rule of the source, or the editor model. */
export const FRONTIER_EVIDENCE_BASES = Object.freeze(['pubmed-types', 'registry', 'model'])

/** `evimed_frontier.entries.state` (plan §10.3.1). */
export const FRONTIER_ENTRY_STATES = Object.freeze(['received', 'held', 'merged', 'screened-out', 'promoted', 'dropped', 'backfill', 'failed'])

/** `evimed_frontier.items.state` (plan §10.3.1). */
export const FRONTIER_ITEM_STATES = Object.freeze(['screened', 'scored', 'published', 'withdrawn', 'failed'])

/** What a plugin value this build does not know becomes (contract rule 1).
 *  Vocabularies without an entry have no fallback: an unknown value there is
 *  dropped (a defect, a flag) or refused by the caller. */
export const FRONTIER_VOCABULARY_FALLBACKS = Object.freeze({
  lane: /** @type {FrontierSourceLane} */ ('mixed'),
  sourceType: /** @type {FrontierSourceType} */ ('media'),
  health: /** @type {FrontierHealthState} */ ('degraded'),
})

/** Every vocabulary by name: its values and, where it has them, its labels. */
const VOCABULARIES = Object.freeze({
  lane: { values: FRONTIER_SOURCE_LANES, labels: FRONTIER_LANE_LABELS_ZH },
  sourceType: { values: FRONTIER_SOURCE_TYPES, labels: FRONTIER_SOURCE_TYPE_LABELS_ZH },
  evidenceType: { values: FRONTIER_EVIDENCE_TYPES, labels: FRONTIER_EVIDENCE_TYPE_LABELS_ZH },
  specialty: { values: FRONTIER_SPECIALTIES, labels: FRONTIER_SPECIALTY_LABELS_ZH },
  flag: { values: FRONTIER_ITEM_FLAGS, labels: FRONTIER_ITEM_FLAG_LABELS_ZH },
  health: { values: FRONTIER_HEALTH_STATES, labels: FRONTIER_HEALTH_LABELS_ZH },
  egress: { values: FRONTIER_EGRESSES, labels: FRONTIER_EGRESS_LABELS_ZH },
  access: { values: FRONTIER_ACCESSES, labels: FRONTIER_ACCESS_LABELS_ZH },
  launchTier: { values: FRONTIER_LAUNCH_TIERS, labels: null },
  datePrecision: { values: FRONTIER_DATE_PRECISIONS, labels: null },
  defect: { values: FRONTIER_ENTRY_DEFECTS, labels: null },
})

/** @typedef {keyof typeof VOCABULARIES} FrontierVocabularyName */

/** The names `frontierLabel`, `isFrontierValue` and `frontierValue` accept. */
export const FRONTIER_VOCABULARY_NAMES = /** @type {readonly FrontierVocabularyName[]} */ (Object.freeze(Object.keys(VOCABULARIES)))

/** @param {string} name */
function vocabularyOf(name) {
  const vocabulary = /** @type {Record<string, { values: readonly string[], labels: Readonly<Record<string, string>> | null }>} */ (VOCABULARIES)[name]
  if (!vocabulary) throw new TypeError(`Unknown frontier vocabulary ${JSON.stringify(name)}.`)
  return vocabulary
}

/**
 * Whether a value belongs to a vocabulary.
 * @param {FrontierVocabularyName} name @param {unknown} value @returns {boolean}
 */
export function isFrontierValue(name, value) {
  return typeof value === 'string' && vocabularyOf(name).values.includes(value)
}

/**
 * A plugin value as this build stores it: the value when known, else the
 * vocabulary's fallback (contract rule 1) — `known: false` either way, so the
 * caller can count it. `value` is null when the value is unknown and the
 * vocabulary has no fallback.
 * @param {FrontierVocabularyName} name @param {unknown} value
 * @returns {{ value: string | null, known: boolean }}
 */
export function frontierValue(name, value) {
  if (isFrontierValue(name, value)) return { value: /** @type {string} */ (value), known: true }
  const fallback = /** @type {Record<string, string>} */ (FRONTIER_VOCABULARY_FALLBACKS)[name]
  return { value: fallback ?? null, known: false }
}

/**
 * The Chinese label of a vocabulary value, or null for a value the vocabulary
 * does not know or a vocabulary without labels. Never the raw key: a UI that
 * printed `public-health` would be printing an identifier.
 * @param {FrontierVocabularyName} name @param {unknown} key @returns {string | null}
 */
export function frontierLabel(name, key) {
  const vocabulary = vocabularyOf(name)
  if (!vocabulary.labels || typeof key !== 'string' || !vocabulary.values.includes(key)) return null
  return vocabulary.labels[key] ?? null
}

// ───────────────────────── evidence type from PubMed publication types ─────────────────────────

/**
 * PubMed publication types that name a study design, most decisive first: a
 * record typed both "Practice Guideline" and "Systematic Review" is a
 * guideline, one typed "Meta-Analysis" and "Review" a systematic review. Only
 * these replace the editor model's pick. Designs NLM leaves open ("Clinical
 * Trial, Phase III" without randomisation, "Multicenter Study", "Comparative
 * Study") are not here: the model reads the abstract for those.
 * Keys are lower-case, as compared.
 * @type {ReadonlyArray<readonly [string, FrontierEvidenceType]>}
 */
export const PUBMED_RESEARCH_TYPE_EVIDENCE = Object.freeze(/** @type {Array<readonly [string, FrontierEvidenceType]>} */ ([
  ['practice guideline', 'guideline'],
  ['guideline', 'guideline'],
  ['consensus development conference, nih', 'guideline'],
  ['consensus development conference', 'guideline'],
  ['network meta-analysis', 'systematic-review'],
  ['meta-analysis', 'systematic-review'],
  ['systematic review', 'systematic-review'],
  ['randomized controlled trial', 'rct'],
  ['randomized controlled trial, veterinary', 'rct'],
  ['equivalence trial', 'rct'],
  ['pragmatic clinical trial', 'rct'],
  ['observational study', 'observational'],
  ['observational study, veterinary', 'observational'],
  ['twin study', 'observational'],
  ['case reports', 'other'],
  ['scoping review', 'review-opinion'],
  ['review', 'review-opinion'],
].map((pair) => Object.freeze(pair))))

/**
 * PubMed types that are not research (plan §10.3.2: letters, comments,
 * editorials, news, biographies — 17.5% of indexed articles in the dry run).
 * An article carrying only these (besides the generic types below) is not a
 * research item: `demote` keeps it out of the selected feed (it stays in
 * 「全部」); news is the exception — a journal's news piece is news and competes
 * like any other.
 * @type {Readonly<Record<string, { evidenceType: FrontierEvidenceType, demote: boolean }>>}
 */
export const PUBMED_NON_RESEARCH_TYPES = Object.freeze({
  letter: Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('review-opinion'), demote: true }),
  comment: Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('review-opinion'), demote: true }),
  editorial: Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('review-opinion'), demote: true }),
  news: Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: false }),
  'newspaper article': Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: false }),
  interview: Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: true }),
  biography: Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: true }),
  autobiography: Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: true }),
  portrait: Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: true }),
  'personal narrative': Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: true }),
  'published erratum': Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: true }),
  'retraction of publication': Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: true }),
  'expression of concern': Object.freeze({ evidenceType: /** @type {FrontierEvidenceType} */ ('other'), demote: true }),
})

/** The evidence types that are a research design (what a research letter is). */
const RESEARCH_DESIGN_TYPES = Object.freeze(['rct', 'systematic-review', 'observational', 'real-world'])

/** Types every indexed article carries, which say nothing about its design. */
const GENERIC_PUBLICATION_TYPES = Object.freeze(['journal article', 'english abstract', 'preprint'])

/** @param {string} type */
function isGenericPublicationType(type) {
  return GENERIC_PUBLICATION_TYPES.includes(type) || type.startsWith('research support')
}

/**
 * What PubMed's publication types say about an article's evidence type.
 *
 * `evidenceType` is non-null only when a type decides it — a research design
 * from `PUBMED_RESEARCH_TYPE_EVIDENCE`, or, when every specific type is a
 * non-research one, that type's entry; then it replaces the model's pick.
 * `demote` is true when the article is only a letter, comment, editorial, …:
 * it is shown in 「全部」 and never selected.
 *
 * A bare `Letter` is the one type PubMed gives both correspondence and a
 * journal's research letters (a JAMA secondary analysis of an RCT, a kidney
 * journal's genetics letters — 2026-09-22): the design is in the text, not in
 * the type. So it decides only once the model has read the article
 * (`modelType`) and found no research design there; before that, or when the
 * model found one, it decides nothing.
 * @param {unknown} publicationTypes
 * @param {{ modelType?: string | null }} [reading]
 * @returns {{ evidenceType: FrontierEvidenceType | null, matched: string | null, demote: boolean }}
 */
export function frontierEvidenceFromPublicationTypes(publicationTypes, { modelType = null } = {}) {
  const types = [...new Set((Array.isArray(publicationTypes) ? publicationTypes : [])
    .filter((type) => typeof type === 'string')
    .map((type) => type.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean))]
  for (const [name, evidenceType] of PUBMED_RESEARCH_TYPE_EVIDENCE) {
    if (types.includes(name)) return { evidenceType, matched: name, demote: false }
  }
  const specific = types.filter((type) => !isGenericPublicationType(type))
  if (specific.length === 1 && specific[0] === 'letter' && (!modelType || RESEARCH_DESIGN_TYPES.includes(modelType))) {
    return { evidenceType: null, matched: null, demote: false }
  }
  if (specific.length && specific.every((type) => Object.hasOwn(PUBMED_NON_RESEARCH_TYPES, type))) {
    const decisive = specific.find((type) => !PUBMED_NON_RESEARCH_TYPES[type].demote) ?? specific[0]
    return {
      evidenceType: PUBMED_NON_RESEARCH_TYPES[decisive].evidenceType,
      matched: decisive,
      demote: specific.every((type) => PUBMED_NON_RESEARCH_TYPES[type].demote),
    }
  }
  return { evidenceType: null, matched: null, demote: false }
}

// ───────────────────────── authority score ─────────────────────────

/** How much of a source's authority an evidence type carries (plan §6.3). */
export const FRONTIER_EVIDENCE_AUTHORITY_COEFFICIENTS = /** @type {Readonly<Record<FrontierEvidenceType, number>>} */ (Object.freeze({
  guideline: 1,
  'regulatory-decision': 1,
  'safety-notice': 1,
  rct: 1,
  'systematic-review': 1,
  observational: 0.8,
  'real-world': 0.75,
  other: 0.6,
  'review-opinion': 0.5,
  'press-release': 0.5,
}))

/** A preprint's discount: not yet peer reviewed. */
export const FRONTIER_PREPRINT_AUTHORITY_FACTOR = 0.6

/** The authority dimension's maximum (of the 100-point total). */
export const FRONTIER_AUTHORITY_MAX = 30

/**
 * The authority and evidence-strength score, 0–30: the registry's authority
 * grade (1–5) times the evidence type's coefficient, times 0.6 for a
 * preprint. An unknown evidence type counts as `other`.
 * @param {{ authority: unknown, evidenceType?: unknown, preprint?: boolean }} input
 * @returns {number}
 */
export function frontierAuthorityScore({ authority, evidenceType = null, preprint = false }) {
  const grade = Math.max(1, Math.min(5, Math.round(Number(authority) || 1)))
  const coefficient = /** @type {Record<string, number>} */ (FRONTIER_EVIDENCE_AUTHORITY_COEFFICIENTS)[String(evidenceType)]
    ?? FRONTIER_EVIDENCE_AUTHORITY_COEFFICIENTS.other
  const score = FRONTIER_AUTHORITY_MAX * (grade / 5) * coefficient * (preprint ? FRONTIER_PREPRINT_AUTHORITY_FACTOR : 1)
  return Math.max(0, Math.min(FRONTIER_AUTHORITY_MAX, Math.round(score)))
}

/** Each score dimension's maximum; the four sum to 100. */
export const FRONTIER_SCORE_MAXIMA = Object.freeze({ authority: 30, impact: 30, novelty: 20, relevance: 20 })

/** A score as the card's 「为什么入选」 shows it — never the number. */
export const FRONTIER_LEVEL_LABELS_ZH = Object.freeze({ high: '高', medium: '中', low: '低' })

/**
 * The level a dimension's score reads as: high from two thirds of its
 * maximum, medium from one third, else low; null when there is no score.
 * @param {'authority'|'impact'|'novelty'|'relevance'} dimension @param {unknown} score
 * @returns {'high'|'medium'|'low'|null}
 */
export function frontierScoreLevel(dimension, score) {
  const maximum = FRONTIER_SCORE_MAXIMA[dimension]
  if (!maximum || score == null || score === '' || !Number.isFinite(Number(score))) return null
  const share = Number(score) / maximum
  return share >= 2 / 3 ? 'high' : share >= 1 / 3 ? 'medium' : 'low'
}

// ───────────────────────── mastheads ─────────────────────────

/**
 * The fixed pages of a journal issue, matched against a whole title after
 * `mastheadTitleKey` (plan §10.3.2: 3.4% of the dry run's entries). Exact, on
 * purpose: 「Cover」 is a masthead, 「Covering the uninsured」 is an article.
 */
export const FRONTIER_MASTHEAD_TITLES = Object.freeze([
  'editorial board',
  'editorial board and contents',
  'editorial board and table of contents',
  'table of contents',
  'contents',
  'issue information',
  'issue highlights',
  'in this issue',
  'this issue',
  'cover',
  'cover image',
  'cover picture',
  'front cover',
  'back cover',
  'inside front cover',
  'inside back cover',
  'issue cover',
  'masthead',
  'masthead and table of contents',
  'front matter',
  'back matter',
  'title page',
  'copyright page',
  'full issue',
  'full issue pdf',
  'information for authors',
  'instructions for authors',
  'author index',
  'subject index',
  'index',
  'reviewer acknowledgement',
  'reviewer acknowledgment',
  'acknowledgement of reviewers',
  'acknowledgment of reviewers',
  'acknowledgement to reviewers',
  'thank you to our reviewers',
  'advertisement',
  '目录',
  '本期目录',
  '封面',
  '封二',
  '封三',
  '封底',
  '编委会',
  '编辑委员会',
  '本期导读',
  '版权页',
])

/**
 * A title in the form the masthead list is written in: lower case, `&` as
 * "and", runs of whitespace as one space, no surrounding punctuation.
 * @param {unknown} title @returns {string}
 */
export function mastheadTitleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'“”‘’«»:：.。,，;；\-–—|()[\]（）【】]+|[\s"'“”‘’«»:：.。,，;；\-–—|()[\]（）【】]+$/g, '')
    .trim()
}

/** @param {unknown} title @returns {boolean} */
export function isFrontierMastheadTitle(title) {
  const key = mastheadTitleKey(title)
  return key.length > 0 && FRONTIER_MASTHEAD_TITLES.includes(key)
}
