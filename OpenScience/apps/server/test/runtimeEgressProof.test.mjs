import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {observedRuntimeEgress,createRuntimeEgressProofStore} from '../src/runtimeEgressProof.mjs';
const id='a'.repeat(64),peerId='b'.repeat(64),image=`sha256:${'c'.repeat(64)}`,networkId='d'.repeat(64);
function fixture(){
 const project={userId:'operator',id:'eval-paper-unit'},mounts=[{Type:'volume',Source:'/var/lib/docker/volumes/data/_data/workspace',Destination:'/workspace',RW:true}];
 const container={Id:id,Name:'/owned-runtime',Image:image,State:{Running:true,Paused:false,StartedAt:'2026-10-05T01:00:00Z'},Config:{User:'10001:10001',Env:['PATH=/usr/bin'],Labels:{'open-science.web.runtime':'true','open-science.user':project.userId,'open-science.project':project.id}},HostConfig:{Privileged:false,ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:[],SecurityOpt:['no-new-privileges'],Devices:[],DeviceRequests:[],NetworkMode:'dedicated-evaluation',PidMode:'',IpcMode:'private',UsernsMode:'',ExtraHosts:[],Links:[],VolumesFrom:[]},NetworkSettings:{Networks:{'dedicated-evaluation':{NetworkID:networkId,Gateway:'',GlobalIPv6Address:'',IPv6Gateway:''}}},Mounts:mounts};
 const network={Id:networkId,Driver:'bridge',Internal:true,EnableIPv6:false,Options:{'com.docker.network.bridge.gateway_mode_ipv4':'isolated'},IPAM:{Config:[{Subnet:'172.30.0.0/24'}]},Containers:{[id]:{},[peerId]:{}}};
 const peer={Id:peerId,Image:image,State:{Running:true}};
 const binding={...project,projectId:project.id,containerName:'owned-runtime',imageId:image,generations:{platform:{id:'generation',digest:'e'.repeat(64)}},mounts:mounts.map(m=>({type:m.Type,source:m.Source,destination:m.Destination,rw:m.RW}))};
 return{project,container,network,peers:[peer],binding,allowedPeers:[{containerId:peerId,imageId:image}]};
}
test('only actual hardened isolated Docker topology with exact approved peers qualifies',()=>{
 assert.equal(observedRuntimeEgress(fixture()).nativeCoverageVerified,true);
 const mutations=[f=>f.network.Internal=false,f=>f.network.Options={},f=>f.network.EnableIPv6=true,f=>f.container.NetworkSettings.Networks.other={NetworkID:'f'.repeat(64)},f=>f.container.HostConfig.Privileged=true,f=>f.container.HostConfig.CapAdd=['NET_ADMIN'],f=>f.container.HostConfig.CapDrop=[],f=>f.container.Config.User='0:0',f=>f.container.HostConfig.PidMode='host',f=>f.container.HostConfig.ExtraHosts=['host:host-gateway'],f=>f.container.Config.Env.push('HTTPS_PROXY=http://proxy.invalid'),f=>f.container.Mounts.push({Type:'bind',Source:'/var/run/docker.sock',Destination:'/socket',RW:true}),f=>f.container.Mounts[0].RW=false,f=>f.container.Image='sha256:'+'f'.repeat(64),f=>f.container.State.Running=false,f=>f.allowedPeers=[],f=>f.peers[0].Image='sha256:'+'f'.repeat(64),f=>f.network.Containers['f'.repeat(64)]={},f=>f.network.IPAM.Config[0].Gateway='172.30.0.1',f=>f.container.Config.Labels['open-science.project']='other'];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(observedRuntimeEgress(f).nativeCoverageVerified,false);}
});
test('controller-signed immutable pairs survive restart and reject tampering or changed container generations',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-egress-proof-'));
 try{
 const f=fixture(),options={directory,inspectContainer:async name=>name===peerId?f.peers[0]:f.container,inspectNetwork:async()=>f.network,readBinding:async()=>f.binding,allowedPeers:()=>f.allowedPeers};
 let store=createRuntimeEgressProofStore(options);const request={project:f.project,runId:'run_actual'};
 assert.equal((await store.verifyPair(request)).reason,'proof_pair_incomplete');
 const start=await store.capture({...request,phase:'start'});assert.equal(start.nativeCoverageVerified,true);request.promptDispatchStartedAt=new Date().toISOString();
 assert.deepEqual(await store.capture({...request,phase:'start'}),start,'a duplicate capture preserves original observed bytes');
 request.completedAt=new Date().toISOString();assert.equal((await store.capture({...request,phase:'end'})).nativeCoverageVerified,true);
 store=createRuntimeEgressProofStore(options);const proof=await store.verifyPair(request);assert.equal(proof.nativeCoverageVerified,true);assert.match(proof.proofHash,/^[a-f0-9]{64}$/);
 assert.equal((await store.verifyPair({...request,runId:'other_run'})).nativeCoverageVerified,false);
 assert.equal((await store.verifyPair({...request,project:{...f.project,id:'foreign'}})).nativeCoverageVerified,false);
 await store.capture({...request,runId:'run_changed',phase:'start'});request.promptDispatchStartedAt=new Date().toISOString();f.binding.generations.platform.digest='f'.repeat(64);request.completedAt=new Date().toISOString();await store.capture({...request,runId:'run_changed',phase:'end'});
 assert.equal((await store.verifyPair({...request,runId:'run_changed'})).reason,'proof_pair_mismatch');
 assert.equal((await store.verifyPair({...request,promptDispatchStartedAt:'2020-01-01T00:00:00Z'})).reason,'proof_time_binding_invalid');
 const files=(await fs.readdir(directory)).filter(x=>x.endsWith('.json'));for(const file of files){const name=path.join(directory,file),body=JSON.parse(await fs.readFile(name,'utf8'));if(body.runId==='run_actual'&&body.phase==='start'){body.facts.imageId='sha256:'+'f'.repeat(64);await fs.writeFile(name,JSON.stringify(body));}}
 assert.equal((await store.verifyPair(request)).nativeCoverageVerified,false);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('concurrent end captures reuse only the winning signed immutable receipt',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-egress-concurrent-'));
 try{
  const f=fixture();let arrived=0,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const store=createRuntimeEgressProofStore({directory,inspectContainer:async name=>{
   if(name===peerId)return f.peers[0];
   if(++arrived===8)release();await barrier;return f.container;
  },inspectNetwork:async()=>f.network,readBinding:async()=>f.binding,allowedPeers:()=>f.allowedPeers});
  const results=await Promise.all(Array.from({length:8},()=>store.capture({project:f.project,runId:'run_concurrent',phase:'end'})));
  assert.equal(results.every(result=>result.nativeCoverageVerified),true);
  assert.equal(new Set(results.map(result=>result.receiptHash)).size,1);
  const files=(await fs.readdir(directory)).filter(file=>file.endsWith('.json'));
  assert.equal(files.length,1);
  const receipt=JSON.parse(await fs.readFile(path.join(directory,files[0]),'utf8'));
  receipt.facts.imageId='sha256:'+'f'.repeat(64);
  await fs.writeFile(path.join(directory,files[0]),JSON.stringify(receipt));
  const invalid=await store.capture({project:f.project,runId:'run_concurrent',phase:'end'});
  assert.equal(invalid.nativeCoverageVerified,false,'an existing tampered winner is never reused');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
