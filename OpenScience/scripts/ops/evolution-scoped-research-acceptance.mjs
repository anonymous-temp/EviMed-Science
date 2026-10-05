// Operator-only positive supplied-input analysis; explicitly excludes whole-paper reproduction.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {freezeCycle,digest} from '../../evals/paper-gold/evaluator.mjs';
import {calibrationTextView} from '../../apps/server/src/paperGoldCalibration.mjs';
import {callReviewModel} from '../../apps/server/src/reviewModel.mjs';
import {createWebApiApp} from '../../apps/server/src/server.mjs';
import {loadConfig} from '../../apps/server/src/config.mjs';
import {createRuntimeController} from '../../apps/server/src/runtimeControllerServer.mjs';
import {RuntimeControllerClient} from '../../apps/server/src/runtimeControllerClient.mjs';
import {createEvolutionConfiguration} from './evolution-acceptance-config.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
/** No model calls: immutable actual independent engine proof is verified before semantic admission. */
export async function loadScopedReference(evaluationDataDir){
 const manifest=JSON.parse(await fs.readFile(new URL('../../evals/paper-gold/scoped-research-manifest.json',import.meta.url),'utf8'));
 const directory=path.join(evaluationDataDir,'paper-gold','scoped-research');
 const bytes=await fs.readFile(path.join(directory,'hackshaw-main-dl-proof.json'));
 const author=await fs.readFile(path.join(directory,'hackshaw-main-dl-author.html'),'utf8');
 if(sha(bytes)!==manifest.proofHash||sha(author)!==manifest.authorDocumentHash)throw new Error('Scoped source integrity changed.');
 const proof=validateScopedReference({manifest,bytes,author});
 return {manifest,proof,author};
}
/** Immutable operator receipt validation; separate semantic QA never follows from these numeric checks. */
export function validateScopedReference({manifest,bytes,author}){
 if(sha(bytes)!==manifest.proofHash||sha(author)!==manifest.authorDocumentHash)throw new Error('Scoped source integrity changed.');
 const proof=JSON.parse(bytes.toString());
 if(proof.sourceHash!==manifest.dataHash||proof.publicationId!==manifest.publicationId||proof.numericComparisonPassed!==true||proof.actualReplicates.length!==2||proof.input.tauEstimator!=='DL'||proof.input.studies.length!==37||proof.fullResearchReproductionValid!==false)throw new Error('Unverified scoped reference.');
 for(const actual of proof.actualReplicates)for(const [key,ref]of Object.entries(proof.numeric))if(!Number.isFinite(actual[key])||Math.abs(actual[key]-ref.value)>ref.absoluteTolerance)throw new Error('Independent scoped numeric comparison failed.');
 return proof;
}
/** Reuse only identical source/input/question semantic evidence, never an old scorer verdict. */
export function validateScopedQaReuse({cached,frozen,identity,manifest}){
 if(cached.identity!==identity||frozen.hash!==digest({definition:frozen.definition,evaluatorCodeHash:frozen.evaluatorCodeHash})||frozen.definition.referenceProofHash!==manifest.proofHash||frozen.definition.scopedAnalysis!==true)throw new Error('Prior scoped QA is not bound to unchanged source/input/question.');
 return cached.review;
}
export function scopedVerificationDescriptor(proof){
 return {entrypoint:'deliverables/paper-gold-analysis/analysis.py:analyze',implementationId:'delivered-scoped-meta-analysis',sourceHash:proof.sourceHash,input:proof.input,inputHash:digest(proof.input),dependencyIds:[],independentQa:{passed:proof.numericComparisonPassed===true,executor:proof.independentReference.implementationId},independentImplementation:{...proof.independentReference,sourceHash:proof.sourceHash},tolerances:Object.fromEntries(Object.entries(proof.numeric).map(([key,row])=>[key,{absoluteTolerance:row.absoluteTolerance,relativeTolerance:0}]))};
}
/** Three variants/two replicates remain frozen; independent semantic QA is a separate metered control-only call. */
export async function prepareScopedResearch({app,evaluationDataDir,cycleId='acceptance-scoped-research-meta-v7',reuseFromCycleId='acceptance-scoped-research-meta-v1',signal,review=callReviewModel,loadReference=loadScopedReference}){
 if(!/^[a-z0-9_-]{1,100}$/.test(cycleId))throw new Error('Invalid scoped cycle.');
 return app.evolution.service.withLock(`scoped-research:${cycleId}`,async()=>{
  const {manifest,proof,author}=await loadReference(evaluationDataDir);
  const directory=path.join(evaluationDataDir,'paper-gold','cycles',cycleId);
  try{
   const saved=JSON.parse(await fs.readFile(path.join(directory,'definition.json'),'utf8'));
   if(saved.hash!==digest({definition:saved.definition,evaluatorCodeHash:saved.evaluatorCodeHash})||saved.definition.referenceProofHash!==manifest.proofHash||saved.definition.scopedAnalysis!==true)throw new Error('Scoped freeze identity changed.');
   return {cycleId,hash:saved.hash,admitted:true,resumed:true,fullResearchEligible:false};
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const question='Produce a scoped numerical research report on lung cancer odds in lifelong nonsmoking women exposed to tobacco smoke from their spouse, using the supplied 37-study author tabulation and the specified DerSimonian–Laird random-effects model with normal-Wald confidence intervals. Explain the data limitations and distinguish this main pooled analysis from all other analyses in the original study.';
  const variants=[question,'Prepare a scoped report estimating the association between spouse tobacco smoke exposure and lung cancer in lifelong nonsmoking women. Analyze the supplied 37-study author effect-size table with DerSimonian–Laird random effects and normal-Wald intervals, and state the scope and limitations.','Using the supplied 37-study author tabulation, independently reproduce the main pooled-analysis model for spouse tobacco smoke exposure and lung cancer in lifelong nonsmoking women. Deliver a report with DerSimonian–Laird estimates, normal-Wald intervals, assumptions and limitations; do not claim reproduction of omitted study analyses.'];
  const scope='Supplied-data main pooled-analysis only. Study-level log odds ratios and variances are author back-calculations from rounded published values. No whole-paper reproduction: bias/diet/biochemical analyses and independent literature-search/extraction stages are outside this task.';
  const userId=await app.evolution.service.owner(),projectId=`eval-paper-${sha(`${cycleId}:semantic-qa`).slice(0,40)}`;
  const user=await app.store.userById(userId);if(!user)throw new Error('Scoped evaluation owner unavailable.');
  await app.store.projectFor(user,projectId,'Scoped analysis control QA');
  if(app.config.reviewProvider==='deepseek')throw new Error('Scoped semantic QA requires a separate model family.');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const proposed={question,variants,scope,input:proof.input,publicationId:proof.publicationId};
  const qaFile=path.join(directory,'semantic-qa.json'),qaIdentity=digest({proofHash:manifest.proofHash,authorHash:manifest.authorDocumentHash,proposed});
  let qa;
  try{const cached=JSON.parse(await fs.readFile(qaFile,'utf8'));if(cached.identity!==qaIdentity)throw new Error('Scoped semantic QA definition changed.');qa=cached.review;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!qa&&reuseFromCycleId){
   if(!/^[a-z0-9_-]{1,100}$/.test(reuseFromCycleId)||reuseFromCycleId===cycleId)throw new Error('Invalid prior scoped cycle.');
   const prior=path.join(evaluationDataDir,'paper-gold','cycles',reuseFromCycleId);
   let cached;try{cached=JSON.parse(await fs.readFile(path.join(prior,'semantic-qa.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(cached){const frozen=JSON.parse(await fs.readFile(path.join(prior,'definition.json'),'utf8'));qa=validateScopedQaReuse({cached,frozen,identity:qaIdentity,manifest});await fs.writeFile(qaFile,JSON.stringify({identity:qaIdentity,review:qa,reusedFrom:reuseFromCycleId}),{mode:0o600,flag:'wx'});}
  }
  if(!qa){
   qa=await review({config:app.config,usageLedger:app.usageLedger},{userId,projectId,purpose:'evolution',signal,limits:{daily:app.config.evolutionDailyBudgetCny,weekly:0},schemaName:'scoped_research_primary_qa',maxTokens:1536,schema:{type:'object',additionalProperties:false,required:['passed','issues'],properties:{passed:{type:'boolean'},issues:{type:'array',items:{type:'string'}}}},messages:[{role:'system',content:'Independently verify this narrowly scoped commissioned analysis against the author dataset documentation. Require accurate population/exposure/outcome, exact 37-study tabulation, DL/normal-Wald methods and three distinct neutral report variants. Explicitly acknowledge back-calculated rounded inputs. A supplied-input reanalysis does not reproduce all original clinical research; verify omitted bias/diet/biochemical and independent search/extraction stages are excluded. Requesting numerical estimates does not reveal literal answers. Reject unsupported semantic assertions; never infer approval from the numeric proof.'},{role:'user',content:JSON.stringify({source:calibrationTextView(author),proposed})}]});
   await fs.writeFile(qaFile,JSON.stringify({identity:qaIdentity,review:qa}),{mode:0o600,flag:'wx'});
  }
  if(qa.value?.passed!==true||qa.modelReported!==true||!/^qwen/i.test(qa.model??''))return {cycleId,admitted:false,status:'independent_semantic_qa_failed',issues:qa.value?.issues?.length??0,fullResearchEligible:false};
  const definition={schemaVersion:1,replicates:2,track:'meta',scopedAnalysis:true,referenceProofHash:manifest.proofHash,assessmentConfiguration:{reviewProvider:app.config.reviewProvider,reviewModel:app.config.reviewModel,baselineModel:'deepseek-flash'},cases:[{id:manifest.id,type:'research',publicationId:manifest.publicationId,sourceHash:manifest.dataHash,engineId:'meta',track:'meta',group:'scoped-positive-given-inputs',capabilityId:'statistical-analysis',rewrite:{writer:'deterministic-scoped-dl-template-v1',qaExecutor:qa.model,qaPassed:true,question,variants},input:`${question}\nScope: ${scope}\nAnalysis inputs: ${JSON.stringify(proof.input)}\nWrite the numeric JSON receipt with output fields ${Object.keys(proof.numeric).join(', ')} and deliverables/paper-gold-analysis/analysis.py exporting callable analyze(**arguments) for the supplied input fields. Submit exactly deliverables/paper-gold-analysis/report.md, analysis-results.json, analysis-run.json and analysis.py through the statistical-analysis producer receipt; include the callable analysis.py itself, not merely a launcher or an unsubmitted scripts copy.`,policy:{aliases:[manifest.publicationId,'PMID:9365295','PMC2127653'],titles:['The accumulated evidence on lung cancer and environmental tobacco smoke.']},dois:[manifest.publicationId],gold:{numeric:proof.numeric,inputAvailable:true,benchmarkScope:'positive-scoped-analysis-not-full-research',applicableStages:['question','method','calculation','certainty','writing'],stageChecks:{question:['question_aligned'],method:['method_supported'],certainty:['certainty_supported'],writing:['writing_sources_bound']},sourceHash:manifest.dataHash,deterministicVerification:scopedVerificationDescriptor(proof),inputLimitations:[scope],preservedEvidence:[{id:manifest.id,sourceHash:manifest.dataHash},{id:'author-dataset-documentation',sourceHash:manifest.authorDocumentHash,kind:'author-dataset-documentation',text:calibrationTextView(author),textHash:sha(calibrationTextView(author)),supportsPaperAdjudication:false}],reachableEvidenceIds:[],unreachableEvidenceIds:[]}}],unavailable:[]};
  const frozen=await freezeCycle(evaluationDataDir,cycleId,definition);
  return {cycleId,hash:frozen.hash,admitted:true,resumed:false,plannedDshRuns:6,fullResearchEligible:false};
 });
}
export async function runScopedResearch({app,evaluationDataDir,cycleId='acceptance-scoped-research-meta-v7',reuseFromCycleId='acceptance-scoped-research-meta-v1',maxNewUnits=null,signal}){
 const prepared=await prepareScopedResearch({app,evaluationDataDir,cycleId,reuseFromCycleId,signal});
 if(!prepared.admitted)return prepared;
 return app.evolution.service.withLock(`scoped-research-run:${cycleId}`,async()=>{
  const job={id:`scoped-research-${cycleId}`,payload:{cycleId,maxNewUnits}};
  const result=await app.evolution.worker.callbacks.evaluate(job.payload,{service:app.evolution.service,job,purpose:'evolution',signal});
  const units=result?.payload?.units??[];
  if(units.some(row=>row.fullResearchReproductionValid===true))throw new Error('Scoped analysis was incorrectly scored as whole research.');
  return {cycleId,evaluatorHash:prepared.hash,complete:result?.payload?.complete===true,completedUnits:units.length,applicableValid:units.filter(row=>row.applicableStagesValid===true).length,independentAssessments:units.filter(row=>row.independent===true).length,fullResearchValid:0,unknownExposure:units.filter(row=>row.exposureTier==='unknown').length};
 });
}
/** Detached control-only preparation never starts the HTTP listener. */
export async function closeScopedApp(app){
 if(!app)return;
 try{await app.close();}catch(error){if(error.code!=="ERR_SERVER_NOT_RUNNING")throw error;await app.store.close();}
}
async function main(){
 const inputFile=process.env.EVIMED_EVOLUTION_ACCEPTANCE_INPUT;if(!inputFile)throw new Error('Supply isolated acceptance input.');
 const input=JSON.parse(await fs.readFile(inputFile,'utf8'));
 if(!String(input.databaseUrl).includes('evimed_test_evolution')||input.dataDir!=='/acceptance'||input.evaluationDataDir!=='/control-eval'||!String(input.runtimeImage).startsWith('evimed-evolution-acceptance:')||!String(input.network).startsWith('evimed-evolution-acceptance'))throw new Error('Refusing unscoped environment.');
 if(!process.argv.includes('--prepare')&&!process.argv.includes('--execute')){const {manifest}=await loadScopedReference(input.evaluationDataDir);process.stdout.write(`${JSON.stringify({id:manifest.id,proofHash:manifest.proofHash,plannedDshRuns:6,scored:false,fullResearchEligible:false})}\n`);return;}
 const credentials=JSON.parse(await fs.readFile('/control-state/acceptance-credentials.json','utf8'));
 const overrides=createEvolutionConfiguration(input,credentials),config=loadConfig(overrides);
 const abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
 let app,controller;
 try{
  if(process.argv.includes('--execute')){controller=createRuntimeController(config);await controller.listen();}
  app=createWebApiApp({...overrides,...(controller?{evolutionController:new RuntimeControllerClient(config)}:{})});
  if(controller){await app.listen(8787,'0.0.0.0');app.evolution.worker.stop();}
  await app.store.bootstrapUserState();
  const unitArg=process.argv.find(arg=>arg.startsWith('--max-new-units='));
  const result=controller?await runScopedResearch({app,evaluationDataDir:input.evaluationDataDir,maxNewUnits:unitArg?Number(unitArg.split('=')[1]):null,signal:abort.signal}):await prepareScopedResearch({app,evaluationDataDir:input.evaluationDataDir,signal:abort.signal});
  process.stdout.write(`${JSON.stringify(result)}\n`);
 }finally{if(controller)await app?.close();else await closeScopedApp(app);await controller?.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
