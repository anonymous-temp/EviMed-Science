import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {SkillLibraryService} from '../src/skillLibraryService.mjs';
import {SkillLibraryArtifacts} from '../src/skillLibraryArtifacts.mjs';
import {NativeSkillCatalogue} from '../src/nativeSkillCatalogue.mjs';
import {decodeSkillArchive} from '../src/skillArchive.mjs';
import {createNativeValidationFixture} from './helpers/nativeSkillValidationFixture.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'',sourceFile=process.env.NATIVE_SKILL_CATALOGUE_SNAPSHOT??'',image=process.env.NATIVE_SKILL_VALIDATOR_IMAGE??'';
const options={skip:(!url||!sourceFile||!image)&&'Isolated PG and actual native snapshot/validator image are required'};
let isolated,database,dataDir,validator,service,source,runtime,manager,user,project;
const hash=value=>createHash('sha256').update(value).digest('hex');
before(async()=>{if(options.skip)return;isolated=await createGeoTestDatabase(url,'skillcopy');database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:1,databaseConnectionTimeoutMs:1000});await database.migrate();
 user={id:'copy-owner-'+randomUUID()};project={userId:user.id,id:'copy-project'};await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Native copy fixture','development')",[user.id]);user.accountCreatedAt=(await database.query('SELECT created_at::text AS epoch FROM evimed_control.users WHERE id=$1',[user.id])).rows[0].epoch;await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Copy fixture',1048576)",[user.id,project.id]);
 const shared=path.resolve('../.evimed-local/extensions/build/fixtures');await fs.mkdir(shared,{recursive:true});dataDir=await fs.realpath(await fs.mkdtemp(path.join(shared,'native-skill-copy-')));const root=path.join(dataDir,'.openscience','skill-library');await fs.mkdir(root,{recursive:true});validator=await createNativeValidationFixture({dataDir,image});
 const artifacts=new SkillLibraryArtifacts({root,minFreeBytes:0,decodeArchive:decodeSkillArchive,parseSkill:async(absolute,options)=>{const parts=path.relative(root,absolute).split(path.sep);assert.equal(parts.length,3);try{return await validator.validate({ownerHash:parts[0],kind:parts[1],contentId:parts[2],expectedName:options.expectedName??null});}catch(error){process.stderr.write(JSON.stringify({nativeValidationCode:error.code,nativeValidationReason:error.message})+'\n');throw error;}}});
 source=JSON.parse(await fs.readFile(sourceFile,'utf8'));runtime={};manager={runtimes:new Map([[user.id+':'+project.id,runtime]]),key:p=>p.userId+':'+p.id,runtimeGeneration:()=> 'actual-fixture-epoch',runtimePersonalSkillPins:()=>[],callKernel:async(_runtime,_project,method)=>method==='evimedSkills/list'?source.list:method==='evimedSkills/read'?source.body:source.snapshot};
 const catalogue=new NativeSkillCatalogue({runtimeManager:manager,authorizeSession:async(actor,p,sessionId)=>{assert.equal(actor.id,user.id);assert.equal(sessionId,'catalogue-session');const current=await database.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[actor.id,p.id]);assert.equal(current.rowCount,1);}});
 service=new SkillLibraryService(database,{artifacts,nativeCatalogue:catalogue,projectAccess:async(actor,p)=>{const current=await database.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[actor.id,p.id]);if(current.rowCount!==1)throw Object.assign(Error('missing'),{status:404});},learnedMethods:async()=>[{id:'same-existing-method',payload:{title:'已有方法'}}]});
});
after(async()=>{let failure;try{if(validator)await validator.close();}catch(error){failure=error;}finally{if(database)await database.close();if(isolated)await isolated.drop();if(dataDir&&!failure)await fs.rm(dataDir,{recursive:true,force:true});}if(failure)throw failure;});

test('actual Linux scoped builtin bytes duplicate via native private validation and pool1 durable history, without restoring authority',options,async()=>{
 const listed=await service.effectiveCatalogue(user,project,'catalogue-session');assert.equal(listed.state,'available');assert(listed.items.some(item=>item.invocation.userInvocable===false));assert.deepEqual(listed.learnedMethods,[{id:'same-existing-method',title:'已有方法',href:'/app/memory?method=same-existing-method'}]);
 const input={sessionId:'catalogue-session',key:source.snapshot.key,title:'我的原始模板副本',idempotencyKey:'copy-once',expectedRuntimeGeneration:'actual-fixture-epoch'};
 const copied=await service.duplicateNative(user,project,input);assert.match(copied.payload.nativeName,/^personal-/);assert.notEqual(copied.payload.nativeName,source.snapshot.name);assert.equal(copied.payload.invocation.userInvocable,false);assert.equal(copied.payload.metadata.title,'原始模板');assert.equal(copied.revision,1);
 const resource=copied.payload.resources[0];assert.equal(resource.path,'资料/证据.csv');assert.equal((await service.resource(user,copied.id,1,resource.id)).toString(),'来源,结果\n真实,1\n');assert.equal(copied.payload.instructions,source.snapshot.instructions);
 const retried=await service.duplicateNative(user,project,input);assert.equal(retried.id,copied.id);assert.equal(retried.revision,1);await assert.rejects(service.duplicateNative(user,project,{...input,title:'Different'}),{status:409});
 assert.equal((await service.projectSelections(user,project)).payload.skills.length,0);const blob=path.join(service.artifacts.ownerRoot(user),'blobs',resource.digest.slice(7));assert.equal((await fs.stat(blob)).mode&0o777,0o400);
 assert.equal((await fs.readdir(path.join(service.artifacts.ownerRoot(user),'uploads'))).length,0);assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='skill' AND deleted_at IS NULL")).rows[0].n,1);
 assert.equal(hash(Buffer.from(source.snapshot.entries.find(entry=>entry.path==='资料/证据.csv').bytesBase64,'base64')),resource.digest.slice(7));
 // Source/runtime authority is a controlled transport fixture here; real source bytes, isolated validator and PG are actual.
});

test('duplicate row and idempotency pointer roll back together when durable receipt publication fails',options,async()=>{
 const original=service.documents.put.bind(service.documents);service.documents.put=async(...args)=>{if(args[1]==='extension-resource')throw new Error('outbox fixture failure');return original(...args);};
 try{await assert.rejects(service.duplicateNative(user,project,{sessionId:'catalogue-session',key:source.snapshot.key,title:'Rollback fixture',idempotencyKey:'rollback-copy',expectedRuntimeGeneration:'actual-fixture-epoch'}),/outbox fixture failure/);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='skill' AND deleted_at IS NULL")).rows[0].n,1);
 }finally{service.documents.put=original;}
});
