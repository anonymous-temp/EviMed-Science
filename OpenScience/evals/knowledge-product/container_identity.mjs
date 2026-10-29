// Operator-owned evaluation proof only; never accepts a caller-selected host PID.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
export function validateContainerIdentity(binding,inspected,namespacePid,status){
 if(!/^[a-f0-9]{64}$/.test(binding?.containerId??'')||inspected.Id!==binding.containerId||inspected.Image!==binding.imageId||!inspected.State?.Running||!Number.isSafeInteger(inspected.State.Pid)||inspected.State.Pid<1)throw new Error('Container identity/image/liveness mismatch');
 if(inspected.Config?.Labels?.['evimed.eval.owner']!==binding.owner||inspected.Config?.Labels?.['evimed.eval.scope']!==binding.scope)throw new Error('Container ownership/scope mismatch');
 if(inspected.HostConfig?.PidMode==='host'||inspected.HostConfig?.NetworkMode!=='host')throw new Error('Evaluation container must retain its PID namespace with verified loopback networking');
 const chain=/^NSpid:\s*(.+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
 if(!chain||chain.length<2||chain[0]!==inspected.State.Pid||chain.at(-1)!==namespacePid)throw new Error('Container namespace PID proof mismatch');
 return inspected.State.Pid;
}
export function resolveOperatorContainer(file,containerId,scope,namespacePid){
 if(!file)throw new Error('Operator container bindings missing');
 const stat=fs.statSync(file);if(stat.uid!==0||(stat.mode&0o077)!==0)throw new Error('Container bindings must be root-owned private operator state');
 const binding=JSON.parse(fs.readFileSync(file,'utf8')).containers?.find(b=>b.containerId===containerId&&b.scope===scope);
 if(!binding)throw new Error('Container absent from exact operator admission');
 const result=spawnSync('docker',['inspect',containerId],{encoding:'utf8'});if(result.status!==0)throw new Error('Operator Docker identity unavailable');
 const inspected=JSON.parse(result.stdout)[0];const status=fs.readFileSync(`/proc/${inspected.State?.Pid}/status`,'utf8');
 return {hostPid:validateContainerIdentity(binding,inspected,namespacePid,status),containerId,imageId:binding.imageId,namespacePid,scope};
}
