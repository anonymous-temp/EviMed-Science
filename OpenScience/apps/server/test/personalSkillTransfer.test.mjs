import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { decodePersonalSkillTransfer, decodeAccountSkillData, exportPersonalSkills } from '../src/personalSkillTransfer.mjs';

const bytes=Buffer.from('Preserved public resource 公开资料'),digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
function envelope(){return{format:'evimed-personal-skills',version:1,skills:[{sourceId:'skill:original',revisions:[{revision:1,title:'Review',description:'Preserve evidence',instructions:'Read the supplied source.',
  invocation:{userInvocable:false,modelInvocable:false},metadata:{origin:'authored-data'},whenToUse:null,resources:[{path:'references/公开资料.txt',digest,size:bytes.length}]}]}],resources:[{digest,size:bytes.length,base64:bytes.toString('base64')}]};}

test('authored histories retain invocation and exact Unicode resource bytes without importing owner or prepared authority',()=>{
  const decoded=decodePersonalSkillTransfer(Buffer.from(JSON.stringify(envelope())));
  assert.deepEqual(decoded.resources.get(digest),bytes);assert.equal(decoded.skills[0].revisions[0].invocation.modelInvocable,false);
  assert.equal(Object.hasOwn(decoded.skills[0],'ownerId'),false);
});

test('forged authority, history collisions, resource aliases, corrupt hashes and noncanonical base64 are refused',()=>{
  for(const change of [
    e=>{e.ownerId='another-account';},e=>{e.skills[0].prepared=true;},e=>{e.skills[0].revisions[0].nativeName='required-platform-skill';},
    e=>{e.skills[0].revisions.push({...e.skills[0].revisions[0]});},e=>{e.resources[0].base64+='\n';},
    e=>{e.resources[0].digest='sha256:'+'0'.repeat(64);},e=>{e.skills[0].revisions[0].resources[0].path='../private';},
    e=>{e.skills[0].revisions[0].resources.push({...e.skills[0].revisions[0].resources[0],path:'references/公开资料.TXT'});},
    e=>{e.resources.push({digest:'sha256:'+createHash('sha256').update('unused').digest('hex'),size:6,base64:Buffer.from('unused').toString('base64')});},
  ]){const e=envelope();change(e);assert.throws(()=>decodePersonalSkillTransfer(Buffer.from(JSON.stringify(e))));}
});

test('owned current and historical revisions share content bytes in one portable envelope and exclude runtime metadata',async()=>{
  const revision=envelope().skills[0].revisions[0],resource={...revision.resources[0],id:'resource:'+digest.slice(7)};
  const payload={...revision,resources:[resource],nativeName:'personal-old-owner',prepared:true,digest:'sha256:'+'a'.repeat(64)};
  const skills={get:async(user,id)=>{assert.equal(user.id,'alice');return{id,revision:2,payload};},documents:{history:async()=>[{revision:2,payload:{...payload,instructions:'Updated source reading.'}},{revision:1,payload}]}};
  const encoded=await exportPersonalSkills({skills,artifacts:{resourceBytes:async()=>bytes}},{id:'alice'},['skill:original']);
  const decoded=decodePersonalSkillTransfer(encoded);assert.equal(decoded.skills[0].revisions.length,2);assert.equal(decoded.resources.size,1);
  assert.equal(encoded.toString().includes('personal-old-owner'),false);assert.equal(encoded.toString().includes('prepared'),false);
});

test('account data selects authored skill histories while leaving source accounts, projects, connections and proof authority behind',()=>{
  const original=envelope(),revision=original.skills[0].revisions[0],payload={schemaVersion:1,...revision,resources:revision.resources.map(r=>({...r,id:'resource:'+digest.slice(7)})),prepared:false};delete payload.revision;
  const state={version:1,account:{id:'old-owner',accountCreatedAt:'old-epoch'},projects:[{id:'old-project'}],connections:[{token:'fixture-not-authority'}],
    documents:[{kind:'skill',id:'skill:original',revision:2,payload:{...payload,instructions:'Second authored version.'}},{kind:'extension-proof',id:'old-proof',payload:{qualified:true}}],
    revisions:[{kind:'skill',id:'skill:original',revision:1,payload}],personalSkillResources:[{...original.resources[0],id:'resource:'+digest.slice(7)}]};
  const decoded=decodeAccountSkillData(Buffer.from(JSON.stringify(state)),['skill:original']);assert.equal(decoded.skills[0].revisions.length,2);
  assert.equal(JSON.stringify(decoded.skills).includes('old-owner'),false);assert.equal(JSON.stringify(decoded.skills).includes('qualified'),false);
  state.documents[0].payload.prepared=true;assert.throws(()=>decodeAccountSkillData(Buffer.from(JSON.stringify(state)),['skill:original']));
});
