import type { ReactNode } from "react";

/**
 * One group of the scheduled-tasks list: its name in grey over the rows
 * (「即将执行」, 「研究机会」, 「推荐」). The groups are parts of one list, so a
 * group with nothing in it is not drawn by whoever has the rows — an empty
 * heading is a promise the page cannot keep (plan 2026-10-07 §10).
 */
export function TaskGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="space-y-1">
      <h2 className="px-2 text-caption font-medium text-text-3">{label}</h2>
      {children}
    </section>
  );
}
