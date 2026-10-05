import path from 'node:path';
import {parse} from 'yaml';
import {HttpError} from './security.mjs';
import {createHash} from 'node:crypto';
import {canonicalJson,validateCapabilityManifest} from '@evimed/domain';
import {writeFileExclusiveNoFollow} from './security.mjs';
const shellQuote=value=>"'"+String(value).replaceAll("'", "'\\''")+"'";
/** Prepare review input only. Development pipelines may turn it into a PR; generated agents
 * never obtain authority to edit platform source or merge/deploy it. @param {any} config */
export function createEvolutionEngineReviewWriter(config){
  return async({card,candidate,digest})=>{
    const files=candidate.files??{};
    let capability=null,pendingContracts=[];
    if(card.form==='new-capability'||candidate.form==='new-capability'){
      const names=Object.keys(files), manifests=names.filter(name=>/(^|\/)capability\.yaml$/.test(name));
      if(manifests.length!==1)throw new HttpError(422,'extension_contract_invalid','A new capability requires exactly one capability.yaml.');
      try{capability=parse(files[manifests[0]]);}catch{throw new HttpError(422,'extension_contract_invalid','The capability manifest is invalid YAML.');}
      const skill=names.some(name=>/(^|\/)SKILL\.md$/.test(name)&&String(files[name]).trim());
      const contract=names.some(name=>/(^|\/)contracts?\/[^/]+\.(?:json|md|yaml)$/.test(name)&&String(files[name]).trim());
      const briefs=names.filter(name=>/(^|\/)(?:task-briefs|taskbooks|tasks)\/[^/]+\.(?:json|md|yaml)$/.test(name)&&String(files[name]).trim());
      const validation=validateCapabilityManifest(capability);
      pendingContracts=(capability?.produces??[]).filter(item=>validation.issues.some(issue=>issue.code==='contract_kind_unknown'&&issue.message.includes('"'+item.contractKind+'"'))).map(item=>item.contractKind);
      const admissible=validation.issues.every(issue=>issue.code==='contract_kind_unknown')&&pendingContracts.every(kind=>typeof kind==='string'&&/^[a-z0-9-]+$/.test(kind)&&names.some(name=>new RegExp('(^|/)contracts?/'+kind+'\\.(json|md|yaml)$').test(name)&&String(files[name]).trim()));
      if(!admissible||capability.display?.listed!==false||!skill||!contract||new Set(briefs.map(name=>createHash('sha256').update(String(files[name]).trim()).digest('hex'))).size<3)throw new HttpError(422,'extension_contract_invalid','A new capability requires an unlisted manifest, skill, contract and at least three task briefs.');
    }
    const body=`${card.goal??'Implement the proposed literature-grounded engine change.'}\n\nCandidate digest: ${digest}\n\nValidation: replay the attached development cases and independent published reference examples before merging. New contracts require reviewed domain registration before this capability can be activated.\n\nThe proposal has not modified production source or clinical safety rules.\n`;
    const manifest={schemaVersion:1,prBodyDigest:`sha256:${createHash('sha256').update(body).digest('hex')}`,cardId:card.id,candidateId:candidate.id??card.id,digest,goal:card.goal??null,lineage:candidate.lineage??null,developmentCases:card.developmentCases??[],requestedChanges:candidate.requestedChanges??[],files:candidate.files??{}};
    const identity=createHash('sha256').update(canonicalJson(manifest)).digest('hex'),root=path.join(config.dataDir,'.openscience','evolution-engine-review',identity);
    await writeFileExclusiveNoFollow(config.dataDir,path.join(root,'manifest.json'),canonicalJson(manifest)+'\n',{mode:0o444}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    await writeFileExclusiveNoFollow(config.dataDir,path.join(root,'pr-body.txt'),body,{mode:0o444}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    return{kind:'engine-review-input',identity,digest,cardId:card.id,candidateId:candidate.id??card.id,relativeDirectory:path.relative(config.dataDir,root),form:capability?'new-capability':'engine',capabilityId:capability?.id??null,prepareCommand:`node OpenScience/scripts/dev/open-evolution-pr.mjs --staging=${shellQuote(root)} --dry-run`,diagnostics:pendingContracts.map(contractKind=>({code:'pending-domain-registration',contractKind})),files:['manifest.json','pr-body.txt']};
  };
}
