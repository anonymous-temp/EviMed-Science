/** Deterministic selected readings. Domain metrics own all arithmetic and membership. */
import { createHash } from 'node:crypto';
import { GEO_METRIC_IDS, GEO_METRIC_LABELS_ZH, GEO_METRIC_UNITS, documentExportDigest } from '@evimed/domain';
import { readGeoSelection, withGeoReadTransaction, geoReadScopeInput, geoReadPage, geoDailyReadings, geoRoundReadings } from './geoReadScope.mjs';
import { HttpError } from './security.mjs';

const hash = value => createHash('sha256').update(documentExportDigest(value)).digest('hex');
const invalid = message => new HttpError(400, 'geo_read_filter_invalid', message);
export const GEO_ANALYSIS_FIELDS = Object.freeze(['viewId','metricId','dimension','expectedDigest','limit','offset']);
/** @param {any} input */
export function normalizeGeoAnalysisView(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['viewId','metricId','dimension'].includes(key))) throw invalid('Choose a registered analysis view.');
  const viewId = input.viewId ?? 'V01', metricId = input.metricId ?? (viewId === 'V02' ? 'M-01' : null), dimension = input.dimension ?? (viewId === 'V02' ? 'engine' : 'project');
  if (!['V01','V02'].includes(viewId) || metricId !== null && !GEO_METRIC_IDS.includes(metricId) || !['project','engine','group'].includes(dimension)) throw invalid('Choose V01 or V02 and an existing metric/dimension.');
  return {viewId,metricId,dimension};
}
const metricKey = cell => documentExportDigest([cell.metricId,cell.scope,cell.engine,cell.groupId,cell.pool,cell.variant,cell.rival,cell.arm]);
const reading = cell => ({value:cell?.value ?? null,state:!cell || cell.status === 'absent' ? 'no_data' : cell.status === 'ok' ? 'known' : cell.status === 'insufficient' ? 'insufficient' : ['not_adjudicated','judgement_incomplete','not_extracted'].includes(cell.reason) ? 'unjudged' : ['not_applicable','inclusion_surface'].includes(cell.reason) ? 'not_applicable' : 'unknown',metric:cell ?? null,members:cell?.members ?? null,links:[]});
const plain = (value, state = 'known') => ({value,state,metric:null,members:null,links:[]});
/** Build all admitted rows before pagination. readAt is informational and never participates in identity.
 * @param {any} selected @param {any} request @param {any} [context]
 */
export function presentGeoAnalysis(selected, request, context = {}) {
  const view=normalizeGeoAnalysisView(request);
  const matches=cell => cell.scope === view.dimension && (!view.metricId || cell.metricId === view.metricId) && !cell.variant && !cell.rival && !cell.arm;
  const label=cell => [GEO_METRIC_LABELS_ZH[cell.metricId] ?? cell.metricId,cell.engine,context.groups?.find(group=>group.id===cell.groupId)?.name].filter(Boolean).join(' · ');
  const rowOf=(cell,values,dimensions=/** @type {Record<string,any>} */ ({}))=>({key:hash([metricKey(cell),dimensions]),seriesKey:hash(metricKey(cell)),label:label(cell),metricId:cell.metricId,dimensions:{period:null,date:null,scope:cell.scope,engine:cell.engine,groupId:cell.groupId,...dimensions},values,links:[]});
  const rows=[];
  if(view.viewId==='V01') {
    const baselineRound=[...selected.rounds].filter(round=>round.kind==='baseline').sort((a,b)=>String(a.sample_date).localeCompare(String(b.sample_date))||a.id.localeCompare(b.id))[0];
    const baseline=baselineRound?geoRoundReadings(selected,baselineRound.id):null;
    for(const cell of selected.computed.cells.filter(matches)) {
      const previous=selected.comparison?.cells.find(item=>metricKey(item)===metricKey(cell))?.previous;
      const pool=cell.pool ?? 'all';
      const target=context.targets?.rows?.find(item=>item.tier===context.tier && item.metricId===cell.metricId && item.pool===pool && cell.scope==='project')?.target;
      rows.push(rowOf(cell,{baseline:reading(baseline?.cells.find(item=>metricKey(item)===metricKey(cell))),previous:reading(previous),current:reading(cell),target:plain(Number.isFinite(target)?target:null,Number.isFinite(target)?'known':'no_data')}));
    }
  } else {
    for(const day of geoDailyReadings(selected)) for(const cell of day.result.cells.filter(matches)) rows.push(rowOf(cell,{current:reading(cell)},{period:'day',date:day.date}));
    for(const cell of selected.computed.cells.filter(matches)) rows.push(rowOf(cell,{current:reading(cell)},{period:'interval',date:null}));
    for(const comparison of selected.comparison?.cells.filter(matches) ?? []) {
      if(comparison.previous) rows.push(rowOf(comparison.previous,{current:reading(comparison.previous)},{period:'comparison',date:null}));
      rows.push(rowOf(comparison.current,{current:reading(comparison.current)},{period:'comparison_current',date:null}));
    }
  }
  rows.sort((a,b)=>documentExportDigest([a.dimensions.date ?? '',a.dimensions.period ?? '',a.label,a.key]).localeCompare(documentExportDigest([b.dimensions.date ?? '',b.dimensions.period ?? '',b.label,b.key])));
  if(rows.length>20_000) throw new HttpError(422,'geo_read_filter_invalid','Narrow the dates, metric or dimension to at most 20,000 analysis rows.');
  const dates=[...new Set(rows.filter(row=>row.dimensions.period==='day').map(row=>row.dimensions.date))].sort();
  const dayRows=rows.filter(row=>row.dimensions.period==='day');
  const points=new Map(dayRows.map(row=>[documentExportDigest([row.seriesKey,row.dimensions.date]),row.values.current]));
  const seriesLabels=new Map(dayRows.map(row=>[row.seriesKey,{label:row.label,engine:row.dimensions.engine}]));
  const series=[...seriesLabels].map(([seriesKey,displayLabel])=>({key:seriesKey,label:displayLabel.label,engine:displayLabel.engine,values:dates.map(date=>{const cell=points.get(documentExportDigest([seriesKey,date]));return cell?.state==='known'?cell.value:null;})}));
  const chart={labels:dates,series};
  const columns=(view.viewId==='V01'?['baseline','previous','current','target']:['current']).map(key=>({key,label:({baseline:'范围内基线',previous:'对照实测',current:'所选实测',target:'当前目标'})[key],type:'number',unit:view.metricId?GEO_METRIC_UNITS[view.metricId]??'index':'metric'}));
  const contextualBasis=context.targets?[{kind:'targets',id:'targets',version:context.targets.version??null,digest:hash(context.targets),temporalBasis:'current_context'}]:[];
  if(context.groups?.length) contextualBasis.push({kind:'group_labels',id:'groups',version:null,digest:hash(context.groups),temporalBasis:'current_context'});
  const definition={metricId:view.metricId,unit:view.metricId?(selected.computed.cells.find(matches)?.members.unit??'answers'):'derived_inputs',countingRule:'Existing domain metric; member references identify its exact input cohort.',denominatorRule:'Domain metric eligibility, deduplication and cross-engine balance.',methodVersion:selected.selection.methodVersion,dataType:view.metricId?(selected.computed.cells.find(matches)?.dataType??'unknown'):'mixed'};
  const basis={schemaVersion:1,view,scope:selected.scope,selection:selected.selection,comparison:selected.comparison,definition,contextualBasis,columns,rows,chart};
  const digest=hash(basis), page=geoReadPage({limit:context.limit??50,offset:context.offset??0}), limit=context.allRows?rows.length:page.limit, offset=context.allRows?0:page.offset;
  return {...basis,viewId:view.viewId,digest,availability:{status:rows.length?'ready':'empty',reasons:rows.length?[]:['no_selected_readings'],remedy:null},asOf:{readAt:context.readAt??new Date().toISOString(),observedFrom:selected.scope.from??null,observedTo:selected.scope.to??null},rows:rows.slice(offset,offset+limit),page:{total:rows.length,shown:Math.min(limit,Math.max(0,rows.length-offset)),nextOffset:offset+limit<rows.length?offset+limit:null},remainder:rows.length>offset+limit?{rows:rows.length-offset-limit,value:null,members:null}:null};
}
/** One authorized project and one repeatable-read snapshot for every consumer. @param {any} store @param {any} project @param {any} [input] */
export async function readGeoAnalysis(store, project, input = {}, allRows = false) {
  return withGeoReadTransaction(store, async()=>{
    const view=normalizeGeoAnalysisView(input.view ?? Object.fromEntries(['viewId','metricId','dimension'].filter(key=>input[key]!=null).map(key=>[key,input[key]])));
    const selected=await readGeoSelection(store,project,geoReadScopeInput(input));
    const targets=view.viewId==='V01'?await store.latestTargets(project.id):null;
    const groupIds=[...new Set(selected.questions.map(question=>question.group_id).filter(Boolean))];
    const groups=view.dimension==='group'?(await store.query('SELECT id,name,set_version FROM evimed_geo.question_groups WHERE geo_project_id=$1 AND user_id=$2 AND id=ANY($3::text[]) ORDER BY id',[project.id,project.userId,groupIds])).rows:[];
    const result=presentGeoAnalysis(selected,view,{targets,tier:project.tier,groups,limit:input.limit,offset:input.offset,allRows});
    if(input.expectedDigest && input.expectedDigest!==result.digest) throw new HttpError(409,'geo_read_filter_invalid','The selected analysis changed. Refresh the view.');
    return result;
  });
}
/** Freeze the complete table, with no formatted-value parsing or model-generated arithmetic. @param {any} view */
export function freezeGeoAnalysisDocument(view) {
  if(view.page.shown!==view.page.total) throw invalid('Freeze every selected row before exporting.');
  const metadataColumns=['selection_ref','analysis_digest','data_revision','scope','counts','method','counting_rule','denominator_rule','contextual_basis'].map(key=>({key,label:key,type:'text'}));
  const metadataValues={selection_ref:view.selection.reference,analysis_digest:view.digest,data_revision:view.selection.dataRevision,scope:documentExportDigest(view.scope),counts:documentExportDigest(view.selection.counts),method:view.definition.methodVersion,counting_rule:view.definition.countingRule,denominator_rule:view.definition.denominatorRule,contextual_basis:documentExportDigest(view.contextualBasis)};
  const columns=[...metadataColumns,{key:'key',label:'Row',type:'text'},{key:'label',label:'指标',type:'text'},{key:'metricId',label:'Metric',type:'text'},{key:'metric_unit',label:'指标尺度',type:'text'},{key:'period',label:'区间',type:'text'},{key:'date',label:'日期',type:'text'},...view.columns.flatMap(column=>[{key:column.key,label:column.label,type:'number'},{key:`${column.key}_state`,label:`${column.label}状态`,type:'text'},{key:`${column.key}_numerator`,label:`${column.label}分子`,type:'number'},{key:`${column.key}_denominator`,label:`${column.label}分母`,type:'number'},{key:`${column.key}_reason`,label:`${column.label}说明`,type:'text'},{key:`${column.key}_unit`,label:`${column.label}成员单位`,type:'text'}])];
  const rows=view.rows.map(row=>Object.fromEntries([...Object.entries(metadataValues),['key',row.key],['label',row.label],['metricId',row.metricId],['metric_unit',GEO_METRIC_UNITS[row.metricId]??'index'],['period',row.dimensions.period??'selected'],['date',row.dimensions.date??null],...view.columns.flatMap(column=>[[column.key,row.values[column.key].value],[`${column.key}_state`,row.values[column.key].state],[`${column.key}_numerator`,row.values[column.key].metric?.numerator??null],[`${column.key}_denominator`,row.values[column.key].metric?.denominator??null],[`${column.key}_reason`,row.values[column.key].metric?.reason??null],[`${column.key}_unit`,row.values[column.key].members?.unit??null]])]));
  const clean=value=>String(value??'未测').replaceAll('|','\\|').replaceAll('\n',' ');
  const metadata={...view,rows:view.rows};
  const reportColumns=[{key:'label',label:'指标与区间'},...view.columns];
  const reportReading=(row,column)=>{
    const cell=row.values[column.key],metric=cell.metric,unit=GEO_METRIC_UNITS[row.metricId]??'index';
    const value=cell.value==null?'未测':`${cell.value}${unit==='percent'?'%':''}`;
    const word=metric?.reason==='citations_without_links'?'引用不可测':metric?.status==='insufficient'?'样本不足':metric?.status==='absent'?'未测':value;
    return `${word}${word!==value&&cell.value!=null?`；保留值 ${value}`:''} (状态 ${cell.state}; 尺度 ${unit}; 原因 ${metric?.reason??'—'}; 分子/分母 ${metric?.numerator??'—'}/${metric?.denominator??'—'}; 成员单位 ${cell.members?.unit??'—'})`;
  };
  const reportRows=view.rows.map(row=>({label:[row.label,row.dimensions.date??row.dimensions.period].filter(Boolean).join(' · '),...Object.fromEntries(view.columns.map(column=>[column.key,reportReading(row,column)]))}));
  const canonicalMarkdown=`# 所选数据分析\n\n${view.definition.countingRule}\n\n${view.definition.denominatorRule}\n\n范围：${clean(documentExportDigest(view.scope))}。样本：${clean(documentExportDigest(view.selection.counts))}。\n\n方法：${view.definition.methodVersion}。分析摘要：${view.digest}。目标为读取时的当前目标，对照为另选区间的实际读数。每个读数保留指标尺度、状态、不可用原因、分子/分母和成员单位。\n\n| ${reportColumns.map(column=>clean(column.label)).join(' | ')} |\n| ${reportColumns.map(()=>'---').join(' | ')} |\n${reportRows.map(row=>`| ${reportColumns.map(column=>clean(row[column.key])).join(' | ')} |`).join('\n')}\n`;

  return {canonicalMarkdown,title:'所选数据分析',revision:view.digest,assets:[],cover:{analysis:metadata},typedTable:{columns,rows}};
}
/** The 20,000 observation bound also bounds table rows here; pages are joined only after digest parity. */
export async function freezeSelectedGeoAnalysis(store,project,input) {
  return readGeoAnalysis(store, project, {...input, limit:50, offset:0}, true);
}
