/**
 * What the frontier feed goes looking for, and when (ct-mix 2026-10-24: lead triggers). The feed reads registered sources
 * and grows them by discovery (the knowledge plugin's candidate lines); nothing made it look for a story it had heard of
 * and did not have. The control plane now does (`apps/server/src/frontierLeads.mjs`): a few times a day it decides what to
 * search for, asks the platform's web-search gateway under the module's purpose and budget, and hands the pages it found
 * to the plugin, which reads them under its own rules and names their sites as discovery candidates (line `lead`).
 *
 * This module is the data and the pure decisions of it: the triggers and each one's share of a day's queries, the
 * congress calendar (`frontier-congresses.json`), the Chinese regulatory and industry watch, the queries a genre group
 * short of its floor searches, the identifiers a report names (a primary source to fetch by its address rather than by a
 * search), and the key two queries are the same by. Monitoring products do the same (research for this round): saved
 * queries with a since-cursor (Google and Talkwalker Alerts), event follow-up from a cluster's entities (Event Registry),
 * coverage gaps against a target (Ground News' blindspot), calendars from organisers' disclosures, and identifiers before
 * free text for a missing primary source.
 */

import congressTable from './frontier-congresses.json' with { type: 'json' }

/**
 * Why a lead was made. The standing watches run once a day: `hot-tag` (this week's most-read tags), `specialty` (each
 * specialty's most frequent entity this week), `congress` (a congress in its window), `regulatory-watch` (the Chinese
 * regulatory and industry watch). The follow-ups run through the day: `genre-gap` (yesterday a genre group was under its
 * floor), `event-hot` (an event entered the hot list), `zh-report` (a selected item has no Chinese report in its event),
 * `primary-source` (a selected news or industry item has no primary source in its event).
 */
export const FRONTIER_LEAD_TRIGGERS = Object.freeze(['hot-tag', 'specialty', 'congress', 'regulatory-watch', 'genre-gap', 'event-hot', 'zh-report', 'primary-source'])

/**
 * Each trigger's share of a day's queries (the cap is `OPEN_SCIENCE_FRONTIER_LEADS_DAILY_QUERIES`): standing watches a
 * fixed half, follow-ups the other half, so a busy news day cannot spend the watches' places and a quiet one leaves them
 * unspent rather than searching for filler. An identifier lead (a DOI, a PMID, a trial number) is an address, not a
 * search, and counts against nothing here.
 */
export const FRONTIER_LEAD_SHARES = Object.freeze({
  'regulatory-watch': 0.10, congress: 0.10, 'hot-tag': 0.12, specialty: 0.18,
  'genre-gap': 0.08, 'event-hot': 0.12, 'zh-report': 0.20, 'primary-source': 0.10,
})

/** Results a query hands the plugin at most. */
export const FRONTIER_LEAD_RESULTS_PER_QUERY = 5

/**
 * Hosts a search result is never handed over from: the social networks, whose pages need a sign-in the plugin does not
 * have and whose posts the feed reads, where it reads them at all, through its own social adapters. A closed list (the
 * trial searches of 2026-10-24 returned LinkedIn posts for a company's press release).
 */
export const FRONTIER_LEAD_SKIP_HOSTS = Object.freeze(['linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'tiktok.com', 'weibo.com', 'zhihu.com', 'douyin.com', 'bilibili.com', 'xiaohongshu.com'])

/** Whether a result's host is one never handed over (`FRONTIER_LEAD_SKIP_HOSTS`, or below one). @param {string} host */
export function frontierLeadSkipHost(host) {
  const parts = String(host ?? '').toLowerCase().replace(/\.$/, '').split('.')
  return parts.some((_, index) => FRONTIER_LEAD_SKIP_HOSTS.includes(parts.slice(index).join('.')))
}

/**
 * The Chinese regulatory and industry watch (owner, 2026-10-24: NMPA 批准上市, 药审中心 突破性治疗, 医保 谈判, 集采 中选): one
 * query each, searched once a day for the last day's pages. Data, so an editor extends it without touching code.
 */
export const FRONTIER_LEAD_REGULATORY_WATCH = Object.freeze([
  Object.freeze({ query: '国家药监局 批准 上市', why: '国家药监局批准的新药与新适应症' }),
  Object.freeze({ query: '国家药监局 附条件批准', why: '附条件批准上市的药品' }),
  Object.freeze({ query: '药审中心 突破性治疗药物', why: 'CDE 纳入突破性治疗的品种' }),
  Object.freeze({ query: '药审中心 优先审评', why: 'CDE 纳入优先审评的品种' }),
  Object.freeze({ query: '临床试验 默示许可 首次', why: '国内首次获批开展的临床试验' }),
  Object.freeze({ query: '国家医保局 医保目录 谈判', why: '国家医保药品目录的谈判与调整' }),
  Object.freeze({ query: '国家组织药品集中采购 中选', why: '集采的品种与中选结果' }),
  Object.freeze({ query: '国家药监局 创新医疗器械 批准', why: '获批的创新医疗器械' }),
  Object.freeze({ query: '国家卫健委 印发 诊疗', why: '卫健委的诊疗规范、指南与通知' }),
  Object.freeze({ query: '国家疾控局 通报', why: '传染病疫情与公共卫生通报' }),
  Object.freeze({ query: '创新药 授权 交易 首付款', why: '国内药企的授权交易（行业）' }),
  Object.freeze({ query: '医药 融资 完成 亿元', why: '医药企业的融资（行业）' }),
])

/**
 * What a genre group short of its floor yesterday searches today (`genre-gap`), Chinese first: the groups whose
 * candidates the feed's sources bring least. Research is not here: it is never short.
 */
export const FRONTIER_LEAD_GENRE_QUERIES = Object.freeze({
  guideline: Object.freeze(['指南 发布 2026', '专家共识 发布', '临床实践指南 更新']),
  regulatory: Object.freeze(['国家药监局 批准', 'FDA 批准 新药', 'EMA 推荐 批准']),
  policy: Object.freeze(['国家卫健委 最新政策', '国家医保局 通知', '药品监管 新规']),
  industry: Object.freeze(['创新药 合作 最新', '药企 研发管线 进展', '医疗器械 公司 动态']),
  commentary: Object.freeze(['最新研究 解读 临床意义', 'NEJM 研究 解读', '柳叶刀 研究 解读']),
})

/**
 * @typedef {{ id: string, name_en: string, name_zh: string, start: string, end: string, abstracts_at: string | null,
 *   city: string | null, keywords_en: string[], keywords_zh: string[], specialty: string | null, source_url: string }} FrontierCongress
 */

/** The congress calendar (`frontier-congresses.json`). @type {readonly FrontierCongress[]} */
export const FRONTIER_CONGRESSES = Object.freeze(/** @type {FrontierCongress[]} */ (congressTable.congresses).map((row) => Object.freeze({ ...row })))

/** Days before a congress starts, and after it ends, it is searched for; and after its abstracts go online. */
export const FRONTIER_CONGRESS_WINDOW_DAYS = 3

/** @param {string} day @param {number} days */
function shiftDay(day, days) {
  const at = new Date(`${day}T00:00:00Z`)
  return new Date(at.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The congresses on a day (`YYYY-MM-DD`, the feed's day): from `FRONTIER_CONGRESS_WINDOW_DAYS` before its start to as many
 * after its end, and from the day its abstracts go online to as many after.
 * @param {string} day @param {readonly FrontierCongress[]} [calendar]
 * @returns {FrontierCongress[]}
 */
export function frontierActiveCongresses(day, calendar = FRONTIER_CONGRESSES) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return []
  return calendar.filter((congress) => {
    const meeting = day >= shiftDay(congress.start, -FRONTIER_CONGRESS_WINDOW_DAYS) && day <= shiftDay(congress.end, FRONTIER_CONGRESS_WINDOW_DAYS)
    const abstracts = Boolean(congress.abstracts_at) && day >= /** @type {string} */ (congress.abstracts_at)
      && day <= shiftDay(/** @type {string} */ (congress.abstracts_at), FRONTIER_CONGRESS_WINDOW_DAYS)
    return meeting || abstracts
  })
}

/** The key two queries are the same by: NFKC, lower case, one space. @param {unknown} query */
export function frontierLeadQueryKey(query) {
  return String(query ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Formats, not language (principle 5): a DOI, a PMID written as such, a ClinicalTrials.gov number.
const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"'<>，。；、）\]]+/gi
const PMID_IN_TEXT = /\bPMID[:：\s]*(\d{6,9})\b/gi
const NCT_IN_TEXT = /\bNCT\d{8}\b/gi

/** A DOI as a text writes it, without the sentence's punctuation or a bracket it closes: `10.1016/s0140-6736(26)01234-5`. @param {string} raw */
function doiOfText(raw) {
  let doi = raw.replace(/[.,;:]+$/, '')
  while (doi.endsWith(')') && (doi.match(/\(/g) ?? []).length < (doi.match(/\)/g) ?? []).length) doi = doi.slice(0, -1).replace(/[.,;:]+$/, '')
  return doi.toLowerCase()
}

/**
 * The primary sources a report names, as addresses the plugin can read: a DOI (`https://doi.org/…`), a PMID
 * (`https://pubmed.ncbi.nlm.nih.gov/…/`) and a ClinicalTrials.gov number (`https://clinicaltrials.gov/study/…`) — from the
 * item's own columns and from its text, each once, at most `limit`.
 * @param {{ doi?: string | null, pmid?: string | null, registryIds?: readonly string[] | null, text?: string | null }} input
 * @param {{ limit?: number }} [options]
 * @returns {Array<{ kind: 'doi' | 'pmid' | 'nct', id: string, url: string }>}
 */
export function frontierIdentifierLeads({ doi = null, pmid = null, registryIds = [], text = null }, { limit = 3 } = {}) {
  /** @type {Map<string, { kind: 'doi' | 'pmid' | 'nct', id: string, url: string }>} */
  const found = new Map()
  const add = (/** @type {'doi' | 'pmid' | 'nct'} */ kind, /** @type {string} */ raw) => {
    const id = kind === 'doi' ? doiOfText(raw) : kind === 'nct' ? raw.toUpperCase() : raw
    const key = `${kind}:${id}`
    if (found.has(key) || !id) return
    const url = kind === 'doi' ? `https://doi.org/${id}` : kind === 'pmid' ? `https://pubmed.ncbi.nlm.nih.gov/${id}/` : `https://clinicaltrials.gov/study/${id}`
    found.set(key, { kind, id, url })
  }
  if (typeof doi === 'string' && /^10\.\d{4,9}\//.test(doi.trim())) add('doi', doi.trim())
  if (typeof pmid === 'string' && /^\d{6,9}$/.test(pmid.trim())) add('pmid', pmid.trim())
  for (const id of registryIds ?? []) if (/^NCT\d{8}$/i.test(String(id))) add('nct', String(id))
  const body = String(text ?? '')
  for (const match of body.matchAll(DOI_IN_TEXT)) add('doi', match[0])
  for (const match of body.matchAll(PMID_IN_TEXT)) add('pmid', match[1])
  for (const match of body.matchAll(NCT_IN_TEXT)) add('nct', match[0])
  return [...found.values()].slice(0, Math.max(0, limit))
}

/**
 * A day's query places per trigger: each trigger's share of the cap, rounded down, at least one while the cap allows.
 * @param {number} cap @returns {Record<string, number>}
 */
export function frontierLeadPlaces(cap) {
  const total = Math.max(0, Math.floor(Number(cap) || 0))
  return Object.fromEntries(FRONTIER_LEAD_TRIGGERS.map((trigger) => [trigger,
    total < FRONTIER_LEAD_TRIGGERS.length ? (FRONTIER_LEAD_TRIGGERS.indexOf(trigger) < total ? 1 : 0)
      : Math.max(1, Math.floor(total * /** @type {Record<string, number>} */ (FRONTIER_LEAD_SHARES)[trigger]))]))
}
