import { evolutionProposalIssues } from '../../../packages/domain/src/evolutionSelection.mjs';
import { validatePlatformSkillPackage } from './platformSkillPackage.mjs';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {HttpError} from './security.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
/** The builder sees development inputs and case IDs only. Publication takes a trusted evaluator
 * verdict, never a candidate's own assertion that it passed. @param {any} dependencies */
export function createEvolutionBuilder({dispatch,verification,evaluator,publisher,writeEnginePrInput,recordFailure=async()=>{},compareDevelopment=undefined,validateDevelopment=undefined,screenCandidate=undefined}){
  return{async build(card,{signal=undefined}={}){
    let stage='candidate-delivery';
    try {
    const input=structuredClone(Object.fromEntries(['id','methodId','track','goal','capabilityIds','toolKind','publicationKind','form','callableContract','developmentBasis','developmentCases','dataRequirements','dependencies','implementationOptions','estimatedBudget','parentToolIds','executionTools','selectedPath','proposal','lineageId','round','rounds'].filter(key=>card[key]!==undefined).map(key=>[key,card[key]])));
    const candidate=await dispatch(input,{signal});
    if(candidate?.status==='impossible'){
      const failure={cardId:card.id,code:'method_implementation',reason:String(candidate.reason??'Unable to faithfully implement the method.').slice(0,2000),wakeConditions:candidate.wakeConditions??['new_method','new_data','new_tool','new_model']};
      await recordFailure(failure);return{status:'impossible',failure};
    }
    if(!candidate||!['skill','isolated-tool','engine-pr'].includes(candidate.publicationKind))throw new HttpError(400,'extension_contract_invalid','The builder returned an invalid candidate.');
    const selection=candidate.publicationKind==='isolated-tool'&&compareDevelopment?await compareDevelopment(candidate,input,{signal}):{candidate,comparison:{status:'comparison-unavailable',ranked:false,options:[]}};
    const snapshot=structuredClone(selection.candidate);snapshot.developmentComparison=selection.comparison;const digest=`sha256:${sha(canonicalJson(snapshot.files??{}))}`;
    const sourceText=Object.values(snapshot.files??{}).join('\n');
    const forbidden=(input.developmentCases??[]).map(item=>item.id).filter(value=>typeof value==='string'&&value.length>=8);
    const leakage=forbidden.some(value=>sourceText.includes(value))||/(?:evaluation-control|candidate-cases|candidate-evaluations|absoluteTolerance|evaluatorHash|frozenSourceDigest|paper-gold\/evaluator)/.test(sourceText);
    if(leakage)return{status:'repair',feedback:{passed:false,failedCaseIds:[],issueCodes:['candidate-evaluation-leakage']}};
    if(screenCandidate){const screen=await screenCandidate(snapshot,input,{signal});if(screen?.ok!==true)return{status:screen?.resourcePending?'waiting_resource':'repair',feedback:{passed:false,failedCaseIds:[],issueCodes:screen?.issueCodes??['candidate-screening-failed']}};}
    const proposal=snapshot.proposal??input.proposal;
    if(evaluator.freezeCandidate&&!proposal)return{status:'repair',feedback:{passed:false,failedCaseIds:[],issueCodes:['candidate-proposal-required']}};
    if(proposal){const issueCodes=evolutionProposalIssues(proposal);if(issueCodes.length)return{status:'repair',feedback:{passed:false,failedCaseIds:[],issueCodes}};}
    stage='static-verification';
    const verificationResult=await verification.verify(snapshot,{signal});
    if(!verificationResult.ok){const issues=(verificationResult.issues??[]).slice(0,100).map(item=>({code:String(item.code).slice(0,120),message:String(item.message??item.code).slice(0,2000),...(typeof (item.path??item.field)==='string'&&Object.hasOwn(snapshot.files??{},item.path??item.field)?{path:item.path??item.field}:{})}));await recordFailure({cardId:card.id,code:'method_implementation',issueCodes:verificationResult.issues.map(item=>item.code)});return{status:'repair',feedback:{passed:false,failedCaseIds:[],issueCodes:issues.map(item=>item.code),issues}};}
    if(snapshot.publicationKind==='engine-pr'){
      if(!writeEnginePrInput)throw new HttpError(503,'product_state_unavailable','Engine review preparation is unavailable.');
      const development=validateDevelopment?await validateDevelopment(snapshot,{signal}):{ok:false,status:'waiting_resource',issues:[{code:'development-validator-unavailable'}]};
      stage='engine-review';
      const review=await writeEnginePrInput({card:input,candidate:snapshot,digest,validation:{static:verificationResult,development}});return{status:'review',review,digest};
    }
    const packageCheck=validatePlatformSkillPackage(snapshot,{card:input});
    if(!packageCheck.ok){
      const issues=packageCheck.issues;
      await recordFailure({cardId:card.id,code:'method_implementation',gapCode:'method-implementation',issueCodes:issues.map(issue=>issue.code),stage:'public-package'});
      return{status:'repair',feedback:{passed:false,failedCaseIds:[],issueCodes:issues.map(issue=>issue.code),issues}};
    }
    if(validateDevelopment){
      const development=await validateDevelopment(snapshot,{signal});
      snapshot.developmentValidation=development;
      if(!development.ok)return{status:development.status==='waiting_resource'?'waiting_resource':'repair',feedback:{passed:false,failedCaseIds:[],issueCodes:(development.issues??[]).map(issue=>issue.code),issues:(development.issues??[]).map(issue=>({code:issue.code,caseId:issue.caseId}))}};
    }
    stage='candidate-freeze';
    if(evaluator.freezeCandidate)await evaluator.freezeCandidate(snapshot,{card:input});
    stage='hidden-evaluation';
    const evaluation=await evaluator.evaluate(snapshot,{signal,card:input,purpose:'confirmation'});
    await evaluator.recordFeedback?.(evaluation,{lineageId:input.lineageId??input.id,candidateDigest:digest});
    // Return only pass/fail and opaque case identities to the research agent. Opaque is made here, not assumed: a hidden
    // case's own id can name its publication ("darth-time-dependent", "marker-net-benefit"), which is what the gateway
    // exclusion exists to hide. The token is stable for one frozen definition, so repeated failures can still be told apart.
    // `issueCodes` here is a closed code such as candidate_generalisation_failed: which derived input failed stays with the evaluator.
    const feedback={passed:evaluation.ok===true,failedCaseIds:(evaluation.failedCaseIds??[]).map(id=>`case-${sha(`${evaluation.evaluatorHash??''}:${String(id)}`).slice(0,16)}`),...(Array.isArray(evaluation.issueCodes)&&evaluation.issueCodes.length?{issueCodes:evaluation.issueCodes.map(code=>String(code).slice(0,120))}:{})};
    if(evaluation.ok && (!evaluation.candidateFreeze || evaluation.candidateFreeze.artifactDigest!==digest || evaluation.confirmatory!==true || !/^[a-f0-9]{64}$/.test(evaluation.evaluationReceiptHash??'')))throw new HttpError(422,'extension_contract_invalid','Publication requires a frozen candidate and fresh confirmation receipt.');
    if(!evaluation.ok){
      if(evaluation.status!=='waiting_resource' && feedback.failedCaseIds.length) await recordFailure({cardId:card.id,code:'method_implementation',gapCode:'method-implementation',failedCaseIds:feedback.failedCaseIds});
      return{status:evaluation.status==='waiting_resource'?'waiting_resource':'repair',feedback};
    }
    if(`sha256:${sha(canonicalJson(snapshot.files??{}))}`!==digest)throw new HttpError(409,'extension_contract_invalid','Candidate bytes changed during evaluation.');
    stage='publication';
    const publication=await publisher.publish(snapshot,{card:input,evaluation});return{status:'published',publication,feedback,digest};
    } catch(error) {
      const status=error?.status??error?.statusCode;
      const packageInvalid=error?.code==='extension_contract_invalid' && [400,422].includes(status);
      const deliveryInvalid=stage==='candidate-delivery' && error?.code==='evolution_output_invalid' && [400,413,422].includes(status);
      if(!packageInvalid && !deliveryInvalid) throw error;
      const issue={code:error.code,stage,message:stage==='engine-review'||deliveryInvalid?String(error.message).slice(0,2000):'The candidate does not satisfy its declared public package contract.'};
      await recordFailure({cardId:card.id,code:'method_implementation',gapCode:'method-implementation',issueCodes:[issue.code],stage});
      return {status:'repair',feedback:{passed:false,failedCaseIds:[],issueCodes:[issue.code],issues:[issue]}};
    }
  }};
}
