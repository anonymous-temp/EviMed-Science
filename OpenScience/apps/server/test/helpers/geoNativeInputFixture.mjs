import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.mjs';
import { PostgresStore } from '../../src/store.mjs';
import { ProductDocuments } from '../../src/productStore.mjs';
import { GeoStore } from '../../src/geoStore.mjs';
import { GeoService } from '../../src/geoService.mjs';
import { GeoNativeAuthority } from '../../src/geoNativeAuthority.mjs';
import { GeoSharedContext } from '../../src/geoSharedContext.mjs';
import { GeoNativeInputs } from '../../src/geoNativeInputs.mjs';
import { PluginService } from '../../src/pluginService.mjs';
import { HttpError } from '../../src/security.mjs';
import { createGeoTestDatabase } from './geoTestDatabase.mjs';
export async function createNativeInputFixture(t, poolMax=1) {
  const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'gninput');
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'gn-input-'));
  const config=loadConfig({dataDir,databaseUrl:isolated.url,stateStore:'postgres',devAuth:true,runtimeMode:'mock',runtimeUiProxyEnabled:true,publicUrl:'https://science.example',runtimeUiPublicOrigin:'https://science.example:8443',geoEnabled:true,geoAudience:'all',databasePoolMax:poolMax,databaseConnectionTimeoutMs:700});
  const accounts=new PostgresStore(config), db=accounts.database;
  t.after(async()=>{await db.close();await isolated.drop();await rm(dataDir,{recursive:true,force:true});});
  for(const id of ['owner','editor','editor2'])await accounts.createUser(id,'fixture-password',id);
  const users={};for(const id of ['owner','editor','editor2'])users[id]=await accounts.userById(id);
  const project=await accounts.requireProject(users.owner,'default');
  const store=new GeoStore({database:db});await store.ready();
  const geo=await store.createProject({userId:users.owner.id,projectId:project.id,engines:['deepseek'],coverageDays:90});
  for(const id of ['editor','editor2'])await store.addMember({geoId:geo.id,userId:id,role:'editor',invitedBy:'owner'});
  const documents=new ProductDocuments(db), service=new GeoService({store,config});
  const authority=new GeoNativeAuthority({store,accounts,service,documents,results:{scope:async()=>{throw new HttpError(404,'none','none');}},runs:async()=>[],createSession:async()=>({id:'root'}),ensureSession:async()=>{}});
  await authority.registerPrimary(geo,'root');
  const policies=new GeoSharedContext({database:db,documents});const policy=await policies.forProject(project);
  let launched={generation:'generation',referenceId:'launch-fixture',digest:'1'.repeat(64)};
  const journal=new GeoNativeInputs({database:db,documents,authority,policies,resolveLaunchedContext:async()=>launched,
    proveSession:async({receipt})=>({namespaceId:policy.namespace.id,rootSessionId:'root',generation:receipt.runtime.generation,
      launchedContextRef:receipt.runtime.launchedContextRef,launchedContextDigest:receipt.runtime.launchedContextDigest})});
  const plugin=new PluginService(db);
  const claims=async user=>({frameId:`frame-${user.id}`,userId:user.id,projectId:project.id,delegation:{...(await authority.resolve(user,{kind:'geo',geoProjectId:geo.id,sessionId:'root'})).principal,rootSessionId:'root'}});
  const prepare=async(request,user=users.editor)=>{const frame=await claims(user);await journal.prepare({user,project,claims:frame,request});return frame;};
  const execute=async(request,frame,business)=>{
    try{return await plugin.withAdmission(project,async()=>{
      const result=await journal.execute(request,operation=>authority.withFrame(users[frame.userId],frame.delegation,operation),business);
      if(result.error)throw result.error;return result.value;
    },{prompt:true,promptDisposition:()=>journal.disposition(request)});}
    catch(error){await journal.afterAdmission(request,error);throw error;}
  };
  const request=id=>({requestId:id,sessionId:'root',mode:'queue',content:[{type:'text',text:`user ${id}`} ]});
  return {config,accounts,store,service,db,documents,project,users,authority,policy,geo,prepare,execute,journal,request,setLaunch:value=>{launched=value;},claims};
}
