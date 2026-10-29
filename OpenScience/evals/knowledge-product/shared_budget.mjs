import {verifyNativePeers} from './native_peer_identity.mjs';
// Evaluation-only aggregate budget. Uncertain calls keep their full reservation; no budget is silently released.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
export const REQUIRED_PROVIDER_SCOPES=Object.freeze(['baseline','candidate','openviking']);
export const BUDGET_SCOPES=Object.freeze([...REQUIRED_PROVIDER_SCOPES,'C','judge']);
export class SharedBudget {
  constructor({capCny=50,models,ledgerFile=null,id=randomBytes(12).toString('hex')}) {
    if(!(capCny>0&&capCny<=50)||!models||!Object.keys(models).length)throw new Error('Invalid aggregate budget configuration');
    for(const price of Object.values(models))if(!Number.isFinite(price.input)||price.input<0||!Number.isFinite(price.output)||price.output<0||!Number.isSafeInteger(price.maxOutput)||price.maxOutput<0)throw new Error('Invalid finite model pricing/output bound');
    this.id=id;this.cap=Math.floor(capCny*1e6);this.models=models;this.pending=new Map();this.committed=0;this.ledgerFile=ledgerFile;this.halted=false;
    if(ledgerFile&&fs.existsSync(ledgerFile)&&fs.statSync(ledgerFile).size)throw new Error('Refuse to reset an existing budget ledger; restart requires explicit recovery');
    this.record({type:'opened',capMicroCny:this.cap});
  }
  record(row){if(this.ledgerFile)fs.appendFileSync(this.ledgerFile,JSON.stringify({at:new Date().toISOString(),budgetId:this.id,...row})+'\n',{mode:0o600});}
  reserve({scope,model,inputTokens,maxOutputTokens=0}) {
    const price=Object.hasOwn(this.models,model)?this.models[model]:null;
    if(!price)throw new Error('Unpriced model refused');
    if(!Number.isSafeInteger(inputTokens)||inputTokens<0||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<0||maxOutputTokens>price.maxOutput)throw new Error('Invalid output/input token budget');
    if(this.halted)throw new Error('Aggregate budget halted after uncertain accounting');
    const amount=Math.ceil(inputTokens*price.input+maxOutputTokens*price.output);
    if(this.committed+[...this.pending.values()].reduce((s,r)=>s+r.amount,0)+amount>this.cap)throw new Error('Aggregate budget exhausted');
    const id=randomBytes(12).toString('hex');const row={scope,model,inputTokens,maxOutputTokens,amount};
    this.record({type:'reserved',id,...row});this.pending.set(id,row);return id;
  }
  holdUncertain(id){if(!this.pending.has(id))throw new Error('Unknown uncertainty reservation');this.halted=true;this.record({type:'uncertain-halted',id});}
  settle(id,{inputTokens,outputTokens}) {
    const r=this.pending.get(id);if(!r)throw new Error('Unknown or already settled reservation');
    if(!Number.isSafeInteger(inputTokens)||inputTokens<0||inputTokens>r.inputTokens||!Number.isSafeInteger(outputTokens)||outputTokens<0||outputTokens>r.maxOutputTokens){this.halted=true;this.record({type:'halted',id});throw new Error('Usage exceeds reserved token bound; budget halted');}
    const p=this.models[r.model],amount=Math.ceil(inputTokens*p.input+outputTokens*p.output);
    this.record({type:'settled',id,inputTokens,outputTokens,amount});this.pending.delete(id);this.committed+=amount;
  }
  status(){return {id:this.id,capCny:this.cap/1e6,committedCny:this.committed/1e6,reservedCny:[...this.pending.values()].reduce((s,r)=>s+r.amount,0)/1e6,halted:this.halted,pending:this.pending.size};}
}
// Explicit recovery is deliberately separate from the new-ledger constructor.
export function replaySharedBudget({bytes,id,capCny,models,configurationSha256}) {
  const fail=()=>{throw new Error('Invalid or inconsistent budget replay');};
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.at(-1)!==10||!Buffer.from(bytes.toString('utf8')).equals(bytes))fail();
  const priceHash=createHash('sha256').update(JSON.stringify(Object.entries(models).sort())).digest('hex');
  // Reuse configuration validation without touching any ledger.
  const state=new SharedBudget({id,capCny,models});
  const seen=new Set();const checkpoints=new Set();let opened=false;let offset=0;let recoverySeen=false;
  for(const line of bytes.toString('utf8').split('\n').slice(0,-1)) {
    let r;try{r=JSON.parse(line);}catch{fail();}
    if(!r||r.budgetId!==id||typeof r.at!=='string'||!Number.isFinite(Date.parse(r.at)))fail();
    const fields={opened:['capMicroCny'],reserved:['id','scope','model','inputTokens','maxOutputTokens','amount'],settled:['id','inputTokens','outputTokens','amount'],'uncertain-halted':['id'],halted:['id'],resumed:['ledgerSha256','priceHash','checkpointId']};
    fields['unspent-recovery']=['priorLedgerSha256','configurationSha256'];
    const prefixHash=createHash('sha256').update(bytes.subarray(0,offset)).digest('hex');offset+=Buffer.byteLength(line+'\n');
    const allowed=fields[r.type];if(!allowed||Object.keys(r).sort().join()!==['at','budgetId','type',...allowed].sort().join())fail();
    if(!opened){if(r.type!=='opened'||r.capMicroCny!==state.cap)fail();opened=true;continue;}
    if(r.type==='opened')fail();
    if(r.type==='unspent-recovery') {
      if(recoverySeen||seen.size||state.committed||state.pending.size||state.halted||r.priorLedgerSha256!==prefixHash||!/^([a-f0-9]{64})$/.test(configurationSha256??'')||r.configurationSha256!==configurationSha256)fail();recoverySeen=true;
    } else if(r.type==='reserved') {
      if(state.halted||!/^([a-f0-9]{24})$/.test(r.id)||seen.has(r.id)||!BUDGET_SCOPES.includes(r.scope))fail();
      const p=models[r.model];if(!p||!Number.isSafeInteger(r.inputTokens)||r.inputTokens<0||!Number.isSafeInteger(r.maxOutputTokens)||r.maxOutputTokens<0||r.maxOutputTokens>p.maxOutput||r.amount!==Math.ceil(r.inputTokens*p.input+r.maxOutputTokens*p.output))fail();
      seen.add(r.id);state.pending.set(r.id,{scope:r.scope,model:r.model,inputTokens:r.inputTokens,maxOutputTokens:r.maxOutputTokens,amount:r.amount});
    } else if(r.type==='settled') {
      const p=state.pending.get(r.id);if(!p||!Number.isSafeInteger(r.inputTokens)||r.inputTokens<0||r.inputTokens>p.inputTokens||!Number.isSafeInteger(r.outputTokens)||r.outputTokens<0||r.outputTokens>p.maxOutputTokens||r.amount!==Math.ceil(r.inputTokens*models[p.model].input+r.outputTokens*models[p.model].output))fail();
      state.pending.delete(r.id);state.committed+=r.amount;
    } else if(r.type==='halted'||r.type==='uncertain-halted') {
      if(!state.pending.has(r.id))fail();state.halted=true;
    } else if(r.type==='resumed') {
      if(checkpoints.has(r.checkpointId)||state.pending.size||state.halted||r.priceHash!==priceHash||!r.checkpointId||!/^([a-f0-9]{64})$/.test(r.ledgerSha256))fail();
      if(prefixHash!==r.ledgerSha256)fail();checkpoints.add(r.checkpointId);
    }
    if(!Number.isSafeInteger(state.committed)||[...state.pending.values()].some(p=>!Number.isSafeInteger(p.amount)||p.amount<0)||state.committed+[...state.pending.values()].reduce((n,p)=>n+p.amount,0)>state.cap)fail();
  }
  return {state,priceHash,checkpointIds:[...checkpoints],ledgerSha256:createHash('sha256').update(bytes).digest('hex')};
}
export function resumeSharedBudget({ledgerFile,checkpoint,...config}) {
  const bytes=fs.readFileSync(ledgerFile);
  // Validate all history first, including any terminal recovery audit.
  const full=replaySharedBudget({bytes,...config});
  const lines=bytes.toString('utf8').trimEnd().split('\n');
  const terminal=JSON.parse(lines.at(-1));
  const repeated=terminal.type==='resumed'&&terminal.checkpointId===checkpoint?.checkpointId;
  if(!repeated&&full.checkpointIds.includes(checkpoint?.checkpointId))throw new Error('Recovery checkpoint identity was already used');
  const checkpointBytes=repeated?Buffer.from(lines.slice(0,-1).join('\n')+'\n'):bytes;
  const result=replaySharedBudget({bytes:checkpointBytes,...config});
  const {state,priceHash,ledgerSha256}=result;
  if(!checkpoint||checkpoint.ledgerSha256!==ledgerSha256||checkpoint.priceHash!==priceHash||checkpoint.configurationSha256!==config.configurationSha256||!/^([a-f0-9]{64})$/.test(config.configurationSha256??'')||checkpoint.id!==state.id||checkpoint.capMicroCny!==state.cap||checkpoint.committedMicroCny!==state.committed||checkpoint.pending!==0||checkpoint.halted!==false||!checkpoint.checkpointId||state.pending.size||state.halted)throw new Error('Live checkpoint does not match safe replay');
  // Caller must own the exclusive coordinator lock and verify the old PID/start identity.
  // Recheck bytes immediately before append; never truncate or replace history.
  if(!fs.readFileSync(ledgerFile).equals(bytes))throw new Error('Ledger changed during recovery');
  if(repeated){full.state.ledgerFile=ledgerFile;return full.state;}
  state.ledgerFile=ledgerFile;
  state.record({type:'resumed',ledgerSha256,priceHash,checkpointId:checkpoint.checkpointId});
  return state;
}
export function nativeConfigBinding(command,environment,file){
 return /openviking[-\s]+(serve|server)|python.*openviking/i.test(command)&&(command.includes(file)||environment.OPENVIKING_CONFIG_FILE===file);
}
export function verifyNativeConfiguration(config) {
  if(!config.nativeConfigFile||!Number.isSafeInteger(config.nativeProcessId))throw new Error('Native OpenViking live config/process wiring missing');
  const command=spawnSync('ps',['-p',String(config.nativeProcessId),'-o','command='],{encoding:'utf8'});
  const nativeEnv=Object.fromEntries(fs.readFileSync(`/proc/${config.nativeProcessId}/environ`,'utf8').split('\0').filter(Boolean).map(pair=>{const at=pair.indexOf('=');return [pair.slice(0,at),pair.slice(at+1)];}));
  if(command.status!==0||!nativeConfigBinding(command.stdout,nativeEnv,config.nativeConfigFile))throw new Error('Native config is not bound to the running engine process');
  const mountedConfig=fs.readFileSync(`/proc/${config.nativeProcessId}/root/${config.nativeConfigFile.replace(/^\/+/,'')}`);
  if(!mountedConfig.equals(fs.readFileSync(config.nativeConfigFile)))throw new Error('Native mounted config differs from operator config');
  const native=JSON.parse(fs.readFileSync(config.nativeConfigFile,'utf8'));
  const origin=new URL(config.coordinatorUrl).origin;
  const token=fs.readFileSync(config.tokenFile,'utf8').trim();
  const dense=native.embedding?.dense;
  if(!dense?.api_base||new URL(dense.api_base).origin!==origin||!dense.api_base.includes('/scope/openviking/')||dense.api_key!==token)throw new Error('Native embedding provider bypasses the shared coordinator');
  if(!native.vlm?.api_base||!native.bot?.agents?.api_base)throw new Error('Native VLM/compiler model wiring incomplete');
  const allowed=new Set([origin,...(config.instrumentedGatewayOrigins??[])]);
  for(const entry of [native.vlm,native.bot?.agents].filter(Boolean))if(!entry.api_base||!allowed.has(new URL(entry.api_base).origin))throw new Error('Native model provider bypasses instrumented gateway');
  for(const origin of allowed){const hostname=new URL(origin).hostname;if(!['127.0.0.1','localhost','::1'].includes(hostname))throw new Error('Uninstrumented remote native gateway refused');}
  return true;
}
export function processStartedAt(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Invalid instrumented process identity');
  const result=spawnSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,TZ:'UTC'}});
  const start=result.stdout?.trim();
  if(result.status!==0||!start)throw new Error('Instrumented process is not alive');
  return start;
}
export function listenerOwnersForAddress(output,endpoint){
 const host=endpoint.hostname.replace(/^\[|\]$/g,''),port=endpoint.port||(endpoint.protocol==='https:'?'443':'80');
 const admitted=host==='localhost'?[`127.0.0.1:${port}`,`[::1]:${port}`]:[host==='::1'?`[::1]:${port}`:`${host}:${port}`];
 const owners=[];let pid;
 for(const line of output.split('\n')){if(line.startsWith('p'))pid=Number(line.slice(1));else if(line.startsWith('n')&&admitted.includes(line.slice(1))&&Number.isSafeInteger(pid))owners.push(pid);}
 return [...new Set(owners)];
}
export function loopbackListenerOwners(endpoint) {
  const port=endpoint.port||(endpoint.protocol==='https:'?'443':'80');
  const result=spawnSync('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpn'],{encoding:'utf8'});
  if(result.status!==0)return [];
  return listenerOwnersForAddress(result.stdout,endpoint);
}
export async function verifyBoundCollector(base,scope,config,{liveVerifier=verifyLiveBudgetWiring,listenerOwners=loopbackListenerOwners}={}) {
  const endpoint=new URL(base);
  if(!['http:','https:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','::1','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw new Error('Collector must be an unambiguous loopback base URL');
  if(!['baseline','candidate'].includes(scope))throw new Error('Collector must bind an admitted arm');
  const status=await liveVerifier(config);
  const proof=status.wiring?.[scope];
  if(!proof||proof.budgetId!==status.id||!listenerOwners(endpoint).includes(proof.processId))throw new Error(`Collector listener is not the instrumented ${scope} process on the shared coordinator`);
  return {...status,binding:{scope,base:endpoint.origin,processId:proof.processId,budgetId:status.id,processStart:proof.processStart}};
}
export function verifyGatewayListeners(origins,wiring,{owners=loopbackListenerOwners}={}){
 for(const origin of origins){const endpoint=new URL(origin),listeners=owners(endpoint);if(!['baseline','candidate'].some(scope=>listeners.includes(wiring[scope]?.processId)))throw new Error('Native gateway listener is not the exact loopback instrumented control plane');}
 return true;
}
export async function verifyLiveBudgetWiring(config,{fetchImpl=fetch,nativeVerifier=verifyNativeConfiguration}={}) {
  if(!config?.coordinatorUrl||!config?.tokenFile||!config?.sharedBudgetId)throw new Error('Live shared budget wiring missing');
  const u=new URL(config.coordinatorUrl);if(!['127.0.0.1','localhost','::1'].includes(u.hostname))throw new Error('Budget wiring coordinator must be owned loopback');
  nativeVerifier(config);
  const token=fs.readFileSync(config.tokenFile,'utf8').trim();
  const nonce=randomBytes(16).toString('hex');
  const r=await fetchImpl(`${u.origin}/__eval/status?nonce=${nonce}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error('Live budget accounting unavailable');
  const status=await r.json();
  if(status.nonce!==nonce||status.id!==config.sharedBudgetId||status.halted||!(status.capCny>0&&status.capCny<=50)||!Number.isFinite(status.committedCny)||!Number.isFinite(status.reservedCny))throw new Error('Live aggregate budget accounting identity mismatch');
  for(const scope of REQUIRED_PROVIDER_SCOPES){const p=status.wiring?.[scope];if(!p?.providerBoundary||!p.processId||!p.processStart||processStartedAt(p.processId)!==p.processStart||p.budgetId!==status.id)throw new Error(`Unverified provider wiring: ${scope}`);}
  for(const scope of ['baseline','candidate'])try{process.kill(status.wiring[scope].processId,0);}catch{throw new Error('Instrumented control-plane process is not alive');}
  if(nativeVerifier===verifyNativeConfiguration)verifyGatewayListeners(config.instrumentedGatewayOrigins??[],status.wiring);
  if(config.nativePeers!==undefined)status.nativePeers=verifyNativePeers({...config,peerWebProcessIds:Object.fromEntries(['baseline','candidate'].map(arm=>[arm,status.wiring[arm].processId]))},{verifyConfig:nativeVerifier,listenerOwners:loopbackListenerOwners});
  return status;
}

export async function armSharedBudget(config,options) {
  await verifyLiveBudgetWiring(config,options);
  const token=fs.readFileSync(config.tokenFile,'utf8').trim();
  const response=await fetch(`${new URL(config.coordinatorUrl).origin}/__eval/arm`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({budgetId:config.sharedBudgetId}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('Shared budget refused to arm');
  return response.json();
}
