import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {assessSubject} from '/tmp/evimed-integration-20261010/OpenScience/apps/server/src/vcrMatching.mjs';
const dir='/tmp/evimed-integration-20261010/OpenScience/.r/users/integrationlocal/projects/model-vcr-final/workspace/skill-closure/vcr-isolated/';
const bytes=fs.readFileSync(dir+'engine-input.json');const input=JSON.parse(bytes);
const expected={C1:'satisfied',C2:'not_satisfied',C3:'unknown',C4:'satisfied'};
const results=input.subjects.map(subject=>({source:subject.subjectKey,assessment:assessSubject({asOf:input.asOf,criteria:input.criteria.map((criterion,index)=>({...criterion,id:criterion.id||'audit-criterion-'+index})),documents:input.documents,...subject,facts:subject.facts.map((fact,index)=>({...fact,id:fact.id||'audit-fact-'+subject.subjectKey+'-'+index}))})}));
const failures=[];
for(const item of results){const judgment=item.assessment.judgments.find(j=>j.kind==='exclusion');try{assert.equal(judgment?.state,expected[item.source]);assert.equal(item.assessment.voidedFacts.length,0);assert.equal(item.assessment.summary,item.source==='C2'?'ineligible':'insufficient_evidence');}catch(e){failures.push({source:item.source,message:e.message});}}
const walk=n=>{if(!n||typeof n!=='object')return;assert.notEqual(n.op,'elapsed_since');assert.equal(n.window,undefined);for(const x of Object.values(n))walk(x)};
try{assert.equal(results.length,4);const protocol=JSON.parse(fs.readFileSync(dir+'protocol.json'));assert.deepEqual(input.criteria.map(c=>c.requirement),protocol.criteria.map(c=>c.requirement));for(const c of input.criteria)walk(c.requirement);}catch(e){failures.push({criterion:e.message});}
const record={observedAt:new Date().toISOString(),method:'actual current assessSubject using generated clinical criteria/facts unchanged; assign only audit-local stable IDs normally assigned by platform ingestion, no study registration or platform-issued ID claim',inputSha256:crypto.createHash('sha256').update(bytes).digest('hex'),passed:failures.length===0,failures,results};
fs.writeFileSync('/tmp/evimed-release-closure-20261010/skills/vcr-isolated/actual-matcher.json',JSON.stringify(record,null,2));console.log(JSON.stringify({passed:record.passed,failures,summaries:results.map(r=>({source:r.source,summary:r.assessment.summary,judgments:r.assessment.judgments.map(j=>({kind:j.kind,state:j.state})),voided:r.assessment.voidedFacts}))},null,2));if(failures.length)process.exitCode=1;
