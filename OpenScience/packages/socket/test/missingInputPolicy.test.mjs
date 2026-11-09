import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGuidanceText } from '../src/guidanceText.mjs'

test('unattended work distinguishes routine defaults from absent research inputs', () => {
  const text = buildGuidanceText([], { askUserEnabled: false, capsuleActive: false, reviewEnabled: false })
  assert.match(text, /排版等一般选择可采用合理默认值/)
  assert.match(text, /缺少必要文件、数据或计算参数/)
  assert.match(text, /回复所需信息及原因，结束本轮/)
  assert.match(text, /用户明确要求假设演示时，可以模拟/)
  assert.doesNotMatch(text, /按最合理的假设做完/)
})

test('an unanswered attended question cannot authorize fabricated data', () => {
  const text = buildGuidanceText([], { askUserEnabled: true, capsuleActive: false, reviewEnabled: false })
  assert.match(text, /已有输入的部分照常完成/)
  assert.match(text, /列出所需信息，不补造/)
})
