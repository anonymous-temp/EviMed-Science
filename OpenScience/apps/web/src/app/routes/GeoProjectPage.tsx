import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useNavigate, useParams } from "react-router";
import { MessageSquare, Radar } from "lucide-react";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import {
  deleteGeoProject,
  exportGeo,
  getGeoProject,
  isGeoOff,
  patchGeoProject,
  runGeoStep,
  useGeoFeature,
  type GeoProject,
  type GeoStepKey,
} from "@/lib/geoClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { GeoOverview } from "@/components/geo/GeoOverview";
import { GeoOffPage, GeoProjectSkeleton } from "@/components/geo/GeoStates";
import { coverageText, GEO_STEP_EMPTY, GEO_TABS, isGeoTab, type GeoTabKey } from "@/components/geo/geoText";
import { useOpenGeoConversation } from "@/components/geo/useOpenGeoConversation";
import { ContentTab } from "@/components/geo/tabs/ContentTab";
import { DiagnosisTab } from "@/components/geo/tabs/DiagnosisTab";
import { DistributionTab } from "@/components/geo/tabs/DistributionTab";
import { EvidenceTab } from "@/components/geo/tabs/EvidenceTab";
import { JourneyTab } from "@/components/geo/tabs/JourneyTab";
import { MonitoringTab } from "@/components/geo/tabs/MonitoringTab";
import { QuestionsTab } from "@/components/geo/tabs/QuestionsTab";
import { SourcesTab } from "@/components/geo/tabs/SourcesTab";

type TabComponent = ComponentType<{ geoId: string; project: GeoProject }>;

/** Each step's tab content (package D2). */
const STEP_TABS: Record<GeoStepKey, TabComponent> = {
  evidence: EvidenceTab,
  journey: JourneyTab,
  questions: QuestionsTab,
  diagnosis: DiagnosisTab,
  sources: SourcesTab,
  content: ContentTab,
  distribution: DistributionTab,
  monitoring: MonitoringTab,
};

type Loaded =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; project: GeoProject };

/**
 * One GEO project (plan §5.3): a one-line header — the product, its coverage
 * window, 「对话」 and 「⋯」 — and nine underlined tabs, 概览 and the eight
 * steps. A step nobody has touched keeps its tab: one sentence and 「让 AI 做」,
 * which starts that step in the project's conversation.
 *
 * The page is a board over what the AI and the platform did; the work itself
 * happens in the conversation, which every action here opens.
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
  const tab: GeoTabKey = isGeoTab(tabParam) ? tabParam : "overview";

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
      <PageShell title="循证 GEO">
        <EmptyState icon={Radar} title="这个项目不存在或已删除。" action={<Button variant="secondary" onClick={() => navigate("/app/geo")}>回到项目列表</Button>} />
      </PageShell>
    );
  }
  if (loaded.kind !== "ready") {
    return (
      <PageShell title="循证 GEO">
        {loaded.kind === "error" ? <LoadError message={loaded.message} onRetry={reload} /> : <GeoProjectSkeleton />}
      </PageShell>
    );
  }

  const project = loaded.project;
  const target = { projectId: project.projectId, sessionId: project.sessionId };

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
    { label: "导出周报", onSelect: () => act("weekly", () => exportGeo(geoId, "weekly"), "周报没有开始导出，请稍后重试。") },
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

  const changeTab = (next: GeoTabKey) => {
    navigate(next === "overview" ? `/app/geo/${encodeURIComponent(geoId)}` : `/app/geo/${encodeURIComponent(geoId)}/${next}`);
  };

  return (
    <PageShell
      title={project.name}
      meta={<Tag>{coverageText(project.coverageDays, project.startedAt ?? project.createdAt ?? null)}</Tag>}
      actions={(
        <>
          <Button variant="secondary" loading={busy === "conversation"} onClick={() => act("conversation", async () => target, "对话暂时无法打开，请稍后重试。")}>
            <MessageSquare size={16} aria-hidden="true" />
            对话
          </Button>
          <Menu label="更多操作" items={menu} />
        </>
      )}
    >
      <Tabs label="项目视图" items={GEO_TABS.map((item) => ({ value: item.key, label: item.label }))} value={tab} onChange={changeTab} panelId="geo-tab-panel" />
      <div id="geo-tab-panel" role="tabpanel" aria-labelledby={`geo-tab-panel-tab-${tab}`} className="pt-6">
        {tab === "overview" ? <GeoOverview geoId={geoId} project={project} />
          : untouched(project, tab) ? (
            <StepEmpty
              step={tab}
              busy={busy === `run:${tab}`}
              onRun={() => act(`run:${tab}`, () => runGeoStep(geoId, tab), "没有开始，请稍后重试。")}
            />
          ) : <StepTab step={tab} geoId={geoId} project={project} />}
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

/** A step nobody has asked for or worked on. */
function untouched(project: GeoProject, step: GeoStepKey): boolean {
  const state = project.steps[step];
  return !state || (state.status === "none" && !state.requested);
}

function StepTab({ step, geoId, project }: { step: GeoStepKey; geoId: string; project: GeoProject }) {
  const Tab = STEP_TABS[step];
  return <Tab geoId={geoId} project={project} />;
}

function StepEmpty({ step, busy, onRun }: { step: GeoStepKey; busy: boolean; onRun: () => void }) {
  return (
    <div data-geo-step-empty={step} className="flex flex-col items-center gap-4 py-12 text-center">
      <p className="text-ui text-text-2">{GEO_STEP_EMPTY[step]}</p>
      <Button onClick={onRun} loading={busy}>让 AI 做</Button>
    </div>
  );
}
