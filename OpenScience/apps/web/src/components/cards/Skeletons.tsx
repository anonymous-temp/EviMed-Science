import { cn } from "@/lib/cn";

/**
 * First-paint loading placeholders, shaped like the content they stand in for
 * (same idea as ThreadSkeleton on the live session page): quiet `animate-pulse`
 * blocks, `aria-hidden` so screen readers skip them, and proportions mirroring
 * the real rows/cards so nothing jumps when data arrives.
 */

function Bar({ className }: { className?: string }) {
  return <div className={cn("rounded bg-surface-2", className)} />;
}

/** Files page — directory listing rows: icon, name, size stub. */
export function FilesSkeleton() {
  const widths = ["w-3/4", "w-1/2", "w-2/3", "w-3/5", "w-1/2", "w-2/3"];
  return (
    <div className="animate-pulse p-2" aria-hidden>
      {widths.map((w, i) => (
        // 36 px — the list-row height, so nothing jumps when the rows arrive.
        <div key={i} className="flex h-9 items-center gap-2 px-2">
          <Bar className="h-4 w-4 shrink-0" />
          <Bar className={cn("h-3.5", w)} />
          <Bar className="ml-auto h-3 w-9 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Runs page — the sticky filter bar (search + facet chips) over ledger rows. */
export function RunsSkeleton({ filter = true }: { filter?: boolean }) {
  const widths = ["w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/3", "w-1/2"];
  return (
    <div className="animate-pulse" aria-hidden>
      {filter && (
        <div className="flex flex-wrap items-center gap-2 px-2 py-2">
          <Bar className="h-8 min-w-[12rem] flex-1 rounded" />
          <Bar className="h-6 w-16 rounded-full" />
          <Bar className="h-6 w-16 rounded-full" />
          <Bar className="h-6 w-36 rounded-full" />
        </div>
      )}
      <div className="mt-2 px-2 py-2">
        <Bar className="h-3 w-16" />
      </div>
      {widths.map((w, i) => (
        <div key={i} className="flex h-9 items-center gap-3 px-2">
          <Bar className="h-1.5 w-1.5 shrink-0 rounded-full" />
          <Bar className={cn("h-3.5", w)} />
          <Bar className="ml-auto h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Memory page — the two-column card grid. */
export function MemorySkeleton() {
  return (
    <div className="mt-6 grid animate-pulse items-start gap-3 md:grid-cols-2" aria-hidden>
      {[3, 2, 3, 2].map((lines, i) => (
        <div key={i} className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <Bar className="h-3 w-24" />
            <Bar className="h-4 w-16" />
          </div>
          <div className="mt-4 space-y-2">
            {Array.from({ length: lines }, (_, j) => (
              <Bar key={j} className={cn("h-3.5", j === lines - 1 ? "w-2/3" : "w-full")} />
            ))}
          </div>
          <div className="mt-4 flex gap-1.5 border-t border-border pt-3">
            <Bar className="h-4 w-12 rounded-full" />
            <Bar className="h-4 w-16 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 前沿动态 — the feed's cards: the source line with its chips, the title and
 * the original title under it, two lines of summary, the 「为什么值得看」 box
 * and the action row. Three cards, one fold of a laptop screen.
 */
export function FrontierSkeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-hidden>
      {["w-4/5", "w-3/5", "w-2/3"].map((w, i) => (
        <div key={i} className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <Bar className="h-5 w-10 rounded-full" />
            <Bar className="h-3.5 w-20" />
            <Bar className="h-5 w-16 rounded-full" />
          </div>
          <Bar className={cn("mt-3 h-4", w)} />
          <Bar className="mt-2 h-3 w-1/2" />
          <div className="mt-3 space-y-2">
            <Bar className="h-3.5 w-full" />
            <Bar className="h-3.5 w-11/12" />
          </div>
          <Bar className="mt-3 h-9 w-full" />
          <div className="mt-3 flex gap-4">
            <Bar className="h-3.5 w-10" />
            <Bar className="h-3.5 w-16" />
            <Bar className="h-3.5 w-10" />
            <Bar className="h-3.5 w-14" />
          </div>
        </div>
      ))}
    </div>
  );
}
