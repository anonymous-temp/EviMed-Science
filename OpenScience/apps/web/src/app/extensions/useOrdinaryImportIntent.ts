import { useCallback, useEffect, useState } from "react";
import { fetchWebMe, invalidateWebMe } from "@/lib/apiClient";
import { sessionGeneration, subscribeSessionBoundary } from "@/lib/sessionLifecycle";
import { useProjectStore } from "@/lib/projects";

export interface OrdinaryImportIntent {
  schemaVersion: 1; userId: string; tenantId: string; projectId: string;
  resourceId: string; title: string; idempotencyKey: string;
}
type Ready = { phase: "ready"; key: string; generation: number; userId: string; tenantId: string; projectId: string; intent: OrdinaryImportIntent | null };
type State = Ready | { phase: "checking" } | { phase: "error"; message: string };
const PREFIX = "evimed:ordinary-skill-import:v1:";
const unavailable = "无法保存导入确认记录。请允许当前标签页使用会话存储后重试；确认导入暂不可用。";
const validText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
function readIntent(value: string | null, scope: Pick<Ready, "userId" | "tenantId" | "projectId">): OrdinaryImportIntent | null {
  if (value === null) return null;
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== "object") throw new Error(unavailable);
  const item = data as OrdinaryImportIntent;
  if (Object.keys(item).length !== 7 || item.schemaVersion !== 1 || item.userId !== scope.userId || item.tenantId !== scope.tenantId || item.projectId !== scope.projectId
    || !validText(item.resourceId, 160) || !validText(item.title, 240) || !validText(item.idempotencyKey, 160)) throw new Error(unavailable);
  return item;
}

/** Tab-local intent metadata is a recovery pointer, never authority; every replay still passes server authentication. */
export function useOrdinaryImportIntent(projectId: string) {
  const [revision, setRevision] = useState(0), [state, setState] = useState<State>({ phase: "checking" });
  const reload = useCallback(() => { setState({ phase: "checking" }); setRevision(value => value + 1); }, []);
  useEffect(() => subscribeSessionBoundary(reload), [reload]);
  useEffect(() => {
    let active = true;
    const generation = sessionGeneration();
    setState({ phase: "checking" });
    invalidateWebMe();
    void fetchWebMe({ projectId }).then(me => {
      if (!active || generation !== sessionGeneration()) return;
      if (!me || me.project.id !== projectId || !validText(me.user.id, 160)) throw new Error("未能核对当前账户与项目，确认导入暂不可用。");
      const scope = { userId: me.user.id, tenantId: me.tenant?.id ?? me.user.tenantId ?? me.user.id, projectId };
      const key = PREFIX + [scope.userId, scope.tenantId, projectId].map(encodeURIComponent).join(":");
      const probe = key + ":probe";
      try {
        window.sessionStorage.setItem(probe, "1");
        if (window.sessionStorage.getItem(probe) !== "1") throw new Error(unavailable);
        window.sessionStorage.removeItem(probe);
        const intent = readIntent(window.sessionStorage.getItem(key), scope);
        setState({ phase: "ready", key, generation, ...scope, intent });
      } catch { throw new Error(unavailable); }
    }).catch(() => { if (active && generation === sessionGeneration()) setState({ phase: "error", message: "未能核对账户或保存导入确认记录。确认导入暂不可用，请重试；已有技能不受影响。" }); });
    return () => { active = false; };
  }, [projectId, revision]);
  const ready = state.phase === "ready" && state.projectId === projectId && state.generation === sessionGeneration() ? state : null;
  const currentScope = () => ready && ready.generation === sessionGeneration() && useProjectStore.getState().currentId === projectId;
  const owns = (intent: OrdinaryImportIntent) => !!currentScope() && !!ready && intent.userId === ready.userId && intent.tenantId === ready.tenantId && intent.projectId === ready.projectId;
  const save = (input: { resourceId: string; title: string; idempotencyKey: string }): OrdinaryImportIntent => {
    if (!ready || !currentScope()) throw new Error("账户与项目尚未核对，请重试。");
    const intent: OrdinaryImportIntent = { schemaVersion: 1, userId: ready.userId, tenantId: ready.tenantId, projectId, ...input };
    try {
      const previous = readIntent(window.sessionStorage.getItem(ready.key), ready);
      if (previous && JSON.stringify(previous) !== JSON.stringify(intent)) throw new Error(unavailable);
      const value = JSON.stringify(intent);
      window.sessionStorage.setItem(ready.key, value);
      if (window.sessionStorage.getItem(ready.key) !== value) throw new Error(unavailable);
      setState({ ...ready, intent });
      return intent;
    } catch {
      setState({ phase: "error", message: unavailable });
      throw new Error(unavailable);
    }
  };
  const complete = (intent: OrdinaryImportIntent) => {
    if (!ready || !owns(intent)) return false;
    try {
      const stored = readIntent(window.sessionStorage.getItem(ready.key), ready);
      if (stored && stored.idempotencyKey !== intent.idempotencyKey) return false;
      window.sessionStorage.removeItem(ready.key);
      if (window.sessionStorage.getItem(ready.key) !== null) throw new Error(unavailable);
      setState({ ...ready, intent: null });
      return true;
    } catch { setState({ phase: "error", message: "未能清除本次确认记录。记录仍保留，请重试核对后再处理。" }); return false; }
  };
  return { state, ready, reload, owns, save, complete, abandon: complete };
}
export type OrdinaryImportController = ReturnType<typeof useOrdinaryImportIntent>;
