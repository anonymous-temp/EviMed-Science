import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {ExtensionService} from '../src/extensionService.mjs';
import {ExtensionQualification} from '../src/extensionQualification.mjs';
import {createExtensionRoutes} from '../src/extensionRoutes.mjs';
import {HttpError,sendError} from '../src/security.mjs';
import {EXTENSION_SAAS_CASE_IDS,EXTENSION_SUPPORTED_DSH_VERSION,extensionProofDigest} from '@evimed/domain';

const hash=value=>createHash('sha256').update(value).digest('hex'),digest=value=>`sha256:${hash(value)}`;
const entry={id:'csv',title:'CSV',coordinate:{kind:'npm',name:'example-csv',version:'1.0.0'},executionClass:'isolated-tool',integrity:digest('package'),settingsSchema:{}};
const identity={packageIntegrity:entry.integrity,sourceCommit:null,adapterRevision:digest('adapter'),dshVersion:EXTENSION_SUPPORTED_DSH_VERSION,
  runtimeImageDigest:digest('image'),executionClass:'isolated-tool',permissionProfileRevision:digest('permission'),suiteRevision:digest('suite')};
const surfaces={client:false,browser:false,externalActions:false,descriptorDigest:digest('descriptor')};
const passing=()=>EXTENSION_SAAS_CASE_IDS.map(caseId=>({caseId,status:'pass',observationDigests:[digest(caseId)],artifactDigests:[]}));
const receiptFor=(cases=passing(),forIdentity=identity)=>{const receipt={schemaVersion:1,identity:forIdentity,cases,receiptDigest:''};receipt.receiptDigest=extensionProofDigest(receipt,hash);return receipt;};
test('catalogue flags and package health are not trusted qualification',async()=>{
  const service=new ExtensionService({}, {catalogue:[{...entry,qualified:true,evidenceState:'saas-qualified',health:{ok:true}}]});
  assert.equal((await service.catalogue()).items[0].evidenceState,'source-assessed');
  assert.throws(()=>new ExtensionService({}, {catalogue:[{...entry,settingsSchema:{apiKey:{type:'string'}}}]}),{status:400});
  assert.throws(()=>service.settings(entry,{url:'http://127.0.0.1'}),{status:400});
});
test('qualification requires current external identity and exact artifact rather than stale catalogue pins',async()=>{
  const receipt=receiptFor();
  const authority={trustedReceiptDigests:new Set([receipt.receiptDigest]),trustedSurfaces:surfaces};
  let currentIdentity={...identity};
  const service=new ExtensionService({}, {catalogue:[entry],proofAuthority:async()=>({receipt,authority,currentIdentity})});
  const first=(await service.catalogue()).items[0];
  assert.equal(first.evidenceState,'saas-qualified');assert.deepEqual(first.qualification,{receiptDigest:receipt.receiptDigest});
  // The record is for an earlier identity: a genuine record, so it is shown as stale rather than as none.
  currentIdentity={...identity,runtimeImageDigest:digest('changed-image')};
  const stale=(await service.catalogue()).items[0];
  assert.equal(stale.evidenceState,'qualification-stale');assert.equal(stale.qualification,null);
  // The reader answered for another package altogether: not this package's record.
  currentIdentity={...identity,packageIntegrity:digest('foreign-package')};
  assert.equal((await service.catalogue()).items[0].evidenceState,'source-assessed');
});
test('a deployment written under other source cannot show a record as qualified, and says so beside the items',async()=>{
  const receipt=receiptFor();
  const proofAuthority=async()=>({receipt,authority:{trustedReceiptDigests:new Set([receipt.receiptDigest]),trustedSurfaces:surfaces},currentIdentity:identity});
  const current=await new ExtensionService({}, {catalogue:[entry],proofAuthority,policyState:'current'}).catalogue();
  assert.equal(current.items[0].evidenceState,'saas-qualified');assert.equal(current.policyState,'current');
  const stale=await new ExtensionService({}, {catalogue:[entry],proofAuthority,policyState:'stale'}).catalogue();
  assert.equal(stale.items[0].evidenceState,'qualification-stale');assert.equal(stale.policyState,'stale');
  // Staleness only ever lowers a label: with no record there is nothing to lower, and no state is invented.
  const none=await new ExtensionService({}, {catalogue:[entry],policyState:'stale'}).catalogue();
  assert.equal(none.items[0].evidenceState,'source-assessed');
  assert.equal(Object.hasOwn(await new ExtensionService({}, {catalogue:[entry]}).catalogue(),'policyState'),false);
});

/** The real protected reader over a real directory, and the real routes over a stub store: what a researcher's browser receives. */
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'evimed-qualification-label-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let observed=identity;
  const reader=new ExtensionQualification({root,secret:'test-only-qualification-secret-with-enough-bytes',currentIdentity:async()=>observed,surfaces:async()=>surfaces});
  const file=path.join(root,hash(entry.id)+'.json');
  const write=async({cases=passing(),forIdentity=identity,mode=0o400,signature=null,bodyOverride={}}={})=>{
    const body={schemaVersion:1,catalogueId:entry.id,receipt:receiptFor(cases,forIdentity),surfaces,...bodyOverride};
    await fs.rm(file,{force:true});await fs.writeFile(file,JSON.stringify({body,signature:signature??reader.signature(body)}),{mode});await fs.chmod(file,mode);
  };
  const reports=[];
  const installation={id:'extension:one',revision:1,deletedAt:null,payload:{catalogueId:entry.id,coordinate:entry.coordinate,integrity:entry.integrity,phase:'waiting',prepareJobId:null}};
  const selection={installationId:installation.id,catalogueId:entry.id,coordinate:entry.coordinate,integrity:entry.integrity,enabled:true,settings:{},connectionRefs:[],actorId:'a'};
  const service=new ExtensionService({}, {catalogue:[entry],access:{project:async(user,id)=>{if(id!=='p1')throw new HttpError(404,'project_not_found','Project not found.');return{id,userId:user.id};}},
    proofAuthority:candidate=>reader.authority(candidate),report:finding=>reports.push(finding)});
  service.documents={list:async()=>({items:[installation],nextCursor:null}),get:async(_owner,kind)=>kind==='extension-defaults'?{revision:1,payload:{selections:[selection]}}:installation};
  const store={ensureSessionUser:async()=>({user:{id:'a'}}),assertCsrf:async()=>{}};
  const route=createExtensionRoutes({store,service,maxJsonBytes:8192});
  const server=createServer((req,res)=>route(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(error=>sendError(res,error)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  /** The three routes the extension centre reads, each with its status and the label it carries. */
  const read=async()=>{
    const out={};
    for(const [name,url,pick] of [['catalogue','/api/extensions/catalogue',body=>body.data.items[0]],
      ['installations','/api/extensions/installations',body=>body.data.items[0]],['project','/api/projects/p1/extensions',body=>body.data.selections[0]]]){
      const response=await fetch(base+url);out[name]={status:response.status,label:pick(await response.json()).evidenceState};
    }
    return out;
  };
  return{reader,write,read,reports,file,setIdentity:value=>{observed=value;},service};
}
const allRoutes=(status,label)=>({catalogue:{status,label},installations:{status,label},project:{status,label}});

test('a qualification record that cannot be read is a label on all three routes, never a 503 or a 500',async t=>{
  const f=await fixture(t);
  // No record at all: nothing to report, nothing to refuse.
  assert.deepEqual(await f.read(),allRoutes(200,'source-assessed'));assert.deepEqual(f.reports,[]);
  // A genuine record for exactly the current identity.
  await f.write();assert.deepEqual(await f.read(),allRoutes(200,'saas-qualified'));
  // Each of these used to answer 503 `extension_proof_untrusted` on every one of the three routes.
  const malformed=[
    ['bad signature',()=>f.write({signature:'0'.repeat(64)})],
    ['broad file mode',()=>f.write({mode:0o666})],
    ['not JSON',async()=>{await fs.rm(f.file,{force:true});await fs.writeFile(f.file,'{ not json',{mode:0o400});}],
    ['another catalogue entry',()=>f.write({bodyOverride:{catalogueId:'another'}})],
    ['surfaces that are not the deployment\'s',()=>f.write({bodyOverride:{surfaces:{...surfaces,client:true}}})],
    ['an empty file',async()=>{await fs.rm(f.file,{force:true});await fs.writeFile(f.file,'',{mode:0o400});}],
  ];
  for(const [name,make] of malformed){
    await make();
    assert.deepEqual(await f.read(),allRoutes(200,'source-assessed'),name);
  }
  assert.ok(f.reports.length>0,'the unreadable record is reported for an operator, once per code');
  assert.deepEqual([...new Set(f.reports.map(report=>report.catalogueId))],['csv']);
  assert.ok(f.reports.every(report=>typeof report.code==='string'&&report.code.length>0));
  // The same record read three times by three routes in one minute is one line, not nine.
  const before=f.reports.length;await f.read();await f.read();assert.equal(f.reports.length,before);
});
test('a genuine record for an earlier identity, or with unmet cases, is a label on all three routes, never a 500',async t=>{
  const f=await fixture(t);
  // The code, image, kernel or permission profile moved since the record was made: the record is stale. The reader
  // used to let a non-HTTP error out of the service here, which the server answered as 500 `internal_error`.
  await f.write();f.setIdentity({...identity,runtimeImageDigest:digest('a-newer-image')});
  assert.deepEqual(await f.read(),allRoutes(200,'qualification-stale'));
  f.setIdentity(identity);
  // A signed record whose cases are not all met, or are missing.
  await f.write({cases:passing().slice(1)});assert.deepEqual(await f.read(),allRoutes(200,'qualification-incomplete'));
  await f.write({cases:passing().map((row,index)=>index?row:{...row,status:'fail'})});assert.deepEqual(await f.read(),allRoutes(200,'qualification-incomplete'));
  // Neither is an unreadable record, so neither is reported as one.
  assert.deepEqual(f.reports,[]);
  // The record is made good again and the label follows it.
  await f.write();assert.deepEqual(await f.read(),allRoutes(200,'saas-qualified'));
});
test('the runtime image being unavailable while a record is read is no record, and a failing report hook cannot fail the route',async t=>{
  const f=await fixture(t);await f.write();
  f.setIdentity(undefined);const original=f.reader.currentIdentity;
  f.reader.currentIdentity=async()=>{throw new HttpError(503,'runtime_image_unavailable','The runtime image is unavailable.');};
  assert.deepEqual(await f.read(),allRoutes(200,'source-assessed'));
  f.reader.currentIdentity=async()=>{throw new TypeError('the identity reader itself is broken');};
  f.service.report=()=>{throw new Error('the audit file is unwritable');};
  assert.deepEqual(await f.read(),allRoutes(200,'source-assessed'));
  f.reader.currentIdentity=original;f.setIdentity(identity);
  assert.deepEqual(await f.read(),allRoutes(200,'saas-qualified'));
});
