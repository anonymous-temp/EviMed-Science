import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { cancelGeoOrder, getGeoDistribution, type GeoDistribution, type GeoOrder, type GeoProject } from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { GEO_ORDER_CANCELLABLE, layerName, monthDay, orderStateWord } from "../geoText";
import { BudgetDialog } from "./BudgetDialog";
import { StepPending, TabError, TabSection, TabSkeleton, TD, TH, useGeoLoad } from "./geoTabKit";
import { yuan } from "./geoTabText";

/**
 * 投放 (plan §3.7, mockup g10). The budget is the program's one money stop:
 * until it is set the tab asks for it, with the tier's suggestion prefilled;
 * after that the control plane places orders within it. The orders list says
 * where each article went and where it stands; 「撤单」 is offered only while
 * the outlet has not accepted it yet. While the marketplace is not connected
 * the tab says so once, and everything else still shows.
 */
export function DistributionTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`distribution:${geoId}`, () => getGeoDistribution(geoId));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  return <Distribution geoId={geoId} project={project} data={state.data} onChanged={reload} />;
}

function Distribution({ geoId, project, data, onChanged }: { geoId: string; project: GeoProject; data: GeoDistribution; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const orders = (Array.isArray(data?.orders) ? data.orders : []).filter((order) => order && order.id);
  const budget = data?.budget && typeof data.budget.totalCny === "number" ? data.budget : null;
  const configured = data?.market?.configured !== false;

  return (
    <div data-geo-tab="distribution">
      {!configured && <p data-geo-market-off="" className="mb-4 text-ui text-text-3">投放渠道未接通</p>}
      <BudgetLine data={data} budget={budget} onEdit={() => setEditing(true)} />
      {orders.length > 0
        ? <Orders geoId={geoId} orders={orders} onChanged={onChanged} />
        : budget && <StepPending geoId={geoId} project={project} step="distribution" />}
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
  onEdit: () => void;
}) {
  if (!budget) {
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
        <div aria-hidden="true" className="relative h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-2">
          <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: share(spent) }} />
          <span className="absolute inset-y-0 bg-border-control" style={{ left: share(spent), width: share(reserved) }} />
        </div>
        <Button variant="text" size="sm" onClick={onEdit}>修改</Button>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption text-text-3">{label}</span>
      <span className="text-ui font-semibold tabular-nums text-text">{value}</span>
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
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "没有撤单，请稍后重试。" })))
      .finally(() => setBusy(null));
  };
  const sorted = [...orders].sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "") || 0);

  return (
    <TabSection title="订单" meta={`${orders.length} 单`} className="mt-8">
      <div className="overflow-x-auto">
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
                      <a href={href} target="_blank" rel="noreferrer" className="inline-flex h-6 items-center gap-1 rounded px-2 text-ui text-accent hover:bg-surface-2">
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
      </div>
      {pending && (
        <ConfirmDialog
          title={`撤下「${pending.articleTitle || "这一单"}」？`}
          body={`这一单还没有被${pending.media || "媒体"}接单，撤单后不会发布，预留的钱退回预算。`}
          confirmLabel="撤单"
          onConfirm={cancel}
          onCancel={() => setPending(null)}
        />
      )}
    </TabSection>
  );
}
