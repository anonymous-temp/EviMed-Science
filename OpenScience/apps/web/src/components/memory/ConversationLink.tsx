import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { chatPath } from "@/lib/runLocation";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";

/**
 * 「来源对话」 and 「从哪里学到的」: a link to the conversation something was
 * learned from, shown inside a drawer only — a row never navigates away
 * (2026-10-07 plan §3.2 item 4). The researcher clicks it on purpose; opening a
 * conversation may start that project's runtime, which is the reason it is not
 * a row's click.
 *
 * The conversation lives in a project, so the shell moves to that project in
 * the same render as the navigation (`useProjectStore.select`), as the sidebar
 * does, and says so when the project cannot be opened. With no project named it
 * opens in the one the shell is in.
 */
export function ConversationLink({ projectId, sessionId, children }: { projectId?: string | null; sessionId: string; children: ReactNode }) {
  const navigate = useNavigate();
  const open = () => {
    const land = () => navigate(chatPath(sessionId), { flushSync: true });
    if (!projectId) { land(); return; }
    void useProjectStore.getState().select(projectId, land).catch(() => toast.error("原始研究暂不可用"));
  };
  return (
    <button type="button" onClick={open} className="max-w-measure text-left text-ui text-accent hover:underline">
      {children}
    </button>
  );
}
