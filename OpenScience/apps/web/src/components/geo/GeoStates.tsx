import { Radar } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageShell } from "@/components/layout/PageShell";

/** The sentence a direct link lands on where the module is off, or not offered to this account. */
export const GEO_OFF_SENTENCE = "循证 GEO 还没有在这个工作空间开放。";

/**
 * The module-off page: one sentence, nothing to click. The navigation row is
 * already gone for this account; this is what a bookmark or a forwarded link
 * finds.
 */
export function GeoOffPage() {
  return (
    <PageShell title="循证 GEO">
      <EmptyState icon={Radar} title={GEO_OFF_SENTENCE} />
    </PageShell>
  );
}

function Bar({ className }: { className: string }) {
  return <div className={`rounded bg-surface-2 ${className}`} />;
}

/** The home list's first paint: rows shaped like the projects they stand in for. */
export function GeoListSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      {["w-1/3", "w-1/4", "w-2/5"].map((width) => (
        <div key={width} className="flex h-16 items-center gap-6 border-b border-border px-2">
          <div className="flex flex-1 flex-col gap-2">
            <Bar className={`h-3.5 ${width}`} />
            <Bar className="h-3 w-1/5" />
          </div>
          <Bar className="h-4 w-40" />
          <Bar className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A project page's first paint: the tab row and four metric blocks. */
export function GeoProjectSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <div className="flex h-10 items-end gap-6 border-b border-border">
        {Array.from({ length: 9 }, (_, index) => <Bar key={index} className="mb-3 h-3.5 w-8" />)}
      </div>
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Bar key={index} className="h-36 rounded-card" />)}
      </div>
    </div>
  );
}
