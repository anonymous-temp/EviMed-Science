import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { frontierSourcedInterests } from '../src/frontierSourcedInterests.mjs';

test('only the public topic of a proven personal interest can supply a ranking reason', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../evals/frontier-follows/cases.json',import.meta.url), 'utf8'));
  const drug = fixture.cases.find(row => row.answer.kind === 'drug');
  const topic = drug.typed, key = 'drug:' + drug.answer.concepts[0].en[0].toLowerCase();
  const file = {type:'notes',uri:'private-source',body:'private note'};
  const source = {id:file.uri,contentDigest:'revision1'};
  const files = [file,{...file,projectId:'private-project'},{...file,type:'people'},{...file,namespaceId:'shared'},{...file,sensitive:true}];
  const ownedLines = async (userId, selected, classify) => {
    assert.equal(userId,'reader'); assert.deepEqual(selected,[file]);
    return [`我关注${topic}。`, '我关注私人同事。', `我对${topic}。`, `项目甲关注${topic}。`]
      .filter(classify).map(quote=>({quote,source})).concat([{quote:'我关注肿瘤学。',source,projectId:'private-project'}]);
  };
  const vocabulary = {keysForText:async({texts})=>texts[0]===topic?[key]:['person:private'],describe:async()=>[{key,label:topic}]};
  const read = () => frontierSourcedInterests({userId:'reader',files,ownedLines,vocabulary});
  const [reason] = await read(); assert.equal((await read()).length,1);
  assert.equal(reason.text,topic); assert.match(reason.memoryId,/^interest:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(reason),/private|我关注|revision1/);
  source.contentDigest='revision2'; assert.notEqual((await read())[0].memoryId,reason.memoryId);
  assert.deepEqual(await frontierSourcedInterests({userId:'reader',files,ownedLines:async()=>[],vocabulary}),[]);
});
