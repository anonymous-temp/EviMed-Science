import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Puzzle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { EmptyState } from "@/components/cards/EmptyState";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { useProjectStore } from "@/lib/projects";
import { PluginsCard } from "@/components/settings/PluginsCard";
import { productErrorMessage, productRequest } from "@/lib/productClient";
import { extensionCatalogue, extensionInstallations, extensionStatus, installExtension, type CatalogueExtension, type ExtensionInstallation } from "@/lib/extensionsClient";
import { ExtensionsNavigation } from "./ExtensionsNavigation";

export function PluginsPage() {
  const navigate = useNavigate(), alive = useRef(true), requestKeys = useRef(new Map<string, string>()), generation = useRef(0), pageRequest = useRef<number | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueExtension[] | null>(null), [installed, setInstalled] = useState<ExtensionInstallation[]>([]);
  const [query, setQuery] = useState(""), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(async () => {
    const request = ++generation.current; pageRequest.current = null; setLoadingMore(false);
    try { const [discovery, library] = await Promise.all([extensionCatalogue(), extensionInstallations()]); if (alive.current && request === generation.current) { setCatalogue(discovery.items); setInstalled(library.items); setCursor(library.nextCursor); setError(null); } }
    catch (caught) { if (alive.current && request === generation.current) setError(productErrorMessage(caught)); }
  }, []);
  useEffect(() => { const requests = generation; alive.current = true; void load(); return () => { alive.current = false; requests.current++; }; }, [load]);
  const more = async () => {
    if (!cursor || pageRequest.current !== null) return;
    const request = generation.current; pageRequest.current = request; setLoadingMore(true);
    try { const page = await extensionInstallations(cursor); if (alive.current && request === generation.current) { setInstalled(current => [...new Map([...current, ...page.items].map(item => [item.id, item])).values()]); setCursor(page.nextCursor); setError(null); } }
    catch (caught) { if (alive.current && request === generation.current) setError(productErrorMessage(caught)); }
    finally { if (pageRequest.current === request) { pageRequest.current = null; if (alive.current) setLoadingMore(false); } }
  };
  const install = async (entry: CatalogueExtension) => {
    if (busy) return;
    const identity = JSON.stringify(entry.coordinate);
    const key = requestKeys.current.get(identity) ?? crypto.randomUUID(); requestKeys.current.set(identity, key); setBusy(entry.id); setError(null);
    try { const outcome = await installExtension(entry.coordinate, key); requestKeys.current.delete(identity); if (alive.current) navigate(`/app/extensions/plugins/${encodeURIComponent(outcome.installation.id)}`); }
    catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { if (alive.current) setBusy(null); }
  };
  const visible = catalogue?.filter(entry => entry.title.toLowerCase().includes(query.toLowerCase()));
  return <PageShell title="插件"><ExtensionsNavigation value="plugins" /><BuiltInPluginInventory />
    {error && <p role="alert" className="my-4 text-ui text-error">{error}<Button variant="text" onClick={() => void load()}>刷新</Button></p>}
    <div className="mt-6"><Input aria-label="搜索插件" placeholder="搜索插件" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {catalogue === null ? !error && <FilesSkeleton /> : <>
      {installed.length > 0 && <section className="mt-6" aria-label="我的插件"><h2 className="mb-2 text-ui font-medium text-text">我的插件</h2><List divided>{installed.filter(item => (catalogue?.find(entry => entry.id === item.catalogueId)?.title ?? item.catalogueId).toLowerCase().includes(query.toLowerCase())).map(item => <ListRow key={item.id} title={catalogue?.find(entry => entry.id === item.catalogueId)?.title ?? item.catalogueId} trailing={<span className="text-caption text-text-3">{extensionStatus(item)}</span>} to={`/app/extensions/plugins/${encodeURIComponent(item.id)}`} leading={<Puzzle size={20} aria-hidden className="text-text-3" />} />)}</List></section>}
      <section className="mt-6" aria-label="发现插件"><h2 className="mb-2 text-ui font-medium text-text">发现</h2>{visible?.length ? <List divided>{visible.map(entry => <ListRow key={entry.id} title={entry.title} to={`/app/extensions/plugins/${encodeURIComponent(entry.id)}`} leading={<Puzzle size={20} aria-hidden className="text-text-3" />} trailing={<span className="text-caption text-text-3">{entry.evidenceState === "saas-qualified" ? "已验证" : "尚未验证"}</span>} actions={<Button variant="text" size="sm" disabled={busy !== null} loading={busy === entry.id} onClick={() => void install(entry)}>添加</Button>} />)}</List> : <EmptyState icon={Puzzle} title={query ? "没有找到插件" : "暂无可添加的插件"} />}</section>
      {cursor && <Button variant="text" disabled={loadingMore} loading={loadingMore} onClick={() => void more()}>更多我的插件</Button>}
    </>}
  </PageShell>;
}

interface BuiltInPlugin {
  id: "dsh-cite" | "dsh-annotation" | "dsh-mermaid"; version: string;
  kind: "tool" | "client"; management: "project" | "deployment";
  configuredEnabled: boolean | null; configurationPhase: string; observation: "unknown";
}
interface PluginInventory { projectId: string; items: BuiltInPlugin[] }
/** Deployment configuration remains separate from marketplace installation and observed runtime readiness. */
function BuiltInPluginInventory() {
  const projectId = useProjectStore(state => state.currentId), alive = useRef(true), requests = useRef(0);
  const [snapshot, setSnapshot] = useState<PluginInventory | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const request = ++requests.current; setSnapshot(null); setError(null); setLoading(true);
    try {
      const value = await productRequest<PluginInventory>(`/projects/${encodeURIComponent(projectId)}/plugin-inventory`);
      if (value.projectId !== projectId) throw new Error("The plugin project changed.");
      if (alive.current && request === requests.current) setSnapshot(value);
    } catch (caught) { if (alive.current && request === requests.current) setError(productErrorMessage(caught)); }
    finally { if (alive.current && request === requests.current) setLoading(false); }
  }, [projectId]);
  useEffect(() => { const counter = requests; alive.current = true; void load(); return () => { alive.current = false; counter.current++; }; }, [load]);
  const current = snapshot?.projectId === projectId ? snapshot : null;
  const names = { "dsh-cite": "文献引用核对", "dsh-annotation": "批注", "dsh-mermaid": "Mermaid 图表" };
  return <section aria-label="内置能力" className="mt-6"><h2 className="mb-2 text-ui font-medium text-text">内置能力</h2>
    {loading ? <p role="status" className="text-ui text-text-2">正在读取内置能力配置</p> : error ? <p role="status" className="text-ui text-error">{error}<Button variant="text" onClick={() => void load()}>重试读取内置能力</Button></p>
      : current && <List divided>{current.items.map(item => <ListRow key={item.id} title={names[item.id]} trailing={<span className="text-caption text-text-3">{item.version}</span>} meta={item.management === "project" ? "项目引用配置见下方；引用服务运行状态尚未确认。" : item.configuredEnabled === false ? "部署已关闭" : item.configuredEnabled === true ? "部署已配置 · 运行状态尚未确认" : "部署配置尚未确认"} />)}</List>}
    <div className="mt-4"><PluginsCard key={projectId} projectId={projectId} /></div>
  </section>;
}
