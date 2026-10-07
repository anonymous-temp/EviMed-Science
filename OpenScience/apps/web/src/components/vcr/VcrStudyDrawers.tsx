import { useState } from "react";
import { getVcrBackgroundRuns, type VcrBackgroundRun, type VcrStudy } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import { ListRow, List } from "@/components/ui/ListRow";
import { LoadError } from "@/components/cards/LoadError";
import { ReviewChip } from "./VcrMarks";
import { VcrReviews } from "./VcrReviews";
import { VcrTabSkeleton } from "./VcrStates";
import { useOpenVcrConversation } from "./useOpenVcrConversation";
import { useVcrLoad } from "./vcrTabKit";

/**
 * 「变更记录」: what changed in the study, and what the AI reviewers said of it — the two things the overview used to stack under
 * its numbers. A record of the past is not what a reader arrives at the study for, so it is one menu entry away rather than a
 * section of the first page. The reviews are named by what they reviewed and never by the model that wrote them.
 */
export function VcrChangeLogDrawer({ study, onClose }: { study: Pick<VcrStudy, "id" | "overview">; onClose: () => void }) {
  const { changes, reviews } = study.overview;
  return (
    <Drawer title="变更记录" onClose={onClose} widthClassName="max-w-lg">
      <div data-vcr-changes="" className="flex flex-col gap-6">
        {changes.length === 0
          ? <p className="py-6 text-ui text-text-3">还没有变化记录。</p>
          : (
            <ol className="divide-y divide-faint">
              {changes.map((change) => (
                <li key={change.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                  <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{change.at}</span>
                  <span className="min-w-0 flex-1 text-ui text-text">
                    {change.text}
                    {change.by && <span className="ml-1.5 text-caption text-text-3">{change.by}</span>}
                  </span>
                  {change.state === "stale" ? <Tag>已过期</Tag> : <ReviewChip state={change.state ?? null} />}
                </li>
              ))}
            </ol>
          )}
        <VcrReviews reviews={reviews} studyId={study.id} onNavigate={onClose} />
      </div>
    </Drawer>
  );
}

const RUN_STATE: Record<VcrBackgroundRun["state"], string> = { running: "进行中", finished: "已完成", stopped: "未完成" };

/**
 * 「AI 运行」: the conversations the programme opened for the steps the researcher did not ask for in their own (the evidence, the
 * analysis, the matching). Each row opens the conversation it ran in. They are a place to read what the AI did, not a ledger — the
 * study's own 「对话」 is the one that is the researcher's.
 */
export function VcrBackgroundRunsDrawer({ studyId, study, onClose }: { studyId: string; study: Pick<VcrStudy, "projectId">; onClose: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:runs`, () => getVcrBackgroundRuns(studyId));
  const open = useOpenVcrConversation();
  const [opening, setOpening] = useState<string | null>(null);
  const go = (sessionId: string) => {
    if (opening) return;
    setOpening(sessionId);
    void open({ projectId: study.projectId, sessionId })
      .then(onClose)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" })))
      .finally(() => setOpening(null));
  };
  return (
    <Drawer title="AI 运行" onClose={onClose} widthClassName="max-w-md">
      <div data-vcr-runs="">
        {state.kind === "loading" ? <VcrTabSkeleton rows={3} />
          : state.kind === "error" ? <LoadError message={state.message} onRetry={reload} />
            : state.data.length === 0 ? <p className="py-6 text-ui text-text-3">AI 还没有在后台做过什么。</p>
              : (
                <List label="AI 运行" divided>
                  {state.data.map((run) => (
                    <ListRow
                      key={run.sessionId}
                      title={run.label}
                      onOpen={() => go(run.sessionId)}
                      meta={[RUN_STATE[run.state], run.at].filter(Boolean).join(" · ")}
                    />
                  ))}
                </List>
              )}
      </div>
    </Drawer>
  );
}
