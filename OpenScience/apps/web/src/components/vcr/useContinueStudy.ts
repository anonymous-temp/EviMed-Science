import { sessionOwner } from "@/lib/sessionLifecycle";
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useProjectStore } from "@/lib/projects";
import { prepareRuntimeUiIntent, conversationNavigationState, newRuntimeUiIntent, scopedConversationPath } from "@/lib/runtimeUiNavigation";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";

/**
 * 「在新对话中继续」: a new conversation in the study's own project whose composer already holds the study as its reference. Staging
 * that reference (RuntimeUiFrame, the first time the conversation opens) is the person's explicit handoff: it records a grant for exactly
 * this study and this conversation, which the study page lists and takes back. The draft is a sentence to edit, never sent for the person.
 */
export function useContinueStudy() {
  const navigate = useNavigate();
  const select = useProjectStore(state => state.select);
  return useCallback((study: { id: string; projectId: string; name: string }) => {
    const owner = sessionOwner();
    const name = study.name.trim();
    void select(study.projectId, () => {
      if (owner !== sessionOwner()) return;
      navigate(scopedConversationPath("/app/chat", study.projectId), { flushSync: true, state: {
        ...conversationNavigationState(null, study.projectId), ...(study.projectId === "default" ? { globalAssistant: true } : {}),
        runtimeUiIntent: prepareRuntimeUiIntent({ ...newRuntimeUiIntent(name ? `接着做“${name}”这项研究：` : "接着做这项研究："), projectId: study.projectId, references: [],
          vcrReference: { studyId: study.id, kind: "study", objectId: "study" } }),
      } });
    }).catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "新对话暂时无法打开，请重试。" })));
  }, [navigate, select]);
}
