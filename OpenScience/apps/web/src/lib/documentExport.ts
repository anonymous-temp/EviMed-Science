import { fetchWithWebAuth, getWebProjectId, webApiBase } from './apiClient';
import { productRequest } from './productClient';

export type DocumentFormat = 'docx' | 'pdf' | 'html';
export type DocumentSource = { artifactId: string; root?: 'workspace' | 'base' } | { studyId: string; exportId: string };
export interface DocumentExport {
  id: string;
  state: 'queued' | 'running' | 'ready' | 'partial' | 'failed' | 'canceled';
  formats: Partial<Record<DocumentFormat, { state: 'queued' | 'ready' | 'failed'; code?: string }>>;
}
export function requestDocumentExport(source: DocumentSource) {
  return productRequest<DocumentExport>('/document-exports', 'POST', { projectId: getWebProjectId(), source, formats: ['docx', 'pdf', 'html'] });
}
export function getDocumentExport(id: string) { return productRequest<DocumentExport>(`/document-exports/${encodeURIComponent(id)}`); }
export function retryDocumentFormat(id: string, format: DocumentFormat) {
  return productRequest<DocumentExport>(`/document-exports/${encodeURIComponent(id)}/retry`, 'POST', { format });
}
export function cancelDocumentExport(id: string) { return productRequest<DocumentExport>(`/document-exports/${encodeURIComponent(id)}/cancel`, 'POST', {}); }
export async function downloadDocumentExport(id: string, format: DocumentFormat) {
  const root = webApiBase.endsWith('/api') ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}/document-exports/${encodeURIComponent(id)}/download/${format}`);
  if (!response.ok) throw new Error('文件暂时无法下载，请刷新后重试。');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `report.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
