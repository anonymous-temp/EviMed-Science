/** Executed in contained build state; inspect artifact bytes only, never load dependencies. */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateOverlayClosure} from './closure.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pinsBytes=await fs.readFile('/adapter/overlay/pins.json'),pins=JSON.parse(pinsBytes);
const closureBytes=await fs.readFile('/work/dependency-closure.json'),closure=JSON.parse(closureBytes);
validateOverlayClosure(closure);
const manifests=[];
for(const item of closure.packages){
  const bytes=await fs.readFile('/work/deploy-publication/'+item.manifest);
  const directory=item.manifest.slice(0,item.manifest.lastIndexOf('/'));
  const licenses=closure.files.filter(entry=>entry.path.startsWith(directory+'/')&&!entry.path.slice(directory.length+1).includes('/')&&/^(?:licen[sc]e|copying)(?:\.|$)/i.test(entry.path.slice(directory.length+1)));
  manifests.push({name:item.name,version:item.version,license:item.license,path:item.manifest,sha256:hash(bytes),licenseFiles:licenses});
}
const record={schemaVersion:1,sourceCommit:pins.sourceCommit,upstreamLockSha256:hash(await fs.readFile('/work/upstream-pnpm-lock.yaml')),
  overlayPinsSha256:hash(pinsBytes),overrides:pins.overrides,admittedLockSha256:hash(await fs.readFile('/work/pnpm-lock.yaml')),
  dependencyClosureSha256:hash(closureBytes),dependencyClosureDigest:closure.contentDigest,forbiddenPackagesAbsent:pins.forbiddenPublishedPackages,
  artifactLicenseManifests:manifests,qualification:'unverified'};
if(record.admittedLockSha256!==pins.admittedLockSha256)throw new Error('overlay_admitted_lock_changed');
if(record.upstreamLockSha256!==pins.upstreamLockSha256)throw new Error('overlay_upstream_snapshot_differs');
await fs.writeFile('/work/overlay-attestation.json',JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({admittedLockSha256:record.admittedLockSha256,packages:manifests.length,forbiddenPackagesAbsent:record.forbiddenPackagesAbsent,unknownLicenses:0}));
