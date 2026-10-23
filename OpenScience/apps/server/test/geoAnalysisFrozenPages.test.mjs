import assert from 'node:assert/strict';
import test from 'node:test';
import {presentGeoAnalysis} from '../src/geoAnalysis.mjs';
import {freezeGeoAnalysisPages,readFrozenGeoAnalysisPage} from '../src/geoAnalysisFrozenPages.mjs';
const project={id:'geo',projectId:'control',userId:'owner'};
function wide(){const engines=['deepseek','kimi','doubao','qwen','baidu'],questions=Array.from({length:130},(_,i)=>({id:`q${i}`,set_version:1,text:`Original question ${i}`,original_id:String(i).padStart(4,'0'),original_row_index:i,original_group:'Category'}));return presentGeoAnalysis({scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel_size',dataRevision:'size',methodVersion:'method',engines,counts:{}},questions,rows:[],rounds:[{id:'r'}],computed:{cells:[]}},{viewId:'V07'},{allRows:true});}
function stored(pack){const parent={id:'gpc_parent',projectId:project.projectId,payload:{recordType:'geo-plan-context',geoId:project.id,actorId:'actor',mode:'analysis',state:'bound',basis:{analysis:pack.analysis}}};const records=new Map(pack.pages.map(page=>[page.id,page]));return {parent,records,documents:{get:async(userId,kind,id)=>userId===project.userId&&kind==='geo-plan-context'?records.get(id)??null:null}};}
test('130 questions x5 engines freezes bounded pages and reconstructs all exact rows once',async()=>{
 const view=wide();assert.ok(Buffer.byteLength(JSON.stringify(view))>200000);
 const pack=freezeGeoAnalysisPages(view,{parentId:'gpc_parent',project,actorId:'actor'});
 assert.equal(pack.analysis.rows.length,5);assert.ok(Buffer.byteLength(JSON.stringify(pack.analysis))<=200000);assert.ok(pack.pages.length>1&&pack.pages.length<=128);assert.equal(pack.analysis.digest,view.digest);
 assert.ok(pack.pages.every(page=>Buffer.byteLength(JSON.stringify(page.payload))<=150000&&!page.payload.basis));
 const fixture=stored(pack),rows=[];for(let offset=0;offset<view.rows.length;offset+=37){const page=await readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{limit:37,offset});assert.equal(page.digest,view.digest);rows.push(...page.rows);}
 assert.deepEqual(rows,view.rows);assert.equal(new Set(rows.map(row=>row.key)).size,650);
});
test('corrupt rows, foreign owner/project/parent or analysis digest fail closed',async()=>{
 const pack=freezeGeoAnalysisPages(wide(),{parentId:'gpc_parent',project,actorId:'actor'});
 for(const mutate of [page=>page.payload.rows[0].label='Corrupt',page=>page.payload.ownerId='foreign',page=>page.projectId='foreign',page=>page.payload.parentId='foreign',page=>page.payload.actorId='foreign',page=>page.payload.analysisDigest='f'.repeat(64)]){
 const fixture=stored(structuredClone(pack));mutate(fixture.records.values().next().value);await assert.rejects(readFrozenGeoAnalysisPage(fixture.documents,project,fixture.parent,{offset:0,limit:1}),error=>error.status===409||error.status===404);
 }
});
test('individual giant rows and excess total storage never create unbounded pages',()=>{
 const view=wide();view.rows[0].label='x'.repeat(150000);assert.throws(()=>freezeGeoAnalysisPages(view,{parentId:'gpc_parent',project,actorId:'actor'}),error=>error.status===422);
 const many=wide();many.rows=Array.from({length:20000},()=>structuredClone(many.rows[0]));assert.throws(()=>freezeGeoAnalysisPages(many,{parentId:'gpc_parent',project,actorId:'actor'}),error=>error.status===422);
});
