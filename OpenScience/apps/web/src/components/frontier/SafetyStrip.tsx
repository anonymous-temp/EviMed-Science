import { useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import type { FrontierItem } from "@/lib/frontierClient";
import { EXTERNAL, INLINE_ACTION, ago } from "./frontierText";

/** How far back the strip looks (plan 2026-09-23 §6.2: 近 48 小时). */
export const SAFETY_STRIP_HOURS = 48;

/** The safety alerts, still being read, unreadable, or read. */
export type SafetyAlerts = "loading" | "failed" | FrontierItem[];

/** The alerts of the strip's window, newest first. */
export function recentAlerts(items: readonly FrontierItem[], now = Date.now()): FrontierItem[] {
  const since = now - SAFETY_STRIP_HOURS * 3_600_000;
  return items
    .filter((item) => item.safetyAlert && Date.parse(item.timelineAt) >= since)
    .sort((a, b) => Date.parse(b.timelineAt) - Date.parse(a.timelineAt));
}

/** One alert's line: the title, then who issued it and when, in grey. */
function AlertLink({ item, onOpened }: { item: FrontierItem; onOpened: (item: FrontierItem) => void }) {
  const when = ago(item.timelineAt);
  return (
    <a href={item.url} {...EXTERNAL} onClick={() => onOpened(item)} className="flex h-control min-w-0 flex-1 items-center rounded text-ui text-text hover:underline">
      <span className="truncate">
        {item.title}
        <span className="text-text-3"> · {item.source.name}{when && ` · ${when}`}</span>
      </span>
    </a>
  );
}

/**
 * 安全警示, at the top of 精选 whenever there is one from the last 48 hours —
 * at every width, where the old rail fell below the feed on a laptop (plan
 * 2026-09-23 §6.2; research B §8 #32). One thin red strip: how many, the
 * newest, who issued it and when; 「全部 ›」 opens the rest in place. It does
 * not follow the filters: an official safety notice is here whatever the
 * reader narrowed the feed to.
 *
 * Nothing in the window, nothing on the page. A list that could not be read
 * says so, because a strip that is simply absent would read as 「没有」 — the
 * one fact a pharmacist came to check.
 */
export function SafetyStrip({ alerts, onRetry, onOpened }: {
  alerts: SafetyAlerts;
  onRetry: () => void;
  onOpened: (item: FrontierItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);
  const toggle = () => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    if (!open) {
      setMounted(true);
      setOpen(true);
      return;
    }
    setOpen(false);
    collapseTimer.current = setTimeout(() => setMounted(false), 220);
  };
  if (alerts === "loading") return null;
  if (alerts === "failed") {
    return (
      <div role="alert" className="frontier-safety-strip flex min-h-control items-center gap-3 rounded-card px-4 py-2 text-ui text-danger-strong">
        <span className="frontier-safety-icon"><ShieldAlert size={20} aria-hidden="true" /></span>
        <span className="min-w-0 flex-1">无法读取安全警示</span>
        <button type="button" onClick={onRetry} className={cn(INLINE_ACTION, "frontier-safety-action px-3")}>重试</button>
      </div>
    );
  }
  if (alerts.length === 0) return null;
  const [first, ...rest] = alerts;
  return (
    <section aria-label="安全警示" className="frontier-safety-strip rounded-card px-4 py-1.5">
      <div className="flex min-h-control items-center gap-3">
        <span className="frontier-safety-icon"><ShieldAlert size={20} aria-hidden="true" /></span>
        <span className="shrink-0 text-body font-semibold text-danger-strong">安全警示 <span className="tabular-nums">{alerts.length}</span></span>
        <AlertLink item={first} onOpened={onOpened} />
        {rest.length > 0 && (
          <button type="button" aria-label={open ? "收起" : "全部 ›"} aria-expanded={open} onClick={toggle}
            className={cn(INLINE_ACTION, "frontier-safety-action px-3 text-danger-strong")}>
            {open ? "收起 ↑" : "查看全部 ↓"}
          </button>
        )}
      </div>
      {mounted && (
        <div className="frontier-safety-expand" data-open={open ? "true" : "false"} aria-hidden={!open}>
          <ul aria-label="其余安全警示" className="min-h-0 pb-2 pl-11 pt-1">
            {rest.map((item) => <li key={item.id} className="flex"><AlertLink item={item} onOpened={onOpened} /></li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
