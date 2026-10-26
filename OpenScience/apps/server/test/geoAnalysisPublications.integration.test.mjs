import assert from 'node:assert/strict';
import test from 'node:test';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {GeoStore} from '../src/geoStore.mjs';
import {GeoService} from '../src/geoService.mjs';
import {ProductDocuments} from '../src/productStore.mjs';
import {GeoPlanContext} from '../src/geoPlanContext.mjs';
import {freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument} from '../src/geoAnalysis.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {GeoMeasureStore} from '../src/geoMeasureStore.mjs';
import {readGeoPublicationContext,buildGeoPublicationAnalysis} from '../src/geoAnalysisPublications.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {seedGeoProject} from './helpers/geoMeasureFixtures.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('publication context reads every article and real page before aggregation, preserving tenant/version boundaries',{skip:!url},async t=>{
 const isolated=await createGeoTestDatabase(url,'publicationanalysis'),database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:3,databaseConnectionTimeoutMs:3000});
 t.after(async()=>{await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();
 await seedGeoProject(database,{id:'publication-geo',userId:'publication-owner',projectId:'publication-control',engines:['deepseek'],groups:[{id:'g',pool:'P2'}],questions:[{id:'q',groupId:'g',text:'Original need'}]});
 const project=await new GeoMeasureStore(database).project('publication-geo');
 await store.query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,group_id,path,current_result_version_id,content_sha256)
  SELECT 'article-'||n,$1,$2,'Same title','g','article-'||n||'.md','version-'||n,repeat('a',64) FROM generate_series(1,2005)n`,[project.userId,project.id]);
 await store.query(`INSERT INTO evimed_geo.article_versions(geo_project_id,user_id,article_id,result_version_id,digest,path,association)
  SELECT $1,$2,'article-'||n,'version-'||n,repeat('a',64),'article-'||n||'.md','{"groupId":"g","audience":"patient","channel":"wechat_mp"}'::jsonb FROM generate_series(1,2005)n`,[project.id,project.userId]);
 await store.query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,article_result_version_id,article_digest,state)
  SELECT 'order-'||n,$1,$2,'article-'||n,'version-'||n,repeat('a',64),'unknown' FROM generate_series(1,201)n`,[project.userId,project.id]);
 await store.query(`INSERT INTO evimed_geo.order_events(id,order_id,at,from_state,to_state,detail)
  SELECT 'event-'||n,'order-'||n,'2026-10-02'::timestamptz,'reserved','unknown','{"private":"never-visible"}'::jsonb FROM generate_series(1,201)n`);
 await store.query(`INSERT INTO evimed_geo.owned_links(id,user_id,geo_project_id,url,url_key,platform,title,published_at,article_id,article_result_version_id,article_digest)
  SELECT 'link-'||n,$1,$2,'https://example.org/'||n,'https://example.org/'||n,'zhihu','Published title','2026-10-02'::timestamptz,'article-'||n,'version-'||n,repeat('a',64) FROM generate_series(1,201)n`,[project.userId,project.id]);
 // Imported inconsistent references must never borrow a foreign owner's body.
 await store.query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state) VALUES('foreign-order','foreign-owner',$1,'unknown')",[project.id]);
 await store.query("INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,current_result_version_id,content_sha256) VALUES('foreign-article','foreign-owner',$1,'Foreign secret','foreign-version',repeat('b',64))",[project.id]);
 await store.query("INSERT INTO evimed_geo.owned_links(id,user_id,geo_project_id,url,url_key,platform,title,article_id,published_at) VALUES('foreign-article-reference',$1,$2,'https://example.org/ref','https://example.org/ref','zhihu','Visible report','foreign-article','2026-10-02')",[project.userId,project.id]);
 const publication=await readGeoPublicationContext(store,project);
 assert.equal(publication.articles.length,2005);assert.equal(publication.versions.length,2005);assert.equal(publication.orders.length,201);assert.equal(publication.publications.length,202);assert.equal(publication.events.length,201);
 assert.doesNotMatch(JSON.stringify(publication),/Foreign secret|never-visible|foreign-order/);
 assert.equal(publication.publications.find(item=>item.id==='foreign-article-reference').articleTitle,null);
 const selected={scope:{timeZone:'Asia/Shanghai'},selection:{reference:'exact'},questions:[{id:'q',group_id:'g',set_version:1}],rows:[]};
 const context={groups:[{id:'g',name:'Original need',set_version:1}],execution:{publication}};
 const coverage=buildGeoPublicationAnalysis(selected,{viewId:'V23',publicationFacet:'group'},context),group=coverage.rows.find(row=>row.dimensions.groupId==='g');
 assert.equal(group.values.articles.value,2005);assert.equal(group.values.resultVersions.value,2005);assert.equal(group.values.formats.value,2005);assert.equal(group.values.ownedPublications.value,201);
 assert.equal(new Set(coverage.memberItems.get(group.key+':articles').map(item=>item.id)).size,2005);
 const execution=buildGeoPublicationAnalysis(selected,{viewId:'V24'},context);
 assert.equal(execution.rows.reduce((sum,row)=>sum+row.values.orders.value,0),201);assert.equal(execution.rows.reduce((sum,row)=>sum+row.values.orderEvents.value,0),201);
 const user={id:project.userId},documents=new ProductDocuments(database),service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});
 const live=await service.analysis(user,project.id,{viewId:'V23',publicationFacet:'group'}),g=live.rows.find(row=>row.dimensions.groupId==='g');
 for(const filter of [{audience:'patient'},{sourceId:'source'},{url:'https://example.org'},{key:'key'},{strategyVersion:1},{answerLimit:20},{member:{id:'x'}}])await assert.rejects(service.analysis(user,project.id,{viewId:'V23',...filter}),error=>error.status===400);
 assert.equal(g.values.articles.value,2005);assert.equal(g.values.resultVersions.value,2005);assert.equal(live.rowContext,'member_details');
 assert.ok(Buffer.byteLength(JSON.stringify(live))<30000,'ordinary response must not duplicate full version histories');
 const ids=[];for(let offset=0;offset<2005;offset+=50){const part=await service.analysisMembers(user,project.id,{...live.view,selectionRef:live.selection.reference,expectedDigest:live.digest,rowKey:g.key,columnKey:'resultVersions',offset,limit:50});ids.push(...part.items.map(item=>item.resultVersionId));}
 assert.equal(new Set(ids).size,2005);assert.ok(ids.includes('version-2005'));
 await assert.rejects(service.analysis({id:'stranger'},project.id,{viewId:'V23'}),error=>error.status===404);
 const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest});
 const contexts=new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=contexts;
 const staged=await contexts.stage(user,project.id,{requestKey:'full-publication-analysis',sessionId:'publication-session',mode:'analysis',selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,intent:'explain'});
 const request={requestId:'publication-native',sessionId:'publication-session',content:[{type:'text',text:'Explain these exact content and publication records.'}],geoPlanContext:{referenceId:staged.referenceId}};
 await contexts.prepare(user,{id:project.projectId,userId:project.userId},request);await contexts.bind(user,{id:project.projectId,userId:project.userId},request);
 const objects=[];let next=0;
 while(next!==null){const part=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:g.key,columnKey:'objects',offset:next,limit:50});objects.push(...part.items);next=part.nextOffset;}
 assert.deepEqual(objects,full.rows.find(row=>row.key===g.key).dimensions.objects);
 assert.equal(objects.filter(item=>item.unit==='result_versions').length,2005);
 await store.query("UPDATE evimed_geo.article_versions SET created_at='2026-10-04' WHERE article_id IN ('article-2004','article-2005')");
 await store.query("UPDATE evimed_geo.owned_links SET published_at='2026-10-04' WHERE id IN ('link-200','link-201')");
 await store.query("UPDATE evimed_geo.orders SET created_at='2026-10-04' WHERE id IN ('order-200','order-201')");
 await store.query("UPDATE evimed_geo.order_events SET at='2026-10-04' WHERE id IN ('event-200','event-201')");
 await assert.rejects(service.analysisMembers(user,project.id,{...live.view,selectionRef:live.selection.reference,expectedDigest:live.digest,rowKey:g.key,columnKey:'resultVersions'}),error=>error.status===409);
 const retained=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:g.key,columnKey:'objects',offset:0,limit:50});assert.deepEqual(retained.items,objects.slice(0,retained.items.length));
 for(const descriptor of [{viewId:'V23',publicationFacet:'group'},{viewId:'V23',publicationFacet:'audience'},{viewId:'V23',publicationFacet:'channel'},{viewId:'V24'}]){
  const small=await freezeSelectedGeoAnalysis(store,project,{from:'2026-10-04',to:'2026-10-04',view:descriptor});
  const doc=freezeGeoAnalysisDocument(small);assert.equal(doc.cover.analysis.digest,small.digest);
  if(descriptor.viewId==='V23')assert.equal(small.rows.reduce((n,row)=>n+row.values.articles.value,0),2);
  else{assert.equal(small.rows.reduce((n,row)=>n+row.values.orderEvents.value,0),2);assert.equal(small.chart.timeline.events.length,2);}
  if(process.env.GEO_F2_RECEIPTS_DIR){await mkdir(process.env.GEO_F2_RECEIPTS_DIR,{recursive:true});await writeFile(`${process.env.GEO_F2_RECEIPTS_DIR}/document-${descriptor.publicationFacet??'execution'}.json`,JSON.stringify({...doc,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:small.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));}
 }
 await store.query("INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title) SELECT 'article-'||n,$1,$2,'Extra article' FROM generate_series(2006,20001)n",[project.userId,project.id]);
 await assert.rejects(readGeoPublicationContext(store,project),error=>error.status===422);
});
