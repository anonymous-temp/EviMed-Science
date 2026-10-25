import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/geoStore.mjs';
import { contextPolicyIdentity } from '../../src/geoContextItems.mjs';
import { createWebApiApp } from '../../src/server.mjs';
import { RuntimeManager } from '../../src/runtimeManager.mjs';
import { createGeoTestDatabase } from './geoTestDatabase.mjs';


// This protocol fixture certifies production composition and real HTTP/DB
// identity handling. It is not a runtime launch or installed-kernel receipt.
async function fixture(t, geoEnabled = true, configOverrides = {}) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geocomposition');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-composition-'));
  let creates = 0;
  const sessions = new Map();
  const app = createWebApiApp({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', geoEnabled, geoAudience: 'all',
    runtimeMode: 'mock', devAuth: false, authMode: 'local', bootstrapUser: '', bootstrapPassword: '',
    runtimeUiProxyEnabled: true, publicUrl: 'http://127.0.0.1', runtimeUiPublicOrigin: 'http://127.0.0.1:8443', databasePoolMax: 1, ...configOverrides }, {
    runtimeManagerFactory: (config, hooks) => {
      const manager = new RuntimeManager(config, hooks);
      manager.start = async project => {
        const key = manager.key(project);
        if (!manager.runtimes.has(key)) manager.runtimes.set(key, { kind: 'mock', project, close: async () => {}, modelGatewayTokenJti: 'fixture-generation', startedAt: new Date().toISOString() });
        return manager.runtimes.get(key);
      };
      manager.stop = async project => { manager.runtimes.delete(manager.key(project)); };
      manager.ensureContextPolicyGeneration = async () => ({ adopted: false });
      manager.assertContextPolicyGeneration = async project => {
        assert.equal(typeof project.workspaceDir,"string","proof uses the canonical full owner project");
        const policy = await manager.contextPolicies.forProject(project);
        assert.equal(policy.kind, 'geo-project');
        if (manager.runtimeGeneration(project) !== 'fixture-generation') throw Object.assign(new Error('Old generation'), {status:409});
        const identity={recordType:'geo-runtime-context-launch',version:1,state:'launched',generation:'fixture-generation',digest:'1'.repeat(64),policy:contextPolicyIdentity(policy)};
        const referenceId=`gcr_${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`;
        const existing=await manager.contextDocuments.get(project.userId,'geo-plan-context',referenceId);
        if(!existing)await manager.contextDocuments.put(project.userId,'geo-plan-context',referenceId,{...identity,referenceId},{projectId:project.id,expectedRevision:0});
        return {...identity,referenceId};
      };
      manager.kernelWorkspaceId = async () => 'fixture-workspace';
      manager.subagentAddressFor = async () => null;
      manager.callKernel = async (_runtime, project, method, payload) => {
        if(method==='session/create') {
          const id=payload?.request?.sessionId ?? `native-${++creates}`;
          const known=sessions.get(manager.key(project))??[];
          if(!known.some(item=>item.sessionId===id))sessions.set(manager.key(project),[...known,{sessionId:id}]);
          return {sessionId:id};
        }
        assert.equal(method, 'session/list');
        return { items: sessions.get(manager.key(project)) ?? [] };
      };
      return manager;
    },
  });
  t.after(async () => { await app.close(); await isolated.drop(); await rm(dataDir,{recursive:true,force:true}); });
  for (const id of ['owner','editor','viewer']) await app.store.createUser(id, 'composition-password', id);
  const address = await app.listen(0, '127.0.0.1');
  await app.geo?.worker.close();
  const base = `http://127.0.0.1:${address.port}`, cookies = {};
  for (const id of ['owner','editor','viewer']) {
    const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:id,password:'composition-password'})});
    const body=await response.json(); cookies[id]={'content-type':'application/json',cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),'x-open-science-csrf':body.data.csrfToken};
  }
  const call=async(user,method,route,body)=>{const response=await fetch(`${base}${route}`,{method,headers:cookies[user],...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  return {app,call,sessions,cookies,base,creates:()=>creates};
}


export { fixture };
