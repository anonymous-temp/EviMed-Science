import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEvaluationIsolation} from '../src/evaluationIsolation.mjs';
import {paperGoldSourceResponses,paperGoldTraceCoverage,readPaperGoldNativeCoverage,paperGoldExposureTier} from '../src/paperGoldEvaluator.mjs';
test('requested and self-emitted DOI before failed or blocked retrieval is not observed exposure',()=>{
 const trace=paperGoldSourceResponses({messages:[{role:'assistant',parts:[{type:'text',text:'10.1136/bmj.n71'}]},{role:'user',parts:[{type:'text',text:'10.1136/bmj.n71'}]},{parts:[{type:'tool',tool:'web_read',status:'completed',input:{doi:'10.1136/bmj.n71'},output:'Error: HTTP 502'}]},{parts:[{type:'tool',tool:'web_read',status:'completed',output:{status:'error',data:{doi:'10.1136/bmj.n71',code:'evaluation_source_excluded'}}}]}]});
 assert.deepEqual(trace.responses,[]);assert.equal(trace.complete,true);
});
test('actual PRISMA target body in successful MCP and socket envelopes is preserved for exposure audit',()=>{
 for(const output of [{status:'ok',data:{doi:'10.1136/bmj.n71',body:'PRISMA 2020 systematic reviews introduction methods discussion'}},'ok\n'+JSON.stringify({doi:'10.1136/bmj.n71',body:'PRISMA 2020 systematic reviews'})]){
  const trace=paperGoldSourceResponses({messages:[{parts:[{type:'tool',tool:'web_read',status:'completed',output}]}]});assert.equal(trace.complete,true);assert.equal(trace.responses.length,1);assert.equal(trace.responses[0].data.doi,'10.1136/bmj.n71');
 }
});
test('unparseable or unfinished source responses cannot prove complete trace',()=>{
 for(const part of [{type:'tool',tool:'web_read',status:'completed',output:'unparseable'},{type:'tool',tool:'web_search',status:'pending'}])assert.equal(paperGoldSourceResponses({messages:[{parts:[part]}]}).complete,false);
});

test('successful unknown envelope cannot silently lose a target body or prove unexposed',()=>{
 for(const output of [{ok:true,text:'10.1136/bmj.n71 PRISMA target body'},{ok:true,result:{doi:'10.1136/bmj.n71'}},{status:'ok',results:[{doi:'10.1136/bmj.n71'}]},{ok:true}]){
  const trace=paperGoldSourceResponses({messages:[{parts:[{type:'tool',tool:'web_read',status:'completed',output}]}]});assert.equal(trace.complete,false);assert.equal(trace.responses.length,0);
 }
});
test('native socket plain returned body and nested MCP JSON remain observable',()=>{
 for(const output of ['ok\n10.1136/bmj.n71 PRISMA returned primary body',{content:[{type:'text',text:JSON.stringify({status:'ok',data:{doi:'10.1136/bmj.n71',body:'PRISMA returned primary body'}})}]}]){
  const trace=paperGoldSourceResponses({messages:[{parts:[{type:'tool',tool:'web_read',status:'completed',output}]}]});assert.equal(trace.complete,true);assert.match(JSON.stringify(trace.responses),/10.1136\/bmj.n71/);
 }
});

test('native arbitrary execution without independently proven network fence is unknown',()=>{
 assert.equal(paperGoldTraceCoverage({messages:[{parts:[{type:'tool',tool:'bash',status:'completed',output:'done'}]}]}).complete,false);
});

test('trusted verifier binds current producer; forged transcript proof or rejected stale/different run never covers native tools',async()=>{
 const transcript={nativeCoverageVerified:true,proofHash:'a'.repeat(64),messages:[{parts:[{type:'tool',tool:'bash',status:'completed'}]}]};
 assert.equal(paperGoldTraceCoverage(transcript).complete,false);
 const project={id:'actual-project'},run={id:'actual-run'};
 for(const reason of ['run_identity_changed','start_after_prompt','runtime_generation_changed']){
  const proof=await readPaperGoldNativeCoverage({project,run,runtimeManager:{verifyRunEgressCoverage:async request=>{assert.equal(request.project,project);assert.equal(request.run,run);return {nativeCoverageVerified:false,proofHash:'a'.repeat(64),startProofHash:'b'.repeat(64),endProofHash:'c'.repeat(64),reason};}}});assert.equal(paperGoldTraceCoverage(transcript,proof).complete,false);
 }
 const valid={nativeCoverageVerified:true,proofHash:'a'.repeat(64),startProofHash:'b'.repeat(64),endProofHash:'c'.repeat(64)};
 assert.equal(paperGoldTraceCoverage(transcript,valid).complete,true);
 assert.equal(paperGoldTraceCoverage(transcript,{...valid,startProofHash:null}).complete,false);
 assert.equal(paperGoldTraceCoverage({messages:[{parts:[{type:'tool',tool:'meta_analysis',input:{action:'start'}}]}]},valid).complete,false);
});
test('observed target exposure takes precedence while incomplete coverage never proves unexposed',()=>{
 for(const tier of ['cited','exposed_uncited'])assert.equal(paperGoldExposureTier({audit:{tier},durableComplete:false,traceCoverage:{complete:false},sourceTrace:{complete:false}}),tier);
 assert.equal(paperGoldExposureTier({audit:{tier:'unexposed'},durableComplete:true,traceCoverage:{complete:false},sourceTrace:{complete:true}}),'unknown');
});

// Release 6, 2026-10-06: all six producer runs called cite_lookup, 19 successful results were unparsed, and the four units with no
// observed exposure read unknown for that reason alone. A native tool's result is the text its renderer produced: this is the
// output of dsh-cite@0.3.2's own `cite_lookup` renderer for two works (one with no year, one with only a publisher), written out
// verbatim so the reader is tested against what the tool emits and not against a shape this repository imagined.
const CITE_LOOKUP_TEXT = '1. Random-effects meta-analysis of binary outcomes（2001, Statistics in Medicine）\n2. A handbook of study design（Example Press）';
const citeLookup = output => ({ messages: [{ parts: [{ type: 'tool', tool: 'cite_lookup', status: 'completed', input: { doi: '10.1000/xyz' }, output }] }] });
test('a successful cite_lookup result is read back to the works it lists, so its trace is complete and its text is auditable', () => {
 for (const output of [CITE_LOOKUP_TEXT, `${CITE_LOOKUP_TEXT}\n`, [{ type: 'text', text: CITE_LOOKUP_TEXT }], { content: [{ type: 'text', text: CITE_LOOKUP_TEXT }] }]) {
  const trace = paperGoldSourceResponses(citeLookup(output));
  assert.equal(trace.complete, true);
  assert.deepEqual(trace.unknownTools, []);
  assert.equal(trace.responses.length, 1);
  assert.deepEqual(trace.responses[0].data.works, ['Random-effects meta-analysis of binary outcomes（2001, Statistics in Medicine）', 'A handbook of study design（Example Press）']);
 }
 // The tool is named in the history by its namespaced forms too.
 for (const tool of ['cite_lookup', 'mcp__cite__cite_lookup', 'dsh-cite.cite_lookup']) {
  assert.equal(paperGoldSourceResponses({ messages: [{ parts: [{ type: 'tool', tool, status: 'completed', output: CITE_LOOKUP_TEXT }] }] }).complete, true, tool);
 }
});
test('a cite_lookup result that is not exactly what its renderer emits stays unparsed, and an unparsed result is unknown, never unexposed', () => {
 for (const output of ['', '   ', 'no results', '2. Starts at two（2001, Journal）', '1. Cut off before the closing parenthesis（2001, Statis', '1. A（2001, B）\n3. Skips two（2002, C）\nstill A', { works: [{ title: 'x' }] }, 42]) {
  const trace = paperGoldSourceResponses(citeLookup(output));
  assert.equal(trace.complete, false, JSON.stringify(output));
  assert.deepEqual(trace.unknownTools, ['cite_lookup']);
  assert.equal(trace.responses.length, 0);
 }
 // The same lines from another tool are not read as a cite_lookup result: the reader is per tool, not a guess about text.
 assert.equal(paperGoldSourceResponses({ messages: [{ parts: [{ type: 'tool', tool: 'web_read', status: 'completed', output: CITE_LOOKUP_TEXT }] }] }).complete, false);
 // A failed lookup is still no response and no unknown.
 for (const part of [{ status: 'error', output: 'Error: Crossref returned 404' }, { status: 'completed', output: 'Error: Crossref returned 404' }]) {
  const trace = paperGoldSourceResponses({ messages: [{ parts: [{ type: 'tool', tool: 'cite_lookup', ...part }] }] });
  assert.deepEqual([trace.complete, trace.responses.length], [true, 0]);
 }
});
test('the cite_lookup fixture is what the pinned dsh-cite renderer emits, when the package is installed', async t => {
 let renderer;
 try {
  const resolved = createRequire(new URL('../../../packages/socket/package.json', import.meta.url)).resolve('dsh-cite');
  renderer = await import(pathToFileURL(resolved).href);
 } catch { t.skip('dsh-cite is not installed in this checkout'); return; }
 const tool = renderer.buildCiteTools(renderer.resolveConfig({})).find(row => row.name === 'cite_lookup');
 const works = [{ title: 'Random-effects meta-analysis of binary outcomes', year: 2001, containerTitle: 'Statistics in Medicine', publisher: '' }, { title: 'A handbook of study design', year: 0, containerTitle: '', publisher: 'Example Press' }];
 const [part] = tool.output.render({}, { count: 2, works });
 assert.equal(part.text, CITE_LOOKUP_TEXT);
 assert.equal(paperGoldSourceResponses(citeLookup(part.text)).complete, true);
});

// Release 6, run c8df70fe: it searched Europe PMC with the protected DOI as its query. The request was served; four items came back, none of
// them the paper; the tool result echoed the query under data.provenance.arguments.query, and that echo was the only match.
const ECHO_POLICY = { aliases: ['10.1136/bmj.315.7114.980', 'PMID:9365295', 'PMC2127653'], titles: ['The accumulated evidence on lung cancer and environmental tobacco smoke.'] };
const sourceSearch = (data, input = { source: 'europe-pmc', query: '10.1136/bmj.315.7114.980', limit: 5 }) => ({ type: 'tool', tool: 'mcp__evimed__biomedical_source_search', status: 'completed', input,
  output: JSON.stringify({ status: 'ok', data: { source: 'europe-pmc', ...data, provenance: { tool: 'biomedical_source_search', arguments: input, scope: { tenantId: 'u', userId: 'u', projectId: 'eval-paper-x', workspaceDir: '/workspace' } } } }) });
test('the echo of the run\'s own request is not served content, and served content that names the protected paper still is', async () => {
 const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-'));
 try {
  const isolation = createEvaluationIsolation({ dataDir });
  await isolation.register('run', ECHO_POLICY);
  const items = [{ id: 'PMID:1', title: 'Another passive smoking study' }, { id: 'PMID:2', title: 'Cohort of non-smoking wives' }];
  const audit = async part => {
   const trace = paperGoldSourceResponses({ messages: [{ parts: [part] }] });
   assert.equal(trace.complete, true);
   for (const response of trace.responses) await isolation.auditExposure({ runId: 'run' }, 'transcript-source-response', response);
   return { trace, tier: (await isolation.audit('run')).tier };
  };
  const echoOnly = await audit(sourceSearch({ items }));
  assert.equal(echoOnly.trace.responses.length, 1);
  assert.equal('arguments' in echoOnly.trace.responses[0].data.provenance, false, 'the echo is left out');
  assert.deepEqual(echoOnly.trace.responses[0].data.items, items, 'everything else of the response is kept');
  assert.equal(echoOnly.trace.responses[0].data.provenance.tool, 'biomedical_source_search');
  assert.equal(echoOnly.tier, 'unexposed');
  // A response that serves the paper (here: an item whose DOI is the protected one) is exposure, with or without the echo.
  const served = await audit(sourceSearch({ items: [...items, { id: 'PMID:9365295', doi: '10.1136/bmj.315.7114.980', title: 'x' }] }, { source: 'europe-pmc', query: 'passive smoking lung cancer', limit: 5 }));
  assert.equal(served.tier, 'exposed_uncited');
  // The echo is only dropped from a result that has one; other shapes are returned untouched.
  assert.deepEqual(paperGoldSourceResponses({ messages: [{ parts: [{ type: 'tool', tool: 'web_read', status: 'completed', output: { status: 'ok', data: { provenance: 'text', body: 'b' } } }] }] }).responses[0].data, { provenance: 'text', body: 'b' });
 } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
