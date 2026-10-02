/** Test-only real Docker validator transport for Mac/Colima sharing; never used by serving composition. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createSkillValidationController} from '../../src/skillValidationController.mjs';
/** dataDir must be a descriptor-verified owned fixture directory shared with the daemon.
 * @param {{dataDir:string,image:string}} options */
export async function createNativeValidationFixture({dataDir,image}) {
  const wrapper=path.join(dataDir,'docker-fixture.mjs');
  await fs.writeFile(wrapper,`#!${process.execPath}\nimport {spawnSync,spawn} from 'node:child_process';import fs from 'node:fs';const args=process.argv.slice(2);if(args[0]==='create'){let result;const started=Date.now();for(let retry=0;retry<20;retry++){result=spawnSync('docker',args,{encoding:'utf8',timeout:1000,maxBuffer:65536});if(result.status===0||result.error||!String(result.stderr).includes('invalid mount config for type')||!String(result.stderr).includes('bind source path does not exist')||Date.now()-started>3500)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}if(result.status!==0||! /^[a-f0-9]{64}\\s*$/.test(result.stdout??''))fs.appendFileSync(${JSON.stringify(path.join(dataDir,'create-debug.json'))},JSON.stringify({status:result.status,error:result.error?.code,stderr:result.stderr,stdout:result.stdout})+'\\n');process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);}else{const child=spawn('docker',args,{stdio:'inherit'});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('close',code=>process.exit(code??1));}\n`,{mode:0o700});
  return createSkillValidationController({dataDir,runtimeContainerBin:wrapper,runtimeContainerImage:image,runtimeDataVolume:''},{availableMemory:async()=>Number(execFileSync('docker',['run','--rm','--pull','never','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--memory','128m','--pids-limit','32','--entrypoint','node',image,'-e',"const text=require('node:fs').readFileSync('/proc/meminfo','utf8');console.log(Number(text.match(/^MemAvailable:\\s+(\\d+)/m)[1])*1024);"],{encoding:'utf8',timeout:5000,maxBuffer:1024}).trim())});
}
