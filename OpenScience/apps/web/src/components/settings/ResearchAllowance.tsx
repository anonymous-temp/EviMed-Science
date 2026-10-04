import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import {
  fetchWebResearchStatements, fetchWebAccountUsage,
  webErrorMessage, type WebResearchAllowance, type WebResearchStatement, type WebResearchStatements, type WebUsageSummary,
} from "@/lib/apiClient";
import { formatCny, formatDateTime } from "@/lib/format";
import { useOperator } from "@/lib/useOperator";
import { allowanceSimulated } from "@/lib/useResearchBilling";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { Button, buttonClasses } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { AllowanceAmount, CommerceLink, commerceHref, SimulatedAllowanceNotice, SimulatedDataLine, SimulatedMark } from "./SimulatedAllowance";

const money = (value: number | null | undefined) => formatCny(value) || "暂不可用";
const membershipLabels: Record<string, string> = { active: "有效", canceled: "已取消", cancelled: "已取消", expired: "已到期", inactive: "未开通", pending: "待生效" };
const statusLabels = { pending: "待结算", settled: "已结算", failed: "结算失败", waived: "免收" };
/** The four commerce destinations, in the order their rows are drawn. */
const COMMERCE = [["rechargeUrl", "充值"], ["membershipUrl", "会员"], ["ordersUrl", "订单"], ["refundsUrl", "退款"]] as const;

/**
 * 「科研额度」 in 设置: the allowance, the month's research spend and its
 * statements, for a deployment that bills research. The allowance is the
 * deployment's answer, read once for the tab, the section and the chat frame
 * (`useResearchBilling`) and handed in here; a deployment without billing never
 * gets this page, and shows `MonthlyUsage` instead (`UsageSection` picks).
 *
 * What is not there is not drawn. A commerce row exists only for a destination
 * the control plane named, and the group only when it has a row: four rows
 * reading 「尚未开放」 were a page presenting a checkout the deployment does not
 * have. And a month the ledger could not be read for (`month: null`) has no
 * spend rows and no statement list — unknown is not zero, and the status row
 * already says the allowance cannot be read.
 *
 * Where the wallet is simulated (`allowanceSimulated`) the section opens with
 * the line that says so, every amount carries the mark, and a low or used-up
 * allowance is prompted (`SimulatedAllowance`). A wallet that is not simulated
 * shows none of it.
 */
export function ResearchAllowance({ allowance }: { allowance: WebResearchAllowance }) {
  const operator = useOperator();
  const simulated = allowanceSimulated(allowance);
  const month = allowance.enabled ? allowance.month : null;
  const commerce = COMMERCE.flatMap(([key, label]) => {
    const href = commerceHref(allowance.commerce[key]);
    return href ? [{ key, label, href }] : [];
  });
  return <div className="space-y-8">
    {simulated && <div className="space-y-3">
      <SimulatedDataLine />
      <SimulatedAllowanceNotice allowance={allowance} />
    </div>}
    <Panel title="科研额度">
      {allowance.status !== "ready" ? <PanelRow label={{ disabled: "科研额度尚未启用", unavailable: "科研额度暂不可用", unlinked: "尚未关联科研额度账户", ready: "" }[allowance.status]} /> : <>
        <PanelRow label="可用科研额度" control={<AllowanceAmount value={allowance.available} simulated={simulated} className="text-title font-semibold" />} />
        {allowance.held !== null && <PanelRow label="占用额度" control={<AllowanceAmount value={allowance.held} simulated={simulated} />} />}
        {allowance.balances && ([['paid', '充值额度'], ['member', '会员额度'], ['promotional', '赠送额度']] as const).map(([key, label]) => allowance.balances?.[key] != null && <PanelRow key={key} label={label} control={<AllowanceAmount value={allowance.balances[key]} simulated={simulated} />} />)}
      </>}
      {month && <PanelRow label="本月研究消费" control={<AllowanceAmount value={month.paid} simulated={simulated} />} />}
      {month && month.pending > 0 && <PanelRow label="本月待结算" control={<AllowanceAmount value={month.pending} simulated={simulated} />} />}
    </Panel>
    {(allowance.membership || commerce.length > 0) && <Panel title="充值与会员" action={simulated ? <SimulatedMark /> : undefined}>
      {allowance.membership && <PanelRow label={allowance.membership.name} description={allowance.membership.expiresAt ? `有效期至 ${formatDateTime(allowance.membership.expiresAt, { year: 'numeric', month: 'long', day: 'numeric' })}` : undefined} control={membershipLabels[allowance.membership.status] || "状态暂不可用"} />}
      {commerce.map(({ key, label, href }) => <PanelRow key={key} label={label} control={<CommerceLink href={href} className={buttonClasses({ variant: 'text' })}>查看{label}</CommerceLink>} />)}
    </Panel>}
    {month && <StatementList simulated={simulated} />}
    {operator && <PlatformCost />}
  </div>;
}

function StatementList({ simulated }: { simulated: boolean }) {
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
      {/* A row says for itself whether its wallet is simulated. One that does not is read by what the list says, and then by the allowance these are the statements of. */}
      {page.items.map((item) => <StatementRow key={item.id} item={item} simulated={(item.simulated ?? page.simulated ?? simulated) === true} />)}
    </List>}
    {error && <LoadError message={error} onRetry={() => load(page?.nextCursor ?? undefined)} />}
    {page?.nextCursor && !error && <div className="mt-3"><Button variant="secondary" loading={loading} onClick={() => load(page.nextCursor ?? undefined)}>加载更多</Button></div>}
  </section>;
}

/**
 * One line of the statement: a research task charged against the allowance, or
 * credits going in (a simulated top-up, the simulated starting grant).
 *
 * A charge opens the conversation it was spent in and shows its amount once it
 * is settled. Credits going in are drawn with a plus sign and 「已入账」, and
 * open nothing: no research produced them. A row of a simulated wallet carries
 * the mark beside its amount, whichever it is; the status and amount keep one
 * column width, so the marks line up down the list.
 */
function StatementRow({ item, simulated }: { item: WebResearchStatement; simulated: boolean }) {
  const credit = item.kind === "topup" || item.kind === "grant";
  const date = item.at ? formatDateTime(item.at, { month: 'long', day: 'numeric' }) : '';
  const added = formatCny(item.amount);
  const amount = credit ? (added ? `+${added}` : "") : item.status === 'settled' ? money(item.amount) : "";
  return <ListRow title={item.title || (credit ? "额度入账" : '未命名的研究')}
    to={!credit && item.runId ? `/app/runs?run=${encodeURIComponent(item.runId)}` : undefined}
    meta={[date, !credit && Number(item.waivedCny) > 0 ? `已减免 ${money(Number(item.waivedCny))}` : ''].filter(Boolean).join(' · ') || undefined}
    trailing={<>
      {simulated && <SimulatedMark />}
      <div className="min-w-20 text-right text-ui"><span className="block text-text-2">{credit ? "已入账" : statusLabels[item.status]}</span>{amount && <span className="tabular-nums">{amount}</span>}</div>
    </>} />;
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
