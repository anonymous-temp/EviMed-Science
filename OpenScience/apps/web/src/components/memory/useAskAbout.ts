import { useCallback } from "react";
import { useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";

/**
 * 「就这个提问」: a new conversation with the question drafted in its composer, unsent — the person finishes the sentence and sends it
 * (no input in a drawer, no second composer: the kernel's own is the only one). It opens in `projectId` when the mark belongs to a project,
 * and in the project the shell is in otherwise, the way 「在对话里说说这个项目」 does.
 */
export function useAskAbout() {
  const navigate = useNavigate();
  const select = useProjectStore((state) => state.select);
  const currentId = useProjectStore((state) => state.currentId);
  return useCallback((draft: string, projectId?: string | null) => {
    void select(projectId || currentId, () => {
      navigate("/app/chat", { flushSync: true, state: { runtimeUiIntent: { ...newRuntimeUiIntent(draft), references: [] } } });
    }).catch((failure: unknown) => toast.error(webErrorMessage(failure)));
  }, [navigate, select, currentId]);
}
