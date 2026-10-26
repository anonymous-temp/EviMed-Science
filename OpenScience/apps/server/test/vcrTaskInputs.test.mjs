import test from 'node:test';
import assert from 'node:assert/strict';
import { VcrDataPlane } from '../src/vcrDataPlane.mjs';

function fixture() {
 const source={id:'src1',status:'active',allowedUses:['vcr'],cloudPermission:null};
 const snapshot={id:'snp1',sourceId:'src1',profile:{},notes:{}};
 const table={id:'at1',snapshotId:'snp1',shape:'subject',rowCount:50,valueSource:'observed',columns:['age'],derivedFrom:{columns:[{name:'age',source:'AGE'}]}};
 let grant=true,maps=[{columnName:'AGE',role:'covariate'}];
 const reads=[];
 const plane=new VcrDataPlane({config:{vcrProviderAgreements:true,deepseekBaseUrl:'https://api.example.org'},store:{
  async listSourcesForStudy(){return [source];},async listSnapshots(input){reads.push(input);return [snapshot];},
  async listAnalysisTables(){return [table];},async listFieldMaps(){return maps;}}});
 plane.pageAccess={async judge(input){reads.push(input);return {allowed:grant,fields:{allowed:grant?['AGE']:[]}};}};
 return {plane,source,table,reads,setGrant(value){grant=value;},setMaps(value){maps=value;}};
}
test('home input metadata requires mapped real patient fields and current viewer/source/cloud permission',async()=>{
 const f=fixture();const result=await f.plane.taskInputAvailability({id:'std1'},{id:'viewer'});
 assert.equal(result.matching.length,1);assert.equal(result.cohort.length,1);assert.equal(result.patient.length,0);
 assert.equal(f.reads.find(row=>row.actor).actor,'viewer');assert.equal(JSON.stringify(result).includes('AGE'),false);
 f.setMaps([]);assert.equal((await f.plane.taskInputAvailability({id:'std1'},{id:'viewer'})).matching.length,0);
 f.setMaps([{columnName:'AGE',role:'covariate'}]);f.setGrant(false);assert.equal((await f.plane.taskInputAvailability({id:'std1'},{id:'other'})).matching.length,0);
 f.setGrant(true);f.source.status='withdrawn';assert.equal((await f.plane.taskInputAvailability({id:'std1'},{id:'viewer'})).matching.length,0);
 f.source.status='active';f.source.cloudPermission={status:'revoked'};assert.equal((await f.plane.taskInputAvailability({id:'std1'},{id:'viewer'})).matching.length,0);
 f.source.cloudPermission=null;f.table.valueSource='synthetic';assert.equal((await f.plane.taskInputAvailability({id:'std1'},{id:'viewer'})).matching.length,0);
});
