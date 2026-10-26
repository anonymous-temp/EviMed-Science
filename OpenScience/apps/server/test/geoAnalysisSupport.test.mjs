import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson, geoClaimApplicability, geoClaimAssessmentIdentity } from '@evimed/domain';
import { buildGeoSupportAnalysis } from '../src/geoAnalysisSupport.mjs';
import { presentGeoAnalysis,freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
function fixture() {
  const claims=[['adult','Adults','10 mg'],['child','Children','5 mg']].map(([id,population,dose])=>({id,version:1,key:id,status:'active',statement:'Exact claim '+id,quote:'Preserved quote '+id,sourceRef:'https://doi.org/10.1000/'+id,population,elements:{dose},cardId:'card-'+id,cardClaimId:'C1',cardRevision:1}));
  const cards=claims.map(claim=>({cardId:claim.cardId,revision:1,current:{},at:{claims:[{claimId:'C1',claimType:'direct',claim:claim.statement,supportQuote:claim.quote,sourceIndexes:[1]}],sources:[{url:claim.sourceRef,documentText:claim.quote}]}}));
  const rows=claims.map((claim,n)=>({snapshotId:'s'+n,questionId:'q'+n,roundId:'old',status:'valid',engine:'deepseek',askedAt:'2026-10-01T00:00:00Z',facts:{judgedAt:'2026-10-01T01:00:00Z',statements:[{claimId:claim.id,claimVersion:1,applicability:geoClaimApplicability(claim),text:'Answer statement',verdict:n?'wrong':'correct'}]}}));
  const selected={rows,rounds:[{id:'old',ref:{evaluationBasis:{claims,value:{version:1,data:{findings:[{id:'f1',statement:'Original finding',population:'Adults'}]}}}}}],questions:[],selection:{reference:'gsel_support'}};
  return {claims,selected,context:{support:{claims:structuredClone(claims),cards,sourceChanges:[],assessmentRecords:[],valueObservations:[],profiles:[]}}};
}
test('V16 keeps exact claim/condition/source rows and never substitutes current wording for frozen claims',()=>{
  const {claims,selected,context}=fixture();
  context.support.claims[0]={...claims[0],id:'replacement',version:2,statement:'Current replacement'};
  const result=buildGeoSupportAnalysis(selected,{viewId:'V16',evidenceKind:'claims'},context);
  assert.equal(result.rows.length,2);
  const adult=result.rows.find(row=>row.dimensions.claimId==='adult');
  assert.equal(adult.values.supported.value,1);
  assert.equal(adult.dimensions.claimVersion,1);
  assert.equal(adult.dimensions.applicability.population,'Adults');
  assert.ok(!JSON.stringify(result.rows).includes('Current replacement'));
  const child=result.rows.find(row=>row.dimensions.claimId==='child');
  assert.equal(child.values.contradicted.value,1);
  assert.equal(child.dimensions.applicability.elements.dose,'5 mg');
});

test('V16 ordinary rows and chart use the visible page while complete freeze keeps the same digest and object relation',()=>{
 const {selected,context}=fixture();
 const page=presentGeoAnalysis(selected,{viewId:'V16'},{...context,limit:1});
 const full=presentGeoAnalysis(selected,{viewId:'V16'},{...context,allRows:true});
 assert.equal(page.rows.length,1);assert.equal(page.chart.cells.length,page.columns.length);
 assert.equal(Object.hasOwn(page.rows[0].dimensions,'objects'),false);
 assert.equal(full.rows.length,2);assert.ok(full.rows.every(row=>row.dimensions.objects.length===1));
 assert.equal(page.digest,full.digest);assert.deepEqual(page.rows[0].values,full.rows[0].values);
 assert.throws(()=>freezeGeoAnalysisDocument(page),{code:'geo_read_filter_invalid'});
 assert.equal(freezeGeoAnalysisDocument(full).cover.analysis.rows.length,2);
});
test('V16 keeps unavailable sources unknown and current invalidation specific to the referenced claim',()=>{
  const {selected,context}=fixture();context.support.cards[0].at.sources[0].documentText='';
  context.support.sourceChanges=[{identifier:'doi:10.1000/child',state:'changed',checkedAt:'2026-10-24T00:00:00Z',changes:[{kind:'retraction',date:'2026-10-20',recordedAt:'2026-10-23T00:00:00Z'}]}];
  const result=buildGeoSupportAnalysis(selected,{viewId:'V16',evidenceKind:'claims'},context);
  const adult=result.rows.find(row=>row.dimensions.claimId==='adult'),child=result.rows.find(row=>row.dimensions.claimId==='child');
  assert.equal(adult.values.needsVerification.value,1);assert.equal(adult.values.supported.value,null);
  assert.equal(adult.values.supported.state,'unknown');
  assert.equal(child.values.updateNeeded.value,1);assert.equal(child.values.contradicted.value,0);
  const member=result.memberItems.get(child.key+':updateNeeded')[0];
  assert.equal(member.sourceChanges[0].changes[0].date,'2026-10-20');
  assert.equal(member.askedAt,'2026-10-01T00:00:00Z');
  assert.equal(member.preservedQuoteVerification.status,'verified');
});
test('V16 finding expression has its own units, complete members and exact historical definition',()=>{
  const {selected,context}=fixture();
  context.support.valueObservations=Array.from({length:37},(_,n)=>({id:'obs'+n,snapshotId:'s0',position:n+1,roundId:'old',basisVersion:1,findingId:'f1',status:n===36?'uncertain':'represented',recordedStatus:n===36?'not_addressed':'represented',judgementCoverage:{status:'partial'},quote:'Answer quote'}));
  context.support.profiles=[{version:2,data:{findings:[{id:'f1',statement:'Current changed finding'}]}}];
  const result=buildGeoSupportAnalysis(selected,{viewId:'V16',evidenceKind:'findings'},context),row=result.rows[0];
  assert.equal(row.values.observations.value,37);assert.equal(row.values.represented.value,36);assert.equal(row.values.uncertain.value,1);
  assert.equal(row.dimensions.finding.statement,'Original finding');
  assert.equal(result.memberItems.get(row.key+':observations').length,37);
  assert.ok(result.columns.every(column=>!['supported','contradictedMedical'].includes(column.key)));
  assert.ok(result.memberItems.get(row.key+':observations').every(item=>item.unit==='finding_observations'));
});

test('V16 current assessment retains its version and cannot borrow absent basis or changed same-version source bytes',()=>{
  const {claims,selected,context}=fixture(),claim=claims[0],digest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
  const basis={id:claim.id,version:claim.version,identity:geoClaimAssessmentIdentity(claim),applicability:geoClaimApplicability(claim),cardId:claim.cardId,cardRevision:1,cardClaimId:'C1',sourceRef:claim.sourceRef,quoteDigest:digest(claim.quote),statementDigest:digest(claim.statement)};
  const record={id:'assessment',revision:4,payload:{snapshotId:'s0',state:'active',assessmentVersion:'version-four',assessment:{...selected.rows[0].facts,basis:[basis]}}};
  context.support.assessmentRecords=[record];
  let result=buildGeoSupportAnalysis(selected,{viewId:'V16'},context);
  let row=result.rows.find(item=>item.dimensions.claimId==='adult');
  const member=result.memberItems.get(row.key+':observations')[0];
  assert.equal(member.assessmentVersion,'version-four');assert.equal(member.temporalBasis,'current_assessment_of_selected_answer');
  assert.equal(row.values.supported.value,1);
  record.payload.assessment.basis=[];
  result=buildGeoSupportAnalysis(selected,{viewId:'V16'},context);row=result.rows.find(item=>item.dimensions.claimId==='adult');
  assert.equal(row.values.needsVerification.value,1);assert.equal(row.values.supported.value,null);
  record.payload.assessment.basis=[basis];selected.rounds[0].ref.evaluationBasis.claims=[];
  context.support.claims[0].quote='Changed source bytes';
  result=buildGeoSupportAnalysis(selected,{viewId:'V16'},context);row=result.rows.find(item=>item.dimensions.claimId==='adult');
  assert.equal(row.values.needsVerification.value,1);
});

test('V16 read time alone leaves analytical dependencies stable',()=>{
  const {selected,context}=fixture();context.support.readAt='2026-10-24T01:00:00Z';
  const first=buildGeoSupportAnalysis(selected,{viewId:'V16'},context);
  context.support.readAt='2026-10-24T01:00:01Z';
  const second=buildGeoSupportAnalysis(selected,{viewId:'V16'},context);
  assert.deepEqual(second.dependencies,first.dependencies);assert.deepEqual(second.rows,first.rows);
  assert.deepEqual(second.contextualBasis,first.contextualBasis);
});

test('V16 missing judgment time and failed samples never become verified correct or wrong observations',()=>{
 const {selected,context}=fixture();delete selected.rows[0].facts.judgedAt;selected.rows[1].status='failed';
 const result=buildGeoSupportAnalysis(selected,{viewId:'V16'},context);
 assert.ok(result.rows.every(row=>row.values.needsVerification.value===1&&row.values.supported.value===null&&row.values.contradicted.value===null));
 const reasons=result.rows.map(row=>result.memberItems.get(row.key+':needsVerification')[0].assessmentReason);
 assert.deepEqual(new Set(reasons),new Set(['judgment_time_unavailable','sample_not_returned']));
});
