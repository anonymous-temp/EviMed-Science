import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, readdir, symlink, chmod } from "node:fs/promises";
import path from "node:path";
import { before, after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname)); assert.match(parsed.pathname,/evimed_test/); }
const options = { skip: !url };
const owner = `transfer_${randomUUID()}`;
const recipient = `transfer_${randomUUID()}`;
let directory, database, documents, capsules, identities, transfers;
const password = "test-only-transfer-passphrase";
before(async()=>{
  if(!url)return;
  directory=await mkdtemp("/tmp/evimed-transfer-");
  database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Transfer owner','development'),($2,'Transfer recipient','development')",[owner,recipient]);
  documents=new ProductDocuments(database);capsules=new CapsuleService(documents);
  identities=new CapsuleIdentityStore(directory);transfers=new CapsuleTransferService({documents,capsules,identities,dataDir:directory});
});
after(async()=>{if(database){await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])",[[owner,recipient]]);await database.close();}if(directory)await rm(directory,{recursive:true,force:true});});

async function source(){
  const capsule=await capsules.create(owner,{title:"Private source title"});
  await capsules.addEntry(owner,capsule.id,{factKind:"method_preference",layer:"methods",content:"Preserve reproducible analysis steps.",provenance:[{type:"run",id:"private-run-id"}]});
  await capsules.addEntry(owner,capsule.id,{factKind:"profile",layer:"profile",content:"Private profile canary"});
  await capsules.addEntry(owner,capsule.id,{factKind:"project_fact",layer:"knowledge",content:"Private knowledge canary"});
  await capsules.addEntry(owner,capsule.id,{factKind:"preference",layer:"profile",content:"Unapproved canary",origin:"inferred"});
  await capsules.addEntry(owner,capsule.id,{factKind:"analysis",layer:"sources",content:"Never share source canary"});
  return capsule;
}

test("identities persist outside workspaces under protected files and resolve local issuer trust",options,async()=>{
  const first=await identities.forUser(owner);const second=await new CapsuleIdentityStore(directory).forUser(owner);
  assert.equal(first.issuerId,second.issuerId);assert.equal(first.signing.keyId,second.signing.keyId);
  assert.notEqual(first.issuerId,owner);
  assert.equal((await stat(path.join(directory,"capsule-keys"))).mode&0o777,0o700);
  for(const name of await readdir(path.join(directory,"capsule-keys")))assert.equal((await stat(path.join(directory,"capsule-keys",name))).mode&0o777,0o600);
  assert.equal((await identities.resolve(first.issuerId,first.signing.keyId)).ownerId,owner);
  assert.equal(await identities.resolve("foreign",first.signing.keyId),null);
});

test("identity storage refuses a symlinked key directory",async()=>{
  const root=await mkdtemp("/tmp/evimed-key-symlink-");const target=await mkdtemp("/tmp/evimed-key-target-");
  try{await symlink(target,path.join(root,"capsule-keys"));await assert.rejects(new CapsuleIdentityStore(root).forUser("test-owner"),{code:"capsule_identity_unavailable"});}
  finally{await rm(root,{recursive:true,force:true});await rm(target,{recursive:true,force:true});}
});

test("default export is encrypted and excludes private profile, knowledge, raw identity and provenance",options,async()=>{
  const capsule=await source();const result=await transfers.export(owner,capsule.id,{password,scopes:["workstyle"]});
  assert.match(result.filename,/\.evimedcap$/);assert.equal(typeof result.archive,"string");
  for(const value of [owner,recipient,"Private profile canary","Preserve reproducible", "private-run-id", "Never share source canary"])assert.ok(!result.archive.includes(value));
  const preview=await transfers.preview(recipient,{archive:result.archive,password});
  assert.equal(preview.issuerTrust,"verified");assert.equal(preview.hostedStatus,"active");assert.equal(preview.entries.length,1);
  assert.match(preview.entries[0].path,/^methods\/.+\/SKILL\.md$/);assert.equal(preview.entries[0].version,1);
  assert.ok(!JSON.stringify(preview).includes("private-run-id"));
  assert.equal((await transfers.history(owner,capsule.id)).items[0].id,result.snapshot.id);
  assert.equal(result.snapshot.entryVersions[0].version,1);assert.match(result.snapshot.entryVersions[0].sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(transfers.history(recipient,capsule.id),{code:"capsule_not_found"});
  assert.equal((await transfers.download(owner,capsule.id,result.snapshot.id)).archive,result.archive);
  const stored=await documents.get(owner,"preferences",result.snapshot.id);
  assert.ok(!JSON.stringify(stored).includes(password));assert.ok(!JSON.stringify(stored).includes("PRIVATE KEY"));
});

test("explicit profile/knowledge scopes import only as candidates in a new capsule",options,async()=>{
  const capsule=await source();const result=await transfers.export(owner,capsule.id,{password,scopes:["workstyle","+profile","+knowledge"]});
  const preview=await transfers.preview(recipient,{archive:result.archive,password});assert.equal(preview.entries.length,3);
  const imported=await transfers.import(recipient,{archive:result.archive,password,expectedDigest:preview.archiveSha256,confirmed:true,title:"Imported methods"});
  assert.notEqual(imported.id,capsule.id);assert.equal(imported.payload.imported,true);
  const entries=await capsules.entries(recipient,imported.id);assert.equal(entries.items.length,3);
  assert.ok(entries.items.every(item=>item.payload.status==="candidate"&&item.payload.contextOnly));
  assert.ok(entries.items.every(item=>item.payload.provenance[0].type==="import"&&item.payload.transfer.version===1));
  assert.equal((await capsules.active(recipient)).items.length,0);
  await assert.rejects(transfers.import(recipient,{archive:result.archive,password,expectedDigest:"0".repeat(64),confirmed:true}),{code:"capsule_preview_changed"});
  await assert.rejects(transfers.import(recipient,{archive:result.archive,password,expectedDigest:preview.archiveSha256,confirmed:false}),{code:"capsule_import_confirmation_required"});
});

test("foreign signing keys stay unverified and revoked local snapshots cannot be imported",options,async()=>{
  const capsule=await source();const result=await transfers.export(owner,capsule.id,{password});
  const foreignDir=await mkdtemp("/tmp/evimed-foreign-registry-");
  try{const foreign=new CapsuleTransferService({documents,capsules,identities:new CapsuleIdentityStore(foreignDir),dataDir:foreignDir});
    assert.equal((await foreign.preview(recipient,{archive:result.archive,password})).issuerTrust,"unverified");
  }finally{await rm(foreignDir,{recursive:true,force:true});}
  await assert.rejects(transfers.revoke(recipient,capsule.id,result.snapshot.id,result.snapshot.revision),{code:"capsule_not_found"});
  await transfers.revoke(owner,capsule.id,result.snapshot.id,result.snapshot.revision);
  const preview=await transfers.preview(recipient,{archive:result.archive,password});assert.equal(preview.hostedStatus,"revoked");assert.equal(preview.canImport,false);
  await assert.rejects(transfers.import(recipient,{archive:result.archive,password,expectedDigest:preview.archiveSha256,confirmed:true}),{code:"capsule_snapshot_revoked"});
});

test("invalid passwords/envelopes/base64 and failed batch imports leave no partial capsule",options,async()=>{
  const capsule=await source();const result=await transfers.export(owner,capsule.id,{password});
  await assert.rejects(transfers.preview(recipient,{archive:result.archive,password:"test-only-wrong-passphrase"}),{code:"capsule_transfer_open_failed"});
  for(const archive of ["{}", "{".repeat(100), JSON.stringify({...JSON.parse(result.archive),extra:true}), result.archive.replace('"passwordWrap":"','"passwordWrap":"!')]){
    await assert.rejects(transfers.preview(recipient,{archive,password}));
  }
  const before=(await capsules.list(recipient)).items.length;
  let batchCalls=0;const faultingDocuments=Object.create(documents);faultingDocuments.createBatch=async()=>{batchCalls++;throw new Error("test-only-insert-failure");};
  const faulting=new CapsuleTransferService({documents:faultingDocuments,capsules,identities,dataDir:directory});
  const preview=await transfers.preview(recipient,{archive:result.archive,password});
  await assert.rejects(faulting.import(recipient,{archive:result.archive,password,expectedDigest:preview.archiveSha256,confirmed:true}));
  assert.equal(batchCalls,1);assert.equal((await capsules.list(recipient)).items.length,before);
});

test("updating creates a new immutable hosted snapshot and exposes replacement status",options,async()=>{
  const capsule=await source();const first=await transfers.export(owner,capsule.id,{password});
  const second=await transfers.export(owner,capsule.id,{password,supersedes:first.snapshot.id});
  assert.notEqual(first.snapshot.id,second.snapshot.id);
  assert.equal((await transfers.preview(recipient,{archive:first.archive,password})).newerSnapshotId,second.snapshot.id);
  assert.equal((await transfers.download(owner,capsule.id,first.snapshot.id)).archive,first.archive);
});


test("permissive identity files are refused rather than loaded",async()=>{
  const root=await mkdtemp("/tmp/evimed-key-permissions-");
  try{const store=new CapsuleIdentityStore(root);await store.forUser("test-only-owner");const directory=path.join(root,"capsule-keys");
    const file=(await readdir(directory)).find(name=>name.startsWith("account-"));await chmod(path.join(directory,file),0o644);
    await assert.rejects(store.forUser("test-only-owner"),{code:"capsule_identity_unavailable"});
  }finally{await rm(root,{recursive:true,force:true});}
});
