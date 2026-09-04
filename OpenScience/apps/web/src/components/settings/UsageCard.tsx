import { useEffect, useState } from "react";
import { fetchWebAccountUsage, type WebUsageSummary } from "@/lib/apiClient";
import { Card } from "@/components/ui/Card";

/**
 * What this account has spent this month.
 *
 * The platform priced model calls long before it counted them; this is the
 * count, shown to the person it is charged to. It is deliberately a statement
 * and not a bill: there is no balance yet, and presenting one would imply a
 * limit that nothing enforces.
 */
export function UsageCard() {
  const [usage, setUsage] = useState<WebUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWebAccountUsage()
      .then((value) => {
        if (active) setUsage(value);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
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
      hint={usage ? `统计自 ${month}，按 DeepSeek 峰谷价折算；谷时为五折。` : "统计本月的模型调用与折算金额。"}
    >
      {error && <p className="text-ui text-error">读取用量失败：{error}</p>}
      {!error && !usage && <p className="text-ui text-muted">正在读取…</p>}
      {usage && (
        <div>
          <div className="grid grid-cols-3 gap-4">
            <Figure label="调用次数" value={usage.calls.toLocaleString("zh-CN")} />
            <Figure label="输入 token" value={usage.promptTokens.toLocaleString("zh-CN")} />
            <Figure label="输出 token" value={usage.completionTokens.toLocaleString("zh-CN")} />
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <Figure label={`折算金额（${usage.currency}）`} value={usage.cost.toFixed(2)} />
          </div>
          {usage.byModel.length > 0 && (
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
