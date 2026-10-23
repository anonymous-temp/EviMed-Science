import assert from 'node:assert/strict';
import test from 'node:test';
import {buildJudgeInput,verifyJudgement,factsOf} from '../src/geoJudge.mjs';
const input=text=>({owner:{userId:'u',projectId:'p'},product:{brandName:'Brand'},competitors:[],claims:[],careFlags:[],question:{text:'Question',pool:'P2'},answer:text,links:[]});
const result=(text,extra={})=>{const source=input(text);return verifyJudgement({assessmentComplete:true,statements:[],clinicalApplicability:{schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'not_applicable',quote:text,reason:'Only a navigation instruction; no clinical assertion.'},...extra},buildJudgeInput(source),source);};
test('an explicit grounded complete no-clinical-assertion assessment is preserved inside checks',()=>{
 const judged=result('Open the help menu.');assert.equal(judged.checks.clinicalApplicability.status,'not_applicable');assert.equal(judged.checks.clinicalApplicability.validated,true);
 const {facts}=factsOf({snapshot:{id:'s',answerText:'Open the help menu.',citations:[]},judged,registry:{},countedOwned:{},at:new Date(),claims:[]});assert.deepEqual(facts.checks.clinicalApplicability,judged.checks.clinicalApplicability);
});
test('partial, refusal, omitted or invalid extraction and ungrounded applicability stay unknown',()=>{
 for(const extra of [{assessmentComplete:false},{refusal:true},{statements:[{text:'Invented',verdict:'correct'}]},{clinicalApplicability:{schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'not_applicable',quote:'Not present',reason:'Unknown'}},{statements:null}])assert.equal(result('Open the help menu.',extra).checks.clinicalApplicability.status,'unknown');
});
test('claimless clinical content, wrong population and safe nonrecommendation remain applicable clinical assertions',()=>{
 for(const text of ['Children should take this medicine.','This medicine treats condition X.','Do not take it if you are allergic.']) {
 const judged=result(text,{statements:[{text,topic:'other',verdict:'unverifiable',claim:null}]});assert.equal(judged.checks.clinicalApplicability.status,'unknown');assert.equal(judged.statements[0].verdict,'unverifiable');
 }
});
test('legacy records never receive inferred clinical applicability',()=>{
 const source=input('Legacy answer');const judged=verifyJudgement({assessmentComplete:true,statements:[]},buildJudgeInput(source),source);assert.equal(judged.checks.clinicalApplicability.status,'unknown');
});
