import { ChevronLeft } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { INLINE_ACTION } from "./frontierText";

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
 * the way back to the feed is.
 */
export function FrontierBack({ trail = [] }: { trail?: readonly { label: string; to: string }[] }) {
  return (
    <nav aria-label="返回" className="flex flex-wrap items-center gap-x-1">
      <Link to="/app/frontier" className={cn(INLINE_ACTION, "-ml-1.5 gap-1 px-1.5 text-text-3 hover:text-text")}>
        <ChevronLeft size={16} aria-hidden="true" />前沿动态
      </Link>
      {trail.map((step) => (
        <span key={step.to} className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="text-text-3">/</span>
          <Link to={step.to} className={cn(INLINE_ACTION, "px-1.5 text-text-3 hover:text-text")}>{step.label}</Link>
        </span>
      ))}
    </nav>
  );
}
