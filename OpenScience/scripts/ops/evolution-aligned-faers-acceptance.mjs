// Operator-only same-publication three-ruler preparation; hidden values never enter dispatch input.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {freezeCycle,digest} from '../../evals/paper-gold/evaluator.mjs';
import {methodRulerRelations} from '../../evals/paper-gold/behavioural.mjs';
import {callReviewModel} from '../../apps/server/src/reviewModel.mjs';
import {createWebApiApp} from '../../apps/server/src/server.mjs';
import {loadConfig} from '../../apps/server/src/config.mjs';
import {createRuntimeController} from '../../apps/server/src/runtimeControllerServer.mjs';
import {RuntimeControllerClient} from '../../apps/server/src/runtimeControllerClient.mjs';
import {createEvolutionConfiguration} from './evolution-acceptance-config.mjs';
import {closeScopedApp} from './evolution-scoped-research-acceptance.mjs';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateAlignedProposal(record,descriptor,source){
 if(record.publicationId!==descriptor.publicationId||record.methodCaseId!==descriptor.methodCaseId||record.sourceHash!==descriptor.sourceHash||sha(source)!==descriptor.sourceHash||record.fullResearchReproductionValid!==false||record.independentSemanticQa?.status!=='not_executed')throw new Error('Aligned proposal identity changed.');
 for(const key of ['questionVariants','proposedVariants'])if(record[key]?.length!==3||new Set(record[key]).size!==3||record[key].some(v=>typeof v!=='string'||!v.trim()))throw new Error('Exactly three neutral variants required.');
 for(const key of ['a','b','c','d'])if(!Number.isFinite(record.input.adjustedCounts[key])||record.input.adjustedCounts[key]<=0||record.input.adjustedCounts[key]!==record.input.counts[key]+record.input.continuityCorrection)throw new Error('Invalid supplied aggregate input.');
 const x=record.input.adjustedCounts,ror=x.a*x.d/(x.b*x.c),se=Math.sqrt(1/x.a+1/x.b+1/x.c+1/x.d),actual={ROR:ror,lower:Math.exp(Math.log(ror)-1.96*se),upper:Math.exp(Math.log(ror)+1.96*se)};
 for(const key of ['ROR','lower','upper']){const gold=record.numericGold[key];if(!Number.isFinite(gold?.value)||!Number.isFinite(gold.absoluteTolerance)||gold.absoluteTolerance<0||Math.abs(actual[key]-gold.value)>gold.absoluteTolerance||Math.abs(actual[key]-record.independentNumericReference.numeric[key])>1e-8)throw new Error('Published numeric/reference bond failed.');}
 return true;
}
/** Frozen descriptor binds actual supplied counts to the independent author/R numeric reference. */
export function alignedVerificationDescriptor(record){
 const input={...record.input.counts,continuityCorrection:record.input.continuityCorrection};
 // The counts are given to the run, so replaying on them alone verifies nothing a constant could not: the replay also swaps the exposure groups, which inverts a ROR.
 return {entrypoint:'deliverables/paper-gold-analysis/analysis.py:analyze',implementationId:'delivered-faers-analysis',input,inputHash:digest(input),sourceHash:record.sourceHash,dependencyIds:[],relations:methodRulerRelations('faers-ror'),independentQa:record.existingNumericQa,independentImplementation:{...record.independentNumericReference,sourceHash:record.sourceHash},tolerances:Object.fromEntries(Object.keys(record.numericGold).map(key=>[key,{absoluteTolerance:1e-8,relativeTolerance:0}]))};
}
export async function loadAlignedSources(evaluationDataDir){
 const manifest=JSON.parse(await fs.readFile(new URL('../../evals/paper-gold/aligned-faers-manifest.json',import.meta.url),'utf8'));
 const directory=path.join(evaluationDataDir,manifest.directory),records=[];
 for(const descriptor of manifest.cases){
  const bytes=await fs.readFile(path.join(directory,descriptor.file));if(sha(bytes)!==descriptor.definitionHash)throw new Error('Aligned hidden definition changed.');
  const record=JSON.parse(bytes.toString()),relative=record.sourceBond.sourceFile;
  if(!/^sources\/[a-zA-Z0-9_.-]+$/.test(relative))throw new Error('Invalid preserved source path.');
  const source=await fs.readFile(path.join(directory,relative));validateAlignedProposal(record,descriptor,source);
  // Exact parsed table-row equality is required; no fuzzy quote matching or model approval substitutes it.
  const check=spawnSync('python3',['-c',`import json,sys,csv,xml.etree.ElementTree as E
x=json.load(sys.stdin);s=x['source'];b=x['bond'];row=b['originalTableRow']
if isinstance(row,dict):
 ok=any(r==row for r in csv.DictReader(s.lstrip('\\ufeff').splitlines()));view=json.dumps(row)
else:
 r=E.fromstring(s);t=r.find('.//table-wrap[@id="'+b['tableId']+'"]');ok=t is not None and any([' '.join(c.itertext()).strip() for c in tr.findall('td')]==row for tr in t.findall('.//tbody/tr'))
 if t is not None:
  methods=[' '.join(sec.itertext()) for sec in r.findall('.//body/sec') if 'method' in sec.findtext('title','').lower()]
  view=' '.join(r.findtext('.//article-title','').split())+'\\n'+'\\n'.join(methods)+'\\n'+' '.join(t.itertext())
print(json.dumps({'exactRow':ok,'reviewText':view if ok else ''}));sys.exit(0 if ok else 1)`],{input:JSON.stringify({source:source.toString(),bond:record.sourceBond}),encoding:'utf8'});
  if(check.status!==0)throw new Error('Exact primary table-row bond failed.');
  let context='';if(record.contextDocument){const b=await fs.readFile(path.join(directory,record.contextDocument.file));if(sha(b)!==record.contextDocument.sha256)throw new Error('Author context changed.');context=b.toString();}
  const parsed=JSON.parse(check.stdout);if(parsed.reviewText.length>90000)throw new Error('Primary method/table QA evidence exceeds bounded context.');records.push({record,descriptor,source:parsed.reviewText,context});
 }
 if(records.length!==5||new Set(records.map(x=>x.record.publicationId)).size!==5)throw new Error('Five distinct publications required.');
 return {manifest,records};
}
export async function prepareAlignedFaers({app,evaluationDataDir,cycleId='acceptance-aligned-faers-v6',reuseFromCycleId='acceptance-aligned-faers-v2',signal,review=callReviewModel,load=loadAlignedSources}){
 if(!/^[a-z0-9_-]{1,100}$/.test(cycleId))throw new Error('Invalid aligned cycle.');
 return app.evolution.service.withLock(`aligned-faers:${cycleId}`,async()=>{
  const {manifest,records}=await load(evaluationDataDir),directory=path.join(evaluationDataDir,'paper-gold','cycles',cycleId),manifestHash=digest(manifest);
  try{const frozen=JSON.parse(await fs.readFile(path.join(directory,'definition.json'),'utf8'));if(frozen.definition.alignedManifestHash!==manifestHash||frozen.hash!==digest({definition:frozen.definition,evaluatorCodeHash:frozen.evaluatorCodeHash}))throw new Error('Aligned freeze changed.');return {cycleId,hash:frozen.hash,admittedPublications:frozen.definition.cases.length/2,resumed:true};}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const userId=await app.evolution.service.owner(),projectId=`eval-paper-${sha(`${cycleId}:qa`).slice(0,40)}`,user=await app.store.userById(userId);if(!user||app.config.reviewProvider==='deepseek')throw new Error('Independent evaluation owner/reviewer unavailable.');await app.store.projectFor(user,projectId,'Aligned source control QA');
  const cases=[],missing=[];
  for(const {record,descriptor,source,context}of records){
   const qaIdentity=digest({manifestHash,descriptor}),file=path.join(directory,`${record.id}-qa.json`);let qa;
   try{const saved=JSON.parse(await fs.readFile(file,'utf8'));if(saved.identity!==qaIdentity)throw new Error('Aligned QA identity changed.');qa=saved.review;}catch(error){if(error.code!=='ENOENT')throw error;}
   if(!qa&&reuseFromCycleId!==cycleId){
    if(!/^[a-z0-9_-]{1,100}$/.test(reuseFromCycleId))throw new Error('Invalid prior aligned cycle.');
    const priorDir=path.join(evaluationDataDir,'paper-gold','cycles',reuseFromCycleId);
    try{const prior=JSON.parse(await fs.readFile(path.join(priorDir,'definition.json'),'utf8'));if(prior.hash!==digest({definition:prior.definition,evaluatorCodeHash:prior.evaluatorCodeHash})||prior.definition.alignedManifestHash!==manifestHash)throw new Error('Prior aligned source freeze changed.');const saved=JSON.parse(await fs.readFile(path.join(priorDir,`${record.id}-qa.json`),'utf8'));if(saved.identity!==qaIdentity)throw new Error('Prior aligned scientific QA identity changed.');qa=saved.review;await fs.writeFile(file,JSON.stringify({identity:qaIdentity,review:qa,reusedFromCycleId:reuseFromCycleId}),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='ENOENT')throw error;}
   }
   if(!qa){qa=await review({config:app.config,usageLedger:app.usageLedger},{userId,projectId,purpose:'evolution',signal,limits:{daily:app.config.evolutionDailyBudgetCny,weekly:0},schemaName:'aligned_faers_semantic_qa',maxTokens:1536,schema:{type:'object',additionalProperties:false,required:['passed','issues'],properties:{passed:{type:'boolean'},issues:{type:'array',items:{type:'string'}}}},messages:[{role:'system',content:'Independently verify the same clinical comparison, exact four-cell meanings, comparator, declared continuity correction and normal-log ROR interval method against the preserved primary table and methods. Verify exactly three neutral question variants and three supplied-aggregate scoped research variants. Asking for an estimate does not reveal its actual numeric answer. Question tasks have no supplied data and may fail scientifically; that is not rewrite invalidity. Supplied-aggregate analyses must explicitly exclude original database ingestion, deduplication, harmonization, unprovided secondary analyses and whole-study reproduction. ROR is reporting association, not incidence or causation. Reject unsupported semantic assertions. Numerical engine agreement does not imply semantic QA.'},{role:'user',content:JSON.stringify({primary:source,authorContext:context,proposed:record})}]});await fs.writeFile(file,JSON.stringify({identity:qaIdentity,review:qa}),{mode:0o600,flag:'wx'});}
   if(qa.value?.passed!==true||qa.modelReported!==true||!/^qwen/i.test(qa.model??'')){missing.push({id:record.id,reason:'independent_semantic_qa_failed',issues:qa.value?.issues??[]});continue;}
   for(const type of ['research','question']){
    const variants=type==='question'?record.questionVariants:record.proposedVariants;
    const input=type==='question'?variants[0]:`${variants[0]}\nSupplied counts: ${JSON.stringify(record.input.counts)}\nContinuity correction to EACH cell: ${record.input.continuityCorrection}\nCell definitions: ${JSON.stringify(record.input.cellDefinitions)}\nMethod: ${record.input.method}`;
    const scope=type==='question'?'question-only-same-clinical-comparison':'positive-scoped-analysis-not-full-research';
    cases.push({id:`${record.id}-${type}`,type,publicationId:record.publicationId,sourceHash:record.sourceHash,engineId:'pharmacovigilance',track:'pharmacovigilance',group:`aligned-${type}`,capabilityId:type==='research'?'statistical-analysis':'adr-analysis',rewrite:{writer:'control-aligned-faers-v1',qaExecutor:qa.model,qaPassed:true,question:variants[0],variants},input:`${input}\nWrite a numeric JSON receipt with fields ROR, lower, upper when justified; otherwise explicitly state unavailable inputs.${type==='research'?' Deliver deliverables/paper-gold-analysis/analysis.py exporting callable analyze(a,b,c,d,continuityCorrection=0), adding continuityCorrection to each original cell before the declared calculation and returning an object with numeric ROR, lower, upper. Use only Python standard library; the evaluator will execute this exact callable independently. Submit exactly deliverables/paper-gold-analysis/report.md, analysis-results.json, analysis-run.json and analysis.py through the statistical-analysis producer receipt; the callable file itself must be included.':''}`,policy:{aliases:[record.publicationId,record.source.pmcid,record.source.pmid?`PMID:${record.source.pmid}`:null].filter(Boolean),titles:[record.title]},dois:[record.publicationId],gold:{numeric:record.numericGold,inputAvailable:type==='research',benchmarkScope:scope,applicableStages:type==='research'?['question','method','calculation','certainty','writing']:['question','method','certainty','writing'],stageChecks:{question:['question_aligned'],method:['method_supported'],certainty:['certainty_supported'],writing:['writing_sources_bound']},sourceHash:record.sourceHash,...(type==='research'?{requireDeterministicVerification:true,deterministicVerification:alignedVerificationDescriptor(record)}:{}),inputLimitations:['Only the supplied aggregate comparison is in scope; whole-source research is not reproduced.'],preservedEvidence:[{id:record.id,sourceHash:record.sourceHash,kind:record.sourceBond.tableId==='author-all_ror_tests-comparator-C1'?'primary-author-aggregate':'primary-publication',text:source,textHash:sha(source),extraction:'Deterministic exact parsed source table/methods; original bytes verified before freeze.'},...(context?[{id:`${record.id}-author-context`,sourceHash:record.contextDocument.sha256,kind:'primary-author-context',text:context,textHash:sha(context)}]:[])],reachableEvidenceIds:[],unreachableEvidenceIds:[]}});
   }
  }
  const definition={schemaVersion:1,replicates:2,track:'pharmacovigilance',scopedAnalysis:true,alignedManifestHash:manifestHash,methodReportHash:manifest.methodReportHash,assessmentConfiguration:{reviewProvider:app.config.reviewProvider,reviewModel:app.config.reviewModel,baselineModel:'deepseek-flash'},cases,unavailable:missing};
  const frozen=await freezeCycle(evaluationDataDir,cycleId,definition);return {cycleId,hash:frozen.hash,admittedPublications:cases.length/2,missing:missing.length,plannedDshRuns:cases.length*6,fullResearchEligible:false,resumed:false};
 });
}
export async function runAlignedFaers({app,evaluationDataDir,cycleId='acceptance-aligned-faers-v6',maxNewUnits=null,signal}){
 const prepared=await prepareAlignedFaers({app,evaluationDataDir,cycleId,signal});
 const job={id:`aligned-${cycleId}`,payload:{cycleId,maxNewUnits}};
 const result=await app.evolution.worker.callbacks.evaluate(job.payload,{service:app.evolution.service,job,purpose:'evolution',signal});
 const units=result?.payload?.units??[];if(units.some(row=>row.fullResearchReproductionValid===true))throw new Error('Scoped analysis incorrectly scored as whole research.');
 return {...prepared,complete:result?.payload?.complete===true,completedUnits:units.length,independentAssessments:units.filter(row=>row.independent===true).length,applicableValid:units.filter(row=>row.applicableStagesValid===true).length,fullResearchValid:0};
}
async function main(){
 const file=process.env.EVIMED_EVOLUTION_ACCEPTANCE_INPUT;if(!file)throw new Error('Supply isolated acceptance input.');const input=JSON.parse(await fs.readFile(file,'utf8'));
 if(!String(input.databaseUrl).includes('evimed_test_evolution')||input.dataDir!=='/acceptance'||input.evaluationDataDir!=='/control-eval'||!String(input.runtimeImage).startsWith('evimed-evolution-acceptance:')||!String(input.network).startsWith('evimed-evolution-acceptance'))throw new Error('Refusing unscoped environment.');
 if(!process.argv.includes('--prepare')&&!process.argv.includes('--execute')){const {manifest}=await loadAlignedSources(input.evaluationDataDir);process.stdout.write(`${JSON.stringify({papers:manifest.cases.length,manifestHash:digest(manifest),plannedQACalls:5,plannedDshRuns:60,scored:false,fullResearchEligible:false})}\n`);return;}
 const credentials=JSON.parse(await fs.readFile('/control-state/acceptance-credentials.json','utf8')),overrides=createEvolutionConfiguration(input,credentials),config=loadConfig(overrides),abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());let app,controller;
 try{if(process.argv.includes('--execute')){controller=createRuntimeController(config);await controller.listen();}app=createWebApiApp({...overrides,...(controller?{evolutionController:new RuntimeControllerClient(config)}:{})});if(controller){await app.listen(8787,'0.0.0.0');app.evolution.worker.stop();}await app.store.bootstrapUserState();const arg=process.argv.find(x=>x.startsWith('--max-new-units='));const options={app,evaluationDataDir:input.evaluationDataDir,signal:abort.signal,maxNewUnits:arg?Number(arg.split('=')[1]):null};const result=controller?await runAlignedFaers(options):await prepareAlignedFaers(options);process.stdout.write(`${JSON.stringify(result)}\n`);}finally{if(controller)await app?.close();else await closeScopedApp(app);await controller?.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
