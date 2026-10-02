/** Actual protected reader/signature refusals. Empty cases deliberately cannot qualify any artifact. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson, extensionProofDigest, qualifyExtensionProof } from '@evimed/domain';
import { ExtensionQualification } from '../../apps/server/src/extensionQualification.mjs';
import { loadExtensionDeployment, deploymentProofIdentity } from '../../apps/server/src/extensionDeployment.mjs';
import { openScopedFileNoFollow, readStableFileHandle } from '../../apps/server/src/security.mjs';
import { extensionRequestObject } from '../../apps/server/src/extensionAccess.mjs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assessmentDockerEnvironment } from './extension-saas-acceptance-docker.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'), digest=value=>'sha256:'+hash(value);
/** Complete measurement and separate operator review, never component observations or a qualification flag. */
export function reviewedQualificationReceipt(measurement,review,currentIdentity,surfaces,currentSourceHashes,now=Date.now()){
 extensionRequestObject(review,['schemaVersion','decision','measurementDigest','identityDigest','sourceHashes','reviewedAt']);
 if(review.schemaVersion!==1||review.decision!=='approved-complete-measurements'||review.measurementDigest!==digest(canonicalJson(measurement))
  ||review.identityDigest!==digest(canonicalJson(currentIdentity))||canonicalJson(review.sourceHashes)!==canonicalJson(currentSourceHashes)
  ||!Number.isFinite(Date.parse(review.reviewedAt))||Date.parse(review.reviewedAt)>now||now-Date.parse(review.reviewedAt)>6*3600000
  ||measurement?.qualified!==false||measurement?.cleanup?.physicallyJoined!==true||!Array.isArray(measurement.cases)||measurement.cases.length!==22)throw new Error('qualification_measurements_not_reviewed');
 for(const row of measurement.cases){
  if(!['pass','not-applicable'].includes(row.status)||!Array.isArray(row.uncovered)||row.uncovered.length
   ||!Array.isArray(row.observations)||!row.observations.length||!Array.isArray(row.observationDigests)||!Array.isArray(row.artifactDigests)||!row.artifactDigests.length)throw new Error('qualification_measurements_incomplete');
  const observed=new Set(row.observations.map(value=>digest(canonicalJson(value))));
  if(row.observationDigests.some(value=>!observed.has(value)&&!(row.status==='not-applicable'&&value===surfaces.descriptorDigest)))throw new Error('qualification_observation_changed');
 }
 const receipt={schemaVersion:1,identity:currentIdentity,cases:measurement.cases.map(row=>({caseId:row.caseId,status:row.status,
  observationDigests:row.observationDigests,artifactDigests:row.artifactDigests,...(row.reason?{reason:row.reason}:{})}))};receipt.receiptDigest=extensionProofDigest(receipt,hash);
 qualifyExtensionProof(receipt,currentIdentity,{sha256Hex:hash,trustedReceiptDigests:new Set([receipt.receiptDigest]),trustedSurfaces:surfaces});
 return receipt;
}
async function protectedQualificationBytes(file){
 if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('invalid_qualification_path');const root=path.dirname(file),stat=await fs.lstat(root);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o7777)!==0o700||await fs.realpath(root)!==root)throw new Error('untrusted_qualification_parent');
 const opened=await openScopedFileNoFollow(root,file);try{if(opened.stat.uid!==process.getuid()||(opened.stat.mode&0o7777)!==0o400||opened.stat.size>4*1024*1024)throw new Error('untrusted_qualification_material');const bytes=await readStableFileHandle(opened.handle,opened.stat);return bytes;}finally{await opened.handle.close();}
}
const SIGNER_SOURCE_FILES=['scripts/ops/extension-saas-acceptance-linux.mjs','scripts/ops/extension-saas-acceptance.mjs','scripts/ops/extension-saas-acceptance-authority.mjs','scripts/ops/extension-saas-acceptance-composition.mjs','scripts/ops/extension-saas-acceptance-journey.mjs','scripts/ops/extension-saas-acceptance-native.mjs','scripts/ops/extension-saas-acceptance-proof.mjs','scripts/ops/extension-saas-acceptance-boundaries.mjs','scripts/ops/extension-saas-acceptance-inputs.mjs','scripts/ops/extension-saas-acceptance-docker.mjs','scripts/ops/extension-saas-acceptance-manifest.mjs','scripts/ops/extension-saas-acceptance-contained.mjs','scripts/ops/extension-saas-acceptance-ledger.mjs','apps/server/test/helpers/nativeSkillValidationFixture.mjs','apps/server/test/helpers/geoTestDatabase.mjs','scripts/runtime/extensions/cowork/fixtures.mjs','apps/server/src/extensionAssessmentAuthority.mjs','apps/server/src/extensionGenerationService.mjs','apps/server/src/extensionGenerationWorker.mjs','apps/server/src/extensionHostedIntegration.mjs','apps/server/src/extensionControllerComposition.mjs','apps/server/src/runtimeControllerServer.mjs','apps/server/src/runtimeManager.mjs','apps/server/src/server.mjs','packages/socket/extensions/cowork/bridge.mjs','packages/harness-port/src/pluginProbe.mjs'];
/** Separate explicit issuance command. The qualification key is opened only after complete protected material and independent review pass. */
export async function issueReviewedQualification(inputsPath){
 const inputs=JSON.parse((await protectedQualificationBytes(inputsPath)).toString('utf8'));
 extensionRequestObject(inputs,['schemaVersion','dataDir','measurementPath','reviewPath','signingKeyPath','outputRoot']);
 if(inputs.schemaVersion!==1||path.basename(inputsPath)!=='qualification-signing-inputs.json'||path.basename(inputs.signingKeyPath)!=='qualification-signing.key')throw new Error('invalid_qualification_issuance_inputs');
 const measurement=JSON.parse((await protectedQualificationBytes(inputs.measurementPath)).toString('utf8')),review=JSON.parse((await protectedQualificationBytes(inputs.reviewPath)).toString('utf8'));
 const deployment=loadExtensionDeployment({dataDir:inputs.dataDir}),entry=deployment.catalogue.find(item=>item.id===measurement.subject?.descriptor?.id),surface=deployment.surfaces.get(entry?.id);
 const outputStat=await fs.lstat(inputs.outputRoot),dataStat=await fs.lstat(inputs.dataDir);
 if(deployment.status!=='configured'||!entry||!surface||!dataStat.isDirectory()||dataStat.uid!==process.getuid()||(dataStat.mode&0o7777)!==0o700||await fs.realpath(inputs.dataDir)!==inputs.dataDir
  ||!outputStat.isDirectory()||outputStat.isSymbolicLink()||outputStat.uid!==process.getuid()||(outputStat.mode&0o7777)!==0o700||await fs.realpath(inputs.outputRoot)!==inputs.outputRoot
  ||inputs.outputRoot===inputs.dataDir||inputs.outputRoot.startsWith(inputs.dataDir+path.sep)||inputs.signingKeyPath.startsWith(inputs.dataDir+path.sep))throw new Error('qualification_writer_not_separate');
 const sourceHashes={};for(const file of SIGNER_SOURCE_FILES)sourceHashes[file]=digest(await fs.readFile(new URL('../../'+file,import.meta.url)));
 // This gate runs before daemon inspection and before touching qualification key material.
 const claimedImage=measurement.subject.nativeImage,currentClaim=deploymentProofIdentity(deployment,entry,claimedImage);
 const receipt=reviewedQualificationReceipt(measurement,review,currentClaim,surface,sourceHashes);
 if(canonicalJson(measurement.subject.sourcePolicy)!==canonicalJson(deployment.policy)||measurement.subject.artifactDigest!==deployment.admittedArtifacts.find(item=>item.id===entry.id)?.artifactDigest)throw new Error('qualification_subject_changed');
 const image=(await promisify(execFile)('docker',['image','inspect','--format','{{.Id}}',claimedImage],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:8192})).stdout.trim();
 if(image!==claimedImage)throw new Error('qualification_runtime_image_changed');
 const secret=(await protectedQualificationBytes(inputs.signingKeyPath)).toString('utf8').trim();if(Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>8192)throw new Error('invalid_qualification_signing_key');
 const reader=new ExtensionQualification({root:inputs.outputRoot,secret,currentIdentity:async()=>deploymentProofIdentity(loadExtensionDeployment({dataDir:inputs.dataDir}),entry,image),surfaces:async()=>surface});
 const body={schemaVersion:1,catalogueId:entry.id,receipt,surfaces:surface},envelope={body,signature:reader.signature(body)},file=path.join(inputs.outputRoot,hash(entry.id)+'.json');
 await fs.writeFile(file,canonicalJson(envelope)+'\n',{mode:0o400,flag:'wx'});const verified=await reader.authority(entry);
 if(verified.receipt.receiptDigest!==receipt.receiptDigest)throw new Error('qualification_published_record_changed');
 return{status:'issued-reviewed-measurement-receipt',receiptDigest:receipt.receiptDigest,recordPath:file,ordinaryQualifiedSmoke:'required-separate-stage'};
}
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
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==3||process.argv[2]!=='--issue-qualification')throw new Error('explicit_qualification_issuance_required');process.stdout.write(JSON.stringify(await issueReviewedQualification(process.env.EVIMED_EXTENSION_QUALIFICATION_INPUTS))+'\n');}
 catch(error){process.stderr.write(JSON.stringify({status:'refused',qualified:false,code:error.code??error.message??'qualification_issuance_refused'})+'\n');process.exitCode=1;}
}
