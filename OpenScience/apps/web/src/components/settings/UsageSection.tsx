import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Gauge } from "lucide-react";
import {
  describeWebUsageBudget,
  fetchWebAccountUsage,
  fetchWebAccountUsageRuns,
  lastWebUsageBudgetRefusal,
  webErrorMessage,
  type WebUsageRuns,
  type WebUsageSummary,
} from "@/lib/apiClient";
import { formatCny } from "@/lib/format";
import { useOperator } from "@/lib/useOperator";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Panel, PanelRow } from "@/components/ui/Panel";

const count = (value: number) => value.toLocaleString("zh-CN");

/** 9月22日, in the reader's zone. */
function shortDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 「用量」 in 设置 (2026-09-23 plan §5.9, mockup m11): one number — what this
 * month has cost — with the month and its model calls under it, and 「明细」
 * one row per research run: date · conversation · cost (Kimi and Manus show
 * theirs this way).
 *
 * What went: three token totals in a monospaced title font, the orange
 * paragraph about calls cut off before the provider reported their usage (now
 * one small line at the foot of the detail), and the sentence that the amount
 * is not a bill. An operator still sees tokens and the per-model split. A
 * refused request's ceiling is said in one line above, in the dictionary's own
 * words — never as a reset time, because the windows roll.
 */
export function UsageSection() {
  const operator = useOperator();
  // Read once on entry. The refusal happened on whatever page tried to spend;
  // nothing on this page spends, so there is nothing to keep watching for.
  const [budgetRefusal] = useState(lastWebUsageBudgetRefusal);
  const [usage, setUsage] = useState<WebUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);

  const load = useCallback(() => {
    setError(null);
    fetchWebAccountUsage().then(setUsage, (caught) => setError(webErrorMessage(caught)));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (detail) return <UsageDetail usage={usage} operator={operator} onBack={() => setDetail(false)} />;

  const month = usage ? new Date(usage.since).getUTCMonth() + 1 : null;
  return (
    <div className="space-y-8">
      {budgetRefusal && <p role="status" className="text-ui text-warn-strong">{describeWebUsageBudget(budgetRefusal)}</p>}
      <Panel title="本月用量">
        {error ? (
          <PanelRow
            label={<span role="alert">读取用量失败：{error}</span>}
            control={<Button variant="text" onClick={load}>重试</Button>}
          />
        ) : !usage ? (
          <PanelRow label={<span className="text-text-3">正在读取…</span>} />
        ) : (
          <PanelRow
            label={<span className="text-title font-semibold tabular-nums">{formatCny(usage.cost) || "¥0.00"}</span>}
            description={usage.calls > 0 ? `${month} 月 · ${count(usage.calls)} 次模型调用` : `${month} 月 · 还没有模型调用`}
            control={(
              <Button variant="text" onClick={() => setDetail(true)}>
                明细<ChevronRight size={16} aria-hidden="true" />
              </Button>
            )}
          />
        )}
      </Panel>
      {operator && usage && (
        // One model serves every run; its id is an engine internal a
        // researcher's bill does not need (DESIGN.md: no model names in the body).
        <Panel title="模型调用">
          <PanelRow label="读入 / 生成" control={<span className="tabular-nums">{count(usage.promptTokens)} / {count(usage.completionTokens)} token</span>} />
          {usage.byModel.map((row) => (
            <PanelRow key={row.model} label={<span className="font-mono">{row.model}</span>} control={<span className="tabular-nums">{row.calls} 次 · {formatCny(row.cost) || "¥0.00"}</span>} />
          ))}
        </Panel>
      )}
    </div>
  );
}

/**
 * The month, one row per research run, newest first; a row opens the
 * conversation it was spent in. What no conversation can show — spend not
 * attributed to a run, the platform's own background work — is one 「其他」
 * row, so the rows add up to the number above.
 */
function UsageDetail({ usage, operator, onBack }: { usage: WebUsageSummary | null; operator: boolean; onBack: () => void }) {
  const [runs, setRuns] = useState<WebUsageRuns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    fetchWebAccountUsageRuns().then(setRuns, (caught) => setError(webErrorMessage(caught)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const empty = runs !== null && runs.items.length === 0 && runs.other.cost <= 0;
  return (
    <div>
      <Button variant="text" className="-ml-3" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />本月用量
      </Button>
      <div className="mt-2">
        {error ? <LoadError message={error} onRetry={load} />
          : runs === null ? <RunsSkeleton filter={false} />
            : empty ? <EmptyState icon={Gauge} title="本月还没有用量" />
              : (
                <List label="本月用量明细" divided>
                  {runs.items.map((item) => (
                    <ListRow
                      key={item.runId}
                      leading={<span className="w-20 pt-px text-caption tabular-nums text-text-3">{shortDate(item.at)}</span>}
                      title={item.title ?? "未命名的研究"}
                      to={`/app/runs?run=${encodeURIComponent(item.runId)}`}
                      meta={operator ? `${count(item.calls)} 次调用 · 读入 ${count(item.inputTokens)} · 生成 ${count(item.outputTokens)} token` : undefined}
                      trailing={<span className="text-ui tabular-nums text-text-2">{formatCny(item.cost)}</span>}
                    />
                  ))}
                  {runs.other.cost > 0 && (
                    <ListRow
                      leading={<span className="w-20" />}
                      title="其他"
                      meta={operator ? `${count(runs.other.calls)} 次调用` : undefined}
                      trailing={<span className="text-ui tabular-nums text-text-2">{formatCny(runs.other.cost)}</span>}
                    />
                  )}
                </List>
              )}
      </div>
      {(usage?.uncertainCalls ?? 0) > 0 && (
        <p className="mt-3 text-caption text-text-3">另有 {count(usage?.uncertainCalls ?? 0)} 次调用未回报用量，未计入金额。</p>
      )}
      {operator && (usage?.unpricedCalls ?? 0) > 0 && (
        <p className="mt-1 text-caption text-text-3">{count(usage?.unpricedCalls ?? 0)} 次调用的模型不在价目表里，已计次但未计价。</p>
      )}
    </div>
  );
}
