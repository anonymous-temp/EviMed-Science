import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtensionAccess } from '../src/extensionAccess.mjs';

test('access never derives a project owner or role from request-supplied actor fields',async()=>{
  const access=new ExtensionAccess({store:{requireProject:async(user,id)=>{assert.equal(user.id,'a');if(id!=='p1')throw Object.assign(new Error(),{status:404});return{id,userId:'a'};}}});
  assert.equal((await access.project({id:'a',role:'viewer'},'p1',{manage:true})).userId,'a');
  await assert.rejects(access.project({id:'a'},'p2'),{status:404});
});
test('shared roles and revocation are resolved on every operation, with concealed refusals',async()=>{
  let role='viewer',calls=0;
  const access=new ExtensionAccess({projectAccess:async()=>{calls++;return role?{project:{id:'shared',userId:'owner'},role}:null;}});
  assert.equal((await access.project({id:'viewer'},'shared')).userId,'owner');
  await assert.rejects(access.project({id:'viewer'},'shared',{manage:true}),{status:404});
  role='editor';assert.equal((await access.project({id:'editor'},'shared',{manage:true})).id,'shared');
  role=null;await assert.rejects(access.project({id:'editor'},'shared'),{status:404});assert.equal(calls,4);
});
test('connection references need current actor-scoped authority, never copied credential values',async()=>{
  const absent=new ExtensionAccess({});await assert.rejects(absent.connections({id:'a'},['connection-one']),{status:403});
  let active=true;
  const access=new ExtensionAccess({connectionAccess:async(user,ref)=>user.id==='a'&&ref==='connection-one'&&active});
  await access.connections({id:'a'},['connection-one']);
  await assert.rejects(access.connections({id:'b'},['connection-one']),{status:403});
  active=false;await assert.rejects(access.connections({id:'a'},['connection-one']),{status:403});
});


test('study capabilities and membership epochs are resolved independently from ordinary project ownership', async () => {
  let roles = ['viewer'], epoch = 'first-membership';
  const access = new ExtensionAccess({
    store: { userById: async id => ({ id }), requireProject: async (user, id) => {
      if (user.id !== 'owner') throw Object.assign(new Error('Not owned'), { status: 404 });
      return { id, userId: 'owner' };
    } },
    studyAccess: async () => ({ ownerId: 'owner', roles, epoch }),
  });
  const user = { id: 'member' };
  assert.equal((await access.project(user, 'study-project')).extensionMembershipEpoch, epoch);
  await assert.rejects(access.project(user, 'study-project', { ability: 'write' }), { status: 403 });
  await assert.rejects(access.project(user, 'study-project', { manage: true }), { status: 403 });
  roles = ['data_manager'];
  assert.equal((await access.project(user, 'study-project', { ability: 'write' })).userId, 'owner');
  await assert.rejects(access.project(user, 'study-project', { manage: true }), { status: 403 });
  roles = [];
  await assert.rejects(access.project(user, 'study-project'), { status: 403 });
  roles = ['viewer']; epoch = 're-added-membership';
  assert.equal((await access.project(user, 'study-project')).extensionMembershipEpoch, epoch);
});
