import { Newspaper } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageShell } from "@/components/layout/PageShell";

/** The sentence a direct link lands on where the module is off, or not offered to this account (plan §4.11). */
export const FRONTIER_OFF_SENTENCE = "前沿动态还没有在这个工作空间开放。";

/**
 * The module-off page: one sentence, nothing to click. The navigation row is
 * already gone for this account; this is what a bookmark or a forwarded link
 * finds.
 */
export function FrontierOffPage() {
  return (
    <PageShell title="前沿动态" width="wide">
      <EmptyState icon={Newspaper} title={FRONTIER_OFF_SENTENCE} className="rounded-card border border-dashed border-border" />
    </PageShell>
  );
}
