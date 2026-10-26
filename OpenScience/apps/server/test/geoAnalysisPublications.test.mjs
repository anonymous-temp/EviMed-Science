import assert from 'node:assert/strict';
import test from 'node:test';
import {buildGeoPublicationAnalysis} from '../src/geoAnalysisPublications.mjs';
const selected={scope:{timeZone:'Asia/Shanghai',groupIds:[],pools:[],clientTags:[]},selection:{reference:'selected'},questions:[{id:'q',group_id:'g',set_version:1}],rows:[]};
const version=(id,path,extra={})=>({articleId:'article',resultVersionId:id,digest:id.padEnd(64,'a'),path,createdAt:'2026-10-01T00:00:00Z',association:{groupId:'g',audience:'patient',channel:'wechat_mp'},...extra});
const context={groups:[{id:'g',name:'Original need',set_version:1}],execution:{publication:{articles:[{id:'article',title:'Same title',currentResultVersionId:'new'}],versions:[version('old','old.md'),version('new','new.docx')],publications:[{id:'link',articleId:'article',articleResultVersionId:'old',articleDigest:'old'.padEnd(64,'a'),platform:'zhihu',status:'active',publishedAt:'2026-10-02T00:00:00Z',url:'https://example.org/old'}],orders:[{id:'order',articleId:'article',articleResultVersionId:'new',articleDigest:'new'.padEnd(64,'a'),state:'unknown',createdAt:'2026-10-03T00:00:00Z'}],events:[{id:'event',orderId:'order',at:'2026-10-03T00:00:00Z',fromState:'pending',toState:'unknown'}]}}};
test('content coverage distinguishes article, immutable versions, actual formats and reported publication',()=>{
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V23',publicationFacet:'group'},context),row=result.rows.find(row=>row.dimensions.groupId==='g');
 assert.equal(row.values.articles.value,1);assert.equal(row.values.resultVersions.value,2);assert.equal(row.values.formats.value,2);assert.equal(row.values.ownedPublications.value,1);assert.equal(row.values.paidPublications.value,0);
 const published=result.memberItems.get(row.key+':ownedPublications')[0];assert.equal(published.resultVersionId,'old');assert.equal(published.association.channel,'wechat_mp');assert.equal(published.platform,'zhihu');assert.equal(published.publicationBasis,'user_reported');
});
test('version associations never borrow the new head or merge same-named groups',()=>{
 const fixture=structuredClone(context);fixture.execution.publication.versions[1].association.groupId='other';fixture.groups.push({id:'other',name:'Original need',set_version:2});
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V23',publicationFacet:'group'},fixture);
 assert.equal(result.rows.find(row=>row.dimensions.groupId==='g').values.resultVersions.value,1);assert.equal(result.rows.some(row=>row.dimensions.groupId==='other'),false);
 fixture.execution.publication.publications[0].articleDigest='b'.repeat(64);
 const unknown=buildGeoPublicationAnalysis(selected,{viewId:'V23',publicationFacet:'group'},fixture).rows.find(row=>row.dimensions.mappingState==='unknown');assert.equal(unknown.values.ownedPublications.value,1);
});
test('intended channel coverage does not relabel an actual publication platform',()=>{
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V23',publicationFacet:'channel'},context);
 const row=result.rows.find(row=>row.dimensions.channel==='wechat_mp');assert.equal(row.values.ownedPublications.value,1);
 assert.equal(result.rows.some(row=>row.dimensions.channel==='zhihu'),false);assert.match(result.definition.countingRule,/intended/);
});
test('execution counts keep unknown orders, current publication state and actual transition history independent',()=>{
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V24'},context);
 const unknown=result.rows.find(row=>row.dimensions.objectKind==='order'&&row.dimensions.status==='unknown');assert.equal(unknown.values.orders.value,1);assert.equal(unknown.values.orderEvents.value,1);
 assert.equal(result.memberItems.get(unknown.key+':orders')[0].resultVersionId,'new');
 const owned=result.rows.find(row=>row.dimensions.objectKind==='owned_publication');assert.equal(owned.values.ownedPublications.value,1);assert.equal(owned.values.orders.value,0);
});
test('business dates use their explicit timestamp and retain unknown dates as unknown, never nearest sample',()=>{
 const fixture=structuredClone(context);fixture.execution.publication.publications[0].publishedAt=null;
 const scoped={...selected,scope:{...selected.scope,from:'2026-10-02',to:'2026-10-02'}};
 const result=buildGeoPublicationAnalysis(scoped,{viewId:'V23',publicationFacet:'group'},fixture);
 assert.equal(result.rows.reduce((n,row)=>n+row.values.resultVersions.value,0),0);assert.equal(result.rows.reduce((n,row)=>n+row.values.ownedPublications.value,0),1);
 assert.ok(result.rows.flatMap(row=>row.dimensions.objects).some(item=>item.timeState==='unknown'));
});

test('article and format drilldown retains only versions in the chosen audience and time bucket',()=>{
 const fixture=structuredClone(context);fixture.execution.publication.versions[1].association.audience='physician';
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V23',publicationFacet:'audience'},fixture);
 const patient=result.rows.find(row=>row.dimensions.audience==='patient');
 assert.equal(result.memberItems.get(patient.key+':articles')[0].resultVersionCount,1);
 assert.equal(result.memberItems.get(patient.key+':formats')[0].resultVersionCount,1);
 assert.deepEqual(result.memberItems.get(patient.key+':resultVersions').map(v=>v.resultVersionId),['old']);
});

test('a large same-article version history is indexed once without losing exact versions',()=>{
 const fixture=structuredClone(context);fixture.execution.publication.versions=Array.from({length:5000},(_,index)=>version('v'+index,'same.md'));fixture.execution.publication.orders=[];fixture.execution.publication.publications=[];fixture.execution.publication.events=[];
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V23',publicationFacet:'group'},fixture),row=result.rows[0];
 assert.equal(row.values.articles.value,1);assert.equal(row.values.formats.value,1);assert.equal(row.values.resultVersions.value,5000);
 assert.equal(result.memberItems.get(row.key+':articles')[0].resultVersionCount,5000);assert.equal(result.memberItems.get(row.key+':formats')[0].resultVersionCount,5000);
});

test('current group metadata cannot relabel the selected older question version',()=>{
 const fixture=structuredClone(context);fixture.groups[0].set_version=2;
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V23',publicationFacet:'group'},fixture);
 assert.equal(result.rows.some(row=>row.dimensions.groupId==='g'),false);assert.equal(result.availability.status,'partial');
 assert.equal(result.rows.find(row=>row.dimensions.mappingState==='unknown').values.articles.value,1);
});

test('an unrecorded version path remains an unknown format without borrowing the current article path',()=>{
 const fixture=structuredClone(context);fixture.execution.publication.versions[0].path=null;fixture.execution.publication.articles[0].path='current.docx';
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V23'},fixture),row=result.rows[0];
 assert.ok(result.memberItems.get(row.key+':formats').some(item=>item.format==='unknown'));assert.ok(result.availability.reasons.includes('content_format_unknown'));
});

test('historical event markers describe their own transition instead of the current order state',()=>{
 const fixture=structuredClone(context);fixture.execution.publication.orders[0].state='cancelled';fixture.execution.publication.events[0].fromState='accepted';fixture.execution.publication.events[0].toState='published';
 const result=buildGeoPublicationAnalysis(selected,{viewId:'V24'},fixture);
 assert.equal(result.chart.timeline.events[0].label,'已受理 → 已发布');
 assert.ok(result.rows.some(row=>row.dimensions.status==='cancelled'));
});
