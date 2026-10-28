import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * One group of the scheduled-tasks list: its name in grey over the rows
 * (「即将执行」, 「研究机会」, 「推荐」). The groups are parts of one list, so a
 * group with nothing in it is not drawn by whoever has the rows — an empty
 * heading is a promise the page cannot keep (plan 2026-10-07 §10).
 *
 * The rows carry 8 px of their own (the ground a hover and the open row are drawn on). In a column that holds nothing else
 * the group stands as it is: its block, its name and its rows' ground on one edge, the rows' words 8 px in. In a column whose title
 * and search stand on the text's edge (`bleed`), the group's block starts on that edge too, its name with it, and the rows' ground hangs
 * 8 px outside it, so the words of the name and of every row are on one line and so is the column's one left edge.
 */
export function TaskGroup({ label, children, bleed = false }: { label: string; children: ReactNode; bleed?: boolean }) {
  return (
    <section aria-label={label} className="space-y-1">
      <h2 className={cn("text-caption text-text-3", !bleed && "px-2")}>{label}</h2>
      {bleed ? <div className="-mx-2">{children}</div> : children}
    </section>
  );
}
