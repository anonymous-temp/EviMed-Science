import assert from "node:assert/strict";
import crypto, { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { before, after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { CapsuleService } from "../src/capsuleService.mjs";
import { CapsuleIdentityStore } from "../src/capsuleIdentityStore.mjs";
import { CapsuleTransferService } from "../src/capsuleTransferService.mjs";
const run=promisify(execFile);
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??"";
if(url){const parsed=new URL(url);assert.ok(["127.0.0.1","localhost"].includes(parsed.hostname));assert.match(parsed.pathname,/evimed_test/);}
const options={skip:!url};const password="test-only-lifecycle-passphrase";
let root,db,documents,capsules,identities,transfers;const users=[];
before(async()=>{if(!url)return;root=await fs.realpath(await fs.mkdtemp("/tmp/evimed-capsule-lifecycle-"));db=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:6,databaseConnectionTimeoutMs:2000});documents=new ProductDocuments(db);capsules=new CapsuleService(documents);identities=new CapsuleIdentityStore(root);transfers=new CapsuleTransferService({documents,capsules,identities,dataDir:root});});
after(async()=>{if(db){await db.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])",[users]);await db.close();}if(root)await fs.rm(root,{recursive:true,force:true});});
async function account(){const id=`lifecycle_${randomUUID()}`;users.push(id);await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Lifecycle fixture','development')",[id]);return id;}
async function source(owner){const capsule=await capsules.create(owner,{title:"Lifecycle methods"});await capsules.addEntry(owner,capsule.id,{factKind:"method_preference",layer:"methods",content:"Retain study uncertainty."});return capsule;}
async function deleteOwner(owner){await db.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`evimed-user:${owner}`]);await transfers.prepareAccountDeletion(owner,client);await client.query("DELETE FROM evimed_control.users WHERE id=$1",[owner]);});return transfers.finishAccountDeletion(owner);}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

test("account deletion removes private keys and ciphertext, revokes old envelopes, and preserves imported copies",options,async()=>{
  const owner=await account(),recipient=await account(),other=await account();
  const capsule=await source(owner);const exported=await transfers.export(owner,capsule.id,{password});
  const otherCapsule=await source(other);const otherExport=await transfers.export(other,otherCapsule.id,{password});
  const preview=await transfers.preview(recipient,{archive:exported.archive,password});const imported=await transfers.import(recipient,{archive:exported.archive,password,confirmed:true,expectedDigest:preview.archiveSha256});
  const entry=(await capsules.entries(recipient,imported.id)).items[0];await capsules.updateEntry(recipient,imported.id,entry.id,{status:"approved",expectedRevision:entry.revision});await capsules.activate(recipient,imported.id);
  const issuer=JSON.parse(exported.archive).manifest.issuer;await deleteOwner(owner);
  const keyFiles=await fs.readdir(path.join(root,"capsule-keys"));const hash=createHash("sha256").update(owner).digest("hex");
  assert.ok(!keyFiles.includes(`account-${hash}.json`));assert.ok(!keyFiles.includes(`issuer-${issuer.signingKeyId}.json`));
  assert.ok(!(await fs.readdir(path.join(root,"capsule-snapshots"))).some(name=>name.includes(exported.snapshot.id)));
  const after=await transfers.preview(recipient,{archive:exported.archive,password});assert.equal(after.hostedStatus,"revoked");assert.equal(after.canImport,false);
  assert.equal((await capsules.recall(recipient,{query:"uncertainty"})).items.length,1);
  assert.equal((await transfers.download(other,otherCapsule.id,otherExport.snapshot.id)).archive,otherExport.archive);
  await transfers.finishAccountDeletion(owner);
});

test("failed post-commit filesystem cleanup resumes at startup without a live account losing its keys",options,async()=>{
  const owner=await account();const capsule=await source(owner);const exported=await transfers.export(owner,capsule.id,{password});
  await assert.rejects(db.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`evimed-user:${owner}`]);await transfers.prepareAccountDeletion(owner,client);throw new Error("test-only-rollback");}));
  const hash=createHash("sha256").update(owner).digest("hex");assert.ok(await fs.stat(path.join(root,"capsule-keys",`account-${hash}.json`)));
  await transfers.recoverPendingDeletions();assert.ok(await fs.stat(path.join(root,"capsule-keys",`account-${hash}.json`)));
  await db.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`evimed-user:${owner}`]);await transfers.prepareAccountDeletion(owner,client);await client.query("DELETE FROM evimed_control.users WHERE id=$1",[owner]);});
  const unlink=fs.unlink;try{fs.unlink=async target=>{if(String(target).includes(exported.snapshot.id))throw Object.assign(new Error("test-only-permission-failure"),{code:"EACCES"});return unlink(target);};await assert.rejects(transfers.finishAccountDeletion(owner),{code:"capsule_cleanup_pending"});}finally{fs.unlink=unlink;}
  await new CapsuleTransferService({documents,capsules,identities:new CapsuleIdentityStore(root),dataDir:root}).recoverPendingDeletions();
  assert.ok(!(await fs.readdir(path.join(root,"capsule-keys"))).includes(`account-${hash}.json`));
  assert.equal((await db.query("SELECT id FROM evimed_control.users WHERE id=$1",[owner])).rowCount,0);
});

test("an export finishing KDF after deletion cannot publish files or regenerate private keys",options,async()=>{
  const owner=await account();const capsule=await source(owner);const reached=deferred();let resume;
  const original=crypto.scrypt;
  try{crypto.scrypt=(...args)=>{const callback=args.pop();return original(...args,(error,key)=>{resume=()=>callback(error,key);reached.resolve();});};syncBuiltinESMExports();
    const exporting=transfers.export(owner,capsule.id,{password});const outcome=exporting.then(value=>({value}),error=>({error}));await reached.promise;
    await deleteOwner(owner);resume();const result=await outcome;assert.equal(result.error.code,"product_account_changed");
    const hash=createHash("sha256").update(owner).digest("hex");assert.ok(!(await fs.readdir(path.join(root,"capsule-keys"))).includes(`account-${hash}.json`));
    assert.ok(!(await fs.readdir(path.join(root,"capsule-snapshots"))).some(name=>name.startsWith(hash)));
  }finally{crypto.scrypt=original;syncBuiltinESMExports();}
});

test("revocation completed while import waits is checked inside its persistence transaction",options,async()=>{
  const owner=await account(),recipient=await account();const capsule=await source(owner);const exported=await transfers.export(owner,capsule.id,{password});
  const preview=await transfers.preview(recipient,{archive:exported.archive,password});const reached=deferred(),resume=deferred();const paused=Object.create(documents);
  paused.createBatch=async(...args)=>{reached.resolve();await resume.promise;return documents.createBatch(...args);};
  const service=new CapsuleTransferService({documents:paused,capsules,identities,dataDir:root});
  const importing=service.import(recipient,{archive:exported.archive,password,confirmed:true,expectedDigest:preview.archiveSha256});const outcome=importing.then(value=>({value}),error=>({error}));
  await reached.promise;await transfers.revoke(owner,capsule.id,exported.snapshot.id,exported.snapshot.revision);resume.resolve();
  assert.equal((await outcome).error.code,"capsule_snapshot_revoked");assert.equal((await capsules.list(recipient)).items.length,0);
});

test("delete and recreate the same account ID does not admit an old in-flight import",options,async()=>{
  const owner=await account(),recipient=await account();const capsule=await source(owner);const exported=await transfers.export(owner,capsule.id,{password});const preview=await transfers.preview(recipient,{archive:exported.archive,password});
  const reached=deferred(),resume=deferred();const paused=Object.create(documents);paused.createBatch=async(...args)=>{reached.resolve();await resume.promise;return documents.createBatch(...args);};
  const service=new CapsuleTransferService({documents:paused,capsules,identities,dataDir:root});const importing=service.import(recipient,{archive:exported.archive,password,confirmed:true,expectedDigest:preview.archiveSha256});const outcome=importing.then(value=>({value}),error=>({error}));
  await reached.promise;await deleteOwner(recipient);await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Recreated fixture','development')",[recipient]);resume.resolve();
  assert.equal((await outcome).error.code,"product_account_changed");assert.equal((await capsules.list(recipient)).items.length,0);
});

test("encrypted local backup restores signing identities and ciphertext snapshots with protected modes",options,async()=>{
  const owner=await account(),recipient=await account();const capsule=await source(owner);const exported=await transfers.export(owner,capsule.id,{password});
  const storage=await fs.realpath(await fs.mkdtemp("/tmp/evimed-capsule-backup-"));
  try{const passFile=path.join(storage,"backup-passphrase");await fs.writeFile(passFile,"test-only-encrypted-backup-passphrase",{mode:0o600});
    const env={...process.env,OPEN_SCIENCE_BACKUP_PASSPHRASE:"",OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE:passFile,OPEN_SCIENCE_OBJECT_BACKUP_URI:"",OPEN_SCIENCE_BACKUP_RETENTION_DAYS:"",OPEN_SCIENCE_RESTORE_REPLACE:"false"};
    const backup=await run("bash",["scripts/ops/backup-data.sh",root,path.join(storage,"backups")],{cwd:process.cwd(),env});const archive=backup.stdout.trim().split("\n").at(-1);assert.match(archive,/\.tar\.gz\.enc$/);
    const restored=path.join(storage,"restored");await run("bash",["scripts/ops/restore-data.sh",archive,restored],{cwd:process.cwd(),env});
    const restoredService=new CapsuleTransferService({documents,capsules,identities:new CapsuleIdentityStore(restored),dataDir:restored});
    const download=await restoredService.download(owner,capsule.id,exported.snapshot.id);assert.equal(download.archive,exported.archive);
    const preview=await restoredService.preview(recipient,{archive:download.archive,password});assert.equal(preview.issuerTrust,"verified");assert.equal(preview.entries.length,1);
    assert.equal((await fs.stat(path.join(restored,"capsule-keys"))).mode&0o777,0o700);
    for(const file of await fs.readdir(path.join(restored,"capsule-keys")))assert.equal((await fs.stat(path.join(restored,"capsule-keys",file))).mode&0o777,0o600);
  }finally{await fs.rm(storage,{recursive:true,force:true});}
});
