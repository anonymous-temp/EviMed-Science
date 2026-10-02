import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {NativeSkillCatalogue,nativeSkillSnapshotArchive} from '../src/nativeSkillCatalogue.mjs';
import {decodeSkillArchive} from '../src/skillArchive.mjs';
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const project={userId:'owner',id:'project'},user={id:'owner'},key='skill:'+'a'.repeat(64);
const entry=(path,text)=>({path,size:Buffer.byteLength(text),digest:digest(text),bytesBase64:Buffer.from(text).toString('base64')});
const summary={key,name:'native-template',description:'Real template',invocation:{userInvocable:false,modelInvocable:true},source:'builtin',canDuplicate:true};
const entries=[entry('SKILL.md','---\nname: native-template\ndescription: Real template\n---\nbody'),entry('资料/证据.csv','来源,结果\n真实,1\n')];
const detail={...summary,instructions:'body',metadata:{},whenToUse:null,resources:entries.slice(1).map(({bytesBase64:_bytes,...resource})=>resource),scripts:[],findings:[],digest:digest('definition'),entries};
function fixture(){const runtime={},manager={runtimes:new Map([['owner:project',runtime]]),key:()=> 'owner:project',runtimeGeneration:()=> 'current',callKernel:async(_runtime,_project,method)=>method==='evimedSkills/list'?{complete:true,items:[summary]}:detail};return{manager,catalogue:new NativeSkillCatalogue({runtimeManager:manager,authorizeSession:async()=>{}})};}
test('catalogue never wakes absent runtime; changed generation and caller paths are refused',async()=>{
 const f=fixture();assert.equal((await f.catalogue.list(user,project,null)).state,'unavailable');assert.equal((await f.catalogue.list(user,project,'session')).items.length,1);
 await assert.rejects(f.catalogue.read(user,project,{sessionId:'session',key,expectedRuntimeGeneration:'retired'}),{status:409});
 await assert.rejects(f.catalogue.read(user,project,{sessionId:'session',key,expectedRuntimeGeneration:'current',path:'/outside'}),{status:400});
 f.manager.runtimes.clear();assert.equal((await f.catalogue.list(user,project,'session')).state,'unavailable');
});
test('source bytes are independently checked and maintained archive encoding reuses canonical native importer',async()=>{
 const f=fixture();const snapshot=await f.catalogue.read(user,project,{sessionId:'session',key,expectedRuntimeGeneration:'current'},true);assert.equal(snapshot.skill.invocation.userInvocable,false);
 const encoded=await nativeSkillSnapshotArchive(entries),decoded=await decodeSkillArchive(encoded,'tar-gzip');assert.equal(decoded.find(entry=>entry.path==='资料/证据.csv').bytes.toString(),'来源,结果\n真实,1\n');
 detail.entries=[entries[0],{...entries[1],bytesBase64:entries[1].bytesBase64+'!'}];await assert.rejects(f.catalogue.read(user,project,{sessionId:'session',key,expectedRuntimeGeneration:'current'},true));detail.entries=entries;
});

test('personal labels cannot attach a replacement runtime revision to an earlier native observation',async()=>{
 const {SkillLibraryService}=await import('../src/skillLibraryService.mjs');let generation='observed';const personal={...summary,source:'personal',name:'personal-selected',canDuplicate:false};
 const native={runtime:{runtimePersonalSkillPins:()=>[{nativeName:personal.name,skillId:'owned-skill',revision:2,digest:'newer-digest'}]},list:async()=>({state:'available',runtimeGeneration:'observed',items:[personal],findings:[]}),read:async()=>({state:'available',runtimeGeneration:'observed',skill:personal,findings:[]}),assertCurrent:async(_user,_project,_session,captured)=>{if(captured!==generation)throw Object.assign(Error('generation changed'),{status:409});}};
 const service=new SkillLibraryService(null,{documents:{},projectAccess:async()=>{},nativeCatalogue:native});service.atRevision=async()=>{generation='replacement';return{id:'owned-skill',payload:{title:'Newer title',digest:'newer-digest'}};};
 await assert.rejects(service.effectiveCatalogue(user,project,'session'),{status:409});generation='observed';await assert.rejects(service.effectiveDetail(user,project,{sessionId:'session',key,expectedRuntimeGeneration:'observed'}),{status:409});
});
