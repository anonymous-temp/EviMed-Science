import { ChevronLeft } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { INLINE_ACTION } from "./frontierText";

/**
 * Where a page was opened from, handed over in the link's router state under `evidenceFrom`: a card's link to its author carries the
 * card (`{ to: the card's path, label: its question }`), a zone's carries the zone. The page it opens reads it with
 * `evidenceFromState` and says it in its way back — 「‹ {the card}」 returns to the card, where the default is 「‹ 前沿动态」.
 */
export interface EvidenceFrom {
  to: string;
  label: string;
}

/**
 * The `evidenceFrom` of a location's state, or null: state is whatever the previous page put there (and survives a reload of the
 * history entry), so it is read as untrusted — a path inside the app and a label, nothing else.
 */
export function evidenceFromState(state: unknown): EvidenceFrom | null {
  const from = typeof state === "object" && state !== null ? (state as { evidenceFrom?: unknown }).evidenceFrom : null;
  if (typeof from !== "object" || from === null) return null;
  const { to, label } = from as { to?: unknown; label?: unknown };
  if (typeof to !== "string" || !/^\/app\/[^\s]*$/.test(to) || typeof label !== "string" || !label.trim()) return null;
  return { to, label: label.trim() };
}

/**
 * The way back to 前沿动态 from the evidence-zone pages: 「‹ 前沿动态」 over
 * the page header, as the event page has it (plan 2026-10-07 §4). The four
 * zone pages used to open with the feed's own navigation row — 动态 · 证据专区
 * · 简报 · 关注 — so that a reader on a zone saw the feed's four views and a
 * title that said 前沿动态 over a page that was not the feed. They are a
 * separate group of pages reached from a header link now, and say so here.
 *
 * `trail` names the pages in between, for a page more than one step down: a
 * zone is 「‹ 前沿动态 / 证据专区」, so the way up to the directory stays where
 * the way back to the feed is. `to` and `label` replace the first step when the
 * reader came from somewhere else — the author's page, opened from a card, goes
 * back to that card (`evidenceFromState`).
 */
export function FrontierBack({ trail = [], to = "/app/frontier", label = "前沿动态" }: { trail?: readonly { label: string; to: string }[]; to?: string; label?: string }) {
  return (
    <nav aria-label="返回" className="flex min-w-0 flex-wrap items-center gap-x-1">
      <Link to={to} className={cn(INLINE_ACTION, "-ml-1.5 min-w-0 shrink gap-1 px-1.5 text-text-3 hover:text-text")}>
        <ChevronLeft size={16} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 max-w-measure truncate">{label}</span>
      </Link>
      {trail.map((step) => (
        <span key={step.to} className="inline-flex min-w-0 items-center gap-1">
          <span aria-hidden="true" className="text-text-3">/</span>
          <Link to={step.to} className={cn(INLINE_ACTION, "min-w-0 shrink px-1.5 text-text-3 hover:text-text")}>
            <span className="min-w-0 max-w-measure truncate">{step.label}</span>
          </Link>
        </span>
      ))}
    </nav>
  );
}
