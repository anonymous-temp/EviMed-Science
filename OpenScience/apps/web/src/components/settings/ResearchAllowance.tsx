import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import {
  fetchWebResearchStatements, fetchWebAccountUsage,
  webErrorMessage, type WebResearchAllowance, type WebResearchStatements, type WebUsageSummary,
} from "@/lib/apiClient";
import { formatCny, formatDateTime } from "@/lib/format";
import { useOperator } from "@/lib/useOperator";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { Button, buttonClasses } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Panel, PanelRow } from "@/components/ui/Panel";

const money = (value: number | null | undefined) => formatCny(value) || "暂不可用";
const membershipLabels: Record<string, string> = { active: "有效", canceled: "已取消", cancelled: "已取消", expired: "已到期", inactive: "未开通", pending: "待生效" };
const statusLabels = { pending: "待结算", settled: "已结算", failed: "结算失败", waived: "免收" };

/** Commerce destinations must be real configured web pages, never placeholder checkout. */
function commerceHref(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? value : null;
  } catch { return null; }
}

/**
 * 「科研额度」 in 设置: the allowance, the month's research spend and its
 * statements, for a deployment that bills research. The allowance is the
 * deployment's answer, read once for the tab, the section and the chat frame
 * (`useResearchBilling`) and handed in here; a deployment without billing never
 * gets this page, and shows `MonthlyUsage` instead (`UsageSection` picks).
 */
export function ResearchAllowance({ allowance }: { allowance: WebResearchAllowance }) {
  const operator = useOperator();
  return <div className="space-y-8">
    <Panel title="科研额度">
      {allowance.status !== "ready" ? <PanelRow label={{ disabled: "科研额度尚未启用", unavailable: "科研额度暂不可用", unlinked: "尚未关联科研额度账户", ready: "" }[allowance.status]} /> : <>
        <PanelRow label="可用科研额度" control={<span className="text-title font-semibold tabular-nums">{money(allowance.available)}</span>} />
        {allowance.held !== null && <PanelRow label="占用额度" control={<span className="tabular-nums">{money(allowance.held)}</span>} />}
        {allowance.balances && ([['paid', '充值额度'], ['member', '会员额度'], ['promotional', '赠送额度']] as const).map(([key, label]) => allowance.balances?.[key] != null && <PanelRow key={key} label={label} control={<span className="tabular-nums">{money(allowance.balances[key])}</span>} />)}
      </>}
      {allowance.enabled && <PanelRow label="本月研究消费" control={<span className="tabular-nums">{money(allowance.month.paid)}</span>} />}
      {allowance.enabled && allowance.month.pending > 0 && <PanelRow label="本月待结算" control={<span className="tabular-nums">{money(allowance.month.pending)}</span>} />}
    </Panel>
    <Panel title="充值与会员">
      {allowance.membership && <PanelRow label={allowance.membership.name} description={allowance.membership.expiresAt ? `有效期至 ${formatDateTime(allowance.membership.expiresAt, { year: 'numeric', month: 'long', day: 'numeric' })}` : undefined} control={membershipLabels[allowance.membership.status] || "状态暂不可用"} />}
      {([['rechargeUrl', '充值'], ['membershipUrl', '会员'], ['ordersUrl', '订单'], ['refundsUrl', '退款']] as const).map(([key, label]) => {
        const href = commerceHref(allowance.commerce[key]);
        return <PanelRow key={key} label={label} control={href ? <a href={href} rel="noreferrer" className={buttonClasses({ variant: 'text' })}>查看{label}</a> : <span className="text-text-3">尚未开放</span>} />;
      })}
    </Panel>
    {allowance.enabled && <StatementList />}
    {operator && <PlatformCost />}
  </div>;
}

function StatementList() {
  const [page, setPage] = useState<WebResearchStatements | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback((cursor?: string) => {
    setError(null);
    setLoading(true);
    fetchWebResearchStatements(cursor).then((next) => {
      setPage((previous) => ({ ...next, items: cursor && previous ? [...previous.items, ...next.items.filter((item) => !previous.items.some((old) => old.id === item.id))] : next.items }));
    }, (caught) => setError(webErrorMessage(caught))).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  return <section aria-label="研究消费明细">
    <h2 className="mb-2 text-ui font-semibold">研究消费明细</h2>
    {page === null && !error ? <RunsSkeleton filter={false} /> : page?.items.length === 0 ? <EmptyState icon={Gauge} title="还没有研究消费记录" /> : page && <List label="研究消费记录" divided>
      {page.items.map((item) => <ListRow key={item.id} title={item.title || '未命名的研究'} to={item.runId ? `/app/runs?run=${encodeURIComponent(item.runId)}` : undefined}
        meta={[item.at ? formatDateTime(item.at, { month: 'long', day: 'numeric' }) : '', Number(item.waivedCny) > 0 ? `已减免 ${money(Number(item.waivedCny))}` : ''].filter(Boolean).join(' · ') || undefined}
        trailing={<div className="text-right text-ui"><span className="block text-text-2">{statusLabels[item.status]}</span>{item.status === 'settled' && <span className="tabular-nums">{money(item.amount)}</span>}</div>} />)}
    </List>}
    {error && <LoadError message={error} onRetry={() => load(page?.nextCursor ?? undefined)} />}
    {page?.nextCursor && !error && <div className="mt-3"><Button variant="secondary" loading={loading} onClick={() => load(page.nextCursor ?? undefined)}>加载更多</Button></div>}
  </section>;
}

function PlatformCost() {
  const [usage, setUsage] = useState<WebUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    fetchWebAccountUsage().then(setUsage, (caught) => setError(webErrorMessage(caught)));
  }, []);
  useEffect(() => { load(); }, [load]);
  return <Panel title="平台运行成本">
    {error ? <PanelRow label={<span role="alert">{error}</span>} control={<Button variant="text" onClick={load}>重试</Button>} />
      : <PanelRow label="供应商成本估算" description="含后台运行开销，仅供运营参考。" control={<span className="tabular-nums">{usage ? money(usage.cost) : '正在读取'}</span>} />}
  </Panel>;
}
