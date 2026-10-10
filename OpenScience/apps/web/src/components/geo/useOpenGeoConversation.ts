import { useCallback } from "react";
import { useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";

/** Where a GEO conversation opens: the control-plane project and, when there is one, its conversation. */
export interface GeoConversationTarget {
  projectId: string;
  sessionId?: string | null;
}

/**
 * Open a GEO project's conversation, optionally with a draft in the composer.
 *
 * A GEO project is an ordinary control-plane project, and a conversation
 * belongs to the project the shell is in — the intent names it. So the shell
 * switches to the GEO project first (in place, `useProjectStore.select`) and
 * mints the intent only once it is there, in the same render as the
 * navigation, as the project list does. The draft is never sent: it waits in
 * the composer for the reader.
 *
 * The project list is re-read first when the project is not in it yet — a
 * project created a moment ago — so the sidebar shows the group it lands in.
 *
 * It never rejects. A project that cannot be proved or opened (the network, a
 * project deleted in another tab) is said in a toast, once, here, and the
 * answer is `false`: every button that calls this gives its spinner back and
 * nothing is left to swallow at the call site. `true` is a conversation that
 * was opened.
 */
export function useOpenGeoConversation() {
  const navigate = useNavigate();
  return useCallback(async (target: GeoConversationTarget, draft?: string): Promise<boolean> => {
    try {
      const store = useProjectStore.getState();
      if (!store.projects.some((project) => project.id === target.projectId)) await store.load();
      const sessionId = target.sessionId ?? undefined;
      await useProjectStore.getState().select(target.projectId, () => {
        navigate("/app/chat", {
          state: { runtimeUiIntent: newRuntimeUiIntent(draft, sessionId) },
          flushSync: true,
        });
      });
      return true;
    } catch (error: unknown) {
      toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" }));
      return false;
    }
  }, [navigate]);
}
