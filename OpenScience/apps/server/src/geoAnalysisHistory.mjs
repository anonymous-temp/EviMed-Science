/** Preserved business occurrences and current handling context have separate identities and clocks. */
import {createHash} from 'node:crypto';
import {geoMetricMembers,GEO_METRIC_LABELS_ZH,GEO_METRIC_UNITS} from '@evimed/domain';
import {canonicalJson} from './geoStore.mjs';
import {geoBusinessTime,readGeoPublicationContext} from './geoAnalysisPublications.mjs';
import {geoReadTransactionActive,withGeoReadTransaction,geoRoundReadings} from './geoReadScope.mjs';
import {ProductDocuments} from './productStore.mjs';
import {GeoSignals} from './geoSignals.mjs';
import {readGeoGroupChangeMembers,readGeoSignalTargets,geoGroupSideRoot} from './geoSignalTargets.mjs';
import {HttpError} from './security.mjs';

const json=value=>JSON.parse(JSON.stringify(value));
const hash=value=>createHash('sha256').update(canonicalJson(json(value))).digest('hex');
const list=value=>Array.isArray(value)?value:[];
const max=20000;
const bounded=items=>{if(items.length>max)throw new HttpError(422,'geo_read_filter_invalid','History context exceeds 20,000 records.');return items;};
const kinds={historical_record:'其他保留记录',wrong_occurrence_time_unknown:'错误观察（时间未保留）',error_observed:'错误再次观察',error_first:'错误首次保留',error_last:'错误最近保留',business_reopened:'关闭后再次观察到错误',new_wrong_occurrence:'再次观察到错误',business_closed:'已记录的关闭观察',judgment_changed:'判定变更',task_attempt:'处理任务',source_changed:'资料变化',citation_observed:'引用观察',order_anomaly:'订单需要处理',group_changed:'问题群观测变化',content_revision:'内容版本',publication_update:'用户登记的发布版本',order_event:'订单事件',question_set_created:'问题集建立',question_set_locked:'问题集锁定',sampling_mode_changed:'完成轮次的采样约定变化'};
const observationKinds=new Set(['error_first','error_last','business_reopened','new_wrong_occurrence','wrong_occurrence_time_unknown']);
const recurrenceKinds=new Set(['business_reopened','new_wrong_occurrence']);
const judgmentKinds=new Set(['assessment_correction','judgment_reactivated','resolution_basis_withdrawn','assessment_superseded_unknown','legacy_identity_residual_wrong']);

function admission(selected) {
 const answers=new Map(list(selected.rows).map(row=>[row.snapshotId,row]));
 const groups=new Map();for(const question of list(selected.questions)){if(!groups.has(question.group_id))groups.set(question.group_id,new Set());groups.get(question.group_id).add(Number(question.set_version));}
 const engines=new Set(selected.scope?.engines?.length?selected.scope.engines:selected.selection?.engines??[]);
 const matches=basis=>{
  if(basis.engine&&engines.size&&!engines.has(basis.engine))return false;
  if(basis.group&&selected.scope?.engines?.length){
   const requested=[...selected.scope.engines].sort().join(',');
   if(['before','after'].some(side=>list(basis.methods?.[side]?.engines).sort().join(',')!==requested))return false;
  }
  if(basis.snapshotId)return answers.has(basis.snapshotId);
  const group=basis.groupId??basis.group?.id,version=basis.questionVersion??basis.group?.questionVersion;
  if(group)return groups.has(group)&&(version==null||groups.get(group).has(Number(version)));
  if(list(basis.groupIds).length)return basis.groupIds.some(id=>groups.has(id));
  return true;
 };
 return {answers,groups,matches};
}

/** A saved group aggregate cannot be relabelled as a narrower question cohort. */
function groupCohortMatches(selected,signal) {
 if(signal.kind!=='group_changed')return true;
 const questions=new Set(list(selected.questions).map(question=>question.id)),scope=selected.scope??{};
 for(const side of ['before','after']){
  const members=signal.cohorts?.[side];if(!Array.isArray(members))return false;
  for(const member of members){
   const question=member.preservedQuestion??{},id=member.questionId??question.id;
   if(!questions.has(id)||scope.engines?.length&&!scope.engines.includes(member.engine)
    ||scope.groupIds?.length&&!scope.groupIds.includes(question.groupId)
    ||scope.pools?.length&&!scope.pools.includes(question.pool)
    ||scope.questionVersion!=null&&Number(question.setVersion)!==scope.questionVersion
    ||scope.clientTags?.length&&!scope.clientTags.some(tag=>list(question.clientTags).includes(tag)))return false;
  }
 }
 return true;
}
/** Keep one small event plus independently pageable exact material references. */
function historyMaterials(event) {
 const before=[],after=[],targets=[];
 for(const side of ['before','after'])for(const target of list(event.cohorts?.[side])){
  const {id:_targetId,unit:_targetUnit,...preserved}=target;
  (side==='before'?before:after).push({...preserved,id:'history-answer:'+hash([event.id,side,target.snapshotId]),unit:'history_answer_refs',eventId:event.id,signalId:event.signalId,basisDigest:event.basisDigest,side,title:event.title,eventLabel:event.eventLabel,preservedSelectionRef:event.basis?.sides?.[side]?.selectionRef??null});
 }
 for(const target of list(event.targets??event.basis?.targets)){const {version,...metadata}=target;targets.push({...metadata,materialVersion:version??null,targetId:target.id,id:'history-target:'+hash([event.id,target.key??target.id]),unit:'history_target_refs',eventId:event.id,signalId:event.signalId,basisDigest:event.basisDigest});}
 const {cohorts:_cohorts,targets:_targets,...summary}=event;
 if(event.basis){
  const {targets:_inline,targetPages:_pages,sides,...basis}=event.basis;
  summary.basis={...basis,...(sides?{sides:Object.fromEntries(Object.entries(sides).map(([side,input])=>{const {targets:_members,targetPages:_memberPages,...metadata}=input;return [side,metadata];}))}:{})};
  summary.basisProjection='event_metadata_with_separate_exact_material_references';
 }
 summary.preservedMemberLinks={before:before.length,after:after.length,targets:targets.length};
 return {summary,before,after,targets};
}

const contractOf=round=>{
 const value=round.surface?.measurementContract;if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const result=json(value);for(const field of ['engines','metricIds'])if(Array.isArray(result[field]))result[field].sort();return result;
};

/** The result uses actual retained occurrences; an unrecorded middle observation is never reconstructed. */
export function buildGeoHistoryAnalysis(selected,view,context={}) {
 if(!['V15','V27'].includes(view.viewId))throw new HttpError(400,'geo_read_filter_invalid','Choose a history analysis.');
 const source=context.execution?.history??{},scope=selected.scope??{},allowed=admission(selected),events=new Map(),errors=new Map();
 const add=(kind,id,value,at)=>{
  const time=geoBusinessTime(at,scope);if(!time.admitted)return;
  const item={...value,id,unit:'business_events',kind,eventLabel:kinds[kind]??kinds.judgment_changed,at:time.at,timeState:time.timeState};
  events.set(id,item);if(events.size>max)throw new HttpError(422,'geo_read_filter_invalid','Selected history exceeds 20,000 events.');
 };
 for(const error of bounded(list(source.errors))){
  const retained=new Map(),history=list(error.judgment_history);
  const observe=(kind,snapshotId,receipt=null)=>{
   if(!allowed.answers.has(snapshotId))return;
   const old=retained.get(snapshotId);
   if(!old||recurrenceKinds.has(kind))retained.set(snapshotId,{kind,receipt});
   else if(kind==='wrong_occurrence_time_unknown'&&!old.receipt)old.receipt=receipt;
  };
  observe('error_first',error.first_snapshot_id);observe('error_last',error.last_snapshot_id);
  for(const receipt of history)if(observationKinds.has(receipt.kind))observe(receipt.kind,receipt.snapshotId??receipt.after?.snapshotId,receipt);
  if(!retained.size&&!allowed.answers.has(error.closed_snapshot_id)
   &&!history.some(receipt=>allowed.answers.has(receipt.snapshotId??receipt.after?.snapshotId)))continue;
  errors.set(error.id,error);
  const identity={errorId:error.id,fingerprint:error.fingerprint??null,title:error.statement??null,engine:error.engine??null,currentStatus:error.status??null,currentJudgmentState:error.judgment_state??null};
  for(const [snapshotId,{kind,receipt}] of retained){
   const answer=allowed.answers.get(snapshotId);add(kind,`error-observation:${error.id}:${snapshotId}`,{...identity,snapshotId,roundId:answer.roundId,questionId:answer.questionId,receipt,recordedAt:receipt?.changedAt??receipt?.recordedAt??null,timeBasis:'answer_observed_at'},answer.askedAt);
  }
  if(allowed.answers.has(error.closed_snapshot_id))add('business_closed',`error-closure:${error.id}:${error.closed_snapshot_id}`,{...identity,snapshotId:error.closed_snapshot_id,timeBasis:'answer_observed_at'},allowed.answers.get(error.closed_snapshot_id).askedAt);
  for(const [index,receipt] of history.entries()){
   if(observationKinds.has(receipt.kind))continue;
   const snapshotId=receipt.snapshotId??receipt.after?.snapshotId??null;
   if(snapshotId&&!allowed.answers.has(snapshotId))continue;
   if(receipt.kind==='business_closed'){
    if(snapshotId)add('business_closed',`error-closure:${error.id}:${snapshotId}`,{...identity,snapshotId,receipt,recordedAt:receipt.changedAt??null,timeBasis:'answer_observed_at'},allowed.answers.get(snapshotId).askedAt);
    continue;
   }
   const judgment=judgmentKinds.has(receipt.kind);
   add(judgment?'judgment_changed':'historical_record',`error-record:${error.id}:${index}:${hash(receipt)}`,{...identity,snapshotId,receipt,timeBasis:judgment?'judgment_recorded_at':'recorded_at'},receipt.changedAt??receipt.recordedAt);
  }
 }
 let excludedGroupEvents=Number(source.excludedGroupEvents??0);
 const signalRows=new Map(bounded(list(source.signals)).map(signal=>[signal.id,signal]));
 for(const signal of signalRows.values()){
  const basis=signal.basis??{};if(!allowed.matches(basis))continue;
  if(!groupCohortMatches(selected,signal)){excludedGroupEvents++;continue;}
  if(view.viewId==='V15'&&!errors.has(basis.errorId))continue;
  if(view.viewId==='V27'){
   const observation=signal.kind==='error_observed'?events.get(`error-observation:${basis.errorId}:${basis.snapshotId}`):null;
   if(observation)Object.assign(observation,{signalId:signal.id,basis:signal.basis,basisDigest:signal.basisDigest,detectedAt:signal.detectedAt,currentDisposition:signal.disposition??null,businessOutcome:signal.businessOutcome??null});
   else add(signal.kind,`signal:${signal.id}`,{...signal,signalId:signal.id,unit:undefined,timeBasis:'producer_observed_at',currentDisposition:signal.disposition??null},signal.observedAt);
  }
  for(const attempt of list(signal.attempts)){
   // Only actually submitted attempts are business work; opening an unsent draft is not an execution.
   if(!attempt.submitted)continue;
   const currentError=errors.get(basis.errorId);
   add('task_attempt',`task:${attempt.contextRef}`,{...attempt,signalId:signal.id,errorId:basis.errorId??null,fingerprint:currentError?.fingerprint??null,currentStatus:currentError?.status??null,currentJudgmentState:currentError?.judgment_state??null,title:signal.title??null,timeBasis:attempt.finishedAt?'run_finished_at':attempt.startedAt?'run_started_at':'context_created_at',currentExecutionState:attempt.executionState??'unknown'},attempt.finishedAt??attempt.startedAt??attempt.createdAt);
  }
 }
 if(view.viewId==='V27'){
  const publication=source.publication??{},versions=new Map(list(publication.versions).map(v=>[JSON.stringify([v.articleId,v.resultVersionId]),v]));
  const versionFor=item=>{const version=versions.get(JSON.stringify([item.articleId,item.resultVersionId??item.articleResultVersionId]));return version&&version.digest===(item.digest??item.articleDigest)?version:null;};
  for(const version of versions.values())if(allowed.matches(version.association??{}))add('content_revision',`version:${version.articleId}:${version.resultVersionId}`,{...version,timeBasis:'version_created_at',mappingState:version.association?.groupId?'explicit_group':'unknown'},version.createdAt);
  const historyLinks=new Set();
  for(const receipt of list(source.publicationHistory)){
   historyLinks.add(receipt.linkId);const version=versionFor(receipt);if(version&&!allowed.matches(version.association??{}))continue;
   add('publication_update',`publication:${receipt.id}`,{...receipt,association:version?.association??null,pinState:version?'exact':'unknown',timeBasis:'user_reported_published_at',publicationBasis:'user_reported'},receipt.publishedAt);
  }
  for(const record of list(publication.publications))if(!historyLinks.has(record.id)){
   const version=versionFor(record);if(version&&!allowed.matches(version.association??{}))continue;
   add('publication_update',`publication-current:${record.id}`,{...record,publicationId:record.id,resultVersionId:record.articleResultVersionId??null,digest:record.articleDigest??null,association:version?.association??null,pinState:version?'exact':'unknown',timeBasis:'user_reported_published_at',publicationBasis:'current_user_reported_record_history_unavailable'},record.publishedAt);
  }
  const orders=new Map(list(publication.orders).map(order=>[order.id,order]));
  for(const event of list(publication.events)){
   const order=orders.get(event.orderId);if(!order)continue;const version=versionFor(order);if(version&&!allowed.matches(version.association??{}))continue;
   add('order_event',`order-event:${event.id}`,{...event,articleId:order.articleId,resultVersionId:order.articleResultVersionId??null,digest:order.articleDigest??null,association:version?.association??null,pinState:version?'exact':'unknown',timeBasis:'order_event_at'},event.at);
  }
  const versionsSelected=new Set(list(selected.questions).map(question=>Number(question.set_version)));
  for(const set of list(source.questionSets))if(versionsSelected.has(Number(set.version))){
   add('question_set_created',`question-set:${set.version}:created`,{questionVersion:set.version,timeBasis:'question_set_created_at'},set.created_at);
   if(set.locked_at)add('question_set_locked',`question-set:${set.version}:locked`,{questionVersion:set.version,timeBasis:'question_set_locked_at'},set.locked_at);
  }
  const rounds=[...list(source.rounds)].filter(round=>round.finished_at).sort((a,b)=>new Date(a.finished_at).getTime()-new Date(b.finished_at).getTime()||a.id.localeCompare(b.id));
  for(let i=1;i<rounds.length;i++){
   const old=rounds[i-1],current=rounds[i];if(!selected.selection.roundIds?.includes(current.id))continue;
   const before=old.surface?.mode,after=current.surface?.mode;
   const beforeContract=contractOf(old),afterContract=contractOf(current);
   const surfaceChanged=!!before&&!!after&&before!==after,contractChanged=!!beforeContract&&!!afterContract&&canonicalJson(beforeContract)!==canonicalJson(afterContract);
   if(!surfaceChanged&&!contractChanged)continue;
   add('sampling_mode_changed',`mode:${old.id}:${current.id}`,{previousRoundId:old.id,roundId:current.id,before:before??null,after:after??null,beforeContract,afterContract,surfaceChanged,contractChanged,timeBasis:'completed_round_contract_observation'},current.finished_at);
  }
 }
 const columns=(view.viewId==='V15'?[
  ['observations','保留的错误观察','business_events'],['recurrences','有记录的再次出现','business_events'],['judgments','判定变更记录','business_events'],['closedObservations','有记录的关闭观察','business_events'],['tasks','已提交处理任务','business_events'],['records','其他保留记录','business_events']
 ]:[['events','业务事件','business_events'],['undated','时间未保留','business_events'],['beforeAnswers','变化前样本关联','history_answer_refs'],['afterAnswers','变化后样本关联','history_answer_refs'],['affectedObjects','当时关联材料','history_target_refs'],['reading',GEO_METRIC_LABELS_ZH[view.metricId??'M-01']??'实测读数',GEO_METRIC_UNITS[view.metricId??'M-01']??'percent']]).map(([key,label,unit])=>({key,label,unit,type:'number'}));
 const groups=new Map();for(const event of events.values()){const key=view.viewId==='V15'?event.errorId:event.kind;if(!key)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(event);}
 const memberItems=new Map(),rows=[];
 for(const [identity,items] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const key=hash([view.viewId,identity]),error=errors.get(identity),values={};
  const material=items.map(historyMaterials),eventItems=material.map(item=>item.summary);
  const related={beforeAnswers:material.flatMap(item=>item.before),afterAnswers:material.flatMap(item=>item.after),affectedObjects:material.flatMap(item=>item.targets)};
  for(const column of columns){
   if(Object.hasOwn(related,column.key)){
    const applicable=column.key==='affectedObjects'?identity==='source_changed':identity==='group_changed',members=related[column.key];
    memberItems.set(`${key}:${column.key}`,members);values[column.key]={value:applicable?members.length:null,state:applicable?'known':'not_applicable',reason:applicable?null:'event_has_no_material_of_this_kind',unit:column.unit,metric:null,members:null};continue;
   }
   if(column.key==='reading'){values.reading={value:null,state:'not_applicable',reason:'event_not_metric',unit:column.unit,metric:null,members:null};memberItems.set(`${key}:reading`,[]);continue;}
   const members=column.key==='observations'?eventItems.filter(item=>observationKinds.has(item.kind)):column.key==='recurrences'?eventItems.filter(item=>recurrenceKinds.has(item.kind)):
    column.key==='judgments'?eventItems.filter(item=>item.kind==='judgment_changed'):column.key==='closedObservations'?eventItems.filter(item=>item.kind==='business_closed'):
    column.key==='tasks'?eventItems.filter(item=>item.kind==='task_attempt'):column.key==='records'?eventItems.filter(item=>item.kind==='historical_record'):column.key==='undated'?eventItems.filter(item=>!item.at):eventItems;
   memberItems.set(`${key}:${column.key}`,members);values[column.key]={value:members.length,state:'known',reason:null,unit:column.unit,metric:null,members:null};
  }
  rows.push({key,label:view.viewId==='V15'?error?.statement??'历史错误记录':kinds[identity]??'已记录事件',metricId:null,dimensions:{kind:view.viewId==='V15'?'error_history':'business_history',...(view.viewId==='V15'?{errorId:identity,currentStatus:error?.status??null,currentJudgmentState:error?.judgment_state??null}:{eventKind:identity}),temporalBasis:'preserved_events_with_current_handling_context',objects:[...eventItems,...related.beforeAnswers,...related.afterAnswers,...related.affectedObjects]},values});
 }
 const timeline=rows.flatMap(row=>row.dimensions.objects.filter(item=>item.unit==='business_events').map(item=>({id:item.id,rowKey:row.key,columnKey:view.viewId==='V15'?item.kind==='task_attempt'?'tasks':item.kind==='judgment_changed'?'judgments':item.kind==='business_closed'?'closedObservations':item.kind==='historical_record'?'records':'observations':'events',at:item.at,label:item.eventLabel})));
 const dated=timeline.filter(item=>item.at).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
 const trend=[];
 // Rounds are numbered oldest first, as the rival buckets are: the selection holds them newest first (finished_at DESC).
 const chronological=[...list(selected.rounds)].sort((a,b)=>Number(a.finished_at==null)-Number(b.finished_at==null)||new Date(a.finished_at??0).getTime()-new Date(b.finished_at??0).getTime()||String(a.id).localeCompare(String(b.id)));
 if(view.viewId==='V27'&&selected.metricOptions)for(const [index,round] of chronological.entries()){
  const computed=geoRoundReadings(selected,round.id),cell=computed.cells.find(item=>item.scope==='project'&&item.metricId===(view.metricId??'M-01'));
  if(!cell)continue;
  const key=hash(['round-reading',round.id,cell.metricId]);
  const input=cell.metricId==='M-20'?computed.balance.deduped:computed.balance.rows;
  const original=geoMetricMembers(/** @type {any[]} */ (input),cell,selected.metricOptions);
  const answerTimes=original.rows.map(row=>geoBusinessTime(row.askedAt,{}).at);
  const knownTimes=answerTimes.filter(Boolean).sort(),unknownTimes=answerTimes.length-knownTimes.length;
  const observedFrom=knownTimes[0]??null,observedTo=knownTimes.at(-1)??null,at=unknownTimes?null:observedTo;
  const members=original.rows.map(row=>({id:row.snapshotId,unit:original.unit??'answers',snapshotId:row.snapshotId,questionId:row.questionId,roundId:row.roundId,engine:row.engine,askedAt:row.askedAt??null}));
  const point={roundId:round.id,rowKey:key,columnKey:'reading',at,observedFrom,observedTo,unknownTimes,timeBasis:'selected_member_interval_end',metricId:cell.metricId,value:cell.status==='ok'?cell.value:null,status:cell.status,reason:cell.reason??null,numerator:cell.numerator??null,denominator:cell.denominator??null};
  trend.push(point);const values={};
  for(const column of columns){memberItems.set(`${key}:${column.key}`,column.key==='reading'?members:[]);values[column.key]=column.key==='reading'?{value:point.value,state:cell.status==='ok'?'known':cell.status==='insufficient'?'insufficient':'unknown',reason:point.reason,unit:column.unit,metric:cell,memberUnit:original.unit,numerator:point.numerator,denominator:point.denominator,members:null}:{value:null,state:'not_applicable',reason:'reading_not_event',unit:column.unit,metric:null,members:null};}
  rows.push({key,label:`采样第 ${index+1} 轮`,metricId:cell.metricId,dimensions:{kind:'history_reading',roundId:round.id,date:at,observedFrom,observedTo,unknownTimes,temporalBasis:'selected_member_interval_aggregate',objects:members},values});
 }
 bounded(rows);
 const reasons=[...(view.viewId==='V15'&&rows.length?['error_history_is_retained_observations']:[]),...(timeline.some(item=>!item.at)?['business_time_unknown']:[]),...(source.executionAvailable===false?['handling_context_unavailable']:[]),...(trend.some(point=>point.unknownTimes)?['observation_time_unknown']:[]),...(excludedGroupEvents?['group_history_scope_unavailable']:[])];
 return {columns,rows,memberItems,dependencies:{history:source},definition:{methodVersion:'preserved-business-history-v1',countingRule:'Exact retained first/last answer observations and explicit recurrence/judgment receipts; no inferred middle observations. Submitted execution attempts do not close clinical issues. Producer event identity is deduplicated. Event metadata and independently pageable exact before/after sample references and affected material references are linked by eventId/signalId; a sample may be referenced by several distinct events and is not a new observation. Current disposition and execution state are separate read-time context.',denominatorRule:'Independent business occurrences, never conversion or causal effect. Observation selection admits exact answer/group/version identities; dates use each actual business clock. Undated events stay undated. A round-only scope does not backdate business context.'},contextualBasis:[{kind:'business_history',digest:hash(source),roundReadingTimeBasis:'selected_member_interval_end_unknown_if_any_member_time_unknown',businessDateScope:{from:scope.from??null,to:scope.to??null,timeZone:scope.timeZone??'Asia/Shanghai'},observationSelection:selected.selection.reference,excludedGroupEvents}],chart:{kind:view.viewId==='V15'?'error_history':'business_history',labels:rows.map(row=>row.label),series:[],trend,cells:rows.flatMap(row=>columns.map(column=>({rowKey:row.key,columnKey:column.key,label:row.label,columnLabel:column.label,...row.values[column.key]}))),timeline:{total:timeline.length,dated:dated.length,undated:timeline.length-dated.length,events:dated.slice(0,200)}},availability:{status:rows.length?reasons.length?'partial':'available':'empty',reasons:rows.length?reasons:['no_selected_business_events',...reasons]}};
}

/** Bounded reads reuse existing producer identities and projections; they never run discovery or a task.
 * @param {any} store @param {any} project @param {any} selected @param {any} view @param {{service?:any}} [dependencies] */
export async function readGeoHistoryContext(store,project,selected,view,{service}={}) {
 if(!geoReadTransactionActive(store))return withGeoReadTransaction(store,()=>readGeoHistoryContext(store,project,selected,view,{service}));
 const read=async(sql,values=[project.id,project.userId])=>bounded((await store.query(sql,values)).rows).map(json);
 const ids=list(selected.rows).map(row=>row.snapshotId);
 const errors=await read(`SELECT e.* FROM evimed_geo.errors e WHERE e.geo_project_id=$1 AND e.user_id=$2 AND
   (e.first_snapshot_id=ANY($3::text[]) OR e.last_snapshot_id=ANY($3::text[]) OR e.closed_snapshot_id=ANY($3::text[]) OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(e.judgment_history) receipt WHERE coalesce(receipt->>'snapshotId',receipt#>>'{after,snapshotId}')=ANY($3::text[]))) ORDER BY e.id LIMIT 20001`,[project.id,project.userId,ids]);
 const documents=service?.signals?.documents??new ProductDocuments(store.database);
 const signalsService=service?.signals??new GeoSignals({store,documents,service:null,runs:async()=>{throw new Error('Handling context unavailable');},resultForRun:async()=>null});
 const documentRows=async(kind,filter)=>{
  let cursor=null,bytes=0;const rows=[],seen=new Set();
  do{const page=await documents.list(project.userId,kind,{projectId:project.projectId,filter,cursor,limit:100});
   for(const row of page.items){if(seen.has(row.id))throw new HttpError(409,'geo_read_filter_invalid','History page did not advance.');seen.add(row.id);bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>16*1024*1024)throw new HttpError(422,'geo_read_filter_invalid','History input exceeds 16 MiB.');rows.push(row);}bounded(rows);
   if(page.nextCursor===cursor&&cursor)throw new HttpError(409,'geo_read_filter_invalid','History page did not advance.');cursor=page.nextCursor;
  }while(cursor);return rows;
 };
 const rawSignals=await documentRows('geo-signal',{recordType:'geo-signal',geoId:project.id});
 const contexts=await documentRows('geo-plan-context',{recordType:'geo-plan-context',geoId:project.id,mode:'signal'});
 let runs=[],executionAvailable=Boolean(service?.signals);if(executionAvailable){try{runs=await signalsService.runs(project);}catch{executionAvailable=false;}bounded(runs);}
 const execution={available:executionAvailable,results:new Map()},signals=[],allowed=admission(selected),errorIds=new Set(errors.map(error=>error.id));
 const contextsBySignal=new Map(),runsByRequest=new Map();
 for(const context of contexts){const key=JSON.stringify([context.payload.basis?.signal?.id,context.payload.basis?.signal?.basisDigest]);if(!contextsBySignal.has(key))contextsBySignal.set(key,[]);contextsBySignal.get(key).push(context);}
 let requestBindings=0;
 for(const run of runs)for(const requestId of list(run.kernelRequestIds)){
  if(++requestBindings>200000)throw new HttpError(422,'geo_read_filter_invalid','Handling history exceeds the request binding limit.');
  const key=JSON.stringify([run.sessionId,requestId]);if(!runsByRequest.has(key))runsByRequest.set(key,[]);runsByRequest.get(key).push(run);
 }
 let preservedMembers=0,excludedGroupEvents=0;
 for(const row of rawSignals){
  signalsService.requireRow(project,row);if(!allowed.matches(row.payload.basis)||view.viewId==='V15'&&!errorIds.has(row.payload.basis.errorId))continue;
  const linkedContexts=contextsBySignal.get(JSON.stringify([row.id,row.payload.basisDigest]))??[];
  const linkedRuns=[...new Set(linkedContexts.flatMap(context=>runsByRequest.get(JSON.stringify([context.payload.sessionId,context.payload.requestId]))??[]))];
  const projected=await signalsService.projectRow(project,row,{...execution,contexts:linkedContexts,runs:linkedRuns}),cohorts={};
  if(view.viewId==='V27'&&row.payload.kind==='group_changed')for(const side of ['before','after']){
   const input=row.payload.basis.sides?.[side];preservedMembers+=input?.count??0;if(preservedMembers>max)throw new HttpError(422,'geo_read_filter_invalid','Selected historical cohorts exceed 20,000 members.');
   const cache=new Map();const scopedDocuments={get:async(...args)=>{const key=JSON.stringify(args);if(!cache.has(key))cache.set(key,documents.get(...args));return cache.get(key);}};
   // The existing reader validates the full side once, then the same immutable pages supply its complete member list.
   await readGeoGroupChangeMembers(scopedDocuments,project,row,{side,offset:0,limit:500});
   cohorts[side]=await readGeoSignalTargets(scopedDocuments,project,{id:geoGroupSideRoot(row.id,side),payload:{basis:input}});
  }
  if(row.payload.kind==='group_changed'&&!groupCohortMatches(selected,{kind:row.payload.kind,cohorts})){excludedGroupEvents++;continue;}
  const targets=row.payload.kind==='source_changed'?await readGeoSignalTargets(documents,project,row):null;
  if(targets){preservedMembers+=targets.length;if(preservedMembers>max)throw new HttpError(422,'geo_read_filter_invalid','Selected historical targets exceed 20,000 members.');}
  signals.push({...projected,basis:row.payload.basis,basisDigest:row.payload.basisDigest,eventVersion:row.payload.eventVersion,...(targets?{targets}:{}),...(Object.keys(cohorts).length?{cohorts}:{})});
 }
 if(view.viewId==='V15')return {errors,signals,executionAvailable,excludedGroupEvents};
 const publication=await readGeoPublicationContext(store,project);
 const questionSets=await read('SELECT version,created_at,locked_at FROM evimed_geo.question_sets WHERE geo_project_id=$1 AND user_id=$2 ORDER BY version LIMIT 20001');
 const rounds=await read("SELECT id,finished_at,surface FROM evimed_geo.rounds WHERE geo_project_id=$1 AND user_id=$2 AND kind IN ('baseline','weekly','single_step') AND status IN ('done','partial') AND finished_at IS NOT NULL ORDER BY finished_at,id LIMIT 20001");
 const publicationHistory=await read(`SELECT d.id||':'||r.revision AS id,r.revision,r.recorded_at AS "recordedAt",r.payload->'publication' AS publication
  FROM evimed_product.documents d JOIN evimed_product.revisions r ON r.user_id=d.user_id AND r.kind=d.kind AND r.id=d.id
  WHERE d.project_id=$3 AND d.user_id=$2 AND d.kind='knowledge' AND d.deleted_at IS NULL AND d.payload->>'recordType'='geo-owned-publication'
   AND d.payload->>'geoProjectId'=$1 AND r.deleted_at IS NULL AND r.payload->>'recordType'='geo-owned-publication' AND r.payload->>'geoProjectId'=$1
  ORDER BY r.recorded_at,d.id,r.revision LIMIT 20001`,[project.id,project.userId,project.projectId]);
 return {errors,signals,executionAvailable,excludedGroupEvents,publication,questionSets,rounds,publicationHistory:publicationHistory.map(({publication:receipt,...row})=>({...row,...receipt}))};
}
