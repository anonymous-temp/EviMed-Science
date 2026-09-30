import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentExportActions } from './DocumentExportActions';
import { getDocumentExport, requestDocumentExport, retryDocumentFormat, downloadDocumentExport } from '@/lib/documentExport';
vi.mock('@/lib/documentExport', () => ({ getDocumentExport: vi.fn(), requestDocumentExport: vi.fn(), retryDocumentFormat: vi.fn(), cancelDocumentExport: vi.fn(), downloadDocumentExport: vi.fn() }));
vi.mock('@/lib/productClient', () => ({ productErrorMessage: () => '导出暂时不可用' }));
const partial = { id: 'dex_one', state: 'partial' as const, formats: { docx: { state: 'ready' as const }, pdf: { state: 'failed' as const }, html: { state: 'ready' as const } } };
describe('document export actions', () => {
  beforeEach(() => vi.resetAllMocks());
  it('converts an ordinary report through the shared request and preserves successful format downloads', async () => {
    vi.mocked(requestDocumentExport).mockResolvedValue(partial);
    render(<DocumentExportActions source={{ artifactId: 'report.md', root: 'workspace' }} />);
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }));
    await screen.findByRole('button', { name: '下载 Word' });
    expect(requestDocumentExport).toHaveBeenCalledWith({ artifactId: 'report.md', root: 'workspace' });
    fireEvent.click(screen.getByRole('button', { name: '下载 Word' }));
    await waitFor(() => expect(downloadDocumentExport).toHaveBeenCalledWith('dex_one', 'docx'));
    expect(screen.getByRole('button', { name: '重试 PDF' })).toBeEnabled();
  });
  it('retries only failed PDF without requesting new research or losing Word', async () => {
    vi.mocked(getDocumentExport).mockResolvedValue(partial);
    vi.mocked(retryDocumentFormat).mockResolvedValue({ ...partial, state: 'queued', formats: { ...partial.formats, pdf: { state: 'queued' } } });
    render(<DocumentExportActions source={{ studyId: 'study', exportId: 'package' }} initialId="dex_one" />);
    fireEvent.click(await screen.findByRole('button', { name: '重试 PDF' }));
    await screen.findByRole('status');
    expect(retryDocumentFormat).toHaveBeenCalledWith('dex_one', 'pdf');
    expect(requestDocumentExport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '下载 Word' })).toBeEnabled();
  });
  it('starts a current renderer conversion when an old image can no longer retry', async () => {
    vi.mocked(getDocumentExport).mockResolvedValue({ ...partial, formats: { ...partial.formats, pdf: { state: 'failed', code: 'document_renderer_changed' } } });
    vi.mocked(requestDocumentExport).mockResolvedValue({ ...partial, id: 'dex_new' });
    render(<DocumentExportActions source={{ artifactId: 'report.md' }} initialId="dex_one" />);
    fireEvent.click(await screen.findByRole('button', { name: '重试 PDF' }));
    await waitFor(() => expect(requestDocumentExport).toHaveBeenCalledWith({ artifactId: 'report.md' }));
    expect(retryDocumentFormat).not.toHaveBeenCalled();
  });
  it('shows an actionable error and keeps the conversion buttons available', async () => {
    vi.mocked(requestDocumentExport).mockRejectedValue(new Error('unavailable'));
    render(<DocumentExportActions source={{ artifactId: 'report.md' }} />);
    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('导出暂时不可用');
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeEnabled();
  });
});
