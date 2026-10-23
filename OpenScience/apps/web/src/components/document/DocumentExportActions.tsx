import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { getDocumentExport, requestDocumentExport, retryDocumentFormat, cancelDocumentExport, downloadDocumentExport,
  type DocumentExport, type DocumentFormat, type DocumentSource } from '@/lib/documentExport';
import { productErrorMessage } from '@/lib/productClient';

const FORMATS: Array<[DocumentFormat, string]> = [['docx', 'Word'], ['pdf', 'PDF'], ['html', 'HTML']];

/** Existing conversion lifecycle; selected tables retain independently requested formats. */
export function DocumentExportActions({ source, initialId, groupLabel = '导出报告' }: { source: DocumentSource; initialId?: string | null; groupLabel?: string }) {
  const [records, setRecords] = useState<Record<string, DocumentExport>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const sourceKey = JSON.stringify(source);
  const selected = 'geoId' in source;
  useEffect(() => {
    const current = ++generation.current;
    setRecords({}); setBusy(false); setError(null);
    if (initialId) void getDocumentExport(initialId).then(value => {
      if (generation.current === current) setRecords({ [value.id]: value });
    }).catch(failure => { if (generation.current === current) setError(productErrorMessage(failure)); });
    return () => { generation.current += 1; };
  }, [sourceKey, initialId]);
  const pendingIds = Object.values(records).filter(record => record.state === 'queued' || record.state === 'running').map(record => record.id).sort();
  const pendingKey = JSON.stringify(pendingIds);
  useEffect(() => {
    const ids = JSON.parse(pendingKey) as string[];
    if (!ids.length) return;
    const current = generation.current;
    let live = true, inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void Promise.all(ids.map(id => getDocumentExport(id).then(value => {
        if (live && generation.current === current) { setRecords(previous => ({ ...previous, [value.id]: value })); setError(null); }
      }).catch(failure => { if (live && generation.current === current) setError(productErrorMessage(failure)); }))).finally(() => { inFlight = false; });
    }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [pendingKey]);

  const recordFor = (format: DocumentFormat) => Object.values(records).reverse().find(record => record.formats[format]);
  async function choose(format: DocumentFormat) {
    const current = generation.current, record = recordFor(format);
    setBusy(true); setError(null);
    try {
      if (record?.formats[format]?.state === 'ready') await downloadDocumentExport(record.id, format);
      else {
        const next = record?.formats[format]?.state === 'failed' && record.formats[format]?.code !== 'document_renderer_changed'
          ? await retryDocumentFormat(record.id, format) : selected ? await requestDocumentExport(source, [format]) : await requestDocumentExport(source);
        if (generation.current === current) setRecords(previous => ({ ...previous, [next.id]: next }));
      }
    } catch (failure) { if (generation.current === current) setError(productErrorMessage(failure)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function cancel() {
    const current = generation.current;
    setBusy(true);
    try {
      for (const id of pendingIds) {
        const next = await cancelDocumentExport(id);
        if (generation.current === current) setRecords(previous => ({ ...previous, [next.id]: next }));
      }
    } catch (failure) { if (generation.current === current) setError(productErrorMessage(failure)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  const formats: Array<[DocumentFormat, string]> = selected ? [...FORMATS, ['csv', 'CSV'], ['xlsx', 'Excel']] : FORMATS;
  return <div className="flex flex-wrap items-center gap-2" aria-label={groupLabel}>
    {formats.map(([format, label]) => {
      const record = recordFor(format);
      const pending = record?.state === 'queued' || record?.state === 'running';
      return <Button key={format} size="sm" variant="text" disabled={busy || (pending && record?.formats[format]?.state !== 'ready')} onClick={() => void choose(format)}>
        {record?.formats[format]?.state === 'failed' ? `重试 ${label}` : record?.formats[format]?.state === 'ready' ? `下载 ${label}` : `导出 ${label}`}
      </Button>;
    })}
    {pendingIds.length > 0 && <><span role="status" className="text-caption text-text-3">正在准备文件</span><Button size="sm" variant="text" disabled={busy} onClick={() => void cancel()}>取消</Button></>}
    {error && <span role="alert" className="text-caption text-error">{error}</span>}
  </div>;
}
