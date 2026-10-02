import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assessmentDockerEnvironment,bindAssessmentDockerLauncher} from '../extension-saas-acceptance-docker.mjs';
test('Docker context is one closed local driver setting; remote host/socket/key environment refused or omitted',()=>{
 assert.deepEqual(assessmentDockerEnvironment({PATH:'/bin'}),{PATH:'/bin'});
 assert.deepEqual(assessmentDockerEnvironment({PATH:'/bin',DOCKER_CONTEXT:'colima-evimed-extension-acceptance',DOCKER_HOST:'tcp://example.invalid',API_KEY:'canary'}),{PATH:'/bin',DOCKER_CONTEXT:'colima-evimed-extension-acceptance'});
 for(const context of ['remote','../socket','https://example.invalid'])assert.throws(()=>assessmentDockerEnvironment({DOCKER_CONTEXT:context}));
});
test('owned launcher restores only frozen context despite stripped controller env and preserves exact argv',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'evimed-saas-launcher-'))),file=path.join(root,'docker-fixture.mjs');
 try{await fs.writeFile(file,"console.log(JSON.stringify({argv:process.argv.slice(2),context:process.env.DOCKER_CONTEXT,key:process.env.API_KEY??null}));",{mode:0o700});
 await bindAssessmentDockerLauncher(file,{PATH:process.env.PATH,DOCKER_CONTEXT:'colima-evimed-extension-acceptance'});
 const result=await promisify(execFile)(process.execPath,[file,'create','literal space','$(never executed)'],{env:{PATH:process.env.PATH},timeout:5000});
 assert.deepEqual(JSON.parse(result.stdout),{argv:['create','literal space','$(never executed)'],context:'colima-evimed-extension-acceptance',key:null});
 await assert.rejects(bindAssessmentDockerLauncher(file,{DOCKER_CONTEXT:'remote'}));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
