import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
const image=process.env.NATIVE_EXTENSION_TEST_IMAGE??'';
const options={skip:!image&&'An immutable offline SDK fixture image is required'};
for(const scenario of ['enabled','disabled'])test(`actual Linux nonroot native registry/settings/${scenario} selected projection`,options,()=>{
  assert.match(image,/^sha256:[a-f0-9]{64}$/);const volume='evimed-native-extension-fixture-'+randomUUID(),name=volume+'-reader';
  execFileSync('docker',['volume','create','--driver','local','--opt','type=tmpfs','--opt','device=tmpfs','--opt','o=size=4m,mode=0755',volume],{stdio:'ignore'});
  let keeper;
  try{
    keeper=execFileSync('docker',['run','-d','--pull','never','--network','none','--read-only','--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--pids-limit','32','--mount',`type=volume,source=${volume},target=/projection`,'--entrypoint','node',image,'-e',`const fs=require('node:fs');fs.cpSync('/fixture/generations/${scenario}/projection.json','/projection/projection.json');fs.chmodSync('/projection',0o755);fs.chmodSync('/projection/projection.json',0o444);setInterval(()=>{},1000);`],{encoding:'utf8',timeout:10000}).trim();
    execFileSync('docker',['exec',keeper,'node','-e',"require('node:fs').statSync('/projection/projection.json');"],{stdio:'ignore',timeout:10000});
    execFileSync('docker',['create','--name',name,'--pull','never','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','1','--memory','512m','--pids-limit','64','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--mount',`type=volume,source=${volume},target=/opt/evimed/extensions,readonly`,image],{stdio:'ignore'});
    const actual=JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0];assert.equal(actual.Image,image);assert.equal(actual.Config.User,'10001:10001');assert.equal(actual.HostConfig.NetworkMode,'none');assert.equal(actual.HostConfig.ReadonlyRootfs,true);assert(actual.HostConfig.CapDrop.includes('ALL'));assert.equal(actual.Mounts.find(mount=>mount.Destination==='/opt/evimed/extensions').RW,false);
    const output=execFileSync('docker',['start','-a',name],{encoding:'utf8',timeout:45000,maxBuffer:128*1024});const result=JSON.parse(output.trim());assert.equal(result.uid,10001);assert.equal(result.kernel,'0.1.7-rc.2');assert.equal(result.citation.timeoutMs,scenario==='enabled'?4000:5000);assert.deepEqual(result.nativeTools,scenario==='enabled'?['doc_read','doc_write']:[]);assert.equal(result.gatewayCalls>0,scenario==='enabled');
  }finally{execFileSync('docker',['rm','-f',name],{stdio:'ignore'});if(keeper)execFileSync('docker',['rm','-f',keeper],{stdio:'ignore'});execFileSync('docker',['volume','rm',volume],{stdio:'ignore'});}
});
