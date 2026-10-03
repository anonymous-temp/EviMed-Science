import assert from 'node:assert/strict';
import test from 'node:test';
import tar from 'tar-stream';
import { gzipSync } from 'node:zlib';
import { accountSkillStateBytes } from '../src/personalSkillTransferArchive.mjs';

async function archive(entries) {
  const pack=tar.pack(),chunks=[];pack.on('data',chunk=>chunks.push(chunk));
  const done=new Promise((resolve,reject)=>{pack.on('end',resolve);pack.on('error',reject);});
  for(const entry of entries)await new Promise((resolve,reject)=>pack.entry({name:entry.name,type:entry.type??'file',...(entry.linkname?{linkname:entry.linkname}:{})},entry.bytes??Buffer.alloc(0),error=>error?reject(error):resolve()));
  pack.finalize();await done;return gzipSync(Buffer.concat(chunks));
}

test('account tar-gzip reads only the exported customer-state bytes, never workspace paths or links',async()=>{
  const state=Buffer.from(JSON.stringify({version:1,documents:[],revisions:[]}));
  const bytes=await archive([{name:'projects/private.txt',bytes:Buffer.from('not imported')},{name:'account/customer-state.json',bytes:state},{name:'elsewhere/link',type:'symlink',linkname:'/outside'}]);
  assert.deepEqual(await accountSkillStateBytes(bytes),state);assert.deepEqual(await accountSkillStateBytes(state),state);
});

test('missing, duplicate, linked and path-aliased customer state entries are refused without extraction',async()=>{
  const state=Buffer.from('{}');
  for(const entries of [[],[{name:'elsewhere/state.json',bytes:state}],
    [{name:'account/customer-state.json',bytes:state},{name:'account/customer-state.json',bytes:state}],
    [{name:'account/customer-state.json',type:'symlink',linkname:'/private'}],
    [{name:'prefix/../account/customer-state.json',bytes:state}],
  ])await assert.rejects(accountSkillStateBytes(await archive(entries)),{code:'extension_contract_invalid'});
  await assert.rejects(accountSkillStateBytes(Buffer.from([0x1f,0x8b,0,0])),{code:'extension_contract_invalid'});
});
