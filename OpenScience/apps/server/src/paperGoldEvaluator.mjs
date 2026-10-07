import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { callModelForControlPlane } from "./modelGateway.mjs";
import {setTimeout as delay} from "node:timers/promises";
import {openScopedFileNoFollow,normalizeWorkspaceRelativePath} from "./security.mjs";
import {readDeliveryReceipt} from "./agentRuns.mjs";
import { readRunTranscript } from "./runTranscripts.mjs";
import { createPaperGoldCalibration } from "./paperGoldCalibration.mjs";
import { callReviewModel } from "./reviewModel.mjs";
import { runCycle, PaperGoldAdministrativeDeferral } from "../../../evals/paper-gold/run.mjs";
import { numericScore } from "../../../evals/paper-gold/evaluator.mjs";
import { freezeCycle, digest } from "../../../evals/paper-gold/evaluator.mjs";
import { importExistingEngineReceipt } from "./existingEngineCalibration.mjs";
import { deriveBenchmarkDefinition } from "../../../evals/paper-gold/benchmarks.mjs";
import { comparisonFromVerifiedUnit } from "./recalculationComparison.mjs";
import { verifyPaperGoldCode, bindPaperGoldReview, bindPaperGoldStageAssessment } from "./paperGoldVerification.mjs";

/** Fresh isolated namespace only after a checkpointed administrative attempt. */
export function paperGoldDispatchIdentity(cycleId,caseId,replicate,attempt=0){
 if(!Number.isSafeInteger(attempt)||attempt<0)throw new Error("Invalid administrative dispatch attempt.");
 const identity=`${cycleId}:${caseId}:${replicate}${attempt?`:administrative-retry:${attempt}`:""}`;
 const hash=createHash("sha256").update(identity).digest("hex");
 return {projectId:`eval-paper-${hash.slice(0,40)}`,dispatchId:`evolution_paper_${hash.slice(0,32)}`};
}
/** Immutable control-only provider assessment, without transport headers or credentials. @param {any} request */
export async function preservePaperGoldAssessment({directory,binding,result}){
 const names=binding.checkNames??[];
 const response={value:{checks:Object.fromEntries(names.map(name=>[name,typeof result.value?.checks?.[name]==='boolean'?result.value.checks[name]:null])),evidenceIds:(result.value?.evidenceIds??[]).filter(x=>typeof x==='string'),gaps:(result.value?.gaps??[]).filter(x=>typeof x==='string'),reasons:Object.fromEntries(names.map(name=>[name,typeof result.value?.reasons?.[name]==='string'?result.value.reasons[name]:null]))},model:result.model??null,modelReported:result.modelReported===true,requestId:result.requestId??null};
 const body={schemaVersion:1,binding,response},hash=digest(body),receipt={...body,hash};
 await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,`${digest(binding)}.json`);
 try{await writeFile(file,JSON.stringify(receipt),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const existing=await readPaperGoldAssessment({directory,binding});if(existing?.hash!==hash)throw new Error('Immutable assessment receipt already differs.');}
 return receipt;
}
/** @param {any} request */
export async function readPaperGoldAssessment({directory,binding}){
 let receipt;try{receipt=JSON.parse(await readFile(path.join(directory,`${digest(binding)}.json`),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const {hash,...body}=receipt;if(hash!==digest(body)||digest(body.binding)!==digest(binding))throw new Error('Assessment receipt integrity differs.');return receipt;
}
/** Bounded durable sealing wait; a terminal ledger record alone is not complete evidence. @param {any} request */
export async function waitPaperGoldTranscript({project,runId,signal,timeoutMs=60000,pollMs=500,read=readRunTranscript}){
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isFinite(pollMs)||pollMs<1)throw new Error("Invalid transcript wait bounds.");
 const deadline=Date.now()+timeoutMs;let transcript=null;
 do{signal?.throwIfAborted();try{transcript=await read(project,runId);}catch{transcript=null;}
  if(transcript?.header?.runId===runId&&transcript.header.completeness==="complete"&&!(transcript.header.missing??[]).length)return {transcript,complete:true};
  if(Date.now()>=deadline)break;await delay(Math.min(pollMs,deadline-Date.now()),undefined,{signal});
 }while(Date.now()<=deadline);
 return {transcript,complete:false};
}
/** Managed workers may retrieve outside the gateway audit; tool discovery is not such execution. @param {any} transcript */
export function paperGoldTraceCoverage(transcript,nativeCoverage=null){
 const unobservedTools=new Set();
 const nativeVerified=nativeCoverage?.nativeCoverageVerified===true && [nativeCoverage.proofHash,nativeCoverage.startProofHash,nativeCoverage.endProofHash].every(value=>/^[a-f0-9]{64}$/.test(value??""));
 for(const message of transcript?.messages??[])for(const part of message.parts??[]){
  if(part.type!=="tool")continue;
  if(/(?:^|__|[./])(bash|shell|terminal|python|execute_bash|execute_python|run_python|execute_code|run_code|evimed_exec)$/.test(part.tool??part.name??"")){if(!nativeVerified)unobservedTools.add(part.tool??part.name);continue;}
  const matched=/(?:^|__|[./])(meta_analysis|drug_safety_analysis|mendelian_randomization|bibliometric_analysis|peer_review|research_topic_selection)$/.exec(part.tool??part.name??"");if(!matched)continue;
  let input=part.input??part.arguments??{};if(typeof input==="string"){try{input=JSON.parse(input);}catch{input={};}}
  if(input.action==="capabilities")continue;
  unobservedTools.add(matched[1]);
 }
 return {complete:unobservedTools.size===0,unobservedTools:[...unobservedTools].sort(),basis:unobservedTools.size?"unobserved_native_or_managed_egress":"durable_runtime_and_gateway_trace",nativeCoverageVerified:nativeVerified,nativeCoverageProofHash:nativeVerified?nativeCoverage.proofHash:null};
}
/** Only an independent manager/controller verifier may establish native coverage. @param {any} request */
export async function readPaperGoldNativeCoverage({runtimeManager,project,run,signal}){
 if(!runtimeManager?.verifyRunEgressCoverage)return null;
 try{return await runtimeManager.verifyRunEgressCoverage({project,run,signal});}catch{return {nativeCoverageVerified:false,reason:'verification_unavailable'};}
}
/** Observed exposure survives unknown trace; absence requires complete independent coverage. @param {any} input */
export function paperGoldExposureTier({audit,durableComplete,traceCoverage,sourceTrace}){
 if(['cited','exposed_uncited'].includes(audit.tier))return audit.tier;
 return durableComplete&&traceCoverage.complete&&sourceTrace.complete?audit.tier:'unknown';
}
/**
 * `cite_lookup` (the dsh-cite package, registered through the citation bridge) is a native tool, not an `evimed_*` socket tool: its
 * result reaches the session history as the text its own renderer produced, one `N. <title>（<year>, <journal>）` line per work,
 * with no `ok` head and no JSON (dsh-cite@0.3.2 `cite_lookup.output.render`). Release 6 held 19 successful results of it across six
 * runs; none parsed, so the trace was incomplete and four units read unknown exposure. A rendered result is read back to the works
 * it lists, and anything that is not exactly that shape (empty, cut off, another layout) stays unparsed, which keeps the trace
 * incomplete: the failure is unknown, never unexposed.
 * @param {any} value @returns {{ ok: true, data: { works: string[] } } | null}
 */
function parseCiteLookupRendering(value){
 const parts=Array.isArray(value)?value:Array.isArray(value?.content)?value.content:null;
 const text=typeof value==='string'?value:parts&&parts.length&&parts.every(part=>part?.type==='text'&&typeof part.text==='string')?parts.map(part=>part.text).join('\n'):null;
 if(text===null)return null;
 const works=[];
 for(const line of text.replace(/\s+$/,'').split('\n')){
  const numbered=/^(\d+)\. /.exec(line);
  if(numbered&&Number(numbered[1])===works.length+1)works.push(line.slice(numbered[0].length));
  else if(works.length)works[works.length-1]+=`\n${line}`;
  else return null;
 }
 // The renderer closes every label with a full-width parenthesis; an entry that does not end in one was cut.
 return works.length&&works.every(work=>work.endsWith('）'))?{ok:true,data:{works}}:null;
}
/**
 * The evimed MCP server wraps every result with `provenance: { tool, arguments, scope }`, and `arguments` is the call's own request
 * echoed back (`_data_with_provenance`). What the run typed into its own query is not what the platform served it: on release 6 a
 * run searched Europe PMC with the protected DOI, was served four items none of which was the paper, and that echo was the only
 * match in its source responses, so the unit read exposed_uncited from the model's own recalled identifier. The request side
 * refuses a request that names the protected paper; the response side is audited without the echo of what was asked.
 * @param {any} data
 */
function withoutRequestEcho(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||!data.provenance||typeof data.provenance!=='object'||Array.isArray(data.provenance)||!Object.hasOwn(data.provenance,'arguments'))return data;
 const {arguments:_asked,...provenance}=data.provenance;
 return {...data,provenance};
}
/** Source exposure requires a successful observed response, never prompts or requested identifiers. @param {any} transcript */
export function paperGoldSourceResponses(transcript){
 const responses=[],unknownTools=[];
 const parse=(value,tool='')=>{
  if(typeof value==='string'&&/^Error:|^error\n/.test(value))return {ok:false};
  if(/(?:^|__|[./])cite_lookup$/.test(tool)){const rendered=parseCiteLookupRendering(value);if(rendered)return rendered;}
  if(typeof value==='string'){
   if(value.startsWith('ok\n')){const body=value.slice(3);if(!body.trim())return null;try{return {ok:true,data:JSON.parse(body)};}catch{return {ok:true,data:body};}}
   try{return parse(JSON.parse(value),tool);}catch{return null;}
  }
  if(!value||typeof value!=='object')return null;
  if(typeof value.ok==='boolean')return value.ok===false?{ok:false}:((Object.hasOwn(value,'data')&&value.data!==undefined)||(Object.hasOwn(value,'artifacts')&&value.artifacts!==undefined))?{ok:true,data:value.data,artifacts:value.artifacts}:null;
  if(value.status==='error')return {ok:false};
  if(['ok','success','warning'].includes(value.status))return ((Object.hasOwn(value,'data')&&value.data!==undefined)||(Object.hasOwn(value,'artifacts')&&value.artifacts!==undefined))?{ok:true,data:value.data,artifacts:value.artifacts}:null;
  if(value.isError===true)return {ok:false};
  if(Array.isArray(value.content)){const parsed=value.content.filter(x=>x.type==='text').map(x=>parse(x.text,tool)).filter(Boolean);if(parsed.length===1)return parsed[0];}
  return null;
 };
 for(const message of transcript?.messages??[])for(const part of message.parts??[]){
  if(part.type!=='tool'||!/web_read|web_search|open_access_full_text|literature_search|public_source|pubmed|europe|crossref|frontier|knowledge|memory|capsule|tooluniverse|source_search|cite_lookup/i.test(part.tool??part.name??''))continue;
  if(part.status==='failed'||part.status==='error'||part.error)continue;
  const result=part.status==='completed'?parse(part.output,part.tool??part.name??''):null;
  if(!result){unknownTools.push(part.tool??part.name??'unknown');continue;}
  if(result.ok)responses.push({tool:part.tool??part.name,data:withoutRequestEcho(result.data),artifacts:result.artifacts});
 }
 return {responses,complete:unknownTools.length===0,unknownTools};
}
/**
 * Only unchanged files in this exact run's validated receipt can produce scores/code proof.
 *
 * Two different things were one list until 2026-10-06. `issues` is a file the scoring needs and cannot trust: a file
 * the receipt pins whose bytes differ from the pin, a receipt-pinned JSON that does not parse, a file that cannot be
 * opened inside the workspace. `unverified` is a delivered file the receipt never pinned (a report, a scratch script):
 * scoring never reads it, its text is not handed to any assessor or reviewer (it goes to `auditText`, the citation
 * scan, only), and it is listed here by path so that nothing about it is hidden. On release 6 five of six runs
 * delivered such a file and every one of them made its unit unauditable.
 * @param {any} request */
export async function readPaperGoldArtifacts({project,run,receipt}){
 const deliveredText=[],auditText=[],numeric={},recalledEvidenceIds=[],issues=[],unverified=[],pins=new Map();
 if(receipt?.runId===run.id)for(const entry of receipt.entries??[])for(const file of entry.files??[])if(typeof file.path==="string"&&/^[a-f0-9]{64}$/.test(file.sha256??""))pins.set(file.path,file.sha256);
 for(const artifact of (run.artifacts??[]).filter(row=>/\.(?:json|md|txt|csv|py)$/.test(row.path??row))){
  const relative=artifact.path??artifact;let opened;
  try{normalizeWorkspaceRelativePath(relative,"evaluation artifact");opened=await openScopedFileNoFollow(project.workspaceDir,path.resolve(project.workspaceDir,relative));
   if(!opened.stat.isFile()||opened.stat.size>16*1024*1024)throw new Error("Artifact bounds failed.");
   const bytes=await opened.handle.readFile(),text=bytes.toString("utf8");auditText.push(text);
   if(!pins.has(relative)){unverified.push({path:relative,reason:"not_pinned_by_producer_receipt"});continue;}
   if(pins.get(relative)!==createHash("sha256").update(bytes).digest("hex")){issues.push({path:relative,reason:"producer_receipt_hash_unverified"});continue;}
   deliveredText.push({path:relative,text});if(!relative.endsWith(".json"))continue;
   let value;try{value=JSON.parse(text);}catch{issues.push({path:relative,reason:"numeric_receipt_unreadable"});continue;}
   const visit=(node,prefix="")=>{if(!node||typeof node!=="object")return;for(const [key,v]of Object.entries(node)){const name=prefix?`${prefix}.${key}`:key;if(Number.isFinite(v))numeric[name]=v;else if(v&&typeof v==="object")visit(v,name);}};visit(value);
   for(const source of value.preservedSources??[])if(source.id&&source.sha256)recalledEvidenceIds.push(source.id);
  }catch{issues.push({path:String(relative),reason:"artifact_unavailable_or_outside_scope"});}finally{await opened?.handle.close().catch(()=>{});}
 }
 return {deliveredText,auditText,numeric,recalledEvidenceIds,issues,unverified};
}
/** Whether a no-tool answer shows the paper may be remembered. The model is told to omit what it is unsure
 * of, so requiring every field to match could almost never flag anything: one published number given from
 * memory, within its printed precision, is the signal. A flagged case goes to the development set, which is
 * the cautious side to err on. @param {any} answer @param {any} gold */
export function paperGoldBaselineMemorized(answer, gold) {
  const references = Object.entries(gold.baselineNumeric ?? gold.numeric ?? {});
  return references.some(([key, reference]) => numericScore(answer?.numeric?.[key], reference).valid);
}
/** Metered production evaluator. Hidden definition is never passed to dispatch. @param {any} deps */
export function createPaperGoldEvaluator({ config, usageLedger, store, agentRuns, evaluationIsolation, dispatch, controller, runtimeManager, fetchImpl = fetch }) {
  const dataDir = config.evaluationDataDir || path.join(config.dataDir, "evaluation-control");
  return {
    /** Import a transferred operator receipt without statistical dependencies. @param {any} request */
    async importExistingMethods({ methodId, reportHash }) { return importExistingEngineReceipt({ dataDir, methodId, reportHash }); },
    /** Operator-only direct method ruler; never dispatches a model/runtime or exports gold. @param {any} request */
    async runExistingMethods({ methodId, signal }) {
      if (!/^(meta-reml-published-data|mr-ivw-published-data|faers-ror-published-data)(?:-v[0-9]+)?$/.test(methodId ?? "")) throw new Error("Unsupported existing engine method family.");
      const script = fileURLToPath(new URL("../../../evals/paper-gold/score_existing_methods.py", import.meta.url));
      try {
        const result = await promisify(execFile)("python3", [script, dataDir, methodId], { signal, timeout: 120000, maxBuffer: 65536,
          env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
        const receipt = JSON.parse(result.stdout.trim());
        if (receipt.methodId !== methodId || !/^[a-f0-9]{64}$/.test(receipt.reportHash ?? "")) throw new Error("The method evaluation receipt is invalid.");
        return await importExistingEngineReceipt({ dataDir, methodId, reportHash: receipt.reportHash });
      } catch (error) {
        signal?.throwIfAborted();
        return { ok: false, status: "waiting_resource", resourceCode: "existing_engine_calibration_execution_unavailable", methodId, scored: false };
      }
    },
    /** Derive executable rulers using paid, admitted QA and independently executed public method references. @param {any} request */
    async prepareBenchmarks({ sourceCycleId, cycleId, methodIds = [], rulers = ["method", "research", "question"], caseIds = null }) {
      if (![sourceCycleId, cycleId].every(id => /^[A-Za-z0-9_-]{1,120}$/.test(id))) throw new Error("Invalid benchmark cycle identity.");
      const prior = JSON.parse(await readFile(path.join(dataDir, "paper-gold", "cycles", sourceCycleId, "definition.json"), "utf8"));
      if (prior.hash !== digest({ definition: prior.definition, evaluatorCodeHash: prior.evaluatorCodeHash })) throw new Error("Source calibration hash changed.");
      const methods = [];
      for (const methodId of methodIds) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(methodId)) throw new Error("Invalid method reference identity.");
        const method = JSON.parse(await readFile(path.join(dataDir, "paper-gold", "candidate-cases", `${methodId}.json`), "utf8"));
        try {
          const identities = JSON.parse(await readFile(path.join(dataDir, "paper-gold", "candidate-cases", `${methodId}.identities.json`), "utf8"));
          if (identities.methodId !== methodId || identities.referenceHash !== createHash("sha256").update(JSON.stringify(method)).digest("hex")) throw new Error("Reference identities changed.");
          for (const reference of method.cases) {
            const identity = identities.identities.find(row => row.publicationId === reference.publicationId);
            if (identity) { reference.aliases = [...(reference.aliases ?? []), ...identity.aliases]; reference.title ??= identity.titles[0]; }
          }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        methods.push(method);
      }
      if (!Array.isArray(rulers) || !rulers.length || new Set(rulers).size !== rulers.length || rulers.some(type => !["method", "research", "question"].includes(type))) throw new Error("Select distinct benchmark rulers.");
      const derived = deriveBenchmarkDefinition(prior.definition, methods);
      if (caseIds !== null && (!Array.isArray(caseIds) || !caseIds.length || new Set(caseIds).size !== caseIds.length || caseIds.some(id => !derived.cases.some(row => (row.id === id || row.id === `${id}-question` || row.id === `${id}-research-input-unavailable`) && rulers.includes(row.type))))) throw new Error("Unknown or duplicate selected benchmark case.");
      const definition = { ...derived, selectedCaseIds: caseIds, selectedRulers: rulers, availableByRuler: Object.fromEntries(["method", "research", "question"].map(type => [type, derived.cases.filter(row => row.type === type).length])),
        cases: derived.cases.filter(row => rulers.includes(row.type) && (caseIds === null || caseIds.some(id => row.id === id || row.id === `${id}-question` || row.id === `${id}-research-input-unavailable`))) };
      const frozen = await freezeCycle(dataDir, cycleId, definition);
      return { cycleId, hash: frozen.hash, counts: Object.fromEntries(["method", "research", "question"].map(type => [type, definition.cases.filter(row => row.type === type).length])), missing: definition.benchmarkGaps.length, scored: false };
    },
    /** @param {any} request */
    async prepareCalibration(request) {
      const user = await store.userById(request.userId);
      if (!user) throw new Error("Evaluation operator is unavailable.");
      const projectId = `eval-paper-${createHash("sha256").update(`${request.cycleId}:curation`).digest("hex").slice(0, 40)}`;
      await store.projectFor(user, projectId, "Published-paper calibration curation");
      return createPaperGoldCalibration({ config, usageLedger, fetchImpl }).prepare(request);
    },
    /** @param {any} request */
    async run({ userId, cycleId, definition, signal, jobId = null, maxNewUnits = null }) {
      if (definition.assessmentConfiguration && (definition.assessmentConfiguration.reviewProvider !== config.reviewProvider || definition.assessmentConfiguration.reviewModel !== config.reviewModel)) throw new Error("Assessment models are frozen for this cycle.");
      if (config.reviewProvider === "deepseek") throw new Error("Paper-gold assessment requires a different model family.");
      const user = await store.userById(userId);
      if (!user) throw new Error("Evaluation operator is unavailable.");
      const projectId = `eval-paper-${createHash("sha256").update(`${cycleId}:baseline`).digest("hex").slice(0, 40)}`;
      await store.projectFor(user, projectId, "Published-paper evaluation baseline");
      const adapter = {
        fetchImpl,
        async noToolBaseline({ prompt, numericFields = [] }) {
          const answer = await callModelForControlPlane({ config, usageLedger, fetchImpl }, {
            userId, projectId, purpose: "evolution", limits: { daily: config.evolutionDailyBudgetCny, weekly: 0 }, signal,
            body: { model: "deepseek-flash", messages: [{ role: "system", content: "Without using tools, estimate the principal numerical findings for this research question. Return only JSON {numeric:{}} using exactly the declared output field names as flat numeric keys when known. Do not invent alternative outcome names. If unknown, omit that field; an empty numeric object is permitted." }, { role: "user", content: JSON.stringify({ question: prompt, declaredNumericFields: numericFields }) }], tools: [], tool_choice: "none", response_format: { type: "json_object" }, max_tokens: 1024 },
          });
          const answerText = answer.choices?.[0]?.message?.content ?? "";
          let parsed;
          try { parsed = JSON.parse(answerText); } catch { parsed = { numeric: {}, parseStatus: "invalid_json" }; }
          return { ...parsed, baselineReceipt: { answerText, model: answer.model ?? null, providerRequestId: answer.id ?? null, usage: answer.usage ?? null, responseHash: digest(answer), numericFields } };
        },
        baselineMemorized: paperGoldBaselineMemorized,
        async dispatch({ caseRecord, replicate, attempt = 0 }) {
          const identity = paperGoldDispatchIdentity(cycleId,caseRecord.id,replicate,attempt);
          const unitProjectId = identity.projectId;
          const project = await store.projectFor(user, unitProjectId, "Published-paper isolated evaluation");
          await evaluationIsolation.registerPending({ userId, projectId: unitProjectId }, caseRecord.policy);
          const dispatched = await dispatch({ userId, projectId: unitProjectId, capabilityId: caseRecord.capabilityId, dispatchId: identity.dispatchId, brief: caseRecord.input, evaluationPolicy: caseRecord.policy, jobId });
          const id = dispatched.id ?? dispatched.run?.id;
          if (!id) throw new Error("Evaluation dispatch returned no run id.");
          const deadline = Date.now() + Math.max(60000, config.evolutionEvaluationTimeoutMs ?? 3600000);
          while (Date.now() < deadline) {
            signal?.throwIfAborted();
            const run = (await agentRuns.list(project)).find(row => row.id === id);
            if (run && !["queued", "dispatching", "running"].includes(run.status)) {
              if (run.status !== "succeeded" && run.errorCode === "runtime_spend_limit_reached") throw new PaperGoldAdministrativeDeferral(run, project.id);
              return { project, run };
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          throw new Error("Evaluation run deadline exceeded.");
        },
        async extract({ project, run }) {
          const sealed=await waitPaperGoldTranscript({project,runId:run.id,signal});
          const receipt=await readDeliveryReceipt(project,run).catch(()=>null);
          const artifacts=await readPaperGoldArtifacts({project,run,receipt});
          for(const text of artifacts.auditText)await evaluationIsolation.recordCitations(run.id,text);
          const sourceTrace=paperGoldSourceResponses(sealed.transcript);
          for(const response of sourceTrace.responses)await evaluationIsolation.auditExposure({userId,projectId:project.id,runId:run.id},"transcript-source-response",response);
          const nativeCoverage=sealed.complete?await readPaperGoldNativeCoverage({runtimeManager,project,run,signal}):null;
          const audit=await evaluationIsolation.audit(run.id),traceCoverage=paperGoldTraceCoverage(sealed.transcript,nativeCoverage);
          return {id:run.id,projectId:project.id,numeric:artifacts.numeric,checks:{},recalledEvidenceIds:artifacts.recalledEvidenceIds,modelFamily:"deepseek",nativeEgressProofHash:traceCoverage.nativeCoverageProofHash,exposureTier:paperGoldExposureTier({audit,durableComplete:sealed.complete,traceCoverage,sourceTrace}),gaps:[...(run.status==="succeeded"?[]:["model_capability"]),...(artifacts.issues.length?["extraction"]:[])],assessmentEvidence:{deliveredText:artifacts.deliveredText,artifactIssues:artifacts.issues,unverifiedArtifacts:artifacts.unverified,transcript:sealed.transcript,runStatus:run.status,completeDurableTranscript:sealed.complete,traceCoverage,nativeCoverage,sourceTraceCoverage:{complete:sourceTrace.complete,unknownTools:sourceTrace.unknownTools}}};
        },
        async assess(unit, gold) {
          if (!Object.values(gold.stageChecks ?? {}).some(checks => checks.length)) return unit;
          const frozenDefinition=JSON.parse(await readFile(path.join(dataDir,'paper-gold','cycles',cycleId,'definition.json'),'utf8'));
          const binding={cycleId,frozenHash:frozenDefinition.hash,reviewProvider:config.reviewProvider,reviewModel:config.reviewModel,producerRunId:unit.id,producerProjectId:unit.projectId,goldHash:digest(gold),observedHash:digest(unit.assessmentEvidence),checkNames:[...new Set(Object.values(gold.stageChecks??{}).flat())]};
          const receiptDir=path.join(dataDir,'paper-gold','cycles',cycleId,'stage-assessments');
          const saved=await readPaperGoldAssessment({directory:receiptDir,binding});
          const attach=receipt=>({...bindPaperGoldStageAssessment({result:receipt.response,config,unit,gold}),assessmentReceiptHash:receipt.hash,assessmentReasoningStatus:binding.checkNames.every(name=>typeof receipt.response.value.reasons[name]==='string'&&receipt.response.value.reasons[name].trim())?'preserved':'unknown'});
          if(saved)return attach(saved);
          const result = await callReviewModel({ config, usageLedger, fetchImpl }, {
            userId, projectId, purpose: "evolution", limits: { daily: config.evolutionDailyBudgetCny, weekly: 0 }, signal,
            schemaName: "paper_gold_stages", schema: { type: "object", required: ["checks", "evidenceIds", "gaps", "reasons"], properties: { reasons:{type:"object",additionalProperties:{type:"string"}}, checks: { type: "object", additionalProperties: { type: "boolean" } }, evidenceIds: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string", enum: ["connector", "extraction", "method_missing", "implementation", "routing", "skill_instruction", "writing", "model_capability", "outside_product"] } } } }, maxTokens: 4096,
            messages: [{ role: "system", content: "Judge each named stage check using actual execution logs, source-preservation hashes, deterministic calculation receipts and delivered code, with primary evidence supplied separately. Do not trust the report's self-assessment. Missing proof is false. Evidence recall denominator is reachableEvidenceIds only. Preserve correct inability to reproduce withheld or missing inputs as a supported limitation; never reward fabricated data. Return only named checks, cited evidence IDs, closed gap codes and concise evidence-based reasons keyed by every named check. State missing evidence directly; never invent a reason." }, { role: "user", content: JSON.stringify({ gold, observed: unit.assessmentEvidence, requestedChecks: gold.stageChecks }) }],
          });
          return attach(await preservePaperGoldAssessment({directory:receiptDir,binding,result}));
        },
        comparison: comparisonFromVerifiedUnit,
        async verifyCode({unit,gold}) { return verifyPaperGoldCode({controller,unit,gold,signal}); },
        async review({ evidence, actual, reference, unit, gold, verification: priorVerification }) {
          if (config.reviewProvider === "deepseek") throw new Error("Paper-gold disagreement requires a different model family.");
          const verification = priorVerification ?? await verifyPaperGoldCode({ controller, unit, gold, signal });
          const result = await callReviewModel({ config, usageLedger, fetchImpl }, {
            userId, projectId, purpose: "evolution", limits: { daily: config.evolutionDailyBudgetCny, weekly: 0 }, signal, schemaName: "paper_gold_disagreement", schema: { type: "object", required: ["verdict", "evidenceIds", "reason"], properties: { verdict: { type: "string", enum: ["platform_error", "paper_error", "reasonable_difference"] }, evidenceIds: { type: "array", items: { type: "string" } }, reason: { type: "string" } }, additionalProperties: false },
            messages: [{ role: "system", content: "Adjudicate a research reproduction disagreement using only preserved primary evidence. Cite preserved evidence IDs. Distinguish an implementation error, error in the paper, and a reasonable specification difference. The attached deterministicVerification is a control-plane result of isolated code replay against an independent implementation, not a report self-check. A numerical match does not establish the paper's scientific interpretation; retain uncertainty when source evidence is insufficient. Return the supplied JSON schema." }, { role: "user", content: JSON.stringify({ evidence, actual, reference, deterministicVerification: verification }) }], maxTokens: 4096,
          });
          return bindPaperGoldReview({ result, config, unit, gold, verification });
        },
      };
      return runCycle({ dataDir, cycleId, definition, adapter, signal, maxNewUnits });
    },
  };
}
