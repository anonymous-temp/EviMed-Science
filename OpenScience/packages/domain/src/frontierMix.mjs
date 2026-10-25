/**
 * The mix of 精选 by genre (owner, 2026-10-24: 「公众号和行业资讯太少，几乎都是新发表的 PubMed 论文」).
 *
 * 精选 is the feed's editorial list: what the score line lets through, but no longer whatever lets it through. Seven days
 * of production to 2026-10-24 selected journals 40%, regulators 19%, X 15%, news 14%, guideline bodies 7%, WeChat 4%,
 * preprints 2%, 16% of it Chinese. The owner approved share ranges for 精选 by genre group (`FRONTIER_MIX_GROUPS`) and a
 * Chinese share of at least 30% (`FRONTIER_MIX_ZH_TARGET`); `frontierMixSelect` picks a day's 精选 from its scored
 * candidates within them. It is a pure function: the pipeline hands it a day's published items and writes back the
 * picks, the replay (`frontierMixReplay`) hands it a week exported from production.
 *
 * The rules, in the order they bind:
 *
 * - **The line is the quality bar.** Above it, a group takes places up to its ceiling. Below it, only three things take a
 *   place, each from the medium band up (`FRONTIER_MIX_FLOOR_SCORE`, the lane floor's 60 since launch) and only with a
 *   Chinese summary: a group short of its floor (`genre-floor`), a Chinese item within `FRONTIER_MIX_ZH_MARGIN` of the
 *   line while the day is under its Chinese share (`zh-target`), and the preprint lane's two places, folded into the
 *   research group (`preprint-lane`) — a preprint under the line comes in by those places only. A `genre-floor` place
 *   asks of its item the genre's own bar instead of the absolute 60 (`FRONTIER_MIX_GENRE_FLOOR`, c2-fixes 2026-10-25):
 *   the editor's score is a clinical one, and the genres that are not clinical evidence — industry above all — score
 *   lower whatever their worth (on 2026-10-25 industry's median was 41 against a paper's 50; of 105 industry items
 *   today none reached 65 and one was selected, against a floor of 8%), so a floor place under the line needs the top
 *   fifth of its own genre's last 30 days of published scores, never less than 56 and never more than the 60 floor (c3-select 2026-10-25: it was 45 and 60 on the first scoring, with the line at 82; the line is 64 now).
 * - **A soft quota.** A group short of candidates is not padded with another group's items or with anything under the
 *   band: its places stay empty. News has no range of its own: it fills what the others leave of the day's size.
 * - **The day's size** (`FRONTIER_MIX_DAY`) is the number of non-safety items above the line the source caps allow,
 *   held between 20 and 60, so a quiet morning still has room for its floors and a day of a hundred X posts above the
 *   line is not a hundred places. Shares are of that size.
 * - **Safety alerts are always in** and count against nothing (`safety-bypass`, the pipeline's own rule). An operator's
 *   pin counts against nothing either.
 * - **The per-source cap** (3 a day, 5 for an authority-5 journal) binds every rule here, as it bound the line.
 * - **Merge rules** (`frontierMixMergeVerdict`): a roundup is never selected; a news report of a paper in the paper's
 *   event is never selected over it; an X post announcing a paper is never selected — the post is discussion, counted by
 *   the event's heat. When either of them would have cleared the line, the paper takes the place (`event-primary`) if it
 *   is in the medium band. A Chinese 解读 of a selected paper may stand beside it (Chinese value), whatever the event's
 *   one-selected-report rule said.
 * - **One pick per event** (c2-fixes 2026-10-25, gap review G8). The event grouping call answered "adds value" for 97% of
 *   the reports it judged, so `addsValue` let almost every second report through and 16 of 280 selected events held two to
 *   five items (about 11% of 精选: two genre-floor conference reports of one event in one round; a Paris court ruling in
 *   Czech and in German beside an earlier lane-floor pick; a fifth item four days after the fourth). Now an event that
 *   already has a selected item takes no pick, and an event with none takes at most one in a round — its paper if it has
 *   one among the candidates, else the best-ranked report. The one exception is the Chinese 解读 of a selected paper
 *   (the `beside-paper` verdict): it stands beside the paper, the paper being selected already or the event's pick of the
 *   round.
 * - **Selection is sticky** (the pipeline's rule): what is already selected counts against its group, its source and
 *   the day, and is never taken back here.
 *
 * Genre is `items.genre` when the editor wrote it, else `frontierGenreFallback` (contract A): `frontierMixGenre`.
 */

import { frontierItemGenre } from './frontierGenres.mjs'

/** @typedef {import('./frontierGenres.mjs').FrontierGenre} FrontierGenre */
/** @typedef {'research' | 'guideline' | 'regulatory' | 'policy' | 'industry' | 'commentary' | 'social' | 'news'} FrontierMixGroup */

/**
 * The owner's ranges (2026-10-24), as shares of the day's size. `chineseFirst`: within the group a Chinese candidate is
 * taken before an English one ("policy, Chinese first"; "commentary, Chinese interpretation"). News has no ceiling: it
 * fills what is left. A roundup is in no group: it is never selected.
 * @type {Readonly<Record<FrontierMixGroup, Readonly<{ genres: readonly FrontierGenre[], min: number, max: number | null, chineseFirst: boolean }>>>}
 */
export const FRONTIER_MIX_GROUPS = Object.freeze({
  research: Object.freeze({ genres: Object.freeze(/** @type {FrontierGenre[]} */ (['paper', 'preprint', 'conference', 'trial'])), min: 0.35, max: 0.45, chineseFirst: false }),
  guideline: Object.freeze({ genres: Object.freeze(/** @type {FrontierGenre[]} */ (['guideline'])), min: 0.08, max: 0.12, chineseFirst: false }),
  regulatory: Object.freeze({ genres: Object.freeze(/** @type {FrontierGenre[]} */ (['approval', 'safety'])), min: 0.10, max: 0.15, chineseFirst: false }),
  policy: Object.freeze({ genres: Object.freeze(/** @type {FrontierGenre[]} */ (['policy'])), min: 0.10, max: 0.15, chineseFirst: true }),
  industry: Object.freeze({ genres: Object.freeze(/** @type {FrontierGenre[]} */ (['industry'])), min: 0.08, max: 0.12, chineseFirst: false }),
  commentary: Object.freeze({ genres: Object.freeze(/** @type {FrontierGenre[]} */ (['commentary'])), min: 0.10, max: 0.15, chineseFirst: true }),
  social: Object.freeze({ genres: Object.freeze(/** @type {FrontierGenre[]} */ (['social'])), min: 0, max: 0.05, chineseFirst: false }),
  news: Object.freeze({ genres: Object.freeze(/** @type {FrontierGenre[]} */ (['news'])), min: 0, max: null, chineseFirst: false }),
})

/** The groups in the order their floors are filled. */
export const FRONTIER_MIX_GROUP_ORDER = /** @type {readonly FrontierMixGroup[]} */ (Object.freeze(Object.keys(FRONTIER_MIX_GROUPS)))

/** Genres never selected (a roundup is split, not selected — splitting is out of scope). */
export const FRONTIER_MIX_NEVER = /** @type {readonly FrontierGenre[]} */ (Object.freeze(['roundup']))

/** The Chinese share of a day's 精选 the selection works toward (owner, 2026-10-24: Chinese ≥ 30%). */
export const FRONTIER_MIX_ZH_TARGET = 0.30

/**
 * How far under the line a Chinese candidate may take a place while the day is under its Chinese share: with the line at 64 a Chinese
 * item of 60 comes in (c3-select 2026-10-25; it was 8 under a line of 82). On the week to 2026-10-24, 12-41 Chinese items a day stood between 74 and 81 on the first scoring (most of
 * them 公众号 解读 and Chinese regulators' notices), against 2-21 above the line.
 */
export const FRONTIER_MIX_ZH_MARGIN = 4

/**
 * The lowest score a place under the line is given from (c3-select 2026-10-25, on the recalibrated score): four under the line of 64,
 * the lower edge of the "medium" band (`FRONTIER_SCORE_TIERS`). On the gold set's dev split the labellers called half of the 8 items
 * in 60-63 picks and a quarter of the 8 in 58-59 (7 % of those in 50-54 on the first scoring): under 60 a floor place is a coin that
 * mostly lands wrong, and an unfilled floor beats a junk pick.
 */
export const FRONTIER_MIX_FLOOR_SCORE = 60

/**
 * What a `genre-floor` place under the line asks of its item's genre (c2-fixes 2026-10-25, owner: industry is too little in
 * 精选): a score within the top `1 - percentile` of the genre's published scores of the last `days` days (`percentile` 0.8,
 * the SQL `percentile_cont`), at least `min` (56) and at most `FRONTIER_MIX_FLOOR_SCORE` — a genre the editor scores high
 * (on the first scoring guidelines' 80th percentile was 84, above the line itself) keeps the floor it had: its top fifth is never a lower bar
 * than that, and asking it would empty the floor. A genre with fewer than `minSample` scored items in the window has no
 * floor of its own (a percentile of a handful is noise) and keeps the floor. Preprints, the Chinese margin and the event's
 * paper keep `FRONTIER_MIX_FLOOR_SCORE`.
 */
export const FRONTIER_MIX_GENRE_FLOOR = Object.freeze({ percentile: 0.8, min: 56, days: 30, minSample: 30 })

/**
 * The day's size: the non-safety items above the line the source caps allow (or what its research needs at its ceiling),
 * held between `min` and `max`. Ceilings are shares of at least `reference` places, so a thin day is not stripped of its
 * best guideline or approval to keep to a share of a small number (on 2026-10-21, 22 places would have capped guidelines
 * at two while three Chinese consensus statements scored 94).
 */
export const FRONTIER_MIX_DAY = Object.freeze({ min: 20, max: 60, reference: 40 })

/** In a congress week the research group may rise by this share of the day, for conference reports only. */
export const FRONTIER_MIX_CONGRESS_UPLIFT = 0.05

/**
 * Places a day the preprint lane keeps for preprints in the research group, and the score they need (owner, 2026-10-10: a few a day).
 * On the recalibrated score a preprint's impact is capped at 18 and its novelty at 14 (`frontier-selection.json`), so it tops out near
 * 55; the gold set's 18 preprints scored 33-45 and the labellers called none of them a pick. The bar is 50: the lane stays open for
 * the strong preprint and stays empty on the days there is none.
 */
export const FRONTIER_MIX_PREPRINT_PLACES = 2
export const FRONTIER_MIX_PREPRINT_MIN_SCORE = 50

/** Selected items a source may place per day, and an authority-5 journal (the pipeline's `FRONTIER_SOURCE_DAILY_CAP`). */
export const FRONTIER_MIX_SOURCE_CAP = 3
export const FRONTIER_MIX_TOP_JOURNAL_CAP = 5

/** Why the mix selected an item (`items.selected_rule`). */
export const FRONTIER_MIX_RULES = Object.freeze(['threshold', 'genre-floor', 'zh-target', 'preprint-lane', 'event-primary'])

/**
 * The rules whose selections count against a source's cap, a group and the day: the mix's own, and the lane floor the
 * mix replaced (items it selected before the switch are still selected). A safety alert and an operator's pin count
 * against none of them.
 */
export const FRONTIER_MIX_COUNTED_RULES = Object.freeze([...FRONTIER_MIX_RULES, 'lane-floor'])

/** Why the mix leaves a candidate out whatever its score (`frontierMixMergeVerdict`). */
export const FRONTIER_MIX_EXCLUSIONS = Object.freeze(['roundup', 'paper-rewrite', 'paper-discussion'])

/** @type {Readonly<Record<string, FrontierMixGroup>>} */
const GROUP_OF_GENRE = Object.freeze(Object.fromEntries(Object.entries(FRONTIER_MIX_GROUPS)
  .flatMap(([group, spec]) => spec.genres.map((genre) => [genre, /** @type {FrontierMixGroup} */ (group)]))))

/**
 * An item's genre as the mix reads it: `items.genre` when written, else code's fallback from its stored fields (contract
 * A, the one mapping).
 * @param {(Parameters<typeof frontierItemGenre>[0] & { genre?: string | null }) | null | undefined} row
 * @returns {FrontierGenre}
 */
export function frontierMixGenre(row) {
  return frontierItemGenre(row)
}

/** The group a genre counts against, or null for a genre never selected. @param {string} genre @returns {FrontierMixGroup | null} */
export function frontierMixGroup(genre) {
  return GROUP_OF_GENRE[genre] ?? null
}

/** The places a source has a day. @param {{ source_type?: string | null, sourceType?: string | null, authority?: number | string | null } | null | undefined} source */
export function frontierMixSourceCap(source) {
  const type = source?.source_type ?? source?.sourceType ?? null
  return type === 'journal' && Number(source?.authority) >= 5 ? FRONTIER_MIX_TOP_JOURNAL_CAP : FRONTIER_MIX_SOURCE_CAP
}

/**
 * @typedef {{ id: string, genre: string, evidenceType?: string | null, selected?: boolean, rule?: string | null, safety?: boolean }} FrontierMixEventMember
 * Another published report of the candidate's event (any day, enabled source), and whether it is selected, by which rule, and whether it
 * is a safety alert.
 */

/** Whether a member is the event's paper: a research paper or preprint, not a review or an opinion. @param {FrontierMixEventMember} member */
function isPaper(member) {
  return (member.genre === 'paper' || member.genre === 'preprint') && member.evidenceType !== 'review-opinion'
}

/**
 * What the merge rules say about a candidate, given the other reports of its event: excluded (`roundup`,
 * `paper-rewrite`, `paper-discussion`) with the paper it gives way to, allowed beside the paper (`beside-paper`: a
 * Chinese 解读 of it), or nothing to say. A news report stands beside its paper only when the paper is selected and the
 * event's grouping call judged it adds something (`addsValue: true`); otherwise it is the paper's rewrite.
 * @param {{ genre: string, zh?: boolean, addsValue?: boolean | null }} candidate @param {readonly FrontierMixEventMember[]} [members]
 * @returns {{ verdict: 'roundup' | 'paper-rewrite' | 'paper-discussion' | 'beside-paper' | null, paperId: string | null }}
 */
export function frontierMixMergeVerdict(candidate, members = []) {
  if (/** @type {readonly string[]} */ (FRONTIER_MIX_NEVER).includes(candidate.genre)) return { verdict: 'roundup', paperId: null }
  const paper = members.find((member) => isPaper(member) && member.selected === true) ?? members.find(isPaper) ?? null
  if (!paper) return { verdict: null, paperId: null }
  if (candidate.genre === 'news') {
    return paper.selected === true && candidate.addsValue === true ? { verdict: null, paperId: paper.id } : { verdict: 'paper-rewrite', paperId: paper.id }
  }
  if (candidate.genre === 'social') return { verdict: 'paper-discussion', paperId: paper.id }
  if (candidate.genre === 'commentary' && candidate.zh === true) return { verdict: 'beside-paper', paperId: paper.id }
  return { verdict: null, paperId: paper.id }
}

/**
 * @typedef {{
 *   id: string,
 *   genre: string,
 *   zh: boolean,
 *   score: number | null,
 *   selected: boolean,
 *   rule?: string | null,
 *   safety: boolean,
 *   sourceId: string,
 *   sourceCap?: number,
 *   eligible: boolean,
 *   summarized: boolean,
 *   floorEligible?: boolean,
 *   besideSelected?: boolean,
 *   addsValue?: boolean | null,
 *   eventId?: string | null,
 * }} FrontierMixCandidate
 * One published item of the day. `eligible`: verified, not demoted, not retracted, not a journal's paper without its
 * abstract (what the line already asked). `summarized`: it has a Chinese summary (asked of every place under the line).
 * `besideSelected`: the event's one-selected-report rule named another report it adds nothing to (fr-events); `addsValue`:
 * that rule's verdict as given (`event_selection.addsValue`), null when none was asked.
 * `rule`: the `selected_rule` of an item already selected. `floorEligible`: false for a republisher (`frontierFloorEligible`), which
 * only the line can select.
 */

/**
 * @typedef {{
 *   picks: Array<{ id: string, rule: string, group: FrontierMixGroup }>,
 *   excluded: Array<{ id: string, reason: string, paperId: string | null }>,
 *   superseded: Array<{ id: string, by: string, reason: 'safety-alert' }>,
 *   plan: {
 *     size: number, aboveLine: number, zhTarget: number,
 *     zhShare: { before: number, after: number },
 *     groups: Record<FrontierMixGroup, { floor: number, ceiling: number | null, before: number, after: number }>,
 *     rules: Record<string, number>,
 *     genreFloors: Record<string, number>,
 *     eventHeld: number,
 *   },
 * }} FrontierMixResult
 */

/** @param {number} value */
const share = (value) => Math.round(value * 1000) / 1000

/**
 * The score a `genre-floor` place under the line asks of a genre whose 80th percentile is `percentile`: that, held between
 * `FRONTIER_MIX_GENRE_FLOOR.min` and `floorScore` (the absolute floor, 60); `floorScore` when the genre has no percentile.
 * @param {unknown} percentile @param {number} [floorScore] @param {number} [min] the genre bar's lower end (`FRONTIER_MIX_GENRE_FLOOR.min`)
 */
export function frontierMixGenreFloorScore(percentile, floorScore = FRONTIER_MIX_FLOOR_SCORE, min = FRONTIER_MIX_GENRE_FLOOR.min) {
  const value = Number(percentile)
  if (percentile == null || !Number.isFinite(value)) return floorScore
  return Math.min(floorScore, Math.max(min, value))
}

/**
 * Each genre's 80th percentile of published scores (`FRONTIER_MIX_GENRE_FLOOR`), from rows shaped like the pipeline's
 * 30-day query: the columns `frontierMixGenre` reads (`genre`, `platform`, `channel`, `source_type`, `evidence_type`,
 * `flags`, `safety_alert`, `lane`), `score_total` and `n`, how many items the row stands for (default 1). Linear
 * interpolation between the two nearest ranks, as SQL's `percentile_cont`. A genre with fewer than `minSample` scored
 * items has no entry; a roundup (never selected) none either; a row without a score is left out.
 * @param {readonly Record<string, any>[]} rows
 * @param {{ percentile?: number, minSample?: number }} [options]
 * @returns {Record<string, number>}
 */
export function frontierMixGenreFloors(rows, { percentile = FRONTIER_MIX_GENRE_FLOOR.percentile, minSample = FRONTIER_MIX_GENRE_FLOOR.minSample } = {}) {
  /** @type {Map<string, Map<number, number>>} */
  const byGenre = new Map()
  for (const row of rows) {
    const score = row.score_total ?? row.score
    if (score == null || !Number.isFinite(Number(score))) continue
    const n = row.n == null ? 1 : Number(row.n)
    if (!(n > 0)) continue
    const genre = frontierMixGenre(row)
    const scores = byGenre.get(genre) ?? new Map()
    scores.set(Number(score), (scores.get(Number(score)) ?? 0) + n)
    byGenre.set(genre, scores)
  }
  /** @type {Record<string, number>} */
  const floors = {}
  for (const [genre, scores] of byGenre) {
    if (frontierMixGroup(genre) == null) continue
    const sorted = [...scores.entries()].sort((a, b) => a[0] - b[0])
    const total = sorted.reduce((sum, [, n]) => sum + n, 0)
    if (total < minSample) continue
    // The value at 0-based rank `r` of the expanded sorted list.
    const at = (/** @type {number} */ rank) => {
      let seen = 0
      for (const [value, n] of sorted) {
        seen += n
        if (rank < seen) return value
      }
      return sorted[sorted.length - 1][0]
    }
    const position = percentile * (total - 1)
    const low = Math.floor(position)
    const high = Math.min(low + 1, total - 1)
    floors[genre] = Math.round((at(low) + (at(high) - at(low)) * (position - low)) * 100) / 100
  }
  return floors
}

/**
 * Pick a day's 精选 from its scored candidates (the module's rules). Returns the new picks, the candidates the merge rules
 * left out, and the plan (the day's size, each group's floor, ceiling and count before and after, the Chinese share).
 *
 * @param {{
 *   candidates: readonly FrontierMixCandidate[],
 *   threshold: number,
 *   events?: Readonly<Record<string, readonly FrontierMixEventMember[]>>,
 *   congressActive?: boolean,
 *   preprintPlaces?: number,
 *   preprintMinScore?: number,
 *   floorScore?: number,
 *   genreFloors?: Readonly<Record<string, number>>,
 *   genreFloorMin?: number,
 *   zhMargin?: number,
 *   zhTarget?: number,
 *   day?: { min: number, max: number, reference?: number },
 * }} input
 *   `events`: the other published reports of each candidate's event, by event id. `genreFloors`: each genre's 80th
 *   percentile of the last 30 days (`frontierMixGenreFloors`), which sets what a `genre-floor` place under the line asks of
 *   an item of that genre (`FRONTIER_MIX_GENRE_FLOOR`); a genre not in it asks `floorScore`.
 * @returns {FrontierMixResult}
 */
export function frontierMixSelect({ candidates, threshold, events = {}, congressActive = false,
  preprintPlaces = FRONTIER_MIX_PREPRINT_PLACES, preprintMinScore = FRONTIER_MIX_PREPRINT_MIN_SCORE,
  floorScore = FRONTIER_MIX_FLOOR_SCORE, genreFloors = {}, genreFloorMin = FRONTIER_MIX_GENRE_FLOOR.min, zhMargin = FRONTIER_MIX_ZH_MARGIN,
  zhTarget = FRONTIER_MIX_ZH_TARGET, day = FRONTIER_MIX_DAY }) {
  const counted = (/** @type {string | null | undefined} */ rule) => /** @type {readonly string[]} */ (FRONTIER_MIX_COUNTED_RULES).includes(String(rule ?? ''))
  const scoreOf = (/** @type {FrontierMixCandidate} */ c) => (c.score == null || !Number.isFinite(Number(c.score)) ? null : Number(c.score))
  const aboveLine = (/** @type {FrontierMixCandidate} */ c) => c.eligible && scoreOf(c) != null && /** @type {number} */ (scoreOf(c)) >= threshold
  // A republisher's item (`frontier-selection.json`) takes no place under the line: a floor, the Chinese margin, the preprint lane and a
  // rewrite's place all go through here, and an unfilled place beats a pick that rewrites another feed.
  const inBand = (/** @type {FrontierMixCandidate} */ c, /** @type {number} */ from) => c.eligible && c.floorEligible !== false && c.summarized && scoreOf(c) != null && /** @type {number} */ (scoreOf(c)) >= from
  // What a `genre-floor` place under the line asks of the item's genre (`FRONTIER_MIX_GENRE_FLOOR`).
  const genreFloorOf = (/** @type {FrontierMixCandidate} */ c) => frontierMixGenreFloorScore(genreFloors[c.genre], floorScore, genreFloorMin)
  const capOf = (/** @type {FrontierMixCandidate} */ c) => (Number.isInteger(c.sourceCap) && /** @type {number} */ (c.sourceCap) > 0 ? /** @type {number} */ (c.sourceCap) : FRONTIER_MIX_SOURCE_CAP)

  // The merge rules, once per candidate.
  /** @type {Map<string, { verdict: string | null, paperId: string | null }>} */
  const merge = new Map()
  for (const c of candidates) {
    const members = c.eventId ? (events[c.eventId] ?? []).filter((member) => member.id !== c.id) : []
    merge.set(c.id, frontierMixMergeVerdict(c, members))
  }
  const excludedBy = (/** @type {FrontierMixCandidate} */ c) => {
    const verdict = merge.get(c.id)?.verdict ?? null
    return verdict && /** @type {readonly string[]} */ (FRONTIER_MIX_EXCLUSIONS).includes(verdict) ? verdict : null
  }
  // The one-selected-report rule stands, except for a Chinese 解读 beside its paper.
  const blockedByMerge = (/** @type {FrontierMixCandidate} */ c) => Boolean(excludedBy(c)) || (c.besideSelected === true && merge.get(c.id)?.verdict !== 'beside-paper')

  // One pick per event (module docstring): the reports of an event that must wait for another, decided once per round.
  const selectedIds = new Set([
    ...candidates.filter((c) => c.selected).map((c) => c.id),
    ...Object.values(events).flatMap((members) => members.filter((member) => member.selected === true).map((member) => member.id)),
  ])
  /** A Chinese 解读 of a paper that is selected already: it stands beside it, outside the event's one pick. */
  const besideSelectedPaper = (/** @type {FrontierMixCandidate} */ c) => {
    const entry = merge.get(c.id)
    return entry?.verdict === 'beside-paper' && entry.paperId != null && selectedIds.has(entry.paperId)
  }
  /** The ranking an event's one pick goes by: its paper, then the higher score, then a Chinese report, then the id. */
  const eventRank = (/** @type {FrontierMixCandidate} */ a, /** @type {FrontierMixCandidate} */ b) => {
    const paper = (/** @type {FrontierMixCandidate} */ c) => (c.genre === 'paper' || c.genre === 'preprint' ? 0 : 1)
    return paper(a) - paper(b) || (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1) || Number(b.zh) - Number(a.zh) || String(a.id).localeCompare(String(b.id))
  }
  /** @type {Set<string>} */
  const eventHeld = new Set()
  /** @type {Map<string, FrontierMixCandidate[]>} */
  const byEvent = new Map()
  for (const c of candidates) {
    if (c.eventId == null || c.selected || c.safety || !frontierMixGroup(c.genre) || blockedByMerge(c)) continue
    byEvent.set(c.eventId, [...(byEvent.get(c.eventId) ?? []), c])
  }
  for (const [eventId, list] of byEvent) {
    const contenders = list.filter((c) => !besideSelectedPaper(c))
    const heldAlready = [...(events[eventId] ?? []).map((member) => member.id), ...candidates.filter((c) => c.eventId === eventId).map((c) => c.id)]
      .some((id) => selectedIds.has(id))
    const winner = heldAlready ? null : [...contenders].sort(eventRank)[0] ?? null
    for (const c of contenders) {
      if (c === winner) continue
      if (winner && merge.get(c.id)?.verdict === 'beside-paper' && merge.get(c.id)?.paperId === winner.id) continue
      eventHeld.add(c.id)
    }
  }
  const blocked = (/** @type {FrontierMixCandidate} */ c) => blockedByMerge(c) || eventHeld.has(c.id)

  // A safety alert is the event's report (c3-select S7, event 036972fb29143a2a: one recall selected twice, once by the line and once by the
  // safety bypass, which has no event to look at when the alert is published): a report of its event that an arithmetic rule selected
  // gives its place to it. The pipeline unselects what is named here and points it at the alert; selection stays sticky for everything else.
  /** @type {FrontierMixResult['superseded']} */
  const superseded = []
  for (const members of Object.values(events)) {
    const alert = members.find((member) => member.safety === true && member.selected === true)
    if (!alert) continue
    for (const member of members) {
      if (member.id === alert.id || member.selected !== true || member.safety === true || !counted(member.rule)) continue
      if (!superseded.some((entry) => entry.id === member.id)) superseded.push({ id: member.id, by: alert.id, reason: 'safety-alert' })
    }
  }

  // What is already selected counts (selection is sticky).
  /** @type {Record<string, number>} */
  const groupCount = Object.fromEntries(FRONTIER_MIX_GROUP_ORDER.map((group) => [group, 0]))
  /** @type {Map<string, number>} */
  const sourceCount = new Map()
  let total = 0
  let all = 0
  let zh = 0
  let preprints = 0
  let conferenceExtra = 0
  for (const c of candidates) {
    if (!c.selected) continue
    all += 1
    if (c.zh) zh += 1
    const group = frontierMixGroup(c.genre)
    if (c.safety || !counted(c.rule)) continue
    total += 1
    if (group) groupCount[group] += 1
    if (c.genre === 'preprint') preprints += 1
    sourceCount.set(c.sourceId, (sourceCount.get(c.sourceId) ?? 0) + 1)
  }
  const before = { groups: { ...groupCount }, all, zh }

  // The day's size: the non-safety items above the line the source caps allow (and those already selected).
  const roomBySource = new Map(sourceCount)
  let aboveLineCount = total
  for (const c of [...candidates].filter((x) => !x.selected && !x.safety && aboveLine(x) && !blocked(x))
    .sort((a, b) => /** @type {number} */ (scoreOf(b)) - /** @type {number} */ (scoreOf(a)) || String(a.id).localeCompare(String(b.id)))) {
    const used = roomBySource.get(c.sourceId) ?? 0
    if (used >= capOf(c)) continue
    roomBySource.set(c.sourceId, used + 1)
    aboveLineCount += 1
  }
  // Research is the group the line lets through most; its above-line count at its ceiling sizes the day when that is more
  // than everything above the line, so the rest are added beside it rather than research cut down to them.
  const researchAbove = [...candidates].filter((x) => !x.selected && !x.safety && aboveLine(x) && !blocked(x) && frontierMixGroup(x.genre) === 'research').length
    + groupCount.research
  const researchSized = Math.ceil(Math.min(researchAbove, aboveLineCount) / /** @type {number} */ (FRONTIER_MIX_GROUPS.research.max))
  const size = Math.max(day.min, Math.min(day.max, Math.max(aboveLineCount, researchSized)))
  /** @type {Record<string, number>} */
  const floors = Object.fromEntries(FRONTIER_MIX_GROUP_ORDER.map((group) => [group, Math.floor(FRONTIER_MIX_GROUPS[group].min * size)]))
  const ceilingBase = Math.max(size, Number(day.reference) || 0)
  /** @type {Record<string, number>} */
  const ceilings = Object.fromEntries(FRONTIER_MIX_GROUP_ORDER.map((group) => {
    const max = FRONTIER_MIX_GROUPS[group].max
    return [group, max == null ? Infinity : Math.max(max > 0 ? 1 : 0, Math.floor(max * ceilingBase))]
  }))
  const conferencePlaces = congressActive ? Math.floor(FRONTIER_MIX_CONGRESS_UPLIFT * size) : 0

  /** @type {FrontierMixResult['picks']} */
  const picks = []
  const taken = new Set(candidates.filter((c) => c.selected).map((c) => c.id))
  const zhBelowTarget = () => (all === 0 ? true : zh / all < zhTarget)
  const sourceRoom = (/** @type {FrontierMixCandidate} */ c) => (sourceCount.get(c.sourceId) ?? 0) < capOf(c)
  /** @param {FrontierMixCandidate} c @param {string} rule @param {FrontierMixGroup} group */
  const take = (c, rule, group) => {
    picks.push({ id: c.id, rule, group })
    taken.add(c.id)
    total += 1
    all += 1
    if (c.zh) zh += 1
    groupCount[group] += 1
    if (c.genre === 'preprint') preprints += 1
    sourceCount.set(c.sourceId, (sourceCount.get(c.sourceId) ?? 0) + 1)
  }
  const open = candidates.filter((c) => !c.selected && !c.safety && frontierMixGroup(c.genre) && !blocked(c))
  /** @param {FrontierMixCandidate[]} list @param {boolean} chineseFirst */
  const ranked = (list, chineseFirst) => [...list].sort((a, b) => (chineseFirst ? Number(b.zh) - Number(a.zh) : 0)
    || /** @type {number} */ (scoreOf(b)) - /** @type {number} */ (scoreOf(a)) || String(a.id).localeCompare(String(b.id)))

  // 1. Each group's floor, from above the line first, then from the band (`genre-floor`).
  for (const group of FRONTIER_MIX_GROUP_ORDER) {
    const spec = FRONTIER_MIX_GROUPS[group]
    if (floors[group] < 1) continue
    const mine = open.filter((c) => frontierMixGroup(c.genre) === group)
    for (const c of ranked(mine.filter(aboveLine), spec.chineseFirst)) {
      if (groupCount[group] >= floors[group] || total >= size) break
      if (!taken.has(c.id) && sourceRoom(c)) take(c, 'threshold', group)
    }
    // A preprint under the line comes in only by the preprint lane's places (owner, 2026-10-10: up to two a day).
    for (const c of ranked(mine.filter((x) => !aboveLine(x) && x.genre !== 'preprint' && inBand(x, genreFloorOf(x))), spec.chineseFirst)) {
      if (groupCount[group] >= floors[group] || total >= size) break
      if (!taken.has(c.id) && sourceRoom(c)) take(c, 'genre-floor', group)
    }
  }

  // 2. The preprint lane's places, inside the research group.
  for (const c of ranked(open.filter((x) => x.genre === 'preprint' && !aboveLine(x) && inBand(x, preprintMinScore)), false)) {
    if (preprints >= preprintPlaces || groupCount.research >= ceilings.research || total >= size) break
    if (!taken.has(c.id) && sourceRoom(c)) take(c, 'preprint-lane', 'research')
  }

  // 3. The rest of the day, best first across groups, each group to its ceiling and news to the day's size. A Chinese
  // candidate ranks `zhMargin` higher while the day is under its Chinese share, and may come from that far under the line
  // (`zh-target`). The paper of an event whose news rewrite or X post would have cleared the line ranks at that report's
  // score and may come from the band (`event-primary`).
  /** @type {Map<string, number>} */
  const signal = new Map()
  for (const c of candidates) {
    const verdict = merge.get(c.id)
    if (!verdict?.paperId || (verdict.verdict !== 'paper-rewrite' && verdict.verdict !== 'paper-discussion') || !aboveLine(c)) continue
    signal.set(verdict.paperId, Math.max(signal.get(verdict.paperId) ?? 0, /** @type {number} */ (scoreOf(c))))
  }
  const boostOn = zhBelowTarget()
  const keyOf = (/** @type {FrontierMixCandidate} */ c) => Math.max(/** @type {number} */ (scoreOf(c) ?? 0), signal.get(c.id) ?? 0) + (boostOn && c.zh ? zhMargin : 0)
  const underLine = (/** @type {FrontierMixCandidate} */ c) => c.genre !== 'preprint'
    && ((c.zh && inBand(c, Math.max(floorScore, threshold - zhMargin))) || (signal.has(c.id) && inBand(c, floorScore)))
  const rest = open.filter((c) => aboveLine(c) || underLine(c))
    .sort((a, b) => keyOf(b) - keyOf(a) || String(a.id).localeCompare(String(b.id)))
  for (const c of rest) {
    if (total >= size) break
    if (taken.has(c.id) || !sourceRoom(c)) continue
    const group = /** @type {FrontierMixGroup} */ (frontierMixGroup(c.genre))
    let rule = 'threshold'
    if (!aboveLine(c)) {
      if (signal.has(c.id) && inBand(c, floorScore)) rule = 'event-primary'
      else if (c.zh && zhBelowTarget()) rule = 'zh-target'
      else continue
    }
    if (groupCount[group] >= ceilings[group]) {
      if (!(group === 'research' && c.genre === 'conference' && conferenceExtra < conferencePlaces)) continue
      conferenceExtra += 1
    }
    take(c, rule, group)
  }

  // 4. Still under the Chinese share: a Chinese candidate within `zhMargin` of the line takes the place of an English pick
  // of its own group it is within `zhMargin` of, the smallest loss of score first (`zh-target`). Only this run's picks give
  // way: a selection already written stands.
  const byId = new Map(candidates.map((c) => [c.id, c]))
  for (let guard = 0; zhBelowTarget() && guard < candidates.length; guard += 1) {
    /** @type {{ loss: number, out: number, inc: FrontierMixCandidate } | null} */
    let best = null
    for (const group of FRONTIER_MIX_GROUP_ORDER) {
      const english = picks.map((pick, index) => ({ pick, index, c: /** @type {FrontierMixCandidate} */ (byId.get(pick.id)) }))
        .filter(({ pick, c }) => pick.group === group && !c.zh && (pick.rule === 'threshold' || pick.rule === 'genre-floor'))
        .sort((a, b) => /** @type {number} */ (scoreOf(a.c)) - /** @type {number} */ (scoreOf(b.c)))[0]
      if (!english) continue
      const outScore = /** @type {number} */ (scoreOf(english.c))
      for (const c of ranked(open.filter((x) => x.zh && !taken.has(x.id) && frontierMixGroup(x.genre) === group
        && (aboveLine(x) || (x.genre !== 'preprint' && inBand(x, Math.max(floorScore, threshold - zhMargin))))), false)) {
        const freed = c.sourceId === english.c.sourceId ? 1 : 0
        if ((sourceCount.get(c.sourceId) ?? 0) - freed >= capOf(c)) continue
        const loss = outScore - /** @type {number} */ (scoreOf(c))
        if (loss <= zhMargin && (!best || loss < best.loss)) best = { loss, out: english.index, inc: c }
        break
      }
    }
    if (!best) break
    const [removed] = picks.splice(best.out, 1)
    const out = /** @type {FrontierMixCandidate} */ (byId.get(removed.id))
    taken.delete(out.id)
    total -= 1
    all -= 1
    groupCount[removed.group] -= 1
    if (out.genre === 'preprint') preprints -= 1
    sourceCount.set(out.sourceId, (sourceCount.get(out.sourceId) ?? 1) - 1)
    take(best.inc, 'zh-target', removed.group)
  }

  /** @type {Record<string, number>} */
  const rules = {}
  for (const pick of picks) rules[pick.rule] = (rules[pick.rule] ?? 0) + 1
  return {
    picks,
    superseded,
    excluded: candidates.filter((c) => excludedBy(c)).map((c) => ({ id: c.id, reason: /** @type {string} */ (excludedBy(c)), paperId: merge.get(c.id)?.paperId ?? null })),
    plan: {
      size, aboveLine: aboveLineCount, zhTarget,
      zhShare: { before: before.all ? share(before.zh / before.all) : 0, after: all ? share(zh / all) : 0 },
      groups: /** @type {FrontierMixResult['plan']['groups']} */ (Object.fromEntries(FRONTIER_MIX_GROUP_ORDER.map((group) => [group, {
        floor: floors[group], ceiling: Number.isFinite(ceilings[group]) ? ceilings[group] : null,
        before: before.groups[group], after: groupCount[group],
      }]))),
      rules,
      // What a floor place under the line asked of each genre that has a percentile (the rest asked `floorScore`).
      genreFloors: Object.fromEntries(Object.keys(genreFloors).map((genre) => [genre, frontierMixGenreFloorScore(genreFloors[genre], floorScore, genreFloorMin)])),
      // Reports left out because their event has a selected item or another report of it was chosen for the round.
      eventHeld: eventHeld.size,
    },
  }
}

/**
 * @typedef {{
 *   day: string, candidates: number,
 *   before: { total: number, groups: Record<string, number>, zh: number, zhShare: number },
 *   after: { total: number, groups: Record<string, number>, zh: number, zhShare: number },
 *   rules: Record<string, number>, excluded: Record<string, number>, size: number,
 * }} FrontierMixReplayDay
 */

/**
 * A day as production's export names it: the item's day in the feed's time zone — `timeline_at` when the export has it,
 * else the pipeline's 72-hour rule over `first_seen_at` and `published_at`.
 * @param {Record<string, any>} row @param {string} timeZone
 */
function replayDay(row, timeZone) {
  const seen = new Date(row.timeline_at ?? row.first_seen_at)
  const published = row.timeline_at ? NaN : new Date(row.published_at ?? NaN).getTime()
  const at = Number.isFinite(published) && seen.getTime() - published > 72 * 3_600_000 ? new Date(published) : seen
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/**
 * Replay a week of scored items exported from production (`public_id`, the genre inputs, `lang`, `score_total`,
 * `verification`, `flags`, `selected`, `selected_rule`, `source_id`, `source_type`, `src_authority`, `event_id`,
 * `same_event_item_id`, `first_seen_at`, `published_at` or `timeline_at`) through `frontierMixSelect`, day by day, as if
 * each day were selected at once: what production selected (before) and what the mix selects (after), by group, with
 * the Chinese share. Safety alerts are in on both sides. Rows without a day are left out.
 * @param {readonly Record<string, any>[]} rows
 * @param {{ threshold: number, timeZone?: string, congressDays?: readonly string[], genreFloors?: Readonly<Record<string, number>>,
 *   floorScore?: number, genreFloorMin?: number, zhMargin?: number, preprintMinScore?: number }} options
 *   `genreFloors`: each genre's 80th percentile (`frontierMixGenreFloors`), passed to every day's selection; without it a
 *   floor place asks the absolute `FRONTIER_MIX_FLOOR_SCORE`, as before c2-fixes.
 * @returns {FrontierMixReplayDay[]}
 */
export function frontierMixReplay(rows, { threshold, timeZone = 'Asia/Shanghai', congressDays = [], genreFloors = {}, ...selectOptions }) {
  const genreOf = (/** @type {Record<string, any>} */ row) => frontierMixGenre(row)
  const zhOf = (/** @type {Record<string, any>} */ row) => String(row.lang ?? '').startsWith('zh')
  /** @type {Record<string, FrontierMixEventMember[]>} */
  const events = {}
  for (const row of rows) {
    if (row.event_id == null) continue
    const members = events[String(row.event_id)] ?? []
    // Each day is selected from nothing in the replay: a member is selected only as a safety alert.
    members.push({ id: String(row.public_id), genre: genreOf(row), evidenceType: row.evidence_type ?? null, selected: row.safety_alert === true })
    events[String(row.event_id)] = members
  }
  /** @type {Map<string, Record<string, any>[]>} */
  const byDay = new Map()
  for (const row of rows) {
    if (!row.first_seen_at && !row.timeline_at) continue
    const key = replayDay(row, timeZone)
    const list = byDay.get(key) ?? []
    list.push(row)
    byDay.set(key, list)
  }
  const tally = (/** @type {Record<string, any>[]} */ chosen) => {
    /** @type {Record<string, number>} */
    const groups = {}
    for (const row of chosen) {
      const group = frontierMixGroup(genreOf(row)) ?? genreOf(row)
      groups[group] = (groups[group] ?? 0) + 1
    }
    const zh = chosen.filter(zhOf).length
    return { total: chosen.length, groups, zh, zhShare: chosen.length ? share(zh / chosen.length) : 0 }
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dayKey, dayRows]) => {
    const flags = (/** @type {Record<string, any>} */ row) => (Array.isArray(row.flags) ? row.flags : [])
    /** @type {FrontierMixCandidate[]} */
    const candidates = dayRows.map((row) => {
      const verified = row.verification === 'passed' || row.verification === 'repaired'
      const safety = row.safety_alert === true
      return {
        id: String(row.public_id), genre: genreOf(row), zh: zhOf(row),
        score: row.score_total == null ? null : Number(row.score_total),
        selected: safety, rule: safety ? 'safety-bypass' : null, safety,
        sourceId: String(row.source_id), sourceCap: frontierMixSourceCap({ source_type: row.source_type, authority: row.src_authority }),
        eligible: verified && !flags(row).includes('retracted') && !(row.source_type === 'journal' && flags(row).includes('no-abstract')),
        summarized: verified,
        besideSelected: row.same_event_item_id != null,
        addsValue: typeof row.adds_value === 'boolean' ? row.adds_value : null,
        eventId: row.event_id == null ? null : String(row.event_id),
      }
    })
    const result = frontierMixSelect({ candidates, threshold, events, congressActive: congressDays.includes(dayKey), genreFloors, ...selectOptions })
    const picked = new Set(result.picks.map((pick) => pick.id))
    /** @type {Record<string, number>} */
    const excluded = {}
    for (const entry of result.excluded) excluded[entry.reason] = (excluded[entry.reason] ?? 0) + 1
    return {
      day: dayKey, candidates: dayRows.length,
      before: tally(dayRows.filter((row) => row.selected === true)),
      after: tally(dayRows.filter((row) => row.safety_alert === true || picked.has(String(row.public_id)))),
      rules: { ...(candidates.some((c) => c.safety) ? { 'safety-bypass': candidates.filter((c) => c.safety).length } : {}), ...result.plan.rules },
      excluded, size: result.plan.size,
    }
  })
}
