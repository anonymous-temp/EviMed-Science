import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountProjections } from '../src/memoryAccountProjections.mjs';
import { humanInputReceipt, inputDigest } from '../src/memoryHumanSegments.mjs';
import { clinicalSegmentDigest } from '../src/memoryClinicalSegments.mjs';
import { bindStatementSources } from '../src/memoryStatementSources.mjs';
import { instructionSourceMessage } from '../src/nativeMemoryInstructionOrigin.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { renderResidentProfile } from '../src/residentProfile.mjs';

const quote = '以后报告用表格。';
function fixture({ earlierPreferenceValues = async () => new Map(), messages = [], findings = [] } = {}) {
  const config={memoryAccountPresentationEnabled:true};
  const source = {id:'local-method',payload:{status:'approved',body:'Local statistical method with private project details.',
    contentDigest:inputDigest('method'),provenance:{scope:'statistical-analysis',sourceProjectId:'study',evidence:[{runId:'r', quote}]}}};
  const run={id:'r',sessionId:'original',kernelRequestIds:['input'],memoryInput:humanInputReceipt(quote)};
  const file={type:'preferences',uri:'viking://user/u/memories/preferences/self/tone.md',body:'以后语气正式一点。'};
  const records=[{uri:file.uri,id:'preference',status:'active',origin:'manual',value:file.body,contentHash:inputDigest(file.body),
    sourcePrivacy:{classification:'ordinary'},attribution:{origins:['manual']}}];
  const f={config, source, run, file, records, deleted:false, clinical:false, shared:false};
  const decisions=new Map(), origins=new Map(), external=new Map();
  const projection=createAccountProjections({config, verification:{readSources:async()=>messages}, native:{earlierPreferenceValues,files:async()=>[file],records:async()=>records},overlay:{commit:async()=>({extraction:{sourceVerification:{findings}}}),instructionCheck:async(_u,id)=>decisions.get(id),recordInstructionCheck:async(_u,id,verdict)=>decisions.set(id,verdict),files:async()=>new Map([[file.uri,file]]),originsOf:async()=>origins,externalSources:async()=>external},
    methods:{approvedMethods:async()=>[source]},provenance:{ordinaryDocument:async()=>!f.shared}, settings:{resetInstant:async()=>null},
    contexts:{forProject:async()=>({kind:f.shared?'geo-project':'owned',projectCreatedAt:'epoch'}),assertLive:async()=>{}},projectFor:async(userId,id)=>({id,userId}),
    projectRuns:async()=>[run],deleted:async()=>f.deleted,clinical:async(_u,_p,refs)=>f.clinical || refs.some(ref=>ref.sessionId==='sealed')});
  return {...f, control:f,projection,origins,external};
}

test('owned modules receive only standing original quotes from current preferences and methods', async()=>{
  const f=fixture(), original=structuredClone(f.source);
  for (const project of ['reports','analysis','frontier','deep-research']) {
    const memos=await f.projection.presentation('u',project,'session');
    assert.deepEqual(new Set(memos.map(row=>row.content)),new Set([quote,f.file.body]));
    assert.ok(memos.every(row=>row.applicationScope==='account-presentation'));
    const rendered=renderResidentProfile({presentation:memos});
    assert.match(rendered.standing,/以后报告用表格/);assert.doesNotMatch(rendered.text,/statistical method|private project/);
  }
  assert.deepEqual(f.source,original);
  f.source.payload.status='archived';assert.equal((await f.projection.presentation('u','report','s')).length,1);
  f.config.memoryAccountPresentationEnabled=false;assert.deepEqual(await f.projection.presentation('u','report','s'),[]);
});

test('missing or narrowed scope, sealed context, revoked sources and shared methods grant nothing',async()=>{
  const f=fixture(); f.records.length=0;
  const read=()=>f.projection.presentation('u','report','s');
  for (const text of ['本项目以后报告用表格。','以后默认随机效应。','照患者的表格。','I might prefer tables.']) {
    f.source.payload.provenance.evidence[0].quote=text;
    assert.deepEqual(await read(),[]);
  }
  f.source.payload.provenance.evidence[0].quote=quote;
  for(const key of ['clinical','deleted','shared']){f.control[key]=true;assert.deepEqual(await read(),[]);f.control[key]=false;}
  f.run.memoryInput=humanInputReceipt('本项目'+quote);assert.deepEqual(await read(),[]);
});

test('withdrawing one account projection leaves its local source intact and can be reversed',async()=>{
  const f=fixture(), original=structuredClone(f.source);
  const list=()=>f.projection.list('u'), read=()=>f.projection.presentation('u','analysis','s');
  const {id}= (await list()).find(row=>row.content===quote);
  assert.equal(await f.projection.setEnabled('u',id,false),true);
  assert.equal((await list()).find(row=>row.id===id).disabled,true);
  assert.deepEqual((await read()).map(row=>row.content),[f.file.body]);
  assert.deepEqual(f.source,original);
  assert.equal(await f.projection.setEnabled('u',id,true),true);
  assert.ok((await read()).some(row=>row.id===id));
  assert.equal(await f.projection.setEnabled('u','unknown',false),false);
});

test('a sealed source can contribute only its separately attested standing quote',async()=>{
  const f=fixture(), projectId='study', sessionId='sealed', inputSeq=6, epoch='epoch';
  f.source.payload.status='retired';
  f.file.body=quote+' (as of 2026-11-01)'; f.records[0].value=f.file.body; f.records[0].origin='engine';
  f.run.sessionId=sessionId;
  f.run.memoryInput=humanInputReceipt('> SEALED-MATERIAL\n\n'+quote);
  const ref={operation:'clinical-segment',sessionId,runId:f.run.id,inputSeq,inputDigest:f.run.memoryInput.digest,projectCreatedAt:epoch,saidAt:f.run.memoryInput.at};
  const digest=clinicalSegmentDigest('u',projectId,ref,quote);
  const archiveUri='archive';
  f.origins.set(f.file.uri,new Map([[lineFingerprint(f.file.body),{archiveUri,engineSession:'evimed-segment-'+digest,projectId,projectCreatedAt:epoch}]]));
  f.external.set(archiveUri,{...ref,digest});
  f.config.memoryClinicalSegmentsEnabled=true;
  const read=()=>f.projection.presentation('u','analysis','destination');
  assert.deepEqual((await read()).map(m=>m.content),[quote]);assert.doesNotMatch(JSON.stringify(await read()),/SEALED-MATERIAL/);
  f.external.get(archiveUri).inputSeq++;
  assert.deepEqual(await read(),[]);
});

test('the account route changes only projections owned by the authenticated reader',async()=>{
  const {createMemoryRoutes}=await import('../src/memoryRoutes.mjs');
  const {Readable}=await import('node:stream');
  const f=fixture(), id=(await f.projection.list('u'))[0].id;
  const handler=createMemoryRoutes({config:{memoryAccountPresentationEnabled:true,maxJsonBytes:4096},
    accountProjections:f.projection,context:async()=>({user:{id:'u'}})});
  async function request(method,url,body) {
    const req=Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req,{method,url,headers:{}});
    let response;
    const res={writeHead:()=>{},end:bytes=>{response=JSON.parse(bytes);}};
    await handler(req,res);
    return response.data;
  }
  assert.equal((await request('GET','/api/memory/account-presentation')).length,2);
  const url='/api/memory/account-presentation/'+id;
  assert.deepEqual(await request('PUT',url,{enabled:false}),{id,enabled:false});
  assert.ok(!(await f.projection.presentation('u','other','s')).some(memo=>memo.id===id));
  await assert.rejects(request('PUT',url,{enabled:'false'}),{code:'memory_settings_invalid'});
});

test('account projections retain the statement source and exclude material and incomplete conditions', async () => {
  const f = fixture();
  f.source.payload.status = 'archived';
  const accepted = { kind:'user_edit', speaker:'user', subject:'self', conditions:'preserved' };
  f.records[0].statementSources = [{ text:f.file.body, source:accepted }];
  const read = () => f.projection.presentation('u','report','s');
  const presentation = await read();
  assert.deepEqual(presentation[0].statementSources, f.records[0].statementSources);
  const config = { memorySourceEnvelopeEnabled:true, memorySafetyNotesEnabled:true, memoryStandingInstructionsEnabled:true };
  const nativeFiles = [{ uri:'viking://user/u/memories/preferences/self/layout.md', body:'Keep units with their values.' }];
  const safetyFiles = [{ uri:'viking://user/u/memories/safety_notes/history.md', type:'safety_notes', body:'A past reaction.' }];
  const baseline = renderResidentProfile({ config, nativeFiles, safetyFiles, maxTokens:0 });
  assert.match(baseline.standing, /Keep units/);
  assert.match(baseline.safety, /A past reaction/);
  assert.deepEqual(renderResidentProfile({ presentation, config, nativeFiles, safetyFiles, maxTokens:0 }), baseline);
  const full = renderResidentProfile({ presentation, config, nativeFiles, safetyFiles });
  assert.match(full.standing, /<statement-source.*user_edit/);
  assert.equal(full.safety, baseline.safety);
  for (const patch of [{ kind:'pasted_material' }, { speaker:'assistant' }, { subject:'other' }, { conditions:'missing' }]) {
    f.records[0].statementSources[0].source = { ...accepted, ...patch };
    assert.deepEqual(await read(), []);
  }
  f.records.length = 0;
  f.source.payload.status = 'approved';
  f.run.memoryInput = humanInputReceipt(quote, Date.now(), [{ start:0, end:quote.length }]);
  assert.deepEqual(await read(), []);
});

test('account presentation omits an earlier personal choice while leaving its local record and other projections available', async () => {
  let compared = 0;
  const f = fixture({ earlierPreferenceValues: async userId => {
    assert.equal(userId, 'u');
    compared++;
    return new Map([[f.file.uri, [f.file.body]]]);
  } });
  const read = () => f.projection.presentation('u', 'analysis', 'session');
  assert.equal((await read()).length, 2);
  assert.equal(compared, 0);
  f.config.memoryPreferenceReconcileEnabled = true;
  assert.deepEqual((await read()).map(row => row.content), [quote]);
  assert.equal(compared, 1);
  assert.equal(f.records[0].value, f.file.body);
});

const originalOrder = '以后报告先给结论再给依据。';
const storedOrder = '报告一律先给结论，再给依据。';
function extracted({ message = originalOrder, role = 'user', stored = storedOrder, source = {}, findings = [], wrt = false } = {}) {
  const messages = [instructionSourceMessage({ role, content: message })];
  const f = fixture({ messages, findings });
  f.config.memoryCommitVerificationEnabled = wrt;
  f.source.payload.status = 'archived';
  f.file.body = '- ' + stored;
  Object.assign(f.records[0], { origin: 'engine', value: f.file.body, contentHash: inputDigest(f.file.body) });
  f.run.memoryInput = humanInputReceipt(message);
  const review = { line: 0, kind: 'user_statement', subject: 'self', message: 0, quote: message,
    conditions: 'preserved', presentationMatch: true, ...source };
  const receipt = bindStatementSources(JSON.stringify({ rows: [review] }), [{text: stored}], messages).get(0);
  const engineSession = 'dsh-' + f.run.sessionId;
  const ref = { engineSession, projectId: 'study', projectCreatedAt: 'epoch',
    archiveUri: 'viking://user/u/sessions/' + engineSession + '/history/archive_001', ...(wrt ? {} : {statementSource: receipt}) };
  f.origins.set(f.file.uri, new Map([[lineFingerprint(stored), ref]]));
  const read = (project = 'reports') => f.projection.presentation('u', project, 'destination');
  return { ...f, messages, ref, read };
}

test('a reviewed paraphrase carries only the original standing request across four modules until withdrawn', async () => {
  const f = extracted();
  const id = 'presentation:' + inputDigest(originalOrder);
  const modules = ['reports', 'analysis', 'frontier', 'deep-research'];
  for (const project of modules) {
    const [memo] = await f.read(project);
    assert.equal(memo.id, id);
    assert.equal(memo.content, originalOrder);
    assert.equal(memo.statementSources[0].text, originalOrder);
    assert.match(renderResidentProfile({ presentation:[memo] }).standing, /以后报告先给结论再给依据/);
  }
  assert.ok(await f.projection.setEnabled('u', id, false));
  assert.deepEqual(await f.read(), []);
  assert.ok(await f.projection.setEnabled('u', id, true));
  assert.equal((await f.read())[0].content, originalOrder);
  f.records[0].status = 'archived';
  for (const project of modules) assert.deepEqual(await f.read(project), []);
});

test('paraphrase projection refuses extra content, ambiguous authorship, qualified requests and stale receipts', async () => {
  for (const input of [
    { role:'assistant', source:{kind:'assistant_statement'} }, {source:{kind:'pasted_material'}},
    { source:{subject:'unknown'} }, { source:{conditions:'unknown'} },
    { message:'本项目' + originalOrder, source:{quote:originalOrder} },
    { message:'说简短点。' }, {stored:storedOrder + '每次附上病例。', source:{presentationMatch:false}},
  ]) assert.deepEqual(await extracted(input).read(), []);
  const f = extracted();
  f.run.memoryInput = humanInputReceipt(originalOrder, Date.now(), [{start:0, end:originalOrder.length}]);
  assert.deepEqual(await f.read(), []);
  f.run.memoryInput = humanInputReceipt(originalOrder);
  f.control.deleted = true;
  assert.deepEqual(await f.read(), []);
  f.control.deleted = false;
  f.messages[0] = instructionSourceMessage({role:'user', content:quote});
  assert.deepEqual(await f.read(), []);
  const stale = extracted();
  stale.ref.statementSource.lineDigest = inputDigest('another memory line');
  assert.deepEqual(await stale.read(), []);
});

test('a single-source clause review can bind the line independently and an adverse finding vetoes it', async () => {
  const findings = [];
  const f = extracted({ findings, wrt:true });
  const finding = { uri:f.file.uri, status:'supported', fingerprint:lineFingerprint(storedOrder),
    presentation:{message:0, digest:inputDigest(originalOrder), lineDigest:inputDigest(storedOrder)} };
  assert.deepEqual(await f.read(), []);
  findings.push(finding);
  assert.equal((await f.read())[0].content, originalOrder);
  f.ref.statementSource = extracted({source:{presentationMatch:false}}).ref.statementSource;
  assert.deepEqual(await f.read(), []);
  findings[0] = {...finding, status:'unsupported', presentation:undefined};
  f.ref.statementSource = extracted().ref.statementSource;
  assert.deepEqual(await f.read(), []);
});

test('a paraphrased clinical excerpt must still match its isolated admission and current run', async () => {
  const f = extracted();
  f.config.memoryClinicalSegmentsEnabled = true;
  f.run.sessionId = 'sealed';
  f.run.memoryInput = humanInputReceipt('> SEALED CASE\n\n' + originalOrder);
  const source = { operation:'clinical-segment', sessionId:'sealed', runId:f.run.id, inputSeq:3,
    inputDigest:f.run.memoryInput.digest, projectCreatedAt:'epoch', saidAt:f.run.memoryInput.at };
  const digest = clinicalSegmentDigest('u', f.ref.projectId, source, originalOrder);
  f.ref.engineSession = 'evimed-segment-' + digest;
  f.ref.archiveUri = 'viking://user/u/sessions/' + f.ref.engineSession + '/history/archive_001';
  f.external.set(f.ref.archiveUri, {...source, digest});
  assert.equal((await f.read())[0].content, originalOrder);
  assert.doesNotMatch(JSON.stringify(await f.read()), /SEALED CASE/);
  f.external.get(f.ref.archiveUri).inputSeq++;
  assert.deepEqual(await f.read(), []);
});

test('a historical clause verdict needs the matching full SRC quotation to recover a paraphrase', async () => {
  const findings = [];
  const f = extracted({findings, wrt:true});
  f.ref.statementSource = extracted().ref.statementSource;
  delete f.ref.statementSource.source.locator.presentation;
  findings.push({uri:f.file.uri, status:'supported', fingerprint:lineFingerprint(storedOrder)});
  assert.equal((await f.read())[0].content, originalOrder);
  f.ref.statementSource.source.locator.quoteLength--;
  assert.deepEqual(await f.read(), []);
});
