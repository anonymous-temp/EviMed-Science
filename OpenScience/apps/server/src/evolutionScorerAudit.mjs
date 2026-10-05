import { verifyPaperGoldCode } from './paperGoldVerification.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {numericScore, digest, STAGES} from '../../../evals/paper-gold/evaluator.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Scope follows the frozen ruler, never the current reviewer prompt. @param {any} gold @param {any} reviewed @param {string} [exposureTier] */
export function scorerAuditVerdict(gold,reviewed,exposureTier) {
 const applicableStageIDs=gold.applicableStages ?? (gold.type==='method'?['method','calculation']:STAGES);
 if(!['method','research','question'].includes(gold.type) || !Array.isArray(applicableStageIDs) || applicableStageIDs.some(stage=>!STAGES.includes(stage))) throw new Error('Invalid frozen audit ruler scope.');
 const valid=stage=>reviewed.stages?.[stage]?.observed===true && reviewed.stages?.[stage]?.valid===true;
 return {auditedRuler:gold.type,applicableStageIDs,allStagesValid:gold.inputAvailable!==false && applicableStageIDs.every(valid),fullResearchReproductionValid:gold.type==='research' && gold.inputAvailable!==false && ['unexposed','exposed_uncited','exposed-unreferenced','cited'].includes(exposureTier??'unknown') && STAGES.every(valid)};
}
const modelFamily=model=>/^qwen/i.test(model??'')?'qwen':/^deepseek/i.test(model??'')?'deepseek':'unknown';
/**
 * Control-only sampling: original verdicts and gold are never rewritten.
 *
 * What a finding may be called. The stage verdicts of a unit are a model's, and this audit asks a model
 * to read the same evidence again. When the second reader is of the same family as the first (today
 * both are the review model), agreement between them is not independent confirmation, so such a finding
 * is recorded as `same-family-reread` with `independentOfAssessor: false`, and only a reader of another
 * family is `reviewed`. The parts that are code (numbers re-scored against the frozen gold, the isolated
 * replay of delivered code) are independent of every model and are reported as such. The record states
 * the discrepancy rate it found; no threshold is applied to it, because none has been measured yet.
 * @param {any} dependencies */
export function createEvolutionScorerAudit({service,config,readEvidence,review,controller}) {
  return { /** @param {{day:string,signal?:AbortSignal}} input */
    async run({day,signal}) {
      const id = `evolution-scorer-audit-${day}`;
      const prior = await service.get(id); if (prior?.payload.status === 'complete') return prior;
      const root = path.join(config.evaluationDataDir || path.join(config.dataDir,'evaluation-control'),'paper-gold','cycles');
      let names; try {names = await fs.readdir(root);} catch(error) {if(error.code!=='ENOENT') throw error; names=[];}
      const candidates=[];
      for(const name of names.filter(value=>/^[a-zA-Z0-9_-]+$/.test(value)).sort()) {
        signal?.throwIfAborted();
        let frozen,report;
        try {frozen=JSON.parse(await fs.readFile(path.join(root,name,'definition.json'),'utf8'));report=JSON.parse(await fs.readFile(path.join(root,name,'report.json'),'utf8'));} catch(error) {if(error.code==='ENOENT') continue; throw error;}
        if(frozen.hash!==digest({definition:frozen.definition,evaluatorCodeHash:frozen.evaluatorCodeHash})) throw new Error('Frozen scorer definition integrity differs.');
        if(report.complete!==true || report.evaluatorHash!==frozen.hash) continue;
        for(const unit of report.units??[]) {
          const testCase=frozen.definition?.cases?.find(row=>row.id===unit.caseId);
          if(testCase?.gold && unit.producerRunId && unit.producerProjectId) candidates.push({cycleId:name,unit,gold:{...testCase.gold,type:testCase.type},frozenHash:frozen.hash,reportHash:hash(report)});
        }
      }
      candidates.sort((a,b)=>hash([day,a.cycleId,a.unit.caseId,a.unit.producerRunId]).localeCompare(hash([day,b.cycleId,b.unit.caseId,b.unit.producerRunId])));
      const findings=[...(prior?.payload.findings??[])];
      let checkpoint=prior;
      for(const sample of candidates.slice(0,3)) {
        signal?.throwIfAborted();
        if(findings.some(row=>row.cycleId===sample.cycleId && row.producerRunId===sample.unit.producerRunId && row.caseId===sample.unit.caseId)) continue;
        const evidence=await readEvidence(sample.unit,{signal});
        const identity={cycleId:sample.cycleId,caseId:sample.unit.caseId,producerRunId:sample.unit.producerRunId,producerProjectId:sample.unit.producerProjectId,frozenHash:sample.frozenHash,reportHash:sample.reportHash,originalVerdictHash:hash(sample.unit),sourceHash:sample.gold.sourceHash??null};
        if(!evidence?.transcript || evidence.transcript.header?.completeness!=='complete' || evidence.completeDurableTranscript===false || evidence.traceCoverage?.complete===false) {findings.push({...identity,status:'waiting-evidence',discrepancy:null});continue;}
        if(evidence.artifactIssues?.length) {findings.push({...identity,status:'waiting-control-proof',discrepancy:null});continue;}
        let computationProof=null;
        if(Object.keys(sample.gold.numeric??{}).length) {
          if(!sample.gold.deterministicVerification || !sample.unit.verificationProof?.codeHash) {findings.push({...identity,status:'waiting-control-proof',discrepancy:null});continue;}
          computationProof=await verifyPaperGoldCode({controller,unit:{numeric:evidence.numeric,assessmentEvidence:{deliveredText:evidence.deliveredText}},gold:sample.gold,signal});
          if(computationProof.verified!==true || computationProof.proof?.codeHash!==sample.unit.verificationProof.codeHash) {findings.push({...identity,status:'waiting-control-proof',discrepancy:null});continue;}
        }
        const reviewed=await review({gold:sample.gold,observed:evidence,signal});
        const allowedEvidence=new Set([sample.gold.sourceHash,...(sample.gold.reachableEvidenceIds??[]),...(sample.gold.evidenceIds??[])].filter(value=>typeof value==='string'));
        if(reviewed.independent!==true || !reviewed.model || !reviewed.evidenceIds?.length || reviewed.evidenceIds.some(evidenceId=>!allowedEvidence.has(evidenceId))) throw new Error('Scorer audit requires an actual independent evidence-citing review.');
        if(computationProof?.verified===true) reviewed.stages={...reviewed.stages,calculation:{observed:true,valid:true}};
        const verdict=scorerAuditVerdict(sample.gold,reviewed,sample.unit.exposureTier);
        const references=Object.entries(sample.gold.numeric??{});
        const deterministic=evidence.numeric && references.length ? references.every(([key,reference])=>numericScore(evidence.numeric[key],reference).valid) : null;
        const assessorFamily=modelFamily(sample.unit.assessmentModel),auditorFamily=modelFamily(reviewed.model);
        const independentOfAssessor=assessorFamily!=='unknown' && auditorFamily!=='unknown' && assessorFamily!==auditorFamily;
        findings.push({...identity,status:independentOfAssessor?'reviewed':'same-family-reread',independentOfAssessor,assessorModel:sample.unit.assessmentModel??null,evidenceHash:hash(evidence),reviewModel:reviewed.model,reviewEvidenceIds:reviewed.evidenceIds,
          controlProofHash:computationProof?.proof?.proofHash??null,auditedRuler:verdict.auditedRuler,applicableStageIDs:verdict.applicableStageIDs,reassessedFullResearchReproductionValid:verdict.fullResearchReproductionValid,reassessedAllStagesValid:verdict.allStagesValid,deterministicNumericPassed:deterministic,
          discrepancy:verdict.allStagesValid!==sample.unit.allStagesValid || (deterministic!==null && deterministic!==Object.values(sample.unit.numeric??{}).every((/** @type {any} */ item)=>item.valid===true)) || false});
        checkpoint=await service.save('scorer-audit',id,{day,status:'running',findings:[...findings]},checkpoint);
      }
      const compared=findings.filter(row=>typeof row.discrepancy==='boolean');
      return service.save('scorer-audit',id,{day,status:'complete',observedAt:service.now().toISOString(),eligibleUnits:candidates.length,sampled:findings.length,findings,discrepancies:findings.filter(row=>row.discrepancy).length,
        reviewed:findings.filter(row=>row.status==='reviewed').length,sameFamilyRereads:findings.filter(row=>row.status==='same-family-reread').length,
        discrepancyRate:compared.length?compared.filter(row=>row.discrepancy).length/compared.length:null,discrepancyThreshold:null,
        scope:'Scorer audit only; no gold, original verdict, or promotion changes. A same-family reread is not an independent review; numeric re-scoring and code replay are code.'},checkpoint);
    }
  };
}
