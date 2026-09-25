import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";

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
 */
export function useOpenGeoConversation() {
  const navigate = useNavigate();
  return useCallback(async (target: GeoConversationTarget, draft?: string) => {
    const store = useProjectStore.getState();
    if (!store.projects.some((project) => project.id === target.projectId)) await store.load();
    const sessionId = target.sessionId ?? undefined;
    await useProjectStore.getState().select(target.projectId, () => {
      navigate("/app/chat", {
        state: { runtimeUiIntent: newRuntimeUiIntent(draft, sessionId) },
        flushSync: true,
      });
    });
  }, [navigate]);
}
