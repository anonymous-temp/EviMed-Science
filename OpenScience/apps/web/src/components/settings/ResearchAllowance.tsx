import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { expiryWords, formatCredits } from "@evimed/domain";
import {
  fetchWebResearchStatements, fetchWebResearchStatementDetail, fetchWebAccountUsage,
  webErrorMessage, type WebResearchAllowance, type WebResearchStatement, type WebResearchStatementDetail, type WebResearchStatements, type WebUsageSummary,
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
import { AllowanceAmount, CommerceLink, allowanceText, commerceHref, SimulatedAllowanceNotice, SimulatedDataLine, SimulatedMark } from "./SimulatedAllowance";

const money = (value: number | null | undefined) => formatCny(value) || "暂不可用";
const membershipLabels: Record<string, string> = { active: "有效", canceled: "已取消", cancelled: "已取消", expired: "已到期", inactive: "未开通", pending: "待生效" };
const statusLabels = { pending: "结算中", settled: "已结算", failed: "结算失败", waived: "未计费", absorbed: "平台承担" };
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
        <PanelRow label="可用科研额度" description={allowance.balances ? "充值 ＋ 赠送 − 冻结" : undefined} control={<AllowanceAmount value={allowance.available} simulated={simulated} className="text-title font-semibold" />} />
        {/* The platform's wallet says what it holds in each kind, and which of the gift ends next. EviMed's says one number, and a hold only if it reports one. */}
        {allowance.balances && <>
          <PanelRow label="充值" description="不会过期" control={<AllowanceAmount value={allowance.balances.purchased} simulated={simulated} />} />
          <PanelRow label="赠送" description={allowance.nextExpiry ? `其中 ${allowanceText(allowance.nextExpiry.amount)} 将于 ${expiryWords(allowance.nextExpiry.at)}到期` : undefined} control={<AllowanceAmount value={allowance.balances.gifted} simulated={simulated} />} />
        </>}
        {allowance.held !== null && (allowance.balances || Number(allowance.held) > 0) && <PanelRow label={allowance.balances ? "冻结" : "占用额度"} description={allowance.balances ? "正在进行的研究暂时占用，结束后按实际用量结算" : undefined} control={<AllowanceAmount value={allowance.held} simulated={simulated} />} />}
      </>}
      {month && <PanelRow label="本月研究消费" control={<AllowanceAmount value={month.paid} simulated={simulated} rounding="nearest" />} />}
      {month && month.pending > 0 && <PanelRow label="本月待结算" control={<AllowanceAmount value={month.pending} simulated={simulated} rounding="nearest" />} />}
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
 * credits going in (a top-up, a gift with its source and the date it ends) or
 * out (a gift that ended, an adjustment).
 *
 * A charge opens the conversation it was spent in and says, under its title, what
 * paid for it (赠送 and 充值 each), the balance after it, and — when it was not
 * charged, or the balance could not cover it — why and how much the platform
 * carried. 「明细」 opens, in place, what the charge is made of: how many model
 * calls, the tokens by kind, the price list and the amount to 8 decimals. Credits
 * going in are drawn with a plus sign and 「已入账」, and open nothing: no research
 * produced them. A row of a simulated wallet carries the mark beside its amount,
 * whichever it is; the status and amount keep one column width, so the marks line
 * up down the list.
 */
function StatementRow({ item, simulated }: { item: WebResearchStatement; simulated: boolean }) {
  const [open, setOpen] = useState(false);
  const kind = item.kind ?? "charge";
  const date = item.at ? formatDateTime(item.at, { month: 'long', day: 'numeric' }) : '';
  const balance = item.balanceAfter ? `余额 ${allowanceText(item.balanceAfter)}` : "";
  const label = kind === "topup" || kind === "grant" ? "已入账" : kind === "expire" ? "已到期" : kind === "adjust" ? "已调整" : statusLabels[item.status];
  const sign = kind === "topup" || kind === "grant" ? "+" : kind === "expire" ? "−" : "";
  const credit = kind !== "charge";
  const amount = credit ? allowanceText(item.amount, "nearest") : item.status === "settled" || item.status === "absorbed" ? allowanceText(item.amount, "nearest") : "";
  const paid = item.paidBy ? [["赠送", item.paidBy.gifted], ["充值", item.paidBy.purchased]]
    .filter(([, value]) => formatCredits(value) !== "0.00")
    .map(([name, value]) => `${name} ${allowanceText(value, "nearest")}`).join(" ＋ ") : "";
  const ends = kind === "grant" && item.expiresAt ? `${expiryWords(item.expiresAt)}到期` : "";
  const notes = [
    date, ends, paid, balance,
    item.status === "absorbed" && item.absorbed ? `平台承担 ${allowanceText(item.absorbed, "nearest")}` : "",
    item.status === "waived" && item.notChargedReason ? item.notChargedReason : "",
    kind === "charge" && item.status !== "waived" && Number(item.waivedCny) > 0 && !item.paidBy ? `已减免 ${money(Number(item.waivedCny))}` : "",
  ].filter(Boolean).join(' · ');
  const detailable = kind === "charge" && item.runId !== null && (item.status === "settled" || item.status === "absorbed");
  return <ListRow title={item.title || (credit ? "额度入账" : '未命名的研究')}
    to={!credit && item.runId ? `/app/runs?run=${encodeURIComponent(item.runId)}` : undefined}
    meta={<>{notes || undefined}{detailable && open && <StatementDetail id={item.id} />}</>}
    expanded={detailable ? open : undefined}
    actions={detailable ? <Button variant="text" size="sm" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "收起明细" : "查看明细"}</Button> : undefined}
    trailing={<>
      {simulated && <SimulatedMark />}
      <div className="min-w-20 text-right text-ui"><span className="block text-text-2">{label}</span>{amount && <span className="tabular-nums">{sign}{amount}</span>}</div>
    </>} />;
}

/** What one charge is made of, read when the line is opened and not before. */
function StatementDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<WebResearchStatementDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchWebResearchStatementDetail(id).then((next) => { if (live) setDetail(next); }, (caught) => { if (live) setError(webErrorMessage(caught)); });
    return () => { live = false; };
  }, [id]);
  if (error) return <p role="alert" className="mt-1 text-caption text-text-2">{error}</p>;
  if (!detail) return <p className="mt-1 text-caption text-text-3">正在读取明细</p>;
  const { detail: made } = detail;
  const count = (value: string | null) => value === null ? "—" : Number(value).toLocaleString("zh-CN");
  return <div className="mt-1 space-y-0.5 text-caption text-text-2">
    <p>{made.calls === null ? "模型调用次数未记录" : `${made.calls} 次模型调用`}{made.cacheHitTokens !== null && ` · 命中缓存输入 ${count(made.cacheHitTokens)} · 未命中输入 ${count(made.cacheMissTokens)} · 输出 ${count(made.outputTokens)} tokens`}</p>
    <p>{made.priceVersions.length > 0 && `价目表 ${made.priceVersions.join("、")} · `}金额 <span className="tabular-nums">{made.amount}</span>{Number(made.absorbed) > 0 && <> · 平台承担 <span className="tabular-nums">{made.absorbed}</span></>}</p>
  </div>;
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
