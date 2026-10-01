/** Trusted, aggregate-only VCR adapter for the platform review queue. */
import { createHash } from 'node:crypto';
import { parseLineageNode, vcrResultOutputPayload } from '@evimed/domain';
import { vcrRecordedResultHash } from './vcrJobs.mjs';
import { vcrCurrentNodes, vcrReviewIsCurrent } from './vcrViews.mjs';
import { renderVcrNumbers, vcrReportReviewRevision } from './vcrRender.mjs';
import { studyReviewDigest } from './studyReview.mjs';
import { HttpError } from './security.mjs';

/** @param {any} input */
export function buildVcrReviewInput({ model, results, executions, evidence, reports, forModel }) {
  const nodes = [...results.map(row => `result:${row.id}@${row.version}`),
    ...(model.assumptions ?? []).map(row => `assumption:${row.key}@${row.version}`),
    ...(model.definition?.id ? [`study_definition:${model.definition.id}@${model.definition.version}`] : []),
    ...(model.scenarios ?? []).map(row => `trial_scenario:${row.id}@${row.version}`),
    ...Object.entries(model.inputVersions ?? {}).filter(([, value]) => value).map(([kind, value]) => `${kind === "comparator" ? "comparator_design" : kind}:${value.id}@${value.version}`)].sort();
  const findings = [];
  for (const result of results) {
    const execution = executions.find(row => row.id === result.executionId);
    const actual = vcrRecordedResultHash(result);
    const proof = execution?.receipt;
    const stageHash = proof?.stageOutput ? createHash('sha256').update(vcrResultOutputPayload(proof.stageOutput)).digest('hex') : null;
    if (proof?.stageVerified !== true || stageHash !== execution?.output_hash || proof.recordedResultHash !== actual
      || proof.recordedResultId !== result.id || proof.recordedResultVersion !== result.version) findings.push({ kind: 'number_untraced', location: `result:${result.id}@${result.version}`,
      evidence: '', message: 'The verified stage receipt could not be bound to this exact stored result.', fix: '核对该结果与对应计算记录；保留已产出的结果并标明核验不确定性。' });
  }
  const referenced = new Set((model.assumptions ?? []).flatMap(row => [...(row.evidenceIds ?? []), ...(row.sources ?? [])].map(source => String(source.id ?? source.evidenceId ?? source))));
  for (const id of referenced) {
    if (!evidence.some(row => row.id === id && row.locator?.verification === 'verified' && row.quote && row.record_text?.includes(row.quote) && row.record_hash === createHash('sha256').update(row.record_text).digest('hex'))) findings.push({ kind: 'reference_unresolvable', location: `evidence:${id}`,
      evidence: '', message: 'The assumption source has no verified preserved quotation.', fix: '补充可核验的来源，或保留为明确声明的假设。' });
  }
  // Never pass the exact render model: suppression applies before template binding.
  const safe = forModel({ study: model.study, definition: model.definition, assumptions: (model.assumptions ?? []).map(({ reviewState: _state, ...row }) => row), measures: model.measures, counts: model.counts,
    results: model.results, scenarios: model.scenarios, scenarioResults: model.scenarioResults, models: model.models, inputVersions: model.inputVersions,
    intendedUse: model.intendedUse, conclusion: model.conclusion, notEstimableRule: model.notEstimableRule, stale: model.stale });
  const rendered = reports.map(report => renderVcrNumbers(String(report.template ?? ''), safe));
  for (const report of rendered) for (const issue of report.issues) findings.push({ kind: 'number_untraced', location: issue.path,
    evidence: '', message: issue.message, fix: '使用已保存结果的数字引用，并保留缺失值标记。' });
  const frozenInput = { model: safe, report: rendered.map(row => row.text).join('\n\n'),
    evidence: evidence.filter(row => referenced.has(row.id)).map(row => ({ id: row.id, quote: row.quote, source: /^(https?:\/\/|doi:|pmid:|NCT|ChiCTR)/i.test(row.source_ref ?? '') ? row.source_ref : null,
      verification: row.locator?.verification, parameter: row.parameter, value: row.value, unit: row.unit })),
    methods: executions.map(row => ({ method: row.method, version: row.method_version, validation: row.environment?.validation ?? null })) };
  return { nodes, frozenInput, deterministic: { numbers: { checked: results.length, bindings: rendered.reduce((sum, row) => sum + row.bindings.length, 0) },
    references: { checked: referenced.size }, findings } };
}

/** Read only trusted terminal records for one exact frozen report. A failed
 * review is retained as a failure, never attested as a successful review.
 * @param {any} store @param {string} studyId @param {any} identity */
export async function readVcrReviewExportProof(store, studyId, identity) {
  if (!/^[a-f0-9]{64}$/.test(String(identity.sourceDigest)) || !/^[a-f0-9]{64}$/.test(String(identity.configurationDigest))) return null;
  if (identity.reviewIds && (!Array.isArray(identity.reviewIds) || identity.reviewIds.length !== 2 || new Set(identity.reviewIds).size !== 2)) return null;
  const study = await store.studyById(studyId);
  const exported = await store.exportRow(studyId, identity.exportId);
  if (!study || !exported?.cover?.results?.study || !(exported.cover.reports?.length || exported.cover.report)
    || identity.reportRevision !== vcrReportReviewRevision(exported.cover)) return null;
  const [reviews, results, stale, assumptions, populations, patientSets, comparators, scenarios, grid, definition, protocol] = await Promise.all([
    store.reviews(studyId), store.results(studyId), store.staleMarks(studyId), store.assumptions(studyId), store.populations(studyId),
    store.patientSets(studyId), store.comparatorDesigns(studyId), store.trialScenarios(studyId), store.latestDesignGrid(studyId), store.latestDefinition(studyId), store.latestProtocolVersion(studyId)]);
  const current = vcrCurrentNodes({ study, results, assumptions, populations, patientSets, comparators, scenarios, grid, definition, protocol });
  const staleNodes = new Set(stale.map(row => row.node));
  // The store orders by the full PostgreSQL timestamp. Never fall back to an
  // older pair after a newer review is queued, or a late replay could regress
  // the downloaded cover to the previous reviewer configuration.
  const selected = reviews.filter(row => row.reviewerKind === 'ai' && row.platformReviewId
    && row.provenance.subjectRef?.kind === 'vcr' && row.provenance.subjectRef?.studyId === studyId
    && row.provenance.subjectRef?.exportId === exported.id && row.provenance.subjectRef?.reportRevision === identity.reportRevision);
  const pair = ['clinical', 'statistical'].map(role => selected.find(row => row.kind === role));
  if (pair.some(row => !row || !['done', 'failed'].includes(row.status)
    || row.provenance.inputDigest !== identity.sourceDigest || row.provenance.configurationDigest !== identity.configurationDigest
    || (identity.reviewIds && !identity.reviewIds.includes(row.platformReviewId)) || !row.nodes?.length || row.nodes.some(node => {
    const parsed = parseLineageNode(node);
    return !parsed || staleNodes.has(node) || (current.kinds.has(parsed.kind) && !current.nodes.has(node));
  }) || (row.status === 'done' && !vcrReviewIsCurrent(row, { results, stale, current, exports: [exported] })))) return null;
  return { study, exported, records: pair };
}

/** @param {{vcr:any, reviewService:any}} parts */
export function createVcrReviewAdapter({ vcr, reviewService }) {
  const persist = (client, record) => vcr.store.saveAiReview({ ...record, studyId: record.subjectRef.studyId }, { client });
  reviewService?.registerStudyReviewAdapter('vcr', { persist, requestDeliverable: async (identity, input) => {
    const study = await vcr.store.studyByControlProject(identity.userId, identity.projectId);
    if (!study) return [];
    const exports = await vcr.store.exports(study.id);
    const row = exports.find(item => item.runId === input.runId);
    return api.queue(study.id, { ...(row ? { exportId: row.id } : {}), runId: input.runId });
  }, completed: async record => {
    const exportId = record.subjectRef.exportId;
    if (!exportId || !vcr.orchestrator) return;
    const identity = { sourceDigest: record.inputDigest, configurationDigest: record.configurationDigest,
      reportRevision: record.subjectRef.reportRevision, exportId };
    const proof = await vcr.store.reportSnapshot(snapshot => readVcrReviewExportProof(snapshot, record.subjectRef.studyId, identity));
    if (!proof) return;
    await vcr.orchestrator.requestReviewExportRefresh?.(proof.study.id, { ...identity, reviewIds: proof.records.map(row => row.platformReviewId) });
    const completed = proof.records.filter(row => row.status === 'done');
    const findings = completed.flatMap(row => (row.provenance.findings ?? []).filter(finding => finding.fix));
    if (findings.length) await vcr.orchestrator.requestReviewRepair?.(proof.study.id, { sourceDigest: record.inputDigest, exportId,
      reviewIds: completed.map(row => row.platformReviewId), findings });
  } });
  const api = {
    /** Called only after authorized writes/result persistence, never with caller-provided model context.
     * @param {string} studyId @param {{exportId?:string,runId?:string,reason?:string}} [options] */
    async queue(studyId, { exportId, runId } = {}) {
      const frozen = await vcr.store.reportSnapshot(async snapshot => {
        const study = await snapshot.studyById(studyId);
        if (!study) throw new HttpError(404, 'vcr_study_not_found', 'Study not found.');
        const exported = exportId ? await snapshot.exportRow(studyId, exportId) : null;
        if (exportId && !exported) throw new HttpError(404, 'vcr_export_not_found', 'Export not found.');
        const model = exported?.cover?.results ?? await vcr.service.reportModelFromStore(study, snapshot);
        const ids = [...new Set([...Object.values(model.results ?? {}), ...Object.values(model.scenarioResults ?? {})].map(row => row.id).filter(Boolean))];
        const results = (await Promise.all(ids.map(id => snapshot.result(studyId, id)))).filter(Boolean);
        const executions = await snapshot.rows('SELECT id,output_hash,method,method_version,environment,receipt FROM evimed_vcr.executions WHERE study_id=$1 AND id=ANY($2::text[])', [studyId, results.map(row => row.executionId).filter(Boolean)]);
        const evidence = await snapshot.rows('SELECT e.id,e.quote,e.source_ref,e.parameter,e.value,e.unit,e.locator,p.record_text,p.record_hash FROM evimed_vcr.evidence_items e LEFT JOIN evimed_vcr.precedents p ON p.id=e.precedent_id AND p.user_id=e.user_id WHERE e.study_id=$1 AND e.user_id=$2 ORDER BY e.created_at DESC LIMIT 2000', [studyId, study.userId]);
        const reports = exported?.cover?.reports ?? (exported?.cover?.report ? [exported.cover.report] : []);
        return { study, reportRevision: exported ? vcrReportReviewRevision(exported.cover) : null, ...buildVcrReviewInput({ model, results, executions, evidence, reports, forModel: value => vcr.service.forModel(value) }) };
      });
      if (!frozen.nodes.length) return [];
      const records = [];
      for (const role of ['clinical', 'statistical']) {
        const input = { subjectRef: { kind: 'vcr', studyId, ...(exportId ? { exportId, reportRevision: frozen.reportRevision } : {}) }, role, nodes: frozen.nodes, frozenInput: frozen.frozenInput, deterministic: frozen.deterministic, runId };
        if (reviewService) records.push(await reviewService.requestStudyReview({ userId: frozen.study.userId, projectId: frozen.study.projectId }, input));
        else {
          const digest = studyReviewDigest(frozen.frozenInput);
          records.push(await vcr.store.saveAiReview({ reviewId: `unavailable_${studyReviewDigest({ studyId, role, digest })}`, subjectRef: input.subjectRef, studyId, role,
            nodes: frozen.nodes, inputDigest: digest, configuration: { revision: 'study-review-v1', model: null }, configurationDigest: '', status: 'failed', error: 'review_disabled',
            model: null, usage: {}, cost: null, deterministic: frozen.deterministic, findings: frozen.deterministic.findings, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
        }
      }
      return records;
    },
  };
  return api;
}
