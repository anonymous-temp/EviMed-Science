// Real product transport only. Deployment-owned fixture bindings supply accounts and source identities.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Api, digestTranscript } from '../general-tasks/runner/cell.mjs';
import { validateBenchmark } from './scorer.mjs';
import { collectRetrieval } from './evidence.mjs';
import { verifyLiveBudgetWiring,armSharedBudget,verifyBoundCollector } from './shared_budget.mjs';
import { readTranscript } from './native_probe.mjs';
import { memoryHash,collectIndependentCells,fatalCollectionError,cancelAndConfirmTerminal } from './protocol.mjs';
import { contextId } from './coverage.mjs';
import {selectedArms,experimentIdentity,openExecution,beginArm,sealArm,saveExecution,assertActiveRuntime} from './arm_execution.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
export async function verifyCorpus(b) {
  validateBenchmark(b);
  for (const source of b.sources) if (sha(await fs.readFile(path.join(root, source.path))) !== source.sha256) throw new Error(`Frozen corpus changed: ${source.id}`);
}
export async function preflight(bindings,{activeArms=['baseline','candidate']}={}) {
  const missing = [];
  for (const arm of ['baseline', 'candidate']) {
    const binding = bindings?.[arm];
    if (!binding?.base) { missing.push(`${arm}: product base URL and fixture bindings missing`); continue; }
    try {
      const bound = await verifyBoundCollector(binding.base,arm,bindings.sharedBudget);
      binding.listenerProof=bound.binding;binding.sharedBudget=bindings.sharedBudget;
      const active=activeArms.includes(arm);
      const response = await fetch(`${binding.base}${active?'/api/ready':'/api/health'}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) missing.push(`${arm}: ${active?'runtime readiness':'instrumented web health'} HTTP ${response.status}`);
      if(active)binding.actualRuntimeProof=assertActiveRuntime(binding);
    } catch (e) { missing.push(`${arm}: product readiness unavailable (${e.cause?.code ?? e.name})`); }
    if (!binding.runtimeEvidence?.dshVersion || !binding.runtimeEvidence?.openVikingVersion || !binding.runtimeEvidence?.model || !binding.runtimeEvidence?.revision) missing.push(`${arm}: engine/model/revision identity receipt missing`);
    if (!bindings.sharedBudget?.sharedBudgetId || binding.sharedBudgetId !== bindings.sharedBudget.sharedBudgetId) missing.push(`${arm}: same live aggregate budget identity missing`);
  }
  try { await verifyLiveBudgetWiring(bindings.sharedBudget); } catch(error) { missing.push(error.message); }
  return missing;
}
async function call(api, method, route, body) {
  const response = await api.call(method, route, body);
  if (response.status >= 400) throw new Error(`Product ${method} ${route}: HTTP ${response.status}`);
  return response.json?.data;
}
async function execute(c, binding, repetition, arm, out) {
  const partial={caseId:c.id,arm,repetition,prompt:c.prompt,status:'inconclusive'};
  try {
  binding.listenerProof=(await verifyBoundCollector(binding.base,arm,binding.sharedBudget)).binding;
  assertActiveRuntime(binding);
  const projectScope = binding.accounts[c.actor]?.projects[c.project];
  const scope = c.evaluation && projectScope?.contexts ? projectScope.contexts[contextId(c.evaluation)] : projectScope;
  if (!scope) throw new Error(`Missing real fixture scope ${arm}/${c.actor}/${c.project}`);
  const api = new Api(binding.base);
  const credentials = JSON.parse(await fs.readFile(scope.credentialsFile??binding.accounts[c.actor].credentialsFile, 'utf8'));
  // Session cookies remain in memory and are never written to results.
  api.cookie = credentials.cookie; api.csrf = credentials.csrf; api.project = scope.id;
  const me = await call(api, 'GET', '/api/me');
  if ((me.user?.id ?? me.id) !== (scope.userId??binding.accounts[c.actor].userId)) throw new Error('Live authenticated identity mismatch');
  const sourceMap = scope.sourceMap ?? {};
  const sessionId = `knowledge_eval_${c.id.replaceAll('-', '_')}_${repetition}_${Date.now()}`;
  await call(api, 'PUT', `/api/research-sessions/${sessionId}`, { mode: 'open-domain' });
  const actions = [];
  if(scope.memoryFreeze){
    const settings=await call(api,'GET','/api/memory/settings');
    const profile=await call(api,'GET','/api/memory/profile');
    if(settings.learningPaused!==true||settings.recallPaused!==false||profile.pending?.length||memoryHash(profile)!==scope.memoryFreeze.hash)throw new Error('Frozen memory identity changed before question');
  }
  const memoryInventoryBefore = c.evaluation?.substrate !== 'knowledge' ? await call(api,'GET','/api/memory/records?pageSize=100') : null;
  binding.listenerProof=(await verifyBoundCollector(binding.base,arm,binding.sharedBudget)).binding;
  const dispatched = await api.call('POST', '/api/agent-runs/dispatch', { sessionId, dispatchId: sessionId, automated:true, text: c.prompt });
  if (dispatched.status !== 202) throw new Error(`Dispatch HTTP ${dispatched.status}`);
  let run = dispatched.json.data;partial.run=run;
  const deadline = Date.now() + 180_000;
  while (['queued','running','planned','dispatching','starting','waiting'].includes(run.status)) {
    if (Date.now() >= deadline) { partial.cancellation=await cancelAndConfirmTerminal(api,run); throw new Error('Real DSH run timed out'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
    const runs = await call(api, 'GET', '/api/agent-runs');
    run = (Array.isArray(runs) ? runs : runs.items ?? runs.runs ?? []).find(r => r.id === run.id) ?? run;partial.run=run;
  }
  const transcript = await readTranscript(scope,run.id);
  const transcriptLines = transcript.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const digest = digestTranscript(transcriptLines);
  const retrieval = collectRetrieval(transcriptLines);
  partial.run=run;
  const filename = `${arm}-${c.id}-${repetition}.json`;
  const evidence = { caseId: c.id, prompt: c.prompt, actor: c.actor, project: c.project, arm, repetition, run, digest, retrieval, actions, sourceMap,collectorBinding:binding.listenerProof,memoryInventoryBefore,actualUserId:scope.userId??binding.accounts[c.actor].userId, originalFiles:scope.originalFiles??{},originalTexts:scope.originalTexts??{},memoryFreeze:scope.memoryFreeze??null,evaluation:c.evaluation,documentCount:scope.documentCount,runtime: binding.runtimeEvidence, transcriptSha256: sha(transcript) };
  if(scope.memoryFreeze){const after=await call(api,'GET','/api/memory/profile');evidence.memoryAfterHash=memoryHash(after);evidence.memoryVerified=!after.pending?.length&&evidence.memoryAfterHash===scope.memoryFreeze.hash;}
  await fs.writeFile(path.join(out, filename), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(out, `${filename}.transcript.jsonl`), transcript);
  if(scope.memoryFreeze&&!evidence.memoryVerified)throw new Error('Frozen memory identity changed after question');
  if(run.status!=='succeeded')throw new Error(`Real product run ended ${run.status}`);
  return evidence;
  } catch(error) {
    const file=`${arm}-${c.id}-${repetition}.failure.json`;await fs.writeFile(path.join(out,file),JSON.stringify({...partial,reason:error.message,cancellation:error.cancellationEvidence??partial.cancellation??null,fatal:fatalCollectionError(error)},null,2));error.partialFile=file;throw error;
  }
}
export async function main() {
  const b = JSON.parse(await fs.readFile(path.join(root, 'cases.json'), 'utf8'));
  await verifyCorpus(b);
  const out = process.env.KNOWLEDGE_EVAL_OUT ?? path.join(root, 'results', new Date().toISOString().replaceAll(':','-'));
  await fs.mkdir(out, { recursive: true });
  const bindings = process.env.KNOWLEDGE_EVAL_BINDINGS ? JSON.parse(await fs.readFile(process.env.KNOWLEDGE_EVAL_BINDINGS, 'utf8')) : {};
  const arms=selectedArms(process.argv);
  const missing = await preflight(bindings,{activeArms:arms});
  const protocol = { benchmarkSha256: sha(JSON.stringify(b)), budgetCny: 50, expectedCells: 540, lifecycleDenominator: 30, independentUnit: 'question', ci: 'paired percentile bootstrap, 10000 draws, 95%', noninferiority: 'general and medical independently: lower CI > -0.02; otherwise inconclusive', missing, status: missing.length ? 'blocked' : 'ready',activeArms:arms,inactiveArms:['baseline','candidate'].filter(a=>!arms.includes(a)),spendCny:0 };
  // Preflight never overwrites a prior arm's durable execution or measured evidence.
  await fs.writeFile(path.join(out, 'preflight.json'), JSON.stringify(protocol, null, 2));
  if (missing.length) { console.log(JSON.stringify(protocol)); return; }
  // Scoring is a separate explicit review stage; raw runs never imply quality pass.
  if (!process.argv.includes('--execute')) { console.log('Preflight ready. Use --execute to collect real runs.'); return; }
  delete protocol.spendCny;
  const execution=await openExecution(out,experimentIdentity(bindings,protocol.benchmarkSha256),protocol);
  // Safety checks precede fixtures/model dispatch even when resuming the candidate after baseline.
  // Both instrumented web listeners and native engine remain mandatory under the same coordinator.
  const { provision, runLifecycle } = await import('./provision.mjs');
  const os = await import('node:os');
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-eval-private-'));
  for(const arm of arms){
   let ctx=null;
   try {
      await beginArm(out,execution,arm);
      await armSharedBudget(bindings.sharedBudget);
      if (!bindings[arm].dataDir) throw new Error(`${arm}: isolated product dataDir is required for automatic fixture setup`);
      bindings[arm].listenerProof=(await verifyBoundCollector(bindings[arm].base,arm,bindings.sharedBudget)).binding;
      ctx = await provision({base:bindings[arm].base,dataDir:bindings[arm].dataDir,privateDir:path.join(privateDir,arm),benchmark:b,arm,coverage:true,sharedBudget:bindings.sharedBudget,runtimeMode:'kernel',runtimeEvidence:bindings[arm].runtimeEvidence,databaseBindingsFile:bindings[arm].databaseBindingsFile});
      ctx.evidenceDir=path.join(out,arm,'lifecycle-native');
      bindings[arm].accounts = ctx.bindings.accounts;
      for (const repetition of [1,2,3]) {
        const lifecycle = await runLifecycle(b,ctx);
        await fs.writeFile(path.join(out,`${arm}-lifecycle-${repetition}.json`),JSON.stringify(lifecycle,null,2));
      }
      const cells=b.cases.filter(c=>c.stratum!=='lifecycle').flatMap(c=>[1,2,3].map(repetition=>({caseId:c.id,arm,repetition})));
      const outcomes=await collectIndependentCells(cells,cell=>execute(b.cases.find(c=>c.id===cell.caseId),bindings[arm],cell.repetition,arm,out),row=>fs.appendFile(path.join(out,`${arm}-cell-outcomes.jsonl`),JSON.stringify(row)+'\n'));
      const inconclusiveCells=outcomes.filter(r=>r.status==='inconclusive').length;
      const {reviewDirectory}=await import('./automatic_judge.mjs');
      const review=await reviewDirectory(out,{benchmark:b,sharedBudget:bindings.sharedBudget});
      const reviewed=(await fs.readFile(path.join(out,'reviewed-observations.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.arm===arm);
      await fs.writeFile(path.join(out,`${arm}-reviewed-observations.jsonl`),reviewed.map(r=>JSON.stringify(r)).join('\n')+'\n');
      bindings[arm].listenerProof=(await verifyBoundCollector(bindings[arm].base,arm,bindings.sharedBudget)).binding;
      await sealArm(out,execution,arm,assertActiveRuntime(bindings[arm]),{inconclusiveCells,review,budget:await verifyLiveBudgetWiring(bindings.sharedBudget)});
   }catch(error){
      if(execution.arms[arm].status==='collecting'){
       execution.arms[arm]={...execution.arms[arm],status:fatalCollectionError(error)?'stopped-safety':'inconclusive',error:error.message};
       execution.status=fatalCollectionError(error)?'stopped-safety':'inconclusive';execution.error=error.message;await saveExecution(out,execution);
      }
      throw error;
   }finally{
      if(ctx)await ctx.cleanup();
      await fs.rm(path.join(privateDir,arm),{recursive:true,force:true});
   }
  }
  await fs.rm(privateDir,{recursive:true,force:true});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
