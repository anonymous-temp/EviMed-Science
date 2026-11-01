import { useCallback, useEffect, useRef, useState } from "react";
import { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, WEB_SESSION_SYNC_STORAGE_KEY } from "./apiClient";
import type { EvimedSearchCategory } from "./evimedSearchClient";
import { readEvimedSearchTopics, type EvimedSearchTopics } from "./evimedSearchTopicsClient";
import { productErrorMessage } from "./productClient";

type TopicsState = { key: string; status: "loading" }
  | { key: string; scope: string; status: "success"; data: EvimedSearchTopics; refreshing: boolean; refreshError?: string }
  | { key: string; status: "error"; message: string };

/** A homepage read belongs to its mounted project and category; no feed survives in shared or persistent browser storage. */
export function useEvimedSearchTopics(projectId: string | null, category: EvimedSearchCategory) {
  const [revision, setRevision] = useState(0);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [state, setState] = useState<TopicsState>({ key: "", status: "loading" });
  const scope = JSON.stringify([projectId, category, sessionRevision]);
  const requestKey = JSON.stringify([scope, revision]);
  const latestKey = useRef(requestKey);
  const activeController = useRef<AbortController | null>(null);
  latestKey.current = requestKey;
  const retry = useCallback(() => setRevision(value => value + 1), []);
  const invalidate = useCallback(() => {
    activeController.current?.abort();
    setSessionRevision(value => value + 1);
  }, []);

  useEffect(() => {
    const end = () => {
      activeController.current?.abort();
      setState({ key: latestKey.current, status: "error", message: "登录已失效，请重新登录后查看主题。" });
    };
    const sync = (event: StorageEvent) => {
      if (event.key !== WEB_SESSION_SYNC_STORAGE_KEY && event.key !== null) return;
      try {
        if (event.newValue && JSON.parse(event.newValue)?.kind === "started") { invalidate(); return; }
      } catch { /* An unknown session signal still invalidates private feed data. */ }
      end();
    };
    window.addEventListener(WEB_SESSION_STARTED_EVENT, invalidate);
    window.addEventListener(WEB_SESSION_ENDED_EVENT, end);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WEB_SESSION_STARTED_EVENT, invalidate);
      window.removeEventListener(WEB_SESSION_ENDED_EVENT, end);
      window.removeEventListener("storage", sync);
    };
  }, [invalidate]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    activeController.current = controller;
    setState(previous => previous.status === "success" && previous.scope === scope
      ? { ...previous, key: requestKey, refreshing: true, refreshError: undefined }
      : { key: requestKey, status: "loading" });
    void readEvimedSearchTopics(projectId, category, controller.signal).then(data => {
      if (!controller.signal.aborted && latestKey.current === requestKey) setState({ key: requestKey, scope, status: "success", data, refreshing: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && latestKey.current === requestKey) setState(previous => previous.status === "success" && previous.scope === scope
        ? { ...previous, key: requestKey, refreshing: false, refreshError: productErrorMessage(error) }
        : { key: requestKey, status: "error", message: productErrorMessage(error) });
    });
    return () => {
      controller.abort();
      if (activeController.current === controller) activeController.current = null;
    };
  }, [projectId, category, requestKey, scope]);

  const current: TopicsState = state.key === requestKey ? state : state.status === "success" && state.scope === scope
    ? { ...state, key: requestKey, refreshing: true, refreshError: undefined }
    : { key: requestKey, status: "loading" };
  return { state: current, retry, requestKey };
}
