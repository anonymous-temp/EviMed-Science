import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {verifyGeoMethodPack} from '../../../deploy/runtime-dsh/check-geo-method-pack.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'geo-pack-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=[['shared/reference.md','A reference'],['skills/example/SKILL.md','---\nname: example\n---\nMethod']];
 for(const [name,text]of files){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),text);}
 const tree=sha(files.map(([name,text])=>`${name}\0${sha(text)}\n`).join(''));
 const expected={version:'1.0.0',archiveSha256:'a'.repeat(64),treeSha256:tree,skills:['example']};
 await writeFile(path.join(root,'VENDORED.json'),JSON.stringify({package:'geo-skills',version:expected.version,sha256:expected.archiveSha256,tree,files:2}));return{root,expected};
}
test('reviewed private bytes and exact inventory qualify; stale versions and changed bodies do not',async t=>{
 const {root,expected}=await fixture(t);assert.equal((await verifyGeoMethodPack(root,expected)).configured,true);
 await assert.rejects(verifyGeoMethodPack(root,{...expected,version:'2.0.0'}),/matching private archive/);
 await assert.rejects(verifyGeoMethodPack(root,{...expected,skills:['different']}),/inventory/);
 await writeFile(path.join(root,'shared/reference.md'),'Changed instructions');await assert.rejects(verifyGeoMethodPack(root,expected),/changed after review/);
});
test('a public clone may explicitly omit the pack, never preserve an old one as a new release',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'geo-pack-empty-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'README.md'),'Private pack not included');
 assert.deepEqual(await verifyGeoMethodPack(root,{}, {allowMissing:true}),{configured:false,reason:'private_method_pack_missing'});
 await assert.rejects(verifyGeoMethodPack(root,{}),/required/);
 const f=await fixture(t);await assert.rejects(verifyGeoMethodPack(f.root,{...f.expected,archiveSha256:'b'.repeat(64)},{allowMissing:true}),/matching private archive/);
});
test('a linked method source cannot masquerade as reviewed bytes',async t=>{
 const{root,expected}=await fixture(t);await rm(path.join(root,'shared/reference.md'));await symlink(path.join(root,'skills/example/SKILL.md'),path.join(root,'shared/reference.md'));
 await assert.rejects(verifyGeoMethodPack(root,expected),/links/);
});
