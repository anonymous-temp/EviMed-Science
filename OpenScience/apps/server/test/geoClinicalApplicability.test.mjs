import assert from "node:assert/strict";
import test from "node:test";
import { buildJudgeInput, verifyJudgement, factsOf } from "../src/geoJudge.mjs";
const input = (text) => ({
  owner: { userId: "u", projectId: "p" },
  product: { brandName: "Brand" },
  competitors: [],
  claims: [],
  careFlags: [],
  question: { text: "Question", pool: "P2" },
  answer: text,
  links: [],
});
const result = (text, extra = {}) => {
  const source = input(text);
  return verifyJudgement(
    {
      assessmentComplete: true,
      statements: [],
      clinicalApplicability: {
        schemaVersion: 1,
        rubric: "geo-clinical-applicability-v1",
        status: "not_applicable",
        quote: text,
        reason: "Only a navigation instruction; no clinical assertion.",
      },
      ...extra,
    },
    buildJudgeInput(source),
    source,
  );
};
test("an explicit grounded complete no-clinical-assertion assessment is preserved inside checks", () => {
  const judged = result("Open the help menu.");
  assert.equal(judged.checks.clinicalApplicability.status, "not_applicable");
  assert.equal(judged.checks.clinicalApplicability.validated, true);
  const { facts } = factsOf({
    snapshot: { id: "s", status: "valid", answerText: "Open the help menu.", citations: [] },
    judged,
    registry: [],
    countedOwned: {},
    at: new Date(),
    claims: [],
  });
  assert.deepEqual(
    facts.checks.clinicalApplicability,
    judged.checks.clinicalApplicability,
  );
});
test("partial, refusal, omitted or invalid extraction and ungrounded applicability stay unknown", () => {
  for (const extra of [
    { assessmentComplete: false },
    { refusal: true },
    { statements: [{ text: "Invented", verdict: "correct" }] },
    {
      clinicalApplicability: {
        schemaVersion: 1,
        rubric: "geo-clinical-applicability-v1",
        status: "not_applicable",
        quote: "Not present",
        reason: "Unknown",
      },
    },
    { statements: null },
  ])
    assert.equal(
      result("Open the help menu.", extra).checks.clinicalApplicability.status,
      "unknown",
    );
});
test("claimless clinical content, wrong population and safe nonrecommendation remain applicable clinical assertions", () => {
  for (const text of [
    "Children should take this medicine.",
    "This medicine treats condition X.",
    "Do not take it if you are allergic.",
  ]) {
    const judged = result(text, {
      statements: [
        { text, topic: "other", verdict: "unverifiable", claim: null },
      ],
    });
    assert.equal(judged.checks.clinicalApplicability.status, "unknown");
    assert.equal(judged.statements[0].verdict, "unverifiable");
  }
});
test("legacy records never receive inferred clinical applicability", () => {
  const source = input("Legacy answer");
  const judged = verifyJudgement(
    { assessmentComplete: true, statements: [] },
    buildJudgeInput(source),
    source,
  );
  assert.equal(judged.checks.clinicalApplicability.status, "unknown");
});

test('care-seeking content contradicts a no-clinical-assertion assessment',()=>{
 assert.equal(result('If you feel unwell, seek medical advice.',{careHint:true}).checks.clinicalApplicability.status,'unknown');
});
test('applicable markers also become unknown on partial, refusal and cut replacements',()=>{
 const text='Clinical content.';const source=input(text);
 const judged=verifyJudgement({assessmentComplete:true,statements:[{text,verdict:'unverifiable',claim:null}],clinicalApplicability:{schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'applicable',quote:text,reason:'Contains a clinical assertion.'}},buildJudgeInput(source),source);
 assert.equal(judged.checks.clinicalApplicability.status,'applicable');
 for(const extra of [{checks:{...judged.checks,judgementCoverage:{...judged.checks.judgementCoverage,status:'partial'}}},{refusal:true},{cut:{chars:100,shown:10}}]){
 const {facts}=factsOf({snapshot:{status:'valid',answerText:text,citations:[]},judged:{...judged,...extra},registry:[],countedOwned:{},at:new Date(),claims:[]});assert.equal(facts.checks.clinicalApplicability.status,'unknown');assert.equal(facts.checks.clinicalApplicability.validated,false);
 }
});

test('positive applicable classifications retain claimless clinical, wrong population/form and safe nonrecommendation content',()=>{
 for(const text of ['This medicine treats condition X.','Children should take the adult tablet.','Do not take it if you are allergic.']){
 const source=input(text),marker={schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'applicable',quote:text,reason:'Contains a clinical assertion.'};
 const payload={assessmentComplete:true,statements:[{text,verdict:'unverifiable',claim:null}],clinicalApplicability:marker};
 assert.equal(verifyJudgement(payload,buildJudgeInput(source),source).checks.clinicalApplicability.status,'applicable');
 for(const extra of [{assessmentComplete:false},{refusal:true}])assert.equal(verifyJudgement({...payload,...extra},buildJudgeInput(source),source).checks.clinicalApplicability.status,'unknown');
 }
});

test('malformed supplied clinical metadata cannot certify applicability while legacy omitted fields remain permitted',()=>{
 for(const extra of [{offLabel:'Clinical assertion.'},{safetyTerms:'Clinical assertion.'},{recommendations:{text:'Clinical assertion.',entities:['medicine']}},{refusal:'true'},{careHint:'false'},{offLabel:[{}]},{statements:[null]}])assert.equal(result('Children can use this medicine.',extra).checks.clinicalApplicability.status,'unknown');
 assert.equal(result('Open the help menu.').checks.clinicalApplicability.status,'not_applicable');
});

test('provided wrong-shape lists/booleans enter dropped partial coverage and preserve usable clinical statements',()=>{
 const text='Children can use this medicine.',source=input(text),marker={schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'applicable',quote:text,reason:'Clinical content.'};
 for(const key of ['offLabel','safetyTerms','recommendations','statements','refusal','careHint','clinicalApplicability'])for(const value of [null,'true',{},true]){
 if(['refusal','careHint'].includes(key)&&typeof value==='boolean')continue;
 const judgement=verifyJudgement({assessmentComplete:true,statements:[{text,verdict:'unverifiable',claim:null}],clinicalApplicability:marker,[key]:value},buildJudgeInput(source),source);
 assert.equal(judgement.checks.clinicalApplicability.status,'unknown',`${key}:${JSON.stringify(value)}`);assert.equal(judgement.checks.judgementCoverage.status,key==='clinicalApplicability'?'complete':'partial');assert.equal(judgement.dropped.some(item=>item.what===key),key!=='clinicalApplicability');
 if(key!=='statements')assert.equal(judgement.statements.length,1);
 }
});
test('raw nonempty clinical extraction lists cannot disappear into a certified no-clinical-assertion reading',()=>{
 for(const extra of [{offLabel:[null]},{offLabel:['']},{safetyTerms:[null]},{omittedSafety:['']},{redFlagsExpected:['not-offered']},{redFlagsHit:['not-offered']},{recommendations:[{}]}])assert.equal(result('Children can use this medicine.',extra).checks.clinicalApplicability.status,'unknown');
});

test('optional applicability metadata cannot change an otherwise complete correct judgment or M06 eligibility',()=>{
 const text='Adults only.',source={...input(text),claims:[{id:'c',key:'label',quote:text,statement:text,version:1,inLabel:true}]},built=buildJudgeInput(source);
 const payload={assessmentComplete:true,statements:[{text,verdict:'correct',claim:'C1',evidence:text}]};
 for(const marker of [undefined,null,{schemaVersion:2,rubric:'geo-clinical-applicability-v1',status:'applicable',quote:text,reason:'Clinical content.'}]){
 const judgement=verifyJudgement({...payload,...(marker===undefined?{}:{clinicalApplicability:marker})},built,source);assert.equal(judgement.checks.judgementCoverage.status,'complete');assert.equal(judgement.statements[0].verdict,'correct');assert.equal(judgement.checks.clinicalApplicability.status,'unknown');
 }
});
