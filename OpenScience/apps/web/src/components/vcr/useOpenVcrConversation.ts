import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";

/** Where a study's conversation opens: its control-plane project and, when there is one, its conversation. */
export interface VcrConversationTarget {
  projectId: string;
  sessionId?: string | null;
}

/**
 * Open a study's conversation, optionally with the module's chip and a draft
 * already in the composer.
 *
 * A study is an ordinary control-plane project, and a conversation belongs to
 * the project the shell is in — the intent names it. So the shell switches to
 * the study's project first (in place, `useProjectStore.select`) and mints the
 * intent only once it is there, in the same render as the navigation.
 *
 * **The draft is never sent.** The four action cards on the home page land
 * here with a starting line waiting in the composer; the reader presses
 * return, or edits it first (plan §9.2: no form).
 */
export function useOpenVcrConversation() {
  const navigate = useNavigate();
  return useCallback(async (target: VcrConversationTarget, draft?: string) => {
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
