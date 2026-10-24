import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJudgeInput, verifyJudgement, factsOf, recountedFacts } from '../src/geoJudge.mjs';
import { brandRegistry } from '../src/geoParse.mjs';
const product={brandName:'Alpha'}, competitors=[{brandName:'Beta'}];
const claim={id:'contra',version:3,quote:'Alpha is contraindicated during pregnancy.',statement:'Alpha is contraindicated during pregnancy.',sourceKind:'label'};
const input=answer=>({owner:{userId:'u',projectId:'p'},product,competitors,claims:[claim],careFlags:[],question:{text:'Options?',pool:'P2'},answer});
const item=(quote,entity,state,extra={})=>({quote,entity,state,conditionQuote:null,rationale:null,claimRefs:[],explicitPosition:null,positionQuote:null,...extra});
const support=(quote,entity,conditionQuote,claimId,claimVersion,evidenceQuote)=>({statementQuote:quote,entity,conditionQuote,claimId,claimVersion,evidenceQuote,evidenceConditionQuote:null,relation:'supports_nonrecommendation'});
const extraction=items=>({schemaVersion:1,rubric:'geo-recommendation-expression-v1',coverage:'complete',items});
const judge=(answer,items,extra={})=>verifyJudgement({assessmentComplete:true,statements:[],recommendationExpressions:extraction(items),...extra},buildJudgeInput(input(answer)),input(answer));
test('C3 model semantics preserve lists, conditional recommendations, multiple conditions and one negated entity',()=>{
 const text='Options: Alpha, Beta. If adult, Alpha is recommended; if pregnant, Alpha is contraindicated. Beta is recommended instead of Alpha.';
 const items=[item('Options: Alpha, Beta.','Alpha','mention_only'),item('Options: Alpha, Beta.','Beta','mention_only'),item('If adult, Alpha is recommended','Alpha','conditional',{conditionQuote:'If adult'}),item('if pregnant, Alpha is contraindicated.','Alpha','reasonable_nonrecommendation',{conditionQuote:'if pregnant',claimRefs:[{claimId:'contra',claimVersion:3}],nonrecommendationBasis:{...support('if pregnant, Alpha is contraindicated.','Alpha','if pregnant','contra',3,claim.quote),evidenceConditionQuote:'during pregnancy'}}),item('Beta is recommended instead of Alpha.','Beta','recommended'),item('Beta is recommended instead of Alpha.','Alpha','unknown')];
 const out=judge(text,items,{statements:[{text:'if pregnant, Alpha is contraindicated.',verdict:'correct',claim:'C1',evidence:claim.quote}]});
 assert.deepEqual(out.recommendationExpressions.items.map(x=>x.state),items.map(x=>x.state));
 assert.equal(out.recommendationExpressions.coverage,'complete');
 assert.equal(out.recommendationExpressions.items[3].claimRefs[0].claimVersion,3);
});
test('C3 unsupported clinical refusal stays quoted unknown and malformed optional extraction cannot alter core verdict coverage',()=>{
 const text='If pregnant, Alpha is contraindicated. Please ask a doctor.';
 const out=judge(text,[item(text,'Alpha','reasonable_nonrecommendation')]);
 assert.equal(out.recommendationExpressions.items[0].state,'unknown');
 assert.equal(out.recommendationExpressions.coverage,'partial');
 const bad=judge(text,[],{recommendationExpressions:{schemaVersion:99,items:[]}});
 assert.equal(bad.checks.judgementCoverage.status,'complete');
 assert.equal(bad.recommendationExpressions.coverage,'unknown');
 assert.equal(judge('Please ask a doctor.',[]).recommendationExpressions.items.length,0);
});
test('C3 exact quote/entity/condition/claim-version/order anchors and truncated tail cannot certify absence',()=>{
 const text='First choice: Alpha. Options: Beta.';
 const out=judge(text,[item('First choice: Alpha.','Alpha','recommended',{explicitPosition:1,positionQuote:'First choice: Alpha.',positionToken:'First',positionKind:'explicit_recommendation_order'}),item('Options: Beta.','Beta','mention_only',{explicitPosition:2,positionQuote:null}),item('Alpha recommended','Alpha','recommended'),item('Options: Beta.','Gamma','mention_only'),item('Options: Beta.','Beta','conditional',{conditionQuote:'If adult'})]);
 assert.equal(out.recommendationExpressions.items.length,2);
 assert.equal(out.recommendationExpressions.items[0].explicitPosition,1);
 assert.equal(out.recommendationExpressions.items[1].explicitPosition,null);
 assert.equal(out.recommendationExpressions.coverage,'partial');
 const tail=judge('x'.repeat(8050)+'Alpha.',[]);
 assert.equal(tail.recommendationExpressions.coverage,'partial');
 const stale=judge(text,[item('First choice: Alpha.','Alpha','reasonable_nonrecommendation',{claimRefs:[{claimId:'contra',claimVersion:2}]})]);
 assert.equal(stale.recommendationExpressions.items[0].state,'unknown');
});
test('C3 facts and registry recount retain versioned extraction without reinterpreting legacy booleans',()=>{
 const text='If adult, Alpha is recommended.';
 const judged=judge(text,[item(text,'Alpha','conditional',{conditionQuote:'If adult'})]);
 const registry=brandRegistry(product,competitors),{facts}=factsOf({snapshot:{status:'valid',answerText:text,citations:[]},judged,registry,countedOwned:{},at:new Date('2026-10-01'),claims:[claim]});
 assert.ok(judged.recommendationExpressions);
 assert.deepEqual(facts.judgeExtract.recommendationExpressions,judged.recommendationExpressions);
 const recounted=recountedFacts({...facts,status:'valid',answerText:text,citations:[]},registry,{});
 assert.deepEqual(recounted.judgeExtract.recommendationExpressions,judged.recommendationExpressions);
 assert.equal(recountedFacts({brands:[{ours:true,recommended:true}],statements:[],judgeExtract:null,status:'valid',answerText:'Alpha',citations:[]},registry,{}).judgeExtract.recommendationExpressions,undefined);
});

test('C3 repeated quote occurrences remain distinct and conflicting classifications remain unresolved',()=>{
 const text='Alpha recommended. Alpha recommended.';
 const out=judge(text,[item('Alpha recommended.','Alpha','recommended')]);
 assert.deepEqual(out.recommendationExpressions.items[0].answerOffsets,[0,19]);
 const conflict=judge(text,[item('Alpha recommended.','Alpha','recommended'),item('Alpha recommended.','Alpha','mention_only')]);
 assert.equal(conflict.recommendationExpressions.items.length,1);
 assert.equal(conflict.recommendationExpressions.items[0].state,'unknown');
 assert.equal(conflict.recommendationExpressions.coverage,'partial');
 const missing=judge('Alpha mentioned.',[]);
 assert.equal(missing.recommendationExpressions.coverage,'partial');
 const incomplete=judge('No product named.',[],{assessmentComplete:false});
 assert.equal(incomplete.recommendationExpressions.coverage,'partial');
 const absent=verifyJudgement({assessmentComplete:true,statements:[]},buildJudgeInput(input('No product named.')),input('No product named.'));
 assert.equal(Object.hasOwn(absent,'recommendationExpressions'),false);
});

test('C3 F1 rejects cross-entity or unrelated-statement evidence borrowed through a broad quote',()=>{
 const beta={...claim,id:'beta-contra',quote:'Beta is contraindicated during pregnancy.',statement:'Beta is contraindicated during pregnancy.'};
 const storage={...claim,id:'alpha-storage',quote:'Alpha should be stored at room temperature.',statement:'Alpha should be stored at room temperature.'};
 for(const [text,basis,condition] of [['Do not choose Alpha. '+beta.quote,beta,null],['Do not choose Alpha during pregnancy. '+storage.quote,storage,'during pregnancy']]){
  const args={...input(text),claims:[basis]};
  for(const supplied of [undefined,support(basis.quote,'Alpha',condition,basis.id,3,basis.quote),support(text,'Alpha',condition,basis.id,3,basis.quote)]){
   const expression=item(text,'Alpha','reasonable_nonrecommendation',{conditionQuote:condition,claimRefs:[{claimId:basis.id,claimVersion:3}],...(supplied?{nonrecommendationBasis:supplied}:{})});
   const out=verifyJudgement({assessmentComplete:true,statements:[{text:basis.quote,verdict:'correct',claim:'C1',evidence:basis.quote}],recommendationExpressions:extraction([expression])},buildJudgeInput(args),args);
   assert.equal(out.recommendationExpressions.items[0].state,'unknown');
   assert.equal(out.recommendationExpressions.coverage,'partial');
   assert.equal(out.statements[0].verdict,'correct');
  }
 }
});
test('C3 F2 only retains recommendation order when the verbatim ordinal token agrees with the declared number',()=>{
 for(const [quote,position,positionQuote,positionToken] of [['Alpha is recommended.',99,'Alpha',undefined],['First choice: Alpha.',99,'First choice: Alpha.',undefined],['First choice: Alpha.',99,'First choice: Alpha.','First'],['10. Alpha recommended.',1,'10. Alpha recommended.','1'],['Alpha is recommended.',1,'Alpha','Alpha']]){
  const out=judge(quote,[item(quote,'Alpha','recommended',{explicitPosition:position,positionQuote,positionToken,positionKind:'explicit_recommendation_order'})]);
  assert.equal(out.recommendationExpressions.items[0].explicitPosition,null);
 }
 for(const [quote,position,positionToken] of [['First choice: Alpha.',1,'First'],['第十二顺位推荐 Alpha。',12,'第十二'],['The 99th recommendation is Alpha.',99,'99th']]){
  const out=judge(quote,[item(quote,'Alpha','recommended',{explicitPosition:position,positionQuote:quote,positionToken,positionKind:'explicit_recommendation_order'})]);
  assert.equal(out.recommendationExpressions.items[0].explicitPosition,position);
 }
 const list=judge('1. Alpha\n2. Beta',[item('1. Alpha','Alpha','mention_only',{explicitPosition:1,positionQuote:'1. Alpha',positionToken:'1'})]);
 assert.equal(list.recommendationExpressions.items[0].explicitPosition,null);
});
test('C3 F3 exact longest-name ownership excludes substring aliases while retaining independent same-answer occurrences',()=>{
 for(const [quote,entities,expected] of [['AlphaBeta is recommended.',['AlphaBeta'],['AlphaBeta']],['AlphaBeta and Alpha are recommended.',['AlphaBeta'],['Alpha','AlphaBeta']],['甲牌增强 is recommended.',['甲牌增强'],['甲牌增强']],['甲牌增强与甲牌均可考虑。',['甲牌增强'],['甲牌','甲牌增强']]]){
  const short=quote.includes('Alpha')?'Alpha':'甲牌';
  const args={...input(quote),product:{brandName:short},entities};
  const items=[item(quote,short,'recommended'),...entities.map(entity=>item(quote,entity,'recommended'))];
  const out=verifyJudgement({assessmentComplete:true,statements:[],entities,recommendationExpressions:extraction(items)},buildJudgeInput(args),args);
  assert.deepEqual(out.recommendationExpressions.items.map(expression=>expression.entity),expected);
 }
 const substring=judge('AlphaBeta is recommended.',[item('AlphaBeta is recommended.','Alpha','recommended')]);
 assert.equal(substring.recommendationExpressions.items.length,0);
});

test('C3 new basis binds exact supported claim conditions and survives facts/history payload without editing clinical verdicts',()=>{
 const quote=claim.quote,basis={...support(quote,'Alpha','during pregnancy',claim.id,3,claim.quote),evidenceConditionQuote:'during pregnancy'};
 const good=judge(quote,[item(quote,'Alpha','reasonable_nonrecommendation',{conditionQuote:'during pregnancy',claimRefs:[{claimId:claim.id,claimVersion:3}],nonrecommendationBasis:basis})],{statements:[{text:quote,verdict:'correct',claim:'C1',evidence:claim.quote}]});
 assert.equal(good.recommendationExpressions.items[0].state,'reasonable_nonrecommendation');
 assert.equal(good.recommendationExpressions.coverage,'complete');
 assert.deepEqual(good.recommendationExpressions.items[0].nonrecommendationBasis,basis);
 const registry=brandRegistry(product,competitors),{facts}=factsOf({snapshot:{status:'valid',answerText:quote,citations:[]},judged:good,registry,countedOwned:{},at:new Date('2026-10-01'),claims:[claim]});
 assert.deepEqual(facts.judgeExtract.recommendationExpressions.items[0].nonrecommendationBasis,basis);
 for(const invalid of [{...basis,entity:'Beta'},{...basis,conditionQuote:'during childhood'},{...basis,evidenceConditionQuote:'not in source'},{...basis,claimVersion:2},{...basis,evidenceQuote:'forged source text'}]){
  const out=judge(quote,[item(quote,'Alpha','reasonable_nonrecommendation',{conditionQuote:'during pregnancy',claimRefs:[{claimId:claim.id,claimVersion:3}],nonrecommendationBasis:invalid})],{statements:[{text:quote,verdict:'correct',claim:'C1',evidence:claim.quote}]});
  assert.equal(out.recommendationExpressions.items[0].state,'unknown');assert.equal(out.checks.judgementCoverage.status,'complete');assert.deepEqual(out.statements,good.statements);
 }
});
test('C3 ordinal token cannot be the entity name or an entity fragment from another occurrence',()=>{
 const text='First is recommended.',args={...input(text),product:{brandName:'First'}};
 const out=verifyJudgement({assessmentComplete:true,statements:[],recommendationExpressions:extraction([item(text,'First','recommended',{explicitPosition:1,positionQuote:text,positionToken:'First',positionKind:'explicit_recommendation_order'})])},buildJudgeInput(args),args);
 assert.equal(out.recommendationExpressions.items[0].explicitPosition,null);
 const quote='First choice: AlphaBeta. Alpha is another option.',mixed={...input(quote)};
 const forged=verifyJudgement({assessmentComplete:true,statements:[],entities:['AlphaBeta'],recommendationExpressions:extraction([item(quote,'Alpha','recommended',{explicitPosition:1,positionQuote:'First choice: Alpha',positionToken:'First',positionKind:'explicit_recommendation_order'})])},buildJudgeInput(mixed),mixed);
 assert.equal(forged.recommendationExpressions.items[0].explicitPosition,null);
 const short=verifyJudgement({assessmentComplete:true,statements:[],entities:['AlphaBeta'],recommendationExpressions:extraction([item('Alpha','Alpha','recommended')])},buildJudgeInput(input('AlphaBeta is recommended.')),input('AlphaBeta is recommended.'));
 assert.equal(short.recommendationExpressions.items.length,0);
});

test('C3 same judge distinguishes declared mention ordering from explicit recommendation ordering',()=>{const quote='1. Alpha is recommended.';for(const positionKind of ['mention_order','unknown',null]){const out=judge(quote,[item(quote,'Alpha','recommended',{explicitPosition:1,positionQuote:quote,positionToken:'1',positionKind})]);assert.equal(out.recommendationExpressions.items[0].explicitPosition,null);}});
