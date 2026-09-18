import { useId, useMemo, useState } from "react";
import { ChevronDown, Waypoints } from "lucide-react";
import type { WebAgentRun, WebResearchAgent } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { ANSWER_LINE_LABEL, capabilityTarget, routeLineOf, type DispatchTarget } from "@/lib/dispatch";
import { researchAgentUi } from "@/lib/researchAgentUi";

/**
 * The route line: which line a run is on, why, and how long that line usually
 * takes — 「按 临床证据深度分析 处理 · 通常 15–30 分钟 · 可改为 [普通问答]
 * [其他能力]」 (plan §5 act 1, §9.6).
 *
 * The control plane decided the line and wrote down why, and until
 * 2026-09-18 the reason had no render site anywhere in the shell (appendix
 * E §5.3): a researcher who wanted a quick answer and got a 30-minute package,
 * or wanted a report and got a chat reply, found out afterwards and could only
 * ask again in different words.
 *
 * With `onReroute` the line offers the change — the caller stops the run and
 * starts the same question on the chosen line. Without it the line only
 * informs, as on a run that has been going for a while.
 */
export function RouteLine({
  run,
  catalog = [],
  onReroute,
  busy = false,
  className,
}: {
  run: WebAgentRun;
  catalog?: ReadonlyArray<WebResearchAgent>;
  onReroute?: (target: DispatchTarget, label: string) => void;
  busy?: boolean;
  className?: string;
}) {
  const line = routeLineOf(run, catalog);
  const [picking, setPicking] = useState(false);
  const listId = useId();
  // One wrapped row of names, neighbours by category: fifteen capabilities
  // under twelve category headings made a list taller than the page it
  // interrupted. The category rides along as each chip's tooltip.
  const others = useMemo(
    () =>
      catalog
        .map(researchAgentUi)
        .filter((agent) => agent.id !== line.agentId)
        .sort((a, b) => a.category.localeCompare(b.category, "zh") || a.title.localeCompare(b.title, "zh")),
    [catalog, line.agentId],
  );
  const choose = (target: DispatchTarget, label: string) => {
    setPicking(false);
    onReroute?.(target, label);
  };

  return (
    <div className={cn("text-ui text-text", className)}>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Waypoints size={14} className="shrink-0 text-muted" aria-hidden="true" />
        <span>
          按 <strong className="font-semibold">{line.label}</strong> 处理
        </span>
        {line.minutes && (
          <>
            <span className="text-muted" aria-hidden="true">·</span>
            <span className="text-muted">{line.minutes}</span>
          </>
        )}
        {onReroute && (!line.answerLine || others.length > 0) && (
          <>
            <span className="text-muted" aria-hidden="true">·</span>
            <span className="text-muted">可改为</span>
            {!line.answerLine && (
              <button
                type="button"
                className={chipCls}
                disabled={busy}
                aria-label={`改为${ANSWER_LINE_LABEL}`}
                title="停止这次运行，把同一个问题按普通问答重新开始"
                onClick={() => choose({ kind: "open-domain" }, ANSWER_LINE_LABEL)}
              >
                {ANSWER_LINE_LABEL}
              </button>
            )}
            {others.length > 0 && (
              <button
                type="button"
                className={chipCls}
                disabled={busy}
                aria-expanded={picking}
                aria-controls={listId}
                onClick={() => setPicking((value) => !value)}
              >
                其他能力
                <ChevronDown
                  size={12}
                  className={cn("transition-transform duration-fast", picking && "rotate-180")}
                  aria-hidden="true"
                />
              </button>
            )}
          </>
        )}
      </p>
      {line.reason && <p className="mt-0.5 pl-5 text-caption text-muted">{line.reason}</p>}
      {onReroute && picking && (
        <div id={listId} role="group" aria-label="其他能力" className="mt-2 pl-5">
          <p className="mb-1.5 text-caption text-muted">选一项能力，这次运行会停止，同一个问题按它重新开始。</p>
          <div className="flex flex-wrap gap-1.5">
            {others.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={chipCls}
                disabled={busy}
                title={agent.category}
                aria-label={`改为${agent.title}`}
                onClick={() => choose(capabilityTarget(agent), agent.title)}
              >
                {agent.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const chipCls =
  "inline-flex h-7 items-center gap-1 rounded-full border border-strong bg-surface px-2.5 text-ui text-text transition-colors duration-fast hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";
