import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { createVcrProjection, getVcrProtectedDocument, setVcrCloudPermission, type VcrCloudPermission, type VcrIntakeSource } from '@/lib/vcrClient';
import { webErrorMessage } from '@/lib/apiClient';

/** Exact operator-selected identifiers, never a free-text identifier detector. */
export function reviewedSpans(text: string, identifiers: string) {
  const spans: Array<{ start: number; end: number; kind: string }> = [];
  for (const identifier of [...new Set(identifiers.split('\n').map(v => v.trim()).filter(Boolean))]) {
    for (let start = text.indexOf(identifier); start >= 0; start = text.indexOf(identifier, start + identifier.length)) {
      spans.push({ start, end: start + identifier.length, kind: 'identifier' });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof spans = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

export function CloudDocuments({ studyId, source, onChanged }: { studyId: string; source: VcrIntakeSource; onChanged: () => void }) {
  const [dataClass, setDataClass] = useState<NonNullable<VcrCloudPermission['dataClass']>>('deidentified');
  const [reference, setReference] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [documentId, setDocumentId] = useState('');
  const [document, setDocument] = useState<{ id: string; text: string; sourceHash: string } | null>(null);
  const [identifiers, setIdentifiers] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const documents = source.files.filter(file => file.role === 'document');
  const destinations = source.upload.cloudDestinations ?? [];
  const expired = Boolean(source.cloudPermission?.expiresAt && Date.parse(source.cloudPermission.expiresAt) <= Date.now());
  const approved = source.cloudPermission?.status === 'approved' && !expired;
  const run = async (work: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true); setMessage(''); setFailed(false);
    try { await work(); setMessage(success); onChanged(); }
    catch (error) { setFailed(true); setMessage(webErrorMessage(error, { fallback: '暂时无法保存，请重试。' })); }
    finally { setBusy(false); }
  };
  return <Disclosure summary={`病历云端处理 · ${approved ? '已授权' : expired ? '授权已到期' : '未授权'}`}>
    <div className="flex flex-col gap-4">
      {!approved && <form className="flex flex-col gap-3" onSubmit={event => {
        event.preventDefault();
        void run(() => setVcrCloudPermission(studyId, source.id, { status: 'approved', dataClass, purpose: 'vcr', destinations,
          reference, retention: terms ? 'none' : 'unknown', training: terms ? 'disabled' : 'unknown', humanReview: terms ? 'disabled' : 'unknown' }), '已保存授权，可以准备脱敏文本。');
      }}>
        <Select label="文本来源" value={dataClass} onChange={event => setDataClass(event.target.value as typeof dataClass)}>
          <option value="deidentified">已获合作方授权的脱敏病历</option><option value="synthetic">人工编写的模拟病历</option><option value="public">允许此用途的公开文本</option>
        </Select>
        <p className="break-words text-caption text-text-3">{destinations.length ? `处理服务：${destinations.join('、')}` : '本部署尚未登记云端处理服务。'}</p>
        <Input label="授权依据" value={reference} onChange={event => setReference(event.target.value)} required maxLength={500} placeholder="合作协议、公开许可或模拟数据说明" />
        <label className="flex items-start gap-2 text-caption text-text-2"><input type="checkbox" checked={terms} onChange={event => setTerms(event.target.checked)} />
          已核实服务不保留文本、不用于训练、无人工查看，且包含日志与缓存约定</label>
        <Button type="submit" loading={busy} disabled={busy || !destinations.length || !reference.trim() || dataClass === 'deidentified' && !terms}>保存云端处理授权</Button>
      </form>}
      {approved && <>
        <p className="text-caption text-text-3">{source.cloudPermission?.reference}</p>
        <Button variant="secondary" disabled={busy} onClick={() => void run(() => setVcrCloudPermission(studyId, source.id, { status: 'revoked' }), '已停止后续云端读取。')}>撤销云端处理授权</Button>
        {documents.length ? <div className="flex flex-col gap-3">
          <Select label="准备脱敏文本" value={documentId} onChange={event => { setDocumentId(event.target.value); setDocument(null); setIdentifiers(''); setReviewed(false); }}>
            <option value="">选择病历</option>{documents.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
          </Select>
          <Button variant="secondary" disabled={!documentId || busy} onClick={() => void run(async () => {
            const answer = await getVcrProtectedDocument(studyId, documentId); setDocument(answer.document);
          }, '已打开原文，请核对身份信息。')}>打开原文</Button>
          {document && <>
            <Textarea label="受保护的原文" value={document.text} readOnly rows={8} />
            <Textarea label="需替换的姓名、编号或地址（每行一项）" value={identifiers} onChange={event => { setIdentifiers(event.target.value); setReviewed(false); }} rows={4} />
            <p className="text-caption text-text-3">{`已定位 ${reviewedSpans(document.text, identifiers).length} 处。请保留临床日期、剂量、单位和否定表达。`}</p>
            <label className="flex items-start gap-2 text-caption text-text-2"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
              已检查全文；其余文本已获授权，可用于所列云端服务</label>
            <Button loading={busy} disabled={busy || !reviewed} onClick={() => void run(() => createVcrProjection(studyId, document.id, {
              sourceHash: document.sourceHash, spans: reviewedSpans(document.text, identifiers), attestation: source.cloudPermission?.reference ?? reference,
            }), '已准备脱敏文本，匹配可读取这份副本。')}>保存脱敏文本</Button>
          </>}
        </div> : <p className="text-caption text-text-3">上传病历后，可以在这里准备脱敏文本。</p>}
      </>}
      {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'text-caption text-error' : 'text-caption text-text-3'}>{message}</p>}
    </div>
  </Disclosure>;
}
