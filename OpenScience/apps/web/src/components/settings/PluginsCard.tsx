import { useCallback, useEffect, useRef, useState } from "react";
import { Puzzle, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import {
  listWebPlugins, listWebPluginRevisions, removeWebPlugin, retryWebPlugin, rollbackWebPlugin, saveWebPlugin,
  WebApiError, type WebPluginConfiguration, type WebPluginState,
} from "@/lib/apiClient";

interface Draft { revision: number; enabled: boolean; timeout: string }
const toDraft = (config: WebPluginConfiguration): Draft => ({ revision: config.revision, enabled: config.enabled, timeout: config.settings.timeoutMs === undefined ? "" : String(config.settings.timeoutMs) });
const phaseLabels: Record<WebPluginState["phase"], string> = {
  saved: "已保存，首次启动后验证生效",
  pending: "等待应用",
  applying: "正在应用并验证配置",
  effective: "配置已验证生效",
  rolled_back: "应用失败，已恢复上次有效配置",
  unavailable: "插件暂不可用，尚未确认恢复成功",
  failed: "应用失败，尚未确认恢复成功",
};
/** The settings this version of the card knows how to render. A plugin that
 *  declares anything else is shown, but not configured from here. */
const RENDERABLE_SETTINGS = ["timeoutMs"];

/** A new project gets its own form, requests and polling lifetime. */
export function PluginsCard({ projectId }: { projectId: string }) {
  return <ProjectPluginsCard key={projectId} projectId={projectId} />;
}

function ProjectPluginsCard({ projectId }: { projectId: string }) {
  const [plugins, setPlugins] = useState<WebPluginState[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  // One mutation at a time for the whole project: two plugins applying at once
  // would race the same runtime. State, not only a ref, because the header's
  // refresh, the polling timer and every other panel have to be disabled while
  // one runs — a read that starts mid-save lands its pre-save answer on top of
  // the save's own reply and reads back as a version conflict the user never
  // caused. The ref is the re-entrancy guard for two clicks inside one tick,
  // where no re-render has happened yet.
  const [mutating, setMutating] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const readSequence = useRef(0);
  const actionRunning = useRef(false);

  const refresh = useCallback(async (resetPolling = false) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const sequence = ++readSequence.current;
    if (resetPolling) setPollCount(0);
    setFetching(true);
    try {
      const discovered = await listWebPlugins(projectId, signal);
      if (signal.aborted || sequence !== readSequence.current) return;
      setPlugins(discovered);
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

  const pending = plugins.some((item) => item.phase === "pending" || item.phase === "applying");
  useEffect(() => {
    if (!pending || fetching || loadError || mutating || pollCount >= 24) return;
    const timer = window.setTimeout(() => {
      setPollCount((count) => count + 1);
      void refresh();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [pending, fetching, loadError, mutating, pollCount, refresh]);

  // A mutation owns the card while it runs: a read in flight would land on top
  // of its answer, and polling would restart from a state already superseded.
  const beginMutation = useCallback((pluginId: string) => {
    ++readSequence.current;
    setFetching(false);
    setMutating(pluginId);
  }, []);
  const endMutation = useCallback(() => setMutating(null), []);
  const applyUpdate = useCallback((updated: WebPluginState) => {
    setPlugins((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setLoadError(false);
    setPollCount(0);
  }, []);

  return (
    <Card className="mt-5" header={
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-body text-text">项目插件</h2>
          <p className="mt-0.5 text-ui-sm text-muted">当前项目：{projectId}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh(true)} disabled={fetching || mutating !== null} aria-label="刷新插件状态">
          <RefreshCw size={14} aria-hidden="true" />刷新
        </Button>
      </div>
    }>
      {!loaded && fetching ? (
        <div role="status"><span className="sr-only">正在读取插件</span><FilesSkeleton /></div>
      ) : !loaded && loadError ? (
        <EmptyState title="无法读取插件配置" description="请检查连接后重试。" action={<Button onClick={() => void refresh(true)}>重试</Button>} />
      ) : !plugins.length ? (
        <EmptyState icon={Puzzle} title="暂无可配置的插件" description="此项目没有已批准的可配置插件。" />
      ) : (
        <div className="space-y-6">
          {loadError && <div role="alert" className="text-ui-sm text-error">无法刷新插件状态，当前显示上次读取结果。<Button className="ml-2" variant="ghost" size="sm" onClick={() => void refresh(true)}>重试</Button></div>}
          {pending && pollCount >= 24 && <p className="text-ui-sm text-muted">配置仍在等待处理，自动刷新已暂停。可点击“刷新插件状态”继续查看。</p>}
          {plugins.map((item, index) => (
            <div key={item.id} className={index ? "border-t border-border pt-6" : undefined}>
              <PluginPanel
                projectId={projectId} plugin={item} fetching={fetching} loadError={loadError} mutating={mutating}
                lifetime={lifetime} actionRunning={actionRunning}
                onMutationStart={beginMutation} onMutationEnd={endMutation} onUpdated={applyUpdate} onRefresh={refresh}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface PanelProps {
  projectId: string;
  plugin: WebPluginState;
  fetching: boolean;
  loadError: boolean;
  /** Which plugin the card is mutating, if any — including this one. */
  mutating: string | null;
  lifetime: React.MutableRefObject<AbortController | null>;
  actionRunning: React.MutableRefObject<boolean>;
  onMutationStart: (pluginId: string) => void;
  onMutationEnd: () => void;
  onUpdated: (state: WebPluginState) => void;
  onRefresh: (resetPolling?: boolean) => Promise<void>;
}

function PluginPanel({ projectId, plugin, fetching, loadError, mutating, lifetime, actionRunning, onMutationStart, onMutationEnd, onUpdated, onRefresh }: PanelProps) {
  const [draft, setDraft] = useState<Draft | null>(plugin.desired ? toDraft(plugin.desired) : null);
  const busy = mutating === plugin.id;
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<WebPluginConfiguration[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<WebPluginConfiguration | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const historySequence = useRef(0);

  // Status observations never overwrite a form the user has started editing.
  useEffect(() => { setDraft((current) => current ?? (plugin.desired ? toDraft(plugin.desired) : null)); }, [plugin]);

  const loadHistory = async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const sequence = ++historySequence.current;
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      const items = await listWebPluginRevisions(projectId, plugin.id, signal);
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
    onMutationStart(plugin.id);
    ++historySequence.current;
    setHistoryLoading(false);
    setActionError(null);
    setRestoreTarget(null);
    setRemoveOpen(false);
    try {
      const updated = await operation(signal);
      if (signal.aborted) return;
      onUpdated(updated);
      setDraft(updated.desired ? toDraft(updated.desired) : null);
      setConflict(false);
      setHistory(null);
      if (historyOpen) void loadHistory();
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof WebApiError && error.status === 409) {
        setConflict(true);
        await onRefresh();
      } else {
        setActionError(error instanceof WebApiError && error.status === 401
          ? "登录已失效，请重新登录。" : "操作未完成，请重试。你的输入已保留。");
      }
    } finally {
      if (!signal.aborted) { actionRunning.current = false; onMutationEnd(); }
    }
  };

  const desired = plugin.desired;
  const stale = conflict || (draft != null && desired != null && draft.revision !== desired.revision);
  const schema = plugin.settingsSchema;
  const timeoutField = schema.timeoutMs;
  const maxTimeout = Math.min(timeoutField?.max ?? plugin.limits.maxTimeoutMs, 15000);
  const minTimeout = Math.max(timeoutField?.min ?? plugin.limits.minTimeoutMs, 2000);
  const timeout = Number(draft?.timeout);
  const timeoutError = timeoutField && draft && (!draft.timeout.trim() || !Number.isInteger(timeout) || timeout < minTimeout || timeout > maxTimeout)
    ? `请输入 ${minTimeout}–${maxTimeout} 之间的整数。` : undefined;
  const dirty = draft != null && desired != null
    && (draft.enabled !== desired.enabled || (timeoutField != null && draft.timeout !== String(desired.settings.timeoutMs)));
  // The server, not this file, decides what a plugin accepts. What this file
  // decides is whether it can render it — an older bundle facing a newer
  // schema must refuse rather than silently drop a field.
  const unsupportedSettings = Object.keys(schema).some((key) => !RENDERABLE_SETTINGS.includes(key));
  // Any mutation on this card, not only this panel's: a second one would be
  // taken by the re-entrancy guard and dropped, which is a click that looks
  // accepted and does nothing.
  const formDisabled = mutating !== null || unsupportedSettings || !desired;
  const mutationDisabled = formDisabled || fetching || loadError || stale;
  const unverifiedRecovery = plugin.phase === "unavailable" || plugin.phase === "failed";
  const pending = plugin.phase === "pending" || plugin.phase === "applying";

  const adoptLatest = (keepInput: boolean) => {
    if (!desired) return;
    setDraft((current) => keepInput && current ? { ...current, revision: desired.revision } : toDraft(desired));
    setConflict(false);
    setActionError(null);
  };

  return (
    <section aria-label={`插件 ${plugin.id}`} className="space-y-4">
      <div>
        <h3 className="text-ui font-semibold text-text">{plugin.id}</h3>
        <p className="mt-1 text-ui-sm text-muted">已安装版本 {plugin.binaryVersion}</p>
        {plugin.tools.length > 0 && <p className="text-ui-sm text-muted">提供的工具：{plugin.tools.join("、")}</p>}
        <p className="text-ui-sm text-muted">{availabilityText(plugin)}</p>
        {plugin.availableUpdate && (
          <>
            <Button variant="ghost" size="sm" aria-expanded={updateOpen} onClick={() => setUpdateOpen(!updateOpen)}>查看更新</Button>
            {updateOpen && <p className="mt-1 text-ui-sm text-muted">
              插件程序随运行时镜像发布：平台发布包含 {plugin.availableUpdate.version} 的新镜像后，此项目会自动使用新版本，本页无需操作，已保存的配置会保留。
            </p>}
          </>
        )}
        {plugin.removed && <p className="mt-1 text-ui-sm text-muted">此项目已移除该插件：已停用并恢复默认配置，配置历史保留。</p>}
      </div>
      {unsupportedSettings && <p role="alert" className="text-ui-sm text-error">当前程序版本不支持配置，请联系平台管理员。</p>}
      <div className="rounded-input border border-border bg-bg p-3 text-ui-sm">
        <p role="status" className="font-medium text-text">{phaseLabels[plugin.phase]}</p>
        {pending && <p className="mt-1 text-muted">配置将在项目空闲时应用，进行中的任务不会被中断。应用完成前请以已验证生效配置为准。</p>}
        {unverifiedRecovery && <p className="mt-1 text-muted">下方保留上次通过验证的配置记录，当前运行状态尚未确认。</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ConfigurationSummary label="已保存配置" config={plugin.desired} />
          <ConfigurationSummary label="已验证生效配置" title={unverifiedRecovery ? "上次通过验证的配置" : undefined} config={plugin.effective} />
        </div>
      </div>
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
          if (!mutationDisabled && dirty && !timeoutError) {
            void mutate((signal) => saveWebPlugin(projectId, plugin.id,
              { expectedRevision: draft.revision, enabled: draft.enabled, settings: timeoutField ? { timeoutMs: timeout } : {} }, signal));
          }
        }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-ui-sm font-medium text-text">在此项目中启用</p>
              <p className="mt-1 text-ui-sm text-muted">禁用后，此项目将不再加载该插件提供的工具。</p>
            </div>
            <Button variant="ghost" size="sm" role="switch" aria-checked={draft.enabled} aria-label={`启用插件 ${plugin.id}`} disabled={formDisabled} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}>{draft.enabled ? "已启用" : "已禁用"}</Button>
          </div>
          {timeoutField && (
            <div className="max-w-sm">
              <Input label="请求超时（毫秒）" type="number" min={minTimeout} max={maxTimeout} step={1} value={draft.timeout} error={timeoutError} disabled={formDisabled} onChange={(event) => setDraft({ ...draft, timeout: event.target.value })} />
              <p className="mt-1 text-ui-sm text-muted">允许范围：{minTimeout}–{maxTimeout} 毫秒。引用格式和语言由每次任务指定。</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy} disabled={mutationDisabled || !dirty || Boolean(timeoutError)}>保存配置</Button>
            {dirty && <Button variant="ghost" disabled={busy || stale || loadError || fetching} onClick={() => adoptLatest(false)}>撤销未保存修改</Button>}
            {(["rolled_back", "unavailable", "failed"] as const).some((phase) => plugin.phase === phase) && <Button variant="ghost" disabled={mutationDisabled || dirty} onClick={() => void mutate((signal) => retryWebPlugin(projectId, plugin.id, signal))}>重试应用</Button>}
            {!plugin.removed && <Button variant="ghost" disabled={formDisabled || fetching || loadError || stale || dirty} onClick={() => setRemoveOpen(true)}>移除插件</Button>}
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
            <p className="mb-3 text-ui-sm text-muted">恢复历史配置会创建新的配置版本，程序版本保持 {plugin.binaryVersion}。</p>
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
      {restoreTarget && desired && <ConfirmDialog title={`恢复配置版本 ${restoreTarget.revision}`} body={`将采用${configurationText(restoreTarget)}，创建新的配置版本，并等待空闲时应用。程序版本保持 ${plugin.binaryVersion}。`} confirmLabel="恢复配置" onCancel={() => setRestoreTarget(null)} onConfirm={() => {
        if (!mutationDisabled && !dirty) void mutate((signal) => rollbackWebPlugin(projectId, plugin.id, { expectedRevision: desired.revision, targetRevision: restoreTarget.revision }, signal));
      }} />}
      {/* Removal changes what the running project can do, so it confirms first.
          It is not irreversible — the history keeps every revision and the
          switch above turns the plugin back on — and the dialog says so
          instead of offering an undo the apply loop could not honour. */}
      {removeOpen && desired && <ConfirmDialog title={`移除 ${plugin.id}`} body={`将停用该插件，并把此项目的配置恢复为默认值，创建新的配置版本。插件程序仍在运行时镜像中，配置历史保留，可随时重新启用。`} confirmLabel="移除插件" onCancel={() => setRemoveOpen(false)} onConfirm={() => {
        if (!mutationDisabled && !dirty) void mutate((signal) => removeWebPlugin(projectId, plugin.id, { expectedRevision: desired.revision }, signal));
      }} />}
    </section>
  );
}

/** Absence is unknown, never "up to date": nothing on this path asks upstream. */
function availabilityText(plugin: WebPluginState) {
  if (plugin.availability.state === "update-available" && plugin.availableUpdate) {
    return `可更新至 ${plugin.availableUpdate.version}（记录于 ${plugin.availableUpdate.recordedAt.slice(0, 10)}）`;
  }
  if (plugin.availability.state === "current" && plugin.availability.checkedAt) {
    return `已是记录中的最新版本（检查于 ${plugin.availability.checkedAt.slice(0, 10)}）`;
  }
  return "更新信息暂不可用，尚未记录检查结果";
}

function configurationText(config: WebPluginConfiguration) {
  const parts = [`版本 ${config.revision}`, config.enabled ? "已启用" : "已禁用"];
  if (typeof config.settings.timeoutMs === "number") parts.push(`${config.settings.timeoutMs} 毫秒`);
  return parts.join(" · ");
}

function ConfigurationSummary({ label, title = label, config }: { label: string; title?: string; config: WebPluginConfiguration | null }) {
  return <div aria-label={label}><p className="text-muted">{title}</p><p className="mt-1 text-text">{config ? configurationText(config) : "尚未验证生效"}</p></div>;
}
