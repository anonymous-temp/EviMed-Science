import { useNavigate } from "react-router";
import { useProjectStore } from "@/lib/projects";
import { chatPath } from "@/lib/runLocation";
import { toast } from "@/lib/toast";
import { List, ListRow } from "@/components/ui/ListRow";
import type { LearningSummary } from "@/lib/methodsClient";
import { Button } from "@/components/ui/Button";
import { StatTile } from "@/components/ui/StatTile";

/** Recorded changes across the account; these counts do not claim a causal quality gain. */
export function LearningOverview({ summary, onViewMethods }: {
  summary?: LearningSummary | null;
  onViewMethods: () => void;
}) {
  const navigate = useNavigate();
  if (!summary) return null;
  const handbooks = summary.handbooks;
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
      {handbooks && (
        <div className="mt-4">
          <h3 className="mb-2 text-ui font-semibold text-text">能力经验</h3>
          <div className="grid grid-cols-1 rounded-card border border-border bg-surface sm:grid-cols-3">
            <StatTile label="生效经验" value={handbooks.applied} unit="项" />
            <StatTile label="已采用记录" value={handbooks.used} unit="次" />
            <StatTile label="完成对照评估" value={handbooks.evaluated} unit="项" />
          </div>
          <List label="近期能力经验" className="mt-2">
            {handbooks.recent.map((item) => (
              <ListRow key={item.id} title={item.title}
                meta={item.verification === "unmeasured" ? "效果待观察" : item.evaluationVerdict === "better" ? "对照评估显示改善" : "对照评估未见下降"}
                onOpen={item.source?.sessionId ? () => {
                  void useProjectStore.getState().select(item.source.projectId,
                    () => navigate(chatPath(item.source.sessionId), { flushSync: true }))
                    .catch(() => toast.error("原始研究暂不可用"));
                } : undefined} />
            ))}
          </List>
        </div>
      )}
    </section>
  );
}
