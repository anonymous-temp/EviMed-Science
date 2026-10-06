import {createHash} from 'node:crypto';
import {MemorySubstrate} from './memorySubstrate.mjs';
import {versionsInForce} from './memoryValidity.mjs';
/** Nonclinical, immutable facts exercise scope and time at the production recall port. */
export const MODULE_MEMORY_SNAPSHOT_TASKS=Object.freeze([
 {id:'current-version',expected:['record:new'],asOf:null},
 {id:'past-version',expected:['record:old'],asOf:Date.parse('2026-01-15')},
 {id:'scope-isolation',expected:['record:new'],asOf:null},
].map(item=>({...item,query:'format preference',snapshot:[
 {id:'old',supersededBy:'new',key:'format',kind:'preference',value:'format table',status:'superseded',scope:'project',scopeId:'public-fixture',validFrom:'2026-01-01',invalidSince:'2026-02-01'},
 {id:'new',key:'format',kind:'preference',value:'format list',status:'active',scope:'project',scopeId:'public-fixture',validFrom:'2026-02-01'},
 {id:'private-other',kind:'preference',value:'format chart',status:'active',scope:'project',scopeId:'other-fixture',validFrom:'2026-01-01'},
]})));
/** Runs the production port on a dedicated frozen synthetic store; no clinical facts or tenant access. @param {any} input */
export async function recallEvolutionPublicSnapshot(input){
 const item=input.item;if(!Array.isArray(item.snapshot))throw new Error('Missing frozen public snapshot.');
 const snapshotHash=createHash('sha256').update(JSON.stringify(item.snapshot)).digest('hex');
 const store={list:async()=>[],relevant:async(_user,query,context)=>versionsInForce(item.snapshot,context).map(entry=>({id:`record:${entry.record.id}`,content:entry.record.value,caveats:entry.caveats})),getRecord:async(_user,id)=>item.snapshot.find(row=>row.id===id)};
 const port=new MemorySubstrate({memoryIndexProvider:'builtin',memoryRecallEnabled:true,memoryContextLimit:8},{store});
 const records=await port.recall('public-evolution-fixture',item.query,{projectId:'public-fixture',countUsage:false,asOf:item.asOf??null,now:Date.parse('2026-10-06')});
 return {records,snapshotHash,contextBytes:Buffer.byteLength(JSON.stringify(records)),readOnly:true,evaluationScope:'fixed-public-synthetic-snapshot'};
}
