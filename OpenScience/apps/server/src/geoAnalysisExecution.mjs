/** Current business records linked to an exact selected observation universe. */
import {createHash} from 'node:crypto';
import {canonicalJson,GEO_ENGINES,GEO_ENGINE_LABELS_ZH,GEO_ERROR_TYPE_LABELS_ZH} from '@evimed/domain';
import {readGeoSelectionErrors} from './geoReadScope.mjs';
import {errorRow} from './geoMeasureStore.mjs';
import {geoErrorClinicalContext} from './geoErrors.mjs';
import {buildGeoPublicationAnalysis,readGeoPublicationContext} from './geoAnalysisPublications.mjs';
import {buildGeoFinanceAnalysis,readGeoFinanceContext} from './geoAnalysisFinance.mjs';
import {buildGeoHistoryAnalysis,readGeoHistoryContext} from './geoAnalysisHistory.mjs';
import {HttpError} from './security.mjs';
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const temporalBasis='current_error_state_for_selected_answer_links';
const engineOf=value=>typeof value==='string'&&value?value:'unknown';
const engineColumn=engine=>`engine_${GEO_ENGINES.includes(engine)||engine==='unknown'?engine:'other_'+hash(engine).slice(0,12)}`;

/** Called inside the existing selected-analysis repeatable-read transaction. */
export async function readGeoExecutionContext(store,project,selected,view,dependencies={}){
 if(['V15','V27'].includes(view.viewId))return {history:await readGeoHistoryContext(store,project,selected,view,dependencies)};
 if(['V25','V26'].includes(view.viewId))return {finance:await readGeoFinanceContext(store,project,selected,view,dependencies)};
 if(['V23','V24'].includes(view.viewId))return {publication:await readGeoPublicationContext(store,project)};
 if(view.viewId!=='V13')throw new HttpError(400,'geo_read_filter_invalid','Choose an implemented execution view.');
 const state=view.errorView??'active';
 const result=await readGeoSelectionErrors(store,project,selected,state==='all'?{}:{errorJudgmentState:state},{allRows:true});
 return {errors:result.rows,errorFilter:result.filter,total:result.counts.total};
}

/** One error id is one record, independent of repetitions and handling attempts. */
export function buildGeoExecutionAnalysis(selected,view,context={}){
 if(['V15','V27'].includes(view.viewId))return buildGeoHistoryAnalysis(selected,view,context);
 if(['V25','V26'].includes(view.viewId))return buildGeoFinanceAnalysis(selected,view,context);
 if(['V23','V24'].includes(view.viewId))return buildGeoPublicationAnalysis(selected,view,context);
 if(view.viewId!=='V13')throw new HttpError(400,'geo_read_filter_invalid','Choose an implemented execution view.');
 const facet=view.errorFacet??'type',state=view.errorView??'active',unit='error_records';
 const answers=new Map((selected.rows??[]).map(row=>[row.snapshotId,row]));
 const raw=context.execution?.errors??[];
 if(raw.length>20000)throw new HttpError(422,'geo_read_filter_invalid','Narrow the selection to at most 20,000 error records.');
 const admitted=[];
 for(const row of new Map(raw.map(entry=>[entry.id,entry])).values()){
  const linked=[row.first_snapshot_id,row.last_snapshot_id,row.closed_snapshot_id].find(id=>answers.has(id));
  if(!linked||state!=='all'&&(row.judgment_state??'active')!==state)continue;
  const answer=answers.get(linked);
  const {statement:errorStatement,userId:_owner,geoProjectId:_project,...record}=errorRow(row);
  const item={...record,errorStatement,unit,engine:engineOf(row.engine),recordQuestionId:row.question_id??null,
   snapshotId:linked,questionId:answer.questionId??null,roundId:answer.roundId,askedAt:answer.askedAt??null,
   ...geoErrorClinicalContext(row),temporalBasis};
  admitted.push(item);
 }
 const engines=[...new Set([...(selected.rows??[]).map(row=>engineOf(row.engine)),...admitted.map(item=>item.engine)])].sort();
 const columns=[{key:'total',label:'错误记录',unit,type:'number'},...engines.map(engine=>({key:engineColumn(engine),label:GEO_ENGINE_LABELS_ZH[engine]??'平台未知',unit,type:'number'})),
  {key:'unresolved',label:'当前未关闭',unit,type:'number'},{key:'closed',label:'当前已关闭',unit,type:'number'},
  {key:'statusUnknown',label:'处置状态未知',unit,type:'number'}];
 const groups=new Map();
 for(const item of admitted){
  const category=(facet==='severity'?item.severity:item.errorType)??'unknown';
  if(!groups.has(category))groups.set(category,[]);groups.get(category).push(item);
 }
 const memberItems=new Map(),rows=[];
 for(const [category,items] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const key=hash([view.viewId,facet,state,category]);
  const label=facet==='severity'?(category==='unknown'?'严重程度未知':category):(GEO_ERROR_TYPE_LABELS_ZH[category]??'错误类型未知');
  const values={};
  for(const column of columns){
   const members=column.key==='total'?items:column.key==='unresolved'?items.filter(item=>['open','acting','awaiting_remeasure'].includes(item.status)):
    column.key==='closed'?items.filter(item=>item.status==='closed'):column.key==='statusUnknown'?items.filter(item=>!['open','acting','awaiting_remeasure','closed'].includes(item.status)):
    items.filter(item=>engineColumn(item.engine)===column.key);
   values[column.key]={value:members.length,state:'known',reason:null,unit,metric:null,members:null};
   memberItems.set(`${key}:${column.key}`,members);
  }
  rows.push({key,label,metricId:null,dimensions:{kind:'error_distribution',category,facet,judgmentView:state,temporalBasis,objects:items},values});
 }
 return {definition:{methodVersion:'exact-selected-error-records-v1',
  countingRule:'Distinct current error records whose retained first, last or closed answer belongs to the selected observations. Repeated occurrences and task attempts are not additional error records.',
  denominatorRule:'Stored error objects only; no answer error-rate or historical lifecycle denominator. Active judgment includes closed business records. Withdrawn judgments are a separate explicit view.'},
  contextualBasis:[{kind:'error_records',temporalBasis,judgmentView:state,association:'retained_first_last_closed_answer',digest:hash(admitted)}],
  columns,rows,memberItems,dependencies:{errors:admitted},
  chart:{kind:'error_distribution',labels:rows.map(row=>row.label),series:[],cells:rows.flatMap(row=>engines.map(engine=>({rowKey:row.key,columnKey:engineColumn(engine),engine,label:row.label,...row.values[engineColumn(engine)]})))},
  availability:{status:rows.length?'available':'empty',reasons:rows.length?[]:['no_linked_error_records']}};
}
