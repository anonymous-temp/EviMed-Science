import type { ReactNode } from "react";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";

/**
 * The frame every section of the capsule page shares: the reading measure,
 * the loading and failed states, and a one-line note under the tabs that says
 * what the section is for.
 */
export function SectionShell({
  intro,
  loading,
  failed,
  onRetry,
  children,
}: {
  intro: ReactNode;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-content-wide space-y-6 px-6 py-8">
        <p className="max-w-2xl text-ui text-muted">{intro}</p>
        {failed && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-ui text-text">
            <span>{loading ? "暂时读不到这一部分。" : "刚才没有刷新成功，下面是上次读到的内容。"}</span>
            <Button variant="ghost" size="sm" onClick={onRetry}>重试</Button>
          </div>
        )}
        {loading ? (failed ? null : <MemorySkeleton />) : children}
      </div>
    </div>
  );
}

/** A titled list inside a section: the rows, or one quiet line when there are none. */
export function SectionList({
  title,
  count,
  empty,
  children,
}: {
  title: ReactNode;
  count: number;
  empty: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="flex items-baseline gap-2 text-body font-semibold text-text">
        {title}
        <span className="text-caption font-normal text-muted">{count}</span>
      </h3>
      {count === 0
        ? <p className="mt-2 text-ui text-muted">{empty}</p>
        : <ul className="mt-2 divide-y divide-border rounded-card border border-border bg-surface">{children}</ul>}
    </section>
  );
}
