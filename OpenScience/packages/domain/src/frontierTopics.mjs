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

// ───────────────────────── c2-leads 2026-10-25: the pure decisions of the outside-event trigger ─────────────────────────

/**
 * What makes a hot-list entry a candidate (numbers only, no language rule: principle 5): new — not seen on any board in the
 * `unseenHours` before its sighting, after `frontierHotTitleKey` —, at most `maxRank` on its board, and seen in `minStreak`
 * consecutive snapshots of that board (a flash entry is gone at the next round). At most `perRound` candidates go to the
 * model in one round, the best-ranked first.
 */
export const FRONTIER_TOPIC_CANDIDATE = Object.freeze({ maxRank: 30, minStreak: 2, unseenHours: 48, perRound: 60 })

/**
 * A surge (one a day beside `FRONTIER_TOPIC_LIMITS.perDay`, with more searches a wave): an event in the top `topRank` of at
 * least `boards` boards at once, with at least `medicalEntries` entries in its group that are themselves the medical question
 * (on 2026-03-24 Weibo held 「心源性猝死」 and 「黄金四分钟是心源性猝死抢救关键」 within hours) — both counted in code from the
 * grouping call's answer.
 */
export const FRONTIER_TOPIC_SURGE = Object.freeze({ topRank: 10, boards: 2, medicalEntries: 3 })

/** The grouping call's confidence below which a group is not made a topic. */
export const FRONTIER_TOPIC_MIN_CONFIDENCE = 0.7

/** An item older than the topic's first sighting by more than this is the topic's background, whatever its genre. */
export const FRONTIER_TOPIC_BACKGROUND_DAYS = 30

/** The genres that are evidence to a topic (`@evimed/domain` `FRONTIER_GENRES`); every other genre is a report on it. */
export const FRONTIER_TOPIC_EVIDENCE_GENRES = Object.freeze(['paper', 'preprint', 'trial', 'guideline', 'conference', 'approval', 'safety'])

/**
 * The key two hot-list titles are the same entry by, across boards and rounds: NFKC, lower case, without the hashtag marks,
 * the spaces, the punctuation and the symbols — a format, not a reading of the words.
 * @param {unknown} title @returns {string}
 */
export function frontierHotTitleKey(title) {
  return String(title ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 200)
}

/**
 * What an item is to a topic, in code: its background when it is older than the topic's first sighting by more than
 * `FRONTIER_TOPIC_BACKGROUND_DAYS`, evidence when its genre is one of `FRONTIER_TOPIC_EVIDENCE_GENRES`, a report otherwise.
 * @param {{ genre: string, publishedAt?: string | Date | null, firstSeenAt: string | Date }} input
 * @returns {'report' | 'evidence' | 'background'}
 */
export function frontierTopicItemRole({ genre, publishedAt = null, firstSeenAt }) {
  const published = publishedAt == null ? Number.NaN : new Date(publishedAt).getTime()
  const first = new Date(firstSeenAt).getTime()
  if (Number.isFinite(published) && Number.isFinite(first) && published < first - FRONTIER_TOPIC_BACKGROUND_DAYS * 86_400_000) return 'background'
  return /** @type {readonly string[]} */ (FRONTIER_TOPIC_EVIDENCE_GENRES).includes(genre) ? 'evidence' : 'report'
}

/**
 * The names of an event's people or bodies a text holds (NFKC, case-folded substring; a name shorter than two characters
 * is not matched): a topic's title, question and evidence queries must hold none.
 * @param {unknown} text @param {readonly unknown[]} names @returns {string[]}
 */
export function frontierTopicNamesIn(text, names) {
  const haystack = String(text ?? '').normalize('NFKC').toLowerCase()
  const found = []
  for (const name of names ?? []) {
    const needle = String(name ?? '').normalize('NFKC').toLowerCase().trim()
    if ([...needle].length >= 2 && haystack.includes(needle)) found.push(String(name))
  }
  return found
}

/**
 * Whether a group is a surge (`FRONTIER_TOPIC_SURGE`): its members' boards where one stood in the top `topRank`, and the
 * count of its members that are themselves the medical question.
 * @param {{ members: ReadonlyArray<{ board: string, rank: number }>, medicalEntries: number }} group
 * @returns {{ surge: boolean, topBoards: number }}
 */
export function frontierTopicSurge({ members, medicalEntries }) {
  const topBoards = new Set(members.filter((member) => Number(member.rank) <= FRONTIER_TOPIC_SURGE.topRank).map((member) => member.board)).size
  return { surge: topBoards >= FRONTIER_TOPIC_SURGE.boards && Number(medicalEntries) >= FRONTIER_TOPIC_SURGE.medicalEntries, topBoards }
}
