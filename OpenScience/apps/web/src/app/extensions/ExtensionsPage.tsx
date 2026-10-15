import { useCallback, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Plus, Upload } from "lucide-react";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Menu } from "@/components/ui/Menu";
import { extensionCatalogue, extensionInstallations, installExtension, inventory as loadInventoryOf, type CatalogueExtension, type Inventory } from "@/lib/extensionsClient";
import { capabilityListed } from "@evimed/domain";
import { listWebResearchAgents } from "@/lib/apiClient";
import { bindConversationCapability } from "@/lib/dispatch";
import { researchAgentUi, type CapabilityUi } from "@/lib/researchAgentUi";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { createPersonalSkill, listPersonalSkills, listPlatformSkills, projectSkills, saveProjectSkills, type PendingSkillTransfer, type PersonalSkill, type PlatformSkill, type SkillWrite } from "@/lib/skillLibraryClient";
import { ExtensionDrawer } from "./ExtensionDrawer";
import { InventoryList, countPlugins, type ExtensionRows } from "./InventoryList";
import { CitationDrawer, InventoryDrawer } from "./PluginDrawers";
import { PersonalSkillDrawer } from "./PersonalSkillDrawer";
import { PlatformSkillDrawer } from "./PlatformSkillDrawer";
import { SkillEditor } from "./SkillEditor";
import { SkillImportForm } from "./SkillImport";
import { SkillsList, skillGroups } from "./SkillsList";
import { useCitationPlugin } from "./useCitationPlugin";
import { useLoad } from "./useLoad";

type Tab = "skills" | "plugins";

/** The reader's own skills, first page; a stable function so the read happens once per mount. */
const loadFirstPersonal = () => listPersonalSkills();

/** What the page has open on the right, besides the two that the address names (a personal skill, an extension). */
type Open =
  | { kind: "platform"; skill: PlatformSkill } | { kind: "create" } | { kind: "import"; recovery?: PendingSkillTransfer }
  | { kind: "item"; id: string };

/**
 * 插件与技能: one page, two tabs, each one list with its details in a drawer on the right, and one toolbar above them — the
 * tabs, the group chips of the skills, the search.
 *
 * The page used to be two pages — 技能 listing only the reader's own skills with the platform's fifty-seven hidden in a
 * section below that needed a live runtime to read, and 插件 stacking the deployment's declarations, a settings card and a
 * discovery list that was always empty. Now both are answered from what the control plane already knows without a runtime
 * (the platform's skills from its packages, the plugins from the inventory generated from what the image carries), the tabs
 * carry the number of rows they list, and a row opens a drawer: what it does, how it is used, and what can be done with it.
 *
 * The address still names the open item (`/app/extensions/skills/:skillId`, `/app/extensions/plugins/:extensionId`), so a
 * link a notice or an earlier page made keeps working.
 */
function Extensions({ tab, itemId }: { tab: Tab; itemId: string | undefined }) {
  const navigate = useNavigate();
  const skillId = tab === "skills" ? itemId : undefined, extensionId = tab === "plugins" ? itemId : undefined;
  const projectId = useProjectStore(state => state.currentId);
  const projectName = useProjectStore(state => state.projects.find(project => project.id === state.currentId)?.name);
  const [query, setQuery] = useState(""), [chosenGroup, setChosenGroup] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null), [importBusy, setImportBusy] = useState(false);

  const platform = useLoad(listPlatformSkills);
  // The curated research tools: the catalogue 科研工具 reads, through the same filter and names — no second source.
  const tools = useLoad(listWebResearchAgents);
  const curatedTools = useMemo<CapabilityUi[] | null>(() => tools.state.status === "ready"
    ? tools.state.data.filter(agent => capabilityListed(agent.id)).map(researchAgentUi) : null, [tools.state]);
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

  const loadInventory = useCallback(() => loadInventoryOf(projectId), [projectId]);
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
  const platformReady = platform.state.status === "ready" ? platform.state.data : null;
  // A tab's number is the rows its list draws, whatever the search says.
  const skillCount = platformReady ? skillGroups({ personal, platform: platformReady, tools: curatedTools, query: "" }).total : null;
  const pluginCount = inventoryReady ? countPlugins(inventoryReady, extensions) : null;
  const groupsNow = skillGroups({ personal, platform: platformReady, tools: curatedTools, query });
  const searching = query.trim() !== "";
  // The chip the toolbar shows is a group the list can fill: one the search left empty is not offered, and falls back to all.
  const group = groupsNow.list.some(entry => entry.name === chosenGroup) ? chosenGroup : null;

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

  // A tool is chosen by opening the conversation that runs it, bound before the conversation exists — what the 科研工具 card does.
  const [opening, setOpening] = useState<string | null>(null);
  const openTool = (agent: CapabilityUi) => {
    if (opening) return;
    setOpening(agent.id);
    void bindConversationCapability(null, { agentId: agent.id, agentVersion: agent.version })
      .then((bound) => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(undefined, bound.sessionId), capabilityId: agent.id } }))
      // A binding the control plane refused must not strand the reader: the conversation opens, and the router decides as it did before there were tools.
      .catch(() => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } }))
      .finally(() => setOpening(null));
  };

  // One save at a time: the server makes a new skill for every request it gets, so a second click while the first is on its
  // way would be a second skill.
  const [saving, setSaving] = useState(false), saveRunning = useRef(false);
  const saveNew = async (value: SkillWrite, useInProject: boolean) => {
    if (saveRunning.current) return;
    saveRunning.current = true; setSaving(true);
    try {
      const created = await createPersonalSkill(value);
      reloadPersonal();
      // A saved skill is used nowhere until it is selected for a project. Selecting it is a second request on top of a skill
      // that already exists: if it fails the skill stays, is opened, and the reader is told where to switch it on.
      if (useInProject) {
        try {
          const current = await projectSkills(projectId);
          await saveProjectSkills(projectId, current.revision, [...current.payload.skills.filter(item => item.skillId !== created.id), { skillId: created.id, revision: created.revision }]);
        } catch { toast.error("技能已保存，但没能在当前项目启用，可在详情里打开。"); }
      }
      openSkill(created.id);
    } catch (caught) { toast.error(productErrorMessage(caught)); }
    finally { saveRunning.current = false; setSaving(false); }
  };

  const actions = tab === "skills" ? (
    <Menu label="新建技能" items={[
      { label: "创建技能", icon: Plus, onSelect: () => setOpen({ kind: "create" }) },
      { label: "导入", icon: Upload, onSelect: () => setOpen({ kind: "import" }) },
    ]}>
      <Button><Plus size={16} aria-hidden />新建技能</Button>
    </Menu>
  ) : null;

  return (
    <PageShell title="插件与技能" actions={actions}
      // One row of views over one row of controls, the same two on both tabs so the band keeps its height: the groups of the
      // skills as chips and the search, or the search alone.
      tabs={{
        label: "插件与技能", value: tab,
        onChange: next => { setQuery(""); setChosenGroup(null); setOpen(null); navigate(`/app/extensions/${next}`); },
        items: [{ value: "skills", label: "技能", count: skillCount ?? undefined }, { value: "plugins", label: "插件", count: pluginCount ?? undefined }],
      }}
      toolbar={{
        label: "筛选与搜索",
        filters: tab === "skills" && groupsNow.list.length > 1 ? [{
          kind: "chips", label: "技能分类", value: group ?? "all", maxVisible: 9,
          // The groups' own headings carry their sizes; a chip carries one only while a search is narrowing them.
          options: [{ value: "all", label: "全部", count: searching ? groupsNow.total : undefined },
            ...groupsNow.list.map(entry => ({ value: entry.name, label: entry.name, count: searching ? entry.count : undefined }))],
          onChange: next => setChosenGroup(next === "all" ? null : next),
        }] : [],
        onClear: () => { setQuery(""); setChosenGroup(null); },
        search: { label: "搜索插件与技能", value: query, placeholder: "搜索插件与技能", onChange: setQuery, onClear: () => setQuery("") },
      }}>
      {tab === "skills" ? (
        <>
          {platform.state.status === "error" && <LoadError className="mb-4" message={platform.state.message} onRetry={() => platform.reload()} />}
          {firstPersonal.state.status === "error" && <LoadError className="mb-4" message={firstPersonal.state.message} onRetry={() => firstPersonal.reload()} />}
          {tools.state.status === "error" && <LoadError className="mb-4" message={tools.state.message} onRetry={() => tools.reload()} />}
          {platform.state.status === "loading" && firstPersonal.state.status === "loading" ? <FilesSkeleton /> : (
            <SkillsList personal={personal} platform={platformReady} tools={curatedTools} onOpenTool={openTool} query={query} group={group}
              hasMore={!!cursor} loadingMore={loadingMore} onMore={() => void loadMore()}
              onOpenPlatform={skill => { if (skillId) navigate(root, { replace: true }); setOpen({ kind: "platform", skill }); }}
              onOpenPersonal={skill => openSkill(skill.id)}
              onResume={entry => setOpen({ kind: "import", recovery: entry })}
              onCreate={() => setOpen({ kind: "create" })} />
          )}
        </>
      ) : inventory.state.status === "error" ? <LoadError message={inventory.state.message} onRetry={() => inventory.reload()} />
        : !inventoryReady ? <FilesSkeleton />
          : <InventoryList inventory={inventoryReady} citation={citation} extensions={extensions} allCatalogue={extensions?.all ?? []} query={query} busyId={installing}
            onOpen={target => { if (target.kind === "extension") { setOpen(null); navigate(`/app/extensions/plugins/${encodeURIComponent(target.id)}`); } else { if (extensionId) navigate(root, { replace: true }); setOpen({ kind: "item", id: target.id }); } }}
            onInstall={entry => void install(entry)} />}

      {tab === "skills" && skillId && <PersonalSkillDrawer key={skillId} skillId={skillId} projectId={projectId} onClose={close}
        onChanged={reloadPersonal} onRemoved={() => { reloadPersonal(); close(); }} />}
      {tab === "plugins" && extensionId && <ExtensionDrawer key={extensionId} extensionId={extensionId} projectId={projectId} onClose={close}
        onChanged={id => { extensionData.reload(true); if (id) navigate(`/app/extensions/plugins/${encodeURIComponent(id)}`); }} />}
      {open?.kind === "platform" && <PlatformSkillDrawer key={open.skill.id} skill={open.skill} onClose={close}
        onCopied={created => { reloadPersonal(); toast.success("已复制到我的技能"); openSkill(created.id); }} />}
      {open?.kind === "create" && (
        <Drawer title="新建技能" onClose={() => { if (!saving) close(); }}>
          <SkillEditor initial={{ expectedRevision: 0, title: "", description: "", instructions: "" }} busy={saving} create={{ projectName: projectName ?? "当前项目" }}
            onSave={(value, useInProject) => void saveNew(value, useInProject)} onCancel={close} />
        </Drawer>
      )}
      {open?.kind === "import" && (
        <Drawer title="导入技能" onClose={() => { if (!importBusy) close(); }}>
          <SkillImportForm recovery={open.recovery} onBusy={setImportBusy} onCancel={close}
            onDone={id => { reloadPersonal(); if (id) openSkill(id); else close(); }} />
        </Drawer>
      )}
      {open?.kind === "item" && <ItemDrawer id={open.id} inventory={inventoryReady} citation={citation} projectName={projectName} onClose={close} />}
    </PageShell>
  );
}

/** The drawer an item's row opens: the citation settings for the item that is the switch, the item's words for the rest. */
function ItemDrawer({ id, inventory, citation, projectName, onClose }: {
  id: string; inventory: Inventory | null; citation: ReturnType<typeof useCitationPlugin>; projectName: string | undefined; onClose: () => void;
}) {
  const found = inventory?.groups.flatMap(group => group.items.map(item => ({ item, groupTitle: group.title }))).find(entry => entry.item.id === id);
  if (!found) return null;
  const { item, groupTitle } = found;
  if (item.control.kind === "switch" && item.control.setting === "dsh-cite") {
    return <CitationDrawer item={item} citation={citation} projectName={projectName} groupTitle={groupTitle} onClose={onClose} />;
  }
  // The item that is the tool set carries the account's tools; every other item has its own words alone.
  const tools = item.showsTools ? inventory?.researchTools ?? null : null;
  return <InventoryDrawer item={item} groupTitle={groupTitle} tools={tools} onClose={onClose} />;
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
