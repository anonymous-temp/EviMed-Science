#!/usr/local/bin/node
// Fixed local-test Docker CLI transport; no production gateway or input execution.
import http from 'node:http';
const args=process.argv.slice(2);let prefix='';
async function api(method,url,body){return new Promise((resolve,reject)=>{const bytes=body==null?null:Buffer.from(JSON.stringify(body));const req=http.request({socketPath:'/docker.sock',path:prefix+url,method,headers:bytes?{'content-type':'application/json','content-length':bytes.length}:{}},res=>{const chunks=[];let count=0;res.on('data',x=>{if((count+=x.length)>600000){req.destroy();reject(Error('response_limit'));}else chunks.push(x);});res.on('end',()=>{const out=Buffer.concat(chunks);if(res.statusCode>=400)reject(Error(out.toString()));else resolve(out);});});req.on('error',reject);if(bytes)req.end(bytes);else req.end();});}
const json=async(method,url,body)=>JSON.parse((await api(method,url,body)).toString()||'null');
try{
 const version=await json('GET','/version'),match=/^1\.(\d{1,3})$/.exec(version?.ApiVersion??'');
 if(!match||Number(match[1])<45)throw Error('docker_subpath_api_unsupported');
 prefix='/v'+version.ApiVersion;
 if(args[0]==='image'){console.log((await json('GET','/images/'+encodeURIComponent(args.at(-1))+'/json')).Id);}
 else if(args[0]==='info'){console.log((await json('GET','/info')).ServerVersion);}
 else if(args[0]==='inspect'){console.log(JSON.stringify(await json('GET','/containers/'+encodeURIComponent(args.at(-1))+'/json')));}
 else if(args[0]==='rm'){await api('DELETE','/containers/'+encodeURIComponent(args.at(-1))+'?force=1');}
 else if(args[0]==='create'){
  const required=['--read-only','--network=none','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=32','--cpus=0.5','--memory=256m','--memory-swap=256m'];if(required.some(value=>!args.includes(value)))throw Error('sandbox_flags_missing');
  const option=k=>args[args.indexOf(k)+1];const labels=Object.fromEntries(args.filter((x,i)=>args[i-1]==='--label').map(x=>{const n=x.indexOf('=');return[x.slice(0,n),x.slice(n+1)];}));
  const mount=Object.fromEntries(option('--mount').split(',').map(x=>{const n=x.indexOf('=');return n<0?[x,true]:[x.slice(0,n),x.slice(n+1)];}));
  if(mount.type!=='volume'||mount.dst!=='/input'||mount.readonly!==true)throw Error('invalid_test_mount');
  const imageIndex=args.findIndex(x=>/^sha256:[a-f0-9]{64}$/.test(x));
  const body={Image:args[imageIndex],Entrypoint:[option('--entrypoint')],Cmd:args.slice(imageIndex+1),User:option('--user'),Env:args.filter((x,i)=>args[i-1]==='--env'),Labels:labels,
   HostConfig:{ReadonlyRootfs:true,NetworkMode:'none',CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Memory:268435456,MemorySwap:268435456,NanoCpus:500000000,PidsLimit:32,Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=16m'},Mounts:[{Type:'volume',Source:mount.src,Target:'/input',ReadOnly:true,VolumeOptions:{Subpath:mount['volume-subpath']}}]}};
  console.log((await json('POST','/containers/create?name='+encodeURIComponent(option('--name')),body)).Id);
 }else if(args[0]==='replace'){
  const original=await json('GET','/containers/evimed-skill-validation/json');
  await api('POST','/containers/'+original.Id+'/rename?name=evimed-original-'+original.Id.slice(0,16));
  const body={Image:original.Image,Entrypoint:original.Config.Entrypoint,Cmd:original.Config.Cmd,User:original.Config.User,Env:original.Config.Env,Labels:original.Config.Labels,HostConfig:original.HostConfig};
  const replacement=await json('POST','/containers/create?name=evimed-skill-validation',body);
  console.log(JSON.stringify({originalId:original.Id,replacementId:replacement.Id}));
 }else if(args[0]==='start'){
  const id=encodeURIComponent(args.at(-1));await api('POST','/containers/'+id+'/start');const result=await json('POST','/containers/'+id+'/wait?condition=not-running');const logs=await api('GET','/containers/'+id+'/logs?stdout=1&stderr=1');let offset=0;while(offset<logs.length){const channel=logs[offset],length=logs.readUInt32BE(offset+4);const data=logs.subarray(offset+8,offset+8+length);(channel===2?process.stderr:process.stdout).write(data);offset+=8+length;}process.exitCode=result.StatusCode;
 }else throw Error('unsupported_test_command');
}catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
