// Optional evaluation-only proof for two engines sharing the original aggregate embedding bucket.
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function readNativePeer(peer){
 const image=JSON.parse(execFileSync('docker',['inspect',peer.containerId],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024}))[0];
 const imageMetadata=JSON.parse(execFileSync('docker',['image','inspect',image.Image],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024}))[0];
 const pid=image.State?.Pid;
 const ticks=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').at(-1).split(' ')[19];
 const pinBytes=readFileSync(peer.versionPinFile);
 const pin=JSON.parse(pinBytes);const approved=pin.openviking;
 return {versionPinSha256:sha(pinBytes),approvedVersion:approved?.version,approvedImage:approved?.image && approved?.imageDigest ? `${approved.image}@${approved.imageDigest}` : null,image,imageMetadata,pid,startTicks:ticks,configBytes:readFileSync(peer.nativeConfigFile),mountedConfigBytes:readFileSync(`/proc/${pid}/root/${peer.containerConfigPath.replace(/^\/+/, '')}`),dataPath:realpathSync(peer.dataDir)};
}
export function verifyNativePeers(config,{readPeer=readNativePeer,verifyConfig,listenerOwners}={}){
 if(config.nativePeers===undefined)return null;
 const peers=config.nativePeers;
 if(!peers||Object.keys(peers).sort().join()!=='baseline,candidate')throw Error('Exact native peer arms required');
 const result={};const data=new Set(),containers=new Set();
 for(const arm of ['baseline','candidate']){
  const p=peers[arm];
  if(!p||!/^sha256:[a-f0-9]{64}$/.test(p.imageId??'')||!p.version||!p.versionPinFile||!p.versionPinSha256||!p.approvedImage||!/^[a-f0-9]{64}$/.test(p.containerId??'')||!p.configSha256||!p.startTicks||!Number.isSafeInteger(p.nativeProcessId)||!p.webGatewayOrigin||!p.containerDataPath||!p.containerConfigPath)throw Error('Complete immutable native peer identity required');
  for(const field of ['nativeConfigFile','versionPinFile','dataDir','containerDataPath','containerConfigPath'])if(typeof p[field]!=='string'||!p[field].startsWith('/')||p[field].split('/').includes('..')||/[\x00-\x1f]/.test(p[field]))throw Error('Exact absolute native peer paths required');
  for(const endpoint of [config.coordinatorUrl,p.webGatewayOrigin])if(!['127.0.0.1','localhost','::1'].includes(new URL(endpoint).hostname))throw Error('Native peer endpoint must be loopback');
  const actual=readPeer(p),i=actual.image;
  if(i.Id!==p.containerId||actual.imageMetadata?.Id!==p.imageId||!i.State?.Running||actual.pid!==p.nativeProcessId||String(actual.startTicks)!==String(p.startTicks)||i.Image!==p.imageId)throw Error('Native peer process/image/version drift');
  if(actual.versionPinSha256!==p.versionPinSha256||actual.approvedVersion!==p.version||actual.approvedImage!==p.approvedImage||!actual.imageMetadata?.RepoDigests?.includes(p.approvedImage))throw Error('Native peer approved version/image pin drift');
  if(sha(actual.configBytes)!==p.configSha256||!Buffer.from(actual.configBytes).equals(Buffer.from(actual.mountedConfigBytes)))throw Error('Native peer config drift');
  if(actual.dataPath!==p.dataDir||!i.Mounts?.some(m=>m.Source===p.dataDir&&m.Destination===p.containerDataPath)||data.has(p.dataDir)||containers.has(p.containerId))throw Error('Native peers require distinct exact data and containers');
  data.add(p.dataDir);containers.add(p.containerId);
  const native=JSON.parse(actual.configBytes),origin=new URL(config.coordinatorUrl).origin;
  if(new URL(native.embedding?.dense?.api_base).origin!==origin||!native.embedding.dense.api_base.includes('/scope/openviking/'))throw Error('Native peer embedding bypass');
  if([native.vlm,native.bot?.agents].some(v=>!v?.api_base||new URL(v.api_base).origin!==p.webGatewayOrigin))throw Error('Native peer web gateway mismatch');
  if(typeof verifyConfig!=='function'||typeof listenerOwners!=='function')throw Error('Native peer live verifiers required');
  verifyConfig({...config,...p,instrumentedGatewayOrigins:[p.webGatewayOrigin]});
  const owners=listenerOwners(new URL(p.webGatewayOrigin));
  if(!owners.includes(config.peerWebProcessIds?.[arm]))throw Error('Native peer gateway owner mismatch');
  result[arm]={arm,embeddingAttribution:'shared openviking bucket',containerId:p.containerId,imageId:p.imageId,version:p.version,versionPinSha256:p.versionPinSha256,approvedImage:p.approvedImage,nativeProcessId:p.nativeProcessId,startTicks:p.startTicks,configSha256:p.configSha256,dataDir:p.dataDir,containerConfigPath:p.containerConfigPath,containerDataPath:p.containerDataPath,webGatewayOrigin:p.webGatewayOrigin};
 }
 if(peers.baseline.nativeProcessId!==config.nativeProcessId||peers.baseline.nativeConfigFile!==config.nativeConfigFile)throw Error('Canonical native identity must remain baseline');
 return result;
}

export function canonicalNativePeers(peers){return Object.fromEntries(['baseline','candidate'].map(arm=>[arm,Object.fromEntries(['containerId','imageId','version','versionPinFile','versionPinSha256','approvedImage','nativeProcessId','startTicks','nativeConfigFile','configSha256','dataDir','containerConfigPath','containerDataPath','webGatewayOrigin'].map(key=>[key,peers[arm][key]]))]));}
