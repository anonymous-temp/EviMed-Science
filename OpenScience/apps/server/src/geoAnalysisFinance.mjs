/** Read-only project accounting and frozen plan comparisons. No financial or planning writer is composed here. */
import { createHash } from 'node:crypto';
import { canonicalJson, GEO_METRIC_UNITS, GEO_METRIC_LABELS_ZH, GEO_POOLS, geoMetricId, geoMetricMembers } from '@evimed/domain';
import { GeoDistributionView } from './geoDistributionView.mjs';
import { geoLedgerBalances } from './geoDistributionMoney.mjs';
import { projectMoney } from './geoMarketStore.mjs';
import { geoReadTransactionActive, withGeoReadTransaction } from './geoReadScope.mjs';
import { geoPlanCanonicalScope, geoPlanScopeKey, geoPlanDigest } from './geoPlanContext.mjs';
import { geoBusinessTime } from './geoAnalysisPublications.mjs';
import { strategyFromRow } from './geoStore.mjs';
import { HttpError } from './security.mjs';

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const maximum = 20000;
const invalid = (message, status = 400) => new HttpError(status, 'geo_read_filter_invalid', message);
const bounded = rows => { if (rows.length > maximum) throw invalid('Narrow the finance scope to at most 20,000 records.', 422); return rows; };
const amountKinds = ['budget_set', 'reserve', 'release', 'settle', 'refund'];
const labels = { budget_set:'预算设置', reserve:'预留', release:'释放预留', settle:'结算', refund:'退款' };
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const numeric = (value, unit, reason = 'not_recorded') => ({value:number(value),state:number(value) === null ? 'unknown' : 'known',reason:number(value) === null ? reason : null,unit,metric:null,members:null});
const columnsOf = fields => fields.map(([key,label,unit]) => ({key,label,unit,type:'number'}));

/** Exhaust an authoritative pager in one snapshot; a cap or incomplete traversal fails explicitly. */
async function complete(readPage) {
  let cursor = null, total = null, first = null;
  const items = [], seen = new Set();
  do {
    const page = await readPage({cursor,limit:200});
    first ??= page;
    if (!Number.isSafeInteger(page.total) || page.total < 0 || page.total > maximum) throw invalid('Finance context exceeds 20,000 records.',422);
    if (total !== null && page.total !== total) throw invalid('Finance context changed.',409);
    total = page.total;
    for (const item of page.items) {
      if (seen.has(item.id)) throw invalid('Duplicate finance page.',409);
      seen.add(item.id); items.push(item);
    }
    bounded(items);
    if (page.nextCursor && (page.nextCursor === cursor || !page.items.length)) throw invalid('Finance page did not advance.',409);
    cursor = page.nextCursor;
  } while (cursor);
  if (items.length !== total) throw invalid('Finance context is incomplete.',409);
  return {items,first};
}

/** The caller may already own the selected-analysis repeatable-read transaction.
 * @param {any} store @param {any} project @param {any} selected @param {any} view @param {{service?:any}} [dependencies]
 */
export async function readGeoFinanceContext(store, project, selected, view, {service} = {}) {
  if (!geoReadTransactionActive(store)) return withGeoReadTransaction(store, () => readGeoFinanceContext(store,project,selected,view,{service}));
  const distribution = new GeoDistributionView({store});
  await distribution.requireProject(project);
  if (view.viewId === 'V25') {
    const ledger = await complete(input => distribution.ledger(project,input));
    const orders = await complete(input => distribution.orders(project,input));
    const versions = bounded((await store.query(`SELECT article_id AS "articleId", result_version_id AS "resultVersionId",digest,association
      FROM evimed_geo.article_versions WHERE geo_project_id=$1 AND user_id=$2 ORDER BY article_id,result_version_id LIMIT 20001`,[project.id,project.userId])).rows);
    // The pager's chronological order retains sub-millisecond ordering. Do not sort ISO-millisecond projections again.
    const items = [...ledger.items].reverse();
    return {ledger:{items,opening:items.length ? geoLedgerBalances([]).opening : ledger.first.opening,summary:ledger.first.summary,currency:ledger.first.currency},orders:orders.items,versions};
  }
  if (view.viewId !== 'V26') throw invalid('Choose a finance or frozen plan analysis.');
  for (const key of ['strategyVersion','targetVersion']) if (view[key] != null && (!Number.isSafeInteger(view[key]) || view[key] < 1)) throw invalid('Choose a valid plan and target version.');
  if (!service?.strategyOf) throw new HttpError(503,'geo_plan_context_unavailable','Planning context is unavailable.');
  const scopeKey = geoPlanScopeKey(geoPlanCanonicalScope(selected.scope,selected.questions));
  const found = (await store.query(`SELECT * FROM evimed_geo.strategy WHERE geo_project_id=$1 AND user_id=$2 AND
    ${view.strategyVersion != null ? 'version=$3' : 'scope_key IS NOT DISTINCT FROM $3'} ORDER BY version DESC LIMIT 1`,[project.id,project.userId,view.strategyVersion ?? scopeKey])).rows[0];
  if (!found) {
    if (view.strategyVersion != null) throw new HttpError(404,'geo_strategy_not_found','This plan version is unavailable.');
    return {plan:null,requestedScopeKey:scopeKey};
  }
  const stored = strategyFromRow(found);
  // Freeze the actual exact-version service contract, never its current derived implementation actions.
  const response = await service.strategyOf(project,{strategyVersion:stored.version});
  if (response.version !== stored.version || response.scopeKey !== stored.scopeKey) throw invalid('The exact plan identity changed.',409);
  const basis = response.basis;
  if (canonicalJson(basis) !== canonicalJson(stored.basis) || basis && response.basisDigest !== geoPlanDigest(basis)) throw invalid('The frozen plan basis changed.',409);
  if (view.targetVersion != null && basis?.targets?.version !== view.targetVersion) throw invalid('Choose the target version frozen by this plan.',409);
  bounded(list(basis?.targets?.rows)); bounded(list(basis?.readings?.selected?.cells));
  return {plan:{version:stored.version,scopeKey:stored.scopeKey,basis,basisDigest:response.basisDigest,
    readingsKind:response.readingsKind,freshness:response.freshness,createdAt:stored.createdAt,assumptions:stored.assumptions,tiers:stored.tiers},requestedScopeKey:scopeKey};
}

/** Only an exact paid-order pin may supply group attribution; present article heads are irrelevant.
 * @param {any} selected @param {any} context @param {any} source
 */
function ledgerAssociations(selected, context, source) {
  const scope = selected.scope ?? {};
  const selectedGroups = new Set(list(selected.questions).map(question => question.group_id));
  const questionVersions = new Map();
  for (const question of list(selected.questions)) {
    if (!questionVersions.has(question.group_id)) questionVersions.set(question.group_id,new Set());
    questionVersions.get(question.group_id).add(Number(question.set_version));
  }
  const groups = new Map(list(context.groups).filter(group => selectedGroups.has(group.id)).map(group => [group.id,group]));
  const versions = new Map(bounded(list(source.versions)).map(version => [JSON.stringify([version.articleId,version.resultVersionId]),version]));
  const orders = new Map(bounded(list(source.orders)).map(order => [order.id,order]));
  return entry => {
    if (entry.kind === 'budget_set') return {attribution:'global_budget',groupId:null,groupName:null,selectedQuestionVersion:null,associationQuestionVersion:null,groupContext:'global_project_budget',businessScopeState:'not_filtered'};
    const order = orders.get(entry.orderId), version = order && versions.get(JSON.stringify([order.articleId,order.articleResultVersionId]));
    const exact = Boolean(version && order.articleDigest && version.digest === order.articleDigest);
    const association = exact ? version.association : null, groupId = typeof association?.groupId === 'string' && association.groupId ? association.groupId : null;
    const recordedQuestionVersion = association?.questionVersion ?? association?.setVersion;
    const associationQuestionVersion = Number.isSafeInteger(recordedQuestionVersion) && recordedQuestionVersion > 0 ? recordedQuestionVersion : null;
    // Observation rounds and their question membership never narrow the accounting ledger.
    // Only explicit predicates with preserved business facts can establish an outside association.
    const predicates = [
      {requested:list(scope.groupIds),actual:groupId ? [groupId] : null},
      {requested:list(scope.pools),actual:GEO_POOLS.includes(association?.pool) ? [association.pool] : null},
      {requested:list(scope.clientTags),actual:Array.isArray(association?.clientTags) && association.clientTags.every(tag=>typeof tag==='string') ? association.clientTags : null},
      {requested:scope.questionVersion != null ? [scope.questionVersion] : [],actual:associationQuestionVersion != null ? [associationQuestionVersion] : null},
    ].filter(predicate => predicate.requested.length);
    if (predicates.some(predicate => predicate.actual !== null && !predicate.requested.some(value => predicate.actual.includes(value)))) return null;
    const group = groups.get(groupId);
    return {attribution:groupId ? 'explicit_group' : 'unassigned',groupId,groupName:group?.name ?? null,
      selectedQuestionVersion:questionVersions.get(groupId)?.size === 1 ? [...questionVersions.get(groupId)][0] : null,associationQuestionVersion,
      groupContext:groupId ? group ? 'selected_current_group_label' : 'historical_association_current_metadata_unavailable' : 'association_unavailable',
      businessScopeState:predicates.length ? predicates.some(predicate => predicate.actual === null) ? 'unknown' : 'matched' : 'not_filtered',
      articleId:order?.articleId ?? null,resultVersionId:order?.articleResultVersionId ?? null,digest:order?.articleDigest ?? null,
      pinState:exact ? 'exact' : 'unknown',association:association ?? null};
  };
}

/** @param {any} selected @param {any} view @param {any} context */
function ledgerAnalysis(selected, view, context) {
  const source = context.execution?.finance ?? {}, ledger = source.ledger ?? {}, scope = selected.scope ?? {}, facet = view.financeFacet ?? 'ledger';
  if (!['ledger','group'].includes(facet)) throw invalid('Choose a ledger or group finance view.');
  const businessDateFormat = new Intl.DateTimeFormat('en-CA',{timeZone:scope.timeZone ?? 'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
  const all = bounded(list(ledger.items)), associationFor = ledgerAssociations(selected,context,source), memberItems = new Map();
  let opening = ledger.opening ?? geoLedgerBalances([]).opening;
  const admitted = [];
  for (const entry of all) {
    if (!amountKinds.includes(entry.kind)) continue;
    const time = geoBusinessTime(entry.createdAt,scope);
    // Historical balances include every project row before the interval, including other groups.
    if (scope.from && entry.createdAt && geoBusinessTime(entry.createdAt,{...scope,from:null,to:scope.from}).admitted && !geoBusinessTime(entry.createdAt,{...scope,to:null}).admitted) opening = entry.balance;
    const association = associationFor(entry);
    if (!association || !time.admitted) continue;
    admitted.push({...entry,...association,id:`ledger:${entry.id}`,objectId:entry.id,unit:'ledger_entries',currency:'CNY',at:time.at,timeState:time.timeState,timeBasis:'ledger_created_at',balanceBasis:'whole_project_full_prefix'});
  }
  const fields = facet === 'ledger' ? [['amountCny','记录金额','CNY'],['reservedCny','累计预留余额','CNY'],['settledCny','累计结算','CNY'],['refundedCny','累计退款','CNY'],['spentCny','累计净支出','CNY'],['budgetCny','当时项目预算','CNY'],['availableCny','当时项目可用预算','CNY']] :
    [['reserveCny','区间预留','CNY'],['releaseCny','区间释放预留','CNY'],['settleCny','区间结算','CNY'],['refundCny','区间退款','CNY'],['spentCny','区间结算减退款','CNY'],['budgetCny','区间末次项目预算设置','CNY']];
  const columns = columnsOf(fields), buckets = new Map();
  for (const item of admitted) {
    const key = facet === 'ledger' ? item.id : JSON.stringify([item.attribution,item.groupId]);
    if (!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(item);
  }
  const rows = [...buckets].map(([identity,items]) => {
    const item = items[0], key = hash([view.viewId,facet,identity]);
    const attributionLabel = item.attribution === 'global_budget' ? '项目整体预算' : item.attribution === 'unassigned' ? '未归属问题群' : item.groupName ?? (item.groupContext === 'historical_association_current_metadata_unavailable' ? '历史关联问题群（当前资料未知）' : '已关联问题群（名称未记录）');
    const businessDate = item.at ? businessDateFormat.format(new Date(item.at)) : null;
    const label = facet === 'ledger' ? `${businessDate ?? '日期未知'} · ${labels[item.kind]} · ${attributionLabel}` : attributionLabel;
    const values = {};
    const sums = projectMoney(null,items);
    for (const column of columns) {
      const kind = ({reserveCny:'reserve',releaseCny:'release',settleCny:'settle',refundCny:'refund',budgetCny:'budget_set'})[column.key];
      const members = facet === 'ledger' ? items : column.key === 'spentCny' ? items.filter(entry => ['settle','refund'].includes(entry.kind)) : items.filter(entry => entry.kind === kind);
      const amount = facet === 'ledger' ? column.key === 'amountCny' ? item.amountCny : item.balance?.[column.key] : column.key === 'spentCny' ? sums.spentCny : column.key === 'budgetCny' ? members.at(-1)?.amountCny ?? null : Math.round(members.reduce((sum,entry) => sum+entry.amountCny,0)*100)/100;
      values[column.key] = {...numeric(amount,'CNY'),memberUnit:'ledger_entries'};
      // A balance is one authoritative statement reading; it is not a sum of transition amounts in this cell.
      if (facet === 'ledger' && column.key !== 'amountCny') {
        values[column.key].memberUnit = 'ledger_balance_readings';
        memberItems.set(`${key}:${column.key}`,[{...item,unit:'ledger_balance_readings',prefixThroughLedgerId:item.objectId}]);
      } else memberItems.set(`${key}:${column.key}`,members);
    }
    return {key,label,metricId:null,dimensions:{kind:'project_finance',facet,attribution:item.attribution,groupId:item.groupId,selectedQuestionVersion:item.selectedQuestionVersion,
      groupContext:item.groupContext,businessScopeState:items.some(entry=>entry.businessScopeState==='unknown')?'unknown':item.businessScopeState,ledgerKind:facet === 'ledger' ? item.kind : null,date:facet === 'ledger' ? item.at : null,balanceBasis:'whole_project_full_prefix',currency:'CNY',objects:items},values};
  });
  const partial = admitted.some(item => item.attribution === 'unassigned' || item.timeState === 'unknown' || item.groupContext === 'historical_association_current_metadata_unavailable' || item.businessScopeState === 'unknown');
  return {columns,rows,memberItems,dependencies:{finance:source},definition:{methodVersion:'authoritative-project-ledger-v1',
    countingRule:'CNY reserve, release, settle, refund and budget-setting entries are separate facts. Project spend is settled minus refunded, using projectMoney. Recharge is account credit and excluded. Reserved balance and refund are not extra expenses.',
    denominatorRule:'Complete project ledger prefixes and last preceding budget_set determine historical balances. Current configured summary is separate context. Group monetary totals use the same two-decimal CNY rounding as projectMoney. Date filters use ledger createdAt; observation round or engine membership never removes historical accounting. Only explicit group, pool, client-tag or question-version predicates with preserved association facts exclude established outside records; unknown mappings remain labelled. Group attribution requires the exact order article/version/digest association. Historical pins survive missing current metadata. Missing attribution stays unassigned; the global budget is not a group budget.'},
    contextualBasis:[{kind:'project_ledger',currency:'CNY',opening,currentSummary:ledger.summary ?? null,currentSummaryTemporalBasis:'current_project_configuration_and_full_ledger',
      historicalBalanceBasis:'whole_project_full_prefix_last_budget_set',observationSelection:selected.selection?.reference ?? null,businessAssociationScope:{groupIds:list(scope.groupIds),pools:list(scope.pools),clientTags:list(scope.clientTags),questionVersion:scope.questionVersion ?? null,unknownMapping:'retained'},businessDateScope:{from:scope.from ?? null,to:scope.to ?? null,timeZone:scope.timeZone ?? 'Asia/Shanghai'},digest:hash(source)}],
    chart:{kind:'project_finance',labels:rows.map(row => row.label),series:[],cells:rows.flatMap(row => columns.map(column => ({rowKey:row.key,columnKey:column.key,label:row.label,columnLabel:column.label,...row.values[column.key]})))},
    availability:{status:rows.length ? partial ? 'partial' : 'available' : 'empty',reasons:partial ? ['finance_attribution_or_time_unknown'] : rows.length ? [] : ['no_selected_ledger_entries']}};
}

/** @param {any} selected @param {any} view @param {any} context */
function planAnalysis(selected, view, context) {
  const source = context.execution?.finance ?? {}, plan = source.plan, basis = plan?.basis, memberItems = new Map();
  if (view.targetVersion != null && basis?.targets?.version !== view.targetVersion) throw invalid('Choose the target version frozen by this plan.',409);
  const columns = columnsOf([['frozenBaseline','方案冻结实测','metric'],['recordedBaseline','目标表登记基线','metric'],['current','当前所选实测','metric'],['target','方案目标','metric'],['budgetCny','方案预算估计','CNY'],['placements','计划投放数','placements'],['horizonWeeks','目标周期','weeks']]);
  const targets = bounded(list(basis?.targets?.rows)), frozen = bounded(list(basis?.readings?.selected?.cells)), current = list(selected.computed?.cells);
  const rows = targets.map((target,index) => {
    const pool = target.pool ?? 'all', metricId = geoMetricId(target.metricId) ?? target.metricId, unit = GEO_METRIC_UNITS[metricId] ?? 'unknown';
    const matches = cell => cell.metricId === metricId && !cell.engine && !cell.variant && !cell.rival && !cell.arm && (pool === 'all' ? cell.scope === 'project' : cell.scope === 'pool' && cell.pool === pool);
    const old = frozen.find(matches), now = current.find(matches), key = hash(['V26',plan.version,basis.targets.version,index,target]);
    const targetIdentity = {id:`target:${plan.version}:${basis.targets.version}:${index}`,unit:'target_rows',strategyVersion:plan.version,targetVersion:basis.targets.version,scopeKey:plan.scopeKey,basisDigest:plan.basisDigest,...target};
    const objects = [targetIdentity], values = {};
    for (const column of columns) {
      const cell = column.key === 'frozenBaseline' ? old : column.key === 'current' ? now : null;
      const value = column.key === 'frozenBaseline' || column.key === 'current' ? cell?.value : column.key === 'recordedBaseline' ? target.baseline : target[column.key];
      values[column.key] = numeric(value,column.unit === 'metric' ? unit : column.unit,column.key === 'frozenBaseline' ? 'frozen_reading_unavailable' : 'not_recorded');
      if (cell) {
        values[column.key].metric = cell;
        if (cell.status !== 'ok') {values[column.key].state = cell.status === 'insufficient' ? 'insufficient' : cell.status === 'absent' ? 'no_data' : 'unknown';values[column.key].reason = cell.reason ?? 'metric_unavailable';}
        if (column.key === 'frozenBaseline') {
          const item = {...cell,id:`frozen:${key}`,unit:'frozen_metric_readings',strategyVersion:plan.version,targetVersion:basis.targets.version,scopeKey:plan.scopeKey,basisDigest:plan.basisDigest,
            memberReference:cell.memberReference ?? basis.selection?.reference ?? null,memberDigest:cell.memberDigest ?? null,memberCount:cell.memberCount ?? null,temporalBasis:'frozen_plan_reading'};
          objects.push(item);memberItems.set(`${key}:${column.key}`,[item]);values[column.key].memberUnit = 'frozen_metric_readings';
        } else if (selected.computed?.balance && selected.metricOptions) {
          const members = geoMetricMembers(selected.computed.balance.rows,cell,selected.metricOptions);
          const items = members.rows.map(row => ({id:row.snapshotId,unit:members.unit,snapshotId:row.snapshotId,questionId:row.questionId,roundId:row.roundId,engine:row.engine,askedAt:row.askedAt ?? null,status:row.status}));
          memberItems.set(`${key}:${column.key}`,items);values[column.key].memberUnit = members.unit;objects.push(...items);
        }
      } else if (!['frozenBaseline','current'].includes(column.key)) {memberItems.set(`${key}:${column.key}`,[targetIdentity]);values[column.key].memberUnit = 'target_rows';}
    }
    return {key,label:`${GEO_METRIC_LABELS_ZH[metricId] ?? metricId} · ${pool} · ${target.tier}`,metricId,dimensions:{kind:'frozen_plan_target',pool,tier:target.tier,strategyVersion:plan.version,targetVersion:basis.targets.version,
      scopeKey:plan.scopeKey,basisDigest:plan.basisDigest,historicalSelection:basis.selection?.reference ?? null,currentSelection:selected.selection?.reference ?? null,dataType:target.dataType ?? null,objects},values};
  });
  const partial = rows.some(row => Object.values(row.values).some(value => value.state !== 'known'));
  return {columns,rows,memberItems,dependencies:{finance:source,currentCells:current},definition:{methodVersion:'exact-frozen-plan-targets-v1',
    countingRule:'Each recorded tier/metric/pool target is retained. Frozen measured readings, target-table baseline, current selected measured cells and estimated target/cost values are different facts. No value is recalculated or replaced with a current plan.',
    denominatorRule:'Metric units and domain membership remain unchanged. Frozen readings retain historical memberReference/memberDigest even if old members are unavailable. Current observations use the exact selected universe. Budget, placements, horizon, price references, tiers and assumptions are planning context, not measured expenditure or ROI.'},
    contextualBasis:[{kind:'frozen_plan',strategyVersion:plan?.version ?? null,targetVersion:basis?.targets?.version ?? null,scopeKey:plan?.scopeKey ?? null,basisDigest:plan?.basisDigest ?? null,
      frozenScope:basis?.scope ?? null,frozenSelection:basis?.selection ?? null,frozenGroups:basis?.groups ?? [],readingsKind:plan?.readingsKind ?? null,freshness:plan?.freshness ?? null,
      currentSelection:selected.selection ?? null,currentTemporalBasis:'selected_current_observations',priceReferences:basis?.priceReferences ?? [],costAssumptions:plan?.assumptions ?? null,tiers:plan?.tiers ?? null}],
    chart:{kind:'frozen_plan_targets',labels:rows.map(row => row.label),series:[],cells:rows.flatMap(row => columns.map(column => ({rowKey:row.key,columnKey:column.key,label:row.label,columnLabel:column.label,...row.values[column.key]})))},
    availability:{status:!plan || !basis ? 'unavailable' : !rows.length ? 'empty' : partial ? 'partial' : 'available',reasons:!plan ? ['matching_plan_unavailable'] : !basis ? ['frozen_plan_basis_unavailable'] : !rows.length ? ['frozen_targets_unavailable'] : partial ? ['plan_reading_or_estimate_unknown'] : []}};
}

/** Common selected-analysis adapter. @param {any} selected @param {any} view @param {any} [context] */
export function buildGeoFinanceAnalysis(selected, view, context = {}) {
  if (view.viewId === 'V25') return ledgerAnalysis(selected,view,context);
  if (view.viewId === 'V26') return planAnalysis(selected,view,context);
  throw invalid('Choose a finance or frozen plan analysis.');
}
