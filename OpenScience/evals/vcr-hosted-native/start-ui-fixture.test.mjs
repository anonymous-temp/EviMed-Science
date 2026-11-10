import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
test('an existing fixture output directory is refused without replacing its resource inventory',async()=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'vcr-ui-fixture-test-')),dir=path.join(parent,'owned'),file=path.join(dir,'resources.json');
  try{await mkdir(dir);await writeFile(file,'original');await assert.rejects(run('bash',[fileURLToPath(new URL('./start-ui-fixture.sh',import.meta.url))],{env:{...process.env,VCR_PROVIDER_KEY_FILE:'/unused',VCR_LINUX_DOCKER_CLI:'/unused',VCR_UI_OUTPUT_DIR:dir}}));assert.equal(await readFile(file,'utf8'),'original');}
  finally{await rm(parent,{recursive:true,force:true});}
});
