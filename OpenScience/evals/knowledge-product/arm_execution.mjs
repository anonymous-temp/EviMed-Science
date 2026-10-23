// Sequential execution preserves the same paired experiment when both full runtime images do not fit.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function selectedArms(argv) {
 const index=argv.indexOf('--arm');
 if(index<0)return ['baseline','candidate'];
 if(argv.filter(v=>v==='--arm').length!==1||!['baseline','candidate'].includes(argv[index+1]))throw new Error('Use --arm baseline or --arm candidate');
 return [argv[index+1]];
}
export function experimentIdentity(bindings,benchmarkSha256) {
 return {benchmarkSha256,sharedBudgetId:bindings.sharedBudget.sharedBudgetId,coordinatorUrl:bindings.sharedBudget.coordinatorUrl,arms:Object.fromEntries(['baseline','candidate'].map(arm=>{
  const b=bindings[arm];if(!b.runtimeEvidence?.runtimeImageId)throw new Error(`${arm}: immutable planned runtimeImageId is required, even before its image is staged`);
  return [arm,{base:b.base,dataDir:b.dataDir,databaseBindingsFile:b.databaseBindingsFile??null,...b.runtimeEvidence}];
 }))};
}
export async function saveExecution(out,state) {
 const temporary=path.join(out,`.execution-${randomBytes(6).toString('hex')}.tmp`);
 await fs.writeFile(temporary,JSON.stringify(state,null,2),{mode:0o600});await fs.rename(temporary,path.join(out,'execution.json'));
}
export async function openExecution(out,identity,protocol) {
 let state;
 try{state=JSON.parse(await fs.readFile(path.join(out,'execution.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(state){if(!state.identity||sha(JSON.stringify(state.identity))!==sha(JSON.stringify(identity)))throw new Error('Frozen experiment identity/configuration changed');await verifySealedArms(out,state);return state;}
 state={...protocol,identity,arms:{baseline:{status:'not-executed'},candidate:{status:'not-executed'}}};await saveExecution(out,state);return state;
}
async function armFiles(out,arm) {
 const files=[];
 const walk=async(relative)=>{const absolute=path.join(out,relative),stat=await fs.lstat(absolute);if(stat.isSymbolicLink())throw new Error('Arm evidence seal refuses symlinks');if(stat.isDirectory()){for(const name of (await fs.readdir(absolute)).sort())await walk(path.join(relative,name));}else if(stat.isFile())files.push({path:relative,bytes:stat.size,sha256:sha(await fs.readFile(absolute))});else throw new Error('Unsupported arm evidence entry');};
 for(const name of (await fs.readdir(out)).sort())if(name===arm||name.startsWith(arm+'-'))await walk(name);
 return files;
}
export async function verifySealedArms(out,state) {
 for(const [arm,value] of Object.entries(state.arms))if(value.status==='sealed'){
  const files=await armFiles(out,arm);
  if(!value.seal||sha(JSON.stringify(files))!==value.seal.sha256)throw new Error(`${arm}: evidence changed after the arm seal`);
  if(files.some(f=>f.path===`${arm}-reviewed-observations.jsonl`)){
   const parse=text=>text.split('\n').filter(Boolean).map(JSON.parse);
   const frozen=parse(await fs.readFile(path.join(out,`${arm}-reviewed-observations.jsonl`),'utf8'));
   const current=parse(await fs.readFile(path.join(out,'reviewed-observations.jsonl'),'utf8')).filter(r=>r.arm===arm);
   if(sha(JSON.stringify(frozen))!==sha(JSON.stringify(current)))throw new Error(`${arm}: shared review rows differ from the sealed observations`);
  }
 }
}
export async function beginArm(out,state,arm) {
 await verifySealedArms(out,state);
 if(arm==='candidate'&&state.arms.baseline.status!=='sealed')throw new Error('Candidate requires the completed baseline arm seal');
 if(state.arms[arm].status!=='not-executed')throw new Error(`${arm}: duplicate sealed arm or unsafe interrupted resume refused`);
 if((await armFiles(out,arm)).length)throw new Error(`${arm}: existing unsealed evidence cannot be overwritten`);
 const lock=await fs.open(path.join(out,`.arm-${arm}.lock`),'wx',0o600).catch(()=>{throw new Error(`${arm}: another collector started or interrupted resume is unsafe`);});await lock.close();
 state.arms[arm]={status:'collecting',startedAt:new Date().toISOString()};state.status=`collecting-${arm}`;await saveExecution(out,state);
}
export async function sealArm(out,state,arm,runtimeProof,details) {
 await verifySealedArms(out,state);
 if(state.arms[arm].status!=='collecting')throw new Error('Only a collecting arm can be sealed');
 const expected=state.identity.arms[arm];
 if(runtimeProof.imageId!==expected.runtimeImageId||!revisionMatches(runtimeProof.revision,expected.revision))throw new Error('Actual arm runtime image/revision differs from the frozen configuration');
 const files=await armFiles(out,arm);if(!files.length)throw new Error('Cannot seal an arm without measured evidence');
 state.arms[arm]={...state.arms[arm],...details,status:'sealed',finishedAt:new Date().toISOString(),runtimeProof,seal:{files,sha256:sha(JSON.stringify(files))}};
 state.status=state.arms.candidate.status==='sealed'?'both-arms-sealed':'baseline-sealed-awaiting-candidate';await saveExecution(out,state);
}
function revisionMatches(actual,expected){return actual===expected||(/^[a-f0-9]{7,40}$/.test(expected)&&String(actual).startsWith(expected));}
function collectorRuntime(binding) {
 const pid=binding.listenerProof?.processId;if(!Number.isSafeInteger(pid))throw new Error('Active collector process identity is required');
 const env=Object.fromEntries(readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(Boolean).map(pair=>{const at=pair.indexOf('=');return [pair.slice(0,at),pair.slice(at+1)];}));
 let image=env.OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE;
 if(!image&&env.OPEN_SCIENCE_RELEASE_MANIFEST_FILE)image=JSON.parse(readFileSync(`/proc/${pid}/root/${env.OPEN_SCIENCE_RELEASE_MANIFEST_FILE.replace(/^\/+/, '')}`,'utf8')).runtime?.image;
 return {runtimeImage:image,dataDir:env.OPEN_SCIENCE_DATA_DIR,processId:pid};
}
export function assertActiveRuntime(binding,inspect=id=>JSON.parse(execFileSync('docker',['image','inspect',id],{encoding:'utf8',timeout:10000}))[0],liveConfig=collectorRuntime) {
 const expected=binding.runtimeEvidence;
 if(!expected?.runtimeImageId||!expected.revision)throw new Error('Active arm immutable runtime image/revision is required');
 const live=liveConfig(binding);
 if(!live.runtimeImage||live.dataDir!==binding.dataDir)throw new Error('Active collector data/image configuration identity mismatch');
 const image=inspect(live.runtimeImage),labels=image?.Config?.Labels??{};
 if(image?.Id!==expected.runtimeImageId)throw new Error('Active runtime Docker image identity mismatch');
 if(!revisionMatches(labels['org.opencontainers.image.revision'],expected.revision))throw new Error('Active runtime Docker image revision mismatch');
 if(expected.dshVersion&&labels['io.open-science.dsh.version']!==expected.dshVersion)throw new Error('Active runtime DSH version mismatch');
 return {imageId:image.Id,configuredRuntimeImage:live.runtimeImage,collectorProcessId:live.processId,dataDir:live.dataDir,revision:labels['org.opencontainers.image.revision'],dshVersion:labels['io.open-science.dsh.version']??null,verifiedAt:new Date().toISOString()};
}
