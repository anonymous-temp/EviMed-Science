import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Archive, RefreshCw } from "lucide-react";
import { archiveWebAgentRun, getWebProjectId, listWebAgentRuns, webErrorMessage, type WebAgentRun } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { announceRunsChanged, runMetaLine, runTitle } from "@/lib/runPresentation";
import { chatPath } from "@/lib/runLocation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { toast } from "@/lib/toast";

/**
 * The conversations of this project the researcher put away, and the way
 * back for each. ChatGPT keeps its archived chats under Data controls; this
 * is the same shelf, under 项目, because a conversation belongs to one.
 */
export function ArchivedConversationsCard() {
  const projectId = useProjectStore((state) => state.currentId) || getWebProjectId();
  const [runs, setRuns] = useState<WebAgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRuns(await listWebAgentRuns({ projectId, archived: true })); }
    catch (cause) { setRuns([]); setError(webErrorMessage(cause, { fallback: "已归档的对话暂时读不到。" })); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const restore = async (run: WebAgentRun) => {
    setBusy(run.id);
    try {
      await archiveWebAgentRun(run.id, false);
      announceRunsChanged();
      toast.success("已恢复到对话列表。");
      await load();
    } catch (cause) {
      toast.error(webErrorMessage(cause, { fallback: "没能恢复，请稍后重试。" }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mt-5" title="已归档的对话" hint="从侧栏归档的对话放在这里；恢复后回到列表。删除的对话不在这里，也不能恢复。">
      {error && (
        <div role="alert" className="mb-3 flex items-center gap-2 text-ui text-error">
          <span className="flex-1">{error}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} aria-hidden="true" />重试</Button>
        </div>
      )}
      {runs === null ? <p className="text-ui text-muted">正在读取…</p>
        : runs.length === 0 ? <p className="text-ui text-muted">没有归档的对话。</p>
          : (
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id} className="flex items-center gap-3 py-2">
                  <Archive size={14} className="shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <Link to={chatPath(run.sessionId)} className="block truncate text-ui text-text hover:underline">{runTitle(run)}</Link>
                    <span className="block truncate text-caption text-muted">{runMetaLine(run)}</span>
                  </span>
                  <Button size="sm" variant="ghost" loading={busy === run.id} disabled={busy !== null} onClick={() => void restore(run)}>恢复</Button>
                </li>
              ))}
            </ul>
          )}
    </Card>
  );
}
