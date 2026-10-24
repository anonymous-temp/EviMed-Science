/** V09 reads preserved model classifications; it never infers semantics or schedules a judge. */
import { createHash } from 'node:crypto';
import { documentExportDigest } from '@evimed/domain';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(documentExportDigest(value)).digest('hex');
const states = ['recommended', 'conditional', 'reasonable_nonrecommendation', 'mention_only'];
const labels = { recommended: '推荐', conditional: '条件性推荐', reasonable_nonrecommendation: '合理不推荐', mention_only: '仅提及', unknown: '尚未分类', no_mention: '完整提取且无药品表达', refused: '拒答', unclassified: '分类未知', incomplete: '提取不完整' };
/** @param {any} selected @param {any} _view @param {any} [_context] */
export function buildGeoRecommendationAnalysis(selected, _view, _context = {}) {
  const memberItems = new Map(), rows = [], expressions = [], answers = [];
  for (const observation of selected.rows) {
    if (!['valid', 'refusal'].includes(observation.status)) continue;
    const preserved = observation.assessmentFacts ?? {}, active = observation.facts ?? {};
    const extract = preserved.judgeExtract ?? active.judgeExtract;
    const raw = extract?.recommendationExpressions;
    const versioned = raw?.schemaVersion === 1 && raw.rubric === 'geo-recommendation-expression-v1' && Array.isArray(raw.items);
    const assessmentVersion = preserved.assessmentVersion ?? null;
    const assessmentPayloadDigest = assessmentVersion ? null : hash([observation.snapshotId, preserved.judgedAt ?? active.judgedAt, extract ?? null]);
    const common = { snapshotId: observation.snapshotId, questionId: observation.questionId, engine: observation.engine,
      roundId: observation.roundId, status: observation.status, askedAt: observation.askedAt ?? null, assessmentVersion, assessmentPayloadDigest,
      registryKey: preserved.registryKey ?? active.registryKey ?? null,
      questionVersion: preserved.questionVersion ?? selected.questions?.find(q => q.id === observation.questionId)?.set_version ?? null,
      parserVersion: preserved.parserVersion ?? active.parserVersion ?? null };
    const entry = { ...common, id: observation.snapshotId, unit: 'answers', versioned,
      coverage: versioned ? (!active.judgedAt && !preserved.judgedAt || observation.status === 'refusal' ? 'partial' : raw.coverage) : 'unknown', expressionIds: [] };
    answers.push(entry);
    const source = versioned ? raw.items : (Array.isArray(extract?.recommendations) ? extract.recommendations.flatMap(value => {
      const quote = typeof value === 'string' ? value : value?.text;
      if (typeof quote !== 'string' || !quote.trim()) return [];
      const names = Array.isArray(value?.entities) ? value.entities.filter(entity => typeof entity === 'string' && quote.includes(entity)) : [];
      return (names.length ? names : [null]).map(entity => ({ quote, entity, state: 'unknown', conditionQuote: null, explicitPosition: null, positionQuote: null, claimRefs: [] }));
    }) : []);
    for (const item of source) {
      if (!item || typeof item.quote !== 'string' || (versioned || item.entity !== null) && (typeof item.entity !== 'string' || !item.quote.includes(item.entity))) continue;
      const expression = { ...item, state: [...states, 'unknown'].includes(item.state) ? item.state : 'unknown' };
      // An identical quotation can occur more than once. Each preserved byte occurrence remains an expression.
      const offsets = Array.isArray(item.answerOffsets) && item.answerOffsets.length ? item.answerOffsets : [item.answerOffset ?? null];
      for (const offset of offsets) {
        const id = hash([common.snapshotId, assessmentVersion ?? assessmentPayloadDigest, offset, expression.quote, expression.entity, expression.conditionQuote]);
        if (entry.expressionIds.includes(id)) continue;
        const record = { ...common, id, unit: 'expressions', expression: { ...expression, answerOffset: offset }, rubric: versioned ? raw.rubric : null, legacy: !versioned, coverage: entry.coverage };
        expressions.push(record); entry.expressionIds.push(id);
      }
    }
  }
  if (expressions.length > 200000) throw new HttpError(422, 'geo_read_filter_invalid', 'Narrow the scope to at most 200,000 recommendation expressions.');
  const complete = answers.length > 0 && answers.every(a => a.versioned && a.coverage === 'complete' && a.status === 'valid');
  const known = expressions.filter(item => states.includes(item.expression.state));
  const cell = (items, unit, unknown = false) => ({ value: unknown ? null : items.length, state: unknown ? 'unknown' : 'known',
    reason: unknown ? 'recommendation_coverage_incomplete' : null, unit, metric: null, members: null, links: [], _items: items });
  const add = (dimensions, label, values) => {
    const key = hash(['V09', dimensions]);
    for (const [columnKey, value] of Object.entries(values)) { memberItems.set(`${key}:${columnKey}`, value._items); delete value._items; }
    rows.push({ key, label, metricId: null, dimensions, values, links: [] });
  };
  for (const category of [...states, 'unknown']) {
    const items = expressions.filter(item => item.expression.state === category), ids = new Set(items.map(item => item.snapshotId));
    add({ kind: 'distribution', category, unit: 'expressions' }, labels[category], {
      expressions: cell(items, 'expressions', !items.length && !complete),
      answers: cell(answers.filter(answer => ids.has(answer.id)), 'answers', !items.length && !complete),
    });
  }
  for (const category of ['no_mention', 'refused', 'unclassified', 'incomplete']) {
    const items = answers.filter(answer => category === 'no_mention' ? answer.status === 'valid' && answer.versioned && answer.coverage === 'complete' && !answer.expressionIds.length
      : category === 'refused' ? answer.status === 'refusal'
      : category === 'incomplete' ? answer.status === 'valid' && answer.versioned && answer.coverage !== 'complete'
      : !answer.versioned || expressions.some(item => item.snapshotId === answer.id && item.expression.state === 'unknown'));
    add({ kind: 'coverage', category, unit: 'answers' }, labels[category], { expressions: cell([], 'expressions', true), answers: cell(items, 'answers') });
  }
  for (const item of expressions) add({ kind: 'expression', category: item.expression.state, snapshotId: item.snapshotId, assessmentVersion: item.assessmentVersion, assessmentPayloadDigest: item.assessmentPayloadDigest,
    questionVersion: item.questionVersion, registryKey: item.registryKey, quoteOccurrence: item.expression.answerOffset, entity: item.expression.entity,
    quote: item.expression.quote, conditionQuote: item.expression.conditionQuote ?? null, rationale: item.expression.rationale ?? null, rubric: item.rubric, explicitPosition: item.expression.explicitPosition ?? null,
    positionQuote: item.expression.positionQuote ?? null, positionToken: item.expression.positionToken ?? null, positionKind: item.expression.positionKind ?? null, nonrecommendationBasis: item.expression.nonrecommendationBasis ?? null,
    claimRefs: item.expression.claimRefs ?? [], legacy: item.legacy, coverage: item.coverage },
  `${labels[item.expression.state]} · ${item.expression.entity ?? '对象未保留'} · ${item.expression.quote}`, { expressions: cell([item], 'expressions'), answers: cell(answers.filter(answer => answer.id === item.snapshotId), 'answers') });
  if (rows.length > 20000) throw new HttpError(422, 'geo_read_filter_invalid', 'Narrow the recommendation scope to at most 20,000 rows.');
  const chartCells = rows.filter(row => row.dimensions.kind === 'distribution' && states.includes(row.dimensions.category)).map(row => ({ rowKey: row.key, columnKey: 'expressions', label: row.label, ...row.values.expressions, engine: null, groupId: null, setVersion: null }));
  return { rows, memberItems, columns: [{ key: 'expressions', label: '表达数（互斥分类）', type: 'number', unit: 'expressions' }, { key: 'answers', label: '独立回答数（分类间可重叠）', type: 'number', unit: 'answers' }],
    definition: { metricId: null, unit: 'expressions', countingRule: 'Each snapshot + preserved assessment + quote occurrence + named entity + condition is one expression. Four known states are mutually exclusive per expression; distinct-answer counts overlap across states.',
      denominatorRule: 'Observed expressions only; unknown, refusal, no-mention and incomplete answer coverage remain separate. Missing categories are not zero under incomplete extraction. No sentiment penalty or clinical correctness change.', methodVersion: selected.selection.methodVersion, dataType: 'observed', classifiedExpressions: known.length },
    contextualBasis: [], dependencies: { observations: selected.rows },
    availability: { status: !answers.length ? 'empty' : complete ? 'ready' : 'partial', reasons: !answers.length ? ['no_selected_records'] : complete ? [] : ['recommendation_coverage_incomplete'], remedy: null },
    chart: { kind: 'recommendations', labels: [], series: [], cells: chartCells } };
}
