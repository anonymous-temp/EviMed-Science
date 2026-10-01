import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {before,after,test} from 'node:test';
import {createFixtures} from './fixtures.mjs';
const image=process.env.COWORK_TEST_IMAGE??'';
const options={skip:!image&&'COWORK_TEST_IMAGE immutable digest is required'};
let root,resources;
before(async()=>{if(!image)return;assert.match(image,/^sha256:[a-f0-9]{64}$/);const parent=process.env.COWORK_TEST_FIXTURE_PARENT??os.tmpdir();await fs.mkdir(parent,{recursive:true});root=await fs.mkdtemp(path.join(parent,'evimed-cowork-fixtures-'));await fs.chmod(root,0o755);resources=await createFixtures(root);});
after(async()=>{if(root)await fs.rm(root,{recursive:true});});
function command(request){return new Promise((resolve,reject)=>{
  const child=spawn('docker',['run','--rm','--network','none','--read-only','--cpus','1','--memory','512m','--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,nodev,size=64m','--mount',`type=bind,source=${root},target=/input,readonly`,'-i',image]);
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdin.end(JSON.stringify(request));child.on('close',code=>{try{resolve({code,body:JSON.parse(stdout),stderr});}catch{reject(new Error(`Isolated runner did not return JSON: ${stderr}`));}});
});}
test('actual portable core reads Chinese DOCX, inert notebook and PDF inside a non-root readonly networkless runner',options,async()=>{
  for(const [resourceId,format,needle]of [['res_docx','docx','公开文档'],['res_notebook','ipynb','must remain inert'],['res_pdf','pdf','Public PDF fixture']]){
    const result=await command({operation:'doc_read',resourceId});assert.equal(result.code,0,result.stderr);assert.equal(result.body.data.format,format);assert(JSON.stringify(result.body.data).includes(needle));
  }
});
test('actual writer creates XLSX/notebook; generated XLSX roundtrips without formula or code execution',options,async()=>{
  const result=await command({operation:'doc_write',targetId:'out_public',format:'xlsx',spec:{kind:'create',sheets:[{name:'Public',cells:[{ref:'A1',value:'公开表格'},{ref:'B1',value:42}]}]}});
  assert.equal(result.code,0,result.stderr);const bytes=Buffer.from(result.body.data.contentBase64,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),result.body.data.sha256);
  await fs.writeFile(path.join(root,'roundtrip.xlsx'),bytes);resources.res_roundtrip={file:'roundtrip.xlsx',format:'xlsx',bytes:bytes.length,sha256:result.body.data.sha256,dataClass:'public'};
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({resources}));
  const read=await command({operation:'doc_read',resourceId:'res_roundtrip'});assert.equal(read.code,0,read.stderr);assert(JSON.stringify(read.body.data).includes('公开表格'));assert(JSON.stringify(read.body.data).includes('42'));
  const notebook=await command({operation:'doc_write',targetId:'out_notebook',format:'ipynb',spec:{kind:'create',cells:[{type:'code',source:'raise SystemExit("not executed")'}]}});
  assert.equal(notebook.code,0);assert.equal(notebook.body.data.codeExecuted,false);const nb=JSON.parse(Buffer.from(notebook.body.data.contentBase64,'base64'));assert.deepEqual(nb.cells[0].outputs,[]);assert.equal(nb.cells[0].execution_count,null);
});
test('macros, external relationships, traversal, symlinks and private-data classifications are refused before decoding',options,async()=>{
  for(const request of [{operation:'doc_read',resourceId:'res_macro'},{operation:'doc_read',resourceId:'res_external'},{operation:'doc_read',resourceId:'../data-plane'},{operation:'doc_read',resourceId:'res_docx',path:'/etc/passwd'}]){
    const result=await command(request);assert.notEqual(result.code,0);assert.equal(result.body.ok,false);
  }
  const external=await fs.readFile(path.join(root,'external.docx'));await fs.writeFile(path.join(root,'renamed.ipynb'),external);resources.res_renamed={...resources.res_external,file:'renamed.ipynb',format:'ipynb'};
  const mislabeled=await fs.readFile(path.join(root,'public.docx'));await fs.writeFile(path.join(root,'mislabeled.xlsx'),mislabeled);resources.res_mislabeled={...resources.res_docx,file:'mislabeled.xlsx',format:'xlsx'};
  const mismatch=await fs.readFile(path.join(root,'public.docx'));mismatch[30]=120;await fs.writeFile(path.join(root,'mismatch.docx'),mismatch);resources.res_mismatch={...resources.res_docx,file:'mismatch.docx',sha256:createHash('sha256').update(mismatch).digest('hex')};
  await fs.symlink('public.docx',path.join(root,'linked.docx'));resources.res_link={...resources.res_docx,file:'linked.docx'};resources.res_private={...resources.res_docx,dataClass:'patient'};
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({resources}));
  for(const resourceId of ['res_link','res_private','res_renamed','res_mismatch','res_mislabeled'])assert.notEqual((await command({operation:'doc_read',resourceId})).code,0);
});
test('Docker cancellation removes only an owned process scope and observes its exit',options,()=>{
  const name='evimed-cowork-cancel-fixture-'+process.pid;
  try{execFileSync('docker',['run','-d','--name',name,'--network','none','--read-only','--memory','128m','--pids-limit','16','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','node',image,'-e','setInterval(()=>{},1000)']);
    execFileSync('docker',['stop','--time','2',name]);assert.equal(execFileSync('docker',['inspect','--format','{{.State.Running}}',name],{encoding:'utf8'}).trim(),'false');
  }finally{execFileSync('docker',['rm','-f',name]);}
});
