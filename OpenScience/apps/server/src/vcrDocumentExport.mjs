import { DOCUMENT_EXPORT_FORMATS, documentExportDigest, VCR_EXPORT_KIND_LABELS_ZH, VCR_INTENDED_USE_LABELS_ZH, VCR_REVIEW_KIND_LABELS_ZH } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { exportHash, freezeDocumentAssets } from './documentExport.mjs';
import { renderVcrNumbers } from './vcrRender.mjs';

/** All VCR export kinds use one immutable report adapter. */
export function canonicalVcrDocument(study, row) {
  const cover = row.cover ?? {};
  const model = cover.results;
  const reports = cover.reports?.length ? cover.reports : cover.report ? [cover.report] : [];
  if (!model?.study || !reports.length) throw new HttpError(409, 'document_source_pending', 'The research report is still being prepared.');
  const title = `${model.study.name ?? study.name} — ${VCR_EXPORT_KIND_LABELS_ZH[row.kind] ?? row.kind}`;
  const reviewLines = (model.review?.records ?? []).map(review => {
    const state = review.current === false ? '复核后有变更' : review.state === 'reviewed' ? '已复核' : '尚未完成复核';
    return `- ${VCR_REVIEW_KIND_LABELS_ZH[review.kind] ?? review.kind}：${state}；${review.reviewer ?? '未记录复核人'}；${review.createdAt ?? ''}；${review.nodes?.join(', ') ?? ''}`;
  });
  const use = model.intendedUse ?? model.study.intendedUse ?? study.intendedUse;
  const seal = model.seal ?? {};
  const header = [`# ${title}`, `预期用途：${VCR_INTENDED_USE_LABELS_ZH[use] ?? use}`, '## 复核与限制',
    reviewLines.length ? reviewLines.join('\n') : '尚未完成复核。',
    ...((model.stale ?? []).map(mark => `- ${mark.node}: ${mark.reason}`)),
    seal.required ? `分析计划冻结：${seal.planFrozenAt ?? '未记录'}；首次读取结局：${seal.outcomeFirstReadAt ?? '未记录'}。` : '结局封存：不适用。', ''];
  const sections = reports.map(report => `${report.section === 'main' ? '' : `## ${report.section}\n\n`}${renderVcrNumbers(report.template, model).text}`);
  const canonicalMarkdown = [...header, ...sections].join('\n\n');
  return { title, canonicalMarkdown, cover: { exportKind: row.kind, reviews: model.review?.records ?? [], stale: model.stale ?? [], seal: model.seal ?? null, intendedUse: model.intendedUse ?? model.study.intendedUse ?? study.intendedUse }, assets: [],
    revision: exportHash(documentExportDigest({ reports, model })) };
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
  return { authorize, resolve,
    async queue(service, user, study, row) {
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
