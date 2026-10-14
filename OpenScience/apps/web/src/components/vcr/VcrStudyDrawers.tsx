import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { sourceCitationProse } from "@evimed/domain";
import { getVcrBackgroundRuns, type VcrBackgroundRun, type VcrStudy } from "@/lib/vcrClient";
import { getWebConversationHistory, type PreservedConversationHistory } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import { ListRow, List } from "@/components/ui/ListRow";
import { LoadError } from "@/components/cards/LoadError";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { VcrReviews } from "./VcrReviews";
import { VcrTabSkeleton } from "./VcrStates";
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

const RUN_STATE: Record<VcrBackgroundRun["state"], string> = { running: "进行中", finished: "已完成", stopped: "未完成" };

/**
 * 「AI 运行」: what the programme did for the steps the researcher did not ask for in their own words (the evidence, the analysis, the
 * matching). It is **a record** — each row opens what that run said and wrote, read where the reader is, and there is no session to be
 * sent to and no composer in it: the study's own conversation is the one that is the researcher's (R19, audit B §2.1: this row used to
 * carry the reader into the run's conversation, which they could neither leave nor take part in).
 */
export function VcrBackgroundRunsDrawer({ studyId, study, onClose }: { studyId: string; study: Pick<VcrStudy, "projectId">; onClose: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:runs`, () => getVcrBackgroundRuns(studyId));
  const [record, setRecord] = useState<VcrBackgroundRun | null>(null);
  return (
    <Drawer title={record ? record.label : "AI 运行"} onClose={onClose} widthClassName="max-w-md">
      {record ? (
        <VcrRunRecord run={record} projectId={study.projectId} onBack={() => setRecord(null)} />
      ) : (
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
                        onOpen={() => setRecord(run)}
                        meta={[RUN_STATE[run.state], run.at].filter(Boolean).join(" · ")}
                      />
                    ))}
                  </List>
                )}
        </div>
      )}
    </Drawer>
  );
}

/** What one run said and wrote, as the platform kept it: read-only, with no way into the conversation it was made in. */
function VcrRunRecord({ run, projectId, onBack }: { run: VcrBackgroundRun; projectId: string; onBack: () => void }) {
  const [history, setHistory] = useState<PreservedConversationHistory | "error" | null>(null);
  useEffect(() => {
    let live = true;
    setHistory(null);
    void getWebConversationHistory(run.sessionId, projectId).then(
      (value) => { if (live) setHistory(value); },
      () => { if (live) setHistory("error"); },
    );
    return () => { live = false; };
  }, [run.sessionId, projectId]);
  return (
    <div data-vcr-run-record="" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Button variant="text" size="sm" onClick={onBack} className="pl-0"><ChevronLeft size={16} aria-hidden="true" />全部运行</Button>
        <span className="text-caption tabular-nums text-text-3">{[RUN_STATE[run.state], run.at].filter(Boolean).join(" · ")}</span>
      </div>
      {history === null ? <VcrTabSkeleton rows={2} />
        : history === "error" ? <p className="py-6 text-ui text-text-3">这次运行的记录暂时读不到。</p>
          : history.messages.length === 0 ? <p className="py-6 text-ui text-text-3">这次运行还没有留下文字记录。</p>
            : history.messages.map((message) => (
              <article key={message.seq} aria-label={message.role === "user" ? "要求" : "结果"}>
                {message.role === "user"
                  ? <p className="whitespace-pre-wrap text-ui font-medium text-text">{message.text}</p>
                  : <MarkdownViewer>{sourceCitationProse(message.text)}</MarkdownViewer>}
              </article>
            ))}
    </div>
  );
}
