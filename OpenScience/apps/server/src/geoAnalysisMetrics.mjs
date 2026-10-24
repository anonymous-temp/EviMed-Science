/** Exact engine and versioned group-engine buckets; domain owns metric arithmetic. */
import { createHash } from 'node:crypto';
import { documentExportDigest, geoMetricMembers, GEO_METRIC_LABELS_ZH, GEO_METRIC_UNITS } from '@evimed/domain';
import { computeGeoSelection } from './geoReadScope.mjs';
import { geoComparisonMembers } from './geoComparison.mjs';
import { brandRegistry, registryKey, foldText } from './geoParse.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(documentExportDigest(value)).digest('hex');
const memberItem = (row, unit = 'answers') => ({
  id: row.snapshotId, unit, snapshotId: row.snapshotId, questionId: row.questionId, engine: row.engine, roundId: row.roundId, repeatIndex: row.repeatIndex, askedAt: row.askedAt ?? null, status: row.status, extraction: row.facts ? {
    genericMentions: row.facts.judgeExtract?.genericMentions ?? null, parserVersion: row.facts.parserVersion ?? null, registryKey: row.facts.registryKey ?? null, judgedAt: row.facts.judgedAt ?? null
  } : null
});
const state = cell => cell.status === 'ok' ? 'known' : cell.status === 'insufficient' ? 'insufficient' : cell.status === 'absent' ? 'no_data' : [
  'not_adjudicated', 'judgement_incomplete', 'not_extracted'
].includes(cell.reason) ? 'unjudged' : [
  'not_applicable', 'inclusion_surface'
].includes(cell.reason) ? 'not_applicable' : 'unknown';
/** @param {any} selected @param {any} view @param {any} [context] */
export function buildGeoMetricAnalysis(selected, view, context = {}) {
  const groups = new Map((context.groups ?? []).map(group => [
    group.id, group
  ])), rounds = new Map(selected.rounds.map(round => [
    round.id, round
  ]));
  const questions = new Map((selected.questions ?? []).map(question => [
    question.id, question
  ]));
  const generic = view.entityKind === 'generic', entityKey = generic ? (view.entityKey ?? context.product?.genericName) : context.product?.brandName ?? null;
  if (generic && (!entityKey || entityKey !== context.product?.genericName))
    throw new HttpError(400, 'geo_read_filter_invalid', 'Choose the project’s registered generic entity.');
  const buckets = new Map();
  // Dedupe is the existing per-engine policy. Cross-engine balancing does not remove engine observations.
  for (const row of selected.computed.balance.deduped) {
    if (view.viewId === 'V05' && !row.groupId)
      continue;
    const group = view.viewId === 'V05' ? groups.get(row.groupId) : null;
    const setVersion = view.viewId === 'V05' ? (questions.get(row.questionId)?.set_version ?? rounds.get(row.roundId)?.set_version ?? group?.set_version ?? null) : null;
    const dims = {
      engine: row.engine, groupId: view.viewId === 'V05' ? row.groupId : null, setVersion, entityKind: view.entityKind, entityKey
    };
    const key = documentExportDigest(dims);
    if (!buckets.has(key))
      buckets.set(key, {
        dims, rows: []
      });
    buckets.get(key).rows.push(row);
  }
  // Preserve missing configured platforms as absent domain cells, including missing intersections.
  const engines = selected.selection.engines ?? selected.metricOptions.engines ?? [];
  const dimensions = view.viewId === 'V04'
    ? [
      {
        groupId: null, setVersion: null, entityKind: view.entityKind, entityKey
      }
    ]
    : [
      ...new Map([
        ...buckets.values()
      ].map(bucket => { const { engine: _engine, ...dims } = bucket.dims; return [
        documentExportDigest(dims), dims
      ]; })).values()
    ];
  for (const dims of dimensions)
    for (const engine of engines) {
      const target = {
        ...dims, engine
      }, key = documentExportDigest(target);
      if (!buckets.has(key))
        buckets.set(key, {
          dims: target, rows: []
        });
      if (buckets.size > 20000)
        throw new HttpError(422, 'geo_read_filter_invalid', 'Narrow the scope to at most 20,000 analysis rows.');
    }
  const rows = [], memberItems = new Map();
  const bind = (row, columnKey, items, unit = 'answers', value = items.length) => { memberItems.set(`${row.key}:${columnKey}`, items.map(item => memberItem(item, unit))); return {
    value, state: 'known', reason: null, unit, metric: null, members: null
  }; };
  for (const { dims, rows: inputs } of buckets.values()) {
    const prefix = [
      view.viewId === 'V05' ? (groups.get(dims.groupId)?.name ?? '未命名问题群') : null, dims.setVersion != null ? `问题版本 ${dims.setVersion}` : null, dims.engine
    ].filter(Boolean).join(' · ');
    if (generic) {
      const row = {
        key: hash(dims), label: `当前配置通用名：${entityKey} · 提及回答 · ${prefix}`, metricId: null, dimensions: {
          ...dims, groupName: groups.get(dims.groupId)?.name ?? null, unit: 'answers'
        }, values: {}, links: []
      };
      const observed = inputs.filter(item => item.status === 'valid'), eligible = observed.filter(item => item.facts?.judgeExtract?.genericMentions?.some(mention => mention.ours === true && (mention.name === entityKey || mention.matchedNames?.includes(foldText(entityKey)))));
      const eligibleIds = new Set(eligible.map(item => item.snapshotId));
      const mentioned = eligible.filter(item => item.facts.judgeExtract.genericMentions.some(mention => (mention.name === entityKey || mention.matchedNames?.includes(foldText(entityKey))) && mention.ours === true && mention.count > 0));
      row.values = {
        mentioned: bind(row, 'mentioned', mentioned), eligible: bind(row, 'eligible', eligible), unknown: bind(row, 'unknown', observed.filter(item => !eligibleIds.has(item.snapshotId))), observed: bind(row, 'observed', observed)
      };
      rows.push(row);
      continue;
    }
    const options = {
      ...selected.metricOptions, engines: [
        dims.engine
      ]
    }, computed = computeGeoSelection(inputs, options);
    const matches = cell => cell.metricId === view.metricId && !cell.variant && !cell.rival && !cell.arm;
    let cells = computed.cells.filter(cell => matches(cell) && cell.scope === 'engine');
    if (!cells.length)
      cells = computed.cells.filter(cell => matches(cell) && cell.scope === 'pool_engine');
    if (!cells.length)
      cells = computed.cells.filter(cell => matches(cell) && cell.scope === 'project');
    if (!cells.length)
      cells = computed.cells.filter(cell => matches(cell) && cell.scope === 'pool');
    for (const cell of cells) {
      const key = hash([
        dims, cell.metricId, cell.pool
      ]), row = {
        key, label: `${GEO_METRIC_LABELS_ZH[cell.metricId] ?? cell.metricId} · ${prefix}${cell.pool ? ` · ${cell.pool}` : ''}`, metricId: cell.metricId, dimensions: {
          ...dims, groupName: groups.get(dims.groupId)?.name ?? null, pool: cell.pool, variant: cell.variant
        }, values: {}, links: []
      };
      const input = cell.scope === 'engine' || cell.scope === 'pool_engine' || cell.metricId === 'M-20' ? computed.balance.deduped : computed.balance.rows;
      const members = geoMetricMembers(/** @type {any[]} */ (input), cell, options);
      const value = bind(row, 'current', members.rows, members.unit, cell.value);
      value.state = state(cell);
      value.reason = cell.reason ?? null;
      value.metric = cell;
      value.memberUnit = members.unit;
      value.unit = GEO_METRIC_UNITS[cell.metricId] ?? 'index';
      row.values = {
        current: value
      };
      rows.push(row);
    }
  }
  rows.sort((a, b) => documentExportDigest(a.dimensions).localeCompare(documentExportDigest(b.dimensions)));
  const columns = generic ? [
    [
      'mentioned', '提及通用名的回答'
    ], [
      'eligible', '实体提取可定位的回答'
    ], [
      'unknown', '实体提取未能定位'
    ], [
      'observed', '取得回答'
    ]
  ].map(([key, label]) => ({
    key, label, type: 'number', unit: 'answers'
  })) : [
    {
      key: 'current', label: '所选实测', type: 'number', unit: GEO_METRIC_UNITS[view.metricId] ?? 'index'
    }
  ];
  return {
    definition: {
      metricId: view.metricId, unit: generic ? 'answers' : 'metric_inputs', methodVersion: selected.selection.methodVersion, dataType: generic ? 'observed_generic_facts' : 'domain_metric', countingRule: generic ? `当前配置通用名：${entityKey}。按保留的历史实体提取统计；当前名称不代表历史登记，也不由品牌提及推断。` : 'Existing domain metric computed over the exact engine and versioned group intersection.', denominatorRule: generic ? 'Valid deduplicated answers; exact preserved entity extraction, unknown extraction and positive mentions are separate counts. An absent generic entry is unknown, not a measured negative.' : 'Existing domain eligibility and floors; engine inputs use the canonical deduplicated cohort.'
    }, contextualBasis: [
      {
        kind: 'metric_entities_and_groups', id: 'project', version: null, digest: hash({
          groups: context.groups ?? [], product: context.product ?? null
        }), temporalBasis: 'current_context'
      }
    ], columns, rows, chart: {
      kind: view.viewId === 'V05' ? 'matrix' : 'bars', labels: rows.map(row => row.label), series: [], cells: rows.map(row => ({
        rowKey: row.key, columnKey: generic ? 'mentioned' : 'current', label: row.label, groupId: row.dimensions.groupId, groupName: row.dimensions.groupName, setVersion: row.dimensions.setVersion, engine: row.dimensions.engine, pool: row.dimensions.pool ?? null, value: row.values[generic ? 'mentioned' : 'current'].value, state: row.values[generic ? 'mentioned' : 'current'].state, reason: row.values[generic ? 'mentioned' : 'current'].reason ?? null, unit: row.values[generic ? 'mentioned' : 'current'].unit
      }))
    }, memberItems, dependencies: [
      ...memberItems
    ], availability: {
      status: !rows.length ? 'empty' : generic && rows.some(row => row.values.unknown.value > 0) ? 'partial' : 'ready', reasons: !rows.length ? [
        'no_selected_readings'
      ] : generic ? [
        'generic_observation_identity_only'
      ] : [], remedy: null
    }
  };
}

/** A shared selected comparison presenter, fed by the canonical common-cohort calculation. */
export function buildGeoComparisonAnalysis(selected, view, context = {}) {
    const comparison = selected.comparison, cohorts = comparison?.cohorts, memberItems = new Map(), rows = [];
    const candidates = comparison?.cells ?? selected.computed.cells.map(current => ({ ...current, current, previous: null, delta: null, comparable: false, reason: 'comparison_not_selected' }));
    for (const entry of candidates) {
        if (entry.scope !== view.dimension || view.metricId && entry.metricId !== view.metricId || entry.variant || entry.rival || entry.arm)
            continue;
        const dims = { scope: entry.scope, engine: entry.engine, groupId: entry.groupId, pool: entry.pool, groupName: (context.groups ?? []).find(group=>group.id===entry.groupId)?.name??null, comparisonMode: comparison?.mode ?? null, currentSelection: comparison?.currentSelection?.reference ?? selected.selection.reference, previousSelection: comparison?.previousSelection?.reference ?? null };
        const row = { key: hash([entry.metricId, dims]), label: [GEO_METRIC_LABELS_ZH[entry.metricId], entry.engine, dims.groupName, entry.pool].filter(Boolean).join(' · '), metricId: entry.metricId, dimensions: dims, values: {}, links: [] };
        const members = {};
        for (const period of ['previous', 'current']) {
            const metric = entry[period], source = cohorts?.[period] ?? (period === 'current' ? selected : null);
            const selectedMembers = source ? geoComparisonMembers(source, metric) : { rows: [], unit: 'answers' };
            memberItems.set(`${row.key}:${period}`, selectedMembers.rows.map(item => memberItem(item, selectedMembers.unit)));
            members[period] = selectedMembers.rows.length;
            row.values[period] = { value: metric?.value ?? null, state: metric ? state(metric) : 'no_data', reason: metric?.reason ?? (metric?.status === 'insufficient' ? 'insufficient_sample' : null), unit: GEO_METRIC_UNITS[entry.metricId], memberUnit: selectedMembers.unit, metric: metric ?? null, members: null };
        }
        const ranked = entry.comparable && entry.delta !== null;
        row.values.delta = { value: ranked ? entry.delta : null, state: ranked ? 'known' : 'unknown', reason: entry.reason ?? (!ranked ? 'insufficient_sample' : null), unit: GEO_METRIC_UNITS[entry.metricId] === 'percent' ? 'percentage_points' : GEO_METRIC_UNITS[entry.metricId], metric: null, members: null };
        for (const period of ['previous', 'current']) {
            row.values[`${period}Eligible`] = { value: members[period], state: 'known', unit: row.values[period].memberUnit, metric: null, members: null };
            row.values[`${period}Excluded`] = { value: comparison?.excluded?.[period] ?? 0, state: 'known', unit: 'answers', metric: null, members: null };
        }
        row.values.rank = { value: null, state: 'unknown', unit: 'rank', reason: row.values.delta.reason, metric: null, members: null };
        rows.push(row);
    }
    rows.sort((a, b) => Number(a.values.delta.value === null) - Number(b.values.delta.value === null) || (b.values.delta.value ?? 0) - (a.values.delta.value ?? 0) || a.key.localeCompare(b.key));
    let rank = 0;
    for (const row of rows)
        if (row.values.delta.value !== null)
            row.values.rank = { ...row.values.rank, value: ++rank, state: 'known', reason: null };
    const columns = [['rank', '可比变化排序'], ['previous', '对照实测'], ['current', '所选实测'], ['delta', '变化（百分点或指标原尺度）'], ['previousEligible', '对照合资格成员'], ['currentEligible', '所选合资格成员'], ['previousExcluded', '对照范围排除回答'], ['currentExcluded', '所选范围排除回答']].map(([key, label]) => ({ key, label, type: 'number' }));
    return { definition: { metricId: view.metricId, unit: 'metric', methodVersion: selected.selection.methodVersion, dataType: 'observational_comparison', countingRule: '只对相同问题、平台、采样方式、测量约定和指标合资格成员的可测读数排序。比例变化以百分点表示；综合指数还须保持组成指标与有效权重一致。', denominatorRule: '两期分别保留精确合资格成员与共同范围排除数；不可比或样本不足保留读数和原因，不参与排序。' }, contextualBasis: [], columns, rows, chart: { kind: 'comparison', labels: rows.map(row => row.label), series: [], cells: rows.map(row => ({ rowKey: row.key, columnKey: 'current', label: row.label, engine: row.dimensions.engine, pool: row.dimensions.pool, value: row.values.delta.value, state: row.values.delta.state, reason: row.values.delta.reason, unit: row.values.delta.unit })) }, memberItems, dependencies: [cohorts?.current?.selection, cohorts?.previous?.selection, cohorts?.current?.rows, cohorts?.previous?.rows], availability: { status: comparison ? 'ready' : 'partial', reasons: comparison ? [] : ['comparison_not_selected'], remedy: comparison ? null : 'choose_comparison' } };
}
/** Stable project registration keys; never infer competitors from answer text. */
export function geoRivalEntityKey(entity) { return String(entity.id ?? entity.key ?? entity.brandName ?? entity.genericName ?? ''); }
function timeBuckets(selected, grain) {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: selected.scope.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const observed = new Map();
    for (const row of selected.rows) {
        const key = grain === 'round' ? row.roundId : row.askedAt ? format.format(new Date(row.askedAt)) : null;
        if (key === null)
            continue;
        if (!observed.has(key))
            observed.set(key, []);
        observed.get(key).push(row);
    }
    return [...observed].map(([key, rows]) => { const times = rows.map(row => row.askedAt).filter(Boolean).sort(); return { key, rows, date: times[0] ? format.format(new Date(times[0])) : null, time: times[0] ?? 'z', period: grain }; }).sort((a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key)).map((bucket, index) => ({ ...bucket, roundOrdinal: grain === 'round' ? index + 1 : null, label: grain === 'round' ? `${bucket.date ?? '采样时间未知'} · 第 ${index + 1} 轮` : bucket.date }));
}
function normalizeBrands(row, registry) {
    const brands = registry.filter(entity => entity.aliases.length).map(entity => {
        const matches = (row.facts?.brands ?? []).filter(brand => (brand.ours === true) === entity.ours && (brand.competitor === true) === entity.competitor && [entity.name, ...entity.aliases].map(foldText).includes(foldText(brand.name)));
        const canonical = matches.find(brand => brand.name === entity.name);
        return { name: entity.name, ours: entity.ours, competitor: entity.competitor, count: Math.max(0, canonical?.count ?? Math.max(0, ...matches.map(brand => brand.count ?? 0))) };
    });
    return { ...row, facts: row.facts ? { ...row.facts, brands } : null };
}
/** Monitoring, charts, exports and native freezes use these same pool-qualified rows. @param {any} selected @param {any} view @param {any} [context] */
export function buildGeoRivalAnalysis(selected, view, context = {}) {
    const product = context.product ?? {}, competitors = context.competitors ?? [], registered = brandRegistry(product, competitors), currentRegistryKey = registryKey(registered, selected.metricOptions.owned ?? {});
    const entries = [{ ...product, own: true }, ...competitors.map(entity => ({ ...entity, own: false }))].filter(entity => geoRivalEntityKey(entity));
    if (view.entityKey && !entries.some(entity => geoRivalEntityKey(entity) === view.entityKey))
        throw new HttpError(400, 'geo_read_filter_invalid', 'Choose a registered project entity.');
    const memberItems = new Map(), rows = [], buckets = [{ key: 'selected', period: 'selected', rows: selected.rows, date: null, roundOrdinal: null, label: '所选区间' }, ...timeBuckets(selected, view.timeGrain ?? 'day')];
    const rounds = new Map(selected.rounds.map(round => [round.id, round]));
    const pools = [...new Set([...selected.rows.map(row => row.pool), ...(selected.selection.pools ?? [])].filter(Boolean))].sort();
    const basisFor = row => {
        const snapshot = rounds.get(row.roundId)?.ref?.evaluationBasis;
        if (snapshot) {
            const frozen = brandRegistry(snapshot.product, snapshot.competitors);
            return { registry: frozen, key: snapshot.registryKey ?? registryKey(frozen, snapshot.owned ?? {}), snapshot };
        }
        return { registry: registered, key: currentRegistryKey, snapshot: null };
    };
    for (const bucket of buckets)
        for (const pool of pools)
            for (const entity of entries) {
                const entityKey = geoRivalEntityKey(entity);
                if (view.entityKey && view.entityKey !== entityKey)
                    continue;
                const generic = !entity.brandName, kind = generic ? 'generic' : 'brand';
                const dims = { entityKey, entityKind: kind, entityName: entity.brandName ?? entity.genericName, own: entity.own, pool, period: bucket.period, date: bucket.date, roundId: bucket.period === 'round' ? bucket.key : null, roundOrdinal: bucket.roundOrdinal, roundLabel: bucket.period === 'round' ? `第 ${bucket.roundOrdinal} 轮` : null, engine: null };
                const row = { key: hash(dims), label: `${dims.entityName} · ${generic ? '通用名观测' : entity.own ? '本品' : '已登记竞品'} · ${pool}`, metricId: generic ? null : view.metricId, dimensions: dims, values: {}, links: [] };
                const balanced = /** @type {any[]} */ (computeGeoSelection(bucket.rows, selected.metricOptions).balance.rows).filter(item => item.pool === pool), observed = balanced.filter(item => item.status === 'valid' && item.facts);
                const exactEntity = (item) => { const basis = basisFor(item); const saved = basis.snapshot ? (entity.own ? basis.snapshot.product : (basis.snapshot.competitors ?? []).find(candidate => geoRivalEntityKey(candidate) === entityKey)) : entity; return { basis, saved }; };
                const eligible = observed.filter(item => { const { basis, saved } = exactEntity(item); if (!saved)
                    return false; if (generic)
                    return (item.facts?.judgeExtract?.genericMentions ?? []).some(mention => mention.name === (saved.brandName ?? saved.genericName) && mention.ours === entity.own); return Boolean(basis.snapshot) && (item.status === 'refusal' || item.facts?.registryKey === basis.key) && Boolean(saved.brandName)&&basis.registry.some(entry=>entry.name===saved.brandName&&entry.ours===entity.own&&entry.aliases.length>0); });
                const eligibleIds = new Set(eligible.map(item => item.snapshotId)), unknown = observed.filter(item => !eligibleIds.has(item.snapshotId));
                const positive = observed.filter(item => { const { basis, saved } = exactEntity(item); if (!saved)
                    return false; const name = saved.brandName ?? saved.genericName; return generic ? (item.facts?.judgeExtract?.genericMentions ?? []).some(mention => mention.name === name && mention.ours === entity.own && mention.count > 0) : (normalizeBrands(item, basis.registry).facts?.brands ?? []).some(brand => brand.name === name && brand.ours === entity.own && brand.count > 0); });
                const normalizeInput = item => {
                    const basis = basisFor(item), normalized = normalizeBrands(item, basis.registry);
                    if (normalized.facts)
                        normalized.facts.brands = normalized.facts.brands.flatMap(brand => {
                            const saved = brand.ours ? basis.snapshot?.product : (basis.snapshot?.competitors ?? []).find(candidate => (candidate.brandName ?? candidate.genericName) === brand.name);
                            return saved ? [{ ...brand, name: geoRivalEntityKey(saved) }] : [];
                        });
                    return normalized;
                };
                const input = eligible.map(normalizeInput);
                // Explicit report selection is the measurement agreement; the entity set is recorded with the round.
                const shareAgreed = input.length > 0 && input.every(item => { const round = rounds.get(item.roundId); return round?.surface?.measurementContract?.metricIds?.includes('M-17') && Boolean(round?.ref?.evaluationBasis) && geoRivalEntityKey(round.ref.evaluationBasis.product??{})===geoRivalEntityKey(product) && documentExportDigest((round.ref.evaluationBasis.competitors ?? []).filter(entry => entry.brandName).map(geoRivalEntityKey).sort()) === documentExportDigest(entries.filter(entry => !entry.own && entry.brandName).map(geoRivalEntityKey).sort()); });
                const rivalName = entity.own ? null : entityKey;
                const options = { ...selected.metricOptions, competitors: entries.filter(entry => !entry.own && entry.brandName).map(geoRivalEntityKey) };
                const computed = computeGeoSelection(input, options);
                const id = entity.own ? (view.metricId === 'M-17' ? 'M-04' : 'M-01') : view.metricId;
                row.metricId=generic?null:id;
                let metric = /** @type {any} */ (generic ? null : computed.cells.find(cell => cell.metricId === id && cell.scope === 'pool' && cell.pool === pool && cell.rival === rivalName && !cell.variant && !cell.arm) ?? null);
                const reason = generic ? 'generic_observation_identity_only' : !eligible.length ? 'rival_history_unknown' : view.metricId === 'M-17' && !shareAgreed ? 'share_agreement_missing' : null;
                if (reason && !generic)
                    metric = { ...(metric ?? {}), metricId: id, status: 'not_measurable', reason, value: null, numerator: null, denominator: null };
                const member = metric ? geoMetricMembers(/** @type {any[]} */ (computed.balance.rows), metric, options) : { rows: eligible, unit: 'answers' };
                const bind = (key, items, value = items.length, unit = 'answers', cell = null) => { memberItems.set(`${row.key}:${key}`, items.map(item => memberItem(item, unit))); return { value, state: 'known', unit, memberUnit: unit, metric: cell, members: null, reason: null }; };
                row.values = { current: bind('current', member.rows, generic ? positive.length : metric?.value ?? null, member.unit, metric), mentioned: bind('mentioned', positive), eligible: bind('eligible', eligible), unknown: bind('unknown', unknown) };
                const ownMetric = generic ? null : computed.cells.find(cell => cell.metricId === (view.metricId === 'M-17' ? 'M-04' : 'M-01') && cell.scope === 'pool' && cell.pool === pool && !cell.rival && !cell.variant && !cell.arm) ?? null;
                const ownMembers = ownMetric ? geoMetricMembers(/** @type {any[]} */ (computed.balance.rows), ownMetric, options) : { rows: [], unit: 'answers' };
                row.values.pairedOwn = bind('pairedOwn', ownMembers.rows, reason || generic ? null : ownMetric?.value ?? null, ownMembers.unit, ownMetric);
                row.values.pairedOwn.memberUnit = ownMembers.unit;
                row.values.pairedOwn.unit = 'percent';
                row.values.pairedOwn.state = reason || generic ? 'unknown' : ownMetric ? state(ownMetric) : 'no_data';
                row.values.pairedOwn.reason = reason ?? ownMetric?.reason ?? null;
                row.values.current.memberUnit = member.unit;
                row.values.current.unit = generic ? 'answers' : 'percent';
                if (!generic) {
                    row.values.current.state = metric ? state(metric) : 'no_data';
                    row.values.current.reason = reason ?? metric?.reason ?? null;
                }
                else if (!eligible.length) {
                    row.values.current.value = null;
                    row.values.current.state = 'unknown';
                    row.values.current.reason = 'rival_history_unknown';
                }
                row.dimensions.recordedEntities=[...new Map(balanced.map(item=>{const {saved}=exactEntity(item);return [item.roundId,{roundId:item.roundId,name:saved?.brandName??saved?.genericName??null,aliases:saved?.aliases??[],genericAliases:saved?.genericAliases??[]}];})).values()];
                const recordedNames=[...new Set(row.dimensions.recordedEntities.map(item=>item.name).filter(Boolean))];
                row.dimensions.entityLabel=recordedNames.some(name=>name!==row.dimensions.entityName)?`当前登记：${row.dimensions.entityName}（历史登记：${recordedNames.join('、')}）`:row.dimensions.entityName;
                row.label=`${row.dimensions.entityLabel} · ${generic?'通用名观测':entity.own?'本品':'已登记竞品'} · ${pool}`;
                row.dimensions.registryBasis = [...new Set(balanced.map(item => hash(basisFor(item).snapshot)))].sort();
                row.dimensions.temporalBasis = balanced.every(item => basisFor(item).snapshot) ? 'recorded' : 'current_context_history_unknown';
                rows.push(row);
            }
    const points = rows.filter(row => row.dimensions.period !== 'selected'), labels = buckets.slice(1).map(bucket => bucket.label), seriesEntries = entries.filter(entity => !view.entityKey || geoRivalEntityKey(entity) === view.entityKey);
    const series = pools.flatMap(pool => seriesEntries.map(entity => { const matching = points.filter(row => row.dimensions.entityKey === geoRivalEntityKey(entity) && row.dimensions.pool === pool); return { key: hash([geoRivalEntityKey(entity), pool]), label: `${entity.brandName ?? entity.genericName} · ${pool}`, own: entity.own, values: matching.map(row => row.values.current.state === 'known' ? row.values.current.value : null) }; }));
    return { definition: { metricId: view.metricId, unit: 'percent', methodVersion: selected.selection.methodVersion, dataType: 'registered_competitor_metrics', countingRule: view.metricId === 'M-17' ? '所选回答与已登记品牌集合的相对提及声量份额；仅用于明确选择该指标并记录实体集合的测量，不代表市场份额。' : '各问句池分别计算已登记竞品的阳性提及回答 / 合资格回答，本品使用相同合资格回答；通用名独立观测，不汇总为整体竞品指标。', denominatorRule: '按原有领域指标的去重、平衡、适用性和样本要求计算。未保存登记依据的历史缺席保持未知；每个池、日期和实际轮次独立计算。' }, contextualBasis: [{ kind: 'registered_entities', id: 'project', version: null, digest: hash({ product, competitors, rounds: selected.rounds.map(round => [round.id, round.ref?.evaluationBasis, round.surface?.measurementContract]) }), temporalBasis: 'recorded_when_available_current_context_otherwise' }], columns: [{ key: 'current', label: view.metricId === 'M-17' ? '相对提及份额 / 通用名观测（回答）' : '提及率 / 通用名观测', type: 'number' }, { key: 'pairedOwn', label: '同一合资格回答中的本品', type: 'number' }, { key: 'mentioned', label: '阳性提及回答', type: 'number' }, { key: 'eligible', label: '登记依据完整的回答', type: 'number' }, { key: 'unknown', label: '历史依据未知的回答', type: 'number' }], rows, chart: { kind: 'rivals', labels, series, cells: rows.filter(row => row.dimensions.period === 'selected').map(row => ({ rowKey: row.key, columnKey: 'current', label: row.label, entityName: row.dimensions.entityLabel, own: row.dimensions.own, engine: null, pool: row.dimensions.pool, value: row.values.current.value, state: row.values.current.state, reason: row.values.current.reason, unit: row.values.current.unit })) }, memberItems, dependencies: [selected.rows, selected.metricOptions, selected.rounds], availability: { status: rows.length ? 'ready' : 'empty', reasons: rows.some(row => row.values.unknown.value > 0) ? ['rival_history_unknown'] : [], remedy: null } };
}
/** Compatibility projection has no arithmetic: each own point is the rival's exact eligible-cohort domain reading. */
export function geoRivalMonitoringRows(analysis) {
    const keys = [...new Set(analysis.rows.filter(row => !row.dimensions.own && row.dimensions.entityKind === 'brand').map(row => documentExportDigest([row.dimensions.entityKey, row.dimensions.pool])))];
    return keys.map(key => {
        const rows = analysis.rows.filter(row => documentExportDigest([row.dimensions.entityKey, row.dimensions.pool]) === key && row.dimensions.period === 'day'), summary = analysis.rows.find(row => documentExportDigest([row.dimensions.entityKey, row.dimensions.pool]) === key);
        const point = (row, column) => { const value = row.values[column]; return { date: row.dimensions.date, value: value.state === 'known' ? value.value : null, n: value.metric?.denominator ?? null, k: value.metric?.numerator ?? null, coverage: documentExportDigest([row.dimensions.pool, row.dimensions.registryBasis]), status: value.state, analysisMembers: value.members ?? null }; };
        return { name: summary.dimensions.entityName, label: `${summary.dimensions.entityLabel??summary.dimensions.entityName} · ${summary.dimensions.pool}`, entityKey: summary.dimensions.entityKey, pool: summary.dimensions.pool, points: rows.map(row => point(row, 'current')), ownPoints: rows.map(row => point(row, 'pairedOwn')), unknownTimeCount: analysis.selection.timeCoverage?.unknownTime ?? 0 };
    });
}
