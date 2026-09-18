import { useEffect, useState } from "react";
import { webErrorMessage, fetchWebAccountUsage, type WebUsageSummary } from "@/lib/apiClient";
import { Card } from "@/components/ui/Card";
import { useOperator } from "@/lib/useOperator";

/**
 * What this account has spent this month.
 *
 * This release is a nonpaid service. Converted cost remains visible because it
 * drives the enforced safety budget and lets the researcher understand usage.
 */
export function UsageCard() {
  const operator = useOperator();
  const [usage, setUsage] = useState<WebUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWebAccountUsage()
      .then((value) => {
        if (active) setUsage(value);
      })
      .catch((err) => {
        if (active) setError(webErrorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  const month = usage ? new Date(usage.since).toLocaleDateString("zh-CN", { year: "numeric", month: "long" }) : "";

  return (
    <Card
      className="mt-5"
      title="本月用量"
      hint={usage ? `统计自 ${month}，按模型供应商价目折算；首发阶段不收款。` : "统计本月的模型调用与额度占用；首发阶段不收款。"}
    >
      {error && <p className="text-ui text-error">读取用量失败：{error}</p>}
      {!error && !usage && <p className="text-ui text-muted">正在读取…</p>}
      {usage && (
        <div>
          {/* Stacked on a phone: three title-rung numbers side by side did not
              fit a 390 px screen (review B, UsageCard). */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Figure label="调用次数" value={usage.calls.toLocaleString("zh-CN")} />
            <Figure label="读入量（token）" value={usage.promptTokens.toLocaleString("zh-CN")} />
            <Figure label="生成量（token）" value={usage.completionTokens.toLocaleString("zh-CN")} />
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <Figure label={`折算金额（${usage.currency}）`} value={usage.cost.toFixed(2)} />
          </div>
          {/* Per model, for an operator: one model serves every run on this
              deployment, and a model id is an engine internal a researcher's
              bill does not need (DESIGN.md: no model names in the body). */}
          {operator && usage.byModel.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1">
              {usage.byModel.map((row) => (
                <li key={row.model} className="flex items-baseline justify-between text-caption text-muted">
                  <span className="font-mono">{row.model}</span>
                  <span className="tabular-nums">
                    {row.calls} 次 · {row.cost.toFixed(2)} {usage.currency}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* A zero that means "free" and a zero that means "we do not know the
              price" are different answers, so the second one says so. */}
          {usage.unpricedCalls > 0 && (
            <p className="mt-3 text-caption text-warn">
              其中 {usage.unpricedCalls} 次调用的模型不在价目表里，已计次但未计价。
            </p>
          )}
          {(usage.reservedCalls ?? 0) > 0 && (
            <p className="mt-3 text-caption text-muted">另有 {usage.reservedCalls} 次调用已预留额度，等待完成。</p>
          )}
          {(usage.uncertainCalls ?? 0) > 0 && (
            <p className="mt-3 text-caption text-warn">
              {usage.uncertainCalls} 次调用的实际用量还在核对，先按预估的 {Number(usage.reservedCost ?? 0).toFixed(2)} {usage.currency} 计入额度，核对后自动更正。
            </p>
          )}
          <p className="mt-3 text-caption text-muted">折算金额仅用于额度保护和成本透明，不是账单，也不会触发收款。</p>
          {usage.calls === 0 && <p className="mt-3 text-caption text-muted">本月还没有模型调用。</p>}
        </div>
      )}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-caption text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-title tabular-nums text-text">{value}</div>
    </div>
  );
}
