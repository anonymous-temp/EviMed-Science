import { useCallback, useEffect, useRef, useState } from "react";
import { Puzzle, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import {
  listWebPlugins, listWebPluginRevisions, retryWebPlugin, rollbackWebPlugin, saveWebPlugin,
  WebApiError, type WebPluginConfiguration, type WebPluginState,
} from "@/lib/apiClient";

interface Draft { revision: number; enabled: boolean; timeout: string }
const toDraft = (config: WebPluginConfiguration): Draft => ({ revision: config.revision, enabled: config.enabled, timeout: String(config.settings.timeoutMs) });
const phaseLabels: Record<WebPluginState["phase"], string> = {
  saved: "已保存，首次启动后验证生效",
  pending: "等待应用",
  applying: "正在应用并验证配置",
  effective: "配置已验证生效",
  rolled_back: "应用失败，已恢复上次有效配置",
  unavailable: "插件暂不可用，尚未确认恢复成功",
  failed: "应用失败，尚未确认恢复成功",
};

/** A new project gets its own form, requests and polling lifetime. */
export function PluginsCard({ projectId }: { projectId: string }) {
  return <ProjectPluginsCard key={projectId} projectId={projectId} />;
}

function ProjectPluginsCard({ projectId }: { projectId: string }) {
  const [plugin, setPlugin] = useState<WebPluginState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<WebPluginConfiguration[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<WebPluginConfiguration | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const readSequence = useRef(0);
  const historySequence = useRef(0);
  const actionRunning = useRef(false);

  const refresh = useCallback(async (resetPolling = false) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const sequence = ++readSequence.current;
    if (resetPolling) setPollCount(0);
    setFetching(true);
    try {
      const plugins = await listWebPlugins(projectId, signal);
      if (signal.aborted || sequence !== readSequence.current) return;
      const item = plugins.find((entry) => entry.id === "dsh-cite") ?? null;
      setPlugin(item);
      // Status observations never overwrite a form the user has started editing.
      setDraft((current) => current ?? (item?.desired ? toDraft(item.desired) : null));
      setLoaded(true);
      setLoadError(false);
    } catch {
      if (!signal.aborted && sequence === readSequence.current) setLoadError(true);
    } finally {
      if (!signal.aborted && sequence === readSequence.current) setFetching(false);
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void refresh();
    return () => { controller.abort(); };
  }, [refresh]);

  const pending = plugin?.phase === "pending" || plugin?.phase === "applying";
  useEffect(() => {
    if (!pending || fetching || busy || loadError || pollCount >= 24) return;
    const timer = window.setTimeout(() => {
      setPollCount((count) => count + 1);
      void refresh();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [pending, fetching, busy, loadError, pollCount, refresh]);

  const loadHistory = async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const sequence = ++historySequence.current;
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      const items = await listWebPluginRevisions(projectId, signal);
      if (!signal.aborted && sequence === historySequence.current) setHistory(items);
    } catch {
      if (!signal.aborted && sequence === historySequence.current) setHistoryError(true);
    } finally {
      if (!signal.aborted && sequence === historySequence.current) setHistoryLoading(false);
    }
  };

  const mutate = async (operation: (signal: AbortSignal) => Promise<WebPluginState>) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || actionRunning.current) return;
    actionRunning.current = true;
    ++readSequence.current;
    ++historySequence.current;
    setFetching(false);
    setHistoryLoading(false);
    setBusy(true);
    setActionError(null);
    setRestoreTarget(null);
    try {
      const updated = await operation(signal);
      if (signal.aborted) return;
      setPlugin(updated);
      setDraft(updated.desired ? toDraft(updated.desired) : null);
      setConflict(false);
      setLoadError(false);
      setPollCount(0);
      setHistory(null);
      if (historyOpen) void loadHistory();
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof WebApiError && error.status === 409) {
        setConflict(true);
        await refresh();
      } else {
        setActionError(error instanceof WebApiError && error.status === 401
          ? "登录已失效，请重新登录。" : "操作未完成，请重试。你的输入已保留。");
      }
    } finally {
      if (!signal.aborted) { actionRunning.current = false; setBusy(false); }
    }
  };

  const desired = plugin?.desired;
  const stale = conflict || (draft != null && desired != null && draft.revision !== desired.revision);
  const maxTimeout = Math.min(plugin?.limits.maxTimeoutMs ?? 15000, 15000);
  const minTimeout = Math.max(plugin?.limits.minTimeoutMs ?? 2000, 2000);
  const timeout = Number(draft?.timeout);
  const timeoutError = draft && (!draft.timeout.trim() || !Number.isInteger(timeout) || timeout < minTimeout || timeout > maxTimeout)
    ? `请输入 ${minTimeout}–${maxTimeout} 之间的整数。` : undefined;
  const dirty = draft != null && desired != null && (draft.enabled !== desired.enabled || draft.timeout !== String(desired.settings.timeoutMs));
  const unsupportedBinary = plugin != null && plugin.binaryVersion !== "0.3.2";
  const formDisabled = busy || unsupportedBinary || !desired;
  const mutationDisabled = formDisabled || fetching || loadError || stale;
  const unverifiedRecovery = plugin?.phase === "unavailable" || plugin?.phase === "failed";

  const adoptLatest = (keepInput: boolean) => {
    if (!desired) return;
    setDraft((current) => keepInput && current ? { ...current, revision: desired.revision } : toDraft(desired));
    setConflict(false);
    setActionError(null);
  };

  return (
    <Card className="mt-5" header={
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-body text-text">项目插件</h2>
          <p className="mt-0.5 text-ui-sm text-muted">当前项目：{projectId}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh(true)} disabled={fetching || busy} aria-label="刷新插件状态">
          <RefreshCw size={14} aria-hidden="true" />刷新
        </Button>
      </div>
    }>
      {!loaded && fetching ? (
        <div role="status"><span className="sr-only">正在读取插件</span><FilesSkeleton /></div>
      ) : !loaded && loadError ? (
        <EmptyState title="无法读取插件配置" description="请检查连接后重试。" action={<Button onClick={() => void refresh(true)}>重试</Button>} />
      ) : !plugin ? (
        <EmptyState icon={Puzzle} title="暂无可配置的插件" description="此项目没有已批准的可配置插件。" />
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="text-ui font-semibold text-text">dsh-cite</h3>
            <p className="mt-1 text-ui-sm text-muted">已安装版本 {plugin.binaryVersion}</p>
            <p className="text-ui-sm text-muted">暂无可用的程序版本更新</p>
          </div>
          {unsupportedBinary && <p role="alert" className="text-ui-sm text-error">当前程序版本不支持配置，请联系平台管理员。</p>}
          <div className="rounded-input border border-border bg-bg p-3 text-ui-sm">
            <p role="status" className="font-medium text-text">{phaseLabels[plugin.phase]}</p>
            {pending && <p className="mt-1 text-muted">配置将在项目空闲时应用，进行中的任务不会被中断。应用完成前请以已验证生效配置为准。</p>}
            {unverifiedRecovery && <p className="mt-1 text-muted">下方保留上次通过验证的配置记录，当前运行状态尚未确认。</p>}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <ConfigurationSummary label="已保存配置" config={plugin.desired} />
              <ConfigurationSummary label="已验证生效配置" title={unverifiedRecovery ? "上次通过验证的配置" : undefined} config={plugin.effective} />
            </div>
          </div>
          {loadError && <div role="alert" className="text-ui-sm text-error">无法刷新插件状态，当前显示上次读取结果。<Button className="ml-2" variant="ghost" size="sm" onClick={() => void refresh(true)}>重试</Button></div>}
          {pending && pollCount >= 24 && <p className="text-ui-sm text-muted">配置仍在等待处理，自动刷新已暂停。可点击“刷新插件状态”继续查看。</p>}
          {stale && (
            <div role="alert" className="rounded-input border border-border p-3 text-ui-sm text-text">
              <p>配置版本已发生变化，你的未保存输入已保留。请核对最新配置后继续。</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" disabled={busy || fetching || loadError} onClick={() => adoptLatest(true)}>保留输入并采用最新版本</Button>
                <Button size="sm" variant="ghost" disabled={busy || fetching || loadError} onClick={() => adoptLatest(false)}>载入已保存配置</Button>
              </div>
            </div>
          )}
          {actionError && <p role="alert" className="text-ui-sm text-error">{actionError}</p>}
          {draft && (
            <form className="space-y-4" noValidate onSubmit={(event) => {
              event.preventDefault();
              if (!mutationDisabled && dirty && !timeoutError) void mutate((signal) => saveWebPlugin(projectId, { expectedRevision: draft.revision, enabled: draft.enabled, settings: { timeoutMs: timeout } }, signal));
            }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-ui-sm font-medium text-text">项目引用工具</p>
                  <p className="mt-1 text-ui-sm text-muted">禁用后，此项目将不再提供插件的引用工具。</p>
                </div>
                <Button variant="ghost" size="sm" role="switch" aria-checked={draft.enabled} aria-label="启用项目引用工具" disabled={formDisabled} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}>{draft.enabled ? "已启用" : "已禁用"}</Button>
              </div>
              <div className="max-w-sm">
                <Input label="请求超时（毫秒）" type="number" min={minTimeout} max={maxTimeout} step={1} value={draft.timeout} error={timeoutError} disabled={formDisabled} onChange={(event) => setDraft({ ...draft, timeout: event.target.value })} />
                <p className="mt-1 text-ui-sm text-muted">允许范围：{minTimeout}–{maxTimeout} 毫秒。引用格式和语言由每次任务指定。</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" loading={busy} disabled={mutationDisabled || !dirty || Boolean(timeoutError)}>保存配置</Button>
                {dirty && <Button variant="ghost" disabled={busy || stale || loadError || fetching} onClick={() => adoptLatest(false)}>撤销未保存修改</Button>}
                {(["rolled_back", "unavailable", "failed"] as const).some((phase) => plugin.phase === phase) && <Button variant="ghost" disabled={mutationDisabled || dirty} onClick={() => void mutate((signal) => retryWebPlugin(projectId, signal))}>重试应用</Button>}
              </div>
            </form>
          )}
          <div className="border-t border-border pt-4">
            <Button variant="ghost" size="sm" aria-expanded={historyOpen} onClick={() => {
              setHistoryOpen(!historyOpen);
              if (!historyOpen) void loadHistory();
            }}>配置历史</Button>
            {historyOpen && (
              <div className="mt-3">
                <p className="mb-3 text-ui-sm text-muted">恢复历史配置会创建新的配置版本，程序版本保持 0.3.2。</p>
                {historyLoading ? <div role="status"><span className="sr-only">正在读取配置历史</span><FilesSkeleton /></div>
                  : historyError ? <EmptyState title="无法读取配置历史" action={<Button onClick={() => void loadHistory()}>重试读取历史</Button>} />
                    : !history?.length ? <EmptyState title="暂无配置历史" />
                      : <ul className="divide-y divide-border">{history.map((item) => (
                        <li key={item.revision} className="flex flex-wrap items-center justify-between gap-3 py-3 text-ui-sm text-text">
                          <span>{configurationText(item)}</span>
                          <Button variant="ghost" size="sm" disabled={mutationDisabled || dirty || item.revision === desired?.revision} onClick={() => setRestoreTarget(item)}>恢复配置版本 {item.revision}</Button>
                        </li>
                      ))}</ul>}
              </div>
            )}
          </div>
        </div>
      )}
      {restoreTarget && desired && <ConfirmDialog title={`恢复配置版本 ${restoreTarget.revision}`} body={`将采用${configurationText(restoreTarget)}，创建新的配置版本，并等待空闲时应用。程序版本保持 0.3.2。`} confirmLabel="恢复配置" onCancel={() => setRestoreTarget(null)} onConfirm={() => {
        if (!mutationDisabled && !dirty) void mutate((signal) => rollbackWebPlugin(projectId, { expectedRevision: desired.revision, targetRevision: restoreTarget.revision }, signal));
      }} />}
    </Card>
  );
}

function configurationText(config: WebPluginConfiguration) {
  return `版本 ${config.revision} · ${config.enabled ? "已启用" : "已禁用"} · ${config.settings.timeoutMs} 毫秒`;
}

function ConfigurationSummary({ label, title = label, config }: { label: string; title?: string; config: WebPluginConfiguration | null }) {
  return <div aria-label={label}><p className="text-muted">{title}</p><p className="mt-1 text-text">{config ? configurationText(config) : "尚未验证生效"}</p></div>;
}
