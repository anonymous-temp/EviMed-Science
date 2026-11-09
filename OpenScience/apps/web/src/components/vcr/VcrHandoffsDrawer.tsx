import { useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { getVcrContinuations, revokeVcrContinuation } from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/cards/EmptyState";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";
import { VcrTabSkeleton } from "./VcrStates";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";

/** A moment as a person reads it in a list: month, day and time. */
const momentText = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/**
 * 交出去的对话: the conversations this study was handed to with 「在新对话中继续」, each with when it was handed over and one click to take it back.
 *
 * Hidden knowledge:
 *  - **Taking back needs no confirmation.** A handoff is a grant the person made with one pick; undoing it is the same size. The conversation
 *    stops reaching the study at its next call, and a result that finishes after that is not read into it.
 *  - **A person sees the handoffs they made; the study's lead sees every one.** The server decides which (`mine` says whose it is).
 *  - **The conversation is named by when, never by an identifier.**
 */
export function VcrHandoffsDrawer({ studyId, onClose }: { studyId: string; onClose: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:continuations`, () => getVcrContinuations(studyId));
  const [busy, setBusy] = useState<string | null>(null);
  const take = (sessionId: string) => {
    if (busy) return;
    setBusy(sessionId);
    void revokeVcrContinuation(studyId, sessionId)
      .then(() => { toast.success("已收回。"); reload(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法收回，请稍后重试。" })))
      .finally(() => setBusy(null));
  };
  return (
    <Drawer title="交出去的对话" description="这项研究交给过哪些新对话；收回后，那个对话不再能读写这项研究。" onClose={onClose} widthClassName="max-w-md">
      <div data-vcr-handoffs="">
        {state.kind === "loading" ? <VcrTabSkeleton rows={2} />
          : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} />
            : state.data.length === 0 ? <EmptyState title="还没有交出过对话" description="在这项研究的菜单里选“在新对话中继续”，交出的对话就会列在这里。" />
              : (
                <List label="交出去的对话" divided>
                  {state.data.map((entry, at) => (
                    <ListRow
                      key={entry.sessionId}
                      title={`${momentText(entry.grantedAt)} 交出的对话`}
                      meta={entry.mine ? undefined : "别的成员交出的"}
                      trailing={entry.revoked ? <Tag>已收回</Tag> : undefined}
                      actions={entry.revoked ? undefined : <Button actionKind="set" size="sm" loading={busy === entry.sessionId} disabled={busy !== null} aria-label={`收回第 ${at + 1} 个对话`} onClick={() => take(entry.sessionId)}>收回</Button>}
                    />
                  ))}
                </List>
              )}
      </div>
    </Drawer>
  );
}
