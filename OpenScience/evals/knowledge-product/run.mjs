// Real product transport only. Deployment-owned fixture bindings supply accounts and source identities.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Api, digestTranscript } from '../general-tasks/runner/cell.mjs';
import { validateBenchmark } from './scorer.mjs';
import { collectRetrieval } from './evidence.mjs';
import { verifyLiveBudgetWiring,armSharedBudget,verifyBoundCollector } from './shared_budget.mjs';
import { contextId } from './coverage.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
export async function verifyCorpus(b) {
  validateBenchmark(b);
  for (const source of b.sources) if (sha(await fs.readFile(path.join(root, source.path))) !== source.sha256) throw new Error(`Frozen corpus changed: ${source.id}`);
}
export async function preflight(bindings) {
  const missing = [];
  for (const arm of ['baseline', 'candidate']) {
    const binding = bindings?.[arm];
    if (!binding?.base) { missing.push(`${arm}: product base URL and fixture bindings missing`); continue; }
    try {
      const bound = await verifyBoundCollector(binding.base,arm,bindings.sharedBudget);
      binding.listenerProof=bound.binding;binding.sharedBudget=bindings.sharedBudget;
      const response = await fetch(`${binding.base}/api/ready`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) missing.push(`${arm}: readiness HTTP ${response.status}`);
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
  binding.listenerProof=(await verifyBoundCollector(binding.base,arm,binding.sharedBudget)).binding;
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
  const memoryInventoryBefore = c.evaluation?.substrate !== 'knowledge' ? await call(api,'GET','/api/memory/records?pageSize=100') : null;
  binding.listenerProof=(await verifyBoundCollector(binding.base,arm,binding.sharedBudget)).binding;
  const dispatched = await api.call('POST', '/api/agent-runs/dispatch', { sessionId, dispatchId: sessionId, text: c.prompt });
  if (dispatched.status !== 202) throw new Error(`Dispatch HTTP ${dispatched.status}`);
  let run = dispatched.json.data;
  const deadline = Date.now() + 180_000;
  while (['queued','running','planned','dispatching','starting','waiting'].includes(run.status)) {
    if (Date.now() >= deadline) { await api.call('POST', `/api/agent-runs/${run.id}/cancel`, {}); throw new Error('Real DSH run timed out'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
    const runs = await call(api, 'GET', '/api/agent-runs');
    run = (Array.isArray(runs) ? runs : runs.items ?? runs.runs ?? []).find(r => r.id === run.id) ?? run;
  }
  const transcriptPath = path.join(scope.workspace, '.openscience/transcripts', `${run.id}.jsonl`);
  const transcript = await fs.readFile(transcriptPath, 'utf8');
  const transcriptLines = transcript.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const digest = digestTranscript(transcriptLines);
  const retrieval = collectRetrieval(transcriptLines);
  if (run.status !== 'succeeded') throw new Error(`Real product run ended ${run.status}`);
  const filename = `${arm}-${c.id}-${repetition}.json`;
  const evidence = { caseId: c.id, prompt: c.prompt, actor: c.actor, project: c.project, arm, repetition, run, digest, retrieval, actions, sourceMap,collectorBinding:binding.listenerProof,memoryInventoryBefore,actualUserId:scope.userId??binding.accounts[c.actor].userId, originalFiles:scope.originalFiles??{},evaluation:c.evaluation,documentCount:scope.documentCount,runtime: binding.runtimeEvidence, transcriptSha256: sha(transcript) };
  await fs.writeFile(path.join(out, filename), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(out, `${filename}.transcript.jsonl`), transcript);
  return evidence;
}
export async function main() {
  const b = JSON.parse(await fs.readFile(path.join(root, 'cases.json'), 'utf8'));
  await verifyCorpus(b);
  const out = process.env.KNOWLEDGE_EVAL_OUT ?? path.join(root, 'results', new Date().toISOString().replaceAll(':','-'));
  await fs.mkdir(out, { recursive: true });
  const bindings = process.env.KNOWLEDGE_EVAL_BINDINGS ? JSON.parse(await fs.readFile(process.env.KNOWLEDGE_EVAL_BINDINGS, 'utf8')) : {};
  const missing = await preflight(bindings);
  const protocol = { benchmarkSha256: sha(JSON.stringify(b)), budgetCny: 50, expectedCells: 540, lifecycleDenominator: 30, independentUnit: 'question', ci: 'paired percentile bootstrap, 10000 draws, 95%', noninferiority: 'general and medical independently: lower CI > -0.02; otherwise inconclusive', missing, status: missing.length ? 'blocked' : 'ready', spendCny: 0 };
  await fs.writeFile(path.join(out, 'execution.json'), JSON.stringify(protocol, null, 2));
  if (missing.length) { console.log(JSON.stringify(protocol)); return; }
  // Scoring is a separate explicit review stage; raw runs never imply quality pass.
  if (!process.argv.includes('--execute')) { console.log('Preflight ready. Use --execute to collect real runs.'); return; }
  await armSharedBudget(bindings.sharedBudget); // Recheck immediately before provisioning can start paid background work.
  const { provision, runLifecycle } = await import('./provision.mjs');
  const os = await import('node:os');
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-eval-private-'));
  const contexts = {};
  try {
    for (const arm of ['baseline','candidate']) {
      if (!bindings[arm].dataDir) throw new Error(`${arm}: isolated product dataDir is required for automatic fixture setup`);
      bindings[arm].listenerProof=(await verifyBoundCollector(bindings[arm].base,arm,bindings.sharedBudget)).binding;
      const ctx = await provision({base:bindings[arm].base,dataDir:bindings[arm].dataDir,privateDir:path.join(privateDir,arm),benchmark:b,arm,coverage:true,sharedBudget:bindings.sharedBudget});
      contexts[arm] = ctx;
      bindings[arm].accounts = ctx.bindings.accounts;
      for (const repetition of [1,2,3]) {
        const lifecycle = await runLifecycle(b,ctx);
        await fs.writeFile(path.join(out,`${arm}-lifecycle-${repetition}.json`),JSON.stringify(lifecycle,null,2));
      }
    }
    for (const c of b.cases.filter(c=>c.stratum !== 'lifecycle')) for (const arm of ['baseline','candidate']) for (const repetition of [1,2,3]) { await verifyBoundCollector(bindings[arm].base,arm,bindings.sharedBudget); await execute(c, bindings[arm], repetition, arm, out); }
  } finally {
    for (const ctx of Object.values(contexts)) await ctx.cleanup();
    await fs.rm(privateDir,{recursive:true,force:true});
  }
  protocol.status = 'collected-awaiting-scoring';
  delete protocol.spendCny; // Real spend must be imported from the control-plane usage ledger, never estimated as zero.
  await fs.writeFile(path.join(out, 'execution.json'), JSON.stringify(protocol, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
