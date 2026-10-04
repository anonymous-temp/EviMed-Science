import { presentVcrReview } from "./vcrViewsKit.mjs";
import { DOCUMENT_EXPORT_FORMATS, documentExportDigest, VCR_EXPORT_KIND_LABELS_ZH, VCR_INTENDED_USE_LABELS_ZH } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { exportHash, freezeDocumentAssets } from './documentExport.mjs';
import { renderVcrNumbers, vcrReportReviewRevision } from './vcrRender.mjs';
import { renderModelDocument } from './vcrModelDocuments.mjs';
import { readVcrReviewExportProof } from './vcrReview.mjs';
import { studyReviewDigest } from './studyReview.mjs';
import { randomUUID } from 'node:crypto';

const MAX_REVIEW_EXPORT_RETRIES = 3;
const REVIEW_RETRY_LEASE_MS = 120_000;

/** ProductDocuments revisions order observations of the same conversion.
 * @param {any} refresh @param {any} conversion */
const olderConversionObservation = (refresh, conversion) => refresh.conversionId === conversion.id
  && Number(refresh.conversionRecordRevision ?? 0) > conversion.revision;

/** All VCR export kinds use one immutable report adapter. */
export function canonicalVcrDocument(study, row) {
  const cover = row.cover ?? {};
  const model = cover.results;
  const completedReview = cover.documentReview;
  // Only trusted conversion completion installs this metadata. The retained
  // numerical model and original report template remain byte-for-byte intact.
  const refreshed = completedReview?.reportRevision === vcrReportReviewRevision(cover);
  const reviewRecords = refreshed ? completedReview.records : model?.review?.records ?? [];
  const reports = cover.reports?.length ? cover.reports : cover.report ? [cover.report] : [];
  if (!model?.study || !reports.length) throw new HttpError(409, 'document_source_pending', 'The research report is still being prepared.');
  const title = `${model.study.name ?? study.name} — ${VCR_EXPORT_KIND_LABELS_ZH[row.kind] ?? row.kind}`;
  const reviewLines = reviewRecords.map(review => {
    const shown = presentVcrReview(review);
    const findings = shown.findings.map(finding => `  - ${finding.location ? `${finding.location}：` : ''}${finding.message ?? finding.evidence ?? ''}${finding.fix ? ` 建议：${finding.fix}` : ''}${finding.response ? ` 已说明：${finding.response}` : ''}`).join('\n');
    const failure = shown.status === 'failed' && review.provenance?.error === 'review_configuration_changed'
      ? ' 本次审查因服务配置变化未完成。' : '';
    return `- ${shown.label}：${shown.state}；${shown.by ?? '身份未返回'}；${shown.at ?? ''}；配置 ${shown.configurationRevision ?? '不适用'}。${shown.note}${failure}${findings ? `\n${findings}` : ''}`;
  });
  const use = model.intendedUse ?? model.study.intendedUse ?? study.intendedUse;
  const seal = model.seal ?? {};
  const header = [`# ${title}`, `预期用途：${VCR_INTENDED_USE_LABELS_ZH[use] ?? use}`, '## 复核与限制',
    reviewLines.length ? reviewLines.join('\n') : '尚未完成复核。',
    ...((model.stale ?? []).map(mark => `- ${mark.node}: ${mark.reason}`)),
    seal.required ? `分析计划冻结：${seal.planFrozenAt ?? '未记录'}；首次读取结局：${seal.outcomeFirstReadAt ?? '未记录'}。` : '结局封存：不适用。', ''];
  // The two model documents are the platform's structure with a run's words in it: the same report write fills the prose
  // of each section, and the tables, the registers and every number come from the frozen report model.
  const modelDocument = renderModelDocument(row.kind, model, reports);
  const sections = modelDocument ? [modelDocument.markdown]
    : reports.map(report => `${report.section === 'main' ? '' : `## ${report.section}\n\n`}${renderVcrNumbers(report.template, model).text}`);
  const canonicalMarkdown = [...header, ...sections].join('\n\n');
  return { title, canonicalMarkdown, cover: { exportKind: row.kind, reviews: reviewRecords, stale: model.stale ?? [], seal: model.seal ?? null, intendedUse: model.intendedUse ?? model.study.intendedUse ?? study.intendedUse }, assets: [],
    revision: exportHash(documentExportDigest({ reports, model, ...(refreshed ? { reviewRecords } : {}) })) };
}

/** Authority stays with the current study membership, including cached files. */
export function createVcrDocumentAdapter({ vcr, store }) {
  async function authorize(user, source) {
    if (!vcr?.service.allows(user)) throw new HttpError(404, 'document_export_unavailable', 'The document is unavailable.');
    const decision = await vcr.access.judge({ actor: user.id, studyId: source.studyId, ability: 'export', purpose: 'document-export' });
    if (!decision.allowed) throw new HttpError(404, 'document_export_unavailable', 'The document is unavailable.');
    const study = await vcr.store.getStudy(user.id, source.studyId);
    if (!study) throw new HttpError(404, 'document_export_unavailable', 'The document is unavailable.');
    const owner = await store.userById(study.userId);
    const project = await store.requireProject(owner, study.projectId);
    return { study, project };
  }
  async function resolve(user, request) {
    if (Object.keys(request.source).some(key => !['studyId','exportId'].includes(key))) throw new HttpError(400, 'document_export_request_invalid', 'Invalid study report reference.');
    const { study, project } = await authorize(user, request.source);
    const row = await vcr.store.exportRow(study.id, request.source.exportId);
    if (!row) throw new HttpError(404, 'document_export_unavailable', 'The document is unavailable.');
    const document = canonicalVcrDocument(study, row);
    const assets = await freezeDocumentAssets(project.workspaceDir, document.canonicalMarkdown);
    return { project, reference: request.source, ...document, assets };
  }

  async function queueReviewRefresh(service, user, study, row) {
    const refresh = row.cover.reviewDocumentRefresh;
    const identity = { exportId: row.id, reportRevision: refresh.reportRevision, sourceDigest: refresh.sourceDigest,
      configurationDigest: refresh.configurationDigest, reviewIds: refresh.reviewIds };
    let current = await vcr.store.reportSnapshot(snapshot => readVcrReviewExportProof(snapshot, study.id, identity));
    if (!current || studyReviewDigest(current.records) !== studyReviewDigest(refresh.records)) {
      await vcr.store.updateExportCover(row.id, cover => cover.reviewDocumentRefresh?.id === refresh.id
        ? { ...cover, reviewDocumentRefresh: { ...cover.reviewDocumentRefresh, state: 'obsolete', code: 'review_proof_stale' } } : cover);
      return { skipped: 'review_proof_stale' };
    }
    let retryToken = null;
    let conversion = null;
    try {
      if (refresh.conversionId) conversion = await service.status(user, refresh.conversionId);
      else {
        const { project } = await authorize(user, { studyId: study.id, exportId: row.id });
        const document = canonicalVcrDocument(study, { ...row, cover: { ...current.exported.cover,
          documentReview: { ...identity, records: refresh.records } } });
        const assets = refresh.baseConversion ? await service.frozenAssets(user, refresh.baseConversion.id,
          { source: { studyId: study.id, exportId: row.id }, sourceRevision: refresh.baseConversion.sourceRevision })
          : await freezeDocumentAssets(project.workspaceDir, document.canonicalMarkdown);
        conversion = await service.requestFrozen(user, { project, reference: { studyId: study.id, exportId: row.id }, ...document, assets }, DOCUMENT_EXPORT_FORMATS);
        conversion = await service.status(user, conversion.id);
      }
      const failedFormat = DOCUMENT_EXPORT_FORMATS.find(format => conversion.formats?.[format]?.state === 'failed');
      if (failedFormat && ['partial', 'failed'].includes(conversion.state)) {
        await vcr.store.updateExportCover(row.id, cover => {
          const retained = cover.reviewDocumentRefresh;
          if (retained?.id !== refresh.id || ['ready', 'obsolete'].includes(retained.state)
            || olderConversionObservation(retained, conversion)
            || Number(retained.retryAttempts ?? 0) >= MAX_REVIEW_EXPORT_RETRIES
            || Date.parse(retained.retryLeaseUntil ?? '') > Date.now()) return cover;
          retryToken = randomUUID();
          return { ...cover, reviewDocumentRefresh: { ...retained, state: 'pending', retryAttempts: Number(retained.retryAttempts ?? 0) + 1,
            conversionId: conversion.id, conversionSourceRevision: conversion.sourceRevision, conversionRecordRevision: conversion.revision,
            retryToken, retryLeaseUntil: new Date(Date.now() + REVIEW_RETRY_LEASE_MS).toISOString() } };
        });
        if (retryToken) conversion = await service.retry(user, conversion.id, failedFormat);
      }
      await vcr.store.updateExportCover(row.id, async (cover, snapshot) => {
        if (cover.reviewDocumentRefresh?.id !== refresh.id || ['ready', 'obsolete'].includes(cover.reviewDocumentRefresh.state)
          || olderConversionObservation(cover.reviewDocumentRefresh, conversion)) return cover;
        // Publish the observed conversion generation and release this retry's
        // claim together. A delayed partial status cannot undo a newer queue.
        const pending = { ...cover.reviewDocumentRefresh, conversionId: conversion.id, conversionSourceRevision: conversion.sourceRevision,
          conversionRecordRevision: conversion.revision };
        if (retryToken && pending.retryToken === retryToken) { delete pending.retryToken; delete pending.retryLeaseUntil; }
        current = await readVcrReviewExportProof(snapshot, study.id, identity);
        if (!current || studyReviewDigest(current.records) !== studyReviewDigest(refresh.records)) return { ...cover,
          reviewDocumentRefresh: { ...pending, state: 'obsolete', code: 'review_proof_stale' } };
        const complete = DOCUMENT_EXPORT_FORMATS.every(format => conversion.formats?.[format]?.state === 'ready');
        const canRetry = ['failed', 'partial'].includes(conversion.state) && failedFormat
          && (Number(pending.retryAttempts ?? 0) < MAX_REVIEW_EXPORT_RETRIES || Date.parse(pending.retryLeaseUntil ?? '') > Date.now());
        if (!complete) return { ...cover, reviewDocumentRefresh: { ...pending,
          state: ['failed', 'canceled', 'partial'].includes(conversion.state) && !canRetry ? 'failed' : 'pending',
          ...(['failed', 'canceled', 'partial'].includes(conversion.state) ? { code: 'document_review_conversion_incomplete' } : {}) } };
        const reviewed = { ...identity, records: refresh.records };
        const expected = canonicalVcrDocument(study, { ...row, cover: { ...cover, documentReview: reviewed } }).revision;
        if (conversion.sourceRevision !== expected) return { ...cover, reviewDocumentRefresh: { ...pending, state: 'obsolete', code: 'document_source_changed' } };
        const history = cover.previousDocumentExports ?? [];
        return { ...cover, documentReview: reviewed, documentExportId: conversion.id, documentExportSourceRevision: conversion.sourceRevision,
          previousDocumentExports: cover.documentExportId && cover.documentExportId !== conversion.id && !history.some(item => item.id === cover.documentExportId)
            ? [...history, { id: cover.documentExportId, sourceRevision: cover.documentExportSourceRevision ?? null }] : history,
          reviewDocumentRefresh: { ...pending, state: 'ready', code: null } };
      });
      return conversion;
    } catch (error) {
      await vcr.store.updateExportCover(row.id, cover => {
        const pending = cover.reviewDocumentRefresh;
        if (pending?.id !== refresh.id || ['ready', 'obsolete'].includes(pending.state)
          || (conversion && olderConversionObservation(pending, conversion))) return cover;
        const attempts = Number(pending.requestFailures ?? 0) + 1;
        const temporary = Number(error.status) >= 500 || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'document_export_retry_invalid', 'product_revision_conflict'].includes(error.code);
        const next = { ...pending, state: temporary && attempts < MAX_REVIEW_EXPORT_RETRIES ? 'pending' : 'failed',
          requestFailures: attempts, code: error.code ?? 'document_review_conversion_failed' };
        if (retryToken && next.retryToken === retryToken) { delete next.retryToken; delete next.retryLeaseUntil; }
        return { ...cover, reviewDocumentRefresh: next };
      });
      throw error;
    }
  }
  return { authorize, resolve,
    async queue(service, user, study, row) {
      if (['pending', 'failed'].includes(row.cover?.reviewDocumentRefresh?.state)) return queueReviewRefresh(service, user, study, row);
      if (row.cover?.reviewDocumentRefresh?.state === 'ready' && row.cover.documentExportId
        && canonicalVcrDocument(study, row).revision === row.cover.documentExportSourceRevision) {
        return service.status(user, row.cover.documentExportId);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await service.request(user, { projectId: study.projectId, source: { studyId: study.id, exportId: row.id }, formats: DOCUMENT_EXPORT_FORMATS });
        let attached = false;
        await vcr.store.updateExportCover(row.id, cover => {
          // Formatting can start while the final report section is being
          // saved. Bind only the exact frozen revision and retain all newer text.
          if (canonicalVcrDocument(study, { ...row, cover }).revision !== result.sourceRevision) return cover;
          attached = true;
          return { ...cover, documentExportId: result.id, documentExportSourceRevision: result.sourceRevision };
        });
        if (attached) return result;
      }
      throw new HttpError(409, 'document_source_changed', 'The report changed while export was queued; retry export.');
    },
  };
}
