import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentExportActions } from './DocumentExportActions';
import { getDocumentExport, requestDocumentExport, retryDocumentFormat, downloadDocumentExport } from '@/lib/documentExport';
vi.mock('@/lib/documentExport', () => ({ getDocumentExport: vi.fn(), requestDocumentExport: vi.fn(), retryDocumentFormat: vi.fn(), cancelDocumentExport: vi.fn(), downloadDocumentExport: vi.fn() }));
vi.mock('@/lib/productClient', () => ({ productErrorMessage: () => '导出暂时不可用' }));
const partial = { id: 'dex_one', state: 'partial' as const, formats: { docx: { state: 'ready' as const }, pdf: { state: 'failed' as const }, html: { state: 'ready' as const } } };
function openFormats() { fireEvent.click(screen.getByRole('button', { name: '导出报告' })); }
async function format(name: string) { await waitFor(() => expect(screen.getByRole('button', { name: '导出报告' })).not.toHaveAttribute('aria-busy', 'true')); openFormats(); return screen.findByRole('menuitem', { name }); }
describe('document export actions', () => {
  beforeEach(() => vi.resetAllMocks());
  it('combines reader actions with conversions without changing their source', async () => {
    const download = vi.fn();
    vi.mocked(requestDocumentExport).mockResolvedValue(partial);
    render(<DocumentExportActions source={{ versionId: 'version-1' }} groupLabel="导出与打印" extraItems={[{ label: '下载 Markdown', onSelect: download }]} />);
    fireEvent.click(screen.getByRole('button', { name: '导出与打印' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '下载 Markdown' }));
    expect(download).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '导出与打印' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '导出 Word' }));
    await waitFor(() => expect(requestDocumentExport).toHaveBeenCalledWith({ versionId: 'version-1' }));
  });
  it('locks an already open portaled menu when its result scope becomes stale', () => {
    const source = { geoId: 'geo', selectionRef: 'old-selection', view: { viewId: 'V01' as const }, expectedDigest: 'old-digest' };
    const { rerender } = render(<DocumentExportActions source={source} />);
    openFormats();
    const word = screen.getByRole('menuitem', { name: '导出 Word' });
    rerender(<DocumentExportActions source={source} disabled />);
    fireEvent.click(word);
    expect(requestDocumentExport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '导出报告' })).toBeDisabled();
  });
  it('binds a preview export to its project and clears records when that project changes', async () => {
    vi.mocked(requestDocumentExport).mockResolvedValue(partial);
    const source = { artifactId: 'report.md' };
    const { rerender } = render(<DocumentExportActions source={source} projectId="project-2" />);
    fireEvent.click(await format('导出 Word'));
    await waitFor(() => expect(requestDocumentExport).toHaveBeenCalledWith(source, undefined, 'project-2'));
    await format('下载 Word');
    fireEvent.keyDown(screen.getByRole('menuitem', { name: '下载 Word' }), { key: 'Escape' });
    rerender(<DocumentExportActions source={source} projectId="project-3" />);
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '下载 Word' })).toBeNull());
    fireEvent.click(await format('导出 Word'));
    await waitFor(() => expect(requestDocumentExport).toHaveBeenLastCalledWith(source, undefined, 'project-3'));
  });
  it('converts an ordinary report through the shared request and preserves successful format downloads', async () => {
    vi.mocked(requestDocumentExport).mockResolvedValue(partial);
    render(<DocumentExportActions source={{ artifactId: 'report.md', root: 'workspace' }} />);
    fireEvent.click(await format('导出 Word'));
    await format('下载 Word');
    expect(requestDocumentExport).toHaveBeenCalledWith({ artifactId: 'report.md', root: 'workspace' });
    fireEvent.click(screen.getByRole('menuitem', { name: '下载 Word' }));
    await waitFor(() => expect(downloadDocumentExport).toHaveBeenCalledWith('dex_one', 'docx'));
    expect(await format('重试 PDF')).toBeEnabled();
  });
  it('retries only failed PDF without requesting new research or losing Word', async () => {
    vi.mocked(getDocumentExport).mockResolvedValue(partial);
    vi.mocked(retryDocumentFormat).mockResolvedValue({ ...partial, state: 'queued', formats: { ...partial.formats, pdf: { state: 'queued' } } });
    render(<DocumentExportActions source={{ studyId: 'study', exportId: 'package' }} initialId="dex_one" />);
    fireEvent.click(await format('重试 PDF'));
    await screen.findByRole('status');
    expect(retryDocumentFormat).toHaveBeenCalledWith('dex_one', 'pdf');
    expect(requestDocumentExport).not.toHaveBeenCalled();
    expect(await format('下载 Word')).toBeEnabled();
  });
  it('starts a current renderer conversion when an old image can no longer retry', async () => {
    vi.mocked(getDocumentExport).mockResolvedValue({ ...partial, formats: { ...partial.formats, pdf: { state: 'failed', code: 'document_renderer_changed' } } });
    vi.mocked(requestDocumentExport).mockResolvedValue({ ...partial, id: 'dex_new' });
    render(<DocumentExportActions source={{ artifactId: 'report.md' }} initialId="dex_one" />);
    fireEvent.click(await format('重试 PDF'));
    await waitFor(() => expect(requestDocumentExport).toHaveBeenCalledWith({ artifactId: 'report.md' }));
    expect(retryDocumentFormat).not.toHaveBeenCalled();
  });
  it('shows an actionable error and keeps the conversion buttons available', async () => {
    vi.mocked(requestDocumentExport).mockRejectedValue(new Error('unavailable'));
    render(<DocumentExportActions source={{ artifactId: 'report.md' }} />);
    fireEvent.click(await format('导出 PDF'));
    expect(await screen.findByRole('alert')).toHaveTextContent('导出暂时不可用');
    expect(await format('导出 PDF')).toBeEnabled();
  });
});

it('requests only the selected table format and retains downloads when a second format is requested',async()=>{
  const source={geoId:'geo',selectionRef:'gsel_exact',view:{viewId:'V01' as const},expectedDigest:'digest'};
  vi.mocked(requestDocumentExport).mockReset().mockResolvedValueOnce({id:'csv-export',state:'ready',formats:{csv:{state:'ready'}}}).mockResolvedValueOnce({id:'xlsx-export',state:'ready',formats:{xlsx:{state:'ready'}}});
  render(<DocumentExportActions source={source}/>);
  openFormats();
  fireEvent.click(screen.getByRole('menuitem',{name:'导出 CSV'}));
  await format('下载 CSV');
  expect(requestDocumentExport).toHaveBeenNthCalledWith(1,source,['csv']);
  fireEvent.click(screen.getByRole('menuitem',{name:'导出 Excel'}));
  await format('下载 Excel');
  expect(requestDocumentExport).toHaveBeenNthCalledWith(2,source,['xlsx']);
  fireEvent.click(screen.getByRole('menuitem',{name:'下载 CSV'}));
  await waitFor(()=>expect(downloadDocumentExport).toHaveBeenCalledWith('csv-export','csv'));
});

it('ignores a stale conversion after the source changes and preserves the new exact source', async () => {
  let resolve!: (value: typeof partial) => void;
  vi.mocked(requestDocumentExport).mockReset().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(partial);
  const { rerender } = render(<DocumentExportActions source={{ artifactId: 'old.md' }} />);
  fireEvent.click(await format('导出 Word'));
  expect(requestDocumentExport).toHaveBeenCalledTimes(1);
  rerender(<DocumentExportActions source={{ artifactId: 'new.md' }} />);
  resolve(partial);
  await waitFor(() => expect(screen.getByRole('button', { name: '导出报告' })).not.toHaveAttribute('aria-busy', 'true'));
  fireEvent.click(await format('导出 PDF'));
  await waitFor(() => expect(requestDocumentExport).toHaveBeenLastCalledWith({ artifactId: 'new.md' }));
});
