import type { LearningSummary } from "@/lib/methodsClient";
import { Button } from "@/components/ui/Button";
import { StatTile } from "@/components/ui/StatTile";

/** Recorded changes across the account; these counts do not claim a causal quality gain. */
export function LearningOverview({ summary, onViewMethods }: {
  summary?: LearningSummary | null;
  onViewMethods: () => void;
}) {
  if (!summary) return null;
  return (
    <section aria-label="方法学习" className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-ui font-semibold text-text">方法学习</h2>
        <Button variant="text" onClick={onViewMethods}>查看做法</Button>
      </div>
      <div className="grid grid-cols-1 rounded-card border border-border bg-surface sm:grid-cols-3">
        <StatTile label="生效做法" value={summary.methods.approved ?? 0} unit="项" />
        <StatTile label="做法改进" value={(summary.results.amend ?? 0) + (summary.results.merge ?? 0)} unit="次" />
        <StatTile label="新增做法" value={summary.results.create ?? 0} unit="项" />
      </div>
    </section>
  );
}
