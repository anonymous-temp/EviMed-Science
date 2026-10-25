import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { cancelGeoOrder, type GeoProject } from '@/lib/geoClient';
import { getGeoExecutionOrders, getGeoOrderDetail, getGeoProjectLedger, getGeoOwnedPublications, getGeoOwnedPublication, confirmGeoOwnedPublication, type GeoExecutionOrder } from '@/lib/geoDistributionClient';
import { webErrorMessage } from '@/lib/apiClient';
import { safeWebHref } from '@/lib/readPages';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { Note } from '@/components/ui/Note';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { useSharedGeoLoad } from '../geoProjectData';
import { useGeoFrame } from '../geoFrame';
import { searchWith } from '../spine/drawerParams';
import { useOpenPublication } from '../spine/useOpenPublication';
import { orderStateWord } from '../geoText';
import { yuan } from './geoTabText';
import { TabError, TabSkeleton } from './geoTabKit';

const when = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未记录';
const ledgerNames: Record<string, string> = { budget_set: '设置预算', reserve: '预留', release: '释放预留', settle: '支付', refund: '退款到账' };
const phaseNames: Record<string, string> = { send_started: '正在提交', late_send_result: '补回提交结果', price_changed: '价格变化', url_changed: '发布地址更新', refund_seen: '退款到账', refund_escalated: '退款待核对', auto_cancel: '自动撤单', check: '检查页面', cited: '发现引用' };

/** Execution history is independent of the current strategy's action list. */
export function DistributionWorkbench({ geoId, project }: { geoId: string; project: GeoProject }) {
  const [tab, setTab] = useState<'orders' | 'owned' | 'ledger'>('orders');
  const [params, setParams] = useSearchParams();
  const orderId = params.get('order');
  const publicationId = params.get('publication');
  const change = (values: Record<string, string | null>) => setParams(previous => new URLSearchParams(searchWith(previous.toString(), values)));
  const openOrder = (id: string) => change({ order: id, action: null, group: null, error: null, source: null, publication: null });
  return <section aria-label="投放执行记录" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button variant={tab === 'orders' ? 'secondary' : 'text'} aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>订单与发布</Button>
      <Button variant={tab === 'owned' ? 'secondary' : 'text'} aria-pressed={tab === 'owned'} onClick={() => setTab('owned')}>自主发布</Button>
      <Button variant={tab === 'ledger' ? 'secondary' : 'text'} aria-pressed={tab === 'ledger'} onClick={() => setTab('ledger')}>费用流水</Button>
    </div>
    {tab === 'orders' ? <OrderPage key={geoId} geoId={geoId} onOpen={openOrder} /> : tab === 'owned' ? <OwnedPage key={geoId} geoId={geoId} onOpen={id => change({ publication: id, order: null, action: null, group: null, error: null, source: null })} /> : <LedgerPage key={geoId} geoId={geoId} onOpen={openOrder} />}
    {orderId && <OrderDetail key={`${geoId}:${orderId}`} geoId={geoId} project={project} orderId={orderId} onClose={() => change({ order: null })} />}
    {!orderId && publicationId && <OwnedDetail key={`${geoId}:${publicationId}`} geoId={geoId} project={project} linkId={publicationId} onClose={() => change({ publication: null })} />}
  </section>;
}

function usePages() {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  return { cursor: cursors.at(-1) ?? null, page: cursors.length, next: (cursor: string) => setCursors(old => [...old, cursor]),
    previous: () => setCursors(old => old.slice(0, -1)), first: () => setCursors([null]) };
}
function PageControls({ pager, nextCursor, total, refresh, firstKey }: { pager: ReturnType<typeof usePages>; nextCursor: string | null; total: number; refresh(): void; firstKey: string }) {
  const frame = useGeoFrame();
  return <div className="flex flex-wrap items-center gap-2 text-caption text-text-3">
    <span>{`共 ${total} 条 · 第 ${pager.page} 页`}</span>
    {pager.page > 1 && <Button size="sm" variant="text" onClick={pager.previous}>上一页</Button>}
    {nextCursor && <Button size="sm" variant="text" onClick={() => pager.next(nextCursor)}>下一页</Button>}
    <Button size="sm" variant="text" onClick={() => { pager.first(); if (frame) frame.data.reload(firstKey); else refresh(); }}>刷新记录</Button>
  </div>;
}
function OrderPage({ geoId, onOpen }: { geoId: string; onOpen(id: string): void }) {
  const pager = usePages();
  const { state, reload } = useSharedGeoLoad(`distribution-orders:${geoId}:${pager.cursor ?? ''}`, () => getGeoExecutionOrders(geoId, { cursor: pager.cursor, limit: 30 }));
  if (state.kind === 'loading') return <TabSkeleton />;
  if (state.kind === 'error') return <TabError message={state.message} onRetry={reload} />;
  return <div className="flex flex-col gap-3">
    {state.refreshError && <Note tone="warn" action={<Button size="sm" onClick={reload}>重试</Button>}>{state.refreshError}</Note>}
    {state.data.items.length === 0 ? <p className="text-ui text-text-3">还没有投放订单。已有的自主发布页面仍显示在对应行动中。</p> : <ul aria-label="投放订单" className="divide-y divide-border">
      {state.data.items.map(order => <li key={order.id} className="flex flex-wrap items-center gap-3 py-3 text-ui">
        <button type="button" className="min-w-0 flex-1 text-left text-link hover:underline" onClick={() => onOpen(order.id)}>{order.articleTitle || '未关联稿件'} · {order.media || order.domain || '媒体未记录'}</button>
        <span>{orderStateWord(order.state)}</span><span className="tabular-nums">{yuan(order.priceCny)}</span>
        <span className="text-caption text-text-3">{order.versionState === 'update_needed' ? '稿件已有新版本' : order.versionState === 'unknown' ? '发布版本未记录' : '与当前稿件一致'}</span>
        <span className="text-caption text-text-3">{order.publishedAt ? `发布于 ${when(order.publishedAt)}` : '尚无发布记录'}</span>
      </li>)}
    </ul>}
    <PageControls pager={pager} nextCursor={state.data.nextCursor} total={state.data.total} refresh={reload} firstKey={`distribution-orders:${geoId}:`} />
  </div>;
}
function LedgerPage({ geoId, onOpen }: { geoId: string; onOpen(id: string): void }) {
  const pager = usePages();
  const { state, reload } = useSharedGeoLoad(`distribution-ledger:${geoId}:${pager.cursor ?? ''}`, () => getGeoProjectLedger(geoId, { cursor: pager.cursor, limit: 30 }));
  if (state.kind === 'loading') return <TabSkeleton />;
  if (state.kind === 'error') return <TabError message={state.message} onRetry={reload} />;
  const money = state.data.summary;
  return <div className="flex flex-col gap-3">
    {state.refreshError && <Note tone="warn" action={<Button size="sm" onClick={reload}>重试</Button>}>{state.refreshError}</Note>}
    <dl className="flex flex-wrap gap-x-6 gap-y-2 text-ui">
      {([['累计支付', money.settledCny], ['退款到账', money.refundedCny], ['净支出', money.spentCny], ['已预留', money.reservedCny], ['可用预算', money.availableCny]] as const).map(([label, value]) => <div key={label}><dt className="text-caption text-text-3">{label}</dt><dd className="tabular-nums">{yuan(value)}</dd></div>)}
    </dl>
    {state.data.items.length === 0 ? <p className="text-ui text-text-3">还没有费用流水。</p> : <ul aria-label="费用流水" className="divide-y divide-border">
      {state.data.items.map(row => <li key={row.id} className="flex flex-wrap items-baseline gap-3 py-3 text-ui">
        <span>{when(row.createdAt)}</span><span>{ledgerNames[row.kind] || '其他变动'}</span><span className="tabular-nums">{yuan(row.amountCny)}</span>
        <span className="text-caption text-text-3">{`变动后可用 ${yuan(row.balance.availableCny)}`}</span>
        {row.orderId && <Button variant="text" size="sm" onClick={() => onOpen(row.orderId!)}>查看订单</Button>}
      </li>)}
    </ul>}
    <PageControls pager={pager} nextCursor={state.data.nextCursor} total={state.data.total} refresh={reload} firstKey={`distribution-ledger:${geoId}:`} />
  </div>;
}
function OrderDetail({ geoId, project, orderId, onClose }: { geoId: string; project: GeoProject; orderId: string; onClose(): void }) {
  const frame = useGeoFrame();
  const pager = usePages();
  const { state, reload } = useSharedGeoLoad(`distribution-order:${geoId}:${orderId}:${pager.cursor ?? ''}`, () => getGeoOrderDetail(geoId, orderId, { cursor: pager.cursor, limit: 30 }));
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const openPublication = useOpenPublication(project);
  const openVersion = async (order: GeoExecutionOrder) => {
    if (!order.articleResultVersionId || !order.articleDigest) return;
    await openPublication(order.articleResultVersionId, order.articleDigest);
  };
  const cancel = async () => {
    setConfirm(false); setBusy(true);
    try { await cancelGeoOrder(geoId, orderId); toast.success('撤单请求已处理，退款与可用预算以实际流水为准。'); reload(); frame?.data.invalidate(); }
    catch (error) { toast.error(webErrorMessage(error, { fallback: '撤单未完成，请刷新订单状态后重试。' })); }
    finally { setBusy(false); }
  };
  const order = state.kind === 'ready' ? state.data.order : null;
  const href = safeWebHref(order?.publishedUrl);
  const canManage = !project.access || project.access.abilities.includes('manage_money');
  return <Drawer title={order?.articleTitle || '投放订单'} onClose={onClose}>
    {state.kind === 'loading' && <TabSkeleton />}
    {state.kind === 'error' && <TabError message={state.message} onRetry={reload} />}
    {order && state.kind === 'ready' && <div className="flex flex-col gap-4">
      {state.refreshError && <Note tone="warn" action={<Button size="sm" onClick={reload}>重试</Button>}>{state.refreshError}</Note>}
      <p className="text-ui">{orderStateWord(order.state)} · {order.media || order.domain || '媒体未记录'} · {yuan(order.priceCny)}</p>
      <p className="text-caption text-text-3">{`实际发布时间：${when(order.publishedAt)}`}</p>
      {order.versionState === 'update_needed' && <p className="text-ui text-text-3">当前稿件已有新版本，线上页面仍关联当时发布的版本。</p>}
      {order.versionState === 'unknown' && <p className="text-ui text-text-3">这个历史订单没有保留稿件版本，不能据此判断线上内容是否已更新。</p>}
      <div className="flex flex-wrap gap-2">
        {href && <a href={href} target="_blank" rel="noreferrer" className="text-link hover:underline">打开线上页面</a>}
        {order.articleResultVersionId && order.articleDigest && <Button variant="text" size="sm" onClick={() => void openVersion(order)}>查看当时稿件</Button>}
        {order.cancellable && canManage && <Button variant="secondary" size="sm" loading={busy} onClick={() => setConfirm(true)}>撤单</Button>}
      </div>
      <ol aria-label="订单时间线" className="divide-y divide-border">
        {state.data.events.items.map(event => <li key={event.id} className="flex flex-wrap gap-3 py-2 text-ui"><time>{when(event.at)}</time><span>{event.phase ? phaseNames[event.phase] || '状态更新' : event.toState ? orderStateWord(event.toState) : '状态更新'}</span>{event.amountCny != null && <span>{yuan(event.amountCny)}</span>}</li>)}
      </ol>
      <PageControls pager={pager} nextCursor={state.data.events.nextCursor} total={state.data.events.total} refresh={reload} firstKey={`distribution-order:${geoId}:${orderId}:`} />
    </div>}
    {confirm && <ConfirmDialog title="提交撤单请求？" body="媒体处理结果会更新到订单；预留释放和退款以实际费用流水为准。" confirmLabel="撤单" onConfirm={() => void cancel()} onCancel={() => setConfirm(false)} />}
  </Drawer>;
}

function OwnedPage({ geoId, onOpen }: { geoId: string; onOpen(id: string): void }) {
  const pager = usePages();
  const { state, reload } = useSharedGeoLoad(`owned-publications:${geoId}:${pager.cursor ?? ''}`, () => getGeoOwnedPublications(geoId, { cursor: pager.cursor, limit: 30 }));
  if (state.kind === 'loading') return <TabSkeleton />;
  if (state.kind === 'error') return <TabError message={state.message} onRetry={reload} />;
  return <div className="flex flex-col gap-3">
    {state.refreshError && <Note tone="warn" action={<Button size="sm" onClick={reload}>重试</Button>}>{state.refreshError}</Note>}
    {state.data.items.length === 0 ? <p className="text-ui text-text-3">还没有登记自主发布的页面，可在对应行动中添加发布地址。</p> : <ul aria-label="自主发布页面" className="divide-y divide-border">
      {state.data.items.map(link => <li key={link.id} className="flex flex-wrap items-baseline gap-3 py-3 text-ui">
        <button type="button" className="min-w-0 flex-1 text-left text-link hover:underline" onClick={() => onOpen(link.id)}>{link.title || link.url}</button>
        <span>{link.status === 'retired' ? '已下线' : '已登记发布'}</span>
        <span className="text-caption text-text-3">{link.versionState === 'update_needed' ? '稿件已有新版本' : link.versionState === 'unknown' ? '发布版本未记录' : '与当前稿件一致'}</span>
        <span className="text-caption text-text-3">{when(link.publishedAt)}</span>
      </li>)}
    </ul>}
    <PageControls pager={pager} nextCursor={state.data.nextCursor} total={state.data.total} refresh={reload} firstKey={`owned-publications:${geoId}:`} />
  </div>;
}
const localPublicationTime = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
function OwnedDetail({ geoId, project, linkId, onClose }: { geoId: string; project: GeoProject; linkId: string; onClose(): void }) {
  const [before, setBefore] = useState<number | undefined>();
  const { state, reload } = useSharedGeoLoad(`owned-publication:${geoId}:${linkId}:${before ?? ''}`, () => getGeoOwnedPublication(geoId, linkId, before));
  const frame = useGeoFrame(), openPublication = useOpenPublication(project);
  const [publishedAt, setPublishedAt] = useState(localPublicationTime), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<Parameters<typeof confirmGeoOwnedPublication>[2] | null>(null);
  const data = state.kind === 'ready' ? state.data : null, link = data?.link;
  const href = safeWebHref(link?.url);
  const canEdit = !project.access || project.access.abilities.includes('edit');
  const prepare = () => {
    if (!data || !link?.currentResultVersionId || !link.currentDigest || !publishedAt) return;
    const at = new Date(`${publishedAt}:00+08:00`);
    if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now()) { setError('请输入已经发生的更新时间。'); return; }
    const input = { expectedRevision: data.revision, expectedResultVersionId: link.articleResultVersionId, expectedDigest: link.articleDigest,
      resultVersionId: link.currentResultVersionId, digest: link.currentDigest, publishedAt: at.toISOString() };
    const previous = pending ? { ...pending, requestKey: undefined } : null;
    setPending(previous && JSON.stringify(previous) === JSON.stringify(input) ? pending : { ...input, requestKey: crypto.randomUUID() });
    setError(''); setConfirm(true);
  };
  const save = async () => {
    if (!pending) return;
    setBusy(true); setError('');
    try { await confirmGeoOwnedPublication(geoId, linkId, pending); setConfirm(false); setBefore(undefined); reload(); frame?.data.invalidate(); toast.success('已登记线上稿件版本，原版本仍保留在更新记录中。'); }
    catch (failure) { setConfirm(false); setError(webErrorMessage(failure, { fallback: '登记结果尚未确认，可以重试同一次登记或刷新查看。' })); }
    finally { setBusy(false); }
  };
  return <Drawer title={link?.title || '自主发布页面'} onClose={onClose}>
    {state.kind === 'loading' && <TabSkeleton />}
    {state.kind === 'error' && <TabError message={state.message} onRetry={reload} />}
    {data && link && <div className="flex flex-col gap-4 text-ui">
      {href && <a href={href} target="_blank" rel="noreferrer" className="break-all text-link hover:underline">{link.url}</a>}
      <p>{link.status === 'retired' ? '已登记下线' : '已登记发布'} · {when(link.publishedAt)}</p>
      <p className="text-text-3">{link.versionState === 'update_needed' ? '稿件已有新版本。编辑稿件不会自动更新这个线上页面。' : link.versionState === 'unknown' ? '此前没有记录完整的发布稿件版本。' : '登记的发布版本与当前稿件一致。'}</p>
      {link.articleResultVersionId && link.articleDigest && <Button variant="text" size="sm" onClick={() => void openPublication(link.articleResultVersionId!, link.articleDigest!)}>查看已登记稿件</Button>}
      {canEdit && link.currentResultVersionId && link.currentDigest && <div className="flex flex-col gap-2">
        <Input type="datetime-local" label="实际更新时间（北京时间）" value={publishedAt} onChange={event => setPublishedAt(event.target.value)} disabled={busy} />
        <Button size="sm" onClick={prepare} disabled={busy}>登记线上已更新为当前稿件</Button>
        <p className="text-caption text-text-3">请在自行更新线上页面后登记。登记会保留旧稿件及历史记录。</p>
      </div>}
      {error && <Note tone="warn" action={<Button size="sm" variant="text" onClick={reload}>刷新记录</Button>}>{error}</Note>}
      <ol aria-label="发布版本记录" className="divide-y divide-border">
        {data.history.items.map(receipt => <li key={receipt.revision} className="flex flex-wrap items-baseline gap-2 py-2">
          <span>{receipt.basis === 'legacy_record' ? '此前登记' : '登记线上更新'} · {when(receipt.publishedAt)}</span>
          {receipt.resultVersionId && receipt.digest ? <Button size="sm" variant="text" onClick={() => void openPublication(receipt.resultVersionId!, receipt.digest!)}>查看这版稿件</Button> : <span className="text-text-3">稿件版本未记录</span>}
        </li>)}
      </ol>
      {data.history.items.length === 0 && <p className="text-caption text-text-3">还没有版本更新记录。</p>}
      <div className="flex gap-2">{data.history.nextBeforeRevision && <Button size="sm" variant="text" onClick={() => setBefore(data.history.nextBeforeRevision!)}>更早记录</Button>}{before && <Button size="sm" variant="text" onClick={() => setBefore(undefined)}>最新记录</Button>}</div>
    </div>}
    {confirm && <ConfirmDialog tone="primary" title="该页面已更新为当前稿件？" body="此操作登记你已完成的线上更新，不会代你发布。原稿件版本与此前登记会继续保留。" confirmLabel="确认登记" busy={busy} onConfirm={() => void save()} onCancel={() => setConfirm(false)} />}
  </Drawer>;
}
