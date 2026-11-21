// Replay the recorded replies as prior assistant messages. The judge output is used
// only by this test; the product receives the remembered layout and the new request.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bindStatementSources, statementSource } from '../../../apps/server/src/memoryStatementSources.mjs';
import { sourceBoundRequest } from '../../../apps/server/src/memorySourceEnvelope.mjs';
import { instructionSourceMessage } from '../../../apps/server/src/nativeMemoryInstructionOrigin.mjs';
import { renderMemoryContext } from '../../../apps/server/src/researchContext.mjs';

const dataset = new URL('../../remembered-format/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, dataset), 'utf8'));
const { cases } = await read('cases.json');
const { cells } = await read('results/2026-10-25-current+pre-1025+conditional-method-deepseek-flash.json');
const selected = ['weekly-report','monthly-report','meeting-minutes','paper-abstract','resume-paragraph','group-meeting',
  'lab-notes','training-summary','quarterly-review','release-notes','weekly-plan','status-update'];

for (const id of selected) test('recorded full and partial replies supply no defaults for ' + id, () => {
  const spec = cases.find(c => c.id === id);
  const text = spec.memory.at(-1).text.split('\n')[0].replace(/^- /, '');
  const original = instructionSourceMessage({role:'user',content:text});
  const quote = text.split('「')[0].trim();
  const receipt = bindStatementSources(JSON.stringify({rows:[{line:0,kind:'user_statement',subject:'self',
    message:0,quote,conditions:'preserved',layoutFields:spec.places}]}),[{text}],[original]);
  const source = statementSource(text,{statementSource:receipt.get(0)});
  assert.deepEqual(source.layout.map(entry => entry.field),spec.places);
  const memo = renderMemoryContext([{ id:'layout', content:text, sourceEnvelope:source }],{ sourceBound:true });
  for (const variant of ['full','partial']) {
    const archived = cells.find(c => c.arm === 'current' && c.case === id && c.variant === variant && c.sample === 0);
    const { messages } = sourceBoundRequest({ messages:[
      {role:'user',content:memo}, {role:'assistant',content:archived.reply}, {role:'user',content:spec[variant].ask}] });
    assert.equal(JSON.parse(messages[2].content).text,archived.reply);
    assert.equal(JSON.parse(messages[2].content).source.kind,'assistant_statement');
    const current = JSON.parse(messages[3].content);
    assert.equal(current.text ?? current.parts.map(p => p.text).join(''),spec[variant].ask);
    for (const field of source.layout) assert.deepEqual([field.value,field.source,field.missing],[null,null,'未提供/未知']);
    if (variant === 'partial') {
      for (const field of spec.partial.missing) assert.ok(source.layout.some(row => row.field === field));
      if (id === 'release-notes') {
        assert.equal(archived.judge.places['影响范围'],'filled_without_source');
        assert.ok(archived.judge.added.some(finding => archived.reply.includes(finding.quote)));
      }
    }
  }
});
