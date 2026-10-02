/** Actual protected reader/signature refusals. Empty cases deliberately cannot qualify any artifact. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson, extensionProofDigest } from '@evimed/domain';
import { ExtensionQualification } from '../../apps/server/src/extensionQualification.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'), digest=value=>'sha256:'+hash(value);
export async function runProofRefusalControls() {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'evimed-saas-proof-refusal-')));
 const pin=JSON.parse(await fs.readFile(new URL('../../deps-version.json',import.meta.url),'utf8')).dsh.version;
 // This identity is contract SETUP only; no case gets a pass and no candidate artifact is qualified.
 const original={packageIntegrity:digest('controlled-package'),sourceCommit:hash('controlled-source').slice(0,40),adapterRevision:digest('controlled-adapter'),runtimeImageDigest:digest('controlled-image'),permissionProfileRevision:digest('controlled-permission'),suiteRevision:digest('controlled-suite'),dshVersion:pin,executionClass:'isolated-tool'};
 const entry={id:'refusal-only'}, surfaces={client:false,browser:false,externalActions:false,descriptorDigest:digest('controlled-surfaces')};
 let current=original, report;
 const reader=new ExtensionQualification({root,secret:randomBytes(32).toString('hex'),currentIdentity:async()=>current,surfaces:async()=>surfaces});
 const file=path.join(root,hash(entry.id)+'.json');
 const receipt={schemaVersion:1,identity:original,cases:[]}; receipt.receiptDigest=extensionProofDigest(receipt,hash);
 const body={schemaVersion:1,catalogueId:entry.id,receipt,surfaces}, signed={body,signature:reader.signature(body)};
 const write=async value=>{await fs.rm(file,{force:true});await fs.writeFile(file,canonicalJson(value),{mode:0o400});};
 const refuses=async expected=>{let code; await assert.rejects(reader.authority(entry),error=>{code=error.code;return expected.includes(code);});return code;};
 try {
  assert.equal(await reader.authority(entry),null);await write(signed);
  const incomplete=await refuses(['extension_proof_incomplete']);const identityDrifts={};
  for(const field of ['packageIntegrity','sourceCommit','adapterRevision','dshVersion','runtimeImageDigest','permissionProfileRevision','suiteRevision','executionClass']) {
   const changed=field==='sourceCommit'?hash('changed-source').slice(0,40):field==='dshVersion'?'invalid-version':field==='executionClass'?'local-only':digest('changed-'+field);
   current={...original,[field]:changed};identityDrifts[field]=await refuses(['extension_proof_stale','extension_contract_invalid']);
  }
  current=original;await write({...signed,signature:'0'.repeat(64)});const signatureTamper=await refuses(['extension_proof_untrusted']);
  await write({...signed,body:{...body,receipt:{...receipt,cases:[{caseId:'SAAS-01',status:'unknown',observationDigests:[],artifactDigests:[]}]}}});const outcomeTamper=await refuses(['extension_proof_untrusted']);
  await write({...signed,body:{...body,surfaces:{...surfaces,client:true}}});const surfaceTamper=await refuses(['extension_proof_untrusted']);
  await write(signed);await fs.chmod(file,0o666);const writableRecord=await refuses(['extension_proof_untrusted']);
  report={qualified:false,receiptsQualified:0,observations:[{caseId:'SAAS-22',scope:'actual-protected-signature-reader-negative-controls',setup:'Ephemeral local signing key and synthetic identity; empty cases deliberately cannot pass, no serving receipt emitted',expected:'Missing/incomplete/tampered/writable records and every identity drift refused',actual:{missing:null,incomplete,identityDrifts,signatureTamper,outcomeTamper,surfaceTamper,writableRecord}}],cleanup:{ownedRootRemoved:true},limitation:'Actual reader refusal behavior; genuine complete measured receipt and final deployment identity remain required.'};
 }finally{await fs.rm(root,{recursive:true,force:true});}
 return report;
}
