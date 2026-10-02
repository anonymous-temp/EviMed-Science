/** Native Linux operator transport. Constructor-owned observations, never a public deployment switch or a sandbox fallback. */
import fs from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
const exec=promisify(execFile),digest=value=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex');
export function nativeLinuxDockerEnvironment(environment=process.env){
 if(environment.DOCKER_CONTEXT!=='default'||['DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'].some(key=>environment[key]))throw new Error('native_linux_remote_docker_refused');
 return{...(typeof environment.PATH==='string'?{PATH:environment.PATH}:{}),DOCKER_CONTEXT:'default'};
}
export function validateNativeLinuxPrerequisites({platform,hostArchitecture,daemonArchitecture,imageId,imageArchitecture,imageOs,endpoint,landlockAbi},expectedImage){
 if(platform!=='linux'||hostArchitecture!=='x64'||!['x86_64','amd64'].includes(daemonArchitecture)||imageId!==expectedImage||imageArchitecture!=='amd64'||imageOs!=='linux'
  ||typeof endpoint!=='string'||!endpoint.startsWith('unix:///')||!Number.isSafeInteger(landlockAbi)||landlockAbi<5)throw new Error('native_linux_sandbox_prerequisite_refused');
 return{platform,hostArchitecture,daemonArchitecture,imageId,imageArchitecture,imageOs,endpoint,landlockAbi};
}
export async function observeNativeLinuxPrerequisites(imageId){
 if(process.platform!=='linux'||process.arch!=='x64')throw new Error('native_linux_sandbox_prerequisite_refused');
 const env=nativeLinuxDockerEnvironment(),command=async args=>(await exec('docker',['--context','default',...args],{env,timeout:10000,maxBuffer:256*1024})).stdout.trim();
 const context=JSON.parse(await command(['context','inspect','default']))[0],endpoint=context.Endpoints?.docker?.Host;
 if(typeof endpoint!=='string'||!endpoint.startsWith('unix:///'))throw new Error('native_linux_remote_docker_refused');
 const socketPath=new URL(endpoint).pathname,canonicalSocket=await fs.realpath(socketPath),socket=await fs.lstat(canonicalSocket);
 if(!socket.isSocket()||![0,process.getuid()].includes(socket.uid))throw new Error('native_linux_docker_socket_untrusted');
 const image=JSON.parse(await command(['image','inspect',imageId]))[0],daemonArchitecture=await command(['info','--format','{{.Architecture}}']);
 const probe=(await exec('python3',['-c',"import ctypes,json; libc=ctypes.CDLL(None,use_errno=True); abi=libc.syscall(444,None,ctypes.c_size_t(0),ctypes.c_uint32(1)); print(json.dumps({'abi':abi if abi>0 else 0,'errno':ctypes.get_errno()}))"],{env,timeout:5000,maxBuffer:4096})).stdout;
 return{...validateNativeLinuxPrerequisites({platform:process.platform,hostArchitecture:process.arch,daemonArchitecture,imageId:image.Id,imageArchitecture:image.Architecture,imageOs:image.Os,endpoint,landlockAbi:JSON.parse(probe).abi},imageId),socketIdentity:{canonicalSocket,uid:socket.uid,dev:socket.dev,ino:socket.ino}};
}
function ipv4Number(address){if(isIP(address)!==4)throw new Error('native_linux_bridge_identity_refused');return address.split('.').reduce((value,part)=>(value*256+Number(part))>>>0,0);}
export function validateOwnedLinuxBridge(network,{id,name,rootDigest},interfaces){
 if(network?.Id!==id||network.Name!==name||network.Driver!=='bridge'||network.Internal!==true||network.Labels?.['io.evimed.campaign-root']!==rootDigest
  ||network.IPAM?.Config?.length!==1)throw new Error('native_linux_bridge_identity_refused');
 const {Subnet:subnet,Gateway:gateway}=network.IPAM.Config[0],parts=typeof subnet==='string'?subnet.split('/'):[],prefix=Number(parts[1]);
 if(parts.length!==2||!Number.isInteger(prefix)||prefix<1||prefix>30||isIP(gateway)!==4)throw new Error('native_linux_bridge_identity_refused');
 const mask=(0xffffffff<<(32-prefix))>>>0;if((ipv4Number(gateway)&mask)!==(ipv4Number(parts[0])&mask))throw new Error('native_linux_bridge_identity_refused');
 const interfaceName=network.Options?.['com.docker.network.bridge.name']||'br-'+id.slice(0,12),matches=(interfaces[interfaceName]??[]).filter(item=>(item.family==='IPv4'||item.family===4)&&item.address===gateway&&!item.internal);
 if(matches.length!==1)throw new Error('native_linux_bridge_interface_refused');
 return{id,name,rootDigest,subnet,gateway,interfaceName};
}
/** iproute2 observes assigned bridge addresses even before an endpoint gives the bridge carrier. */
export function validateOwnedLinuxBridgeKernel(network,expected,links,addresses){
 const interfaceName=network.Options?.['com.docker.network.bridge.name']||'br-'+expected.id.slice(0,12);
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/.test(interfaceName)||links?.length!==1||addresses?.length!==1)throw new Error('native_linux_bridge_interface_refused');
 const link=links[0],address=addresses[0],prefix=Number(network.IPAM?.Config?.[0]?.Subnet?.split('/')[1]);
 if(link.ifname!==interfaceName||address.ifname!==interfaceName||link.linkinfo?.info_kind!=='bridge'||!Number.isSafeInteger(link.ifindex)||link.ifindex<=0||address.ifindex!==link.ifindex
  ||!Array.isArray(link.flags)||!link.flags.includes('UP')||link.flags.includes('LOOPBACK'))throw new Error('native_linux_bridge_interface_refused');
 const assigned=(address.addr_info??[]).filter(item=>item.family==='inet'&&item.local===network.IPAM?.Config?.[0]?.Gateway&&item.prefixlen===prefix&&item.scope==='global');
 if(assigned.length!==1)throw new Error('native_linux_bridge_interface_refused');
 const bridge=validateOwnedLinuxBridge(network,expected,{[interfaceName]:[{family:'IPv4',address:assigned[0].local,internal:false}]});
 return{...bridge,interfaceIndex:link.ifindex,interfaceKind:'bridge',addressProof:'iproute2-kernel-json',operstate:link.operstate};
}
/** Shared fixed handler: no filesystem, Docker, credential resolver or arbitrary destination is available in its closure. */
export function createFixedCampaignRelayHandler(httpModule,getTarget,clock={setTimeout,clearTimeout}){
 const allowed=new Set(['/internal/model/v1/messages','/internal/extensions/v1/execute','/internal/extensions/v1/status','/internal/extensions/v1/cancel']);let active=0;
 return(req,res)=>{
  const target=getTarget();if(req.method!=='POST'||!allowed.has(req.url)||active>=16){res.writeHead(403);res.end();return;}if(!target){res.writeHead(503);res.end();return;}
  active++;let released=false;const done=()=>{if(!released){released=true;active--;}};const headers={};
  for(const[key,value]of Object.entries(req.headers)){if(['host','connection','keep-alive','transfer-encoding','proxy-authorization','proxy-authenticate','forwarded','upgrade'].includes(key)||key.startsWith('x-forwarded-'))continue;headers[key]=value;}
  let sent=0,received=0;const upstream=httpModule.request(new URL(req.url,target),{method:'POST',headers},reply=>{
   const output={};for(const[key,value]of Object.entries(reply.headers)){if(['connection','keep-alive','transfer-encoding','upgrade','server','x-powered-by'].includes(key))continue;output[key]=value;}res.writeHead(reply.statusCode,output);
   reply.on('data',chunk=>{received+=chunk.length;if(received>12*1024*1024){reply.destroy();res.destroy();return;}res.write(chunk);});reply.on('end',()=>res.end());reply.on('error',()=>res.destroy());
  });const timer=clock.setTimeout(()=>{upstream.destroy();res.destroy();},120000);res.on('close',()=>{if(!res.writableEnded)upstream.destroy();clock.clearTimeout(timer);done();});req.on('aborted',()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('data',chunk=>{sent+=chunk.length;if(sent>8*1024*1024){upstream.destroy();res.destroy();return;}upstream.write(chunk);});req.on('end',()=>upstream.end());
 };
}
export async function bindNativeLinuxRelay({network,root}){
 const env=nativeLinuxDockerEnvironment(),observed=JSON.parse((await exec('docker',['--context','default','network','inspect',network.id],{env,timeout:5000,maxBuffer:65536})).stdout)[0];
 const device=observed.Options?.['com.docker.network.bridge.name']||'br-'+network.id.slice(0,12);
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/.test(device))throw new Error('native_linux_bridge_interface_refused');
 const options={env,timeout:5000,maxBuffer:65536},links=JSON.parse((await exec('ip',['-j','-d','link','show','dev',device],options)).stdout),addresses=JSON.parse((await exec('ip',['-j','addr','show','dev',device],options)).stdout);
 const bridge=validateOwnedLinuxBridgeKernel(observed,network,links,addresses);if(bridge.rootDigest!==digest(root))throw new Error('native_linux_bridge_identity_refused');
 return bindInspectedNativeLinuxRelay(bridge);
}
/** Trusted constructor seam; only bindNativeLinuxRelay supplies independently inspected bridge facts in production. */
export async function bindInspectedNativeLinuxRelay(bridge,httpModule=http){
 let target=null,closed=false,stopping=false;const server=httpModule.createServer(createFixedCampaignRelayHandler(httpModule,()=>target));server.maxConnections=16;server.requestTimeout=120000;server.headersTimeout=10000;
 const closeServer=async()=>{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));closed=true;};
 let address;try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,bridge.gateway,()=>{server.removeListener('error',reject);resolve();});});
  address=server.address();if(!address||typeof address==='string'||address.address!==bridge.gateway)throw new Error('native_linux_relay_binding_refused');
 }catch(error){try{await closeServer();}catch(cleanupError){throw new AggregateError([error,cleanupError],'native_linux_relay_cleanup_unconfirmed',{cause:error});}throw error;}
 return{gatewayUrl:`http://${bridge.gateway}:${address.port}`,bridge,sourceDigest:digest(createFixedCampaignRelayHandler.toString()),scope:'TrustedhostNode fixedpath relay bound only to independently inspected owned internal bridge; no runtime hostnetwork/publicport or handler Docker/fs/credential capability',
  bindTarget(fixtureUrl){if(target||closed||stopping)throw new Error('native_linux_relay_target_rebind_refused');const url=new URL(fixtureUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('native_linux_relay_target_refused');target=url.origin;},
  close:async()=>{if(closed)return;stopping=true;await closeServer();}};
}
