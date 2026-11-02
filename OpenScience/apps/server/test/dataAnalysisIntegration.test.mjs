import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebApiApp } from '../src/server.mjs';
import { analysisDigest } from '../src/dataAnalysisArtifacts.mjs';

test('generic project mutation refuses an API-owned project before deletion, archive or rename effects',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'analysis-project-guard-'));
  const app=createWebApiApp({dataDir,port:0,runtimeMode:'mock',devAuth:true});
  try{
    const address=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}`;
    const user=await app.store.devUser(),id=`da-${'a'.repeat(40)}`;
    await app.store.createProject(user,id,'Owned analysis');
    for(const [method,suffix,body] of [['DELETE','',{confirm:id}],['PATCH','',{name:'Changed'}],['POST','/archive',{archived:true}]]){
      const response=await fetch(`${base}/api/projects/${id}${suffix}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,409);assert.equal((await response.json()).code,'analysis_project_reserved');
    }
    const project=await app.store.requireProject(user,id);assert.equal(project.name,'Owned analysis');assert(!project.archivedAt);
  }finally{await app.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

async function withApp(fn, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-project-list-'));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: 'mock', devAuth: true, runTitlesEnabled: false, ...overrides });
  try {
    const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
    const headers = { 'X-Open-Science-Project': 'default', 'Content-Type': 'application/json' };
    const call = async (method, route, body) => {
      const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    await call('GET', '/api/me');
    await fn({ call, app, dataDir, user: await app.store.userById('dev') });
  } finally { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

test('the API\'s own projects are not the person\'s: never listed, never counted against the project ceiling', async () => {
  await withApp(async ({ call, app, user }) => {
    for (const hex of ['a', 'b', 'c']) await app.store.createProject(user, `da-${hex.repeat(40)}`, 'Analysis');
    const listed = (await call('GET', '/api/projects')).body.data.map(item => item.id);
    assert.ok(!listed.some(id => id.startsWith('da-')), listed.join(','));
    const me = (await call('GET', '/api/me')).body.data.projects.map(item => item.id);
    assert.ok(!me.some(id => id.startsWith('da-')), me.join(','));
    assert.equal((await call('POST', '/api/projects', { name: 'One' })).status, 200, 'three hidden analyses leave the ceiling of two untouched');
    assert.equal((await call('POST', '/api/projects', { name: 'Two' })).body.data?.name, 'Two');
    assert.equal((await call('POST', '/api/projects', { name: 'Three' })).body.code, 'project_limit_reached');
  }, { maxProjectsPerUser: 3 });
});

test('account deletion also removes the analyses\' preserved bytes, which live outside the account\'s directory', async () => {
  await withApp(async ({ call, dataDir, user }) => {
    const mine = path.join(dataDir, '.openscience', 'data-analysis', analysisDigest(user.id), `ana_${'a'.repeat(40)}`);
    const others = path.join(dataDir, '.openscience', 'data-analysis', analysisDigest('someone-else'), `ana_${'b'.repeat(40)}`);
    for (const directory of [mine, others]) { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'f'), 'bytes'); }
    const deleted = await call('DELETE', '/api/account', { confirm: user.id });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    await assert.rejects(fs.access(mine), { code: 'ENOENT' });
    await fs.access(others);
  });
});
