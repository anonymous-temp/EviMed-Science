import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
/** Measured public anchors verify the judge itself. Historical anchors never count as confirmations.
 * @param {{moduleId:string,judgeFrontier?:any,geoJudge?:any,input:any}} dependencies */
export async function calibrateModuleSourceJudge({moduleId,judgeFrontier,geoJudge,input}){
 const units=[];
 if(moduleId==='geo'&&geoJudge){
  const data=JSON.parse(await readFile(new URL('../../../evals/geo-judge-cards/cases.json',import.meta.url),'utf8'));
  const negative=data.cases.find(item=>item.mustContain?.some(expect=>expect.verdict==='wrong'));
  if(!negative)return {anchorCalibrated:false,reason:'independent_negative_anchor_missing'};
  const positive={...negative,id:`${negative.id}:supported`,answer:negative.claims.map(claim=>claim.quote).join('\n')};
  for(const item of [positive,negative]){
   const result=await geoJudge.judge({...item,question:{text:item.question},competitors:[],careFlags:[],purpose:'evolution',missionId:input.missionId,userId:input.userId,projectId:input.projectId});
   const wrong=result.statements?.some(statement=>statement.verdict==='wrong')===true;
   const expectedWrong=item.id===negative.id;
   units.push({id:item.id,passed:wrong===expectedWrong && !result.dropped?.length && result.statements?.length>0 && (expectedWrong || result.statements.every(statement=>statement.verdict==='correct')),result,sourceHash:createHash('sha256').update(JSON.stringify(item)).digest('hex')});
  }
 }else if(moduleId==='frontier'&&judgeFrontier){
  const corpus=JSON.parse(await readFile(new URL('../../../evals/geo-judge-cards/cases.json',import.meta.url),'utf8'));
  const original=corpus.cases[0].claims[0].quote;
  if(!original.includes('2.5 mg'))return {anchorCalibrated:false,reason:'independent_numeric_anchor_missing'};
  for(const anchor of [{id:'correct',text:original,supported:true},{id:'wrong-dose',text:original.replace('2.5 mg','25 mg'),supported:false}]){
   const result=await judgeFrontier({...input,original,output:{title:'Source statement',text:anchor.text,body:anchor.text,summary:anchor.text},singleAttempt:true});
   units.push({id:anchor.id,passed:result.supported===anchor.supported,result,sourceHash:createHash('sha256').update(original).digest('hex')});
  }
 }
 return {anchorCalibrated:units.length>=2&&units.every(unit=>unit.passed),units,evaluatorVersion:`${moduleId}-source-anchor-v1`,reason:units.length?'measured':'judge_unavailable'};
}
