import { getVcrBackgroundRuns, type VcrStudy } from "@/lib/vcrClient";
import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import { List } from "@/components/ui/ListRow";
import { ProgrammeRunsDrawer } from "@/components/runs/ProgrammeRunsDrawer";
import { VcrReviews } from "./VcrReviews";
import { useStudyFrame } from "./studyFrameContext";

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
            <List label="变化记录" divided>
              {changes.map((change) => (
                <li key={change.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                  <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{change.at}</span>
                  <span className="min-w-0 flex-1 text-ui text-text">
                    {change.text}
                    {change.by && <span className="ml-1.5 text-caption text-text-3">{change.by}</span>}
                  </span>
                  {change.state === "stale" ? <Tag>已过期</Tag> : null}
                </li>
              ))}
            </List>
          )}
        <VcrReviews reviews={reviews} studyId={study.id} onNavigate={onClose} />
      </div>
    </Drawer>
  );
}

/**
 * 「AI 运行」: what the programme did for the steps the researcher did not ask for in their own words (the evidence, the analysis, the
 * matching) — the platform's one drawer for a module's programme runs (`ProgrammeRunsDrawer`), told how this module reads them. It
 * follows the study frame's version, so a run that begins or ends is on the list without a reload.
 */
export function VcrBackgroundRunsDrawer({ studyId, study, onClose }: { studyId: string; study: Pick<VcrStudy, "projectId">; onClose: () => void }) {
  const version = useStudyFrame()?.version ?? null;
  return <ProgrammeRunsDrawer projectId={study.projectId} load={() => getVcrBackgroundRuns(studyId)} version={version} onClose={onClose} />;
}
