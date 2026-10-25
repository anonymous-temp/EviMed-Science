import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoSignals } from '../src/geoSignals.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { GeoSignalInputs } from '../src/geoSignalInputs.mjs';
import { geoSourceImpactEvent } from '../src/geoSignalDiscovery.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { freezeSelectedGeoAnalysis } from '../src/geoAnalysis.mjs';
import { pruneGeoValueProfiles } from '../src/geoValueUpkeep.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'Disposable PostgreSQL required' };
const user = { id: 'retention-owner' };
const rules = { keep: 20, limit: 200, timeZone: 'Asia/Shanghai' };
let isolated, database, store, documents, service, signals;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'signalvalueretention');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 2000 });
  store = new GeoStore({ database }); await store.ready();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Retention','development'),('other-owner','Other','development')", [user.id]);
  documents = new ProductDocuments(database);
  service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' } });
  signals = new GeoSignals({ documents, store, service, runs: async () => [] }); service.signals = signals;
});
after(async () => { await database?.close(); await isolated?.drop(); });

async function projectWithHistory() {
  const controlId = randomUUID();
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Retention',1048576)", [user.id, controlId]);
  const project = await store.createProject({ userId: user.id, projectId: controlId, engines: ['deepseek'], coverageDays: 90 });
  await store.writeValue(user.id, project.id, { findings: [{ id: 'unrelated', statement: 'First version' }] });
  const finding = { id: 'affected', statement: 'The exact historical finding', sourceRef: 'doi:10.1000/retained' };
  const profile = await store.writeValue(user.id, project.id, { findings: [finding] });
  for (let version = 3; version <= 30; version++) await store.writeValue(user.id, project.id, { findings: [{ id: 'affected', statement: `Later finding ${version}` }] });
  await store.query("UPDATE evimed_geo.value_profiles SET created_at='2026-10-10T12:00:00Z'::timestamptz+make_interval(mins=>version) WHERE geo_project_id=$1", [project.id]);
  const event = geoSourceImpactEvent(profile, { change: { id: 'changed-source', sourceRef: finding.sourceRef, kind: 'correction', summary: 'Source corrected' }, findingIds: [finding.id], articleIds: [], groupIds: [] }, [], []);
  return { project, profile, event, finding: profile.data.findings.find(item => item.id === finding.id) };
}
async function bindSignal(project, signal) {
  const contexts = new GeoPlanContext({ documents, store, service, authorizeSession: async () => {}, runs: async () => [] });
  const staged = await contexts.stage(user, project.id, { requestKey: randomUUID(), sessionId: 'retained-session', mode: 'signal', signalId: signal.id, expectedSignalRevision: signal.revision, intent: 'analyse' });
  const request = { requestId: randomUUID(), sessionId: 'retained-session', content: [{ type: 'text', text: 'Explain the preserved finding.' }], geoPlanContext: { referenceId: staged.referenceId } };
  const control = { id: project.projectId, userId: user.id };
  await contexts.prepare(user, control, request); await store.transaction(() => contexts.bind(user, control, request));
  return { contexts, referenceId: staged.referenceId };
}
async function readFinding(project, bound, event, finding) {
  const inputs = new GeoSignalInputs({ contexts: bound.contexts, service, store });
  const read = await inputs.read(project, { planContextRef: bound.referenceId, targetKey: event.basis.targets.find(item => item.type === 'finding').key });
  assert.equal(read.availability, 'preserved');
  assert.deepEqual(JSON.parse(read.items.map(item => item.text).join('')), finding);
}

test('a source-change signal keeps an old non-month-first profile for later normal stage/prepare/bind and exact finding reads', options, async () => {
  const { project, profile, event, finding } = await projectWithHistory();
  const signal = await signals.record(project, event);
  assert.equal((await pruneGeoValueProfiles(store, project.id, rules)).includes(profile.version), false);
  const bound = await bindSignal(project, signal);
  await readFinding(project, bound, event, finding);
});

test('an independent bound signal context retains the finding after its originating signal head is deleted', options, async () => {
  const { project, profile, event, finding } = await projectWithHistory();
  const signal = await signals.record(project, event), bound = await bindSignal(project, signal);
  await documents.remove(user.id, 'geo-signal', signal.id, signal.revision);
  assert.equal(await documents.get(user.id, 'geo-signal', signal.id), null);
  assert.equal((await pruneGeoValueProfiles(store, project.id, rules)).includes(profile.version), false);
  await readFinding(project, bound, event, finding);
});

test('unrelated, malformed and deleted product heads and historical revisions do not retain profiles', options, async () => {
  const variants = [
    { label: 'wrong owner', userId: 'other-owner' }, { label: 'wrong control project', projectId: 'other-project' },
    { label: 'wrong geo project', payload: { geoId: 'other-geo' } }, { label: 'wrong record type', payload: { recordType: 'other' } },
    { label: 'wrong product kind', kind: 'fact' }, { label: 'other signal kind', payload: { kind: 'citation_observed' } },
    { label: 'string version', pointer: '2' }, { label: 'object version', pointer: { value: 2 } },
    { label: 'null version', pointer: null }, { label: 'boolean version', pointer: true }, { label: 'array version', pointer: [2] },
    { label: 'deleted head', deleted: true }, { label: 'superseded head', superseded: true },
  ];
  for (const context of [false, true]) for (const variant of variants) {
    const { project, profile } = await projectWithHistory();
    const kind = context ? 'geo-plan-context' : 'geo-signal';
    const payload = { recordType: kind, geoId: project.id, ...(context ? { mode: 'signal', basis: { event: { profileVersionAtDetection: Object.hasOwn(variant, 'pointer') ? variant.pointer : profile.version } } } : { kind: 'source_changed', basis: { profileVersionAtDetection: Object.hasOwn(variant, 'pointer') ? variant.pointer : profile.version } }), ...variant.payload };
    if (context && variant.label === 'other signal kind') payload.mode = 'analysis';
    const owner = variant.userId ?? user.id, actualKind = variant.kind ?? kind;
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Other',1048576) ON CONFLICT DO NOTHING", [owner, variant.projectId ?? project.projectId]);
    const row = await documents.put(owner, actualKind, randomUUID(), payload, { expectedRevision: 0, projectId: variant.projectId ?? project.projectId });
    if (variant.deleted) await documents.remove(owner, actualKind, row.id, row.revision);
    if (variant.superseded) { delete payload.basis; await documents.put(owner, actualKind, row.id, payload, { expectedRevision: row.revision, projectId: project.projectId }); }
    assert.equal((await pruneGeoValueProfiles(store, project.id, rules)).includes(profile.version), true, `${kind}: ${variant.label}`);
  }
});

test('pruning initializes the product schema before checking out its single transaction connection', options, async () => {
  const local = await createGeoTestDatabase(url, 'prunemigration');
  const db = new ControlPlaneDatabase({ databaseUrl: local.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 500 });
  try {
    const geo = new GeoStore({ database: db }); await geo.ready();
    const project = await geo.createProject({ userId: user.id, projectId: 'migration', engines: ['deepseek'], coverageDays: 90 });
    for (let version = 1; version <= 25; version++) await geo.writeValue(user.id, project.id, { findings: [{ id: 'f', statement: `Finding ${version}` }] });
    assert.deepEqual(await pruneGeoValueProfiles(geo, project.id, rules), [2, 3, 4, 5]);
    assert.equal((await db.query("SELECT to_regclass('evimed_product.documents') AS name")).rows[0].name, 'evimed_product.documents');
    assert.equal(db.pool.totalCount, 1);
  } finally { await db.close(); await local.drop(); }
});


test('analysis-only profile metadata does not pin history; inline and paged frozen findings remain complete after pruning', options, async () => {
  const { project } = await projectWithHistory();
  await new GeoMeasureStore(database).ready();
  const old = await store.writeValue(user.id, project.id, { findings: [{ id: 'frozen-finding', statement: 'Original complete definition. '.repeat(30), sourceRef: 'doi:10.1000/frozen' }] });
  const round = `round-${randomUUID()}`, group = `group-${randomUUID()}`, question = `question-${randomUUID()}`;
  await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES($1,$2,$3,1,'P2','Retention group')", [group,user.id,project.id]);
  await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) VALUES($1,$2,$3,$4,1,'P2','Original question?',true)", [question,user.id,project.id,group]);
  await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface,ref)
    VALUES($1,$2,$3,'baseline','done',1,'{deepseek}','2026-10-10','{"mode":"web"}',$4::jsonb)`, [round,user.id,project.id,JSON.stringify({evaluationBasis:{value:old,product:{id:'registered',brandName:'Original brand'},competitors:[]}})]);
  await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
    SELECT $1||n,$2,$3,$4,$5,'deepseek','2026-10-10T12:00:00Z'::timestamptz+make_interval(mins=>n),'valid','Preserved answer quote','{"mode":"web"}' FROM generate_series(1,180) AS n`, [round,user.id,project.id,round,question]);
  await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,checks,judge_extract)
    SELECT id,user_id,geo_project_id,now(),'{"judgementCoverage":{"status":"complete"}}',$2::jsonb FROM evimed_geo.snapshots WHERE round_id=$1`,
  [round,JSON.stringify({valueBasisVersion:old.version,valueCoverage:[{findingId:'frozen-finding',status:'represented',quote:'Preserved answer quote'}]})]);
  const contexts = new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]}); service.planContexts=contexts;
  const preserved=[];
  for (const spec of [{viewId:'V10'},{viewId:'V16',evidenceKind:'findings'},{viewId:'V13'}]) {
    const view=await service.analysis(user,project.id,{...spec,round});
    const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});
    const staged=await contexts.stage(user,project.id,{requestKey:randomUUID(),sessionId:'frozen-analysis',mode:'analysis',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,intent:'explain'});
    const request={requestId:randomUUID(),sessionId:'frozen-analysis',content:[{type:'text',text:'Explain the preserved analysis.'}],geoPlanContext:{referenceId:staged.referenceId}};
    await contexts.prepare(user,{id:project.projectId,userId:user.id},request);await contexts.bind(user,{id:project.projectId,userId:user.id},request);
    preserved.push({spec,full,referenceId:staged.referenceId});
  }
  // Existing round/fact pointers legitimately retain profiles. Once those
  // original references are gone, the complete frozen projections stand alone.
  await store.query("UPDATE evimed_geo.rounds SET ref='{}' WHERE id=$1",[round]);
  await store.query('DELETE FROM evimed_geo.facts WHERE geo_project_id=$1',[project.id]);
  for(let index=0;index<30;index++) await store.writeValue(user.id,project.id,{findings:[{id:'frozen-finding',statement:`Replacement ${index}`}]});
  await store.query("UPDATE evimed_geo.value_profiles SET created_at='2026-10-10T12:00:00Z'::timestamptz+make_interval(mins=>version) WHERE geo_project_id=$1",[project.id]);
  assert.equal((await pruneGeoValueProfiles(store,project.id,rules)).includes(old.version),true,'analysis snapshots introduce no detached historical lookup');
  for(const saved of preserved) {
    const read=await service.runtimeRead(project,'analysis',{planContextRef:saved.referenceId,limit:50});
    if(saved.spec.viewId==='V16') {
      const row=read.rows[0];assert.equal(row.dimensions.finding.statement,old.data.findings.find(item=>item.id==='frozen-finding').statement);
      assert.equal(row.dimensions.basisVersion,old.version);assert.equal(row.dimensions.objectsContext.total,180);
      const objects=[];let offset=0;
      do {const page=await service.runtimeRead(project,'analysis',{planContextRef:saved.referenceId,rowKey:row.key,columnKey:'objects',offset,limit:50});objects.push(...page.items);offset=page.nextOffset;} while(offset!==null);
      assert.equal(objects.length,180);assert.ok(objects.every(item=>item.finding.statement===row.dimensions.finding.statement&&item.basisVersion===old.version));
    } else {
      assert.deepEqual(read.rows,saved.full.rows);
      if(saved.spec.viewId==='V10') {
        const original=read.rows.flatMap(row=>row.dimensions.objects.findings).find(item=>item.id==='frozen-finding');
        assert.equal(original.claimStatement,old.data.findings.find(item=>item.id==='frozen-finding').statement);assert.equal(original.basisVersion,old.version);
      }
    }
  }
});
