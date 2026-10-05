import {readDeliveryReceipt} from './agentRuns.mjs';
import {readPaperGoldArtifacts,waitPaperGoldTranscript,paperGoldTraceCoverage,readPaperGoldNativeCoverage} from './paperGoldEvaluator.mjs';
/** Production audit reader shares the evaluator's exact-run SHA/no-follow and sealing rules.
 * @param {any} dependencies */
export function createEvolutionScorerEvidence({service,store,agentRuns,runtimeManager,timeoutMs=60000}) {
 return async(unit,options={})=>{
  const {signal}=/** @type {{signal?:AbortSignal}} */(options);
  const user=await store.userById(await service.owner());
  if(!/^eval-paper-[a-zA-Z0-9_-]+$/.test(unit.producerProjectId)) return null;
  const project=await store.requireProject(user,unit.producerProjectId);
  const run=(await agentRuns.list(project)).find(row=>row.id===unit.producerRunId);
  if(!run) return null;
  const sealed=await waitPaperGoldTranscript({project,runId:run.id,signal,timeoutMs});
  const receipt=await readDeliveryReceipt(project,run).catch(()=>null);
  const artifacts=await readPaperGoldArtifacts({project,run,receipt});
  const nativeCoverage=sealed.complete?await readPaperGoldNativeCoverage({runtimeManager,project,run,signal}):null;
  const traceCoverage=paperGoldTraceCoverage(sealed.transcript,nativeCoverage);
  return {nativeCoverage,nativeEgressProofHash:traceCoverage.nativeCoverageProofHash,transcript:sealed.transcript,completeDurableTranscript:sealed.complete,traceCoverage,deliveredText:artifacts.deliveredText,numeric:artifacts.numeric,artifactIssues:artifacts.issues,recalledEvidenceIds:artifacts.recalledEvidenceIds};
 };
}
