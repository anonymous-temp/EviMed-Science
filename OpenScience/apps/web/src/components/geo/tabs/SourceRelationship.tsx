import { useState } from 'react';
import { GEO_SOURCE_RELATIONSHIP_LABELS_ZH } from '@evimed/domain';
import { getGeoSourceOwnership, setGeoSourceOwnership, type GeoOwnershipTarget, type GeoSourceRelationship, type GeoSourceOwnershipRecord } from '@/lib/geoDistributionClient';
import { webErrorMessage } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Note } from '@/components/ui/Note';
import { useSharedGeoLoad } from '../geoProjectData';
import { useGeoFrame } from '../geoFrame';
import { TabError } from './geoTabKit';

const labels = GEO_SOURCE_RELATIONSHIP_LABELS_ZH;
/** A short manual relationship annotation, never an inferred proof of site ownership. */
export function SourceRelationship({ geoId, target, canEdit, onChanged }: { geoId: string; target: GeoOwnershipTarget; canEdit: boolean; onChanged?(): void }) {
  const frame = useGeoFrame();
  const [editing, setEditing] = useState(false), [history, setHistory] = useState(false), [before, setBefore] = useState<number | undefined>();
  const read = useSharedGeoLoad(`source-ownership:${geoId}:${target.kind}:${target.value}:${before ?? ''}`, () => getGeoSourceOwnership(geoId, target, before));
  if (read.state.kind === 'loading') return <p role="status" className="text-caption text-text-3">正在读取信源关系</p>;
  if (read.state.kind === 'error') return <TabError message={read.state.message} onRetry={read.reload} />;
  const data = read.state.data;
  const relation = data.current?.active ? data.current.relation : data.effective?.relation ?? 'unknown';
  const reload = () => { setBefore(undefined); if (frame) frame.data.reload(`source-ownership:${geoId}:${target.kind}:${target.value}:`); else read.reload(); onChanged?.(); };
  return <section aria-label={target.kind === 'domain' ? '站点关系' : '页面关系'} className="flex flex-col gap-2 rounded-card bg-surface-1 p-3 text-ui">
    <div className="flex flex-wrap items-center gap-2">
      <span>{target.kind === 'domain' ? '站点关系' : '页面关系'}：{labels[relation]}</span>
      {data.effective?.origin === 'domain' && !data.current?.active && <span className="text-caption text-text-3">沿用站点标记</span>}
      {canEdit && <Button size="sm" variant="text" onClick={() => setEditing(value => !value)}>{editing ? '收起修改' : '修改关系'}</Button>}
      {data.current && <Button size="sm" variant="text" onClick={() => setHistory(value => !value)} aria-expanded={history}>变更记录</Button>}
    </div>
    {editing && canEdit && <RelationshipForm key={`${target.kind}:${target.value}:${data.current?.revision ?? 0}`} geoId={geoId} target={target} current={data.current} onSaved={() => { setEditing(false); reload(); }} onReload={reload} />}
    {history && <div>
      <ul aria-label="关系变更记录" className="text-caption text-text-2">
        {data.history.items.map(row => <li key={row.revision}>{new Date(row.reviewedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · {row.active ? labels[row.relation] : '已移除标记'}{row.reason ? ` · ${row.reason}` : ''}</li>)}
      </ul>
      {data.history.nextBeforeRevision != null && <Button size="sm" variant="text" onClick={() => setBefore(data.history.nextBeforeRevision!)}>更早记录</Button>}
      {before !== undefined && <Button size="sm" variant="text" onClick={() => setBefore(undefined)}>最新记录</Button>}
    </div>}
  </section>;
}
function RelationshipForm({ geoId, target, current, onSaved, onReload }: { geoId: string; target: GeoOwnershipTarget; current: GeoSourceOwnershipRecord | null; onSaved(): void; onReload(): void }) {
  const [relation, setRelation] = useState<GeoSourceRelationship>(current?.relation ?? 'unknown');
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async (active = true) => {
    setBusy(true); setError('');
    try { await setGeoSourceOwnership(geoId, { target, relation, expectedRevision: current?.revision ?? 0, reason, active }); onSaved(); }
    catch (failure) { setError(webErrorMessage(failure, { fallback: '标记未保存，请刷新后重试。' })); }
    finally { setBusy(false); }
  };
  return <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void save(); }}>
    <Select label="与本项目的关系" value={relation} disabled={busy} onChange={event => setRelation(event.target.value as GeoSourceRelationship)}>
      {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select>
    <Input label="说明（选填）" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)} />
    {error && <Note tone="warn" action={<Button variant="text" size="sm" onClick={onReload}>刷新</Button>}>{error}</Note>}
    <div className="flex gap-2"><Button type="submit" size="sm" loading={busy}>保存标记</Button>{current?.active && <Button size="sm" variant="text" disabled={busy} onClick={() => void save(false)}>移除标记</Button>}</div>
  </form>;
}
