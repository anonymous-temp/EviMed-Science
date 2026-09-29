// Where a run is told to answer what the reviewer could not find. The report
// is the reader's; an item about the package itself — its files, its fields,
// whether its numbers equal its artifacts, whether a checklist item applies —
// is answered in revision-notes.md. 「补上，或在报告里说明不适用」 and an
// acceptance field asking for 「交付文件里能核对到的具体内容」 put 验收项对照
// sections, number-provenance tables and unmade conflict-of-interest statements
// into eight of nineteen accepted capabilities' reports (quality classes
// 2026-09-29, C1).
import assert from 'node:assert/strict'
import test from 'node:test'

import { reviewIssues } from '../src/review.mjs'
import { planToolParameters } from '../src/runPolicy.mjs'

test('an absent checklist item or an unmet acceptance item is answered in revision-notes.md, never in a section of the report', () => {
  const issues = reviewIssues(/** @type {any} */ ({
    reviewId: 'rv_1',
    findings: [],
    checklist: { present: 3, absent: ['S8', 'P26'], unlocated: [] },
    acceptance: { met: ['A1'], unmet: ['A6', 'A10'], unlocated: [] },
  }))
  const absent = issues.find((issue) => issue.message.includes('S8'))
  const unmet = issues.find((issue) => issue.message.includes('A6'))
  assert.ok(absent && unmet, JSON.stringify(issues))
  for (const issue of [absent, unmet]) {
    assert.equal(issue.severity, 'advisory')
    assert.match(issue.message, /revision-notes\.md/)
  }
  assert.doesNotMatch(absent.message, /在报告里说明/)
  assert.match(absent.message, /不代人声明/, 'a conflict-of-interest or funding statement is not the run\'s to make')
  assert.match(unmet.message, /不在报告里另立小节/)
})

test('the plan asks for acceptance items a reader can check in the report, not items about the package', () => {
  const description = String(planToolParameters().deliverables.items.properties.acceptance.description)
  assert.match(description, /读者在报告正文里能核对/)
  assert.match(description, /不写关于文件清单、字段、哈希或检查过程的项/)
})
