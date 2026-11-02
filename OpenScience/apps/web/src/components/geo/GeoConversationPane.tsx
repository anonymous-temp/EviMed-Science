import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openGeoConversation, type GeoConversationScope } from "@/lib/geoNativeClient";
import { webErrorMessage } from "@/lib/apiClient";
import { PreservedConversation } from "@/components/chat/PreservedConversation";
import { LoadError } from "@/components/cards/LoadError";
import { registerTaskPane } from "@/lib/taskPane";
import { useFitToScroller } from "@/components/workspace/WorkspaceSplit";

/** The shell places its resident native conversation over this pane. */
export function GeoConversationPane({ projectId, sessionId, geoId, canRun = true, owner = true }: { projectId: string; sessionId: string; geoId: string; canRun?: boolean; owner?: boolean }) {
  const pane = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<GeoConversationScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setScope(null); setError(null);
    if (!canRun) return () => { active = false; };
    void openGeoConversation(geoId, {kind:"session",sessionId}).then(value => {
      if (value.projectId !== projectId || value.sessionId !== sessionId) throw new Error("Conversation changed");
      if (active) setScope(value.scope);
    }).catch(cause => { if (active) setError(webErrorMessage(cause, {fallback:"对话暂时无法打开。"})); });
    return () => { active = false; };
  }, [geoId, projectId, sessionId, attempt, canRun]);
  useFitToScroller(pane, Boolean(scope));
  useLayoutEffect(() => {
    if (!pane.current || !scope) return undefined;
    const element = pane.current;
    const withdraw = registerTaskPane({ element, projectId, sessionId, scope, owner });
    return withdraw;
  }, [projectId, sessionId, scope, owner]);
  if (!canRun) return <PreservedConversation projectId={projectId} sessionId={sessionId} scope={{kind:"geo",geoProjectId:geoId,sessionId}} />;
  if (error) return <LoadError message={error} onRetry={() => setAttempt(value => value + 1)} />;
  return <div ref={pane} aria-label="项目对话" className="min-h-96 flex-none" />;
}
