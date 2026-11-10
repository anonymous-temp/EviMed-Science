import assert from 'node:assert/strict';
import test from 'node:test';
import { IDENTIFIER_MASK, maskIdentifiers } from '@evimed/domain';
import { filterCapturedMessage } from '../src/memoryGateway.mjs';
import { secretHash, secretFilter, filterSecretValue, createHistorySecretJudge } from '../src/memoryHistorySecrets.mjs';

const filter = secrets => secretFilter('account-random-salt',secrets.map(text=>({length:text.length,fingerprint:secretHash('account-random-salt',text)})));

test('fast: exact credentials only, repeated spans, Chinese and English, similar numbers and contact details survive', () => {
  const redact = filter(['晚风 orange 73','673921']);
  assert.equal(redact('我邮箱的密码是晚风 orange 73；再说一次晚风 orange 73。'),`我邮箱的密码是${IDENTIFIER_MASK}；再说一次${IDENTIFIER_MASK}。`);
  assert.equal(redact('My code is 673921; invoice 673922, telephone 13812345678 and a@example.org.'),`My code is ${IDENTIFIER_MASK}; invoice 673922, telephone 13812345678 and a@example.org.`);
  assert.equal(redact('6739210 0673921 13867392178'), '6739210 0673921 13867392178');
  assert.equal(redact('Orange 73, 晚风 orange 74, ordinary prose.'),'Orange 73, 晚风 orange 74, ordinary prose.');
  assert.equal(filter(['abc','bcd'])('abcde'),`${IDENTIFIER_MASK}e`);
  assert.equal(filter(['ab'])('abab'),IDENTIFIER_MASK.repeat(2));
  assert.equal(secretFilter('other-account',[{length:6,fingerprint:secretHash('account-random-salt','673921')}])('673921'),'673921');
});

test('structured values and escaped JSON text blocks are filtered without changing unrelated bytes', () => {
  const secret = 'quote"slash\\雪';
  const json = JSON.stringify({ abstract:secret, nested:[secret], number:42 });
  const output = filterSecretValue({content:[{type:'text',text:json},{type:'text',text:`密码是 ${secret}`}],number:42},filter([secret]));
  assert.equal(JSON.parse(output.content[0].text).abstract,IDENTIFIER_MASK);
  assert.equal(output.content[1].text,`密码是 ${IDENTIFIER_MASK}`);
  assert.equal(output.number,42);
  assert.equal(JSON.parse(filterSecretValue(JSON.stringify(secret),filter([secret]))),IDENTIFIER_MASK);
  assert.equal(filterSecretValue(' { "ordinary": 1 } ',filter([])),' { "ordinary": 1 } ');
});

const config = {deepseekApiKey:'fake',deepseekModel:'stub-model',memoryHistorySecretRedactionDailyCalls:1};
const request = {userId:'u',projectId:'p',messages:[{role:'user',text:'Use sunset river 19 to sign in.'}]};
const answer = (content,finish_reason='stop') => ({choices:[{finish_reason,message:{content}}]});

test('judge uses the model on all language, validates exact user spans and enforces its daily budget', async () => {
  let calls=0;
  const judge = createHistorySecretJudge({config,callModel:async(_deps,call)=>{
    calls++; assert.equal(call.purpose,'memory-extraction');assert.equal(call.body.thinking.type,'disabled');
    assert.match(call.body.messages[0].content,/not a closed list/);
    return answer('{"secrets":["sunset river 19"]}');
  }});
  assert.deepEqual(await judge.identify(request),['sunset river 19']);
  await assert.rejects(judge.identify(request),/secret_review_unavailable/);assert.equal(calls,1);
});

test('failure, truncation, malformed JSON and invented or assistant-only strings never certify an archive', async () => {
  for (const body of [answer('{'),answer('{}'),answer('{"secrets":["invented"]}'),answer('{"secrets":[]}','length'),answer('{"secrets":[""]}')]) {
    const judge=createHistorySecretJudge({config,callModel:async()=>body});
    await assert.rejects(judge.identify(request),/secret_review_unavailable/);
  }
  const failed=createHistorySecretJudge({config,callModel:async()=>{throw new Error('do not expose provider response');}});
  await assert.rejects(failed.identify(request),/^Error: memory_history_secret_review_unavailable$/);
  const empty=createHistorySecretJudge({config,callModel:async()=>answer('{"secrets":[]}')});
  assert.deepEqual(await empty.identify(request),[]);
});


test('semantic mode preserves complete credential spans for the model while code still masks shapes', () => {
  const sentence='My password is amber river 72; 密码是晚风 清水。 OTP 673921';
  assert.equal(maskIdentifiers(sentence,{shapesOnly:true}),sentence);
  assert.notEqual(maskIdentifiers(sentence),sentence,'legacy default is unchanged');
  assert.equal(filterCapturedMessage({role:'user',content:sentence},{semanticSecrets:true}).forward.parts[0].text,sentence);
  assert.match(maskIdentifiers('key '+['sk','abcdefghijklmnopqrstuv123456'].join('-'),{shapesOnly:true}),/已省略/);
});
