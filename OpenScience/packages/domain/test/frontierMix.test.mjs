import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRONTIER_GENRES,
  FRONTIER_MIX_COUNTED_RULES,
  FRONTIER_MIX_DAY,
  FRONTIER_MIX_GROUP_ORDER,
  FRONTIER_MIX_GROUPS,
  FRONTIER_MIX_NEVER,
  FRONTIER_MIX_RULES,
  FRONTIER_MIX_ZH_TARGET,
  frontierMixGenre,
  frontierMixGroup,
  frontierMixMergeVerdict,
  frontierMixReplay,
  frontierMixSelect,
  frontierMixSourceCap,
} from '../index.mjs'

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
  const result = frontierMixSelect({ candidates: [...english, near, far], threshold: 82 })
  assert.ok(result.picks.some((pick) => pick.id === near.id && pick.rule === 'zh-target'))
  assert.equal(result.picks.some((pick) => pick.id === far.id), false, '12 under the line is past the margin')
  assert.equal(result.plan.groups.research.after, result.plan.groups.research.ceiling, 'it took a place, it did not add one')
  // At the target no preference is given: a Chinese item under the line stays out.
  const zhDay = [...Array.from({ length: 8 }, () => item({ genre: 'paper', zh: true, score: 90 })), ...Array.from({ length: 4 }, () => item({ genre: 'paper', score: 90 }))]
  const satisfied = frontierMixSelect({ candidates: [...zhDay, item({ genre: 'paper', zh: true, score: 78 })], threshold: 82 })
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
