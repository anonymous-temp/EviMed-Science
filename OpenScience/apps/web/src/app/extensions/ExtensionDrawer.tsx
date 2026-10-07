import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { Input, inputClasses } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { formatClock, formatDay } from "@/lib/format";
import { productErrorMessage } from "@/lib/productClient";
import {
  extensionCatalogue, extensionConnections, extensionHistory, extensionInstallation, extensionSourceUrl, extensionVersion, installExtension, projectExtensions,
  removeExtension, retryExtension, sameExtensionCoordinate, saveProjectExtensions, updateExtension,
  type CatalogueExtension, type ExtensionConnection, type ExtensionInstallation, type ExtensionRevision, type ProjectExtensions,
} from "@/lib/extensionsClient";
import { Link } from "react-router";
import { MissingRecord, orMissing, RecordMissing } from "./MissingRecord";
import { DrawerSection } from "./PlatformSkillDrawer";
import { settingLabel } from "./extensionCopy";

/** The three words a package's state comes down to for a reader: it works, it is getting ready, or it needs something from them. */
export function extensionState(item: Pick<ExtensionInstallation, "effective" | "phase">): "可用" | "准备中" | "需处理" | "已移除" {
  if (item.effective) return "可用";
  if (item.phase === "removed") return "已移除";
  if (["failed", "unsupported", "connection-needed"].includes(item.phase)) return "需处理";
  return "准备中";
}

/**
 * A package of the extension centre — one offered under 「可以添加」 or one the reader added — opened from its row: add it,
 * switch it for this project, set it, give it an account, remove it. The package's own settings are labelled in Chinese
 * (`settingLabel`), and where it came from and its earlier saved versions are under 「高级设置」.
 */
export function ExtensionDrawer({ extensionId, projectId, onClose, onChanged }: { extensionId: string; projectId: string; onClose: () => void; onChanged: (installationId?: string) => void }) {
  const alive = useRef(true), generation = useRef(0), requestKeys = useRef(new Map<string, string>()), working = useRef(false), historyRequest = useRef<number | null>(null);
  const [entry, setEntry] = useState<CatalogueExtension | null>(null), [installation, setInstallation] = useState<ExtensionInstallation | null>(null), [project, setProject] = useState<ProjectExtensions | null>(null), [loaded, setLoaded] = useState(false), [missing, setMissing] = useState(false);
  const [settings, setSettings] = useState<Record<string, string | number | boolean>>({}), [versions, setVersions] = useState<ExtensionRevision[]>([]), [beforeRevision, setBeforeRevision] = useState<number | null>(null), [historyBusy, setHistoryBusy] = useState(false), [historyError, setHistoryError] = useState<string | null>(null);
  const [connections, setConnections] = useState<ExtensionConnection[]>([]), [connectionRefs, setConnectionRefs] = useState<string[]>([]), [connectionError, setConnectionError] = useState<string | null>(null), [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false);
  const load = useCallback(async () => {
    const request = ++generation.current;
    historyRequest.current = null; setHistoryBusy(false);
    try {
      const [discovery, item, selection] = await Promise.all([extensionCatalogue(), extensionId.startsWith("extension:") ? orMissing(extensionInstallation(extensionId)) : Promise.resolve(null), projectExtensions(projectId)]);
      const descriptor = discovery.items.find(candidate => candidate.id === (item?.catalogueId ?? extensionId)) ?? null;
      if (!descriptor && !item) throw new RecordMissing();
      const exact = descriptor && (!item || (item.integrity === descriptor.integrity && sameExtensionCoordinate(item.coordinate, descriptor.coordinate)));
      const [history, available] = await Promise.allSettled([item ? extensionHistory(item.id) : Promise.resolve({ items: [], nextBeforeRevision: null }), exact && item ? extensionConnections(descriptor.id, projectId) : Promise.resolve({ items: [], supportedKinds: [] })]);
      const selected = selection.selections.find(row => row.installationId === item?.id);
      if (alive.current && request === generation.current) {
        setEntry(descriptor); setInstallation(item); setProject(selection); setLoaded(true); setError(null); setMissing(false);
        setSettings(selected?.settings ?? (exact && descriptor ? Object.fromEntries(Object.entries(descriptor.settingsSchema).filter(([, field]) => field.default !== undefined).map(([key, field]) => [key, field.default!])) : {}));
        setConnectionRefs(selected?.connectionRefs ?? []);
        setConnectionsLoaded(!!exact && !!item && available.status === "fulfilled");
        setConnections(available.status === "fulfilled" ? available.value.items : []); setConnectionError(available.status === "rejected" ? productErrorMessage(available.reason) : null);
        setVersions(history.status === "fulfilled" ? history.value.items : []); setBeforeRevision(history.status === "fulfilled" ? history.value.nextBeforeRevision : null); setHistoryError(history.status === "rejected" ? productErrorMessage(history.reason) : null);
      }
    } catch (caught) {
      if (!alive.current || request !== generation.current) return;
      // A package that is not there is its own state, not an error to retry; any other failure keeps the line and 刷新.
      if (caught instanceof RecordMissing) { setMissing(true); setError(null); } else setError(productErrorMessage(caught));
    }
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
  const save = (enabled: boolean) => act(async () => {
    if (!installation || !project || !canConfigure) return;
    await saveProjectExtensions(projectId, project.revision, [...project.selections.filter(row => row.installationId !== installation.id), { installationId: installation.id, enabled, settings, connectionRefs }]);
  });
  const add = () => act(async () => {
    if (!entry) return;
    const identity = JSON.stringify(entry.coordinate), key = requestKeys.current.get(identity) ?? crypto.randomUUID(); requestKeys.current.set(identity, key);
    const added = await installExtension(entry.coordinate, key); requestKeys.current.delete(identity);
    if (alive.current) onChanged(added.installation.id);
  });
  const state = installation ? extensionState(installation) : null;
  if (missing) return <Drawer title="插件" onClose={onClose}><MissingRecord noun="插件" list="回到插件列表" onBack={onClose} /></Drawer>;
  return (
    <Drawer title={entry?.title ?? "插件"} description={state ? `我的插件 · ${state}` : "可以添加"} onClose={onClose}>
      {error && <p role="alert" className="mb-4 text-ui text-error">{error}<Button variant="text" disabled={busy} onClick={() => void load()}>刷新</Button></p>}
      {!loaded ? !error && <FilesSkeleton /> : coordinate && <div className="flex flex-col gap-6">
        {!installation ? <div><Button loading={busy} onClick={() => void add()}>添加到我的插件</Button></div> : <>
          {!exactDescriptor && <p className="text-ui text-text-2">当前安装版本的配置暂不可编辑。</p>}
          {entry && !exactDescriptor && <div><Button variant="secondary" disabled={busy} onClick={() => void act(() => updateExtension(installation.id, installation.revision, entry.coordinate))}>{sameExtensionCoordinate(installation.coordinate, entry.coordinate) ? "重新获取最新版" : "更新到最新版"}</Button></div>}
          {selectionMismatch && <p className="text-ui text-text-2">当前项目用的是这个插件的另一个版本。移出当前项目后可重新选用当前版本。</p>}
          {(selectionMismatch || unavailableConnection) && selected && project && <div><Button variant="text" disabled={busy} onClick={() => void act(() => saveProjectExtensions(projectId, project.revision, project.selections.filter(row => row.installationId !== installation.id)))}>移出当前项目</Button></div>}
          {exactDescriptor && <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(selected?.enabled ?? true); }}>
            {Object.entries(exactDescriptor.settingsSchema).map(([name, field]) => field.type === "boolean" ? <Switch key={name} label={settingLabel(name)} showLabel checked={settings[name] === true} disabled={busy || !canConfigure} onChange={checked => setSettings({ ...settings, [name]: checked })} />
              : field.enum ? <label key={name} className="text-ui text-text">{settingLabel(name)}<select className={inputClasses({ className: "mt-2" })} value={String(settings[name] ?? "")} disabled={busy || !canConfigure} onChange={event => setSettings({ ...settings, [name]: event.target.value })}><option value="">请选择</option>{field.enum.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
                : <Input key={name} label={settingLabel(name)} type={field.type === "string" ? "text" : "number"} step={field.type === "number" ? "any" : field.type === "integer" ? 1 : undefined} min={field.min} max={field.max} maxLength={field.maxLength} value={settings[name] === undefined ? "" : String(settings[name])} disabled={busy || !canConfigure} onChange={event => { if (!event.target.value) { const next = { ...settings }; delete next[name]; setSettings(next); } else setSettings({ ...settings, [name]: field.type === "string" ? event.target.value : Number(event.target.value) }); }} />)}
            {connectionError && <p role="alert" className="text-ui text-error">{connectionError}<Button type="button" variant="text" disabled={busy} onClick={() => void load()}>重试账户连接</Button></p>}
            {unavailableConnection && <div className="flex flex-col items-start gap-2"><p className="text-ui text-text-2">部分账户连接已不可用。移除后可重新选用账户。</p><Button type="button" variant="text" disabled={busy} onClick={() => setConnectionRefs(current => current.filter(ref => connections.some(connection => connection.id === ref)))}>移除不可用连接</Button></div>}
            {connections.length > 0 && <fieldset className="flex flex-col gap-3"><legend className="mb-2 text-ui font-medium text-text">选用账户</legend>{connections.map(connection => <label key={connection.id} className="flex items-center gap-3 text-ui text-text"><Input type="checkbox" className="h-4 w-4" aria-label={connection.title} checked={connectionRefs.includes(connection.id)} disabled={busy || !canConfigure} onChange={event => setConnectionRefs(current => event.target.checked ? [...current, connection.id] : current.filter(ref => ref !== connection.id))} />{connection.title}</label>)}</fieldset>}
            <div className="flex flex-wrap gap-2"><Button type="submit" loading={busy} disabled={!canConfigure}>{selected ? "保存" : "用于当前项目"}</Button>{selected && <Button type="button" variant="text" disabled={busy || !canConfigure} onClick={() => void save(!selected.enabled)}>{selected.enabled ? "停用" : "启用"}</Button>}<Link to="/app/account?tab=connectors" className="self-center text-ui text-accent">连接账户</Link></div>
          </form>}
          {installation.phase === "failed" && <div><Button variant="secondary" disabled={busy} onClick={() => void act(() => retryExtension(installation.id, installation.revision))}>重新准备</Button></div>}
          <Disclosure summary="高级设置">
            <div className="flex flex-col gap-4 pt-2">
              <DrawerSection title="来源"><a className="text-ui text-accent" href={extensionSourceUrl(coordinate)} target="_blank" rel="noopener noreferrer">查看来源（版本 {extensionVersion(coordinate)}）</a></DrawerSection>
              <DrawerSection title="安装记录">
                {historyError && <p role="alert" className="text-ui text-error">{historyError}<Button variant="text" disabled={busy || historyBusy} onClick={() => void moreHistory(beforeRevision)}>重试读取</Button></p>}
                {versions.map(version => <p key={version.revision} className="py-1 text-ui text-text-2">{formatDay(version.recordedAt)} {formatClock(version.recordedAt)} · 版本 {extensionVersion(version.coordinate)}{version.removed ? " · 已移除" : ""}</p>)}
                {beforeRevision !== null && <div><Button variant="text" disabled={busy || historyBusy} loading={historyBusy} onClick={() => void moreHistory(beforeRevision)}>更早的记录</Button></div>}
              </DrawerSection>
            </div>
          </Disclosure>
          <div><Button variant="text" destructive disabled={busy} onClick={() => setRemoving(true)}>移除插件</Button></div>
        </>}
      </div>}
      {removing && installation && <ConfirmDialog title="移除插件" body="从我的插件移除。正在执行的任务会继续使用它原有的版本。" confirmLabel="移除" busy={busy} onCancel={() => setRemoving(false)} onConfirm={() => void act(async () => { await removeExtension(installation.id, installation.revision); if (alive.current) { onChanged(); onClose(); } })} />}
    </Drawer>
  );
}
