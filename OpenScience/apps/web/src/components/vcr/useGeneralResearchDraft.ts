import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useProjectStore } from "@/lib/projects";
import { conversationNavigationState, newRuntimeUiIntent, scopedConversationPath, type VcrObjectSelection } from "@/lib/runtimeUiNavigation";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";

/** A home task begins in the general assistant, after atomic project selection. */
export function useGeneralResearchDraft() {
  const navigate = useNavigate();
  const select = useProjectStore(state => state.select);
  return useCallback((draft: string, vcrReference?: VcrObjectSelection, restoreDraft = false) => {
    void select("default", () => {
      navigate(scopedConversationPath("/app/chat", "default"), { flushSync: true, state: {
        ...conversationNavigationState(null, "default"), globalAssistant: true,
        runtimeUiIntent: { ...newRuntimeUiIntent(draft), projectId: "default", references: [], ...(restoreDraft ? { restoreDraft: true } : {}), ...(vcrReference ? { vcrReference } : {}) },
      } });
    }).catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "研究对话暂时无法打开，请重试。" })));
  }, [navigate, select]);
}
