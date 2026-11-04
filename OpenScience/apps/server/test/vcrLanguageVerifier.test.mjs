import assert from 'node:assert/strict';
import test from 'node:test';
import { createVcrLanguageSourceVerifier } from '../src/vcrLanguageVerifier.mjs';

test('source verifier requires all current authorized documents and exact UTF-16 evidence', async () => {
  const h='a'.repeat(64), rows=[{id:'d1',sourceId:'src1'}];
  let withdrawn=false, revoked=false, changed=false;
  const dataPlane={listDocuments:async()=>rows,store:{getSourceFile:async()=>({sourceId:'src1',detail:{subjectKey:'p1'}})},
    projectionText:async()=>{if(revoked)throw new Error('revoked');return {id:'d1',subjectKey:'p1',sourceHash:changed?'b'.repeat(64):h,projectionHash:null,projectionId:null,text:'A🧬B',visibleAt:null};}};
  const verify=createVcrLanguageSourceVerifier({dataPlane,matchStore:{withdrawnSubjects:async()=>new Set(withdrawn?['p1']:[])}});
  const request={studyId:'s1',userId:'u1',subjectKey:'p1',documents:[{id:'d1',sourceId:'src1',sourceHash:h,projectionHash:null,projectionId:null}],
    evidence:[{documentId:'d1',start:1,end:3,quote:'🧬',visibleAt:null}]};
  assert.equal(await verify(request),true);
  assert.equal(await verify({...request,evidence:[{...request.evidence[0],end:2}]}),false);
  rows.push({id:'d2',sourceId:'src2'});assert.equal(await verify(request),false);rows.pop();
  changed=true;assert.equal(await verify(request),false);changed=false;
  revoked=true;assert.equal(await verify(request),false);revoked=false;
  withdrawn=true;assert.equal(await verify(request),false);
});
