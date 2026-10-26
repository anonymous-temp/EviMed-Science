import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { readGeoSelection, withGeoReadTransaction } from '../src/geoReadScope.mjs';
import { freezeGeoPlanBasis, geoPlanScopeKey, geoPlanDigest } from '../src/geoPlanContext.mjs';
import { readGeoFinanceContext, buildGeoFinanceAnalysis } from '../src/geoAnalysisFinance.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('finance reads preserve complete tenant accounting and exact historical plan basis on real PostgreSQL',{skip:!url},async t => {
 const isolated=await createGeoTestDatabase(url,'financeanalysis');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:3,databaseConnectionTimeoutMs:3000});
 const external=new pg.Client({connectionString:isolated.url});await external.connect();
 t.after(async()=>{await external.end();await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();
 await seedGeoProject(database,{id:'finance-geo',userId:'finance-owner',projectId:'finance-control',engines:['deepseek'],groups:[{id:'g',pool:'P2'}],questions:[{id:'q',groupId:'g',text:'Original selected question'}]});
 const project=await new GeoMeasureStore(database).project('finance-geo');
 const documents=new ProductDocuments(database),service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});
 await store.query('UPDATE evimed_geo.projects SET budget=$2::jsonb WHERE id=$1',[project.id,JSON.stringify({totalCny:9000})]);
 await store.query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,group_id,current_result_version_id,content_sha256)
  VALUES('article',$1,$2,'Current changed article','other','v2',repeat('b',64))`,[project.userId,project.id]);
 await store.query(`INSERT INTO evimed_geo.article_versions(geo_project_id,user_id,article_id,result_version_id,digest,path,association)
  VALUES($1,$2,'article','v1',repeat('a',64),'article.md','{"groupId":"g"}')`,[project.id,project.userId]);
 await store.query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,article_result_version_id,article_digest,state)
  VALUES('order',$1,$2,'article','v1',repeat('a',64),'settled')`,[project.userId,project.id]);
 for(const [id,kind,amount,order,day] of [['01','budget_set',500,null,'01'],['02','reserve',100,'order','02'],['03','settle',80,'order','03'],['04','release',20,'order','04'],['05','refund',10,'order','05']]) {
  await store.query(`INSERT INTO evimed_geo.ledger(id,user_id,geo_project_id,order_id,kind,amount_cny,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,project.userId,project.id,order,kind,amount,`2026-10-${day}T00:00:00Z`]);
 }
 await store.query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,article_result_version_id,article_digest,state)
  SELECT 'extra-order-'||n,$1,$2,'article','v1',repeat('a',64),'cancelled' FROM generate_series(1,205)n`,[project.userId,project.id]);
 await store.query(`INSERT INTO evimed_geo.ledger(id,user_id,geo_project_id,order_id,kind,amount_cny,created_at)
  SELECT 'extra-'||n,$1,$2,'extra-order-'||n,'reserve',0,'2026-10-06T00:00:00Z'::timestamptz + n*interval '1 microsecond' FROM generate_series(1,205)n`,[project.userId,project.id]);
 const selected=await readGeoSelection(store,project,{}),groups=[{id:'g',name:'Selected question group',set_version:1}];
 const finance=await readGeoFinanceContext(store,project,selected,{viewId:'V25'});
 assert.equal(finance.ledger.items.length,210);assert.equal(finance.orders.length,206);assert.equal(new Set(finance.ledger.items.map(item=>item.id)).size,210);
 assert.deepEqual(finance.ledger.items.slice(-2).map(item=>item.id),['extra-204','extra-205'],'microsecond cursor order survives millisecond ISO output');
 const result=buildGeoFinanceAnalysis(selected,{viewId:'V25'},{groups,execution:{finance}}),refund=result.rows.find(row=>row.dimensions.ledgerKind==='refund');
 assert.equal(refund.values.reservedCny.value,0);assert.equal(refund.values.spentCny.value,70);assert.equal(refund.values.availableCny.value,430);assert.equal(refund.values.budgetCny.value,500);
 assert.equal(result.contextualBasis[0].currentSummary.budgetCny,9000);
 const dated=buildGeoFinanceAnalysis({...selected,scope:{...selected.scope,from:'2026-10-04',to:'2026-10-05'}},{viewId:'V25'},{groups,execution:{finance}});
 assert.equal(dated.rows.length,2);assert.equal(dated.contextualBasis[0].opening.reservedCny,20);assert.equal(dated.contextualBasis[0].opening.settledCny,80);
 const grouped=buildGeoFinanceAnalysis(selected,{viewId:'V25',financeFacet:'group'},{groups,execution:{finance}});
 assert.equal(grouped.rows.find(row=>row.dimensions.groupId==='g').values.reserveCny.value,100);
 assert.equal(grouped.rows.find(row=>row.dimensions.groupId==='g').values.refundCny.value,10);
 assert.ok(!grouped.rows.some(row=>row.dimensions.groupId==='other'),'the current article group must not rewrite the paid pin');

 // A foreign version body and order can share imported identifiers, but are not tenant context.
 await store.query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title) VALUES('foreign-article','foreign-owner',$1,'Private foreign article')`,[project.id]);
 await store.query(`INSERT INTO evimed_geo.article_versions(geo_project_id,user_id,article_id,result_version_id,digest,path,association)
  VALUES($1,'foreign-owner','foreign-article','foreign-version',repeat('f',64),'foreign-private.md','{"groupId":"g"}')`,[project.id]);
 await store.query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,article_result_version_id,article_digest,state)
  VALUES('foreign-order','foreign-owner',$1,'foreign-article','foreign-version',repeat('f',64),'cancelled'),('dangling-order',$2,$1,'foreign-article','foreign-version',repeat('f',64),'settled')`,[project.id,project.userId]);
 await store.query(`INSERT INTO evimed_geo.ledger(id,user_id,geo_project_id,order_id,kind,amount_cny) VALUES('dangling',$1,$2,'dangling-order','settle',4)`,[project.userId,project.id]);
 const boundary=await readGeoFinanceContext(store,project,selected,{viewId:'V25'});
 assert.doesNotMatch(JSON.stringify(boundary),/foreign-private|foreign-owner|"id":"foreign-order"/);
 assert.equal(buildGeoFinanceAnalysis(selected,{viewId:'V25',financeFacet:'group'},{groups,execution:{finance:boundary}}).rows.find(row=>row.dimensions.attribution==='unassigned').values.settleCny.value,4);
 await assert.rejects(readGeoFinanceContext(store,{...project,userId:'stranger'},selected,{viewId:'V25'}),error=>error.status===404);

 // A concurrent write between pages is invisible throughout the caller's repeatable-read snapshot.
 await withGeoReadTransaction(store,async()=>{
  const before=await readGeoFinanceContext(store,project,selected,{viewId:'V25'});
  await external.query(`INSERT INTO evimed_geo.ledger(id,user_id,geo_project_id,kind,amount_cny) VALUES('concurrent',$1,$2,'budget_set',10000)`,[project.userId,project.id]);
  const after=await readGeoFinanceContext(store,project,selected,{viewId:'V25'});
  assert.deepEqual(after,before);
 });
 assert.equal((await readGeoFinanceContext(store,project,selected,{viewId:'V25'})).ledger.items.some(item=>item.id==='concurrent'),true);

 const target={tier:'2',metricId:'M-01',pool:'all',baseline:20,target:60,budgetCny:1200,horizonWeeks:8,dataType:'forecast'};
 await store.writeTargets(project.userId,project.id,[target]);
 const frozen=await freezeGeoPlanBasis(store,project,{});
 frozen.basis.readings.selected.cells=[{metricId:'M-01',scope:'project',pool:null,value:25,status:'ok',numerator:1,denominator:4,memberReference:'unavailable-old-selection',memberDigest:'old-member-digest',memberCount:4}];
 frozen.basis.selection.reference='unavailable-old-selection';
 const scopeKey=geoPlanScopeKey(frozen.basis.scope);
 const initial=await store.writeStrategy(project.userId,project.id,{scopeKey,basis:frozen.basis,summary:'Original plan',assumptions:['Estimated CNY cost'],tiers:[{tier:'2',summary:'Original cost envelope'}]});
 const historical=await readGeoFinanceContext(store,project,selected,{viewId:'V26',strategyVersion:initial.version,targetVersion:1},{service});
 assert.equal(historical.plan.version,1);assert.equal(historical.plan.basisDigest,geoPlanDigest(frozen.basis));assert.equal(historical.plan.basis.targets.version,1);
 assert.equal(historical.plan.basis.readings.selected.cells[0].value,25);
 await store.writeTargets(project.userId,project.id,[{...target,target:95,budgetCny:9900}]);
 await store.writeStrategy(project.userId,project.id,{scopeKey,basis:{...frozen.basis,targets:{version:2,rows:[{...target,target:95,budgetCny:9900}]}},summary:'New plan'});
 const retained=await readGeoFinanceContext(store,project,selected,{viewId:'V26',strategyVersion:1,targetVersion:1},{service});
 assert.deepEqual(retained.plan.basis,historical.plan.basis);assert.equal(retained.plan.basis.targets.rows[0].target,60);
 const current={...selected,computed:{...selected.computed,cells:[{...frozen.basis.readings.selected.cells[0],value:75,numerator:3}]}};
 const comparison=buildGeoFinanceAnalysis(current,{viewId:'V26',strategyVersion:1,targetVersion:1},{execution:{finance:retained}});
 assert.equal(comparison.rows[0].values.frozenBaseline.value,25);assert.equal(comparison.rows[0].values.current.value,75);assert.equal(comparison.rows[0].values.target.value,60);
 assert.equal(comparison.memberItems.get(comparison.rows[0].key+':frozenBaseline')[0].memberReference,'unavailable-old-selection');
 const latest=await readGeoFinanceContext(store,project,selected,{viewId:'V26'},{service});assert.equal(latest.plan.version,2);assert.equal(latest.plan.basis.targets.version,2);
 assert.equal((await readGeoFinanceContext(store,project,{...selected,scope:{...selected.scope,from:'2026-10-20'}},{viewId:'V26'},{service})).plan,null,'no plan from a nearby scope is substituted');
 await assert.rejects(readGeoFinanceContext(store,project,selected,{viewId:'V26',strategyVersion:1,targetVersion:2},{service}),error=>error.status===409);
 await assert.rejects(readGeoFinanceContext(store,project,selected,{viewId:'V26',strategyVersion:999},{service}),error=>error.status===404);
 const user={id:project.userId},contexts=new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=contexts;
 const fullGroup=await service.analysis(user,project.id,{viewId:'V25',financeFacet:'group'}),groupRow=fullGroup.rows.find(row=>row.dimensions.groupId==='g');
 const reserveIds=[];let memberOffset=0;
 do{
  const part=await service.analysisMembers(user,project.id,{...fullGroup.view,selectionRef:fullGroup.selection.reference,expectedDigest:fullGroup.digest,rowKey:groupRow.key,columnKey:'reserveCny',offset:memberOffset,limit:50});
  assert.equal(part.total,206);reserveIds.push(...part.items.map(item=>item.objectId));memberOffset=part.nextOffset;
 }while(memberOffset!==null);
 assert.equal(new Set(reserveIds).size,206);assert.ok(reserveIds.includes('extra-205'));
 const fullGroupFrozen=await freezeSelectedGeoAnalysis(store,project,{selectionRef:fullGroup.selection.reference,view:fullGroup.view,expectedDigest:fullGroup.digest},{service});
 const fullGroupStage=await contexts.stage(user,project.id,{requestKey:'full-finance-group',sessionId:'finance-session',mode:'analysis',selectionRef:fullGroup.selection.reference,view:fullGroup.view,expectedDigest:fullGroup.digest,intent:'explain'});
 const fullGroupRequest={requestId:'full-finance-group-request',sessionId:'finance-session',content:[{type:'text',text:'Explain the complete selected finance group.'}],geoPlanContext:{referenceId:fullGroupStage.referenceId}};
 await contexts.prepare(user,{id:project.projectId,userId:project.userId},fullGroupRequest);await contexts.bind(user,{id:project.projectId,userId:project.userId},fullGroupRequest);
 const allNativeObjects=[];let nativeOffset=0;
 do{const part=await service.runtimeRead(project,'analysis',{planContextRef:fullGroupStage.referenceId,rowKey:groupRow.key,columnKey:'objects',offset:nativeOffset,limit:50});allNativeObjects.push(...part.items);nativeOffset=part.nextOffset;}while(nativeOffset!==null);
 assert.deepEqual(allNativeObjects,fullGroupFrozen.rows.find(row=>row.key===groupRow.key).dimensions.objects);assert.ok(allNativeObjects.some(item=>item.objectId==='extra-205'));
 let frozenLedgerContext=null,frozenLedgerRow=null,frozenLedgerObjects=null;
 for(const [name,view,scope] of [
  ['ledger',{viewId:'V25',financeFacet:'ledger'},{from:'2026-10-04',to:'2026-10-05'}],
  ['group',{viewId:'V25',financeFacet:'group'},{from:'2026-10-04',to:'2026-10-05'}],
  ['exact-plan',{viewId:'V26',strategyVersion:1,targetVersion:1},{}],
  ['default-plan',{viewId:'V26'},{}]
 ]){
  const live=await service.analysis(user,project.id,{...scope,...view});
  assert.ok(live.rows.length>0,name);
  if(name==='default-plan'){assert.equal(live.view.strategyVersion,2);assert.equal(live.view.targetVersion,2);}
  if(name==='exact-plan')assert.equal(live.rows[0].values.frozenBaseline.value,25);
  for(const row of live.rows)for(const value of Object.values(row.values))if(value.members){
   const member=value.members;const detail=await service.analysisMembers(user,project.id,{...live.view,selectionRef:live.selection.reference,expectedDigest:live.digest,rowKey:row.key,columnKey:member.columnKey});
   assert.equal(detail.digest,live.digest);assert.equal(detail.total,member.total);assert.equal(detail.items.length,detail.total);assert.ok(detail.items.every(item=>item.id&&item.unit===member.unit));
  }
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest},{service});
  const document=freezeGeoAnalysisDocument(full);assert.equal(document.cover.analysis.digest,full.digest);
  if(process.env.GEO_F3_RECEIPTS_DIR){
   await mkdir(process.env.GEO_F3_RECEIPTS_DIR,{recursive:true});
   await writeFile(`${process.env.GEO_F3_RECEIPTS_DIR}/document-${name}.json`,JSON.stringify({...document,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:full.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));
  }
  let captured=null;
  await service.selectedExport(user,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,formats:['csv','xlsx','docx','pdf','html']},{requestFrozen:async(_user,payload,formats)=>{captured={payload,formats};return {id:'captured'};}});
  assert.equal(captured.payload.cover.analysis.digest,live.digest);assert.deepEqual(captured.formats,['csv','xlsx','docx','pdf','html']);
  const staged=await contexts.stage(user,project.id,{requestKey:`finance-native-${name}`,sessionId:'finance-session',mode:'analysis',selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,intent:'explain'});
  const request={requestId:`finance-request-${name}`,sessionId:'finance-session',content:[{type:'text',text:'Explain these exact finance and planning readings.'}],geoPlanContext:{referenceId:staged.referenceId}};
  await contexts.prepare(user,{id:project.projectId,userId:project.userId},request);await contexts.bind(user,{id:project.projectId,userId:project.userId},request);
  if(name==='ledger'){frozenLedgerContext=staged.referenceId;frozenLedgerRow=full.rows[0].key;frozenLedgerObjects=full.rows[0].dimensions.objects;}
  for(const row of full.rows){
   const objects=[];let offset=0;
   do{const part=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:row.key,columnKey:'objects',offset,limit:50});objects.push(...part.items);offset=part.nextOffset;}while(offset!==null);
   assert.deepEqual(objects,row.dimensions.objects);
  }
 }
 // Existing observation selection remains fixed when these additive view selectors change.
 const a=await service.analysis(user,project.id,{viewId:'V25'}),b=await service.analysis(user,project.id,{viewId:'V26',strategyVersion:1});
 assert.equal(a.selection.reference,b.selection.reference);
 for(const bad of [{viewId:'V25',strategyVersion:1},{viewId:'V23',financeFacet:'group'},{viewId:'V26',targetVersion:0},{viewId:'V26',financeFacet:'group'}])await assert.rejects(service.analysis(user,project.id,bad),error=>error.status===400);
 await assert.rejects(service.analysisMembers(user,project.id,{...a.view,selectionRef:a.selection.reference,expectedDigest:'0'.repeat(64),rowKey:a.rows[0].key,columnKey:'amountCny'}),error=>error.status===409);
 await store.query('UPDATE evimed_geo.projects SET budget=$2::jsonb WHERE id=$1',[project.id,JSON.stringify({totalCny:20000})]);
 await assert.rejects(service.analysisMembers(user,project.id,{...a.view,selectionRef:a.selection.reference,expectedDigest:a.digest,rowKey:a.rows[0].key,columnKey:'amountCny'}),error=>error.status===409);
 assert.deepEqual((await service.runtimeRead(project,'analysis',{planContextRef:frozenLedgerContext,rowKey:frozenLedgerRow,columnKey:'objects',offset:0,limit:50})).items,frozenLedgerObjects);
 await store.query(`INSERT INTO evimed_geo.ledger(id,user_id,geo_project_id,kind,amount_cny) SELECT 'overflow-'||n,$1,$2,'reserve',0 FROM generate_series(1,20001)n`,[project.userId,project.id]);
 await assert.rejects(readGeoFinanceContext(store,project,selected,{viewId:'V25'}),error=>error.status===422);
});

test('public ledger, exact members and frozen export headings share each selected timezone day without changing UTC chronology',{skip:!url},async t=>{
 const isolated=await createGeoTestDatabase(url,'financetimezone');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:3,databaseConnectionTimeoutMs:3000});
 t.after(async()=>{await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();
 const documents=new ProductDocuments(database),service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});
 for(const [name,timeZone,before,start,end,next] of [
  ['shanghai','Asia/Shanghai','2026-10-01T15:59:59.999999Z','2026-10-01T16:00:00.000001Z','2026-10-02T15:59:59.999999Z','2026-10-02T16:00:00.000001Z'],
  ['utc','UTC','2026-10-01T23:59:59.999999Z','2026-10-02T00:00:00.000001Z','2026-10-02T23:59:59.999999Z','2026-10-03T00:00:00.000001Z'],
  ['los-angeles','America/Los_Angeles','2026-10-02T06:59:59.999999Z','2026-10-02T07:00:00.000001Z','2026-10-03T06:59:59.999999Z','2026-10-03T07:00:00.000001Z'],
 ]){
  const geoId=`timezone-${name}`,groupId=`group-${name}`,articleId=`article-${name}`,orderId=`order-${name}`;
  await seedGeoProject(database,{id:geoId,userId:'timezone-owner',projectId:`control-${name}`,engines:['deepseek'],groups:[{id:groupId,pool:'P2'}],questions:[{id:`question-${name}`,groupId,text:'Timezone finance question'}]});
  const project=await new GeoMeasureStore(database).project(geoId),user={id:project.userId};
  await store.query('INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,group_id) VALUES($1,$2,$3,$1,$4)',[articleId,project.userId,geoId,groupId]);
  await store.query('INSERT INTO evimed_geo.article_versions(geo_project_id,user_id,article_id,result_version_id,digest,path,association) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[geoId,project.userId,articleId,'old-version','a'.repeat(64),'article.md',JSON.stringify({groupId,questionVersion:1})]);
  await store.query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,article_result_version_id,article_digest,state) VALUES($1,$2,$3,$4,$5,$6,'settled')",[orderId,project.userId,geoId,articleId,'old-version','a'.repeat(64)]);
  const entries=[['budget','budget_set',100,null,'2026-09-30T00:00:00Z'],['before','reserve',0.1,orderId,before],['start','reserve',0.2,orderId,start],['end','settle',0.1,orderId,end],['next','refund',0.1,orderId,next]];
  for(const [id,kind,amount,order,createdAt] of entries)await store.query('INSERT INTO evimed_geo.ledger(id,user_id,geo_project_id,order_id,kind,amount_cny,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[`${name}-${id}`,project.userId,geoId,order,kind,amount,createdAt]);
  const live=await service.analysis(user,geoId,{viewId:'V25',from:'2026-10-02',to:'2026-10-02',timeZone});
  assert.equal(live.page.total,2,name);assert.equal(live.contextualBasis[0].opening.reservedCny,0.1);assert.equal(live.contextualBasis[0].opening.budgetCny,100);
  assert.deepEqual(live.rows.map(row=>row.dimensions.date),[new Date(start).toISOString(),new Date(end).toISOString()]);
  assert.ok(live.rows.every(row=>row.label.startsWith('2026-10-02 · ')),name);assert.ok(live.chart.cells.every(cell=>cell.label.startsWith('2026-10-02 · ')),name);
  const memberIds=[];
  for(const row of live.rows){
   const detail=await service.analysisMembers(user,geoId,{...live.view,selectionRef:live.selection.reference,expectedDigest:live.digest,rowKey:row.key,columnKey:'amountCny'});
   assert.equal(detail.items[0].createdAt,row.dimensions.date);assert.equal(detail.items[0].amountCny,row.values.amountCny.value);memberIds.push(detail.items[0].objectId);
  }
  assert.deepEqual(memberIds,[`${name}-start`,`${name}-end`]);
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest},{service});
  const document=freezeGeoAnalysisDocument(full);
  for(const row of full.rows){assert.ok(document.canonicalMarkdown.includes(`## ${row.label}`));assert.ok(row.label.startsWith('2026-10-02 · '));}
  let exported=null;
  await service.selectedExport(user,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,formats:['csv','xlsx','docx','pdf','html']},{requestFrozen:async(_user,payload)=>{exported=payload;return {id:'export'};}});
  assert.equal(exported.canonicalMarkdown,document.canonicalMarkdown);assert.deepEqual(exported.typedTable,document.typedTable);assert.equal(exported.cover.analysis.digest,live.digest);
  const contexts=new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=contexts;
  const staged=await contexts.stage(user,geoId,{requestKey:`timezone-${name}`,sessionId:`session-${name}`,mode:'analysis',selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,intent:'explain'});
  const request={requestId:`request-${name}`,sessionId:`session-${name}`,content:[{type:'text',text:'Explain these exact local-date ledger entries.'}],geoPlanContext:{referenceId:staged.referenceId}};
  await contexts.prepare(user,{id:project.projectId,userId:project.userId},request);await contexts.bind(user,{id:project.projectId,userId:project.userId},request);
  for(const row of full.rows)assert.deepEqual((await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:row.key,columnKey:'objects',offset:0,limit:50})).items,row.dimensions.objects);
  if(name==='shanghai'&&process.env.GEO_F3_QUALITY_RECEIPTS_DIR){
   await mkdir(process.env.GEO_F3_QUALITY_RECEIPTS_DIR,{recursive:true});
   await writeFile(`${process.env.GEO_F3_QUALITY_RECEIPTS_DIR}/document-ledger.json`,JSON.stringify({...document,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:full.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));
  }
 }
});

test('public CNY cells, exact members, exports and native freezes retain historical accounting through a real question-version advance',{skip:!url},async t=>{
 const isolated=await createGeoTestDatabase(url,'financehistory');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:3,databaseConnectionTimeoutMs:3000});
 t.after(async()=>{await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();
 await seedGeoProject(database,{id:'historical-geo',userId:'historical-owner',projectId:'historical-control',engines:['deepseek'],groups:[{id:'g',pool:'P2'},{id:'h',pool:'P3'}],questions:[{id:'qg',groupId:'g',text:'Old G'},{id:'qh',groupId:'h',text:'Old H'}]});
 const project=await new GeoMeasureStore(database).project('historical-geo'),user={id:project.userId},documents=new ProductDocuments(database);
 const service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});
 await store.query('UPDATE evimed_geo.projects SET budget=$2::jsonb WHERE id=$1',[project.id,JSON.stringify({totalCny:500})]);
 for(const [id,groupId,digest] of [['a','g','a'],['b','h','b'],['c','retired','c']]){
  await store.query('INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,group_id) VALUES($1,$2,$3,$1,$4)',[id,project.userId,project.id,'changed-current-head']);
  await store.query('INSERT INTO evimed_geo.article_versions(geo_project_id,user_id,article_id,result_version_id,digest,path,association) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[project.id,project.userId,id,`old-${id}`,digest.repeat(64),`${id}.md`,JSON.stringify({groupId,questionVersion:1})]);
  await store.query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,article_result_version_id,article_digest,state) VALUES($1,$2,$3,$4,$5,$6,'settled')",[`order-${id}`,project.userId,project.id,id,`old-${id}`,digest.repeat(64)]);
 }
 const entries=[['01','budget_set',100,null],['02','reserve',0.1,'order-a'],['03','reserve',0.2,'order-a'],['04','reserve',2,'order-b'],['05','release',0.1,'order-b'],['06','release',0.2,'order-b'],['07','settle',0.1,'order-b'],['08','settle',0.2,'order-b'],['09','refund',0.1,'order-b'],['10','refund',0.2,'order-b'],['11','settle',3,'order-c'],['12','settle',2,null]];
 for(const [id,kind,amount,orderId] of entries)await store.query('INSERT INTO evimed_geo.ledger(id,user_id,geo_project_id,order_id,kind,amount_cny,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,project.userId,project.id,orderId,kind,amount,`2026-10-02T00:00:${id}Z`]);
 const original=await service.analysis(user,project.id,{viewId:'V25'});
 assert.equal(original.page.total,12);assert.ok(original.rows.some(row=>row.dimensions.groupId==='retired'));
 await store.query('INSERT INTO evimed_geo.question_sets(geo_project_id,version,user_id) VALUES($1,2,$2)',[project.id,project.userId]);
 await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('new-g',$1,$2,2,'P2','New group')",[project.userId,project.id]);
 await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,text,kind,pool,is_measured) VALUES('new-q',$1,$2,'new-g',2,'New question','typical','P2',true)",[project.userId,project.id]);
 await store.query("UPDATE evimed_geo.questions SET retired_at='2026-10-03' WHERE geo_project_id=$1 AND set_version=1",[project.id]);
 await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES('v2-round',$1,$2,'baseline','done',2,'{deepseek}','2026-10-04','{\"mode\":\"web\"}')",[project.userId,project.id]);
 // The new version's baseline heard an answer: a round that heard none is never the latest (2026-10-25).
 await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface) VALUES('v2-answer',$1,$2,'v2-round','new-q','deepseek','2026-10-04','valid','New answer','{\"mode\":\"web\"}')",[project.userId,project.id]);
 const after=await service.analysis(user,project.id,{viewId:'V25'});
 assert.equal(after.page.total,12);assert.deepEqual(after.selection.roundIds,['v2-round']);
 assert.deepEqual(after.rows.map(row=>row.values.amountCny.value),original.rows.map(row=>row.values.amountCny.value));
 assert.equal(after.contextualBasis[0].currentSummary.spentCny,5);assert.equal(after.rows.at(-1).values.spentCny.value,5);assert.equal(after.rows.at(-1).values.availableCny.value,93.3);
 assert.equal(after.rows.find(row=>row.dimensions.groupId==='retired').dimensions.groupContext,'historical_association_current_metadata_unavailable');
 const explicitRound=await service.analysis(user,project.id,{viewId:'V25',round:'v2-round'});assert.equal(explicitRound.page.total,12);
 const explicitGroup=await service.analysis(user,project.id,{viewId:'V25',groupIds:['g']});
 assert.deepEqual(explicitGroup.rows.map(row=>row.dimensions.groupId),[null,'g','g',null]);
 const explicitVersion=await service.analysis(user,project.id,{viewId:'V25',questionVersion:2});assert.deepEqual(explicitVersion.rows.map(row=>row.dimensions.attribution),['global_budget','unassigned']);
 const grouped=await service.analysis(user,project.id,{viewId:'V25',financeFacet:'group'});
 for(const [groupId,column] of [['g','reserveCny'],['h','releaseCny'],['h','settleCny'],['h','refundCny']]){
  const row=grouped.rows.find(row=>row.dimensions.groupId===groupId);assert.equal(row.values[column].value,0.3);
  assert.equal(grouped.chart.cells.find(cell=>cell.rowKey===row.key&&cell.columnKey===column).value,0.3);
  const detail=await service.analysisMembers(user,project.id,{...grouped.view,selectionRef:grouped.selection.reference,expectedDigest:grouped.digest,rowKey:row.key,columnKey:column});
  assert.equal(detail.total,2);assert.equal(detail.items.reduce((sum,item)=>sum+Math.round(item.amountCny*100),0),30);
 }
 const contexts=new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=contexts;
 for(const [name,live] of [['ledger',after],['group',grouped]]){
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest},{service});
  const document=freezeGeoAnalysisDocument(full);
  for(const row of full.rows)for(const value of Object.values(row.values))if(typeof value.value==='number')assert.equal(value.value,Math.round(value.value*100)/100);
  let exportPayload=null;
  await service.selectedExport(user,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,formats:['csv','xlsx','docx','pdf','html']},{requestFrozen:async(_user,payload)=>{exportPayload=payload;return {id:'export'};}});
  assert.deepEqual(exportPayload.typedTable,document.typedTable);assert.equal(exportPayload.cover.analysis.digest,full.digest);
  if(process.env.GEO_F3_REPAIR_RECEIPTS_DIR){
   await mkdir(process.env.GEO_F3_REPAIR_RECEIPTS_DIR,{recursive:true});
   await writeFile(`${process.env.GEO_F3_REPAIR_RECEIPTS_DIR}/document-${name}.json`,JSON.stringify({...document,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:full.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));
  }
  const staged=await contexts.stage(user,project.id,{requestKey:`historical-${name}`,sessionId:'historical-session',mode:'analysis',selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,intent:'explain'});
  const request={requestId:`historical-request-${name}`,sessionId:'historical-session',content:[{type:'text',text:'Explain the preserved historical costs and cent amounts.'}],geoPlanContext:{referenceId:staged.referenceId}};
  await contexts.prepare(user,{id:project.projectId,userId:project.userId},request);await contexts.bind(user,{id:project.projectId,userId:project.userId},request);
  for(const row of full.rows){
   const objects=[];let offset=0;
   do{const part=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:row.key,columnKey:'objects',offset,limit:50});objects.push(...part.items);offset=part.nextOffset;}while(offset!==null);
   assert.deepEqual(objects,row.dimensions.objects);
  }
 }
});
