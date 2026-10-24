/** Exact engine and versioned group-engine buckets; domain owns metric arithmetic. */
import { createHash } from 'node:crypto';
import { documentExportDigest, geoMetricMembers, GEO_METRIC_LABELS_ZH, GEO_METRIC_UNITS } from '@evimed/domain';
import { computeGeoSelection } from './geoReadScope.mjs';
import { foldText } from './geoParse.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(documentExportDigest(value)).digest('hex');
const memberItem = (row, unit = 'answers') => ({
  id: row.snapshotId, unit, snapshotId: row.snapshotId, questionId: row.questionId, engine: row.engine, roundId: row.roundId, repeatIndex: row.repeatIndex, askedAt: row.askedAt ?? null, status: row.status, extraction: row.facts ? {
    genericMentions: row.facts.judgeExtract?.genericMentions ?? null, parserVersion: row.facts.parserVersion ?? null, judgedAt: row.facts.judgedAt ?? null
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
