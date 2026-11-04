import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateAuthorization,protocolText,n2c2Prompt,privateFile} from './n2c2-preflight.mjs';

const definition=JSON.parse(await fs.readFile(new URL('./n2c2-protocol.json',import.meta.url),'utf8'));
function authorized() {
  return {schema:1,dataset:'n2c2-2018-t1',userConfirmed:true,provider:'deepseek-official',
    destination:'https://api.deepseek.com',purpose:'vcr-platform-evaluation',
    confirmationReference:'user-confirmation-20261104',experimentId:'vcrbench-n2c2-offline',
    dataProvenance:{kind:'user-supplied',sourceRoot:'/user-supplied/private',archiveSha256:definition.source.archiveSha256}};
}
test('authorization permits only the specific dataset, original package, destination and experiment',()=>{
  assert.equal(validateAuthorization(authorized(),definition,'vcrbench-n2c2-offline').userConfirmed,true);
  for(const changes of [{userConfirmed:false},{dataset:'other'},{destination:'https://other.invalid'},
    {provider:'other'},{experimentId:'vcrbench-other'},{labels:{HBA1C:'met'}}]){
    assert.throws(()=>validateAuthorization({...authorized(),...changes},definition,'vcrbench-n2c2-offline'));
  }
  assert.throws(()=>validateAuthorization({...authorized(),dataProvenance:{...authorized().dataProvenance,archiveSha256:{}}},definition));
});
test('Python and JavaScript protocol renderers agree and omit scoring-only defaults',()=>{
  const code="import importlib.util,json;from pathlib import Path;p=Path('OpenScience/evals/vcr-platform-comparison/n2c2-prepare.py');s=importlib.util.spec_from_file_location('prepare',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.protocol_text(json.loads(m.PROTOCOL.read_bytes())),end='')";
  const result=spawnSync('python3',['-c',code],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,protocolText(definition));
  assert.doesNotMatch(result.stdout,/unknownAsMet|Binary sensitivity/);
});
test('protocol prompt requests real saved protocol matching without candidate-registry or answer seed',()=>{
  const text=n2c2Prompt({dataset:'n2c2-2018-t1',task:'protocol_matching'},{id:'n2c2-test-001',asOf:'2020-01-15'});
  assert.match(text,/trial_to_patient/);assert.match(text,/protocol.txt/);assert.match(text,/patient.txt/);
  assert.doesNotMatch(text,/NCT\d|requirement.*op|expert_eligibility|not met.*ENGLISH/);
  assert.throws(()=>n2c2Prompt({dataset:'other',task:'protocol_matching'},{id:'n2c2-test-001',asOf:'2020-01-15'}));
});
test('protected manifest files outside private acceptance or relative paths are refused',async()=>{
  await assert.rejects(privateFile('relative.json'));
  await assert.rejects(privateFile(fileURLToPath(new URL('./n2c2-protocol.json',import.meta.url))));
});

test('an unrelated or denied original consent cannot be spliced into a self-declared inline authorization',async()=>{
  const os=await import('node:os'),path=await import('node:path');
  const {authorizationBinding,sha}=await import('./n2c2-preflight.mjs');
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'n2c2-authorization-attack-'));
  try{
    const directory=path.join(await fs.realpath(tmp),'.evimed-local','acceptance','fixture');
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const originalFile=path.join(directory,'original.json'),bindingFile=path.join(directory,'binding.json');
    const original=JSON.stringify({...authorized(),userConfirmed:false});
    await fs.writeFile(originalFile,original,{mode:0o600});
    const binding={schema:1,dataset:'n2c2-2018-t1',authorization:authorized(),authorizationSha256:sha(original),
      authorizationFile:originalFile,preparedAt:'2026-11-04T00:00:00Z',preparerSha256:'0'.repeat(64),
      manifests:['train','test'].map(split=>({split,manifestPath:path.join(directory,split,'cases.json'),
        manifestSha256:'0'.repeat(64),inputSetSha256:'0'.repeat(64)}))};
    await fs.writeFile(bindingFile,JSON.stringify(binding),{mode:0o600});
    await assert.rejects(authorizationBinding(bindingFile),/n2c2_authorization_snapshot_mismatch/);
  }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
