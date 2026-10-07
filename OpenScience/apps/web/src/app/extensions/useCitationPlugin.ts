import { useCallback, useEffect, useRef, useState } from "react";
import {
  listWebPlugins, listWebPluginRevisions, retryWebPlugin, rollbackWebPlugin, saveWebPlugin, WebApiError,
  type WebPluginConfiguration, type WebPluginState,
} from "@/lib/apiClient";

/** The one plugin a project can switch: the citation check. */
const PLUGIN_ID = "dsh-cite";
/** A save is applied when the project is idle; the page looks again every five seconds, two minutes at most. */
const POLL_MS = 5000, POLL_MAX = 24;

/**
 * The citation plugin's state for one project, and the four things a reader can do to it: switch it, set the request
 * timeout, go back to an earlier saved setting, and try again when it did not take.
 *
 * Hidden knowledge: a save does not take effect at once — it is queued and applied when the project has no run in
 * flight — so the state carries a `phase`, and a state still waiting is read again until it settles. One change at a
 * time: two at once would race the same runtime, so the second is refused here, not sent. A 409 means someone else
 * changed it first; the state is re-read and the reader is told, never overwritten.
 */
export function useCitationPlugin(projectId: string) {
  const [plugin, setPlugin] = useState<WebPluginState | null>(null);
  // Two reasons to say something, kept apart: a read that failed (cleared by the next read that works) and a change that was not
  // made (cleared when the reader makes the next one) — a read that succeeds right after a conflict must not wipe the conflict.
  const [loading, setLoading] = useState(true), [readError, setReadError] = useState<string | null>(null), [actionError, setActionError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), running = useRef(false), polls = useRef(0);

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const mine = ++sequence.current;
    try {
      const found = (await listWebPlugins(projectId, signal)).find(item => item.id === PLUGIN_ID) ?? null;
      if (signal.aborted || mine !== sequence.current) return;
      setPlugin(found); setReadError(null);
    } catch {
      if (!signal.aborted && mine === sequence.current) setReadError("插件状态暂时读不到，请稍后重试。");
    } finally {
      if (!signal.aborted && mine === sequence.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller; polls.current = 0;
    setPlugin(null); setLoading(true); setReadError(null); setActionError(null);
    void refresh();
    return () => { controller.abort(); };
  }, [refresh]);

  const waiting = plugin?.phase === "pending" || plugin?.phase === "applying";
  useEffect(() => {
    if (!waiting || busy || polls.current >= POLL_MAX) return;
    const timer = window.setTimeout(() => { polls.current += 1; void refresh(); }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, busy, plugin, refresh]);

  const mutate = useCallback(async (operation: (signal: AbortSignal) => Promise<WebPluginState>) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || running.current) return false;
    running.current = true; ++sequence.current; setBusy(true); setActionError(null);
    try {
      const updated = await operation(signal);
      if (signal.aborted) return false;
      polls.current = 0; setPlugin(updated);
      return true;
    } catch (caught) {
      if (signal.aborted) return false;
      if (caught instanceof WebApiError && caught.status === 409) { setActionError("这个设置刚在别处改过，已刷新，请再操作一次。"); await refresh(); }
      else setActionError(caught instanceof WebApiError && caught.status === 401 ? "登录已失效，请重新登录。" : "操作没有完成，请重试。");
      return false;
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }, [refresh]);

  /** Save the switch and/or the timeout (in milliseconds); what is not given stays as it was saved. */
  const save = useCallback((change: { enabled?: boolean; timeoutMs?: number }) => {
    const desired = plugin?.desired;
    if (!plugin || !desired) return Promise.resolve(false);
    const timeoutMs = change.timeoutMs ?? desired.settings.timeoutMs;
    return mutate(signal => saveWebPlugin(projectId, plugin.id, {
      expectedRevision: desired.revision, enabled: change.enabled ?? desired.enabled,
      settings: plugin.settingsSchema.timeoutMs && timeoutMs !== undefined ? { timeoutMs } : {},
    }, signal));
  }, [mutate, plugin, projectId]);
  const retry = useCallback(() => mutate(signal => retryWebPlugin(projectId, PLUGIN_ID, signal)), [mutate, projectId]);
  const restore = useCallback((target: WebPluginConfiguration) => {
    const desired = plugin?.desired;
    if (!desired) return Promise.resolve(false);
    return mutate(signal => rollbackWebPlugin(projectId, PLUGIN_ID, { expectedRevision: desired.revision, targetRevision: target.revision }, signal));
  }, [mutate, plugin, projectId]);
  const history = useCallback(async () => {
    const signal = lifetime.current?.signal;
    return listWebPluginRevisions(projectId, PLUGIN_ID, signal);
  }, [projectId]);

  return { plugin, loading, error: actionError ?? readError, busy, save, retry, restore, history, reload: refresh };
}
