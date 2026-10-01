import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Input, inputClasses } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/Switch";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { getWebProjectId } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { productErrorMessage } from "@/lib/productClient";
import { extensionCatalogue, extensionConnections, extensionHistory, extensionInstallation, extensionSourceUrl, extensionStatus, extensionVersion, installExtension, projectExtensions, removeExtension, retryExtension, sameExtensionCoordinate, saveProjectExtensions, updateExtension, type CatalogueExtension, type ExtensionConnection, type ExtensionInstallation, type ExtensionRevision, type ProjectExtensions } from "@/lib/extensionsClient";

export function PluginDetailPage() {
  const { extensionId = "" } = useParams(); useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <PluginDetail key={`${extensionId}:${projectId}`} extensionId={extensionId} projectId={projectId} />;
}
function PluginDetail({ extensionId, projectId }: { extensionId: string; projectId: string }) {
  const navigate = useNavigate(), alive = useRef(true), generation = useRef(0), requestKeys = useRef(new Map<string, string>()), working = useRef(false), historyRequest = useRef<number | null>(null);
  const [entry, setEntry] = useState<CatalogueExtension | null>(null), [installation, setInstallation] = useState<ExtensionInstallation | null>(null), [project, setProject] = useState<ProjectExtensions | null>(null), [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Record<string, string | number | boolean>>({}), [versions, setVersions] = useState<ExtensionRevision[]>([]), [beforeRevision, setBeforeRevision] = useState<number | null>(null), [historyBusy, setHistoryBusy] = useState(false), [historyError, setHistoryError] = useState<string | null>(null);
  const [connections, setConnections] = useState<ExtensionConnection[]>([]), [connectionRefs, setConnectionRefs] = useState<string[]>([]), [connectionError, setConnectionError] = useState<string | null>(null), [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false);
  const load = useCallback(async () => {
    const request = ++generation.current;
    historyRequest.current = null; setHistoryBusy(false);
    try {
      const [discovery, item, selection] = await Promise.all([extensionCatalogue(), extensionId.startsWith("extension:") ? extensionInstallation(extensionId) : Promise.resolve(null), projectExtensions(projectId)]);
      const descriptor = discovery.items.find(candidate => candidate.id === (item?.catalogueId ?? extensionId)) ?? null;
      if (!descriptor && !item) throw new Error("找不到这个插件。");
      const exact = descriptor && (!item || (item.integrity === descriptor.integrity && sameExtensionCoordinate(item.coordinate, descriptor.coordinate)));
      const [history, available] = await Promise.allSettled([item ? extensionHistory(item.id) : Promise.resolve({ items: [], nextBeforeRevision: null }), exact && item ? extensionConnections(descriptor.id, projectId) : Promise.resolve({ items: [], supportedKinds: [] })]);
      const selected = selection.selections.find(row => row.installationId === item?.id);
      if (alive.current && request === generation.current) {
        setEntry(descriptor); setInstallation(item); setProject(selection); setLoaded(true); setError(null);
        setSettings(selected?.settings ?? (exact && descriptor ? Object.fromEntries(Object.entries(descriptor.settingsSchema).filter(([, field]) => field.default !== undefined).map(([key, field]) => [key, field.default!])) : {}));
        setConnectionRefs(selected?.connectionRefs ?? []);
        setConnectionsLoaded(!!exact && !!item && available.status === "fulfilled");
        setConnections(available.status === "fulfilled" ? available.value.items : []); setConnectionError(available.status === "rejected" ? productErrorMessage(available.reason) : null);
        setVersions(history.status === "fulfilled" ? history.value.items : []); setBeforeRevision(history.status === "fulfilled" ? history.value.nextBeforeRevision : null); setHistoryError(history.status === "rejected" ? productErrorMessage(history.reason) : null);
      }
    } catch (caught) { if (alive.current && request === generation.current) setError(productErrorMessage(caught)); }
  }, [extensionId, projectId]);
  useEffect(() => { const requests = generation; alive.current = true; void load(); return () => { alive.current = false; requests.current++; }; }, [load]);
  useEffect(() => {
    if (!installation || installation.phase !== "preparing") return;
    let live = true, running = false;
    const timer = setInterval(() => {
      if (running || working.current) return; running = true;
      const request = generation.current;
      void extensionInstallation(installation.id).then(current => { if (live && alive.current && request === generation.current) setInstallation(current); })
        .catch(caught => { if (live && alive.current && request === generation.current) setError(productErrorMessage(caught)); }).finally(() => { running = false; });
    }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [installation]);
  const act = async (work: () => Promise<unknown>) => {
    if (working.current) return; working.current = true; setBusy(true); setError(null);
    try { await work(); if (alive.current) await load(); }
    catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const moreHistory = async (after: number | null) => {
    if (!installation || historyRequest.current !== null) return;
    const request = generation.current; historyRequest.current = request; setHistoryBusy(true); setHistoryError(null);
    try {
      const page = await extensionHistory(installation.id, after);
      if (alive.current && request === generation.current) {
        setVersions(current => [...new Map([...(after === null ? [] : current), ...page.items].map(item => [item.revision, item])).values()]); setBeforeRevision(page.nextBeforeRevision);
      }
    } catch (caught) { if (alive.current && request === generation.current) setHistoryError(productErrorMessage(caught)); }
    finally { if (historyRequest.current === request) { historyRequest.current = null; if (alive.current) setHistoryBusy(false); } }
  };
  const selected = project?.selections.find(row => row.installationId === installation?.id);
  const exactDescriptor = entry && (!installation || (installation.integrity === entry.integrity && sameExtensionCoordinate(installation.coordinate, entry.coordinate))) ? entry : null;
  const unavailableConnection = connectionsLoaded && connectionRefs.some(ref => !connections.some(connection => connection.id === ref));
  const selectionMismatch = !!selected && !!installation && ((!!selected.coordinate && !sameExtensionCoordinate(selected.coordinate, installation.coordinate)) || (!!selected.integrity && selected.integrity !== installation.integrity));
  const canConfigure = !!exactDescriptor && connectionsLoaded && !selectionMismatch && !connectionError && !unavailableConnection;
  const coordinate = installation?.coordinate ?? entry?.coordinate;
  const evidenceState = installation ? installation.evidenceState : entry?.evidenceState;
  const save = (enabled: boolean) => act(async () => {
    if (!installation || !project || !canConfigure) return;
    await saveProjectExtensions(projectId, project.revision, [...project.selections.filter(row => row.installationId !== installation.id), { installationId: installation.id, enabled, settings, connectionRefs }]);
  });
  const add = () => act(async () => {
    if (!entry) return;
    const identity = JSON.stringify(entry.coordinate), key = requestKeys.current.get(identity) ?? crypto.randomUUID(); requestKeys.current.set(identity, key);
    const added = await installExtension(entry.coordinate, key); requestKeys.current.delete(identity);
    if (alive.current) navigate(`/app/extensions/plugins/${encodeURIComponent(added.installation.id)}`);
  });
  return <PageShell title={entry?.title ?? "插件"} actions={<Button variant="text" onClick={() => navigate("/app/extensions/plugins")}>返回</Button>}>
    {error && <p role="alert" className="mb-4 text-ui text-error">{error}<Button variant="text" disabled={busy} onClick={() => void load()}>刷新</Button></p>}
    {!loaded ? !error && <FilesSkeleton /> : coordinate && <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 text-ui text-text-2"><span>版本 {extensionVersion(coordinate)}</span><span>{evidenceState === "saas-qualified" ? "兼容核验通过" : "尚未完成兼容核验"}</span>{installation && <span>{extensionStatus(installation)}</span>}</div>
      <a className="text-ui text-accent" href={extensionSourceUrl(coordinate)} target="_blank" rel="noopener noreferrer">查看来源</a>
      {!installation ? <div><Button loading={busy} onClick={() => void add()}>添加到我的插件</Button></div> : <>
        {!exactDescriptor && <p className="text-ui text-text-2">当前安装版本的配置暂不可编辑。</p>}
        {entry && !exactDescriptor && <div><Button variant="secondary" disabled={busy} onClick={() => void act(() => updateExtension(installation.id, installation.revision, entry.coordinate))}>{sameExtensionCoordinate(installation.coordinate, entry.coordinate) ? "重新获取版本 " : "更新到版本 "}{extensionVersion(entry.coordinate)}</Button></div>}
        {selectionMismatch && selected.coordinate && <p className="text-ui text-text-2">当前项目选用版本 {extensionVersion(selected.coordinate)}。移出当前项目后可重新选用当前安装版本。</p>}
        {(selectionMismatch || unavailableConnection) && selected && project && <div><Button variant="text" disabled={busy} onClick={() => void act(() => saveProjectExtensions(projectId, project.revision, project.selections.filter(row => row.installationId !== installation.id)))}>移出当前项目</Button></div>}
        {exactDescriptor && <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(selected?.enabled ?? true); }}>
          {Object.entries(exactDescriptor.settingsSchema).map(([name, field]) => field.type === "boolean" ? <Switch key={name} label={name} showLabel checked={settings[name] === true} disabled={busy || !canConfigure} onChange={checked => setSettings({ ...settings, [name]: checked })} />
            : field.enum ? <label key={name} className="text-ui text-text">{name}<select className={inputClasses({ className: "mt-2" })} value={String(settings[name] ?? "")} disabled={busy || !canConfigure} onChange={event => setSettings({ ...settings, [name]: event.target.value })}><option value="">请选择</option>{field.enum.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
              : <Input key={name} label={name} type={field.type === "string" ? "text" : "number"} step={field.type === "number" ? "any" : field.type === "integer" ? 1 : undefined} min={field.min} max={field.max} maxLength={field.maxLength} value={settings[name] === undefined ? "" : String(settings[name])} disabled={busy || !canConfigure} onChange={event => { if (!event.target.value) { const next = { ...settings }; delete next[name]; setSettings(next); } else setSettings({ ...settings, [name]: field.type === "string" ? event.target.value : Number(event.target.value) }); }} />)}
          {connectionError && <p role="alert" className="text-ui text-error">{connectionError}<Button type="button" variant="text" disabled={busy} onClick={() => void load()}>重试账户连接</Button></p>}
          {unavailableConnection && <div className="flex flex-col items-start gap-2"><p className="text-ui text-text-2">部分账户连接已不可用。移除后可重新选用账户。</p><Button type="button" variant="text" disabled={busy} onClick={() => setConnectionRefs(current => current.filter(ref => connections.some(connection => connection.id === ref)))}>移除不可用连接</Button></div>}
          {connections.length > 0 && <fieldset className="flex flex-col gap-3"><legend className="mb-2 text-ui font-medium text-text">选用账户</legend>{connections.map(connection => <label key={connection.id} className="flex items-center gap-3 text-ui text-text"><Input type="checkbox" className="h-4 w-4" aria-label={connection.title} checked={connectionRefs.includes(connection.id)} disabled={busy || !canConfigure} onChange={event => setConnectionRefs(current => event.target.checked ? [...current, connection.id] : current.filter(ref => ref !== connection.id))} />{connection.title}</label>)}</fieldset>}
          <div className="flex flex-wrap gap-2"><Button type="submit" loading={busy} disabled={!canConfigure}>{selected ? "保存配置" : "用于当前项目"}</Button>{selected && <Button type="button" variant="text" disabled={busy || !canConfigure} onClick={() => void save(!selected.enabled)}>{selected.enabled ? "停用" : "启用"}</Button>}<Link to="/app/account?tab=connectors" className="self-center text-ui text-accent">连接账户</Link></div>
        </form>}
        {installation.phase === "failed" && <div><Button variant="secondary" disabled={busy} onClick={() => void act(() => retryExtension(installation.id, installation.revision))}>重新准备</Button></div>}
        <section aria-label="插件版本"><h2 className="mb-3 text-ui font-medium text-text">版本记录</h2>{historyError && <p role="alert" className="text-ui text-error">{historyError}<Button variant="text" disabled={busy || historyBusy} onClick={() => void moreHistory(beforeRevision)}>重试版本记录</Button></p>}{versions.map(version => <p key={version.revision} className="py-2 text-ui text-text-2">版本 {extensionVersion(version.coordinate)}{version.removed ? " · 已移除" : ""}</p>)}{beforeRevision !== null && <Button variant="text" disabled={busy || historyBusy} loading={historyBusy} onClick={() => void moreHistory(beforeRevision)}>更早的版本记录</Button>}</section>
        <div><Button variant="text" destructive disabled={busy} onClick={() => setRemoving(true)}>移除插件</Button></div>
      </>}
    </div>}
    {removing && installation && <ConfirmDialog title="移除插件" body="从我的插件移除。正在执行的任务会继续使用它原有的版本。" confirmLabel="移除" busy={busy} onCancel={() => setRemoving(false)} onConfirm={() => void act(async () => { await removeExtension(installation.id, installation.revision); if (alive.current) navigate("/app/extensions/plugins"); })} />}
  </PageShell>;
}
