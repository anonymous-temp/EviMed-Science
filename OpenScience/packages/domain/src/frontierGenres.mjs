/**
 * What an item of 「前沿动态」 is, as a reader would name it (owner, 2026-10-24: 「不同来源的内容 ai 要怎么写」). The
 * genre decides how the item is written (its 导读 and its typed 要点), how its reader page is laid out and which share
 * of 精选 it counts against. It is about the content, not the channel: a 公众号 article reporting an NMPA approval is
 * an `approval`, the same account's reading of a NEJM trial is a `commentary`.
 *
 * Code decides a genre wherever the registry, identifiers or flags already say it (`frontierGenreFallback`); the
 * editor model refines it only where they cannot — a news page or a 公众号 article — and code keeps its own answer
 * for the genres it is sure of (`FRONTIER_CODE_GENRES`).
 */

/** @typedef {'paper' | 'preprint' | 'guideline' | 'policy' | 'approval' | 'safety' | 'industry' | 'conference' | 'trial' | 'commentary' | 'news' | 'social' | 'roundup'} FrontierGenre */

export const FRONTIER_GENRES = /** @type {readonly FrontierGenre[]} */ (Object.freeze([
  'paper',
  'preprint',
  'guideline',
  'policy',
  'approval',
  'safety',
  'industry',
  'conference',
  'trial',
  'commentary',
  'news',
  'social',
  'roundup',
]))

export const FRONTIER_GENRE_LABELS_ZH = /** @type {Readonly<Record<FrontierGenre, string>>} */ (Object.freeze({
  paper: '研究论文',
  preprint: '预印本',
  guideline: '指南共识',
  policy: '政策法规',
  approval: '审批上市',
  safety: '安全警示',
  industry: '行业动态',
  conference: '会议报道',
  trial: '临床试验',
  commentary: '解读评论',
  news: '医学新闻',
  social: '社交动态',
  roundup: '汇总简讯',
}))

/** Genres code is sure of: the editor model's genre never replaces one of these. */
export const FRONTIER_CODE_GENRES = /** @type {readonly FrontierGenre[]} */ (Object.freeze(['safety', 'social', 'trial', 'preprint', 'roundup']))

/** Where an item's genre came from. */
export const FRONTIER_GENRE_BASES = Object.freeze(['code', 'model'])

const SOCIAL_PLATFORMS = new Set(['x', 'xiaohongshu', 'douyin', 'zhihu', 'weibo', 'bilibili', 'channels'])

/** @param {unknown} value @returns {value is FrontierGenre} */
export function isFrontierGenre(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (FRONTIER_GENRES).includes(value)
}

/**
 * The genre code can tell from an item's stored fields alone (the same columns `evimed_frontier.items` carries:
 * `platform`, `channel`, `source_type`, `evidence_type`, `flags`, `safety_alert`, `lane`). It is the whole answer
 * for an item the model has not seen, and the floor under the model's: an item whose genre is in
 * `FRONTIER_CODE_GENRES` keeps it.
 *
 * @param {{ platform?: string | null, channel?: string | null, source_type?: string | null, sourceType?: string | null,
 *   evidence_type?: string | null, evidenceType?: string | null, flags?: readonly string[] | null,
 *   safety_alert?: boolean | null, safetyAlert?: boolean | null, lane?: string | null } | null | undefined} item
 * @returns {FrontierGenre}
 */
export function frontierGenreFallback(item) {
  const row = item ?? {}
  const flags = Array.isArray(row.flags) ? row.flags : []
  const sourceType = row.source_type ?? row.sourceType ?? null
  const evidence = row.evidence_type ?? row.evidenceType ?? null
  const platform = row.platform ?? null
  const channel = row.channel ?? null
  if (flags.includes('digest')) return 'roundup'
  if (row.safety_alert === true || row.safetyAlert === true || evidence === 'safety-notice') return 'safety'
  if (platform && SOCIAL_PLATFORMS.has(platform)) return 'social'
  if (channel === 'registry') return 'trial'
  if (sourceType === 'preprint' || flags.includes('preprint')) return 'preprint'
  if (evidence === 'guideline' || channel === 'guideline') return 'guideline'
  if (evidence === 'regulatory-decision') return 'approval'
  if (sourceType === 'regulator') return 'policy'
  if (sourceType === 'evidence-body') return evidence === 'systematic-review' ? 'paper' : 'guideline'
  if (sourceType === 'company' || evidence === 'press-release' || row.lane === 'pipeline') return 'industry'
  if (platform === 'wechat') return 'commentary'
  if (sourceType === 'journal') return 'paper'
  return 'news'
}

/**
 * The one reading rule for an item's genre (contract A of the 2026-10-24 round): `items.genre` where written, code's
 * fallback otherwise — never null. Every reader (selection, the reader page, ranking, interactions, leads) calls this.
 *
 * @param {(NonNullable<Parameters<typeof frontierGenreFallback>[0]> & { genre?: string | null }) | null | undefined} row
 * @returns {FrontierGenre}
 */
export function frontierItemGenre(row) {
  return isFrontierGenre(row?.genre) ? row.genre : frontierGenreFallback(row)
}

/**
 * The genre an item is stored with: the model's when it names a known genre and code is not sure of its own, code's
 * otherwise.
 *
 * @param {Parameters<typeof frontierGenreFallback>[0]} item @param {unknown} modelGenre
 * @returns {{ genre: FrontierGenre, basis: 'code' | 'model' }}
 */
export function frontierGenreDecision(item, modelGenre) {
  const fallback = frontierGenreFallback(item)
  if (/** @type {readonly string[]} */ (FRONTIER_CODE_GENRES).includes(fallback)) return { genre: fallback, basis: 'code' }
  if (isFrontierGenre(modelGenre) && !/** @type {readonly string[]} */ (FRONTIER_CODE_GENRES).includes(modelGenre)) {
    return { genre: modelGenre, basis: 'model' }
  }
  return { genre: fallback, basis: 'code' }
}

/** @typedef {'deal' | 'financing' | 'people' | 'operations' | 'pipeline' | 'other'} FrontierIndustryKind */

/**
 * What a piece of 行业动态 is about (owner, 2026-10-26, after LifeSpark, which files business news as kinds of its own): a deal or a
 * licence, a financing or a listing, a change of people or organisation, how a company is run, how a pipeline moved. The editor model
 * names it for an item of genre `industry` and nothing else (language judgement); code checks the answer against this closed list and
 * drops an unknown value instead of guessing one (`frontierIndustryKindDecision`). The order is the filter's.
 */
export const FRONTIER_INDUSTRY_KINDS = /** @type {readonly FrontierIndustryKind[]} */ (Object.freeze([
  'deal',
  'financing',
  'people',
  'operations',
  'pipeline',
  'other',
]))

export const FRONTIER_INDUSTRY_KIND_LABELS_ZH = /** @type {Readonly<Record<FrontierIndustryKind, string>>} */ (Object.freeze({
  deal: '交易与授权',
  financing: '融资与上市',
  people: '人事与组织',
  operations: '公司经营',
  pipeline: '研发管线',
  other: '其他',
}))

/** @param {unknown} value @returns {value is FrontierIndustryKind} */
export function isFrontierIndustryKind(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (FRONTIER_INDUSTRY_KINDS).includes(value)
}

/**
 * The kind an item is stored with: the model's when it names a known kind and the item's genre is `industry`, otherwise none. A kind
 * belongs to the genre — an item that is not 行业动态 has none, and an unknown word is dropped, never mapped to the nearest kind.
 *
 * @param {unknown} genre @param {unknown} modelKind
 * @returns {FrontierIndustryKind | null}
 */
export function frontierIndustryKindDecision(genre, modelKind) {
  return genre === 'industry' && isFrontierIndustryKind(modelKind) ? modelKind : null
}

/**
 * The one reading rule for an item's kind: `items.industry_kind` where written and the item is 行业动态, else none. Every reader
 * (the list, the card, the reader page) calls this, so a kind written before the genre changed never shows on a paper.
 *
 * @param {{ genre?: string | null, industry_kind?: string | null, industryKind?: string | null } | null | undefined} row
 * @returns {FrontierIndustryKind | null}
 */
export function frontierItemIndustryKind(row) {
  return frontierIndustryKindDecision(row?.genre ?? null, row?.industry_kind ?? row?.industryKind ?? null)
}
