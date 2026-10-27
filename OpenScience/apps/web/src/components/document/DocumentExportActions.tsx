import { useEffect, useRef, useState } from 'react';
import { Menu, type MenuEntry } from '@/components/ui/Menu';
import { Button } from '@/components/ui/Button';
import { getDocumentExport, requestDocumentExport, retryDocumentFormat, cancelDocumentExport, downloadDocumentExport,
  type DocumentExport, type DocumentFormat, type DocumentSource } from '@/lib/documentExport';
import { productErrorMessage } from '@/lib/productClient';

const FORMATS: Array<[DocumentFormat, string]> = [['docx', 'Word'], ['pdf', 'PDF'], ['html', 'HTML']];

/**
 * Component: DocumentExportActions; owner: H; rules: DS22/AT52–AT54.
 * Anatomy: Labeled format menu, visible conversion status, cancellation and error.
 * Variants: Three report formats; five selected GEO table formats.
 * States: Independent records preserve retry/download/poll state; source generation discards stale replies.
 * Hit area: Shared Button trigger and Menu rows.
 * Keyboard: Menu arrows, Escape and trigger focus return.
 * Long content: Shared menu labels and wrapping status text.
 * Theme: Semantic surface, text and error roles.
 * Responsive: One export trigger; ongoing state remains outside disclosure.
 * Verification: DocumentExportActions.test.tsx; DS22.2/AT52; caller owns exportability.
 */
export function DocumentExportActions({ source, initialId, groupLabel = '导出报告', extraItems = [], disabled = false, projectId }: { source: DocumentSource; initialId?: string | null; groupLabel?: string; extraItems?: readonly MenuEntry[]; disabled?: boolean; projectId?: string }) {
  const [records, setRecords] = useState<Record<string, DocumentExport>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const intent = useRef<string | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const sourceKey = JSON.stringify([source, projectId]);
  const selected = 'geoId' in source;
  useEffect(() => {
    const current = ++generation.current;
    intent.current = null;
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
    if (disabledRef.current || intent.current === sourceKey) return;
    const record = recordFor(format);
    if ((record?.state === 'queued' || record?.state === 'running') && record.formats[format]?.state !== 'ready') return;
    intent.current = sourceKey;
    const current = generation.current;
    setBusy(true); setError(null);
    try {
      if (record?.formats[format]?.state === 'ready') await downloadDocumentExport(record.id, format);
      else {
        const next = record?.formats[format]?.state === 'failed' && record.formats[format]?.code !== 'document_renderer_changed'
          ? await retryDocumentFormat(record.id, format) : selected ? await requestDocumentExport(source, [format]) : projectId ? await requestDocumentExport(source, undefined, projectId) : await requestDocumentExport(source);
        if (generation.current === current) setRecords(previous => ({ ...previous, [next.id]: next }));
      }
    } catch (failure) { if (generation.current === current) setError(productErrorMessage(failure)); }
    finally { if (generation.current === current) { intent.current = null; setBusy(false); } }
  }
  async function cancel() {
    if (disabledRef.current || intent.current === sourceKey) return;
    intent.current = sourceKey;
    const current = generation.current;
    setBusy(true);
    try {
      for (const id of pendingIds) {
        if (generation.current !== current) break;
        const next = await cancelDocumentExport(id);
        if (generation.current === current) setRecords(previous => ({ ...previous, [next.id]: next }));
      }
    } catch (failure) { if (generation.current === current) setError(productErrorMessage(failure)); }
    finally { if (generation.current === current) { intent.current = null; setBusy(false); } }
  }
  const formats: Array<[DocumentFormat, string]> = selected ? [...FORMATS, ['csv', 'CSV'], ['xlsx', 'Excel']] : FORMATS;
  return <div className="flex flex-wrap items-center gap-2" aria-label={groupLabel}>
    <Menu label={groupLabel} items={[...formats.map(([format, label]) => {
      const record = recordFor(format);
      const pending = record?.state === 'queued' || record?.state === 'running';
      return {
        label: record?.formats[format]?.state === 'failed' ? `重试 ${label}` : record?.formats[format]?.state === 'ready' ? `下载 ${label}` : `导出 ${label}`,
        disabled: disabled || busy || (pending && record?.formats[format]?.state !== 'ready'),
        onSelect: () => void choose(format),
      };
    }), ...(extraItems.length ? ['separator' as const, ...extraItems.map(item => item === 'separator' || 'heading' in item ? item : { ...item, disabled: disabled || item.disabled, onSelect: () => { if (!disabledRef.current) item.onSelect(); } })] : [])]}><Button size="sm" variant="text" loading={busy} disabled={disabled}>{groupLabel}</Button></Menu>
    {pendingIds.length > 0 && <><span role="status" className="text-caption text-text-3">正在准备文件</span><Button size="sm" variant="text" disabled={disabled || busy} onClick={() => void cancel()}>取消</Button></>}
    {error && <span role="alert" className="text-caption text-error">{error}</span>}
  </div>;
}
