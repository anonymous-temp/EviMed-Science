import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useNavigate, useParams } from "react-router";
import { FileDown, MessageSquare, Radar } from "lucide-react";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import {
  deleteGeoProject,
  exportGeo,
  getGeoProject,
  isGeoOff,
  patchGeoProject,
  useGeoFeature,
  type GeoProject,
} from "@/lib/geoClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { ProgressRail } from "@/components/ui/ProgressRail";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { GeoOffPage, GeoProjectSkeleton } from "@/components/geo/GeoStates";
import { railSteps } from "@/components/geo/geoOverviewModel";
import { coverageText, weekOf } from "@/components/geo/geoText";
import { GEO_TAB_REDIRECTS, GEO_TABS, geoTabPath, resolveGeoTab, type GeoTabKey } from "@/components/geo/geoTabs";
import { useOpenGeoConversation } from "@/components/geo/useOpenGeoConversation";
import { AccuracyTab } from "@/components/geo/tabs/AccuracyTab";
import { ActionsTab } from "@/components/geo/tabs/ActionsTab";
import { OverviewTab } from "@/components/geo/tabs/OverviewTab";
import { PlanTab } from "@/components/geo/tabs/PlanTab";
import { QuestionsTab } from "@/components/geo/tabs/QuestionsTab";
import { SourcesTab } from "@/components/geo/tabs/SourcesTab";
import { VisibilityTab } from "@/components/geo/tabs/VisibilityTab";

type TabComponent = ComponentType<{ geoId: string; project: GeoProject }>;

/** One component per view; the eight steps are no longer places (plan §8.1). */
const TABS: Record<GeoTabKey, TabComponent> = {
  overview: OverviewTab,
  visibility: VisibilityTab,
  accuracy: AccuracyTab,
  questions: QuestionsTab,
  sources: SourcesTab,
  actions: ActionsTab,
  plan: PlanTab,
};

type Loaded =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; project: GeoProject };

/**
 * One GEO project, on the wide column a dashboard needs (fusion plan §4.8).
 *
 * The header is the product, which week it is and when it is measured next,
 * then the eight-step programme as one rail — with what each step produced and
 * which one is waiting for the reader — and then tabs organised by the
 * question a reader arrives with: 总览 · 可见度 · 准确与安全 · 问题与回答 ·
 * 信源 · 行动 · 方案.
 *
 * The nine tabs this replaces were the platform's workflow, which meant a
 * reader had to know how the platform works before they could find out how
 * their medicine is being described. Every old address still resolves: a link
 * to 「诊断」 lands on 准确与安全 and the browser's bar says so.
 *
 * There is one AI entry on the page — 「对话」 in the header — where there used
 * to be one beside every number.
 */
export function GeoProjectPage() {
  const { geoId = "", tab: tabParam } = useParams();
  const navigate = useNavigate();
  const feature = useGeoFeature();
  const openConversation = useOpenGeoConversation();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { tab, moved } = resolveGeoTab(tabParam);

  useEffect(() => {
    // An address that named a step is rewritten to the tab that now holds it,
    // in place, so the reader leaves with a link that will keep working.
    if (moved && geoId) navigate(geoTabPath(geoId, tab), { replace: true });
  }, [moved, geoId, tab, navigate]);

  useEffect(() => {
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    void getGeoProject(geoId).then(
      (project) => { if (live) setLoaded({ kind: "ready", project }); },
      (error: unknown) => {
        if (!live) return;
        if (isGeoOff(error)) setLoaded({ kind: "off" });
        else if (error instanceof WebApiError && error.status === 404) setLoaded({ kind: "missing" });
        else setLoaded({ kind: "error", message: webErrorMessage(error, { fallback: "项目暂时无法读取。" }) });
      },
    );
    return () => { live = false; };
  }, [feature, geoId, reloads]);

  const reload = useCallback(() => setReloads((value) => value + 1), []);

  if (feature === "off" || loaded.kind === "off") return <GeoOffPage />;
  if (loaded.kind === "missing") {
    return (
      <PageShell title="循证 GEO" width="wide">
        <EmptyState icon={Radar} title="这个项目不存在或已删除。" action={<Button variant="secondary" onClick={() => navigate("/app/geo")}>回到项目列表</Button>} />
      </PageShell>
    );
  }
  if (loaded.kind !== "ready") {
    return (
      <PageShell title="循证 GEO" width="wide">
        {loaded.kind === "error" ? <LoadError message={loaded.message} onRetry={reload} /> : <GeoProjectSkeleton />}
      </PageShell>
    );
  }

  const project = loaded.project;
  const target = { projectId: project.projectId, sessionId: project.sessionId };
  const Tab = TABS[tab];

  /** Runs an action that ends in the project's conversation. */
  const act = (key: string, work: () => Promise<{ sessionId?: string | null } | void>, failure: string) => {
    if (busy) return;
    setBusy(key);
    void work()
      .then((result) => openConversation({ projectId: project.projectId, sessionId: result?.sessionId ?? project.sessionId }))
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure })))
      .finally(() => setBusy(null));
  };

  const paused = project.status === "paused";
  const menu: MenuEntry[] = [
    { label: "导出提案资料包", onSelect: () => act("proposal", () => exportGeo(geoId, "proposal"), "提案资料包没有开始导出，请稍后重试。") },
    {
      label: paused ? "继续" : "暂停",
      onSelect: () => {
        void patchGeoProject(geoId, { status: paused ? "active" : "paused" })
          .then(() => { toast.success(paused ? "已继续。" : "已暂停，测量和投放都停下了。"); reload(); })
          .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "没有改成功，请稍后重试。" })));
      },
    },
    "separator",
    { label: "删除", destructive: true, onSelect: () => setConfirmDelete(true) },
  ];

  const remove = () => {
    setConfirmDelete(false);
    void deleteGeoProject(geoId)
      .then(() => {
        // The control-plane project went with it: the sidebar's list is re-read.
        void useProjectStore.getState().load();
        navigate("/app/geo", { replace: true });
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "项目没有删除，请稍后重试。" })));
  };

  const week = weekOf(project.startedAt ?? project.createdAt ?? null);

  return (
    <PageShell
      title={project.name}
      width="wide"
      meta={<Tag>{week ? `第 ${week} 周` : coverageText(project.coverageDays, project.startedAt ?? project.createdAt ?? null)}</Tag>}
      actions={(
        <>
          <Button variant="secondary" loading={busy === "weekly"} onClick={() => act("weekly", () => exportGeo(geoId, "weekly"), "周报没有开始导出，请稍后重试。")}>
            <FileDown size={16} aria-hidden="true" />
            周报
          </Button>
          <Button variant="secondary" loading={busy === "conversation"} onClick={() => act("conversation", async () => target, "对话暂时无法打开，请稍后重试。")}>
            <MessageSquare size={16} aria-hidden="true" />
            对话
          </Button>
          <Menu label="更多操作" items={menu} />
        </>
      )}
    >
      <ProgressRail label="进度" steps={railSteps(project, (step) => geoTabPath(geoId, GEO_TAB_REDIRECTS[step] ?? "overview"))} className="mb-6" />
      <Tabs
        label="项目视图"
        items={GEO_TABS.map((item) => ({ value: item.key, label: item.label }))}
        value={tab}
        onChange={(next) => navigate(geoTabPath(geoId, next))}
        panelId="geo-tab-panel"
        className="gap-4 overflow-x-auto sm:gap-6 [&>button]:shrink-0"
      />
      <div id="geo-tab-panel" role="tabpanel" aria-labelledby={`geo-tab-panel-tab-${tab}`} className="pt-6">
        <Tab geoId={geoId} project={project} />
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={`删除「${project.name}」？`}
          body="这个项目的对话、文件、测量记录和稿件会一起删除，不能恢复。已经发出的稿件不会被撤下。"
          confirmLabel="删除"
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </PageShell>
  );
}
