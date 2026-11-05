/** Assemble exact local candidate artifacts. Publication and installation are separate commands. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {HOST_ABI,HOST_PORT_METHODS,SCHEMA_VERSIONS,profileIdentity,validateReleaseManifest} from '../../packages/patient-matching-core/index.mjs';
import {patientMatchingConfiguration} from '../../apps/server/src/patientMatchingConfiguration.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const [directory,receiptDirectory]=process.argv.slice(2);if(!directory||!receiptDirectory)throw new Error('Usage: build-release.mjs <private artifact directory> <public receipt directory>');
const destination=path.resolve(directory),publicDir=path.resolve(receiptDirectory);
const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function artifact(packageDirectory){
 const source=JSON.parse(await fs.readFile(path.join(root,'packages',packageDirectory,'package.json'),'utf8'));
 const filename=`${source.name.replace(/^@/,'').replace('/','-')}-${source.version}.tgz`,artifactPath=path.join(destination,filename);
 const packed=JSON.parse(execFileSync('tar',['-xOf',artifactPath,'package/package.json'],{encoding:'utf8',maxBuffer:1024*1024}));
 if(packed.name!==source.name||packed.version!==source.version)throw new Error('Packed identity differs from the selected source package.');
 const bytes=await fs.readFile(artifactPath);
 return {coordinate:{package:packed.name,version:packed.version,integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`},digest:hash(bytes),path:artifactPath};
}
const core=await artifact('patient-matching-core'),bundle=await artifact('patient-matching-plugin'),calculator=await artifact('patient-matching-worker');
const pins=JSON.parse(await fs.readFile(path.join(root,'deps-version.json'),'utf8')),seam=await fs.readFile(path.join(root,'packages/harness-port/seam-manifest.json'));
const worker=JSON.parse(await fs.readFile(path.join(destination,'worker-image.json'),'utf8'));
if(!/^sha256:[a-f0-9]{64}$/.test(worker.workerImageDigest))throw new Error('An actual immutable worker image is required.');
const oci=JSON.parse(execFileSync('tar',['-xOf',path.join(destination,'patient-matching-worker.oci.tar'),'index.json'],{encoding:'utf8',maxBuffer:1024*1024}));
const workerOciManifestDigest=oci.manifests?.[0]?.digest;
if(oci.manifests?.length!==1||!/^sha256:[a-f0-9]{64}$/.test(workerOciManifestDigest))throw new Error('The actual exported OCI manifest is required.');
const model=patientMatchingConfiguration({},{}),revision=model.revision;
const manifest={schemaVersion:'1',plugin:{id:'patient-matching',version:bundle.coordinate.version},artifacts:{core:core.coordinate,bundle:bundle.coordinate,worker:{image:`ghcr.io/anonymous-temp/evimed-patient-matching-worker@${workerOciManifestDigest}`},resources:[]},host:{abi:HOST_ABI,ports:HOST_PORT_METHODS},kernel:{version:pins.dsh.version,seamDigest:hash(seam)},schemas:SCHEMA_VERSIONS,
 profiles:{reasoning:{provider:'deepseek',model:model.reasoningModel,revision,digest:profileIdentity({model:model.reasoningModel,revision}),efforts:['high']},embedding:{provider:'bailian',model:model.embeddingModel,revision,digest:profileIdentity({provider:'bailian',endpoint:model.embeddingApiBase,model:model.embeddingModel,dimensions:model.embeddingDimensions,revision}),dimensions:model.embeddingDimensions},rerank:{provider:'bailian',model:model.rerankModel,revision,digest:profileIdentity({model:model.rerankModel,endpoint:model.rerankApiBase,revision})},priority:{provider:'typesafe',model:model.triageModel,revision,digest:profileIdentity({model:model.triageModel,revision})},
 algorithm:{id:'patient-matching-balanced',version:calculator.coordinate.version,digest:calculator.digest},skill:{id:'patient-matching',version:bundle.coordinate.version,digest:hash(await fs.readFile(path.join(root,'packages/patient-matching-plugin/skills/patient-matching/SKILL.md')))}},
 resources:{trialIndex:null,knowledgeRequired:false},verification:{receipts:[{kind:'package',artifactDigest:bundle.digest,artifactId:'patient-matching-native-package'}]},upgrade:{readableSchemaVersions:['1'],rollbackGenerations:[]}};
for(const [filename,id]of [['native-status-smoke.json','patient-matching-native-status'],['native-runtime-smoke.json','patient-matching-native-runtime']]){
 try{const receipt=JSON.parse(await fs.readFile(path.join(publicDir,filename),'utf8'));if(`sha256:${receipt.sha256}`!==bundle.digest)throw new Error('Runtime proof refers to another bundle.');manifest.verification.receipts.push({kind:'runtime',artifactDigest:bundle.digest,artifactId:id});}catch(error){if(error.code!=='ENOENT')throw error;}
}
try {
  const clinical=JSON.parse(await fs.readFile(path.join(publicDir,'native-clinical-workflow.json'),'utf8'));
  if(clinical.status==='complete'&&`sha256:${clinical.sha256}`===bundle.digest)manifest.verification.receipts.push({kind:'workflow',artifactDigest:bundle.digest,artifactId:'patient-matching-public-native-clinical'});
} catch(error) { if(error.code!=='ENOENT')throw error; }
validateReleaseManifest(manifest);await fs.mkdir(publicDir,{recursive:true});await fs.writeFile(path.join(publicDir,'release-candidate.json'),JSON.stringify(manifest,null,2)+'\n');
const catalogue=[{releaseId:`patient-matching-${bundle.coordinate.version}-candidate`,packageName:bundle.coordinate.package,packageVersion:bundle.coordinate.version,artifactPath:bundle.path,artifactIntegrity:bundle.coordinate.integrity,artifactDigest:bundle.digest,workerImageDigest:worker.workerImageDigest,hostAbi:HOST_ABI,dshVersion:pins.dsh.version,modelProfile:model}];
await fs.writeFile(path.join(destination,'catalogue.json'),JSON.stringify(catalogue,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({plugin:manifest.plugin,bundleDigest:bundle.digest,workerImageDigest:worker.workerImageDigest,workerOciManifestDigest,publication:'not-published'})+'\n');
