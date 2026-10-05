import {createHash,generateKeyPairSync,sign,verify,createPrivateKey,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson} from '@evimed/domain';

const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
async function writeExclusiveAtomic(file,content){
 const temporary=`${file}.${randomUUID()}.tmp`;
 try{await fs.writeFile(temporary,content,{mode:0o600,flag:'wx'});await fs.link(temporary,file);}finally{await fs.unlink(temporary).catch(()=>{});}
}
const fail=reason=>({nativeCoverageVerified:false,reason});
/** Only observed daemon facts qualify. No environment value or host mount path leaves this boundary.
 * @param {{container:any,network:any,peers:any[],binding:any,allowedPeers:any[]}} input */
export function observedRuntimeEgress({container,network,peers,binding,allowedPeers}){
 const c=container,h=c?.HostConfig,networks=c?.NetworkSettings?.Networks;
 if(!c||!h||c.State?.Running!==true||c.State?.Paused!==false||!Number.isFinite(Date.parse(c.State?.StartedAt??''))||!/^[a-f0-9]{64}$/.test(c.Id??''))return fail('container_not_running');
 if(c.Name!==`/${binding.containerName}`||c.Config?.Labels?.['open-science.web.runtime']!=='true'||c.Config.Labels['open-science.user']!==binding.userId||c.Config.Labels['open-science.project']!==binding.projectId)return fail('container_identity_mismatch');
 if(c.Image!==binding.imageId)return fail('image_mismatch');
 if(h.SecurityOpt?.some(x=>/unconfined/i.test(x))||h.Privileged!==false||h.ReadonlyRootfs!==true||!h.CapDrop?.some(x=>String(x).toUpperCase()==='ALL')||(h.CapAdd??[]).length||(h.Devices??[]).length||(h.DeviceRequests??[]).length||!h.SecurityOpt?.some(x=>/^no-new-privileges(?::true|=true)?$/.test(x))||!/^\d+(?::\d+)?$/.test(c.Config?.User??'')||Number(c.Config.User.split(':')[0])===0)return fail('container_hardening_unverified');
 if(['host','container:'].some(x=>String(h.NetworkMode??'').startsWith(x))||h.PidMode||h.IpcMode==='host'||h.UsernsMode==='host'||(h.ExtraHosts??[]).length||(h.Links??[]).length||(h.VolumesFrom??[]).length)return fail('namespace_escape');
 if((c.Config?.Env??[]).some(x=>/^(?:https?_proxy|all_proxy|ftp_proxy|no_proxy)=/i.test(x)&&x.slice(x.indexOf('=')+1)))return fail('proxy_environment');
 if(!networks||Object.keys(networks).length!==1)return fail('additional_networks');
 const endpoint=Object.values(networks)[0];
 if(network?.Id!==endpoint.NetworkID||network.Driver!=='bridge'||network.Internal!==true||network.EnableIPv6!==false||network.Options?.['com.docker.network.bridge.gateway_mode_ipv4']!=='isolated')return fail('network_not_isolated');
 if(endpoint.GlobalIPv6Address||endpoint.IPv6Gateway||endpoint.Gateway||(network.IPAM?.Config??[]).some(x=>x.Gateway))return fail('network_gateway_present');
 if(!Array.isArray(c.Mounts)||c.Mounts.some(m=>!['bind','volume'].includes(m.Type)||/\.sock(?:\/|$)|\/var\/run|\/run\/docker|\/proc(?:\/|$)|\/sys(?:\/|$)|\/dev(?:\/|$)/.test(`${m.Source??''} ${m.Destination??''}`)))return fail('unsafe_mount');
 const expected=binding.mounts??[];
 if(hash(c.Mounts.map(m=>({type:m.Type,source:m.Source,destination:m.Destination,rw:m.RW})).sort((a,b)=>a.destination.localeCompare(b.destination)))!==hash(expected))return fail('mount_generation_mismatch');
 const members=Object.keys(network.Containers??{}).sort();
 if(!members.includes(c.Id)||members.some(id=>id!==c.Id&&!allowedPeers.some(p=>p.containerId===id))||peers.length!==members.length-1)return fail('network_peer_unapproved');
 for(const peer of peers){const accepted=allowedPeers.find(p=>p.containerId===peer.Id);if(!accepted||accepted.imageId!==peer.Image||peer.State?.Running!==true)return fail('network_peer_identity_mismatch');}
 return{nativeCoverageVerified:true,reason:'observed_isolated_docker',facts:{containerId:c.Id,imageId:c.Image,startedAt:c.State.StartedAt,networkId:network.Id,networkMode:'isolated-bridge-ipv4-only',peers:peers.map(p=>({containerId:p.Id,imageId:p.Image})).sort((a,b)=>a.containerId.localeCompare(b.containerId)),generationDigest:hash(binding.generations??{}),mountDigest:hash(expected)}};
}
/** Receipts are signed by a private controller key and read only through the controller.
 * Runtime workspaces never mount this directory. @param {any} options */
export function createRuntimeEgressProofStore({directory,inspectContainer,inspectNetwork,readBinding,allowedPeers=()=>[]}){
 let keyPromise;
 const key=()=>keyPromise??=(async()=>{
  await fs.mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'controller-key.pem');
  try{const generated=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});await writeExclusiveAtomic(file,generated);}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw new Error('egress_key_unavailable');
  return createPrivateKey(await fs.readFile(file));
 })();
 const receiptFile=(project,runId,phase)=>path.join(directory,`${hash([project.userId,project.id,runId,phase])}.json`);
 const read=async(project,runId,phase)=>{
  let receipt;try{receipt=JSON.parse(await fs.readFile(receiptFile(project,runId,phase),'utf8'));}catch{return null;}
  const {signature,receiptHash,...body}=receipt;
  if(body.runId!==runId||body.userId!==project.userId||body.projectId!==project.id||body.phase!==phase||hash(body)!==receiptHash||!verify(null,Buffer.from(canonicalJson(body)),await key(),Buffer.from(signature??'','base64')))return null;
  return receipt;
 };
 return{
  async capture({project,runId,phase}){
   if(!/^[A-Za-z0-9_-]{1,128}$/.test(runId??'')||!['start','end'].includes(phase))return fail('proof_binding_invalid');
   try{
    const previous=await read(project,runId,phase);if(previous)return{nativeCoverageVerified:true,receiptHash:previous.receiptHash};
    const binding=await readBinding(project);if(!binding)return fail('runtime_binding_unavailable');
    const container=await inspectContainer(binding.containerName),names=Object.values(container.NetworkSettings?.Networks??{});
    if(names.length!==1)return fail('additional_networks');
    const network=await inspectNetwork(names[0].NetworkID),peers=[];
    for(const id of Object.keys(network.Containers??{}))if(id!==container.Id)peers.push(await inspectContainer(id));
    const result=observedRuntimeEgress({container,network,peers,binding,allowedPeers:allowedPeers()});if(!result.nativeCoverageVerified)return result;
    const body={schemaVersion:1,runId,userId:project.userId,projectId:project.id,phase,observedAt:new Date().toISOString(),facts:result.facts};
    const receipt={...body,receiptHash:hash(body),signature:sign(null,Buffer.from(canonicalJson(body)),await key()).toString('base64')};
    try{await writeExclusiveAtomic(receiptFile(project,runId,phase),canonicalJson(receipt));}catch(error){
     if(error.code!=='EEXIST')throw error;
     const winner=await read(project,runId,phase);
     return winner?{nativeCoverageVerified:true,receiptHash:winner.receiptHash}:fail('proof_write_conflict');
    }
    return{nativeCoverageVerified:true,receiptHash:receipt.receiptHash};
   }catch{return fail('proof_probe_unavailable');}
  },
  async verifyPair({project,runId,promptDispatchStartedAt,completedAt}){
   try{const start=await read(project,runId,'start'),end=await read(project,runId,'end');
    if(!start||!end)return fail('proof_pair_incomplete');
    const dispatchAt=Date.parse(promptDispatchStartedAt??''),finishedAt=Date.parse(completedAt??'');
    if(!Number.isFinite(dispatchAt)||!Number.isFinite(finishedAt)||dispatchAt>finishedAt||Date.parse(start.observedAt)>dispatchAt||Date.parse(end.observedAt)<finishedAt)return fail('proof_time_binding_invalid');
    if(Date.parse(end.observedAt)<Date.parse(start.observedAt)||hash(start.facts)!==hash(end.facts))return fail('proof_pair_mismatch');
    return{nativeCoverageVerified:true,reason:'observed_isolated_docker',proofHash:hash([start.receiptHash,end.receiptHash]),startProofHash:start.receiptHash,endProofHash:end.receiptHash};
   }catch{return fail('proof_verification_unavailable');}
  },
 };
}
