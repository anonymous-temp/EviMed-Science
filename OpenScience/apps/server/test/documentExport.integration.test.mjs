import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { migrateProductStore, PRODUCT_KINDS, PRODUCT_JOB_KINDS } from '../src/productPersistence.mjs';
import { DocumentExportService, freezeArtifactDocument, exportHash } from '../src/documentExport.mjs';
import { DocumentExportWorker } from '../src/documentExportWorker.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { VcrJobs } from '../src/vcrJobs.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { heavyWorkAdmission } from '../src/heavyWorkAdmission.mjs';
import { DOCUMENT_EXPORT_MIME } from '@evimed/domain';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'A local test PostgreSQL is required.' };
let database, isolated, root, documents, jobs, service, project;
let membership = true;
const config = { runtimeContainerImage: 'runtime@sha256:test' };
let failPdf = true;
const controller = {
  async inspectRuntimeImage() { return { imageId: config.runtimeContainerImage }; },
  async cancelDocumentRender() { return { canceled: true }; },
  async renderDocument(reference) {
    const dir = path.join(root, 'users', reference.ownerId, 'projects', reference.projectId, '.openscience', 'document-exports', reference.exportId, 'attempts', reference.attemptId);
    const input = JSON.parse(await fs.readFile(path.join(dir, 'input/document.json'), 'utf8'));
    const formats = {};
    for (const format of input.formats) {
      if (format === 'pdf' && failPdf) { formats.pdf = { state: 'failed' }; continue; }
      const bytes = Buffer.from(`rendered ${format}: ${input.canonicalMarkdown}`);
      await fs.writeFile(path.join(dir, 'output', `document.${format}`), bytes);
      formats[format] = { state: 'ready', path: `document.${format}`, mime: DOCUMENT_EXPORT_MIME[format], bytes: bytes.length, sha256: exportHash(bytes) };
    }
    await fs.writeFile(path.join(dir, 'output/manifest.json'), JSON.stringify({ rendererVersion: input.rendererVersion, sourceDigest: input.sourceDigest, formats }));
    return {};
  },
};
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'docx');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development'),('bob','Bob','development'),('carol','Carol','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('alice','project','Research',100000000)");
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'document-export-')));
  config.dataDir = root;
  project = { userId: 'alice', id: 'project', workspaceDir: path.join(root, 'workspace'), baseDir: path.join(root, 'workspace') };
  await fs.mkdir(project.workspaceDir);
  await fs.writeFile(path.join(project.workspaceDir, 'report.md'), '# 中文研究\n\n95% CI 12.5\n');
  documents = new ProductDocuments(database); jobs = new ProductJobs(database);
  service = new DocumentExportService({ config, documents, jobs, controller,
    resolveSource: async (user, request) => {
      if (user.id !== 'alice' && !(user.id === 'bob' && membership)) throw new Error('unauthorized');
      return { project, reference: request.source, ...await freezeArtifactDocument(project, request.source) };
    },
    authorize: async user => { if (user.id !== 'alice' && !(user.id === 'bob' && membership)) throw new Error('unauthorized'); },
  });
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });
const request = () => service.request({ id: 'alice' }, { projectId: 'project', source: { artifactId: 'report.md' }, formats: ['docx','pdf','html'] });
const worker = () => new DocumentExportWorker({ service, jobs, controller, admission: client => heavyWorkAdmission(client, 'render') });

test('concurrent ordinary report requests dedupe without a VCR schema and preserve partial formats', options, async () => {
  const requests = await Promise.all(Array.from({ length: 8 }, request));
  assert.equal(new Set(requests.map(x => x.id)).size, 1);
  assert.equal(Number((await database.query("SELECT count(*) FROM evimed_product.jobs")).rows[0].count), 1);
  await worker().tick();
  const result = await service.status({ id: 'alice' }, requests[0].id);
  assert.equal(result.state, 'partial');
  assert.equal(result.formats.docx.state, 'ready');
  assert.equal(result.formats.pdf.state, 'failed');
  assert.match((await service.download({ id: 'bob' }, result.id, 'docx')).bytes.toString(), /中文研究/);
  await assert.rejects(service.download({ id: 'carol' }, result.id, 'docx'), { code: 'document_export_unavailable' });
  membership = false;
  await assert.rejects(service.status({ id: 'bob' }, result.id), { code: 'document_export_unavailable' });
  await assert.rejects(service.download({ id: 'bob' }, result.id, 'docx'), { code: 'document_export_unavailable' });
  const docxHash = result.formats.docx.sha256;
  failPdf = false;
  await service.retry({ id: 'alice' }, result.id, 'pdf');
  await worker().tick();
  const ready = await service.status({ id: 'alice' }, result.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.formats.docx.sha256, docxHash);
  assert.equal(ready.formats.pdf.state, 'ready');
});

test('changed source creates a new immutable export; cancellation and lost leases cannot publish', options, async () => {
  await fs.writeFile(path.join(project.workspaceDir, 'report.md'), '# Changed\n\n84.7');
  const value = await request();
  const job = await jobs.claim(['document-export'], 'test-worker');
  const prepared = await service.prepare(job);
  await controller.renderDocument(prepared.attempt);
  await service.cancel({ id: 'alice' }, value.id);
  await assert.rejects(service.complete(job, prepared.attempt, prepared.dir), { code: 'product_job_lease_lost' });
  assert.equal((await service.status({ id: 'alice' }, value.id)).state, 'canceled');
  await assert.rejects(service.download({ id: 'alice' }, value.id, 'docx'), { code: 'document_export_unavailable' });
});

test('source traversal, symlinks and snapshot tampering are refused', options, async () => {
  await assert.rejects(freezeArtifactDocument(project, { artifactId: '../outside.md' }), { code: 'path_forbidden' });
  await fs.symlink('/etc/passwd', path.join(project.workspaceDir, 'linked.md'));
  await assert.rejects(freezeArtifactDocument(project, { artifactId: 'linked.md' }));
  await fs.writeFile(path.join(project.workspaceDir, 'report.md'), '# Immutable source');
  const value = await request();
  const input = path.join(root, 'users/alice/projects/project/.openscience/document-exports', value.id, 'input/document.json');
  await fs.chmod(input, 0o600);
  await fs.writeFile(input, '{}');
  const job = await jobs.claim(['document-export'], 'test-worker');
  await assert.rejects(service.prepare(job), { code: 'document_input_changed' });
  await jobs.cancel('alice', job.id);
});

test('render admission is atomic, expires only into recovery, and compute respects it', options, async () => {
  const a = await jobs.enqueue('alice','document-export',{ exportId: 'a' }, { idempotencyKey: 'admission-a', projectId: 'project' });
  await jobs.enqueue('alice','document-export',{ exportId: 'b' }, { idempotencyKey: 'admission-b', projectId: 'project' });
  const claimed = await Promise.all([jobs.claim(['document-export'],'one',{ admission: client => heavyWorkAdmission(client,'render') }), jobs.claim(['document-export'],'two',{ admission: client => heavyWorkAdmission(client,'render') })]);
  assert.equal(claimed.filter(Boolean).length, 1);
  assert.equal(await database.transaction(client => heavyWorkAdmission(client,'compute')), false);
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=now()-interval '1 second' WHERE status='running'");
  assert.equal(await database.transaction(client => heavyWorkAdmission(client,'compute')), false);
  await jobs.cancel('alice', claimed.find(Boolean).id);
  assert.equal(await database.transaction(client => heavyWorkAdmission(client,'compute')), true);
  await jobs.cancel('alice', a.id);
});


test('losing authority during input preparation removes the unregistered attempt', options, async () => {
  await database.query("UPDATE evimed_product.jobs SET status='canceled' WHERE status IN ('queued','running')");
  await fs.writeFile(path.join(project.workspaceDir, 'report.md'), '# Lease lost during preparation');
  const value = await request();
  const job = await jobs.claim(['document-export'], 'test-worker');
  const original = jobs.withLease;
  jobs.withLease = async () => null;
  try { await assert.rejects(service.prepare(job), { code: 'product_job_lease_lost' }); }
  finally { jobs.withLease = original; }
  const attempts = path.join(root, 'users/alice/projects/project/.openscience/document-exports', value.id, 'attempts');
  assert.deepEqual(await fs.readdir(attempts).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
  await jobs.cancel('alice', job.id);
});

test('a restarted worker reaps terminal attempts only after confirmed physical cancellation', options, async () => {
  await fs.writeFile(path.join(project.workspaceDir, 'report.md'), '# Restart recovery');
  const value = await request();
  const job = await jobs.claim(['document-export'], 'departed-worker');
  await service.prepare(job);
  await database.query("UPDATE evimed_product.jobs SET status='failed', lease_token=NULL WHERE id=$1", [job.id]);
  assert.equal(await database.transaction(client => heavyWorkAdmission(client, 'compute')), false);
  const cancel = controller.cancelDocumentRender;
  controller.cancelDocumentRender = async () => { throw Object.assign(new Error('unknown physical state'), { code: 'document_render_state_unknown' }); };
  await assert.rejects(service.reconcileTerminatedAttempts(), { code: 'document_render_state_unknown' });
  assert.equal(await database.transaction(client => heavyWorkAdmission(client, 'compute')), false);
  controller.cancelDocumentRender = cancel;
  await service.reconcileTerminatedAttempts();
  assert.equal(await database.transaction(client => heavyWorkAdmission(client, 'compute')), true);
  assert.equal((await documents.get('alice', 'document-export', value.id)).payload.attempt, null);
});

test('project deletion stops exports transactionally before cascading their authority', options, async () => {
  await database.query("UPDATE evimed_product.jobs SET status='canceled' WHERE status IN ('queued','running')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('alice','deletion','Delete',100000000)");
  const ownProject = { ...project, id: 'deletion' };
  const source = { project: ownProject, reference: { artifactId: 'report.md' }, ...await freezeArtifactDocument(project, { artifactId: 'report.md' }) };
  const value = await service.requestFrozen({ id: 'alice' }, source);
  const job = await jobs.claim(['document-export'], 'delete-worker');
  await service.prepare(job);
  let stops = 0;
  const original = controller.cancelDocumentRender;
  controller.cancelDocumentRender = async () => { stops++; return { canceled: true }; };
  await database.transaction(async client => {
    await service.cancelProject('alice', 'deletion', client);
    await client.query("DELETE FROM evimed_control.projects WHERE user_id='alice' AND id='deletion'");
  });
  controller.cancelDocumentRender = original;
  assert.equal(stops, 1);
  assert.equal(await jobs.get('alice', job.id), null);
  assert.equal(await documents.get('alice','document-export',value.id), null);
  await assert.rejects(service.requestFrozen({ id: 'alice' }, source), { code: 'document_export_unavailable' });
});


test('compute and render claims share one atomic slot and unknown engine completion retains it', options, async () => {
  const store = new VcrStore({ database }); await store.ready();
  const study = await store.createStudy({ userId:'alice', projectId:'project', name:'Admission study', dataTier:'T0' });
  let engineState = 'running';
  const compute = new VcrJobs({ store, config:{ vcrMaxConcurrentJobs:1, vcrJobCpuSeconds:600, vcrStudyCpuBudget:1200 }, engine:{ configured:()=>true, status:async()=>({ state:engineState }) } });
  const scenario = { design:{ kind:'two_arm_fixed', nTreat:150, nControl:150 }, endpoint:{ type:'time_to_event' }, truth:{ hazardRatio:0.7, controlMedian:6 }, analysis:{ method:'logrank', alpha:0.025, sided:1 }, accrual:{ kind:'uniform', duration:12, followup:12 }, performance:['power'] };
  const { job: numerical } = await compute.enqueue({ studyId:study.id, userId:'alice', kind:'design_simulation', scenario, inputs:[] });
  await jobs.enqueue('alice','document-export',{ exportId:'admission-race' },{ idempotencyKey:'admission-race', projectId:'project' });
  const [rendered, calculated] = await Promise.all([jobs.claim(['document-export'],'render-worker',{ admission:client=>heavyWorkAdmission(client,'render') }), compute.claim()]);
  assert.equal(Number(Boolean(rendered))+calculated.length,1);
  if (rendered) await jobs.cancel('alice',rendered.id);
  await database.query("UPDATE evimed_product.jobs SET status='canceled' WHERE status IN ('queued','running')");
  await database.query("UPDATE evimed_vcr.jobs SET state='canceled', checkpoint=checkpoint || '{\"engineJobId\":\"physical-one\"}'::jsonb WHERE id=$1",[numerical.id]);
  assert.equal(await database.transaction(client=>heavyWorkAdmission(client,'render')),false);
  assert.equal(await database.transaction(client=>heavyWorkAdmission(client,'compute')),false);
  await compute.reconcileStoppedEngineWork();
  assert.equal(await database.transaction(client=>heavyWorkAdmission(client,'compute')),false);
  engineState='failed';
  await compute.reconcileStoppedEngineWork();
  assert.equal(await database.transaction(client=>heavyWorkAdmission(client,'render')),true);
  assert.equal(await database.transaction(client=>heavyWorkAdmission(client,'compute')),true);
});

test('concurrent report sections retain one model snapshot and do not overwrite each other', options, async () => {
  const store = new VcrStore({ database });
  const study = await store.createStudy({ userId:'alice', projectId:'snapshot-project', name:'Snapshot study', dataTier:'T0' });
  const row = await store.createExport({ studyId:study.id, userId:'alice', kind:'study_package' });
  let value = 41;
  const source = { reportModel:async()=>({ study, counts:{ sample:++value } }) };
  await Promise.all(['Methods','Results'].map(section=>vcrRuntimeWrite({ store, service:source, study, what:'report', items:null,
    data:{ kind:'study_package', section, template:'样本 {{n:counts.sample|int}}。' } })));
  const saved = await store.exportRow(study.id,row.id);
  assert.equal(saved.cover.reports.length,2);
  for (const report of saved.cover.reports) assert.match(report.rendered,new RegExp(String(saved.cover.results.counts.sample)));
});

test('an ordinary report converts through the hosted API with VCR disabled and no research session', options, async () => {
  const { createWebApiApp } = await import('../src/server.mjs');
  const app = createWebApiApp({ dataDir:root, port:0, runtimeMode:'mock', devAuth:false, authMode:'local', bootstrapUser:'', bootstrapPassword:'',
    stateStore:'postgres', requireSharedStateStore:true, databaseUrl:isolated.url, vcrEnabled:false, documentExportController:controller, rateLimitMaxRequests:10000 });
  try {
    await app.store.createUser('ordinary','test-document-password','Ordinary');
    const address = await app.listen(0,'127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ordinary',password:'test-document-password'})});
    const identity = await login.json();
    assert.equal(login.status,200,JSON.stringify(identity));
    const headers = {'content-type':'application/json',cookie:login.headers.get('set-cookie').split(';')[0],'x-open-science-csrf':identity.data.csrfToken};
    const user = await app.store.userById('ordinary');
    const current = await app.store.requireProject(user,'default');
    await fs.writeFile(path.join(current.workspaceDir,'scientific-report.md'),'# 科学报告\n\nEffect 42.5 [1].');
    const requested = await fetch(`${base}/api/document-exports`,{method:'POST',headers,body:JSON.stringify({projectId:'default',source:{artifactId:'scientific-report.md'},formats:['docx','pdf','html']})});
    const data = await requested.json();
    assert.equal(requested.status,202,JSON.stringify(data));
    let result;
    for(let i=0;i<60;i++){
      result=await (await fetch(`${base}/api/document-exports/${data.data.id}`,{headers})).json();
      if(result.data.state==='ready')break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(result.data.state,'ready',JSON.stringify(result));
    assert.equal(app.vcr,null);
    const downloaded=await fetch(`${base}/api/document-exports/${data.data.id}/download/pdf`,{headers});
    assert.equal(downloaded.status,200);
    assert.match(await downloaded.text(),/42\.5/);
  } finally { await app.close(); }
});


test('a stale preparing worker cannot cancel or delete the successor attempt', options, async () => {
  await fs.writeFile(path.join(project.workspaceDir, 'report.md'), '# Successor authority');
  const value = await request();
  const old = await jobs.claim(['document-export'], 'old-worker');
  await service.prepare(old);
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[old.id]);
  const next = await jobs.claim(['document-export'], 'new-worker');
  assert.equal(old.id,next.id);
  const successor = await service.prepare(next);
  const cancel = controller.cancelDocumentRender;
  let canceled = 0;
  controller.cancelDocumentRender = async () => { canceled++; return {canceled:true}; };
  try { await assert.rejects(service.prepare(old), {code:'product_job_lease_lost'}); }
  finally { controller.cancelDocumentRender = cancel; }
  assert.equal(canceled,0);
  assert.ok(await fs.stat(path.join(successor.dir,'input/document.json')));
  assert.equal((await documents.get('alice','document-export',value.id)).payload.attempt.attemptId,successor.attempt.attemptId);
  await service.cancel({id:'alice'},value.id);
});


test('timeout and restart preserve completed formats from an atomically written renderer receipt', options, async () => {
  await fs.writeFile(path.join(project.workspaceDir,'report.md'),'# Partial conversion after timeout');
  const value = await request();
  const render = controller.renderDocument;
  controller.renderDocument = async reference => {
    await render(reference);
    const dir = path.join(root,'users',reference.ownerId,'projects',reference.projectId,'.openscience/document-exports',reference.exportId,'attempts',reference.attemptId,'output');
    const manifest = JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
    delete manifest.formats.pdf; delete manifest.formats.html;
    await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
    throw Object.assign(new Error('timeout'),{code:'document_render_timeout'});
  };
  await worker().tick();
  controller.renderDocument = render;
  assert.equal((await service.status({id:'alice'},value.id)).state,'partial');
  assert.equal((await service.status({id:'alice'},value.id)).formats.docx.state,'ready');
  await fs.writeFile(path.join(project.workspaceDir,'report.md'),'# Partial conversion before restart');
  const restarted = await request();
  const old = await jobs.claim(['document-export'],'old-worker');
  const prepared = await service.prepare(old);
  await controller.renderDocument(prepared.attempt);
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[old.id]);
  const next = await jobs.claim(['document-export'],'replacement-worker');
  const recovered = await service.prepare(next);
  assert.equal(recovered.recovered,true);
  assert.equal(recovered.attempt.attemptId,prepared.attempt.attemptId);
  await service.complete(next,recovered.attempt,recovered.dir);
  assert.equal((await service.status({id:'alice'},restarted.id)).state,'ready');
});


test('waiting for renderer capacity refunds both budgets and converts when headroom returns', options, async () => {
  await fs.writeFile(path.join(project.workspaceDir,'report.md'),'# Waiting for memory');
  const value = await request();
  const render = controller.renderDocument;
  controller.renderDocument = async () => { throw Object.assign(new Error('capacity'),{code:'document_render_capacity'}); };
  try {
    for(let i=0;i<13;i++){
      await worker().tick();
      await database.query("UPDATE evimed_product.jobs SET run_after=now() WHERE id=$1",[value.jobId]);
    }
  } finally { controller.renderDocument = render; }
  assert.equal((await documents.get('alice','document-export',value.id)).payload.attempts,0);
  assert.equal((await jobs.get('alice',value.jobId)).attempts,0);
  await worker().tick();
  assert.equal((await service.status({id:'alice'},value.id)).state,'ready');
});


test('an oversized or corrupt format cannot erase another verified format', options, async () => {
  await fs.writeFile(path.join(project.workspaceDir,'report.md'),'# Independent output verification');
  const value=await request();
  const job=await jobs.claim(['document-export'],'format-worker');
  const prepared=await service.prepare(job);
  await controller.renderDocument(prepared.attempt);
  await fs.truncate(path.join(prepared.dir,'output/document.pdf'),65*1024*1024);
  await fs.writeFile(path.join(prepared.dir,'output/document.html'),'changed after render');
  await service.complete(job,prepared.attempt,prepared.dir);
  const completed=await service.status({id:'alice'},value.id);
  assert.equal(completed.state,'partial');
  assert.equal(completed.formats.docx.state,'ready');
  assert.equal(completed.formats.pdf.code,'document_export_too_large');
  assert.equal(completed.formats.html.code,'document_output_invalid');
  assert.match((await service.download({id:'alice'},value.id,'docx')).bytes.toString(),/Independent output/);
});


test('a rolled-back metadata transaction can reuse its immutable input files on retry', options, async () => {
  await fs.writeFile(path.join(project.workspaceDir,'report.md'),'# Transaction recovery');
  const put = documents.put;
  documents.put = async () => { throw Object.assign(new Error('transaction interruption'),{code:'test_interruption'}); };
  try { await assert.rejects(request(),{code:'test_interruption'}); }
  finally { documents.put = put; }
  const value = await request();
  await worker().tick();
  assert.equal((await service.status({id:'alice'},value.id)).state,'ready');
});

test('a changed immutable runtime image creates a distinct conversion while the source revision stays fixed', options, async () => {
  const first=await request();
  const previousImage=config.runtimeContainerImage;
  config.runtimeContainerImage='runtime@sha256:replacement';
  try {
    const next=await request();
    assert.notEqual(next.id,first.id);
    assert.notEqual(next.sourceDigest,first.sourceDigest);
    assert.equal(next.sourceRevision,first.sourceRevision);
    assert.equal((await service.status({id:'alice'},first.id)).state,'ready');
  } finally { config.runtimeContainerImage=previousImage; }
});


test('additive migration admits export records and jobs on already-migrated deployments', options, async () => {
  const legacy = await createGeoTestDatabase(url,'docmig');
  let connection=new ControlPlaneDatabase({databaseUrl:legacy.url,databasePoolMax:2,databaseConnectionTimeoutMs:5000});
  try {
    await migrateProductStore(connection);
    for(const [table,kinds] of [['documents',PRODUCT_KINDS],['jobs',PRODUCT_JOB_KINDS]]) {
      await connection.query(`ALTER TABLE evimed_product.${table} DROP CONSTRAINT product_${table}_kind_check`);
      await connection.query(`ALTER TABLE evimed_product.${table} ADD CONSTRAINT product_${table}_kind_check CHECK (kind IN (${kinds.filter(kind=>kind!=='document-export').map(kind=>"'"+kind+"'").join(',')}))`);
    }
    await connection.close();
    connection=new ControlPlaneDatabase({databaseUrl:legacy.url,databasePoolMax:2,databaseConnectionTimeoutMs:5000});
    await migrateProductStore(connection);
    await connection.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('migration','Migration','development')");
    const saved=await new ProductDocuments(connection).put('migration','document-export','snapshot',{}, {expectedRevision:0});
    const queued=await new ProductJobs(connection).enqueue('migration','document-export',{exportId:'snapshot'}, {idempotencyKey:'snapshot'});
    assert.equal(saved.kind,'document-export');
    assert.equal(queued.status,'queued');
  } finally { await connection.close(); await legacy.drop(); }
});
