import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
for(const stage of ['verification','compilation'])test(`both build drivers stop before publication after benign ${stage} failure`,async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cowork-build-failure-'));
  try{for(const name of ['build.sh','overlay/build.sh']){
    const script=await fs.readFile(path.join(here,name),'utf8');
    const flags=/timeout --kill-after=10 600 sh (-[a-z]+) '/.exec(script)?.[1];assert(flags,'actual contained shell invocation must be found');
    const log=path.join(root,name.replaceAll('/','-'));
    // Exercise the actual driver shell flags with harmless commands. No vendor
    // code runs here: markers stand for verification, compilation and publication.
    const commands=stage==='verification'?'printf verification >> "$1"; false; printf compilation >> "$1"; printf publication >> "$1"':'printf verification >> "$1"; printf compilation >> "$1"; false; printf publication >> "$1"';
    const result=spawnSync('sh',[flags,commands,'fixture',log],{encoding:'utf8'});
    assert.notEqual(result.status,0,`${name} must propagate failure`);
    assert.equal(await fs.readFile(log,'utf8'),stage==='verification'?'verification':'verificationcompilation');
  }}finally{await fs.rm(root,{recursive:true});}
});
