import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPatientMatchingKnowledge} from '../src/patientMatchingKnowledge.mjs';
test('knowledge cites preserved bytes, intersects conversation selection and invalidates changed generations',async()=>{
  let generation=1;const origin={userId:'owner',projectId:'project'};const source={projectId:'project',payload:{status:'complete',generation,analysis:{textSha256:'hash'}}};
  const knowledge=createPatientMatchingKnowledge({sourceScope:async()=>['source-a'],sources:{get:async()=>({...source,payload:{...source.payload,generation}}),loadCapture:async()=>({input:{text:'Stage II disease is defined by preserved evidence.'}})},index:{search:async()=>({hits:[{sourceId:'source-a',start:0,end:16}]})}});
  const result=await knowledge({origin,input:{query:'Stage II'}});assert.equal(result.data.passages[0].text,'Stage II disease');
  await knowledge.refresh({origin,passages:result.data.passages});generation++;
  await assert.rejects(knowledge.refresh({origin,passages:result.data.passages}),{code:'patient_matching_knowledge_changed'});
  await assert.rejects(knowledge({origin,input:{sourceId:'foreign'}}),{code:'patient_matching_knowledge_changed'});
});

test('compiled pages cannot become clinical evidence through search or an explicit source id',async()=>{
 const source={projectId:'project',payload:{status:'complete',generation:1,paths:['knowledge-base/wiki/index.md'],analysis:{textSha256:'hash'}}};
 const knowledge=createPatientMatchingKnowledge({sourceScope:async()=>null,sources:{get:async()=>source,loadCapture:async()=>{throw new Error('compiled text must not be read as evidence');}},index:{search:async()=>({hits:[{sourceId:'wiki',compiled:true}]})}});
 for(const input of [{query:'stage'}, {sourceId:'wiki'}]){const value=await knowledge({origin:{userId:'owner',projectId:'project'},input});assert.equal(value.data.passages.length,0);assert.ok(value.data.limitations.length);}
});

test('small-library paraphrases can reach late sections and explicit verified cursors read all remaining text',async()=>{
 const text=('Irrelevant introduction. '.repeat(400))+'\n\nA clinical stage is determined by tumor spread and lymph node involvement.';
 const knowledge=createPatientMatchingKnowledge({sourceScope:async()=>null,sources:{get:async()=>({projectId:'project',payload:{status:'complete',generation:1,analysis:{textSha256:'hash'}}}),loadCapture:async()=>({input:{text}})},index:{search:async()=>({mode:'small-library',files:[{sourceId:'source'}]})}});
 const origin={userId:'owner',projectId:'project'},found=await knowledge({origin,input:{taskId:'task',query:'How is clinical stage determined?',limit:1}});
 assert.match(found.data.passages[0].text,/tumor spread/);assert.ok(found.data.passages[0].span.start>1800);
 const page=await knowledge({origin,input:{taskId:'task',sourceId:'source',offset:9500,maxChars:1000,limit:1}});assert.equal(page.data.passages[0].text,text.slice(9500,10500));
});
