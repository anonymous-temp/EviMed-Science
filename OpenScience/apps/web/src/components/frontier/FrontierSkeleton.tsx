import { cn } from "@/lib/cn";

function Bar({ className }: { className?: string }) {
  return <div className={cn("rounded bg-surface-2", className)} />;
}

/**
 * 前沿动态's first paint: three rows shaped like the feed's — the time column,
 * the source line, the title and two lines of summary — so nothing jumps when
 * the list arrives. Quiet `animate-pulse` blocks, hidden from screen readers.
 */
export function FrontierSkeleton() {
  return (
    <div className="animate-pulse motion-reduce:animate-none" aria-hidden="true">
      <div className="mb-1 flex items-baseline gap-2">
        <Bar className="h-4 w-14" />
        <Bar className="h-3 w-8" />
      </div>
      {["w-4/5", "w-3/5", "w-2/3"].map((width, index) => (
        <div key={index} className="flex max-sm:block">
          <div className="mt-5 flex w-14 shrink-0 items-center gap-2 max-sm:mb-1 max-sm:mt-4 max-sm:w-auto">
            <Bar className="h-3 w-9" />
            <Bar className="hidden h-1.5 w-1.5 max-sm:block" />
          </div>
          <div className="min-w-0 flex-1 border-b border-border pb-5 pt-5 max-sm:pt-0">
            <div className="flex items-center justify-between gap-3">
              <Bar className="h-3 w-32" />
              <Bar className="h-3 w-9" />
            </div>
            <Bar className={cn("mt-2.5 h-5", width)} />
            <Bar className="mt-2.5 h-3.5 w-full max-w-measure" />
            <Bar className="mt-2 h-3.5 w-11/12 max-w-measure" />
            <Bar className="mt-3 h-7 w-48" />
          </div>
        </div>
      ))}
    </div>
  );
}
