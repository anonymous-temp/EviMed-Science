import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { getDocumentExport, requestDocumentExport, retryDocumentFormat, cancelDocumentExport, downloadDocumentExport,
  type DocumentExport, type DocumentFormat, type DocumentSource } from '@/lib/documentExport';
import { productErrorMessage } from '@/lib/productClient';

const FORMATS: Array<[DocumentFormat, string]> = [['docx', 'Word'], ['pdf', 'PDF'], ['html', 'HTML']];

/** The same conversion action is available for any existing text report. */
export function DocumentExportActions({ source, initialId }: { source: DocumentSource; initialId?: string | null }) {
  const [record, setRecord] = useState<DocumentExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const sourceKey = JSON.stringify(source);
  useEffect(() => {
    const current = ++generation.current;
    setRecord(null);
    setBusy(false);
    setError(null);
    if (initialId) void getDocumentExport(initialId).then(value => {
      if (generation.current === current) setRecord(value);
    }).catch(failure => { if (generation.current === current) setError(productErrorMessage(failure)); });
    return () => { generation.current += 1; };
  }, [sourceKey, initialId]);
  const pending = record?.state === 'queued' || record?.state === 'running';
  const activeId = record?.id;
  useEffect(() => {
    if (!activeId || !pending) return;
    const current = generation.current;
    let live = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void getDocumentExport(activeId).then(value => {
        if (live && generation.current === current) { setRecord(value); setError(null); }
      }).catch(failure => { if (live && generation.current === current) setError(productErrorMessage(failure)); })
        .finally(() => { inFlight = false; });
    }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [activeId, pending]);

  async function choose(format: DocumentFormat) {
    const current = generation.current;
    setBusy(true); setError(null);
    try {
      if (record?.formats[format]?.state === 'ready') await downloadDocumentExport(record.id, format);
      else {
        const next = record?.formats[format]?.state === 'failed' && record.formats[format]?.code !== 'document_renderer_changed'
          ? await retryDocumentFormat(record.id, format) : await requestDocumentExport(source);
        if (generation.current === current) setRecord(next);
      }
    } catch (failure) { if (generation.current === current) setError(productErrorMessage(failure)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function cancel() {
    if (!record) return;
    const current = generation.current;
    setBusy(true);
    try { const next = await cancelDocumentExport(record.id); if (generation.current === current) setRecord(next); }
    catch (failure) { if (generation.current === current) setError(productErrorMessage(failure)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <div className="flex flex-wrap items-center gap-2" aria-label="导出报告">
    {FORMATS.map(([format, label]) => <Button key={format} size="sm" variant="text"
      disabled={busy || (pending && record?.formats[format]?.state !== 'ready')}
      onClick={() => void choose(format)}>
      {record?.formats[format]?.state === 'failed' ? `重试 ${label}` : record?.formats[format]?.state === 'ready' ? `下载 ${label}` : `导出 ${label}`}
    </Button>)}
    {pending && <><span role="status" className="text-caption text-text-3">正在准备文件</span><Button size="sm" variant="text" disabled={busy} onClick={() => void cancel()}>取消</Button></>}
    {error && <span role="alert" className="text-caption text-error">{error}</span>}
  </div>;
}
