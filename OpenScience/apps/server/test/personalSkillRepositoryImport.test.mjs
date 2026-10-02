import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { PersonalSkillRepositoryImport } from '../src/personalSkillRepositoryImport.mjs';

const commit='a'.repeat(40),treeSha='b'.repeat(40),user={id:'alice',accountCreatedAt:'2026-10-02T00:00:00Z'};
const blobHash=bytes=>createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
function fixture(){
  const files={'skills/example/SKILL.md':Buffer.from('---\nname: example\ndescription: Public fixture\n---\n\nRead the supplied source.\n'),
    'skills/example/references/公开说明.txt':Buffer.from('Public reference 公开说明')};
  const subtree='c'.repeat(40),leaf='d'.repeat(40);
  const state={entries:Object.entries(files).map(([name,bytes])=>({path:name.replace('skills/example/',''),type:'blob',mode:'100644',sha:blobHash(bytes),size:bytes.length})),truncated:false,uploads:0,removals:0};
  const transport=async({url,headers,signal,maxBytes})=>{
    assert.equal(Object.hasOwn(headers,'authorization'),false);assert(signal instanceof AbortSignal);assert(maxBytes<=4*1024*1024);
    if(url.hostname==='api.github.com'&&url.pathname.endsWith('/commits/'+commit))return{status:200,body:Buffer.from(JSON.stringify({sha:commit,tree:{sha:treeSha}}))};
    if(url.hostname==='api.github.com'&&url.pathname.endsWith('/trees/'+treeSha))return{status:200,body:Buffer.from(JSON.stringify({sha:treeSha,tree:[{path:'skills',type:'tree',mode:'040000',sha:subtree}]}))};
    if(url.hostname==='api.github.com'&&url.pathname.endsWith('/trees/'+subtree))return{status:200,body:Buffer.from(JSON.stringify({sha:subtree,tree:[{path:'example',type:'tree',mode:'040000',sha:leaf}]}))};
    if(url.hostname==='api.github.com'&&url.pathname.endsWith('/trees/'+leaf))return{status:200,body:Buffer.from(JSON.stringify({sha:leaf,truncated:state.truncated,tree:state.entries}))};
    if(url.hostname==='api.github.com'&&url.pathname.includes('/blobs/')){const sha=url.pathname.split('/').at(-1),bytes=Object.values(files).find(value=>blobHash(value)===sha);return{status:200,body:Buffer.from(JSON.stringify({sha,encoding:'base64',size:bytes.length,content:bytes.toString('base64')}))};}
    throw new Error('Unexpected fixed request');
  };
  const skills={upload:async(actual,kind,bytes)=>{assert.equal(actual,user);assert.equal(kind,'zip');state.archive=bytes;state.uploads++;return{resourceId:'upload:fixture'};},
    previewImport:async()=>({description:'Public fixture',instructions:'Read only the supplied source.',resources:[{path:'references/公开说明.txt'}]}),
    removeUpload:async()=>{state.removals++;}};
  const importer=new PersonalSkillRepositoryImport({transport,skills});
  return{state,files,skills,importer,input:{repository:'PublicOwner/research-skills',commit,subdirectory:'skills/example'}};
}

test('immutable public subtree acquisition validates real Git blob hashes and stages existing owned native preview only',async()=>{
  const f=fixture(),result=await f.importer.preview(user,f.input);
  assert.equal(result.resourceId,'upload:fixture');assert.deepEqual(result.immutableSource,f.input);
  const extracted=unzipSync(f.state.archive);assert.deepEqual(Buffer.from(extracted['references/公开说明.txt']),f.files['skills/example/references/公开说明.txt']);
  assert.equal(f.state.uploads,1);assert.equal(result.preview.resources.length,1);
});

test('mutable references, caller destinations, missing account epoch, truncated trees, symlinks and byte drift never stage data',async()=>{
  for(const change of [
    f=>{f.input.commit='main';},f=>{f.input.url='https://example.invalid';},
    f=>{f.state.truncated=true;},f=>{f.state.entries[1].mode='120000';},
    f=>{f.state.entries[1].sha='0'.repeat(40);},f=>{f.state.entries[1].path='../outside';},
    f=>{f.state.entries.push({...f.state.entries[1],path:'references/公开说明.TXT'});},
    f=>{f.state.entries[0].size=4*1024*1024;},
  ]){const f=fixture();change(f);await assert.rejects(f.importer.preview(user,f.input));assert.equal(f.state.uploads,0);}
  const f=fixture();await assert.rejects(f.importer.preview({id:'alice'},f.input));assert.equal(f.state.uploads,0);
});

test('redirects are refused and failed native preview removes only its owned upload',async()=>{
  const f=fixture();const refused=new PersonalSkillRepositoryImport({skills:f.skills,transport:async()=>({status:302,body:Buffer.alloc(0)})});
  await assert.rejects(refused.preview(user,f.input));assert.equal(f.state.uploads,0);
  f.skills.previewImport=async()=>{throw new Error('Fixture native refusal');};await assert.rejects(f.importer.preview(user,f.input));assert.equal(f.state.uploads,1);assert.equal(f.state.removals,1);
});
