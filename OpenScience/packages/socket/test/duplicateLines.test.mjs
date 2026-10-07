import test from 'node:test'
import assert from 'node:assert/strict'
import { collapseDuplicateLines, compactCommandResult } from '../src/duplicateLines.mjs'
import { screeningPrompt } from '../src/screening.mjs'

test('consecutive exact logs collapse at three, preserving whitespace, empty lines and separated repeats', () => {
  assert.equal(collapseDuplicateLines('a\na\na\nb\na\na\n\n\n\n'), 'a\n(重复 3 次)\nb\na\na\n\n\n\n')
  assert.equal(collapseDuplicateLines('a\n a\na'), 'a\n a\na')
})
test('research tools and structured data never undergo log reduction', () => {
  const raw = {content:[{type:'text',text:'1\n1\n1'}]}
  assert.equal(compactCommandResult('pubmed_search', raw), raw)
  assert.equal(compactCommandResult('bash', raw, {command:'cat data.csv'}), raw)
  const structured = {...raw, structuredContent:{rows:[1,1,1]}}
  assert.equal(compactCommandResult('bash', structured), structured)
  assert.equal(compactCommandResult('bash', raw, {command:'pytest'}).content[0].text, '1\n(重复 3 次)')
})
test('screening moves insufficient abstracts to full text rather than excludes them', () => {
  const prompt = screeningPrompt('Adults', [{id:'a',title:'Trial'}])
  assert.match(prompt, /没有明确违反标准时给 include/)
  assert.match(prompt, /unclear 也进入全文核对/)
})

 test('canonical bash stream values survive DSH success normalization', () => {
  const value = {kind:'completed',stdout:{text:'same\nsame\nsame\n',truncated:false},stderr:{text:'',truncated:false},exitCode:0}
  const result = compactCommandResult('bash', {isError:false,value,content:[{type:'text',text:value.stdout.text}]}, {command:'npm test'})
  assert.equal(result.value.stdout.text,'same\n(重复 3 次)\n')
  assert.equal(result.value.exitCode,0)
  assert.equal(result.value.stdout.truncated,false)
  assert.equal(value.stdout.text,'same\nsame\nsame\n')
 })
