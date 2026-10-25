/**
 * Hot-event topics of 「前沿动态」 (owner, 2026-10-25: 「热点事件……各种领域的，战争 经济 国事 娱乐等等的，你要覆盖全了」).
 *
 * A public hot event in any field — a public figure's illness, a war, an economic or policy decision, a disaster, a sports
 * collapse, a food-safety scandal, a viral health claim — often raises a general medical question that readers want evidence
 * for the same day (the 2026-03-24 sudden cardiac death of 张雪峰 put 「心源性猝死」 at the top of Weibo within hours). A topic
 * is that question: written as the question, never as the person; the event is one attributed line (`peg`); what the lead
 * triggers found for it — Chinese reports, primary research, guidelines and statistics — are its items; one overview paragraph
 * places them, citing each by number. The platform does not report the event itself and writes no news of its own: a topic
 * curates and cites, and the deeper answer, when the evidence programme takes the day's strongest topic, is an official evidence
 * card whose every claim is checked against its source (`programme_*`).
 *
 * The vocabulary here is shared by the lead trigger (`apps/server/src/frontierLeads.mjs`), the topic service, the evidence
 * programme and the reader pages.
 */

/**
 * The fields a hot event comes from — every field, because the medical question does not stay in medicine (a war: blast
 * injuries, trauma care, PTSD, infection in displacement; an economic decision: drug prices, medical insurance, supply; a
 * heat wave: heat stroke). Recorded per topic for the operators' counts; a reader sees the label.
 * @typedef {'public-figure' | 'entertainment' | 'sports' | 'conflict' | 'disaster' | 'accident' | 'economy' | 'policy' | 'society' | 'technology' | 'environment' | 'food-safety' | 'outbreak' | 'education' | 'international' | 'health-claim' | 'other'} FrontierTopicDomain
 */

export const FRONTIER_TOPIC_DOMAINS = /** @type {readonly FrontierTopicDomain[]} */ (Object.freeze([
  'public-figure',
  'entertainment',
  'sports',
  'conflict',
  'disaster',
  'accident',
  'economy',
  'policy',
  'society',
  'technology',
  'environment',
  'food-safety',
  'outbreak',
  'education',
  'international',
  'health-claim',
  'other',
]))

export const FRONTIER_TOPIC_DOMAIN_LABELS_ZH = /** @type {Readonly<Record<FrontierTopicDomain, string>>} */ (Object.freeze({
  'public-figure': '公众人物',
  entertainment: '文娱',
  sports: '体育',
  conflict: '战争冲突',
  disaster: '自然灾害',
  accident: '事故',
  economy: '经济',
  policy: '国事政策',
  society: '社会',
  technology: '科技',
  environment: '环境气候',
  'food-safety': '食品安全',
  outbreak: '疫情',
  education: '教育',
  international: '国际',
  'health-claim': '健康说法',
  other: '其他',
}))

/**
 * The public hot lists a topic can be first seen on, read by the knowledge-source plugin (contract 1.7.0 `GET /v1/hot-lists`):
 * three Chinese boards that together cover every field, and two international ones read through the relay egress.
 */
export const FRONTIER_HOT_BOARDS = Object.freeze(['baidu', 'toutiao', 'weibo', 'wikipedia-en', 'google-trends'])

export const FRONTIER_TOPIC_STATUSES = Object.freeze(['active', 'closed'])

/** What an item is to a topic: a report on the question, a piece of primary evidence, or the background a reader needs. */
export const FRONTIER_TOPIC_ITEM_ROLES = Object.freeze(['report', 'evidence', 'background'])

/** How an item came to the topic: found by the topic's own searches, or already in the feed when the topic was made. */
export const FRONTIER_TOPIC_ITEM_VIA = Object.freeze(['lead', 'corpus'])

/** Where the evidence programme stands with a topic: waiting, taken as the day's question, answered by a card, or passed over. */
export const FRONTIER_TOPIC_PROGRAMME_STATES = Object.freeze(['queued', 'taken', 'card', 'skipped'])

/**
 * The limits a topic lives within. `perDay` topics are accepted a day plus `surgePerDay` surge (an event high on several boards
 * at once); a topic is active `activeHours` after it was accepted, its searches run in `waveOffsetsHours` waves (0, +6 h, and the
 * next morning's watch hour), and nothing is searched for it once closed. The lengths are what the reader pages draw.
 */
export const FRONTIER_TOPIC_LIMITS = Object.freeze({
  perDay: 4,
  surgePerDay: 1,
  activeHours: 72,
  waveOffsetsHours: Object.freeze([0, 6]),
  titleChars: 40,
  questionChars: 80,
  pegChars: 120,
  overviewMin: 120,
  overviewMax: 360,
  overviewRefs: 8,
})

/** @param {unknown} value @returns {value is FrontierTopicDomain} */
export function isFrontierTopicDomain(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (FRONTIER_TOPIC_DOMAINS).includes(value)
}
