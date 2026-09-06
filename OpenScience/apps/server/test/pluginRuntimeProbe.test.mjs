import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../../packages/socket/package.json',import.meta.url));

test('fixed proof uses an authenticated rc.1 host, complete shipped preset and side-effect-free native Agent registry', {
  skip:!process.env.EVIMED_CITATION_COMPOSITION_IMAGE, timeout:180000,
},()=>{
  const citeRoot=path.dirname(realpathSync(require.resolve('dsh-cite/package.json')));
  const script=readFileSync(new URL('./fixtures/plugin-runtime-probe.mjs',import.meta.url),'utf8');
  const output=execFileSync('docker',['run','--rm','-i','--network','none','--entrypoint','/usr/bin/env','--tmpfs','/tmp:rw,exec,size=512m',
    '-v',`${root}:/repo:ro`,'-v',`${citeRoot}:/cite:ro`,process.env.EVIMED_CITATION_COMPOSITION_IMAGE,
    '-i','PATH=/usr/local/bin:/usr/bin:/bin','node','--input-type=module','-'],{input:script,encoding:'utf8',timeout:175000,maxBuffer:1024*1024});
  const result=JSON.parse(output);
  assert.deepEqual(result.map(x=>({enabled:x.enabled,timeoutMs:x.timeoutMs,tools:x.tools.length})),[
    {enabled:true,timeoutMs:2000,tools:5},{enabled:true,timeoutMs:4000,tools:5},{enabled:false,timeoutMs:4000,tools:0}]);
  assert.ok(result.every(x=>x.binaryVersion==='0.3.2'));
});
