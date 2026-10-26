import {seedProposition,approvedBodyHash} from './personal_context.mjs';
// Preparation-only independent agent review of actual frozen native records.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
export const REVIEWED_SEED_MODE='reviewed-authored-seed-with-semantic-check';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const dimensions=['scope','qualification','ordering','negation','noConflictingContent'];
export function nativeReviewRecords(profile){
 if(!Array.isArray(profile.pending)||profile.pending.length||!Array.isArray(profile.records)||profile.records.length>64)throw Error('Review requires settled native profile');
 const records=profile.records.map(r=>({recordId:r.id,uri:r.document?.uri??r.uri??r.id,body:r.value??r.body,version:r.version??null}));
 if(records.some(r=>typeof r.recordId!=='string'||!r.recordId||r.recordId.length>1024||!/^viking:\/\/user\/[^/]+\/memories\//.test(r.uri??'')||typeof r.body!=='string'||Buffer.byteLength(r.body)>32768)||new Set(records.map(r=>JSON.stringify([r.recordId,r.uri]))).size!==records.length)throw Error('Bounded unique native URI/body records required');
 return records.sort((a,b)=>a.uri.localeCompare(b.uri)||String(a.recordId).localeCompare(String(b.recordId))).map(r=>({...r,bodySha256:approvedBodyHash(r.body)}));
}
export function reviewRequest(identity,seeds,profile){
 for(const field of ['runId','arm','contextId','ownerId','projectId','preparedBy'])if(typeof identity?.[field]!=='string'||!identity[field])throw Error('Review identity missing');
 if(!['baseline','candidate'].includes(identity.arm)||!seeds.length||seeds.length>64||new Set(seeds.map(s=>s.id)).size!==seeds.length)throw Error('Review seed identity invalid');
 const records=nativeReviewRecords(profile);
 return {version:1,identity:{...identity},seeds:seeds.map(s=>({id:s.id,statement:s.statement,statementSha256:approvedBodyHash(s.statement),proposition:s.proposition,propositionSha256:approvedBodyHash(seedProposition(s))})),records,profileSha256:hash(records)};
}
export function validateSeedReview(request,manifest){
 if(Buffer.byteLength(JSON.stringify(manifest??null))>131072)throw Error('Review manifest response bound exceeded');
 if(manifest?.requestSha256!==hash(request)||manifest.profileSha256!==request.profileSha256||JSON.stringify(manifest.identity)!==JSON.stringify(request.identity)||manifest.method!=='independent-agent-review')throw Error('Review manifest binding invalid');
 if(!Array.isArray(manifest.reviewers)||manifest.reviewers.length<2||new Set(manifest.reviewers).size!==manifest.reviewers.length||manifest.reviewers.includes(request.identity.preparedBy)||manifest.reviewers.some(r=>typeof r!=='string'||!r))throw Error('Independent review identities required');
 if(!Array.isArray(manifest.assignments)||manifest.assignments.length!==request.seeds.length||new Set(manifest.assignments.map(a=>a.seedId)).size!==request.seeds.length)throw Error('Exact unique seed assignments required');
 const selected={};
 for(const a of manifest.assignments){const seed=request.seeds.find(s=>s.id===a.seedId),record=request.records.find(r=>r.uri===a.uri&&r.recordId===a.recordId&&r.bodySha256===a.bodySha256);if(!seed||!record||a.recordId!==record.recordId||a.statementSha256!==seed.statementSha256||a.propositionSha256!==seed.propositionSha256||a.bodySha256!==record.bodySha256||!dimensions.every(d=>a.verdicts?.[d]===true))throw Error('Reviewed seed dimensions or native body mismatch');selected[a.seedId]={recordId:record.recordId,uri:record.uri,bodySha256:record.bodySha256};}
 return {selected,manifestSha256:hash(manifest),requestSha256:hash(request)};
}
export function verifyReviewedProfile(freeze,seeds,profile,identity){
 if(freeze?.mode!==REVIEWED_SEED_MODE)throw Error('Main quality requires independently reviewed native seed preparation');
 if(seeds.some(seed=>!freeze.reviewSeeds?.some(reviewed=>reviewed.id===seed.id&&approvedBodyHash(reviewed.statement)===approvedBodyHash(seed.statement))))throw Error('Case seed not covered by reviewed manifest');
 const current=reviewRequest(identity,freeze.reviewSeeds,profile);const verified=validateSeedReview(current,freeze.reviewManifest);
 if(verified.manifestSha256!==freeze.reviewManifestSha256||verified.requestSha256!==freeze.reviewRequestSha256)throw Error('Reviewed profile or manifest drift');
 return verified;
}
export function fileSeedReview(directory,{timeoutMs=120000,pollMs=250}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000||!Number.isSafeInteger(pollMs)||pollMs<1)throw Error('Bounded seed review deadline required');
 return async request=>{
  await fs.mkdir(directory,{recursive:true,mode:0o700});const directoryStat=await fs.lstat(directory);if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||(directoryStat.mode&0o077)||directoryStat.uid!==process.getuid())throw Error('Private owned review directory required');const id=hash(request),requestFile=path.join(directory,id+'.request.json'),responseFile=path.join(directory,id+'.review.json');
  try{await fs.writeFile(requestFile,JSON.stringify({...request,requestSha256:id},null,2),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST'||JSON.parse(await fs.readFile(requestFile,'utf8')).requestSha256!==id)throw error;}
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){try{const st=await fs.lstat(responseFile);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>131072)throw Error('Private bounded review response required');const manifest=JSON.parse(await fs.readFile(responseFile,'utf8'));validateSeedReview(request,manifest);return manifest;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(r=>setTimeout(r,pollMs));}
  throw Error('Native seed review unavailable before deadline; preparation inconclusive');
 };
}
