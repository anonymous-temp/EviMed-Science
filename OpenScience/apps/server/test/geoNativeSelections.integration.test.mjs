import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createGeoRoutes } from '../src/geoRoutes.mjs';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { createNativeSelectionFixture as fixture } from './helpers/geoNativeSelectionFixture.mjs';
import { GeoMarketStore } from '../src/geoMarketStore.mjs';
import { GeoOwnedPublications } from '../src/geoOwnedPublications.mjs';
import { nativeInputCandidate } from '../src/geoNativeInputs.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, timeout: 60000 };

test('implicit article follow-up previews exact human input and owner bytes before admission, then binds once',options,async t=>{
  const f=await fixture(t),request=f.request('implicit');
  // A personal project with the identical local id must never supply its bytes.
  const personal=await f.accounts.requireProject(f.users.editor,'default');
  assert.equal(personal.id,f.project.id);assert.notEqual(personal.userId,f.project.userId);
  const original=structuredClone(request),frame=await f.prepare(request);
  assert.deepEqual(request,original);
  const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.equal(receipt.payload.actor.id,'editor');assert.equal(receipt.payload.ownerId,'owner');
  assert.equal(receipt.payload.native.originalParts,1);
  assert.equal(receipt.payload.candidate.bindings.length,1);
  const ref=receipt.payload.candidate.bindings[0].id;
  const staged=await f.documents.get('owner','result-revision',ref);
  assert.equal(staged.payload.state,'staged');assert.equal(staged.payload.requestedBy,'editor');
  assert.equal(f.mirrors(),0);
  await assert.rejects(access(path.join(f.project.workspaceDir,`artifacts/result-revisions/${ref}/input.md`)));
  await f.submit(request,frame);
  assert.equal(f.mirrors(),1);
  const final=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.equal(final.payload.state,'accepted');
  assert.equal(final.payload.candidate.forwardedRequestDigest,nativeInputCandidate(request).forwardedRequestDigest);
  assert.deepEqual(request.content[0],original.content[0]);
  const row=await f.documents.get('owner','result-revision',ref);
  assert.equal(row.payload.instruction,original.content[0].text);
  assert.equal((await f.store.getArticle(f.geo.id,f.articleId)).currentResultVersionId,f.version.versionId);
});

test('GPC modification appends GPC then result context without treating system text as human instruction',options,async t=>{
  const f=await fixture(t),request=f.request('modify');
  const id=`gpc_${'a'.repeat(64)}`;
  const action={work:{mode:'modify_existing',resultVersionId:f.version.versionId,digest:f.version.digest,articleId:f.articleId}};
  const payload={geoId:f.geo.id,actorId:'editor',sessionId:'root',state:'staged',mode:'content',fingerprint:'fingerprint',basisDigest:'basis',basis:{scope:{}},actions:[action],draft:''};
  await f.documents.put('owner','geo-plan-context',id,payload,{projectId:f.project.id,expectedRevision:0});
  request.geoPlanContext={referenceId:id};
  // The actual service resolves and binds its staged row; only irrelevant
  // expiry/strategy-catalogue checks use this minimal fixture envelope.
  const original=request.content[0].text, frame=await f.prepare(request);
  await f.submit(request,frame);
  assert.match(request.content[1].text, /evimed_geo_plan_context/);
  assert.match(request.content[2].text, /evimed_result_selection/);
  const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  const binding=receipt.payload.candidate.bindings.find(item=>item.kind==='result-revision');
  assert.equal((await f.documents.get('owner','result-revision',binding.id)).payload.instruction,original);
  assert.equal(receipt.payload.native.originalParts,1);
  assert.equal(receipt.payload.candidate.forwardedRequestDigest,nativeInputCandidate(request).forwardedRequestDigest);
});

test('GPC new work and multiple leaf ambiguity keep ordinary input free of borrowed file context',options,async t=>{
  const f=await fixture(t);
  const request=f.request('ambiguous');
  await f.capture('another.md','# Another');
  // Remove the business pointer so the shared immutable leaf search is exercised.
  await f.store.query('DELETE FROM evimed_geo.article_versions WHERE article_id=$1',[f.articleId]);
  await f.store.query('DELETE FROM evimed_geo.articles WHERE id=$1',[f.articleId]);
  const original=structuredClone(request),frame=await f.prepare(request);
  await f.submit(request,frame);
  assert.deepEqual(request,original);
  const row=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.deepEqual(row.payload.candidate.bindings,[]);
});

test('changed head and revoked role refuse before binding or mirroring',options,async t=>{
  const f=await fixture(t),request=f.request('racing');
  const frame=await f.prepare(request),next=await f.capture('next.md','# Next',f.version.versionId);
  await f.store.linkArticleVersion(f.geo.id,f.articleId,{version:next,expectedHeadVersionId:f.version.versionId,requestId:'next'});
  await assert.rejects(f.submit(request,frame),{code:'geo_article_head_changed'});
  assert.equal(f.mirrors(),0);
  const second=f.request('revoked'),secondFrame=await f.prepare(second);
  await f.store.query('DELETE FROM evimed_geo.members WHERE geo_project_id=$1 AND user_id=$2',[f.geo.id,'editor']);
  await assert.rejects(f.submit(second,secondFrame));assert.equal(f.mirrors(),0);
});

test('missing preserved artifact refuses in Phase A with no staged file or mirror',options,async t=>{
  const f=await fixture(t),request=f.request('missing');
  const raw=await f.documents.get('owner','result-version',f.version.versionId);
  // The exact immutable snapshot is server-owned metadata, never current workspace bytes.
  assert.ok(raw);
  await rm(path.join(f.project.metaDir,raw.payload.storagePath));
  await assert.rejects(f.prepare(request));assert.equal(f.mirrors(),0);
});

test('accepted and unknown retries retain original bound rows after head advances and never forward again',options,async t=>{
  for(const state of ['accepted','unknown'])await t.test(state,async t=>{
    const f=await fixture(t),request=f.request(`retry-${state}`),frame=await f.prepare(request);
    await f.submit(request,frame,f.users.editor,state);
    const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
    const ref=receipt.payload.candidate.bindings[0].id,bound=await f.documents.get('owner','result-revision',ref);
    const next=await f.capture('advanced.md','# Advanced',f.version.versionId);
    await f.store.linkArticleVersion(f.geo.id,f.articleId,{version:next,expectedHeadVersionId:f.version.versionId,requestId:'advance'});
    const retry=f.request(`retry-${state}`),retryFrame=await f.prepare(retry);
    await assert.rejects(f.submit(retry,retryFrame),{code:'geo_native_input_already_submitted'});
    assert.deepEqual(await f.documents.get('owner','result-revision',ref),bound);
    assert.equal(f.mirrors(),1);
    assert.equal((await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId)).payload.state,state);
  });
});

test('historical exact capture is prepared without premature business-head migration',options,async t=>{
  const f=await fixture(t),request=f.request('migration');
  await f.store.query('DELETE FROM evimed_geo.article_versions WHERE article_id=$1',[f.articleId]);
  await f.store.query('UPDATE evimed_geo.articles SET current_result_version_id=NULL WHERE id=$1',[f.articleId]);
  const frame=await f.prepare(request);
  assert.equal((await f.store.getArticle(f.geo.id,f.articleId)).currentResultVersionId,null);
  assert.equal(f.mirrors(),0);
  await f.submit(request,frame);
  assert.equal((await f.store.getArticle(f.geo.id,f.articleId)).currentResultVersionId,f.version.versionId);
});

test('GPC nonmodifying action uses only its selected plan even when one article is available',options,async t=>{
  const f=await fixture(t),request=f.request('new-work'),id=`gpc_${'b'.repeat(64)}`;
  await f.documents.put('owner','geo-plan-context',id,{geoId:f.geo.id,actorId:'editor',sessionId:'root',state:'staged',mode:'content',
    fingerprint:'new-work',basisDigest:'basis',basis:{scope:{}},actions:[{work:{mode:'new',outputs:['new.md']}}],draft:''},{projectId:f.project.id,expectedRevision:0});
  request.geoPlanContext={referenceId:id};
  const frame=await f.prepare(request);await f.submit(request,frame);
  assert.equal(request.content.length,2);assert.match(request.content[1].text,/evimed_geo_plan_context/);
  const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.deepEqual(receipt.payload.candidate.bindings.map(item=>item.kind),['geo-plan-context']);
  assert.equal(f.mirrors(),0);
});

test('explicit result reference is prepared, journaled and bound without implicit reselection',options,async t=>{
  const f=await fixture(t),request=f.request('explicit');
  const reference=await f.revisions.stage('owner',f.version.versionId,{projectId:f.project.id,digest:f.version.digest,
    requestId:'explicit-stage',sessionId:'root',anchor:{kind:'file',elementId:'file',selectedText:''}});
  request.evimedResultRevision={referenceId:reference.referenceId};
  const frame=await f.prepare(request,f.users.owner),staged=await f.documents.get('owner','result-revision',reference.referenceId);
  assert.equal(staged.payload.state,'staged');assert.equal(f.mirrors(),0);
  await f.submit(request,frame,f.users.owner);
  assert.equal(request.evimedResultRevision,undefined);
  const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.equal(receipt.payload.candidate.bindings[0].id,reference.referenceId);
  assert.equal(receipt.payload.candidate.forwardedRequestDigest,nativeInputCandidate(request).forwardedRequestDigest);
});

test('private authority does not transfer to cloned requests or same-id personal projects',options,async t=>{
  const f=await fixture(t),request=f.request('private-scope');
  await f.prepare(request);
  const clone=structuredClone(request);
  assert.equal(await f.revisions.preview('editor',f.project,clone),null);
  const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  clone.evimedResultRevision={referenceId:receipt.payload.candidate.bindings[0].id};
  await assert.rejects(f.revisions.preview('editor',f.project,clone));
  const personal=await f.accounts.requireProject(f.users.editor,'default');
  await assert.rejects(f.revisions.preview('editor',personal,request));
});

test('a selected modification and conflicting explicit result refuse without binding either context',options,async t=>{
  const f=await fixture(t),request=f.request('conflicting'),id=`gpc_${'c'.repeat(64)}`;
  const another=await f.capture('other.md','# Other');
  const reference=await f.revisions.stage('owner',another.versionId,{projectId:f.project.id,digest:another.digest,
    requestId:'other-stage',sessionId:'root',anchor:{kind:'file',elementId:'file',selectedText:''}});
  await f.documents.put('owner','geo-plan-context',id,{geoId:f.geo.id,actorId:'owner',sessionId:'root',state:'staged',mode:'content',
    fingerprint:'conflicting',basisDigest:'basis',basis:{scope:{}},actions:[{work:{mode:'modify_existing',resultVersionId:f.version.versionId,digest:f.version.digest,articleId:f.articleId}}],draft:''},{projectId:f.project.id,expectedRevision:0});
  request.geoPlanContext={referenceId:id};request.evimedResultRevision={referenceId:reference.referenceId};
  await assert.rejects(f.prepare(request,f.users.owner),{code:'geo_native_input_conflict'});
  assert.equal((await f.documents.get('owner','result-revision',reference.referenceId)).payload.state,'staged');
  assert.equal((await f.documents.get('owner','geo-plan-context',id)).payload.state,'staged');assert.equal(f.mirrors(),0);
});

for(const state of ['accepted','unknown'])test(`${state} GPC modification replay resolves disposition before unavailable historical source rendering`,options,async t=>{
  const f=await fixture(t),request=f.request(`unavailable-gpc-${state}`),id=`gpc_${'d'.repeat(64)}`;
  await f.documents.put('owner','geo-plan-context',id,{geoId:f.geo.id,actorId:'editor',sessionId:'root',state:'staged',mode:'content',
    fingerprint:'unavailable-replay',basisDigest:'basis',basis:{scope:{}},actions:[{work:{mode:'modify_existing',resultVersionId:f.version.versionId,digest:f.version.digest,articleId:f.articleId}}],draft:''},{projectId:f.project.id,expectedRevision:0});
  request.geoPlanContext={referenceId:id};
  const original=structuredClone(request),frame=await f.prepare(request);
  await f.submit(request,frame,f.users.editor,state);
  const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  const referenceId=receipt.payload.candidate.bindings.find(binding=>binding.kind==='result-revision').id;
  const bound=await f.documents.get('owner','result-revision',referenceId),context=await f.documents.get('owner','geo-plan-context',id);
  const next=await f.capture(`advanced-${state}.md`,'# Advanced',f.version.versionId);
  await f.store.linkArticleVersion(f.geo.id,f.articleId,{version:next,expectedHeadVersionId:f.version.versionId,requestId:'advance'});
  const snapshot=await f.documents.get('owner','result-version',f.version.versionId);
  await rm(path.join(f.project.metaDir,snapshot.payload.storagePath));
  let reads=0,reselections=0;
  const raw=f.results.raw.bind(f.results),list=f.store.listArticles.bind(f.store),query=f.results.query.bind(f.results);
  f.results.raw=async(...args)=>{reads++;return raw(...args);};
  f.store.listArticles=async(...args)=>{reselections++;return list(...args);};
  f.results.query=async(...args)=>{reselections++;return query(...args);};
  const retry=structuredClone(original),replayFrame=await f.prepare(retry);
  assert.ok(f.journal.operations.get(retry)?.replay,'the actual journal reached its retained replay disposition');
  assert.equal(f.journal.disposition(retry),state);
  await assert.rejects(f.submit(retry,replayFrame),{code:'geo_native_input_already_submitted'});
  assert.equal(reads,0);assert.equal(reselections,0);assert.equal(f.mirrors(),1);
  assert.deepEqual(await f.documents.get('owner','result-revision',referenceId),bound);
  assert.deepEqual(await f.documents.get('owner','geo-plan-context',id),context);
  assert.deepEqual(await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId),receipt);
  const changed=structuredClone(original);changed.content[0].text+=' changed';
  await assert.rejects(f.prepare(changed),{code:'geo_native_input_conflict'});
  assert.equal(f.journal.operations.has(changed),false);
  await f.store.query('DELETE FROM evimed_geo.members WHERE geo_project_id=$1 AND user_id=$2',[f.geo.id,'editor']);
  const revoked=structuredClone(original);
  await assert.rejects(f.prepare(revoked));assert.equal(f.journal.operations.has(revoked),false);
  assert.equal(reads,0);assert.equal(f.mirrors(),1);
});

test('a fresh modifying GPC still requires the selected preserved bytes before journal creation',options,async t=>{
  const f=await fixture(t),request=f.request('new-modify-unavailable'),id=`gpc_${'7'.repeat(64)}`;
  await f.documents.put('owner','geo-plan-context',id,{geoId:f.geo.id,actorId:'editor',sessionId:'root',state:'staged',mode:'content',
    fingerprint:'new-unavailable',basisDigest:'basis',basis:{scope:{}},actions:[{work:{mode:'modify_existing',resultVersionId:f.version.versionId,digest:f.version.digest,articleId:f.articleId}}],draft:''},{projectId:f.project.id,expectedRevision:0});
  request.geoPlanContext={referenceId:id};
  const snapshot=await f.documents.get('owner','result-version',f.version.versionId);
  await rm(path.join(f.project.metaDir,snapshot.payload.storagePath));
  await assert.rejects(f.prepare(request),{code:'result_snapshot_unavailable'});
  assert.equal(await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId),null);
  assert.equal((await f.documents.get('owner','geo-plan-context',id)).payload.state,'staged');
  assert.equal(f.mirrors(),0);
});

for (const state of ['accepted','unknown']) test(`${state} unselected replay precedes newly available article selection`, options, async t => {
  const f = await fixture(t);
  await f.store.query('DELETE FROM evimed_geo.article_versions WHERE article_id=$1',[f.articleId]);
  await f.store.query('DELETE FROM evimed_geo.articles WHERE id=$1',[f.articleId]);
  await f.capture('second.md','# Second candidate');
  const request=f.request(`quality-unselected-${state}`), original=structuredClone(request), frame=await f.prepare(request);
  const before=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.deepEqual(before.payload.candidate.bindings,[]);
  await f.submit(request,frame,f.users.editor,state);
  const retained=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.equal(retained.payload.state,state);
  const [articleId]=await f.store.registerArticles('owner',f.geo.id,[{path:f.version.path,layer:'popular',title:'Registered after original submission',claimIds:[],gate:'unverified',safety:'open',contentSha256:f.version.digest,runId:'run-article.md'}]);
  await f.store.linkArticleVersion(f.geo.id,articleId,{version:f.version});
  const snapshot=await f.documents.get('owner','result-version',f.version.versionId);
  await rm(path.join(f.project.metaDir,snapshot.payload.storagePath));
  let reads=0,reselections=0;
  const raw=f.results.raw.bind(f.results),list=f.store.listArticles.bind(f.store),query=f.results.query.bind(f.results);
  f.results.raw=async(...args)=>{reads++;return raw(...args);};
  f.store.listArticles=async(...args)=>{reselections++;return list(...args);};
  f.results.query=async(...args)=>{reselections++;return query(...args);};
  const retry=structuredClone(original);
  let replayFrame,preparationError;
  try { replayFrame=await f.prepare(retry); } catch(error) { preparationError=error; }
  const after=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.deepEqual(after,retained);
  assert.equal(preparationError,undefined,'Exact accepted/unknown receipt must be resolved before reselection, including an originally unselected input');
  assert.equal(f.journal.disposition(retry),state);
  await assert.rejects(f.submit(retry,replayFrame),{code:'geo_native_input_already_submitted'});
  assert.equal(reads,0);assert.equal(reselections,0);assert.equal(f.mirrors(),0);
});


test('a removed replay hint cannot become a new unpreviewed submission',options,async t=>{
 const f=await fixture(t),request=f.request('removed-replay-hint'),original=structuredClone(request),frame=await f.prepare(request);
 const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
 const retry=structuredClone(original);await f.selections.prepare(f.users.editor,f.project,retry);
 await f.documents.remove('owner','geo-plan-context',receipt.id,receipt.revision);
 await assert.rejects(f.journal.prepare({user:f.users.editor,project:f.project,claims:frame,request:retry}),{code:'geo_native_input_conflict'});
 const removed=await f.documents.get('owner','geo-plan-context',receipt.id,{includeDeleted:true});
 assert.ok(removed.deletedAt);assert.equal(removed.revision,receipt.revision+1);assert.equal(f.mirrors(),0);
});

test('GEO staged article revision binds to the member, exact head and producer session',options,async t=>{
  const f=await fixture(t);
  await f.accounts.createUser('viewer','fixture-password','viewer');
  f.users.viewer=await f.accounts.userById('viewer');
  await f.store.addMember({geoId:f.geo.id,userId:'viewer',role:'viewer',invitedBy:'owner'});
  const input={versionId:f.version.versionId,digest:f.version.digest,requestId:'member-stage'};
  const ownerStaged=await f.articles.stageSelected(f.users.owner,f.geo.id,f.articleId,{...input,requestId:'owner-stage'},f.authority);
  assert.equal(ownerStaged.sessionId,'root');
  const staged=await f.articles.stageSelected(f.users.editor,f.geo.id,f.articleId,input,f.authority);
  assert.equal(staged.sessionId,'root');
  const row=await f.documents.get('owner','result-revision',staged.referenceId);
  assert.equal(row.payload.requestedBy,'editor');
  assert.equal(row.payload.nativeOwnerId,'owner');
  assert.equal(row.payload.target.articleId,f.articleId);
  const request=f.request('member-explicit');request.evimedResultRevision={referenceId:staged.referenceId};
  const frame=await f.prepare(request,f.users.editor);
  await f.submit(request,frame,f.users.editor);
  assert.equal((await f.documents.get('owner','result-revision',staged.referenceId)).payload.state,'bound');
  await assert.rejects(f.articles.stageSelected(f.users.editor,f.geo.id,f.articleId,{...input,requestId:'bad-digest',digest:'bad'},f.authority),{code:'geo_article_head_changed'});
  await assert.rejects(f.articles.stageSelected(f.users.viewer,f.geo.id,f.articleId,{...input,requestId:'viewer'},f.authority));
});

test('GEO article text requires a linked immutable version and read membership',options,async t=>{
  const f=await fixture(t);
  await f.accounts.createUser('viewer','fixture-password','viewer');
  f.users.viewer=await f.accounts.userById('viewer');
  await f.store.addMember({geoId:f.geo.id,userId:'viewer',role:'viewer',invitedBy:'owner'});
  const read=await f.articles.readArticleVersion(f.users.viewer,f.geo.id,f.articleId,f.version.versionId,f.version.digest,f.authority);
  assert.match(read.text,/Original/);
  await assert.rejects(f.articles.readArticleVersion(f.users.viewer,f.geo.id,f.articleId,f.version.versionId,'wrong',f.authority),{code:'geo_article_not_found'});
  const unrelated=await f.capture('other.md','# Other');
  await assert.rejects(f.articles.readArticleVersion(f.users.viewer,f.geo.id,f.articleId,unrelated.versionId,unrelated.digest,f.authority),{code:'geo_article_not_found'});
});


test('publication pins authorize the exact order and retained owned-link revision',options,async t=>{
  const f=await fixture(t); f.service.ownedPublications=new GeoOwnedPublications({store:f.store,documents:f.documents});
  await f.accounts.createUser('viewer','fixture-password','viewer');
  const viewer=await f.accounts.userById('viewer');
  await f.store.addMember({geoId:f.geo.id,userId:'viewer',role:'viewer',invitedBy:'owner'});
  await f.store.query(`UPDATE evimed_geo.projects SET status='active', budget='{"totalCny":1000,"dailyCny":1000}'::jsonb WHERE id=$1`,[f.geo.id]);
  const market=new GeoMarketStore(f.db),at=new Date().toISOString();
  const [order]=await market.insertOrders([{userId:'owner',geoProjectId:f.geo.id,articleId:f.articleId,mediaType:'website',resourceId:'outlet',priceCny:10,reserveCny:11}],at);
  await f.store.upsertOwnedLinks('owner',f.geo.id,[{url:'https://example.org/article',urlKey:'example.org/article',platform:'brand_site',title:'Original',publishedAt:at,articleId:f.articleId,groupId:null}]);
  const [link]=await f.store.ownedLinks(f.geo.id);
  const routes=createGeoRoutes({store:{ensureSessionUser:async()=>({user:viewer}),assertCsrf:async()=>{}},service:f.service,config:f.config,maxJsonBytes:65536,projects:{create:async()=>({id:'unused',name:'unused'}),bindSession:async()=>({sessionId:null,bound:false}),readPublicationVersion:(user,geoId,kind,recordId,versionId,digest,revision)=>f.articles.readPublicationVersion(user,geoId,kind,recordId,versionId,digest,revision,f.authority)}});
  const get=async url=>{const res={body:'',writeHead(){},end(value){this.body=String(value);}};await routes({method:'GET',url,headers:{}},res);return JSON.parse(res.body).data;};
  const route=`/api/geo/projects/${f.geo.id}/orders/${order.id}/version-text?versionId=${f.version.versionId}&digest=${f.version.digest}`;
  assert.match((await get(route)).text,/Original/);
  await assert.rejects(get(route.replace(f.version.digest,'wrong')),{code:'geo_article_not_found'});
  assert.match((await f.articles.readPublicationVersion(viewer,f.geo.id,'orders',order.id,f.version.versionId,f.version.digest,null,f.authority)).text,/Original/);
  assert.match((await f.articles.readPublicationVersion(viewer,f.geo.id,'owned-links',link.id,f.version.versionId,f.version.digest,null,f.authority)).text,/Original/);
  await assert.rejects(f.articles.readPublicationVersion(viewer,f.geo.id,'orders',order.id,f.version.versionId,'wrong',null,f.authority),{code:'geo_article_not_found'});
  const next=await f.capture('article.md','# New',f.version.versionId);
  await f.store.linkArticleVersion(f.geo.id,f.articleId,{version:next,expectedHeadVersionId:f.version.versionId,requestId:'next'});
  await f.service.confirmOwnedPublication(f.users.owner,f.geo.id,link.id,{requestKey:'confirm',expectedRevision:0,expectedResultVersionId:f.version.versionId,expectedDigest:f.version.digest,resultVersionId:next.versionId,digest:next.digest,publishedAt:at});
  const history=await f.service.ownedPublicationDetail(viewer,f.geo.id,link.id);
  const old=history.history.items.find(item=>item.resultVersionId===f.version.versionId);
  assert.ok(old);
  assert.match((await f.articles.readPublicationVersion(viewer,f.geo.id,'owned-links',link.id,f.version.versionId,f.version.digest,old.revision,f.authority)).text,/Original/);
  assert.match((await get(`/api/geo/projects/${f.geo.id}/owned-links/${link.id}/version-text?versionId=${f.version.versionId}&digest=${f.version.digest}&revision=${old.revision}`)).text,/Original/);
  await assert.rejects(f.articles.readPublicationVersion(viewer,f.geo.id,'owned-links',link.id,f.version.versionId,f.version.digest,null,f.authority),{code:'geo_article_not_found'});
});


test('GEO version HTTP endpoints reject outsiders, other projects and stale heads',options,async t=>{
  const f=await fixture(t);
  await f.accounts.createUser('outsider','fixture-password','outsider');
  const outsider=await f.accounts.userById('outsider');
  const otherProject=await f.accounts.requireProject(outsider,'default');
  const otherGeo=await f.store.createProject({userId:outsider.id,projectId:otherProject.id,engines:['deepseek'],coverageDays:90});
  let actor=f.users.editor;
  const routes=createGeoRoutes({store:{ensureSessionUser:async()=>({user:actor}),assertCsrf:async()=>{}},service:f.service,config:f.config,maxJsonBytes:65536,projects:{create:async()=>({id:'unused',name:'unused'}),bindSession:async()=>({sessionId:null,bound:false}),
    stageArticleRevision:(user,geoId,articleId,input)=>f.articles.stageSelected(user,geoId,articleId,input,f.authority),
    readArticleVersion:(user,geoId,articleId,versionId,digest)=>f.articles.readArticleVersion(user,geoId,articleId,versionId,digest,f.authority),
    readPublicationVersion:(user,geoId,kind,recordId,versionId,digest,revision)=>f.articles.readPublicationVersion(user,geoId,kind,recordId,versionId,digest,revision,f.authority)}});
  const invoke=async(method,url,body)=>{const req=Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []),{method,url,headers:{'content-type':'application/json'}});const res={body:'',writeHead(){},end(value){this.body=String(value);}};await routes(req,res);return JSON.parse(res.body).data;};
  const base=`/api/geo/projects/${f.geo.id}/articles/${f.articleId}`;
  const query=`?versionId=${f.version.versionId}&digest=${f.version.digest}`;
  assert.match((await invoke('GET',`${base}/version-text${query}`)).text,/Original/);
  await assert.rejects(invoke('GET',`${base}/version-text?versionId=${f.version.versionId}&digest=wrong`),{code:'geo_article_not_found'});
  await assert.rejects(invoke('GET',`/api/geo/projects/${otherGeo.id}/articles/${f.articleId}/version-text${query}`));
  actor=outsider; await assert.rejects(invoke('GET',`${base}/version-text${query}`));
  actor=f.users.editor;
  await assert.rejects(invoke('POST',`${base}/revision`,{versionId:f.version.versionId,digest:'wrong',requestId:'stale-http'}),{code:'geo_article_head_changed'});
  const staged=await invoke('POST',`${base}/revision`,{versionId:f.version.versionId,digest:f.version.digest,requestId:'valid-http'});
  const request=f.request('revoked-http'); request.evimedResultRevision={referenceId:staged.referenceId};
  await f.store.query('DELETE FROM evimed_geo.members WHERE geo_project_id=$1 AND user_id=$2',[f.geo.id,'editor']);
  await assert.rejects(f.prepare(request,f.users.editor));
});

test('GEO explicit article stage refuses changed session, head and actor before binding',options,async t=>{
  const f=await fixture(t);
  const input={versionId:f.version.versionId,digest:f.version.digest,requestId:'explicit-race'};
  const staged=await f.articles.stageSelected(f.users.editor,f.geo.id,f.articleId,input,f.authority);
  const changedSession=f.request('wrong-session');changedSession.sessionId='other';changedSession.evimedResultRevision={referenceId:staged.referenceId};
  await assert.rejects(f.selections.prepare(f.users.editor,f.project,changedSession));
  const otherActor=f.request('wrong-actor');otherActor.evimedResultRevision={referenceId:staged.referenceId};
  await assert.rejects(f.selections.prepare(f.users.editor2,f.project,otherActor));
  const next=await f.capture('article.md','# Successor',f.version.versionId);
  await f.store.linkArticleVersion(f.geo.id,f.articleId,{version:next,expectedHeadVersionId:f.version.versionId,requestId:'advance'});
  const stale=f.request('stale-head');stale.evimedResultRevision={referenceId:staged.referenceId};
  await assert.rejects(f.selections.prepare(f.users.editor,f.project,stale),{code:'geo_article_head_changed'});
});

test('GEO staged selection cannot survive removal and re-adding the same member',options,async t=>{
  const f=await fixture(t);
  const staged=await f.articles.stageSelected(f.users.editor,f.geo.id,f.articleId,{versionId:f.version.versionId,digest:f.version.digest,requestId:'membership-epoch'},f.authority);
  await f.store.query('DELETE FROM evimed_geo.members WHERE geo_project_id=$1 AND user_id=$2',[f.geo.id,'editor']);
  await f.store.addMember({geoId:f.geo.id,userId:'editor',role:'editor',invitedBy:'owner'});
  const request=f.request('readded');request.evimedResultRevision={referenceId:staged.referenceId};
  await assert.rejects(f.selections.prepare(f.users.editor,f.project,request),{code:'geo_member_forbidden'});
});
