import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { createVcrProjection, getVcrProtectedDocument, retireVcrProjection, setVcrCloudPermission, type VcrCloudPermission, type VcrCloudState, type VcrIdentifierSuggestion, type VcrIntakeSource } from '@/lib/vcrClient';
import { ShowMore, useShowMore } from '@/components/ui/ShowMore';
import { webErrorMessage } from '@/lib/apiClient';
import { cn } from '@/lib/cn';

/** What the reviewer listed, one identifier per line, each once. */
function listedIdentifiers(identifiers: string): string[] {
  return [...new Set(identifiers.split('\n').map(v => v.trim()).filter(Boolean))];
}

/** Where `identifier` stands in `text`: one offset per non-overlapping occurrence, in UTF-16 units as the server counts. */
function occurrencesOf(text: string, identifier: string): number[] {
  const starts: number[] = [];
  for (let start = text.indexOf(identifier); start >= 0; start = text.indexOf(identifier, start + identifier.length)) starts.push(start);
  return starts;
}

/** How often each listed identifier stands in the text, one by one: one that stands nowhere is a misspelling, not a quiet zero in a total. */
export function identifierCounts(text: string, identifiers: string): Array<{ identifier: string; count: number }> {
  return listedIdentifiers(identifiers).map(identifier => ({ identifier, count: occurrencesOf(text, identifier).length }));
}

/**
 * The text cut at the reviewed spans: what is written and what is masked. The masked pieces carry no text, so nothing that will be
 * replaced can be drawn from the result.
 */
export function maskedParts(text: string, spans: ReadonlyArray<{ start: number; end: number }>): Array<{ text: string; masked: boolean }> {
  const parts: Array<{ text: string; masked: boolean }> = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) parts.push({ text: text.slice(cursor, span.start), masked: false });
    parts.push({ text: '', masked: true });
    cursor = span.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), masked: false });
  return parts;
}

/**
 * The spans of the projection: the exact identifiers the reviewer listed (every place they stand) and the suggestions the reviewer
 * accepted, each with its own kind. Nothing is a span until the reviewer put it there; overlapping spans are one span, the first's kind.
 */
export function reviewedSpans(text: string, identifiers: string, accepted: ReadonlyArray<{ start: number; end: number; kind: string }> = []) {
  const spans: Array<{ start: number; end: number; kind: string }> = [];
  for (const identifier of listedIdentifiers(identifiers)) {
    for (const start of occurrencesOf(text, identifier)) spans.push({ start, end: start + identifier.length, kind: 'identifier' });
  }
  for (const span of accepted) spans.push({ start: span.start, end: span.end, kind: span.kind });
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof spans = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** What a suggestion is, in the reviewer's words. */
export function suggestionLabel(suggestion: Pick<VcrIdentifierSuggestion, 'format' | 'birth'>): string {
  if (suggestion.format === 'resident_id') return '居民身份证号';
  if (suggestion.format === 'mobile') return '手机号';
  if (suggestion.format === 'record_number') return '病历编号';
  return suggestion.birth ? '出生日期' : '日期';
}

/** Where a source stands for the cloud models: the server says so; an older answer is read from the recorded permission. */
export function cloudStateOf(source: Pick<VcrIntakeSource, 'cloud' | 'cloudPermission'>, now = Date.now()): VcrCloudState & { expired: boolean } {
  const recorded = source.cloudPermission;
  const expired = Boolean(recorded?.status === 'approved' && recorded.expiresAt && Date.parse(recorded.expiresAt) <= now);
  if (source.cloud) return { ...source.cloud, expired };
  if (recorded?.status === 'revoked') return { state: 'restricted', basis: null, expired };
  if (recorded?.status === 'approved' && !expired) return { state: 'allowed', basis: 'source_permission', expired };
  return { state: 'closed', basis: null, expired };
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
  const [accepted, setAccepted] = useState<ReadonlyArray<VcrIdentifierSuggestion>>([]);
  const [reviewed, setReviewed] = useState(false);
  const documents = source.files.filter(file => file.role === 'document' && !file.erased);
  // The reviewed texts saved of the record being worked on: any of them that missed an identifier can be retired.
  const saved = documents.find(file => file.id === documentId)?.projections ?? [];
  const destinations = source.upload.cloudDestinations ?? [];
  const cloud = cloudStateOf(source);
  const summary = cloud.state === 'restricted' ? '已限制'
    : cloud.state === 'allowed' ? (cloud.basis === 'source_permission' ? '已授权' : '已开放')
      : cloud.expired ? '授权已到期' : '未授权';
  // The record and the names typed beside it are the most sensitive text on the page: they live only while the reviewer is working on
  // them, and go when the text is saved, when another record is chosen, or when the fold is closed.
  const forget = () => { setDocument(null); setIdentifiers(''); setAccepted([]); setReviewed(false); };
  const run = async (work: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true); setMessage(''); setFailed(false);
    try { await work(); setMessage(success); onChanged(); }
    catch (error) { setFailed(true); setMessage(webErrorMessage(error, { fallback: '暂时无法保存，请重试。' })); }
    finally { setBusy(false); }
  };
  return <Disclosure summary={`病历云端处理 · ${summary}`} onToggle={open => { if (!open) forget(); }}>
    <div className="flex flex-col gap-4">
      {cloud.state === 'closed' && <form className="flex flex-col gap-3" onSubmit={event => {
        event.preventDefault();
        void run(() => setVcrCloudPermission(studyId, source.id, { status: 'approved', dataClass, purpose: 'vcr', destinations,
          reference, retention: terms ? 'none' : 'unknown', training: terms ? 'disabled' : 'unknown', humanReview: terms ? 'disabled' : 'unknown' }), '已保存授权，可以准备脱敏文本。');
      }}>
        <Select label="文本来源" value={dataClass} onChange={event => setDataClass(event.target.value as typeof dataClass)}>
          <option value="deidentified">已获合作方授权的脱敏病历</option><option value="clinical">已获合作方授权的含身份信息病历</option>
          <option value="synthetic">人工编写的模拟病历</option><option value="public">允许此用途的公开文本</option>
        </Select>
        <p className="break-words text-caption text-text-3">{destinations.length ? `处理服务：${destinations.join('、')}` : '本部署尚未登记云端处理服务。'}</p>
        <Input label="授权依据" value={reference} onChange={event => setReference(event.target.value)} required maxLength={500} placeholder="合作协议、公开许可或模拟数据说明" />
        <label className="flex items-start gap-2 text-caption text-text-2"><input type="checkbox" checked={terms} onChange={event => setTerms(event.target.checked)} />
          已核实服务不保留文本、不用于训练、无人工查看，且包含日志与缓存约定</label>
        <Button type="submit" loading={busy} disabled={busy || !destinations.length || !reference.trim() || (dataClass === 'deidentified' || dataClass === 'clinical') && !terms}>保存云端处理授权</Button>
      </form>}
      {cloud.state === 'restricted' && <>
        <p className="text-caption text-text-3">这个数据源的病历不会交给云端模型。</p>
        <Button variant="secondary" disabled={busy} onClick={() => void run(() => setVcrCloudPermission(studyId, source.id, { status: 'default' }), '已恢复云端处理。')}>恢复云端处理</Button>
      </>}
      {cloud.state === 'allowed' && <>
        {cloud.basis === 'source_permission' && <p className="text-caption text-text-3">{source.cloudPermission?.reference}</p>}
        <Button variant="secondary" disabled={busy} onClick={() => void run(() => setVcrCloudPermission(studyId, source.id, { status: 'revoked' }),
          cloud.basis === 'source_permission' ? '已停止后续云端读取。' : '已限制这个数据源的云端处理。')}>
          {cloud.basis === 'source_permission' ? '撤销云端处理授权' : '限制云端处理'}</Button>
        {documents.length ? <div className="flex flex-col gap-3">
          <Select label="准备脱敏文本" value={documentId} onChange={event => { setDocumentId(event.target.value); forget(); }}>
            <option value="">选择病历</option>{documents.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
          </Select>
          <Button variant="secondary" disabled={!documentId || busy} onClick={() => void run(async () => {
            const answer = await getVcrProtectedDocument(studyId, documentId); setDocument(answer.document);
          }, '已打开原文，请核对身份信息。')}>打开原文</Button>
          {saved.length > 0 && <ul aria-label="已保存的脱敏文本" className="flex flex-col divide-y divide-faint">
            {saved.map((projection, index) => <li key={projection.id} className="flex items-center justify-between gap-3 py-2">
              <span className="text-caption text-text-2">{`脱敏文本 ${index + 1}${projection.at ? ` · ${projection.at.slice(0, 10)} 保存` : ''}`}</span>
              <Button variant="text" size="sm" disabled={busy} onClick={() => void run(() => retireVcrProjection(studyId, projection.id), '已停用并清除这份脱敏文本。')}>停用并清除</Button>
            </li>)}
          </ul>}
          {document && <Redaction document={document} identifiers={identifiers} accepted={accepted} reviewed={reviewed} busy={busy}
            onIdentifiers={value => { setIdentifiers(value); setReviewed(false); }} onReviewed={setReviewed}
            onAccepted={next => { setAccepted(next); setReviewed(false); }}
            onSave={() => void run(async () => {
              await createVcrProjection(studyId, document.id, {
                sourceHash: document.sourceHash, spans: reviewedSpans(document.text, identifiers, accepted),
                attestation: source.cloudPermission?.reference || reference || '病历审阅人已核对脱敏文本',
              });
              forget();
            }, '已准备脱敏文本，匹配可读取这份副本。')} />}
        </div> : <p className="text-caption text-text-3">上传病历后，可以在这里准备脱敏文本。</p>}
      </>}
      {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'text-caption text-error' : 'text-caption text-text-3'}>{message}</p>}
    </div>
  </Disclosure>;
}

/** A scrolling box a keyboard can reach: the attributes are a spread so the a11y rule that cannot model a scroll region stays quiet. */
const PREVIEW_REGION = { tabIndex: 0, role: 'region', 'aria-label': '脱敏后的文本' } as const;

/**
 * The privacy gate of a record: the protected original, the names to replace, and — what the attestation is about — the text as it
 * will be saved, with each located span masked and everything else as written (review V-C1). A name the reviewer did not list is
 * plainly still in it; an identifier that stands nowhere in the record is counted as 0 and flagged, not hidden inside a total.
 */
function Redaction({ document, identifiers, accepted, reviewed, busy, onIdentifiers, onAccepted, onReviewed, onSave }: {
  document: { id: string; text: string; sourceHash: string; suggestions?: VcrIdentifierSuggestion[] };
  identifiers: string; accepted: ReadonlyArray<VcrIdentifierSuggestion>; reviewed: boolean; busy: boolean;
  onIdentifiers: (value: string) => void; onAccepted: (next: ReadonlyArray<VcrIdentifierSuggestion>) => void; onReviewed: (value: boolean) => void; onSave: () => void;
}) {
  const spans = reviewedSpans(document.text, identifiers, accepted);
  const counts = identifierCounts(document.text, identifiers);
  return <>
    <Textarea label="受保护的原文" value={document.text} readOnly rows={8} />
    <Suggestions text={document.text} suggestions={document.suggestions ?? []} accepted={accepted} onAccepted={onAccepted} />
    <Textarea label="需替换的姓名、编号或地址（每行一项）" value={identifiers} onChange={event => onIdentifiers(event.target.value)} rows={4} />
    {counts.length > 0 && <ul aria-label="需替换的内容" className="flex flex-col gap-1">
      {counts.map(({ identifier, count }) => <li key={identifier} className={cn('flex items-center gap-2 text-caption', count === 0 ? 'text-warn-strong' : 'text-text-2')}>
        {count === 0 && <TriangleAlert size={16} aria-hidden="true" className="shrink-0" />}
        <span className="min-w-0 break-words text-text">{identifier}</span>
        <span className="shrink-0 tabular-nums">{count === 0 ? '0 处，原文里没有找到，请核对写法' : `${count} 处`}</span>
      </li>)}
    </ul>}
    <p className="text-caption text-text-3">{`共 ${spans.length} 处将被替换。请保留临床日期、剂量、单位和否定表达。`}</p>
    <div className="flex flex-col gap-1">
      <p className="text-ui font-semibold text-text">脱敏后的文本</p>
      <p className="text-caption text-text-3">保存时遮蔽处换成代号，其余文字原样保留。</p>
      <div {...PREVIEW_REGION} className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-1 p-3 text-ui text-text">
        {maskedParts(document.text, spans).map((part, index) => part.masked
          ? <span key={index} className="rounded-tag bg-surface-2 px-1 text-text-3">已遮蔽</span>
          : part.text)}
      </div>
    </div>
    <label className="flex items-start gap-2 text-caption text-text-2"><input type="checkbox" checked={reviewed} onChange={event => onReviewed(event.target.checked)} />
      已检查脱敏后的全文；其余文本已获授权，可用于所列云端服务</label>
    <Button loading={busy} disabled={busy || !reviewed} onClick={onSave}>保存脱敏文本</Button>
  </>;
}

/** The characters of context shown either side of a suggestion, so a date can be told from the date of birth. */
const SUGGESTION_CONTEXT = 8;
const SUGGESTIONS_SHOWN = 20;

/**
 * The identifiers of closed formats the server found in the record, as spans to accept one by one (or all at once). None is applied
 * until the reviewer accepts it: an accepted suggestion joins the spans of the projection, and a suggestion left alone stays in the text.
 */
function Suggestions({ text, suggestions, accepted, onAccepted }: {
  text: string; suggestions: ReadonlyArray<VcrIdentifierSuggestion>; accepted: ReadonlyArray<VcrIdentifierSuggestion>;
  onAccepted: (next: ReadonlyArray<VcrIdentifierSuggestion>) => void;
}) {
  const shown = useShowMore(suggestions, { first: SUGGESTIONS_SHOWN, step: SUGGESTIONS_SHOWN, resetKey: text.length.toString() });
  if (!suggestions.length) return null;
  const taken = (suggestion: VcrIdentifierSuggestion) => accepted.some(other => other.start === suggestion.start && other.end === suggestion.end);
  const open = suggestions.filter(suggestion => !taken(suggestion));
  return <div className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-3">
      <p className="text-ui font-semibold text-text">{`建议遮蔽 · ${suggestions.length} 处`}</p>
      {open.length > 0 && <Button variant="text" size="sm" onClick={() => onAccepted([...accepted, ...open])}>全部接受</Button>}
    </div>
    <ul aria-label="建议遮蔽" className="flex flex-col divide-y divide-faint">
      {shown.visible.map(suggestion => {
        const on = taken(suggestion);
        const value = text.slice(suggestion.start, suggestion.end);
        return <li key={`${suggestion.start}-${suggestion.end}`} className="flex items-center gap-3 py-2">
          <span className="w-24 shrink-0 text-caption text-text-3">{suggestionLabel(suggestion)}</span>
          <span className="min-w-0 flex-1 break-words text-caption text-text-3">
            {text.slice(Math.max(0, suggestion.start - SUGGESTION_CONTEXT), suggestion.start)}<span className="text-ui text-text">{value}</span>{text.slice(suggestion.end, suggestion.end + SUGGESTION_CONTEXT)}
          </span>
          <Button variant="text" size="sm" aria-label={`${on ? '取消接受' : '接受'} ${value}`}
            onClick={() => onAccepted(on ? accepted.filter(other => !(other.start === suggestion.start && other.end === suggestion.end)) : [...accepted, suggestion])}>
            {on ? '已接受' : '接受'}</Button>
        </li>;
      })}
    </ul>
    <ShowMore remaining={shown.remaining} unit="处" onMore={shown.more} />
  </div>;
}
