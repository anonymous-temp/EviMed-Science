import assert from 'node:assert/strict'
import test from 'node:test'

import { BLANK_EXAMPLES, CAPABILITY_DISPLAY, GENERAL_TOOL_GROUP, GENERAL_TOOLS, PROFESSIONAL_TOOL_GROUP } from '../index.mjs'

const CJK = /[㐀-鿿]/
/** The words that would make a general tool read as a medical one; a closed list, because this guards data, not language. */
const MEDICAL = /医学|临床|药|患者|病|循证|PubMed|研究/

test('the two groups are named and are not the same', () => {
  assert.equal(GENERAL_TOOL_GROUP, '通用')
  assert.equal(PROFESSIONAL_TOOL_GROUP, '医学专业')
})

test('every general tool is a Chinese name, one sentence and at least one sentence to start from', () => {
  assert.equal(new Set(GENERAL_TOOLS.map((tool) => tool.id)).size, GENERAL_TOOLS.length)
  assert.deepEqual(GENERAL_TOOLS.map((tool) => tool.title), ['文档', '表格', '幻灯片', '数据分析', '网页调研', '代码'])
  for (const tool of GENERAL_TOOLS) {
    assert.ok(CJK.test(tool.title) && CJK.test(tool.description), `${tool.id} is written in Chinese`)
    assert.ok(tool.description.endsWith('。') && !tool.description.slice(0, -1).includes('。'), `${tool.id} is one sentence`)
    assert.ok(tool.starterPrompts.length >= 1 && tool.starterPrompts.every((line) => line.length <= 400), `${tool.id} has starters that fit a composer`)
    assert.ok(!MEDICAL.test(`${tool.title}${tool.description}${tool.starterPrompts.join('')}`), `${tool.id} presumes no medical domain`)
    assert.ok(!Object.hasOwn(CAPABILITY_DISPLAY, tool.id), `${tool.id} is not a capability id: a general tool binds nothing`)
  }
})

test('the blank conversation offers four to six pills, general ones first and two medical ones last', () => {
  assert.ok(BLANK_EXAMPLES.length >= 4 && BLANK_EXAMPLES.length <= 6)
  const medical = BLANK_EXAMPLES.filter((example) => MEDICAL.test(`${example.label}${example.draft}`) || /SGLT2|他汀/.test(example.draft))
  assert.equal(medical.length, 2)
  assert.deepEqual(BLANK_EXAMPLES.slice(-2), medical, 'the medical pills come after the general ones')
  for (const example of BLANK_EXAMPLES) {
    assert.ok(CJK.test(example.label) && example.label.length <= 8, `${example.label} is short enough for a pill`)
    assert.ok(example.draft.length > example.label.length && example.draft.length <= 400)
  }
  assert.equal(new Set(BLANK_EXAMPLES.map((example) => example.label)).size, BLANK_EXAMPLES.length)
})

test('a medical pill is a starter prompt one of the capabilities offers, so it names something the platform does', () => {
  const offered = new Set(Object.values(CAPABILITY_DISPLAY).flatMap((display) => display.starterPrompts))
  for (const example of BLANK_EXAMPLES.slice(-2)) assert.ok(offered.has(example.draft), `${example.label} is not a capability's starter`)
})
