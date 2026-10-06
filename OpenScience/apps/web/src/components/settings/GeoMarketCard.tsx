import { useCallback, useEffect, useRef, useState } from "react";
import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import {
  fetchGeoMarket, listGeoMarketOrders, listGeoMarketTopups, fetchGeoMonthlySettlement, confirmGeoMarketTopup,
  resolveGeoMarketOrder, markGeoMarketOrderLost, clearGeoMarketStop, isGeoOff,
  type GeoMarketOverview, type GeoMarketOrder, type GeoMarketTopup, type GeoMonthlySettlement,
} from "@/lib/geoClient";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { DataTable } from "@/components/ui/DataTable";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/cards/EmptyState";

type View = "unknown" | "problems" | "topups" | "settlement";
const money = (value: number | null | undefined) => value == null ? "—" : `¥${value.toFixed(2)}`;
const flowLabels: Record<string, string> = { settle: "结算支出", refund: "已到账退款", reserve: "预留", release: "释放预留",
  topup_request: "申请充值", topup_confirmed: "充值到账", adjustment: "调整", budget_set: "预算变更" };
const reasonLabels: Record<string, string> = { text_changed: "正文内容不符", domain_mismatch: "发布域名不符", unreachable: "页面无法访问", above_reserve: "金额超过预留" };
const topupLabels = { requested: "待核对", confirmed: "已到账", cancelled: "已取消" };

export function GeoMarketCard() {
  const [overview, setOverview] = useState<GeoMarketOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [view, setView] = useState<View>("unknown");
  const [month, setMonth] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [orders, setOrders] = useState<GeoMarketOrder[]>([]);
  const [topups, setTopups] = useState<GeoMarketTopup[]>([]);
  const [statement, setStatement] = useState<GeoMonthlySettlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ order: GeoMarketOrder; kind: "resolve" | "lost" } | null>(null);
  const [field, setField] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null);
  const overviewGeneration = useRef(0);
  const alive = useRef(true);
  const overviewLoad = useCallback(async () => {
    const generation = ++overviewGeneration.current;
    setOverviewError(null);
    try {
      const result = await fetchGeoMarket();
      if (!alive.current || generation !== overviewGeneration.current) return;
      setOverview(result);
      setMonth((current) => current || result.currentMonth || "");
    } catch (error) {
      if (!alive.current || generation !== overviewGeneration.current) return;
      if (isGeoOff(error)) setOff(true);
      else setOverviewError(webErrorMessage(error));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void overviewLoad();
    return () => { alive.current = false; };
  }, [overviewLoad]);
  useEffect(() => {
    if (!overview?.operationsAvailable) return;
    if (view === "settlement" && !month) { setStatement(null); setLoading(false); setNextCursor(null); return; }
    let active = true;
    setLoading(true);
    setListError(null);
    setNextCursor(null);
    setOrders([]);
    setTopups([]);
    setStatement(null);
    const query = { cursor, limit: 50 };
    const read = async () => {
      try {
        if (view === "settlement") {
          const result = await fetchGeoMonthlySettlement({ ...query, month });
          if (active) { setStatement(result); setNextCursor(result.nextCursor); }
        } else if (view === "topups") {
          const result = await listGeoMarketTopups({ ...query, status: "all" });
          if (active) { setTopups(result.items); setNextCursor(result.nextCursor); }
        } else {
          const result = await listGeoMarketOrders({ ...query, view });
          if (active) { setOrders(result.items); setNextCursor(result.nextCursor); }
        }
      } catch (error) { if (active) setListError(webErrorMessage(error)); }
      finally { if (active) setLoading(false); }
    };
    void read();
    return () => { active = false; };
  }, [overview?.operationsAvailable, view, month, cursor, refresh]);

  const mutate = async <T,>(id: string, action: () => Promise<T>, message: string | ((result: T) => string)) => {
    if (pending) return;
    setPending(id); setActionError(null); setNotice(null);
    try {
      const result = await action();
      if (!alive.current) return;
      setNotice(typeof message === "function" ? message(result) : message); setEditing(null); setCursor(null); setRefresh((n) => n + 1);
      void overviewLoad();
    } catch (error) {
      if (alive.current) {
        setActionError(webErrorMessage(error));
        if (error instanceof WebApiError && [404, 409].includes(error.status)) {
          setEditing(null); setCursor(null); setRefresh((n) => n + 1); void overviewLoad();
        }
      }
    }
    finally { if (alive.current) setPending(null); }
  };
  const pageTo = (next: string | null) => { setCursor(next); setEditing(null); setField(""); setConfirmation(null); };
  const changeView = (next: View) => { setView(next); pageTo(null); setNotice(null); setActionError(null); };
  const state = loading ? "loading" : listError ? "error" : "content";
  const tableCommon = { state, errorMessage: listError ?? undefined, onRetry: () => setRefresh((n) => n + 1), emptyText: "暂无记录。" } as const;
  if (off) return null;
  if (overviewError) return <Panel title="循证传播投放" className="mt-6"><EmptyState title="无法读取投放状态" description={overviewError}
    action={<Button variant="secondary" onClick={() => void overviewLoad()}>重试</Button>} /></Panel>;
  if (!overview) return <Panel title="循证传播投放" className="mt-6"><div className="h-24 animate-pulse bg-surface-2" aria-label="正在读取投放状态" /></Panel>;
  if (!overview.operationsAvailable) return <Panel title="循证传播投放" className="mt-6"><EmptyState title="投放管理暂不可用"
    action={<Button variant="secondary" onClick={() => void overviewLoad()}>重试</Button>} /></Panel>;

  return <Panel title="循证传播投放" className="mt-6" action={<Button size="sm" variant="text" onClick={() => { pageTo(null); void overviewLoad(); setRefresh((n) => n + 1); }}>刷新</Button>}>
    <PanelRow label={overview.configured ? "投放账户余额" : "未配置投放连接"} control={overview.configured && overview.balance == null ? "暂时无法读取余额" : money(overview.balance?.money)} />
    {overview.stopNewOrders?.stopped && <PanelRow label="新订单已暂停" control={<Button variant="secondary" size="sm" disabled={Boolean(pending)}
      onClick={() => setConfirmation({ title: "恢复新订单", body: "确认已核对账目差异后恢复投放。", run: () => mutate("stop", () => clearGeoMarketStop("Operator reviewed reconciliation in GEO operations."), (result) => result.cleared ? "已解除对账暂停" : "本次未解除暂停，请重新核对。") })}>恢复新订单</Button>} />}
    {overview.reconciliation && <PanelRow label={`最近对账 · ${overview.reconciliation.day}`} control={overview.reconciliation.status === "mismatch" ? `差额 ${money(overview.reconciliation.diff)}` : "已核对"} />}
    <div className="p-4">
      <Tabs label="循证传播投放管理" value={view} onChange={changeView} items={[
        { value: "unknown", label: "待确认订单", count: overview.counts?.unknownOrders },
        { value: "problems", label: "问题订单", count: overview.counts?.problemOrders },
        { value: "topups", label: "充值记录", count: overview.counts?.requestedTopups }, { value: "settlement", label: "月度结算" },
      ]} />
      {notice && <p role="status" className="mt-3 text-caption text-text-2">{notice}</p>}
      {actionError && <p role="alert" className="mt-3 text-caption text-error">{actionError}</p>}
      {view === "settlement" && <div className="mt-4 flex items-end gap-4"><Input label="结算月份" type="month" value={month} onChange={(event) => { setMonth(event.target.value); setCursor(null); }} />
        <span className="text-caption text-text-3">{overview.timeZone}</span></div>}
      {(view === "unknown" || view === "problems") && <DataTable label="投放订单" rows={orders} rowKey={(row) => row.id} {...tableCommon} columns={[
        { key: "article", header: "文章", rowHeader: true, cell: (row) => row.articleTitle || "未命名文章" },
        { key: "media", header: "媒体", cell: (row) => row.mediaName || row.mediaDomain || "—" },
        { key: "vendor", header: "平台订单号", cell: (row) => row.vendorOrderNid ?? "待确认", isEmpty: (row) => !row.vendorOrderNid },
        { key: "project", header: "项目", cell: (row) => row.projectLabel ?? row.geoProjectId },
        { key: "amount", header: "预留金额", align: "right", cell: (row) => money(row.reserveCny) },
        { key: "spent", header: "已记账 / 订单金额", align: "right", cell: (row) => money(row.settledCny ?? row.priceCny), isEmpty: (row) => view === "unknown" || (row.settledCny == null && row.priceCny == null) },
        { key: "reason", header: "核对事项", cell: (row) => row.refundSeenAt ? "退款标记待核实到账" : reasonLabels[row.stateReason ?? ""] ?? "订单状态需核对", isEmpty: () => view === "unknown" },
        { key: "action", header: "处理", cell: (row) => row.canResolve
          ? <Button size="sm" variant="secondary" disabled={Boolean(pending)} onClick={() => { setEditing({ order: row, kind: "resolve" }); setField(""); }}>核对订单</Button>
          : row.canMarkLost ? <Button size="sm" variant="text" disabled={Boolean(pending)} onClick={() => { setEditing({ order: row, kind: "lost" }); setField(""); }}>记为损失</Button> : "待核对" },
      ]} />}
      {editing && <div className="mt-4 flex flex-wrap items-end gap-3"><p className="w-full text-caption text-text-2">{editing.order.articleTitle || "未命名文章"} · {editing.order.vendorOrderNid || "订单待确认"}</p><Input label={editing.kind === "resolve" ? "平台订单号" : "损失原因"} value={field} maxLength={editing.kind === "resolve" ? 80 : 300} onChange={(event) => setField(event.target.value)} />
        {editing.kind === "resolve" ? <>
          <Button size="sm" disabled={!overview.configured || Boolean(pending) || !/^[A-Za-z0-9_-]{1,80}$/.test(field)} onClick={() => void mutate(editing.order.id, () => resolveGeoMarketOrder(editing.order.id, { created: true, vendorOrderNid: field }), (result) => result.state === "submitted" ? "订单已核对" : "状态尚未更新，请重新核对。")}>已找到订单</Button>
          <Button size="sm" variant="secondary" disabled={Boolean(pending)} onClick={() => setConfirmation({ title: "确认未创建订单", body: "确认供应商没有创建该订单，将释放对应的预留金额。", run: () => mutate(editing.order.id, () => resolveGeoMarketOrder(editing.order.id, { created: false }), (result) => result.state === "cancelled" ? "已记录未创建订单" : "状态尚未更新，请重新核对。") })}>确认未创建</Button>
        </> : <Button size="sm" disabled={Boolean(pending) || !field.trim()} onClick={() => setConfirmation({ title: "将订单记为损失", body: `订单 ${editing.order.vendorOrderNid} 将按当前记录 ${money(editing.order.settledCny ?? editing.order.priceCny ?? editing.order.reserveCny)} 记为损失；已结算金额不会重复扣计。`, run: () => mutate(editing.order.id, () => markGeoMarketOrderLost(editing.order.id, field.trim()), (result) => result.state === "lost" ? "已记录损失" : "状态尚未更新，请重新核对。") })}>确认记损</Button>}
        <Button size="sm" variant="text" onClick={() => setEditing(null)}>取消</Button>
      </div>}
      {view === "topups" && <DataTable label="充值记录" rows={topups} rowKey={(row) => row.id} {...tableCommon} columns={[
        { key: "date", header: "申请时间", cell: (row) => row.requestedAt.slice(0, 10) },
        { key: "amount", header: "金额", align: "right", cell: (row) => money(row.amountCny) },
        { key: "status", header: "状态", cell: (row) => topupLabels[row.status] },
        { key: "action", header: "处理", cell: (row) => row.status === "requested" && <Button size="sm" variant="secondary" disabled={!overview.configured || Boolean(pending)}
          onClick={() => void mutate(row.id, async () => confirmGeoMarketTopup(row.id), (result) => result.status === "awaiting_balance" ? "尚未核实到账" : "已核实到账")}>核对到账</Button> },
      ]} />}
      {view === "settlement" && <>
        {statement && <dl className="my-4 grid grid-cols-2 gap-3 text-caption sm:grid-cols-3">
          {[ ["净结算支出", statement.summary.netSettledCny], ["结算支出", statement.summary.settledCny], ["已到账退款", statement.summary.refundedCny],
            ["充值到账", statement.summary.topupConfirmedCny], ["申请充值", statement.summary.topupRequestedCny], ["本月预留", statement.summary.reservedDuringPeriodCny],
            ["本月释放预留", statement.summary.releasedDuringPeriodCny], ["调整", statement.summary.adjustmentCny],
          ].map(([label, amount]) => <div key={label}><dt className="text-text-3">{label}</dt><dd data-testid={label === "净结算支出" ? "geo-net-settled" : undefined} className="mt-1 tabular-nums text-text">{money(Number(amount))}</dd></div>)}
          <div><dt className="text-text-3">预算变更</dt><dd className="mt-1 text-text">{statement.summary.budgetChangeCount} 次</dd></div>
        </dl>}
        <DataTable label="月度结算明细" rows={statement?.entries ?? []} rowKey={(row) => row.id} {...tableCommon} columns={[
          { key: "date", header: "记账时间", cell: (row) => new Date(row.createdAt).toLocaleString("zh-CN", { timeZone: overview.timeZone }) },
          { key: "kind", header: "类别", cell: (row) => flowLabels[row.kind] ?? row.kind },
          { key: "amount", header: "金额", align: "right", cell: (row) => money(row.amountCny) },
          { key: "note", header: "说明", cell: (row) => row.note ?? "—", isEmpty: (row) => !row.note },
        ]} footnote={statement ? `本月共 ${statement.summary.entryCount} 笔记录；汇总包含整月，明细按页显示。` : undefined} />
        {statement && statement.reconciliations.length > 0 && <DataTable label="对账观察" rows={statement.reconciliations} rowKey={(row) => row.day} columns={[
          { key: "day", header: "观察时间", cell: (row) => new Date(row.observedAt).toLocaleString("zh-CN", { timeZone: overview.timeZone }) }, { key: "balance", header: "当时余额", cell: (row) => money(row.balance) },
          { key: "status", header: "核对结果", cell: (row) => row.clearedAt ? "已处理差异" : row.status === "mismatch" ? "存在差异" : "已核对" },
        ]} />}
      </>}
      {!loading && !listError && <div className="mt-3 flex gap-2">
        {cursor && <Button size="sm" variant="text" onClick={() => pageTo(null)}>回到首页</Button>}
        {nextCursor && <Button size="sm" variant="secondary" onClick={() => pageTo(nextCursor)}>下一页</Button>}
      </div>}
    </div>
    {confirmation && <ConfirmDialog title={confirmation.title} body={confirmation.body} confirmLabel="确认" onCancel={() => setConfirmation(null)}
      onConfirm={() => { const current = confirmation; setConfirmation(null); void current.run(); }} />}
  </Panel>;
}
