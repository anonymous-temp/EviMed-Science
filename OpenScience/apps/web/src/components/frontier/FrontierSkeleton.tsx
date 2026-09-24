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
    <div className="animate-pulse" aria-hidden="true">
      {["w-4/5", "w-3/5", "w-2/3"].map((width, index) => (
        <div key={index} className="flex">
          <div className="mt-5 w-14 shrink-0"><Bar className="h-3 w-9" /></div>
          <div className="min-w-0 flex-1 border-b border-border pb-5 pt-5">
            <Bar className="h-3 w-32" />
            <Bar className={cn("mt-3 h-4", width)} />
            <Bar className="mt-3 h-3.5 w-full max-w-measure" />
            <Bar className="mt-2 h-3.5 w-11/12 max-w-measure" />
          </div>
        </div>
      ))}
    </div>
  );
}
