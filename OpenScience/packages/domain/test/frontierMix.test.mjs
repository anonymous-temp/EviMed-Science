import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRONTIER_GENRES,
  FRONTIER_MIX_COUNTED_RULES,
  FRONTIER_MIX_DAY,
  FRONTIER_MIX_FLOOR_SCORE,
  FRONTIER_MIX_GENRE_FLOOR,
  FRONTIER_MIX_GROUP_ORDER,
  FRONTIER_MIX_GROUPS,
  FRONTIER_MIX_NEVER,
  FRONTIER_MIX_RULES,
  FRONTIER_MIX_PREPRINT_MIN_SCORE,
  FRONTIER_MIX_ZH_MARGIN,
  FRONTIER_MIX_ZH_TARGET,
  frontierMixGenre,
  frontierMixGenreFloors,
  frontierMixGenreFloorScore,
  frontierMixGroup,
  frontierMixMergeVerdict,
  frontierMixReplay,
  frontierMixSelect,
  frontierMixSourceCap,
} from '../index.mjs'

/** The numbers the mix's tests were written with, before the score was recalibrated (c3-select 2026-10-25): the algorithm is the same on any scale. */
const OLD_SCALE = { floorScore: 60, zhMargin: 8, genreFloorMin: 45, preprintMinScore: 60 }

let serial = 0
/** @param {Record<string, any>} overrides */
function item(overrides = {}) {
  serial += 1
  return { id: `i${serial}`, genre: 'paper', zh: false, score: 85, selected: false, rule: null, safety: false,
    sourceId: `s${serial}`, sourceCap: 3, eligible: true, summarized: true, besideSelected: false, eventId: null, ...overrides }
}
/** @param {ReturnType<typeof frontierMixSelect>} result */
const byRule = (result) => Object.fromEntries(FRONTIER_MIX_RULES.map((rule) => [rule, result.picks.filter((pick) => pick.rule === rule).map((pick) => pick.id)]))
const ids = (/** @type {ReturnType<typeof frontierMixSelect>} */ result) => result.picks.map((pick) => pick.id).sort()

test('the owner\'s ranges: every genre but a roundup counts against exactly one group, and the shares are the approved ones', () => {
  const grouped = Object.values(FRONTIER_MIX_GROUPS).flatMap((group) => group.genres)
  assert.deepEqual([...grouped, ...FRONTIER_MIX_NEVER].sort(), [...FRONTIER_GENRES].sort())
  assert.equal(new Set(grouped).size, grouped.length)
  assert.deepEqual(Object.fromEntries(FRONTIER_MIX_GROUP_ORDER.map((group) => [group, [FRONTIER_MIX_GROUPS[group].min, FRONTIER_MIX_GROUPS[group].max]])), {
    research: [0.35, 0.45], guideline: [0.08, 0.12], regulatory: [0.10, 0.15], policy: [0.10, 0.15], industry: [0.08, 0.12],
    commentary: [0.10, 0.15], social: [0, 0.05], news: [0, null],
  })
  assert.equal(FRONTIER_MIX_ZH_TARGET, 0.30)
  assert.equal(frontierMixGroup('roundup'), null)
  assert.equal(frontierMixGroup('conference'), 'research')
  assert.ok(FRONTIER_MIX_COUNTED_RULES.includes('lane-floor'), 'a lane-floor selection made before the switch still counts')
  assert.equal(FRONTIER_MIX_COUNTED_RULES.includes('safety-bypass'), false)
})

test('genre is the column when the editor wrote it, else code\'s fallback — one mapping', () => {
  assert.equal(frontierMixGenre({ genre: 'industry', source_type: 'journal' }), 'industry')
  assert.equal(frontierMixGenre({ genre: null, source_type: 'journal' }), 'paper')
  assert.equal(frontierMixGenre({ genre: 'not-a-genre', platform: 'x' }), 'social')
  assert.equal(frontierMixGenre({ flags: ['digest'], source_type: 'media' }), 'roundup')
  assert.equal(frontierMixSourceCap({ source_type: 'journal', authority: 5 }), 5)
  assert.equal(frontierMixSourceCap({ source_type: 'journal', authority: 4 }), 3)
  assert.equal(frontierMixSourceCap({ sourceType: 'media', authority: 5 }), 3)
})

test('merge rules: a roundup never; a news rewrite and an X post of a paper give way to it; a Chinese 解读 stands beside it', () => {
  const paper = { id: 'p', genre: 'paper', evidenceType: 'rct' }
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'roundup' }), { verdict: 'roundup', paperId: null })
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'news' }, [paper]), { verdict: 'paper-rewrite', paperId: 'p' })
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'social' }, [paper]), { verdict: 'paper-discussion', paperId: 'p' })
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'commentary', zh: true }, [paper]), { verdict: 'beside-paper', paperId: 'p' })
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'commentary', zh: false }, [paper]), { verdict: null, paperId: 'p' })
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'news' }, [{ id: 'r', genre: 'paper', evidenceType: 'review-opinion' }]),
    { verdict: null, paperId: null }, 'a review or an opinion piece is no paper a story rewrites')
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'news' }, [{ id: 'x', genre: 'preprint' }]).verdict, 'paper-rewrite')
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'industry' }, [paper]), { verdict: null, paperId: 'p' })
  // A news report stands beside its paper only once the paper is selected and the event's grouping call said it adds something.
  const selectedPaper = { ...paper, selected: true }
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'news', addsValue: true }, [selectedPaper]), { verdict: null, paperId: 'p' })
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'news', addsValue: true }, [paper]).verdict, 'paper-rewrite', 'never over an unselected paper')
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'news', addsValue: null }, [selectedPaper]).verdict, 'paper-rewrite', 'unjudged is a rewrite')
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'social', addsValue: true }, [selectedPaper]).verdict, 'paper-discussion', 'a post never')
  assert.deepEqual(frontierMixMergeVerdict({ genre: 'news' }, [{ id: 'q', genre: 'paper' }, { id: 's', genre: 'paper', selected: true }]).paperId, 's',
    'the selected paper is the one named')
})

test('the line is the bar: above it a group takes places to its ceiling; research is capped at 45 % of the day', () => {
  const research = Array.from({ length: 30 }, () => item({ genre: 'paper', score: 90 }))
  const result = frontierMixSelect({ candidates: research, threshold: 82 })
  // Thirty papers above the line make a day of 60 by research's ceiling (30 / 0.45 = 67, held at 60): 27 of them.
  assert.equal(result.plan.size, FRONTIER_MIX_DAY.max)
  assert.equal(result.plan.groups.research.ceiling, 27)
  assert.equal(result.picks.length, 27)
  assert.ok(result.picks.every((pick) => pick.rule === 'threshold' && pick.group === 'research'))
})

test('floors come from the medium band with a Chinese summary when a group is short above the line; a group with nothing is not padded', () => {
  const research = Array.from({ length: 12 }, () => item({ genre: 'paper', score: 90 }))
  const policyHigh = item({ genre: 'policy', score: 70, zh: true })
  const policyLow = item({ genre: 'policy', score: 59 })
  const policyBare = item({ genre: 'policy', score: 75, summarized: false })
  const result = frontierMixSelect({ candidates: [...research, policyHigh, policyLow, policyBare], threshold: 82 })
  // Twelve above the line: a day of 27 by research (12 / 0.45). Policy's floor is 2; one candidate is in the band.
  assert.equal(result.plan.size, 27)
  assert.equal(result.plan.groups.policy.floor, 2)
  assert.deepEqual(byRule(result)['genre-floor'], [policyHigh.id])
  assert.equal(result.plan.groups.guideline.after, 0, 'no guideline candidates: nothing else takes its places')
  assert.equal(result.picks.some((pick) => pick.id === policyLow.id || pick.id === policyBare.id), false)
})

test('news fills what the others leave of the day; a social group never passes 5 %', () => {
  const papers = Array.from({ length: 10 }, () => item({ genre: 'paper', score: 88 }))
  const news = Array.from({ length: 60 }, () => item({ genre: 'news', score: 86 }))
  const social = Array.from({ length: 10 }, () => item({ genre: 'social', score: 99 }))
  const result = frontierMixSelect({ candidates: [...papers, ...news, ...social], threshold: 82 })
  assert.equal(result.plan.size, 60)
  assert.equal(result.plan.groups.social.after, 3, '5 % of a day of 60')
  assert.equal(result.plan.groups.research.after, 10)
  assert.equal(result.plan.groups.news.after, 60 - 10 - 3)
  assert.equal(result.picks.length, 60)
})

test('the per-source cap binds every rule: three a day, five for an authority-5 journal, counting what is already selected', () => {
  const stream = Array.from({ length: 6 }, () => item({ sourceId: 'pubmed-stream', score: 95 }))
  const top = Array.from({ length: 7 }, () => item({ sourceId: 'nejm', sourceCap: 5, score: 95 }))
  const already = item({ sourceId: 'pubmed-stream', score: 95, selected: true, rule: 'threshold' })
  const result = frontierMixSelect({ candidates: [...stream, ...top, already], threshold: 82 })
  assert.equal(result.picks.filter((pick) => pick.id.startsWith('i') && stream.some((s) => s.id === pick.id)).length, 2)
  assert.equal(result.picks.filter((pick) => top.some((s) => s.id === pick.id)).length, 5)
})

test('a safety alert counts against nothing; an operator pin neither; a sticky selection counts against its group and is never returned', () => {
  const alerts = Array.from({ length: 5 }, () => item({ genre: 'safety', safety: true, selected: true, rule: 'safety-bypass', score: 40 }))
  const pin = item({ genre: 'social', selected: true, rule: 'operator-pin' })
  const stickySocial = item({ genre: 'social', selected: true, rule: 'threshold', score: 90 })
  const social = Array.from({ length: 4 }, () => item({ genre: 'social', score: 99 }))
  const papers = Array.from({ length: 9 }, () => item({ genre: 'paper', score: 88 }))
  const result = frontierMixSelect({ candidates: [...alerts, pin, stickySocial, ...social, ...papers], threshold: 82 })
  assert.equal(result.plan.groups.regulatory.before, 0, 'alerts are outside the groups')
  assert.equal(result.plan.groups.social.before, 1, 'the pin is not counted; the sticky selection is')
  // A day of 20 (held at the minimum): social's ceiling is 5 % of the 40-place reference, 2 — one taken already.
  assert.equal(result.plan.groups.social.ceiling, 2)
  assert.equal(result.picks.filter((pick) => pick.group === 'social').length, 1)
  assert.equal(result.picks.some((pick) => pick.id === stickySocial.id || alerts.some((a) => a.id === pick.id)), false)
})

test('a roundup is never selected, whatever its score', () => {
  const roundup = item({ genre: 'roundup', score: 100 })
  const result = frontierMixSelect({ candidates: [roundup], threshold: 82 })
  assert.deepEqual(result.picks, [])
  assert.deepEqual(result.excluded, [{ id: roundup.id, reason: 'roundup', paperId: null }])
})

test('a news rewrite and an X post of a paper are never selected; the paper takes the place from the band (event-primary)', () => {
  const paper = item({ genre: 'paper', score: 66, eventId: 'e1' })
  const rewrite = item({ genre: 'news', score: 92, eventId: 'e1' })
  const post = item({ genre: 'social', score: 99, eventId: 'e1' })
  // Enough papers above the line for research's floor, so the paper below it comes in only by the rewrite's place.
  const papers = Array.from({ length: 12 }, () => item({ genre: 'paper', score: 85 }))
  const events = { e1: [{ id: paper.id, genre: 'paper', evidenceType: 'rct' }, { id: rewrite.id, genre: 'news' }, { id: post.id, genre: 'social' }] }
  const result = frontierMixSelect({ candidates: [paper, rewrite, post, ...papers], threshold: 82, events })
  assert.equal(result.picks.some((pick) => pick.id === rewrite.id || pick.id === post.id), false)
  assert.deepEqual(byRule(result)['event-primary'], [paper.id])
  assert.deepEqual(result.excluded.map((entry) => [entry.id, entry.reason, entry.paperId]).sort(),
    [[rewrite.id, 'paper-rewrite', paper.id], [post.id, 'paper-discussion', paper.id]].sort())
  // Below the band the paper does not take the place, and the rewrite still gives way.
  const weak = item({ genre: 'paper', score: 50, eventId: 'e2' })
  const story = item({ genre: 'news', score: 92, eventId: 'e2' })
  const other = frontierMixSelect({ candidates: [weak, story], threshold: 82, events: { e2: [{ id: weak.id, genre: 'paper' }, { id: story.id, genre: 'news' }] } })
  assert.deepEqual(other.picks, [])
})

test('a Chinese 解读 of a paper may stand beside it although the event named another report it adds nothing to', () => {
  const paper = item({ genre: 'paper', score: 90, eventId: 'e', selected: true, rule: 'threshold' })
  const reading = item({ genre: 'commentary', zh: true, score: 84, eventId: 'e', besideSelected: true })
  const english = item({ genre: 'commentary', zh: false, score: 84, eventId: 'e', besideSelected: true })
  const events = { e: [{ id: paper.id, genre: 'paper' }, { id: reading.id, genre: 'commentary' }, { id: english.id, genre: 'commentary' }] }
  const result = frontierMixSelect({ candidates: [paper, reading, english], threshold: 82, events })
  assert.ok(result.picks.some((pick) => pick.id === reading.id))
  assert.equal(result.picks.some((pick) => pick.id === english.id), false, 'the one-selected-report rule stands for the rest')
})

test('under the Chinese share a Chinese item within the margin ranks higher, may come from under the line, and takes an English pick\'s place', () => {
  // A full day of research: thirty English papers at 84-89, and Chinese papers at 76 and 70.
  const english = Array.from({ length: 30 }, (_, index) => item({ genre: 'paper', score: 84 + (index % 6) }))
  const near = item({ genre: 'paper', zh: true, score: 76 })
  const far = item({ genre: 'paper', zh: true, score: 70 })
  const result = frontierMixSelect({ candidates: [...english, near, far], threshold: 82, ...OLD_SCALE })
  assert.ok(result.picks.some((pick) => pick.id === near.id && pick.rule === 'zh-target'))
  assert.equal(result.picks.some((pick) => pick.id === far.id), false, '12 under the line is past the margin')
  assert.equal(result.plan.groups.research.after, result.plan.groups.research.ceiling, 'it took a place, it did not add one')
  // At the target no preference is given: a Chinese item under the line stays out.
  const zhDay = [...Array.from({ length: 8 }, () => item({ genre: 'paper', zh: true, score: 90 })), ...Array.from({ length: 4 }, () => item({ genre: 'paper', score: 90 }))]
  const satisfied = frontierMixSelect({ candidates: [...zhDay, item({ genre: 'paper', zh: true, score: 78 })], threshold: 82, ...OLD_SCALE })
  assert.equal(satisfied.plan.rules['zh-target'] ?? 0, 0)
})

test('policy and commentary take Chinese first within the group', () => {
  const papers = Array.from({ length: 20 }, () => item({ genre: 'paper', score: 88 }))
  const englishPolicy = Array.from({ length: 6 }, () => item({ genre: 'policy', score: 95 }))
  const chinesePolicy = Array.from({ length: 3 }, () => item({ genre: 'policy', zh: true, score: 83 }))
  const result = frontierMixSelect({ candidates: [...papers, ...englishPolicy, ...chinesePolicy], threshold: 82 })
  const policyPicks = result.picks.filter((pick) => pick.group === 'policy').map((pick) => pick.id)
  for (const zh of chinesePolicy) assert.ok(policyPicks.includes(zh.id))
})

test('the preprint lane keeps two places inside the research group, from 60 with a Chinese summary', () => {
  const preprints = [item({ genre: 'preprint', score: 72 }), item({ genre: 'preprint', score: 65 }), item({ genre: 'preprint', score: 64 }),
    item({ genre: 'preprint', score: 59 })]
  const papers = Array.from({ length: 18 }, () => item({ genre: 'paper', score: 88 }))
  const result = frontierMixSelect({ candidates: [...papers, ...preprints], threshold: 82 })
  assert.deepEqual(byRule(result)['preprint-lane'].sort(), [preprints[0].id, preprints[1].id].sort())
})

test('in a congress week the research group may rise for conference reports only', () => {
  const papers = Array.from({ length: 27 }, () => item({ genre: 'paper', score: 90 }))
  const reports = Array.from({ length: 6 }, () => item({ genre: 'conference', score: 86 }))
  const quiet = frontierMixSelect({ candidates: [...papers, ...reports], threshold: 82 })
  const congress = frontierMixSelect({ candidates: [...papers, ...reports], threshold: 82, congressActive: true })
  assert.equal(quiet.picks.filter((pick) => pick.group === 'research').length, quiet.plan.groups.research.ceiling)
  assert.equal(congress.picks.filter((pick) => reports.some((r) => r.id === pick.id)).length, 3, '5 % of a day of 60')
})

test('unverified, retracted or demoted candidates (eligible: false) are never picked by any rule', () => {
  const bad = [item({ eligible: false, score: 99 }), item({ genre: 'policy', eligible: false, score: 70 }), item({ genre: 'paper', zh: true, eligible: false, score: 80 })]
  assert.deepEqual(ids(frontierMixSelect({ candidates: bad, threshold: 82 })), [])
})

test('the replay reads an export day by day: safety alerts in on both sides, roundups out, the Chinese share computed', () => {
  const day = '2026-10-22T04:00:00Z'
  const rows = [
    { public_id: 'a', source_id: 'nejm', source_type: 'journal', src_authority: 5, channel: 'journal', lang: 'en', score_total: 90, verification: 'passed', flags: [], selected: true, safety_alert: false, first_seen_at: day, published_at: day, event_id: 1 },
    { public_id: 'b', source_id: 'mx', source_type: 'media', channel: 'news', lang: 'en', score_total: 92, verification: 'passed', flags: [], selected: true, safety_alert: false, first_seen_at: day, published_at: day, event_id: 1 },
    { public_id: 'c', source_id: 'fda', source_type: 'regulator', channel: 'regulator', evidence_type: 'safety-notice', lang: 'en', score_total: 40, verification: 'passed', flags: [], selected: true, safety_alert: true, first_seen_at: day, published_at: day },
    { public_id: 'd', source_id: 'wx', source_type: 'media', platform: 'wechat', channel: 'wechat', lang: 'zh', score_total: 80, verification: 'passed', flags: [], selected: false, safety_alert: false, first_seen_at: day, published_at: day },
    { public_id: 'e', source_id: 'digest', source_type: 'media', channel: 'news', lang: 'en', score_total: 95, verification: 'passed', flags: ['digest'], selected: true, safety_alert: false, first_seen_at: day, published_at: day },
    // A week-old source date: its own day (the 72-hour rule).
    { public_id: 'f', source_id: 'old', source_type: 'journal', channel: 'journal', lang: 'en', score_total: 90, verification: 'passed', flags: [], selected: false, safety_alert: false, first_seen_at: day, published_at: '2026-10-14T04:00:00Z' },
  ]
  const [old, today] = frontierMixReplay(rows, { threshold: 82 })
  assert.equal(old.day, '2026-10-14')
  assert.equal(today.day, '2026-10-22')
  assert.deepEqual(today.before.groups, { research: 1, news: 1, regulatory: 1, roundup: 1 })
  assert.deepEqual(today.after.groups, { research: 1, regulatory: 1, commentary: 1 })
  assert.equal(today.after.zhShare, 0.333)
  assert.deepEqual(today.excluded, { 'paper-rewrite': 1, roundup: 1 })
  assert.equal(today.rules['safety-bypass'], 1)
})

test('a preprint under the line comes in only by the preprint lane, never by a floor, the Chinese share or a rewrite\'s place', () => {
  const preprints = Array.from({ length: 5 }, (_, index) => item({ genre: 'preprint', score: 75 - index, zh: index === 0 }))
  const story = item({ genre: 'news', score: 95, eventId: 'p' })
  const events = { p: [{ id: preprints[1].id, genre: 'preprint' }, { id: story.id, genre: 'news' }] }
  const result = frontierMixSelect({ candidates: [...preprints, story], threshold: 82, events })
  assert.deepEqual(result.picks.map((pick) => pick.rule), ['preprint-lane', 'preprint-lane'])
  assert.equal(result.plan.groups.research.floor, 7, 'the research floor stayed short rather than fill with preprints')
})

// ------------------------------------------------------------------------------------ genre floors (c2-fixes 2026-10-25)

test('a floor place under the line asks its genre\'s 80th percentile, held between 56 and the absolute 60 (the score of 2026-10-25)', () => {
  assert.deepEqual(FRONTIER_MIX_GENRE_FLOOR, { percentile: 0.8, min: 56, days: 30, minSample: 30 })
  assert.equal(FRONTIER_MIX_FLOOR_SCORE, 60)
  assert.equal(FRONTIER_MIX_ZH_MARGIN, 4)
  assert.equal(FRONTIER_MIX_PREPRINT_MIN_SCORE, 50)
  assert.equal(frontierMixGenreFloorScore(58), 58, 'a genre whose top fifth starts at 58 asks 58')
  assert.equal(frontierMixGenreFloorScore(41), 56, 'industry\'s top fifth is 41: it asks 56, never less, so an unfilled floor beats a junk pick')
  assert.equal(frontierMixGenreFloorScore(74), 60, 'a genre the editor scores high keeps the absolute floor: its top fifth would be above the line')
  assert.equal(frontierMixGenreFloorScore(undefined), 60, 'no percentile, no change')
  assert.equal(frontierMixGenreFloorScore(null), 60)
  assert.equal(frontierMixGenreFloorScore(Number.NaN), 60)
  assert.equal(frontierMixGenreFloorScore(52, 55, 45), 52, 'the minimum may be given')
  assert.equal(frontierMixGenreFloorScore(70, 55), 55, 'the absolute floor given is the ceiling of the genre\'s')
})

test('the genre percentiles are the SQL percentile_cont of each genre\'s published scores, weighted by the rows\' counts', () => {
  const industry = { source_type: 'company', channel: 'news', lane: 'pipeline' }
  const paper = { source_type: 'journal', channel: 'journal', lane: 'evidence' }
  // Industry: 1..100 once each is 80.2 at the 80th percentile (position 0.8 × 99 = 79.2 between ranks 80 and 81).
  const rows = [
    ...Array.from({ length: 100 }, (_, index) => ({ ...industry, score_total: index + 1 })),
    // Papers as grouped rows: 40 at 40, 30 at 50, 30 at 70 → the 80th percentile falls inside the 70s (position 79.2 of 100).
    { ...paper, score_total: 40, n: 40 }, { ...paper, score_total: 50, n: 30 }, { ...paper, score_total: 70, n: 30 },
    // Too few to say anything, a roundup (never selected), a row without a score, and a row that stands for nothing.
    ...Array.from({ length: 29 }, () => ({ source_type: 'regulator', channel: 'regulator', score_total: 70 })),
    ...Array.from({ length: 50 }, () => ({ source_type: 'media', channel: 'news', flags: ['digest'], score_total: 70 })),
    { ...paper, score_total: null }, { ...paper, score_total: 99, n: 0 },
  ]
  assert.deepEqual(frontierMixGenreFloors(rows), { industry: 80.2, paper: 70 })
  assert.deepEqual(frontierMixGenreFloors(rows, { percentile: 0.5 }), { industry: 50.5, paper: 50 })
  assert.deepEqual(frontierMixGenreFloors(rows, { minSample: 20 }).policy, 70, 'a smaller sample may be asked for')
  assert.deepEqual(frontierMixGenreFloors([]), {})
  // The editor's own genre column wins over code's fallback, as everywhere.
  assert.deepEqual(frontierMixGenreFloors(Array.from({ length: 30 }, (_, index) => ({ ...paper, genre: 'industry', score_total: index }))), { industry: 23.2 })
})

/** A day shaped like 2026-10-25: forty papers over the line and industry that the clinical score keeps in the 40s and 50s. */
function industryDay() {
  const papers = Array.from({ length: 40 }, () => item({ genre: 'paper', score: 88 }))
  const industry = [57, 56, 55, 54, 52, 50, 48, 46, 44, 40].map((score) => item({ genre: 'industry', zh: true, score }))
  return { papers, industry }
}

test('industry\'s floor is filled from its own genre\'s top fifth, not from the 60 the clinical score keeps it under', () => {
  const { papers, industry } = industryDay()
  const before = frontierMixSelect({ candidates: [...papers, ...industry], threshold: 82, ...OLD_SCALE })
  assert.equal(before.plan.size, 60)
  assert.equal(before.plan.groups.industry.floor, 4)
  assert.equal(before.plan.groups.industry.after, 0, 'before: nothing is 60 or more, the floor stays empty')
  assert.deepEqual(before.plan.genreFloors, {})
  // Industry's 80th percentile of the last 30 days is 52: a floor place asks 52.
  const after = frontierMixSelect({ candidates: [...papers, ...industry], threshold: 82, ...OLD_SCALE, genreFloors: { industry: 52, paper: 63 } })
  const scoreOf = (/** @type {string} */ id) => industry.find((c) => c.id === id)?.score ?? -1
  const picked = after.picks.filter((pick) => pick.group === 'industry')
  assert.deepEqual(picked.map((pick) => pick.rule), ['genre-floor', 'genre-floor', 'genre-floor', 'genre-floor'])
  assert.deepEqual(picked.map((pick) => scoreOf(pick.id)), [57, 56, 55, 54], 'best first, to the floor of 8 %')
  assert.deepEqual(after.plan.genreFloors, { industry: 52, paper: 60 }, 'what each place asked, said in the plan')
  // A percentile under 45 asks 45: the weakest industry items stay out whatever the genre\'s distribution.
  const low = frontierMixSelect({ candidates: [...papers, ...industry], threshold: 82, ...OLD_SCALE, genreFloors: { industry: 30 } })
  assert.equal(low.picks.filter((pick) => pick.group === 'industry').every((pick) => scoreOf(pick.id) >= 45), true)
  // The rest of the rules are unchanged: only a floor place reads the genre's bar.
  assert.deepEqual(frontierMixSelect({ candidates: [...papers, ...industry], threshold: 82, ...OLD_SCALE, genreFloors: {} }).picks, before.picks)
})

test('a genre floor lowers a bar for its own genre only, needs the Chinese summary, and leaves preprints and the line alone', () => {
  const papers = Array.from({ length: 40 }, () => item({ genre: 'paper', score: 88 }))
  const industry = [item({ genre: 'industry', score: 53, summarized: false }), item({ genre: 'industry', score: 53, eligible: false }), item({ genre: 'industry', score: 53 })]
  const policy = [item({ genre: 'policy', score: 53 })]
  const preprint = [item({ genre: 'preprint', score: 53 })]
  const result = frontierMixSelect({ candidates: [...papers, ...industry, ...policy, ...preprint], threshold: 82, ...OLD_SCALE, genreFloors: { industry: 50, preprint: 46 } })
  assert.deepEqual(result.picks.filter((pick) => pick.group === 'industry').map((pick) => pick.id), [industry[2].id],
    'a place needs a Chinese summary and an item that is eligible')
  assert.equal(result.picks.some((pick) => pick.id === policy[0].id), false, 'policy has no percentile of its own: it asks the 60')
  assert.equal(result.picks.some((pick) => pick.id === preprint[0].id), false, 'a preprint under the line comes in by the lane (60) only')
  // The line itself, the Chinese margin and the lane keep their numbers: an industry item of 70 under the line is not taken by it.
  const near = frontierMixSelect({ candidates: [...papers, item({ genre: 'industry', score: 70 })], threshold: 82, ...OLD_SCALE, genreFloors: { industry: 50 } })
  assert.deepEqual(near.picks.filter((pick) => pick.group === 'industry').map((pick) => pick.rule), ['genre-floor'], 'by the floor, as before')
})

test('the replay passes the genre floors to each day: the same export, industry in where the 60 kept it out', () => {
  const day = '2026-10-25T04:00:00Z'
  const row = (/** @type {string} */ id, /** @type {string} */ source, /** @type {string} */ type, /** @type {string} */ channel, /** @type {string} */ lane, /** @type {number} */ score, lang = 'zh') => ({ public_id: id, source_id: source, source_type: type, src_authority: 3, channel, lane,
    lang, score_total: score, verification: 'passed', flags: [], selected: false, safety_alert: false, first_seen_at: day, published_at: day })
  const rows = [
    ...Array.from({ length: 40 }, (_, index) => row(`p${index}`, `j${index}`, 'journal', 'journal', 'evidence', 88, 'en')),
    ...[57, 56, 55, 54, 52, 50, 48, 46].map((score, index) => row(`i${index}`, `c${index}`, 'company', 'news', 'pipeline', score)),
  ]
  const [without] = frontierMixReplay(rows, { threshold: 82, ...OLD_SCALE })
  // The percentile of this export's own industry scores (46..57, position 5.6 of 0..7) is 55.6; a replay may be given it.
  assert.equal(frontierMixGenreFloors(rows, { minSample: 8 }).industry, 55.6)
  const [withFloors] = frontierMixReplay(rows, { threshold: 82, ...OLD_SCALE, genreFloors: { industry: 52 } })
  assert.equal(without.after.groups.industry ?? 0, 0)
  assert.equal(withFloors.after.groups.industry, 4)
  assert.equal(withFloors.rules['genre-floor'], 4)
  assert.equal(withFloors.size, without.size, 'the day\'s size is the line\'s, not the floor\'s')
})

// ------------------------------------------------------------------------------------ one pick per event (c2-fixes 2026-10-25, G8)

/** @param {Array<[string, string, boolean?]>} members */
const eventOf = (members) => members.map(([id, genre, selected]) => ({ id, genre, evidenceType: null, selected: selected === true }))

test('one pick per event per round: two conference reports of one event, as in production\'s event 30447, give one place', () => {
  const papers = Array.from({ length: 2 }, () => item({ genre: 'paper', score: 88 }))
  const twins = [item({ genre: 'conference', score: 72, eventId: 'e30447' }), item({ genre: 'conference', score: 70, eventId: 'e30447' }),
    item({ genre: 'conference', score: 66, eventId: 'e30447' })]
  const others = [item({ genre: 'conference', score: 68, eventId: 'e2' }), item({ genre: 'conference', score: 65, eventId: 'e3' })]
  const events = { e30447: eventOf(twins.map((c) => [c.id, 'conference'])), e2: eventOf([[others[0].id, 'conference']]), e3: eventOf([[others[1].id, 'conference']]) }
  const result = frontierMixSelect({ candidates: [...papers, ...twins, ...others], threshold: 82, events })
  const picked = new Set(result.picks.map((pick) => pick.id))
  assert.deepEqual(twins.map((c) => picked.has(c.id)), [true, false, false], 'the best-ranked report of the event, once')
  assert.ok(picked.has(others[0].id) && picked.has(others[1].id), 'other events are not affected')
  assert.equal(result.plan.eventHeld, 2)
  // The same reports with no event take all three: it is the grouping that holds them.
  const loose = frontierMixSelect({ candidates: [...papers, ...twins.map((c) => ({ ...c, eventId: null })), ...others], threshold: 82 })
  assert.equal(twins.every((c) => loose.picks.some((pick) => pick.id === c.id)), true)
  assert.equal(loose.plan.eventHeld, 0)
})

test('an event that already has a selected item takes no pick, whatever put it there and however many it holds', () => {
  // Event 21842: one Paris court ruling, in Czech and in German, beside an earlier lane-floor pick.
  const earlier = item({ genre: 'industry', score: 61, selected: true, rule: 'lane-floor', eventId: 'e21842' })
  const czech = item({ genre: 'industry', zh: false, score: 58, eventId: 'e21842' })
  const german = item({ genre: 'industry', zh: false, score: 57, eventId: 'e21842' })
  const separate = item({ genre: 'industry', score: 56, eventId: 'e9' })
  const papers = Array.from({ length: 40 }, () => item({ genre: 'paper', score: 88 }))
  const events = { e21842: eventOf([[earlier.id, 'industry', true], [czech.id, 'industry'], [german.id, 'industry']]), e9: eventOf([[separate.id, 'industry']]) }
  const result = frontierMixSelect({ candidates: [...papers, earlier, czech, german, separate], threshold: 82, ...OLD_SCALE, events, genreFloors: { industry: 52 } })
  const picked = result.picks.map((pick) => pick.id)
  assert.equal(picked.includes(czech.id) || picked.includes(german.id), false)
  assert.ok(picked.includes(separate.id), 'an event of its own still has its place')
  // Event 25153: four selected, a fifth four days later (its other members are on other days: only `events` knows them).
  const late = item({ genre: 'paper', score: 95, eventId: 'e25153' })
  const history = eventOf([['a1', 'paper', true], ['a2', 'news', true], ['a3', 'news', true], ['a4', 'industry', true], [late.id, 'paper']])
  const fifth = frontierMixSelect({ candidates: [late, ...papers], threshold: 82, ...OLD_SCALE, events: { e25153: history } })
  assert.equal(fifth.picks.some((pick) => pick.id === late.id), false)
  assert.ok(fifth.plan.eventHeld >= 1)
})

test('an event\'s one pick is its paper, then the best-ranked report — the same whatever order the candidates come in', () => {
  const industry = Array.from({ length: 3 }, (_, index) => item({ id: `r${index}`, genre: 'industry', score: 58, eventId: 'e5' }))
  const events = { e5: eventOf(industry.map((c) => [c.id, 'industry'])) }
  const papers = Array.from({ length: 40 }, () => item({ genre: 'paper', score: 88 }))
  const picks = (/** @type {any[]} */ list) => frontierMixSelect({ candidates: [...papers, ...list], threshold: 82, events, genreFloors: { industry: 52 } })
    .picks.filter((pick) => pick.group === 'industry').map((pick) => pick.id)
  assert.deepEqual(picks(industry), ['r0'], 'a tie goes to the id')
  assert.deepEqual(picks([...industry].reverse()), ['r0'])
  assert.deepEqual(picks([industry[1], industry[2], industry[0]]), ['r0'])
  // A paper outranks a better-scored report of its event (the rewrite is excluded, the 解读 stands beside).
  const paper = item({ genre: 'paper', score: 70, eventId: 'e6' })
  const report = item({ genre: 'industry', score: 80, eventId: 'e6' })
  const both = frontierMixSelect({ candidates: [paper, report, ...papers], threshold: 82, genreFloors: { industry: 52 },
    events: { e6: eventOf([[paper.id, 'paper'], [report.id, 'industry']]) } })
  assert.equal(both.picks.some((pick) => pick.id === report.id), false, 'the event has its paper')
})

test('the exception: a Chinese 解读 of a selected paper stands beside it, a news report that "adds value" and an English one do not', () => {
  const paper = item({ genre: 'paper', score: 90, selected: true, rule: 'threshold', eventId: 'e' })
  const reading = item({ genre: 'commentary', zh: true, score: 84, eventId: 'e' })
  const english = item({ genre: 'commentary', zh: false, score: 90, eventId: 'e' })
  const story = item({ genre: 'news', score: 95, eventId: 'e', addsValue: true })
  const events = { e: eventOf([[paper.id, 'paper', true], [reading.id, 'commentary'], [english.id, 'commentary'], [story.id, 'news']]) }
  const result = frontierMixSelect({ candidates: [paper, reading, english, story], threshold: 82, events })
  assert.deepEqual(result.picks.map((pick) => pick.id), [reading.id])
  // The paper and its 解读 in the same round: both, whichever the order.
  const fresh = item({ genre: 'paper', score: 90, eventId: 'f' })
  const note = item({ genre: 'commentary', zh: true, score: 84, eventId: 'f' })
  const members = { f: eventOf([[fresh.id, 'paper'], [note.id, 'commentary']]) }
  for (const order of [[fresh, note], [note, fresh]]) {
    assert.deepEqual(frontierMixSelect({ candidates: order, threshold: 82, events: members }).picks.map((pick) => pick.id).sort(), [fresh.id, note.id].sort())
  }
  // A 解读 whose paper is neither selected nor a candidate competes like any other report of the event.
  const alone = item({ genre: 'commentary', zh: true, score: 90, eventId: 'g' })
  const other = item({ genre: 'commentary', zh: true, score: 85, eventId: 'g' })
  const older = frontierMixSelect({ candidates: [alone, other], threshold: 82,
    events: { g: eventOf([['p-old', 'paper'], [alone.id, 'commentary'], [other.id, 'commentary']]) } })
  assert.equal(older.picks.length >= 1, true)
})

test('the replay of a day with events holds one pick per event and leaves the rest of the day as it was', () => {
  const day = '2026-10-24T04:00:00Z'
  const row = (/** @type {string} */ id, /** @type {string} */ genre, /** @type {number} */ score, /** @type {number | null} */ event) => ({
    public_id: id, source_id: `s-${id}`, source_type: 'media', channel: 'news', genre, lang: 'zh', score_total: score, verification: 'passed',
    flags: [], selected: false, safety_alert: false, first_seen_at: day, published_at: day, event_id: event })
  const rows = [
    row('n1', 'news', 90, 30447), row('n2', 'news', 89, 30447), row('n3', 'news', 88, 30447),
    row('n4', 'news', 87, 41), row('n5', 'news', 86, 42), row('n6', 'news', 85, 43),
    row('i1', 'industry', 85, 21842), row('i2', 'industry', 84, 21842),
  ]
  const [replayed] = frontierMixReplay(rows, { threshold: 82 })
  assert.equal(replayed.after.groups.news, 4, 'one report of the event with three and three events of their own')
  assert.equal(replayed.after.groups.industry, 1, 'the event with two holds one')
  assert.equal(replayed.after.total, 5)
  const ungrouped = frontierMixReplay(rows.map((entry) => ({ ...entry, event_id: null })), { threshold: 82 })[0]
  assert.deepEqual([ungrouped.after.groups.news, ungrouped.after.groups.industry], [6, 2], 'without the grouping the day takes them all')
})
