/** Exact claim/source support and separately named finding-expression observations. */
import { createHash } from 'node:crypto';
import { canonicalJson, geoClaimAssessmentIdentity, geoClaimApplicability, geoClaimForStatement, PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { geoJourneyClaimSupport, geoEvidenceSupportIndex } from './geoAnalysisEvidence.mjs';
import { claimFromRow } from './geoStore.mjs';
import { readEvidenceCardRevisions } from './evidenceZoneService.mjs';
import { readStoredSourceChanges, sourceIdentifiersOf } from './sourceChanges.mjs';
import { readGeoValueCoverage } from './geoValueStore.mjs';
import { geoAssessmentId } from './geoLearningSignals.mjs';
import { HttpError } from './security.mjs';
const list=value=>Array.isArray(value)?value:[];
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const byId=items=>{const index=new Map();for(const item of list(items)){if(typeof item?.id!=='string'||!item.id)continue;if(!index.has(item.id))index.set(item.id,[]);index.get(item.id).push(item);}return index;};
const bounded=rows=>{if(rows.length>20000)throw new HttpError(422,'geo_read_filter_invalid','Narrow the scope to at most 20,000 evidence records.');return rows;};
const clinicalColumns=[['observations','陈述判定记录'],['supported','依据已核实且表达一致'],['contradicted','依据已核实但表达冲突'],['needsVerification','待核实'],['updateNeeded','依据或判定需更新']];
const findingColumns=[['observations','发现表达记录'],['represented','已记录完整表达'],['partial','已记录部分表达'],['contradicted','已记录相反表达'],['not_addressed','完整判定中未表达'],['not_applicable','完整判定中不适用'],['uncertain','尚无法确定']];

/** Read only through the selected analysis transaction. Current source annotations never impersonate sampling-time facts. */
export async function readGeoSupportContext(store,project,selected,{evidenceKind='claims'}={}){
  if(evidenceKind==='findings'){
    const coverage=await readGeoValueCoverage(store,project.id,{}, {project,selected});
    const versions=[...new Set((coverage.observations??[]).map(item=>item.basisVersion).filter(value=>Number.isSafeInteger(value)&&value>0))];
    const profiles=bounded((await store.query(`SELECT version,data FROM evimed_geo.value_profiles WHERE geo_project_id=$1 AND user_id=$2
      AND version=ANY($3::integer[]) ORDER BY version LIMIT 20001`,[project.id,project.userId,versions])).rows);
    return {valueObservations:coverage.observations??[],profiles};
  }
  const rows=selected.rows??[], snapshotIds=rows.map(row=>row.snapshotId),snapshotSet=new Set(snapshotIds);
  const assessmentRecords=bounded((await store.query(`SELECT d.id,d.revision,d.payload,
      first.revision AS original_revision,CASE WHEN first.payload->>'recordType'='geo-assessment'
        AND first.payload->>'geoProjectId'=$3 AND first.payload->>'projectId'=$2
        AND first.payload->>'snapshotId'=d.payload->>'snapshotId' THEN first.payload ELSE NULL END AS original_payload
      FROM evimed_product.documents d
    LEFT JOIN LATERAL (SELECT r.revision,r.payload FROM evimed_product.revisions r
      WHERE r.user_id=d.user_id AND r.kind=d.kind AND r.id=d.id
      ORDER BY r.revision ASC LIMIT 1) first ON true
    WHERE d.user_id=$1 AND d.project_id=$2 AND d.kind='knowledge' AND d.deleted_at IS NULL
      AND d.payload->>'recordType'='geo-assessment' AND d.payload->>'geoProjectId'=$3 AND d.payload->>'projectId'=$2
      AND d.id=ANY($4::text[]) ORDER BY d.id LIMIT 20001`,[project.userId,project.projectId,project.id,snapshotIds.map(geoAssessmentId)])).rows)
    .filter(row=>row.id===geoAssessmentId(row.payload.snapshotId)&&snapshotSet.has(row.payload.snapshotId));
  const frozen=list(selected.rounds).flatMap(round=>list(round.ref?.evaluationBasis?.claims));
  const bases=assessmentRecords.flatMap(row=>list(row.payload.assessment?.basis));
  const ids=[...new Set([...frozen,...bases].map(claim=>claim.id).concat(rows.flatMap(row=>list((row.assessmentFacts??row.facts)?.statements).map(statement=>statement.claimId))).filter(Boolean))];
  const claims=bounded((await store.query(`SELECT *,valid_until<=transaction_timestamp() AS expired FROM evimed_geo.claims
    WHERE geo_project_id=$1 AND user_id=$2 AND id=ANY($3::text[]) ORDER BY id LIMIT 20001`,[project.id,project.userId,ids])).rows).map(row=>({...claimFromRow(row),expired:row.expired}));
  const refs=[...new Map([...frozen,...bases].filter(claim=>claim.cardId&&Number.isSafeInteger(claim.cardRevision)&&claim.cardRevision>0)
    .map(claim=>[`${claim.cardId}@${claim.cardRevision}`,{cardId:claim.cardId,revision:claim.cardRevision}])).values()];
  const cards=await readEvidenceCardRevisions(store,project,refs);
  const identifiers=[...new Set(cards.flatMap(card=>list(card.at?.sources).flatMap(sourceIdentifiersOf)))],changes=new Map();
  for(let offset=0;offset<identifiers.length;offset+=500)
    for(const [key,value] of await readStoredSourceChanges(store,PLATFORM_PUBLISHER_USER_ID,identifiers.slice(offset,offset+500)))changes.set(key,value);
  const readAt=(await store.query('SELECT transaction_timestamp() AS at')).rows[0].at.toISOString();
  return {claims,cards,sourceChanges:[...changes.values()],assessmentRecords,readAt};
}

/** A preserved assessment can resolve bytes only through its exact identity and digests, never a newer head. */
function claimFor(statement,assessment,frozen,current,basisRows){
  const candidates=list(basisRows).filter(basis=>basis.id===statement.claimId
    && (statement.claimVersion==null||basis.version===statement.claimVersion)
    && (statement.applicability==null||canonicalJson(basis.applicability)===canonicalJson(geoClaimApplicability(statement))));
  const basis=candidates.length===1?candidates[0]:null;
  if(assessment&&Object.hasOwn(assessment,'basis')&&!basis)return null;
  const matches=claim=>claim.id===(basis?.id??statement.claimId)
    && (basis?.version??statement.claimVersion)===(claim.version??null)
    && (!basis||geoClaimAssessmentIdentity(claim)===basis.identity&&hash(claim.quote??'')===basis.quoteDigest&&hash(claim.statement??'')===basis.statementDigest&&claim.sourceRef===basis.sourceRef);
  let claim=basis?frozen.find(matches)??current.find(matches):geoClaimForStatement(frozen,statement);
  if(!claim)return null;
  claim={...claim};
  if(basis)Object.assign(claim,{cardId:basis.cardId,cardRevision:basis.cardRevision,cardClaimId:basis.cardClaimId,sourceRef:basis.sourceRef,applicability:basis.applicability});
  return claim;
}
function currentClaimContext(claim,support){
  if(!claim)return null;
  const current=list(support.claims).find(row=>row.id===claim.id&&row.version===claim.version);
  const at=Date.parse(support.readAt??''),until=Date.parse(claim.validUntil??'');
  return {...claim,...(current?{status:current.status}:{}),expired:claim.validUntil&&Number.isFinite(at)&&Number.isFinite(until)?until<=at:current?.validUntil===claim.validUntil?current?.expired:undefined};
}

/** Each row has one declared unit. Finding expression is a separate view, never source support. */
export function buildGeoSupportAnalysis(selected,view,context={}){
  const support=context.support??{}, findings=view.evidenceKind==='findings',unit=findings?'finding_observations':'statement_assessments';
  const supportIndex=geoEvidenceSupportIndex(support);
  const dependencies={...support};delete dependencies.readAt;
  const columns=(findings?findingColumns:clinicalColumns).map(([key,label])=>({key,label,unit,type:'number'}));
  const buckets=new Map(),memberItems=new Map(),rounds=new Map(list(selected.rounds).map(round=>[round.id,round]));
  const frozenClaims=new Map(list(selected.rounds).map(round=>[round.id,byId(round.ref?.evaluationBasis?.claims)])),currentClaims=byId(support.claims);
  const records=new Map(list(support.assessmentRecords).map(record=>[record.payload.snapshotId,record]));
  const create=(identity,label,dimensions)=>{
    const key=hash([view.evidenceKind??'claims',identity]);
    if(!buckets.has(key))buckets.set(key,{key,label,metricId:null,dimensions,values:{},items:Object.fromEntries(columns.map(column=>[column.key,[]]))});
    return buckets.get(key);
  };
  if(findings){
    for(const observation of list(support.valueObservations)){
      const frozen=rounds.get(observation.roundId)?.ref?.evaluationBasis?.value;
      const profile=frozen?.version===observation.basisVersion?frozen:list(support.profiles).find(candidate=>Number(candidate.version)===observation.basisVersion);
      const finding=list(profile?.data?.findings).find(candidate=>candidate.id===observation.findingId)??null;
      const identity=[observation.findingId,observation.basisVersion,hash(finding)];
      const row=create(identity,`发现表达 · ${finding?.statement??observation.findingId??'未保留发现标识'} · 版本 ${observation.basisVersion??'未知'}`,{
        kind:'finding_expression',findingId:observation.findingId??null,basisVersion:observation.basisVersion,finding,definitionState:finding?'known':'unknown',temporalBasis:'stored_judgment'});
      const item={...observation,unit,finding,definitionState:finding?'known':'unknown',temporalBasis:'stored_judgment'};
      row.items.observations.push(item);
      const category=findingColumns.some(([key])=>key===observation.status)&&observation.status!=='observations'?observation.status:'uncertain';
      row.items[category].push(item);
    }
  }else{
    let observationCount=0;
    for(const answer of list(selected.rows)){
      const record=records.get(answer.snapshotId),assessment=record?.payload.assessment??answer.facts;
      const frozen=frozenClaims.get(answer.roundId)??new Map(),bases=byId(assessment?.basis);
      for(const [position,statement] of list(assessment?.statements).entries()){
        if(++observationCount>20000)throw new HttpError(422,'geo_read_filter_invalid','Narrow the scope to at most 20,000 statement assessments.');
        const preserved=claimFor(statement,assessment,frozen.get(statement.claimId)??[],currentClaims.get(statement.claimId)??[],bases.get(statement.claimId)??[]),claim=currentClaimContext(preserved,{...support,claims:currentClaims.get(statement.claimId)??[]});
        const source=claim?geoJourneyClaimSupport(claim,supportIndex):{verificationState:'unknown',reason:'preserved_claim_unavailable',sourceChanges:[],preservedQuoteVerification:null};
        const identity=preserved?geoClaimAssessmentIdentity(preserved):geoClaimAssessmentIdentity(statement);
        const basis={claimId:preserved?.id??statement.claimId??null,claimVersion:preserved?.version??statement.claimVersion??null,
          applicability:preserved?geoClaimApplicability(preserved):geoClaimApplicability(statement),cardId:preserved?.cardId??null,cardRevision:preserved?.cardRevision??null,
          cardClaimId:preserved?.cardClaimId??null,sourceRef:preserved?.sourceRef??null,quoteDigest:preserved?hash(preserved.quote??''):null,statementDigest:preserved?hash(preserved.statement??''):null};
        const row=create([identity,basis],`${preserved?.statement??'主张依据未保留'} · 版本 ${basis.claimVersion??'未知'}`,{kind:'clinical_source_support',...basis,evidenceLevel:basis.applicability?.evidenceLevel??null,temporalBasis:'current_source_context'});
        const assessmentState=record?.payload.state??'unrecorded';
        const assessmentReason=!['valid','refusal'].includes(answer.status)?'sample_not_returned':
          typeof assessment?.judgedAt!=='string'||!Number.isFinite(Date.parse(assessment.judgedAt))?'judgment_time_unavailable':null;
        const item={id:JSON.stringify([answer.snapshotId,position,record?.payload.assessmentVersion??assessment?.judgedAt??null]),unit,
          snapshotId:answer.snapshotId,questionId:answer.questionId,engine:answer.engine,roundId:answer.roundId,askedAt:answer.askedAt??null,
          judgedAt:assessment?.judgedAt??null,statement,claimStatement:preserved?.statement??null,quote:preserved?.quote??null,...basis,...source,
          assessmentVersion:record?.payload.assessmentVersion??assessment?.assessmentVersion??null,assessmentState,assessmentReason,
          temporalBasis:record?'current_assessment_of_selected_answer':'stored_judgment',assessmentReference:record?{id:record.id,revision:record.revision}:null,
          originalAssessment:record?.original_payload?.assessment?{referenceId:record.id,revision:record.original_revision,
            assessmentVersion:record.original_payload.assessmentVersion??null,temporalBasis:'first_preserved_assessment',
            assessment:record.original_payload.assessment}:null};
        const outdated=['source_update_needed','card_withdrawn','claim_inactive','claim_expired'].includes(source.reason)||['invalidated','suspended','excluded'].includes(assessmentState);
        const category=outdated?'updateNeeded':assessmentReason||source.verificationState!=='verified'?'needsVerification':statement.verdict==='correct'?'supported':statement.verdict==='wrong'?'contradicted':'needsVerification';
        row.items.observations.push(item);row.items[category].push(item);
      }
    }
  }
  const rows=bounded([...buckets.values()]).sort((a,b)=>a.key.localeCompare(b.key));
  for(const row of rows){
    row.dimensions.objects=row.items.observations;
    for(const column of columns){
      const items=row.items[column.key],unknown=!findings&&['supported','contradicted'].includes(column.key)?row.items.needsVerification.length:0;
      row.values[column.key]={value:unknown&&!items.length?null:items.length,state:unknown?items.length?'partial':'unknown':'known',
        reason:unknown?'verification_basis_incomplete':null,unit,metric:null,members:null,...(unknown?{knownSubtotal:items.length,unknownCandidates:unknown}:{})};
      if(!unknown||items.length)memberItems.set(`${row.key}:${column.key}`,items);
    }
    delete row.items;
  }
  const incomplete=findings?rows.some(row=>row.dimensions.definitionState==='unknown'):
    rows.some(row=>row.values.needsVerification.value>0);
  return {definition:{methodVersion:'exact-claim-source-support-v1',countingRule:findings?'Finding-expression observations grouped by exact finding/version and preserved definition; not medical source verification.':'Distinct statement-assessment positions grouped by exact claim/version/applicability/card/source identities. Correct or wrong is the stored assessment of the answer, not proof of the clinical claim itself.',denominatorRule:'Recorded observations only. Missing source/claim/assessment coverage remains unknown; current source annotations do not replace sampling-time evidence.'},
    contextualBasis:[{kind:findings?'finding_expression':'claim_source_support',temporalBasis:findings?'stored_judgment':'current_source_context',digest:hash(dependencies)}],columns,rows,
    chart:{kind:'evidence',labels:rows.map(row=>row.label),series:[],cells:rows.flatMap(row=>columns.map(column=>({rowKey:row.key,columnKey:column.key,label:row.label,...row.values[column.key]})))},
    availability:{status:rows.length?incomplete?'partial':'available':'empty',reasons:rows.length?incomplete?[findings?'finding_definition_unavailable':'verification_basis_incomplete']:[]:['no_preserved_evidence_observations']},dependencies,memberItems};
}
