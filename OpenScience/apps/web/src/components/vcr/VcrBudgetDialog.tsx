import { useState } from "react";
import { confirmVcrBudget, type VcrStudy } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/Input";
import { numberText } from "./vcrText";

/**
 * The second of the three places a human is required to stop: more compute
 * than this study's budget (plan §10.1).
 *
 * It is one confirmation per study and not one per job — a large simulation
 * costs real money, and asking about every replicate batch would be the kind
 * of standing confirmation this module exists to remove. What is already
 * spent is shown beside the ceiling, because a number to raise is not
 * meaningful without the number it is being raised from.
 */
export function VcrBudgetDialog({
  studyId,
  budget,
  onClose,
  onSaved,
}: {
  studyId: string;
  budget: VcrStudy["budget"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [limit, setLimit] = useState(budget?.limitCny != null ? String(budget.limitCny) : "");
  const [busy, setBusy] = useState(false);
  const parsed = Number.parseFloat(limit);
  const valid = Number.isFinite(parsed) && parsed >= 0;

  const save = () => {
    if (!valid || busy) return;
    setBusy(true);
    void confirmVcrBudget(studyId, { limitCny: parsed })
      .then(() => { toast.success("计算预算已更新。"); onSaved(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "预算暂时无法设定，请稍后重试。" })))
      .finally(() => setBusy(false));
  };

  return (
    <Drawer
      title="计算预算"
      onClose={onClose}
      widthClassName="max-w-md"
      actions={<Button loading={busy} disabled={!valid} onClick={save}>确认</Button>}
    >
      <div data-vcr-budget="" className="flex flex-col gap-4">
        <dl className="divide-y divide-border rounded-card border border-border">
          <div className="flex items-baseline justify-between gap-4 px-3 py-2">
            <dt className="text-caption text-text-3">已用</dt>
            <dd className="text-ui tabular-nums text-text">{`¥ ${numberText(budget?.spentCny ?? 0, 2)}`}</dd>
          </div>
          {budget?.pendingCny != null && (
            <div className="flex items-baseline justify-between gap-4 px-3 py-2">
              <dt className="text-caption text-text-3">排队中的计算需要</dt>
              <dd className="text-ui tabular-nums text-warn-strong">{`¥ ${numberText(budget.pendingCny, 2)}`}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-4 px-3 py-2">
            <dt className="text-caption text-text-3">当前上限</dt>
            <dd className="text-ui tabular-nums text-text">
              {budget?.limitCny != null ? `¥ ${numberText(budget.limitCny, 2)}` : "未设定"}
            </dd>
          </div>
        </dl>
        <Input
          label="新的上限（元）"
          type="number"
          min={0}
          step="1"
          inputMode="decimal"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        />
        <p className="text-caption text-text-3">
          超出上限的仿真会排队等待，不会被静默降级：已经算完的部分保留，研究页上显示还差多少。
        </p>
      </div>
    </Drawer>
  );
}
