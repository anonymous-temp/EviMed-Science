import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { cancelGeoOrder, type GeoDistribution, type GeoOrder, type GeoOwnedLink, type GeoProject } from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { toast } from "@/lib/toast";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ScrollRegion } from "@/components/ui/ScrollRegion";
import { GEO_ORDER_CANCELLABLE, engineName, layerName, monthDay, orderStateWord, ownedPlatformName } from "../geoText";
import { BudgetDialog } from "./BudgetDialog";
import { StepPending, TabSection, TD, TH } from "./geoTabKit";
import { yuan } from "./geoTabText";

/** Whether there is anything to show: a market to place with, a budget, an order, or a page the brand published itself. */
export function hasDistribution(data: GeoDistribution | null | undefined): boolean {
  if (!data) return false;
  return data.market?.configured !== false
    || (data.budget != null && typeof data.budget.totalCny === "number")
    || (Array.isArray(data.orders) && data.orders.some((order) => order && order.id))
    || (Array.isArray(data.ownedLinks) && data.ownedLinks.some((link) => link && link.id));
}

/**
 * 投放 (plan §3.7, mockup g10). The budget is the program's one money stop:
 * until it is set the section asks for it, with the tier's suggestion
 * prefilled; after that the control plane places orders within it. The orders
 * list says where each article went and where it stands; “撤单” is offered only
 * while the outlet has not accepted it yet. While the marketplace is not
 * connected nothing can be placed and the section asks for nothing — no budget
 * button, no “等你” (G20); `ActionsTab` says why, under the stage counts, and
 * does not draw this section at all when there is nothing in it. Below the
 * orders, the pages the brand published itself (百家号, 公众号 …), which the
 * program checks after publication as it checks an order.
 */
export function Distribution({ geoId, project, data, onChanged }: { geoId: string; project: GeoProject; data: GeoDistribution; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const orders = (Array.isArray(data?.orders) ? data.orders : []).filter((order) => order && order.id);
  const ownedLinks = (Array.isArray(data?.ownedLinks) ? data.ownedLinks : []).filter((link) => link && link.id);
  const budget = data?.budget && typeof data.budget.totalCny === "number" ? data.budget : null;
  const configured = data?.market?.configured !== false;

  return (
    <div data-geo-tab="distribution">
      {(configured || budget) && <BudgetLine data={data} budget={budget} onEdit={configured ? () => setEditing(true) : null} />}
      {orders.length > 0
        ? <Orders geoId={geoId} orders={orders} onChanged={onChanged} />
        : budget && configured && <StepPending geoId={geoId} project={project} step="distribution" />}
      {ownedLinks.length > 0 && <OwnedLinks links={ownedLinks} />}
      {editing && (
        <BudgetDialog
          geoId={geoId}
          initial={budget}
          suggestedTotal={typeof data?.suggestedBudgetCny === "number" ? data.suggestedBudgetCny : null}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast.success("预算已设好，稿件会在预算内自动投放。");
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function BudgetLine({
  data,
  budget,
  onEdit,
}: {
  data: GeoDistribution;
  budget: { totalCny: number; dailyCny: number } | null;
  /** Null while there is no market to place with: the budget is shown, not asked for. */
  onEdit: (() => void) | null;
}) {
  if (!budget) {
    if (!onEdit) return null;
    return (
      <div data-geo-budget="unset" className="flex flex-wrap items-center gap-3 rounded-card bg-surface-1 px-5 py-4">
        <span className="min-w-0 flex-1 text-ui text-text">
          还没有设投放预算
          {typeof data.suggestedBudgetCny === "number" && data.suggestedBudgetCny > 0 && (
            <span className="ml-2 text-caption text-text-3">{`建议 ${yuan(data.suggestedBudgetCny)}`}</span>
          )}
        </span>
        <Button onClick={onEdit}>设置投放预算</Button>
      </div>
    );
  }
  const spent = typeof data.spentCny === "number" ? data.spentCny : 0;
  const reserved = typeof data.reservedCny === "number" ? data.reservedCny : 0;
  const share = (value: number) => `${Math.max(0, Math.min(100, (value / budget.totalCny) * 100))}%`;
  return (
    <div data-geo-budget="set" className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-card bg-surface-1 px-5 py-4">
      <Figure label="预算" value={yuan(budget.totalCny)} />
      <Figure label="已花" value={yuan(spent)} />
      <Figure label="已预留" value={yuan(reserved)} />
      <Figure label="每天最多" value={yuan(budget.dailyCny)} />
      <div className="flex min-w-40 flex-1 items-center gap-3">
        {/* Money against the budget: spent solid, reserved the quiet step after it. */}
        <div aria-hidden="true" data-forced-colors="preserve" className="relative h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-2">
          <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: share(spent) }} />
          <span className="absolute inset-y-0 bg-border-control" style={{ left: share(spent), width: share(reserved) }} />
        </div>
        {onEdit && <Button variant="text" size="sm" onClick={onEdit}>修改</Button>}
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption text-text-3">{label}</span>
      <span className="text-ui tabular-nums text-text">{value}</span>
    </div>
  );
}

function Orders({ geoId, orders, onChanged }: { geoId: string; orders: GeoOrder[]; onChanged: () => void }) {
  const [pending, setPending] = useState<GeoOrder | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cancel = () => {
    const order = pending;
    if (!order) return;
    setPending(null);
    setBusy(order.id);
    void cancelGeoOrder(geoId, order.id)
      .then(() => {
        toast.success("已撤单，预留的钱会退回预算。");
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这一单无法撤下，请稍后重试。" })))
      .finally(() => setBusy(null));
  };
  const sorted = [...orders].sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "") || 0);

  return (
    <TabSection title="订单" meta={`${orders.length} 单`} className="mt-8">
      <ScrollRegion label="订单" className="relative">
        <table className="w-full min-w-[44rem] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={`${TH} sticky left-0 bg-bg`}>媒体</th>
              <th scope="col" className={TH}>稿件</th>
              <th scope="col" className={`${TH} text-right`}>价格</th>
              <th scope="col" className={TH}>状态</th>
              <th scope="col" className={`${TH} text-right`}>日期</th>
              <th scope="col" className={TH}><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((order) => {
              const href = safeWebHref(order.publishedUrl);
              const cancellable = GEO_ORDER_CANCELLABLE.has(order.state);
              return (
                <tr key={order.id} data-geo-order={order.id} className="border-b border-faint">
                  <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>
                    <span className="block">{order.media || order.domain || "—"}</span>
                    {order.media && order.domain && <span className="block text-caption text-text-3">{order.domain}</span>}
                  </th>
                  <td className={TD}>
                    <span className="block">{order.articleTitle || "—"}</span>
                    {order.layer && layerName(order.layer) !== "—" && <span className="block text-caption text-text-3">{layerName(order.layer)}</span>}
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>{yuan(order.priceCny)}</td>
                  <td className={TD} data-geo-order-state={order.state}>{orderStateWord(order.state)}</td>
                  <td className={`${TD} text-right tabular-nums text-text-2`}>{monthDay(order.updatedAt) ?? "—"}</td>
                  <td className={`${TD} w-24 whitespace-nowrap text-right`}>
                    {href && (
                      <a href={href} target="_blank" rel="noreferrer" className={buttonClasses({ variant: "text", size: "sm", className: "text-accent hover:text-accent" })}>
                        查看
                        <ExternalLink size={16} aria-hidden="true" />
                      </a>
                    )}
                    {cancellable && (
                      <Button variant="text" size="sm" loading={busy === order.id} onClick={() => setPending(order)}>撤单</Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      {pending && (
        <ConfirmDialog
          title={`撤下“${pending.articleTitle || "这一单"}”？`}
          body={`这一单还没有被${pending.media || "媒体"}接单，撤单后不会发布，预留的钱退回预算。`}
          confirmLabel="撤单"
          onConfirm={cancel}
          onCancel={() => setPending(null)}
        />
      )}
    </TabSection>
  );
}

/** The pages the brand published itself: where, what, which engines cite it, since when. */
function OwnedLinks({ links }: { links: GeoOwnedLink[] }) {
  return (
    <TabSection title="自有发布" meta={`${links.length} 条`} className="mt-8">
      <ScrollRegion label="自有发布" className="relative">
        <table className="w-full min-w-[44rem] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={`${TH} sticky left-0 bg-bg`}>平台</th>
              <th scope="col" className={TH}>标题</th>
              <th scope="col" className={TH}>被 AI 引用</th>
              <th scope="col" className={`${TH} text-right`}>发布日期</th>
              <th scope="col" className={TH}><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => {
              const href = safeWebHref(link.url);
              const cited = Array.isArray(link.citedBy) ? link.citedBy : [];
              return (
                <tr key={link.id} data-geo-owned-link={link.id} className="border-b border-faint">
                  <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>{ownedPlatformName(link.platform)}</th>
                  <td className={TD}>
                    <span className="block">{link.title || "—"}</span>
                    {link.status === "retired" && <span className="block text-caption text-text-3">已下线</span>}
                  </td>
                  <td className={`${TD} text-text-2`}>{cited.length ? cited.map((entry) => engineName(entry.engine)).join("、") : "—"}</td>
                  <td className={`${TD} text-right tabular-nums text-text-2`}>{monthDay(link.publishedAt) ?? "—"}</td>
                  <td className={`${TD} w-24 whitespace-nowrap text-right`}>
                    {href && (
                      <a href={href} target="_blank" rel="noreferrer" className={buttonClasses({ variant: "text", size: "sm", className: "text-accent hover:text-accent" })}>
                        查看
                        <ExternalLink size={16} aria-hidden="true" />
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
    </TabSection>
  );
}
