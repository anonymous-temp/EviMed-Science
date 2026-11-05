/** Run synthetic source deletion against the installed public SDK in an
 * operator-selected immutable runtime image. No model, network or tenant data. */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';

const image = process.argv[2];
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Pass the inspected immutable runtime image id.');
const source = await fs.readFile(new URL('../../packages/harness-port/src/sourceConversationStorage.mjs', import.meta.url), 'utf8');
const program = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const load=async name=>import(pathToFileURL(require.resolve(name)).href);
const {captureSourceStorage,purgeSourceStorage,sourceSessionRelativePath}=await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)});
const [{Context},jsonl,{JsonStorageBackend},{descriptorOf},{projectionCacheDomainSpec},{workspaceDomainSpec}]=await Promise.all([
load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-session-persistence-jsonl'),load('@deepseek-ai/dsh-storage-json'),load('@deepseek-ai/dsh-storage-domain'),load('@deepseek-ai/dsh-session-projection-cache'),load('@deepseek-ai/dsh-workspace')]);
const paths={sessions:'/tmp/sessions',storages:'/tmp/storages'};
const headers=[{id:'source_a'},{id:'managed_child',origin:'subagent',parentSession:'source_a',isSeeded:true},{id:'source_b'},{id:'independent_fork',parentSession:'source_a',isSeeded:true}].map(row=>({version:4,createdAt:1,cwd:'/workspace',delegationDepth:0,isSeeded:false,...row}));
async function seed(rows){const ctx=new Context();try{await ctx.plugin(jsonl,{root:paths.sessions,compression:'zstd'}).await();for(const h of rows){const w=await ctx.get('sessionPersistence').create(h,{inheritedEventCount:0});await w.flush();await w.close();}}finally{await ctx.fiber.dispose();}}
await seed(headers);
let backend=new JsonStorageBackend(paths.storages);
let u=await backend.kv.open({name:'session_projcache',version:6,tables:['sessions'],hasGlobal:false,layout:'single'});
await u.putRecord('sessions','source_a',{title:'synthetic private A'});await u.putRecord('sessions','source_b',{title:'synthetic independent B'});await u.close();
await fs.copyFile('/tmp/storages/session_projcache.json','/tmp/storages/session_projcache.json.bak.synthetic');
u=await backend.kv.open(descriptorOf(projectionCacheDomainSpec));for(const row of headers)await u.putRecord('sessions',row.id,{title:row.id});await u.close();
await fs.writeFile('/tmp/storages/session_projcache/sessions/source_a.json.bak.synthetic','synthetic A backup');await fs.writeFile('/tmp/storages/session_projcache/sessions/source_b.json.bak.synthetic','synthetic B backup');
u=await backend.kv.open(descriptorOf(workspaceDomainSpec));await u.putRecord('workspaces','w',{path:'/workspace',title:'preserve',sessionIds:headers.map(h=>h.id),createdAt:1,updatedAt:2});await u.setGlobal({initialized:true,workspaceIds:['w'],archivedSessionIds:['source_a','source_b'],pinnedSessionIds:['managed_child','independent_fork']});await u.close();await backend.close();
await fs.copyFile('/tmp/storages/workspace.json','/tmp/storages/workspace.json.bak.synthetic');
const bFile='/tmp/sessions/'+sourceSessionRelativePath(headers[2])+'/session.v4.jsonl.zstd', before=await fs.readFile(bFile);
const frozen=await captureSourceStorage(paths,'source_a');assert.deepEqual(frozen.sessions.map(h=>h.id).sort(),['managed_child','source_a']);
await seed([{version:4,id:'late_grandchild',createdAt:2,cwd:'/workspace',delegationDepth:2,isSeeded:true,origin:'subagent',parentSession:'managed_child'}]);
const result=await purgeSourceStorage(paths,frozen);assert.deepEqual(result.removedSessionIds,['late_grandchild','managed_child','source_a']);
assert.deepEqual((await purgeSourceStorage(paths,frozen)).removedSessionIds,['managed_child','source_a']);
assert.deepEqual(await fs.readFile(bFile),before);
assert.equal((await captureSourceStorage(paths,'source_a')).root.absent,true);
assert.equal((await captureSourceStorage(paths,'source_b')).root.id,'source_b');
assert.equal((await captureSourceStorage(paths,'independent_fork')).root.id,'independent_fork');
backend=new JsonStorageBackend(paths.storages);u=await backend.kv.open(descriptorOf(projectionCacheDomainSpec));let state=await u.loadAll();assert.equal(state.tables.sessions.source_a,undefined);assert.equal(state.tables.sessions.managed_child,undefined);assert.equal(state.tables.sessions.source_b.title,'source_b');await u.close();
u=await backend.kv.open(descriptorOf(workspaceDomainSpec));state=await u.loadAll();assert.deepEqual(state.tables.workspaces.w.sessionIds,['source_b','independent_fork']);assert.deepEqual(state.global.archivedSessionIds,['source_b']);assert.deepEqual(state.global.pinnedSessionIds,['independent_fork']);await u.close();await backend.close();
assert.equal(await fs.readFile('/tmp/storages/session_projcache/sessions/source_b.json.bak.synthetic','utf8'),'synthetic B backup');
await assert.rejects(fs.stat('/tmp/storages/session_projcache/sessions/source_a.json.bak.synthetic'),{code:'ENOENT'});
const legacyBackup=JSON.parse(await fs.readFile('/tmp/storages/session_projcache.json.bak.synthetic','utf8'));assert.equal(legacyBackup.tables.sessions.source_a,undefined);assert.ok(legacyBackup.tables.sessions.source_b);
const workspaceBackup=JSON.parse(await fs.readFile('/tmp/storages/workspace.json.bak.synthetic','utf8'));assert.deepEqual(workspaceBackup.tables.workspaces.w.sessionIds,['source_b','independent_fork']);
console.log(JSON.stringify({schema:'native-source-storage-probe/1',passed:true,managedSourcesRemoved:3,independentSourcesPreserved:2,sourceBBytesUnchanged:true,legacyAndCurrentCachesChecked:true,workspaceAndBackupReferencesChecked:true}));
`;
const args = ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
  '--user=10001:10001', '--memory=256m', '--cpus=0.5', '--pids-limit=64', '--tmpfs=/tmp:rw,nosuid,nodev,size=32m,uid=10001,gid=10001', '-i', '--entrypoint=node', image, '--input-type=module'];
const child = spawn(process.env.CAPSULE_PROVING_DOCKER_BIN || 'docker', args, { stdio: ['pipe', 'inherit', 'inherit'] });
const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
child.stdin.on('error', () => {}); child.stdin.end(program);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
clearTimeout(timer); if (code !== 0) process.exitCode = 1;
