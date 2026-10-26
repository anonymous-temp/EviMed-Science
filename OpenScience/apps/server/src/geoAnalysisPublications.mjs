/** Recorded content and publication context. A file, a version, a placement and a reported page are different units. */
import {createHash} from 'node:crypto';
import path from 'node:path';
import {GEO_ARTICLE_CHANNEL_LABELS_ZH} from '@evimed/domain';
import {canonicalJson,geoArticleFromRow} from './geoStore.mjs';
import {GeoDistributionView,geoDistributionEventView} from './geoDistributionView.mjs';
import {GeoOwnedPublications} from './geoOwnedPublications.mjs';
import {geoReadTransactionActive,withGeoReadTransaction} from './geoReadScope.mjs';
import {HttpError} from './security.mjs';
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const list=value=>Array.isArray(value)?value:[];
const max=20000;
const limited=rows=>{if(rows.length>max)throw new HttpError(422,'geo_read_filter_invalid','Narrow the publication scope to at most 20,000 records.');return rows;};
const iso=value=>value==null||!Number.isFinite(new Date(value).getTime())?null:new Date(value).toISOString();

/** Unknown dates stay explicitly undated. Observation dates are never substituted for business dates. */
export function geoBusinessTime(value,scope){
 const at=iso(value);if(!at)return {at:null,timeState:'unknown',admitted:true};
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:scope.timeZone??'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
 return {at,timeState:'recorded',admitted:(!scope.from||day>=scope.from)&&(!scope.to||day<=scope.to)};
}

const coverageColumns=[['articles','内容','articles'],['resultVersions','内容版本','result_versions'],['formats','内容文件格式','article_formats'],['ownedPublications','自行登记发布记录（含撤回）','publications'],['paidPublications','保留发布地址的投放','orders']];
const executionColumns=[['orders','投放订单','orders'],['ownedPublications','自行登记发布记录（含撤回）','publications'],['orderEvents','已记录订单事件','order_events']];
const publishedStates=new Set(['published','verified','settled']);
const audienceWords={patient:'患者',physician:'医生',caregiver:'照护者',pharmacist:'药师',institution:'机构',other:'其他'};
const eventWords={send_started:'开始提交',late_send_result:'延迟返回',price_changed:'报价变化',url_changed:'地址更新',refund_seen:'退款记录',refund_escalated:'退款待处理',auto_cancel:'自动取消',check:'页面检查',cited:'引用观察'};
const orderWords={planned:'已计划',reserved:'已预留',cited:'已观察到引用',draft:'草稿',pending:'待处理',sending:'提交中',submitted:'已提交',accepted:'已受理',published:'已发布',verified:'已检查',settled:'已结算',cancelled:'已取消',rejected:'已拒绝',unknown:'状态待确认',problem:'需要处理',lost:'链接失效',refunded:'已退款'};

/** Pure builder: exact historical associations determine membership; present heads only describe current context. */
export function buildGeoPublicationAnalysis(selected,view,context={}){
 if(!['V23','V24'].includes(view.viewId))throw new HttpError(400,'geo_read_filter_invalid','Choose a publication analysis.');
 const source=context.execution?.publication??{},facet=view.publicationFacet??'group',scope=selected.scope??{};
 for(const field of ['articles','versions','publications','orders','events'])limited(list(source[field]));
 const groupIds=new Set(list(selected.questions).map(q=>q.group_id).filter(Boolean));
 const selectedVersions=new Map();for(const question of list(selected.questions)){if(!selectedVersions.has(question.group_id))selectedVersions.set(question.group_id,new Set());selectedVersions.get(question.group_id).add(Number(question.set_version));}
 const groups=new Map(list(context.groups).filter(g=>groupIds.has(g.id)&&selectedVersions.get(g.id)?.size===1&&selectedVersions.get(g.id).has(Number(g.set_version))).map(g=>[g.id,g]));
 const articles=new Map(list(source.articles).map(article=>[article.id,article]));
 const versions=new Map(list(source.versions).map(version=>[JSON.stringify([version.articleId,version.resultVersionId]),version]));
 const articleVersions=new Map();for(const version of versions.values()){if(!articleVersions.has(version.articleId))articleVersions.set(version.articleId,[]);articleVersions.get(version.articleId).push(version);}
 const columns=(view.viewId==='V23'?coverageColumns:executionColumns).map(([key,label,unit])=>({key,label,unit,type:'number'}));
 const buckets=new Map(),memberItems=new Map();
 const associationFor=version=>version?.association&&typeof version.association==='object'?version.association:null;
 const admitAssociation=association=>!association?.groupId||groupIds.has(association.groupId);
 const bucket=(association,kind=null,status=null)=>{
  if(!admitAssociation(association))return null;
  const group=association?.groupId?groups.get(association.groupId):null;
  const mappingState=group?'exact':'unknown';
  const dimensions=view.viewId==='V24'?{kind:'publication_execution',objectKind:kind,status:status??'unknown',temporalBasis:'current_state_with_recorded_events'}:
   {kind:'content_publication_coverage',facet,mappingState,
    ...(facet==='group'?{groupId:group?.id??null,setVersion:group?.set_version??null,groupName:group?.name??null}:facet==='audience'?{audience:association?.audience??null}:{channel:association?.channel??null}),
    temporalBasis:'preserved_version_associations_and_current_publication_records'};
  const key=hash([view.viewId,dimensions]);
  if(!buckets.has(key)){
   const label=view.viewId==='V24'?`${kind==='order'?'投放订单':'自行登记发布'} · ${kind==='order'?orderWords[status]??'状态未知':status==='active'?'登记有效':status==='retired'?'已撤回登记':'状态未知'}`:
    facet==='group'?(group?`${group.name} · 问题版本 ${group.set_version}`:'关联问题群未知'):facet==='audience'?(audienceWords[association?.audience]??'面向人群未知'):(GEO_ARTICLE_CHANNEL_LABELS_ZH[association?.channel]??'预期渠道未知');
   buckets.set(key,{key,label:view.viewId==='V23'&&facet!=='group'&&mappingState==='unknown'?label+' · 关联问题群未知':label,metricId:null,dimensions,items:Object.fromEntries(columns.map(column=>[column.key,new Map()]))});
  }
  return buckets.get(key);
 };
 const put=(row,key,item)=>{if(row)row.items[key].set(item.id,item);};
 if(view.viewId==='V23'&&facet==='group')for(const group of groups.values())bucket({groupId:group.id});
 for(const version of versions.values()){
  const association=associationFor(version),time=geoBusinessTime(version.createdAt,scope);
  if(view.viewId!=='V23'||!time.admitted)continue;
  const row=bucket(association);if(!row)continue;
  const article=articles.get(version.articleId),format=path.posix.extname(version.path??'').slice(1).toLowerCase()||'unknown';
  const base={articleId:version.articleId,title:article?.title??null,association,temporalBasis:'preserved_version',createdAt:time.at,timeState:time.timeState};
  put(row,'resultVersions',{...base,...version,id:JSON.stringify([version.articleId,version.resultVersionId]),unit:'result_versions'});
  put(row,'articles',{...base,id:version.articleId,unit:'articles',associations:[]});
  put(row,'formats',{...base,id:JSON.stringify([version.articleId,format]),unit:'article_formats',format,versions:[]});
 }
 if(view.viewId==='V23')for(const article of articles.values()){
  if(articleVersions.has(article.id))continue;
  const time=geoBusinessTime(article.createdAt,scope);if(!time.admitted)continue;
  const association=article.currentResultVersionId?null:article,row=bucket(association);
  put(row,'articles',{id:article.id,articleId:article.id,title:article.title,unit:'articles',association,associations:[],temporalBasis:article.currentResultVersionId?'version_unavailable':'current_unversioned_draft',timeState:time.timeState,createdAt:time.at});
 }
 const admittedOrders=new Map();
 for(const [kind,records] of [['owned_publication',list(source.publications)],['order',list(source.orders)]])for(const record of records){
  const version=versions.get(JSON.stringify([record.articleId,record.articleResultVersionId]));
  const exact=!!version&&version.digest===record.articleDigest,association=exact?associationFor(version):null;
  if(!admitAssociation(association))continue;
  const timeBasis=kind==='owned_publication'?'user_reported_published_at':view.viewId==='V23'?'recorded_order_published_at':'order_created_at';
  const time=geoBusinessTime(kind==='owned_publication'||view.viewId==='V23'?record.publishedAt:record.createdAt,scope);
  const row=bucket(association,kind,kind==='order'?record.state:record.status);
  const item={...record,id:`${kind}:${record.id}`,objectId:record.id,unit:kind==='order'?'orders':'publications',resultVersionId:record.articleResultVersionId??null,digest:record.articleDigest??null,
   association,stateLabel:kind==='order'?(orderWords[record.state]??'状态未知'):(record.status==='active'?'登记有效':record.status==='retired'?'已撤回登记':'状态未知'),pinState:exact?'exact':'unknown',publicationBasis:kind==='owned_publication'?'user_reported':'order_record',timeBasis,timeState:time.timeState,at:time.at};
  if(kind==='order')admittedOrders.set(record.id,{row,item,association});
  if(!time.admitted)continue;
  if(kind==='owned_publication')put(row,'ownedPublications',item);
  else if(view.viewId==='V24')put(row,'orders',item);
  else if(publishedStates.has(record.state)&&record.publishedUrl)put(row,'paidPublications',item);
 }
 if(view.viewId==='V24')for(const event of list(source.events)){
  const order=admittedOrders.get(event.orderId),time=geoBusinessTime(event.at,scope);if(!order||!time.admitted)continue;
  put(order.row,'orderEvents',{...event,id:`event:${event.id}`,objectId:event.id,unit:'order_events',eventLabel:eventWords[event.phase]??`${orderWords[event.fromState]??'未知状态'} → ${orderWords[event.toState]??'未知状态'}`,fromStateLabel:orderWords[event.fromState]??'状态未知',toStateLabel:orderWords[event.toState]??'状态未知',articleId:order.item.articleId,resultVersionId:order.item.resultVersionId,digest:order.item.digest,association:order.association,timeBasis:'recorded_order_event',timeState:time.timeState,at:time.at});
 }
 const rows=[...buckets.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(row=>{
  const values={},objects=new Map(),versionsByArticle=new Map(),versionsByFormat=new Map();
  for(const version of row.items.resultVersions?.values()??[]){
   const format=path.posix.extname(version.path??'').slice(1).toLowerCase()||'unknown';
   for(const [index,key] of [[versionsByArticle,version.articleId],[versionsByFormat,JSON.stringify([version.articleId,format])]]){
    if(!index.has(key))index.set(key,[]);index.get(key).push(version);
   }
  }
  for(const article of row.items.articles?.values()??[]){article.resultVersionCount=(versionsByArticle.get(article.id)??[]).length;article.rowResultVersionCount=row.items.resultVersions.size;delete article.associations;delete article.association;}
  for(const format of row.items.formats?.values()??[]){format.resultVersionCount=(versionsByFormat.get(format.id)??[]).length;format.rowResultVersionCount=row.items.resultVersions.size;delete format.versions;delete format.association;}
  for(const column of columns){const items=[...row.items[column.key].values()];values[column.key]={value:items.length,state:'known',reason:null,unit:column.unit,metric:null,members:null};memberItems.set(`${row.key}:${column.key}`,items);for(const item of items)objects.set(`${item.unit}:${item.id}`,item);}
  return {key:row.key,label:row.label,metricId:null,dimensions:{...row.dimensions,objects:[...objects.values()]},values};
 });
 limited(rows);
 const allObjects=rows.flatMap(row=>row.dimensions.objects);
 const incomplete=rows.some(row=>row.dimensions.mappingState==='unknown'&&row.dimensions.objects.length)||allObjects.some(item=>item.pinState==='unknown');
 const unknownTime=allObjects.some(item=>item.timeState==='unknown');
 const unknownFormat=allObjects.some(item=>item.unit==='article_formats'&&item.format==='unknown');
 const events=view.viewId==='V24'?rows.flatMap(row=>(memberItems.get(row.key+':orderEvents')??[]).map(item=>({id:item.id,rowKey:row.key,columnKey:'orderEvents',at:item.at,label:item.eventLabel}))):[];
 const dated=events.filter(event=>event.at).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
 return {columns,rows,memberItems,dependencies:{publication:source},
  definition:{methodVersion:'content-publication-records-v1',countingRule:'Distinct article identities, preserved result versions, article-format pairs, reported pages, orders and recorded transitions are independent. Audience and channel describe intended version associations; actual publication platform/domain stays on each record. All complete version objects live in the resultVersions membership of the same row and objects, linked by articleId; article/format members carry counts rather than duplicating entire version histories. Rows may overlap; no inferred funnel or delivery effect.',denominatorRule:'Independent recorded object units. Publication receipts do not verify external pages. Paid publication counts require a recorded published/verified/settled state and retained URL; other orders stay in V24 execution context. A round-only scope does not backdate business records. Current order states are not historical transition counts. Date filters apply to each explicit business timestamp; unknown dates remain separately labelled.'},
  contextualBasis:[{kind:'publication_records',temporalBasis:'preserved_versions_current_publications',observationSelection:selected.selection?.reference??null,businessDateScope:{from:scope.from??null,to:scope.to??null,timeZone:scope.timeZone??'Asia/Shanghai'},digest:hash(source)}],
  chart:{kind:view.viewId==='V23'?'publication_coverage':'publication_execution',...(view.viewId==='V24'?{timeline:{total:events.length,undated:events.length-dated.length,dated:dated.length,events:dated.slice(0,200)}}:{}),labels:rows.map(row=>row.label),series:[],cells:rows.flatMap(row=>columns.map(column=>({rowKey:row.key,columnKey:column.key,label:row.label,columnLabel:column.label,...row.values[column.key]})))},
  availability:{status:rows.length?incomplete||unknownTime||unknownFormat?'partial':'available':'empty',reasons:rows.length?[...(incomplete?['publication_mapping_incomplete']:[]),...(unknownTime?['business_time_unknown']:[]),...(unknownFormat?['content_format_unknown']:[])]:['no_selected_publication_records']}};
}

/** Exhaust existing authorized read-only pagers in the analysis transaction; never join independently captured pages. */
export async function readGeoPublicationContext(store,project){
 if(!geoReadTransactionActive(store))return withGeoReadTransaction(store,()=>readGeoPublicationContext(store,project));
 const read=async sql=>limited((await store.query(sql,[project.id,project.userId])).rows);
 const articles=(await read('SELECT * FROM evimed_geo.articles WHERE geo_project_id=$1 AND user_id=$2 ORDER BY id LIMIT 20001')).map(geoArticleFromRow);
 const versions=(await read('SELECT article_id AS "articleId",result_version_id AS "resultVersionId",parent_version_id AS "parentVersionId",digest,path,association,created_at AS "createdAt" FROM evimed_geo.article_versions WHERE geo_project_id=$1 AND user_id=$2 ORDER BY article_id,result_version_id LIMIT 20001')).map(row=>({...row,createdAt:iso(row.createdAt)}));
 const complete=async readPage=>{
  let cursor=null,total=null;const items=[],seen=new Set();
  do{const page=await readPage({cursor,limit:200});
   if(page.total>max)throw new HttpError(422,'geo_read_filter_invalid','Publication context exceeds 20,000 records.');
   if(total!==null&&page.total!==total)throw new HttpError(409,'geo_read_filter_invalid','Publication context changed.');total=page.total;
   for(const item of page.items){if(seen.has(item.id))throw new HttpError(409,'geo_read_filter_invalid','Duplicate publication page.');seen.add(item.id);items.push(item);}
   limited(items);if(page.nextCursor&&(page.nextCursor===cursor||!page.items.length))throw new HttpError(409,'geo_read_filter_invalid','Publication page did not advance.');cursor=page.nextCursor;
  }while(cursor);
  if(items.length!==total)throw new HttpError(409,'geo_read_filter_invalid','Publication context is incomplete.');return items;
 };
 const distribution=new GeoDistributionView({store}),owned=new GeoOwnedPublications({store,documents:null});
 const orders=await complete(input=>distribution.orders(project,input)),publications=await complete(input=>owned.list(project,input));
 const events=(await read(`SELECT e.* FROM evimed_geo.order_events e JOIN evimed_geo.orders o ON o.id=e.order_id
   WHERE o.geo_project_id=$1 AND o.user_id=$2 ORDER BY e.at,e.id LIMIT 20001`)).map(row=>({...geoDistributionEventView(row),orderId:row.order_id}));
 return {articles,versions,orders,publications,events};
}
