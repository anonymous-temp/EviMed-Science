import { useCallback, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Plus, Upload } from "lucide-react";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Menu } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tabs } from "@/components/ui/Tabs";
import { extensionCatalogue, extensionInstallations, installExtension, pluginInventory, type CatalogueExtension } from "@/lib/extensionsClient";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { createPersonalSkill, listPersonalSkills, listPlatformSkills, type PendingSkillTransfer, type PersonalSkill, type PlatformSkill, type SkillWrite } from "@/lib/skillLibraryClient";
import { ENGINE_COPY, PLUGIN_COPY } from "./extensionCopy";
import { ExtensionDrawer } from "./ExtensionDrawer";
import { CitationDrawer, ENGINE_WHEN, engineKicker, InfoDrawer, ToolsDrawer } from "./PluginDrawers";
import { PersonalSkillDrawer } from "./PersonalSkillDrawer";
import { PlatformSkillDrawer } from "./PlatformSkillDrawer";
import { PluginsList, countPlugins, type ExtensionRows, type PluginTarget } from "./PluginsList";
import { SkillEditor } from "./SkillEditor";
import { SkillImportForm } from "./SkillImport";
import { SkillsList } from "./SkillsList";
import { useCitationPlugin } from "./useCitationPlugin";
import { useLoad } from "./useLoad";

type Tab = "skills" | "plugins";

/** The reader's own skills, first page; a stable function so the read happens once per mount. */
const loadFirstPersonal = () => listPersonalSkills();

/** What the page has open on the right, besides the two that the address names (a personal skill, an extension). */
type Open =
  | { kind: "platform"; skill: PlatformSkill } | { kind: "create" } | { kind: "import"; recovery?: PendingSkillTransfer }
  | { kind: "plugin"; target: PluginTarget };

/**
 * 插件与技能: one page, two tabs, each one list with its details in a drawer on the right.
 *
 * The page used to be two pages — 技能 listing only the reader's own skills with the platform's fifty-seven hidden in a
 * section below that needed a live runtime to read, and 插件 stacking the deployment's declarations, a settings card and a
 * discovery list that was always empty. Now both are answered from what the control plane already knows without a runtime
 * (the platform's skills from its packages, the plugins from the inventory), the tabs carry their counts, and a row opens a
 * drawer: what it does, when it is used, and what can be done with it.
 *
 * The address still names the open item (`/app/extensions/skills/:skillId`, `/app/extensions/plugins/:extensionId`), so a
 * link a notice or an earlier page made keeps working.
 */
function Extensions({ tab, itemId }: { tab: Tab; itemId: string | undefined }) {
  const navigate = useNavigate();
  const skillId = tab === "skills" ? itemId : undefined, extensionId = tab === "plugins" ? itemId : undefined;
  const projectId = useProjectStore(state => state.currentId);
  const projectName = useProjectStore(state => state.projects.find(project => project.id === state.currentId)?.name);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Open | null>(null), [importBusy, setImportBusy] = useState(false);

  const platform = useLoad(listPlatformSkills);
  const firstPersonal = useLoad(loadFirstPersonal);
  const [more, setMore] = useState<{ items: PersonalSkill[]; cursor: string | null } | null>(null), [loadingMore, setLoadingMore] = useState(false);
  const personal = firstPersonal.state.status === "ready" ? [...firstPersonal.state.data.items, ...(more?.items ?? [])] : [];
  const cursor = more ? more.cursor : firstPersonal.state.status === "ready" ? firstPersonal.state.data.nextCursor : null;
  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listPersonalSkills(cursor);
      setMore(current => ({ items: [...(current?.items ?? []), ...page.items], cursor: page.nextCursor }));
    } catch (caught) { toast.error(productErrorMessage(caught)); }
    finally { setLoadingMore(false); }
  };
  const reloadPersonal = () => { setMore(null); firstPersonal.reload(true); };

  const loadInventory = useCallback(() => pluginInventory(projectId), [projectId]);
  const inventory = useLoad(loadInventory);
  const citation = useCitationPlugin(projectId);
  const loadExtensions = useCallback(async () => {
    const [catalogue, installations] = await Promise.all([extensionCatalogue(), extensionInstallations()]);
    return { catalogue: catalogue.items, installed: installations.items };
  }, []);
  const extensionData = useLoad(loadExtensions);
  const extensions = useMemo<(ExtensionRows & { all: CatalogueExtension[] }) | null>(() => {
    if (extensionData.state.status !== "ready") return null;
    const { catalogue, installed } = extensionData.state.data;
    const taken = new Set(installed.map(item => item.catalogueId));
    return { all: catalogue, installed, offered: catalogue.filter(entry => !taken.has(entry.id)) };
  }, [extensionData.state]);

  const inventoryReady = inventory.state.status === "ready" ? inventory.state.data : null;
  const skillCount = platform.state.status === "ready" ? platform.state.data.items.length + personal.length : null;
  const pluginCount = inventoryReady ? countPlugins(inventoryReady, extensions) : null;

  // Which drawer is open: the address's own item first, then what a click opened.
  const root = `/app/extensions/${tab}`;
  const close = () => { if (skillId || extensionId) navigate(root, { replace: true }); setOpen(null); };
  const requestKeys = useRef(new Map<string, string>());
  const [installing, setInstalling] = useState<string | null>(null);
  const install = async (entry: CatalogueExtension) => {
    if (installing) return;
    const identity = JSON.stringify(entry.coordinate);
    const key = requestKeys.current.get(identity) ?? crypto.randomUUID(); requestKeys.current.set(identity, key); setInstalling(entry.id);
    try {
      const outcome = await installExtension(entry.coordinate, key); requestKeys.current.delete(identity);
      extensionData.reload(true); navigate(`/app/extensions/plugins/${encodeURIComponent(outcome.installation.id)}`);
    } catch (caught) { toast.error(productErrorMessage(caught)); }
    finally { setInstalling(null); }
  };
  const openSkill = (id: string) => { setOpen(null); navigate(`/app/extensions/skills/${encodeURIComponent(id)}`); };

  const saveNew = async (value: SkillWrite) => {
    try { const created = await createPersonalSkill(value); reloadPersonal(); openSkill(created.id); }
    catch (caught) { toast.error(productErrorMessage(caught)); }
  };

  const action = tab === "skills" ? (
    <Menu label="新建技能" items={[
      { label: "创建技能", icon: Plus, onSelect: () => setOpen({ kind: "create" }) },
      { label: "导入", icon: Upload, onSelect: () => setOpen({ kind: "import" }) },
    ]}>
      <Button><Plus size={16} aria-hidden />新建技能</Button>
    </Menu>
  ) : null;

  return (
    <PageShell title="插件与技能" actions={<><SearchInput label="搜索" value={query} onChange={event => setQuery(event.target.value)} />{action}</>}>
      <Tabs label="插件与技能" className="mb-6" value={tab} onChange={next => { setQuery(""); setOpen(null); navigate(`/app/extensions/${next}`); }}
        items={[{ value: "skills", label: "技能", count: skillCount ?? undefined }, { value: "plugins", label: "插件", count: pluginCount ?? undefined }]} />
      {tab === "skills" ? (
        <>
          {platform.state.status === "error" && <LoadError className="mb-4" message={platform.state.message} onRetry={() => platform.reload()} />}
          {firstPersonal.state.status === "error" && <LoadError className="mb-4" message={firstPersonal.state.message} onRetry={() => firstPersonal.reload()} />}
          {platform.state.status === "loading" && firstPersonal.state.status === "loading" ? <FilesSkeleton /> : (
            <SkillsList personal={personal} platform={platform.state.status === "ready" ? platform.state.data : null} query={query}
              hasMore={!!cursor} loadingMore={loadingMore} onMore={() => void loadMore()}
              onOpenPlatform={skill => { if (skillId) navigate(root, { replace: true }); setOpen({ kind: "platform", skill }); }}
              onOpenPersonal={skill => openSkill(skill.id)}
              onResume={entry => setOpen({ kind: "import", recovery: entry })} />
          )}
        </>
      ) : inventory.state.status === "error" ? <LoadError message={inventory.state.message} onRetry={() => inventory.reload()} />
        : !inventoryReady ? <FilesSkeleton />
          : <PluginsList inventory={inventoryReady} citation={citation} extensions={extensions} allCatalogue={extensions?.all ?? []} query={query} busyId={installing}
            onOpen={target => { if (target.kind === "extension") { setOpen(null); navigate(`/app/extensions/plugins/${encodeURIComponent(target.id)}`); } else { if (extensionId) navigate(root, { replace: true }); setOpen({ kind: "plugin", target }); } }}
            onInstall={entry => void install(entry)} />}

      {tab === "skills" && skillId && <PersonalSkillDrawer key={skillId} skillId={skillId} projectId={projectId} onClose={close}
        onChanged={reloadPersonal} onRemoved={() => { reloadPersonal(); close(); }} />}
      {tab === "plugins" && extensionId && <ExtensionDrawer key={extensionId} extensionId={extensionId} projectId={projectId} onClose={close}
        onChanged={id => { extensionData.reload(true); if (id) navigate(`/app/extensions/plugins/${encodeURIComponent(id)}`); }} />}
      {open?.kind === "platform" && <PlatformSkillDrawer key={open.skill.id} skill={open.skill} onClose={close}
        onCopied={created => { reloadPersonal(); toast.success("已复制到我的技能"); openSkill(created.id); }} />}
      {open?.kind === "create" && (
        <Drawer title="创建技能" onClose={close}>
          <SkillEditor initial={{ expectedRevision: 0, title: "", description: "", instructions: "" }} busy={false} onSave={value => void saveNew(value)} onCancel={close} />
        </Drawer>
      )}
      {open?.kind === "import" && (
        <Drawer title="导入技能" onClose={() => { if (!importBusy) close(); }}>
          <SkillImportForm recovery={open.recovery} onBusy={setImportBusy} onCancel={close}
            onDone={id => { reloadPersonal(); if (id) openSkill(id); else close(); }} />
        </Drawer>
      )}
      {open?.kind === "plugin" && <PluginTargetDrawer target={open.target} inventory={inventoryReady} citation={citation} projectName={projectName} onClose={close} />}
    </PageShell>
  );
}

/** The drawer a plugin row opens: the citation settings, the tool set's list, or a plain description. */
function PluginTargetDrawer({ target, inventory, citation, projectName, onClose }: {
  target: PluginTarget; inventory: Awaited<ReturnType<typeof pluginInventory>> | null; citation: ReturnType<typeof useCitationPlugin>;
  projectName: string | undefined; onClose: () => void;
}) {
  if (target.kind === "cite") return <CitationDrawer citation={citation} projectName={projectName} onClose={onClose} />;
  if (target.kind === "tools") return inventory ? <ToolsDrawer tools={inventory.researchTools} onClose={onClose} /> : null;
  if (target.kind === "info") {
    const copy = PLUGIN_COPY[target.id];
    return <InfoDrawer title={copy.title} kicker="对话里的工具 · 始终开启" does={copy.does} onClose={onClose} />;
  }
  if (target.kind === "engine") {
    const copy = ENGINE_COPY.find(engine => engine.id === target.id);
    const available = inventory?.engines.find(state => state.id === target.id)?.available ?? false;
    return copy ? <InfoDrawer title={copy.title} kicker={engineKicker(available)} does={copy.use} when={ENGINE_WHEN} onClose={onClose} /> : null;
  }
  return null;
}

/**
 * The one route element for both tabs (`extensions/:tab/:itemId?`): one component instance serves both, so a switch of tab is a
 * switch of view, not a second read of everything the page has already loaded.
 */
export function ExtensionsPage() {
  const { tab, itemId } = useParams();
  if (tab !== "skills" && tab !== "plugins") return <Navigate to="/app/extensions/skills" replace />;
  return <Extensions tab={tab} itemId={itemId} />;
}
