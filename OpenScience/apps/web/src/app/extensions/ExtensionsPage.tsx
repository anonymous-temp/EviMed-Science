import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronDown, Folder, Plus, Upload } from "lucide-react";
import { RESEARCH_TOOLS_NAME, capabilityListed, searchMatches } from "@evimed/domain";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Menu } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { Switch } from "@/components/ui/Switch";
import { Tooltip } from "@/components/ui/Tooltip";
import { extensionCatalogue, extensionInstallations, installExtension, inventory as loadInventoryOf, projectExtensions, projectBuiltinPlugins, saveProjectBuiltinPlugins, saveProjectExtensions, type BuiltinPluginPolicy, type CatalogueExtension, type Inventory } from "@/lib/extensionsClient";
import { listWebResearchAgents } from "@/lib/apiClient";
import { bindConversationCapability } from "@/lib/dispatch";
import { productErrorMessage } from "@/lib/productClient";
import { researchAgentUi, type CapabilityUi } from "@/lib/researchAgentUi";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { useProjectStore } from "@/lib/projects";
import { useNarrow } from "@/lib/useMediaQuery";
import { toast } from "@/lib/toast";
import { createPersonalSkill, listPersonalSkills, listPlatformSkills, projectPlatformSkills, projectSkills, saveProjectPlatformSkills, saveProjectSkills, type PendingSkillTransfer, type PersonalSkill, type PlatformSkill, type SkillWrite } from "@/lib/skillLibraryClient";
import { CatalogueView, type CatalogueEntry } from "./CatalogueView";
import { SHARED_PROJECT_TEXT, allInstalledExtensions, catalogueOrigins, extensionAvailability, nextDisabled, platformSkillReadOnly, projectChoicesNotApplicable, skillActivationText, skillAdapted, skillOrigin, skillPublisher, skillRepositoryUrl } from "./catalogueModel";
import { SKILL_LOOPX_ICON, SKILL_PACK_ICON } from "./extensionCopy";
import { inventoryIcon } from "./inventoryIcons";
import { ExtensionDrawer } from "./ExtensionDrawer";
import { CitationDrawer, InventoryDrawer } from "./PluginDrawers";
import { PersonalSkillDrawer } from "./PersonalSkillDrawer";
import { PlatformSkillDrawer } from "./PlatformSkillDrawer";
import { SkillEditor } from "./SkillEditor";
import { PendingSkillTransfers, SkillImportForm } from "./SkillImport";
import { useCitationPlugin } from "./useCitationPlugin";
import { useActivationPoll } from "./useActivationPoll";
import { useLoad } from "./useLoad";

type View = "discover" | "installed";
type Kind = "all" | "skills" | "plugins";
type Open = { kind: "platform"; skill: PlatformSkill } | { kind: "create" } | { kind: "import"; recovery?: PendingSkillTransfer } | { kind: "item"; id: string };
const loadFirstPersonal = () => listPersonalSkills();
const loadCatalogue = () => extensionCatalogue();
const loadInstalled = () => allInstalledExtensions(extensionInstallations);

/** Account discovery and project activation share a page, not an implied shared state. */
function Extensions({ tab, itemId, projectId }: { tab: string; itemId?: string; projectId: string }) {
  const navigate = useNavigate();
  const narrow = useNarrow();
  const [params, setParams] = useSearchParams();
  const view: View = tab === "installed" || itemId ? "installed" : "discover";
  const rawType = params.get("type") ?? (tab === "skills" || tab === "plugins" ? tab : "all");
  const type: Kind = rawType === "skills" || rawType === "plugins" ? rawType : "all";
  const query = params.get("q") ?? "", group = params.get("group") ?? "all", origin = params.get("origin") ?? "all";
  const projectName = useProjectStore(state => state.projects.find(project => project.id === projectId)?.name) ?? "当前项目";
  const alive = useRef(true), running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [open, setOpen] = useState<Open | null>(null), [busy, setBusy] = useState<string | null>(null), [importBusy, setImportBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const platform = useLoad(listPlatformSkills);
  const policy = useLoad(useCallback(() => projectPlatformSkills(projectId), [projectId]));
  const personal = useLoad(loadFirstPersonal);
  const selection = useLoad(useCallback(() => projectSkills(projectId), [projectId]));
  const catalogue = useLoad(loadCatalogue), installed = useLoad(loadInstalled);
  const projectPlugins = useLoad(useCallback(() => projectExtensions(projectId), [projectId]));
  const builtinPlugins = useLoad(useCallback(() => projectBuiltinPlugins(projectId), [projectId]));
  const inventory = useLoad(useCallback(() => loadInventoryOf(projectId), [projectId]));
  // The curated research tools: the catalogue 科研工具 reads, through the same filter and names — no second source.
  const tools = useLoad(listWebResearchAgents);
  const curatedTools = useMemo<CapabilityUi[]>(() => tools.state.status === "ready"
    ? tools.state.data.filter(agent => capabilityListed(agent.id)).map(researchAgentUi) : [], [tools.state]);
  const citation = useCitationPlugin(projectId);
  const [more, setMore] = useState<{ items: PersonalSkill[]; cursor: string | null } | null>(null), [loadingMore, setLoadingMore] = useState(false);
  const personalRows = personal.state.status === "ready" ? [...personal.state.data.items, ...(more?.items ?? [])] : [];
  const cursor = more ? more.cursor : personal.state.status === "ready" ? personal.state.data.nextCursor : null;
  const platformData = platform.state.status === "ready" ? platform.state.data : null;
  const currentPolicy = policy.state.status === "ready" ? policy.state.data : null;
  const currentPersonal = selection.state.status === "ready" ? selection.state.data : null;
  const currentPlugins = projectPlugins.state.status === "ready" ? projectPlugins.state.data : null;
  const currentBuiltin = builtinPlugins.state.status === "ready" ? builtinPlugins.state.data : null;
  const inventoryData = inventory.state.status === "ready" ? inventory.state.data : null;
  const catalogueData = catalogue.state.status === "ready" ? catalogue.state.data : null;
  const installedRows = installed.state.status === "ready" ? installed.state.data.items : [];
  // A 循证 GEO project runs on its shared settings: the project's own skill and plugin switches are kept but do not apply
  // there, so its rows say so and draw no switch (a switch that saves and never takes effect is a dead control).
  const shared = projectChoicesNotApplicable(currentPolicy?.activation, currentPersonal?.activation, currentBuiltin?.activation);
  const root = `/app/extensions/${view}`;
  const close = () => { setOpen(null); if (itemId) navigate(root, { replace: true }); };
  const reloadSelections = () => { policy.reload(true); selection.reload(true); builtinPlugins.reload(true); };
  const reloadPersonal = () => { setMore(null); personal.reload(true); reloadSelections(); };
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === "all") next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };
  const clearFilters = () => setParams(tab === "skills" || tab === "plugins" ? { type: "all" } : {}, { replace: true });
  const act = async (id: string, work: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true; setBusy(id); setActionError(null);
    try { await work(); }
    catch (error) { if (alive.current) { setActionError(productErrorMessage(error)); reloadSelections(); projectPlugins.reload(true); } }
    finally { running.current = false; if (alive.current) setBusy(null); }
  };
  const switchPlatform = (skill: PlatformSkill, enabled: boolean) => act(skill.id, async () => {
    if (!currentPolicy) return;
    const updated = await saveProjectPlatformSkills(projectId, currentPolicy.revision, nextDisabled(currentPolicy, skill.id, enabled));
    if (alive.current) { policy.replace(updated); selection.reload(true); builtinPlugins.reload(true); }
  });
  const switchPersonal = (skill: PersonalSkill, enabled: boolean) => act(skill.id, async () => {
    if (!currentPersonal) return;
    const next = currentPersonal.payload.skills.filter(row => row.skillId !== skill.id);
    const updated = await saveProjectSkills(projectId, currentPersonal.revision, enabled ? [...next, { skillId: skill.id, revision: skill.revision }] : next);
    if (alive.current) { selection.replace(updated); policy.reload(true); builtinPlugins.reload(true); }
  });
  const switchBuiltin = (id: string, enabled: boolean) => act(`builtin:${id}`, async () => {
    if (!currentBuiltin) return;
    const disabled = currentBuiltin.payload.disabled.filter(item => item !== id);
    const result = await saveProjectBuiltinPlugins(projectId, currentBuiltin.revision, enabled ? disabled : [...disabled, id]);
    if (alive.current) { builtinPlugins.replace(result); policy.reload(true); selection.reload(true); }
  });
  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listPersonalSkills(cursor);
      if (alive.current) setMore(current => ({ items: [...(current?.items ?? []), ...page.items], cursor: page.nextCursor }));
    } catch (error) { if (alive.current) setActionError(productErrorMessage(error)); }
    finally { if (alive.current) setLoadingMore(false); }
  };
  const keys = useRef(new Map<string, string>());
  const install = (entry: CatalogueExtension) => act(entry.id, async () => {
    const identity = JSON.stringify(entry.coordinate), key = keys.current.get(identity) ?? crypto.randomUUID();
    keys.current.set(identity, key);
    const result = await installExtension(entry.coordinate, key);
    keys.current.delete(identity);
    if (alive.current) { installed.reload(true); navigate(`/app/extensions/plugins/${encodeURIComponent(result.installation.id)}`); }
  });
  const openSkill = (id: string) => { setOpen(null); navigate(`/app/extensions/skills/${encodeURIComponent(id)}`); };
  // A tool is chosen by opening the conversation that runs it, bound before the conversation exists — what its 科研工具 card does.
  const [opening, setOpening] = useState<string | null>(null);
  const openTool = (agent: CapabilityUi) => {
    if (opening) return;
    setOpening(agent.id);
    void bindConversationCapability(null, { agentId: agent.id, agentVersion: agent.version })
      .then(bound => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(undefined, bound.sessionId), capabilityId: agent.id } }))
      // A binding the control plane refused must not strand the reader: the conversation opens, and the router decides as it did before there were tools.
      .catch(() => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } }))
      .finally(() => { if (alive.current) setOpening(null); });
  };
  const openExtension = (id: string) => { setOpen(null); navigate(`/app/extensions/plugins/${encodeURIComponent(id)}`); };
  const entries: CatalogueEntry[] = [];
  // Every skill the runtime carries is listed under its group (owner ruling 2026-10-14): one a project may switch has its
  // switch; one it may not (a standing platform method, one a professional workflow loads, the long task's, the 循证 GEO
  // method pack's index) is listed the same way with no control and no word about it.
  for (const skill of platformData?.items ?? []) {
    const readOnly = platformSkillReadOnly(skill);
    const chosen = currentPolicy?.items.find(item => item.id === skill.id);
    const enabled = chosen?.enabled ?? !currentPolicy?.payload.disabled.includes(skill.id);
    const icon = skill.group === platformData?.geoGroup ? SKILL_PACK_ICON : skill.group === platformData?.loopxGroup ? SKILL_LOOPX_ICON : undefined;
    entries.push({ id: skill.id, title: skill.title, description: skill.use, publisher: skillAdapted(skill) ? `${skillPublisher(skill)} · 已改编` : skillPublisher(skill), type: "skills", group: skill.group, icon,
      origin: skillOrigin(skill), repository: skillOrigin(skill) === "third-party" ? skillRepositoryUrl(skill.provenance?.repository) : null,
      added: true, state: readOnly ? undefined : skillActivationText(enabled, currentPolicy?.activation), open: () => setOpen({ kind: "platform", skill }),
      action: readOnly || shared ? view === "installed" ? undefined : <Button size="sm" variant="text" onClick={() => setOpen({ kind: "platform", skill })}>查看</Button>
        : view === "installed"
          ? <Switch label={`在“${projectName}”里使用${skill.title}`} checked={enabled} disabled={!!busy || !currentPolicy} onChange={checked => void switchPlatform(skill, checked)} />
          : <Button size="sm" variant="text" onClick={() => setOpen({ kind: "platform", skill })}>管理</Button> });
  }
  // The curated research tools, the professional workflows 科研工具 lists: a row opens a new conversation bound to that tool.
  for (const agent of curatedTools) {
    entries.push({ id: `tool:${agent.id}`, title: agent.title, description: agent.description, publisher: "EviMed Science", type: "skills", group: RESEARCH_TOOLS_NAME,
      origin: "first-party", added: true, open: () => openTool(agent),
      action: <Button size="sm" variant="text" loading={opening === agent.id} disabled={!!opening} onClick={() => openTool(agent)}>开始使用</Button> });
  }
  for (const skill of personalRows) {
    const enabled = !!currentPersonal?.payload.skills.some(row => row.skillId === skill.id);
    entries.push({ id: skill.id, title: skill.payload.title, description: skill.payload.description, publisher: "我的技能", type: "skills", group: "我的技能", origin: "personal", added: true,
      state: skillActivationText(enabled, currentPersonal?.activation), open: () => openSkill(skill.id),
      action: view === "installed" && !shared ? <Switch label={`在“${projectName}”里使用${skill.payload.title}`} checked={enabled} disabled={!!busy || !currentPersonal} onChange={checked => void switchPersonal(skill, checked)} /> : undefined });
  }
  for (const entry of catalogueData?.items ?? []) {
    const installation = installedRows.find(item => item.catalogueId === entry.id);
    const selected = currentPlugins?.selections.find(item => item.installationId === installation?.id);
    const publisher = entry.coordinate.kind === "github" ? entry.coordinate.repository.split("/")[0] : entry.coordinate.name;
    const switchPlugin = (enabled: boolean) => act(entry.id, async () => {
      if (!selected || !currentPlugins) return;
      const result = await saveProjectExtensions(projectId, currentPlugins.revision, currentPlugins.selections.map(item => item.installationId === selected.installationId ? { ...item, enabled } : item));
      if (alive.current) projectPlugins.replace(result);
    });
    entries.push({ id: entry.id, title: entry.title, description: "查看插件提供的能力、来源与所需账户连接。", publisher, type: "plugins", group: "插件", added: !!installation,
      origin: "third-party", repository: entry.coordinate.kind === "github" ? skillRepositoryUrl(entry.coordinate.repository) : null,
      state: installation ? shared && selected ? SHARED_PROJECT_TEXT : currentPlugins ? extensionAvailability(installation, selected) : "生效状态待确认" : undefined,
      open: () => { if (installed.state.status === "ready") openExtension(installation?.id ?? entry.id); else setActionError("请先重试读取已添加插件，再查看此项。"); },
      action: !installation ? <Button size="sm" variant="secondary" loading={busy === entry.id} disabled={!!busy || installed.state.status !== "ready"} onClick={() => void install(entry)}>添加</Button>
        : view === "installed" && selected && !shared ? <Switch label={`在“${projectName}”里使用${entry.title}`} checked={selected.enabled} disabled={!!busy} onChange={checked => void switchPlugin(checked)} /> : undefined });
  }
  // An installation remains manageable after its catalogue descriptor is withdrawn.
  for (const item of installedRows.filter(item => !(catalogueData?.items ?? []).some(entry => entry.id === item.catalogueId))) {
    const name = item.coordinate.kind === "npm" ? item.coordinate.name : item.coordinate.repository;
    entries.push({ id: item.id, title: name, description: "查看已添加插件的配置与当前项目状态。", publisher: name, type: "plugins", group: "插件", added: true,
      origin: "third-party", repository: item.coordinate.kind === "github" ? skillRepositoryUrl(item.coordinate.repository) : null,
      state: currentPlugins ? extensionAvailability(item, currentPlugins.selections.find(row => row.installationId === item.id)) : "生效状态待确认", open: () => openExtension(item.id) });
  }
  // Removed account entries can remain pinned in a project; they must never lose their stop control.
  if (installed.state.status === "ready") for (const selected of currentPlugins?.selections ?? []) {
    if (installedRows.some(item => item.id === selected.installationId)) continue;
    const descriptor = catalogueData?.items.find(item => item.id === selected.catalogueId);
    const name = descriptor?.title ?? (selected.coordinate?.kind === "npm" ? selected.coordinate.name : selected.coordinate?.repository) ?? "项目保留的插件";
    const remove = () => act(selected.installationId, async () => {
      if (!currentPlugins) return;
      const result = await saveProjectExtensions(projectId, currentPlugins.revision, currentPlugins.selections.filter(item => item.installationId !== selected.installationId));
      if (alive.current) projectPlugins.replace(result);
    });
    entries.push({ id: `retained:${selected.installationId}`, title: name, description: "已从个人库移除，当前项目仍保留所选版本。", publisher: "项目保留版本", type: "plugins", group: "插件", added: true,
      origin: "third-party", repository: selected.coordinate?.kind === "github" ? skillRepositoryUrl(selected.coordinate.repository) : null,
      state: selected.effective ? "已启用" : selected.enabled ? "生效状态待确认" : "已关闭", open: () => setActionError("这个版本已从个人库移除，可用行末操作将它移出当前项目。"),
      action: <Button size="sm" variant="text" disabled={!!busy} onClick={() => void remove()}>移出当前项目</Button> });
  }
  // What the platform carries that is not switched per project (the long task, memory, the kernel's basics, web reading, the
  // research tool set): listed like any plugin, in the platform's own words, with no control. Memory is its own page.
  for (const item of inventoryData?.groups.flatMap(section => section.items).filter(entry => entry.control.kind === "none") ?? []) {
    entries.push({ id: `builtin:${item.id}`, title: item.title, description: item.use, publisher: item.publisher ?? "EviMed Science", type: "plugins", group: "插件", added: true,
      origin: item.kind === "platform" || !item.publisher ? "first-party" : "third-party", repository: skillRepositoryUrl(item.repository), icon: inventoryIcon(item.icon),
      ...item.opens.kind === "page" ? { to: item.opens.to } : {}, open: () => setOpen({ kind: "item", id: item.id }),
      action: item.opens.kind === "page" || view === "installed" ? undefined : <Button size="sm" variant="text" onClick={() => setOpen({ kind: "item", id: item.id })}>查看</Button> });
  }
  const controlled = inventoryData?.groups.flatMap(section => section.items).filter(item => item.control.kind === "switch") ?? [];
  for (const item of controlled) {
    const setting = item.control.kind === "switch" ? item.control.setting : "";
    const isCitation = setting === "dsh-cite";
    const selected = currentBuiltin?.items.find(entry => entry.id === setting);
    const enabled = isCitation ? citation.plugin?.desired?.enabled ?? false : selected?.enabled ?? false;
    const state = isCitation ? citation.plugin ? extensionAvailability({ phase: citation.plugin.phase, effective: false } as import("@/lib/extensionsClient").ExtensionInstallation,
      { enabled, effective: !!citation.plugin.effective?.enabled, phase: citation.plugin.phase } as import("@/lib/extensionsClient").ExtensionSelection) : "生效状态待确认"
      : selected?.available === false ? "当前环境未提供" : skillActivationText(enabled, currentBuiltin?.activation);
    entries.push({ id: `builtin:${item.id}`, title: item.title, description: item.use, publisher: item.publisher ?? "社区", type: "plugins", group: "插件", added: true, state,
      origin: item.kind === "platform" ? "first-party" : "third-party", repository: skillRepositoryUrl(item.repository), icon: inventoryIcon(item.icon),
      open: () => setOpen({ kind: "item", id: item.id }),
      action: view === "installed" && (isCitation || !shared) ? <Switch label={`在“${projectName}”里使用${item.title}`} checked={enabled}
        disabled={!!busy || (isCitation ? citation.busy || !citation.plugin?.desired : !selected?.available)}
        onChange={next => { if (isCitation) void citation.save({ enabled: next }); else void switchBuiltin(setting, next); }} /> : undefined });
  }
  const scopedEntries = entries.filter(entry => view === "discover" || entry.added);
  const groups = [...new Set(scopedEntries.filter(entry => type === "all" || entry.type === type).map(entry => entry.group))];
  const filtered = scopedEntries.filter(entry => (type === "all" || entry.type === type) && (group === "all" || entry.group === group) && (origin === "all" || entry.origin === origin)
    && searchMatches(query, [entry.title, entry.description, entry.publisher, entry.group]));
  const unavailable = catalogueData?.availability?.state === "unavailable" || catalogueData?.policyState === "unconfigured" || catalogueData?.policyState === "unavailable";
  const create = async (value: SkillWrite, useInProject: boolean) => act("create", async () => {
    const skill = await createPersonalSkill(value);
    if (!alive.current) return;
    reloadPersonal();
    if (useInProject) {
      try { const current = await projectSkills(projectId); await saveProjectSkills(projectId, current.revision, [...current.payload.skills, { skillId: skill.id, revision: skill.revision }]); }
      catch { if (alive.current) toast.error("技能已保存，但没能在当前项目启用，可在详情里打开。"); }
    }
    if (alive.current) openSkill(skill.id);
  });
  // Poll only an apply under way on a running runtime, with growing waits and a stop; a project with nothing running reads
  // 「下次对话生效」 and is not polled. Ready catalogues are never periodically reloaded.
  const pending = currentPolicy?.activation.phase === "waiting" || currentPersonal?.activation?.phase === "waiting" || currentBuiltin?.activation.phase === "waiting"
    || !!currentPlugins?.selections.some(item => item.phase === "waiting" || item.phase === "applying");
  const refreshPolicy = policy.reload, refreshPersonalSelection = selection.reload, refreshPlugins = projectPlugins.reload, refreshBuiltin = builtinPlugins.reload;
  const refreshPending = useCallback(() => { refreshPolicy(true); refreshPersonalSelection(true); refreshPlugins(true); refreshBuiltin(true); },
    [refreshPolicy, refreshPersonalSelection, refreshPlugins, refreshBuiltin]);
  const observedActivation = useMemo(() => [currentPolicy, currentPersonal, currentPlugins, currentBuiltin], [currentPolicy, currentPersonal, currentPlugins, currentBuiltin]);
  useActivationPoll(pending, refreshPending, observedActivation,
    `${currentPolicy?.revision ?? 0}:${currentPersonal?.revision ?? 0}:${currentPlugins?.revision ?? 0}:${currentBuiltin?.revision ?? 0}`);
  const loading = platform.state.status === "loading" && catalogue.state.status === "loading" && installed.state.status === "loading";
  const failures = [
    { load: platform, label: "重试技能目录" }, { load: policy, label: "重试项目技能设置" },
    { load: personal, label: "重试我的技能" }, { load: selection, label: "重试个人技能设置" },
    { load: catalogue, label: "重试插件目录" }, { load: installed, label: "重试已添加插件" },
    { load: projectPlugins, label: "重试项目插件设置" }, { load: builtinPlugins, label: "重试内置插件设置" }, { load: inventory, label: "重试平台能力" },
    { load: tools, label: "重试科研工具" },
  ];
  return <PageShell title="插件与技能" width="wide" meta={<Tooltip content={`当前项目：${projectName}`} kind="label"><span className="inline-flex max-w-48 items-center gap-1.5 text-ui"><Folder size={16} aria-hidden /><span className="truncate">{projectName}</span></span></Tooltip>}
    toolbar={{ label: "筛选与搜索", className: "pt-3",
      views: { label: "插件与技能", value: view, items: [{ value: "discover", label: "发现" }, { value: "installed", label: "已添加" }], onChange: next => { setOpen(null); navigate(`/app/extensions/${next}?${params}`); } },
      filters: [{ kind: "select", label: "类型", allLabel: "全部类型", value: type === "all" ? null : type, options: [{ value: "skills", label: "技能" }, { value: "plugins", label: "插件" }], onChange: next => { const changed = new URLSearchParams(params); changed.set("type", next ?? "all"); changed.delete("group"); setParams(changed, { replace: true }); } },
        { kind: "select", label: "来源", allLabel: "全部来源", value: origin === "all" ? null : origin, options: catalogueOrigins, onChange: next => setFilter("origin", next ?? "all") },
        ...(groups.length > 1 ? [{ kind: "select" as const, label: "分类", allLabel: "全部分类", value: group === "all" ? null : group, options: groups.map(name => ({ value: name, label: name })), onChange: (next: string | null) => setFilter("group", next ?? "all") }] : [])],
      search: { label: "搜索插件与技能", value: query, placeholder: "搜索名称、用途或作者", onChange: next => setFilter("q", next), onClear: () => setFilter("q", "") },
      actions: <Menu label="导入与创建" items={[
        { label: "导入技能", icon: Upload, onSelect: () => setOpen({ kind: "import" }) },
        { label: "创建技能", icon: Plus, onSelect: () => setOpen({ kind: "create" }) },
      ]}><Button size="sm">添加技能<ChevronDown size={16} aria-hidden /></Button></Menu>,
      onClear: narrow ? undefined : clearFilters, onReset: clearFilters }}>
    {actionError && open?.kind !== "create" && <LoadError message={actionError} onRetry={() => { setActionError(null); reloadSelections(); projectPlugins.reload(); }} />}
    {citation.error && controlled.some(item => item.control.kind === "switch" && item.control.setting === "dsh-cite") && <Note tone="warn" action={<Button size="sm" variant="text" disabled={citation.busy} onClick={() => void citation.reload()}>刷新引用设置</Button>}>{citation.error}</Note>}
    {failures.map(({ load, label }) => load.state.status === "error" && <Note key={label} tone="warn" action={<Button size="sm" variant="text" onClick={() => load.reload()}>{label}</Button>}>{load.state.message}</Note>)}
    {unavailable && type !== "skills" && <Note action={<Button size="sm" variant="text" onClick={() => catalogue.reload()}>刷新插件目录</Button>}>暂未提供可添加的插件，已有功能仍可使用。</Note>}
    {type !== "plugins" && <PendingSkillTransfers onResume={entry => setOpen({ kind: "import", recovery: entry })} />}
    {loading ? <FilesSkeleton /> : filtered.length ? <CatalogueView entries={filtered} view={view} />
      : <EmptyState title={query || group !== "all" || origin !== "all" ? "没有找到匹配项" : view === "installed" ? "还没有添加这类扩展" : "暂无可添加的扩展"}
        action={<Button variant="secondary" onClick={() => { setParams({}, { replace: true }); navigate("/app/extensions/discover"); }}>浏览全部</Button>} />}
    {cursor && type !== "plugins" && <div className="mt-4"><Button variant="text" loading={loadingMore} onClick={() => void loadMore()}>更多我的技能</Button></div>}
    {tab === "skills" && itemId && <PersonalSkillDrawer key={`${projectId}:${itemId}`} skillId={itemId} projectId={projectId} onClose={close} onChanged={reloadPersonal} onRemoved={() => { reloadPersonal(); close(); }} />}
    {tab === "plugins" && itemId && <ExtensionDrawer key={`${projectId}:${itemId}`} extensionId={itemId} projectId={projectId} onClose={close} onChanged={id => { installed.reload(true); projectPlugins.reload(true); if (id) openExtension(id); }} />}
    {open?.kind === "platform" && <PlatformSkillDrawer key={open.skill.id} skill={open.skill} projectId={projectId} projectName={projectName} onClose={close} onSelectionChanged={reloadSelections}
      onCopied={created => { reloadPersonal(); toast.success("已复制到我的技能"); openSkill(created.id); }} />}
    {open?.kind === "create" && <Drawer title="新建技能" onClose={() => { if (!busy) close(); }}>{actionError && <p role="alert" className="mb-4 text-ui text-error">{actionError}</p>}<SkillEditor initial={{ expectedRevision: 0, title: "", description: "", instructions: "" }} busy={busy === "create"} create={{ projectName }} onSave={(value, useInProject) => void create(value, useInProject)} onCancel={close} /></Drawer>}
    {open?.kind === "import" && <Drawer title="导入技能" onClose={() => { if (!importBusy) close(); }}><SkillImportForm recovery={open.recovery} onBusy={setImportBusy} onCancel={close} onDone={id => { reloadPersonal(); if (id) openSkill(id); else close(); }} /></Drawer>}
    {open?.kind === "item" && <ItemDrawer id={open.id} inventory={inventoryData} citation={citation} projectName={projectName} builtin={currentBuiltin} busy={!!busy} onBuiltin={(id, enabled) => void switchBuiltin(id, enabled)} error={actionError} onClose={close} />}
  </PageShell>;
}

function ItemDrawer({ id, inventory, citation, projectName, builtin, busy, onBuiltin, error, onClose }: {
  id: string; inventory: Inventory | null; citation: ReturnType<typeof useCitationPlugin>; projectName: string; onClose: () => void;
  builtin: BuiltinPluginPolicy | null; busy: boolean; onBuiltin: (id: string, enabled: boolean) => void; error: string | null;
}) {
  const found = inventory?.groups.flatMap(group => group.items.map(item => ({ item, groupTitle: group.title }))).find(entry => entry.item.id === id);
  if (!found) return null;
  if (found.item.control.kind === "switch" && found.item.control.setting === "dsh-cite") return <CitationDrawer {...found} citation={citation} projectName={projectName} onClose={onClose} />;
  const setting = found.item.control.kind === "switch" ? found.item.control.setting : "";
  const selected = builtin?.items.find(item => item.id === setting);
  const shared = projectChoicesNotApplicable(builtin?.activation);
  return <InventoryDrawer {...found} tools={found.item.showsTools ? inventory?.researchTools ?? null : null} onClose={onClose}
    controls={setting ? <div className="flex flex-col gap-2">{!shared && <Switch showLabel label={`在“${projectName}”里使用`} checked={selected?.enabled ?? false} disabled={busy || !selected?.available} onChange={next => onBuiltin(setting, next)} />}
      <p role="status" className="text-ui text-text-2">{selected?.available === false ? "当前环境未提供" : skillActivationText(selected?.enabled ?? false, builtin?.activation)}</p>
      {error && <p role="alert" className="text-ui text-error">{error}</p>}</div> : undefined} />;
}

/** Legacy item URLs stay valid; the page defaults to discovery. A project change cancels its pending UI work. */
export function ExtensionsPage() {
  const { tab, itemId } = useParams();
  const projectId = useProjectStore(state => state.currentId);
  if (!tab || !["discover", "installed", "skills", "plugins"].includes(tab)) return <Navigate to="/app/extensions/discover" replace />;
  return <Extensions key={projectId} tab={tab} itemId={itemId} projectId={projectId} />;
}
