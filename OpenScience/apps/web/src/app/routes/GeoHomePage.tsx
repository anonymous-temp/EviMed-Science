import { Link } from "react-router";
import { geoJourney } from "@/components/geo/geoJourney";
import { GEO_STEP_HOME, geoDestinationPath } from "@/components/geo/geoTabs";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Plus, Radar } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { createGeoProject, isGeoOff, listGeoProjects, patchGeoProject, useGeoFeature, type GeoProjectSummary } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { MasterDetail, type MasterDetailState } from "@/components/ui/MasterDetail";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import { Toolbar } from "@/components/ui/Toolbar";
import { GeoCellText } from "@/components/geo/GeoCellText";
import { alertText, GeoProjectPreview, progressLine } from "@/components/geo/GeoHomePreview";
import { GeoListSkeleton, GeoOffPage, GeoPreviewSkeleton } from "@/components/geo/GeoStates";
import { withStartDate } from "@/components/geo/geoText";
import { useOpenGeoConversation } from "@/components/geo/useOpenGeoConversation";

/** What the module is for, said to a pharma company or a doctor who has not started: the work, and what they get to see. */
const EMPTY_SENTENCE = "药企和医生在这里研究并传播自己产品的循证依据，也能看到各家 AI 是怎么表达的。";

/**
 * The room the preview is given beside the 340 px list. The two figures sit side by side in it and the eight steps in four columns,
 * so the page splits from 340 + 520 = 860 px of its own width — a laptop window with the sidebar open — and below that the list is the
 * page and a press opens the preview in the drawer.
 */
const PREVIEW_MIN = 520;

type Sort = "recent" | "state";

/** What needs the reader first: a severe error, then an open one, then a stopped article, then the rest; a paused project last. */
function stateRank(project: GeoProjectSummary): number {
  if (project.status === "paused") return 4;
  if (project.alert.severe > 0) return 0;
  if (project.alert.wrongOurs > 0) return 1;
  if (project.alert.safety > 0) return 2;
  return 3;
}

const sortProjects = (projects: GeoProjectSummary[], sort: Sort): GeoProjectSummary[] =>
  [...projects].sort((a, b) => (sort === "state" ? stateRank(a) - stateRank(b) : 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

type Listing =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "ready"; projects: GeoProjectSummary[] };

const NO_PROJECTS: GeoProjectSummary[] = [];

/**
 * “循证 GEO”'s home (plan §5.1, mockup g01), a list with a peek beside it (T2, 2026-10-28): the projects on the left, one row each —
 * its name (with its start date after it when another project has the same name), one line under it (what is open on it, else where it
 * is: the coverage window and the week, or the single step it has done) and the 综合可见度指数 — and the chosen project on the right:
 * both numbers with the sample each rests on, the eight steps, the window and the last activity, with 打开项目 and 继续对话. A press on a
 * row chooses it (`?project=`, so the choice survives a reload and Back); with none chosen, the first row of the order is the one
 * shown. A paused project says 已暂停 in its row and carries 继续 in its preview — a note's action, not a cell among the values (R19,
 * audit D C4). Two or more projects are ordered by the latest activity, or by what needs the reader first (`?sort=state`).
 *
 * Below the room for both (the page's own width, not the window's) the list is the page, a row opens the preview in the drawer over it,
 * and 打开项目 is one press further. A number that does not exist yet is “未测” in the row and in the preview says what measures it; a
 * project that has only done one step is in the list all the same.
 *
 * “新建项目” creates the project and lands in its conversation, where the composer already carries the “循证 GEO” chip: no form. With
 * no project yet the preview pane is the empty state — one sentence for what the module is for and that one button; the header has
 * none then, so the page has one solid button.
 */
export function GeoHomePage() {
  const feature = useGeoFeature();
  const openConversation = useOpenGeoConversation();
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [creating, setCreating] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const sort: Sort = params.get("sort") === "state" ? "state" : "recent";
  const asked = params.get("project");

  useEffect(() => {
    // `error`: `/api/me` could not be read. The list is asked anyway — the
    // route answers for itself, `geo_not_enabled` included.
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    setListing({ kind: "loading" });
    void listGeoProjects().then(
      (projects) => { if (live) setListing({ kind: "ready", projects }); },
      (error: unknown) => {
        if (!live) return;
        setListing(isGeoOff(error) ? { kind: "off" } : { kind: "error", message: webErrorMessage(error, { fallback: "项目列表暂时无法读取。" }) });
      },
    );
    return () => { live = false; };
  }, [feature, reloads]);

  const projects = listing.kind === "ready" ? listing.projects : NO_PROJECTS;
  // Two projects of one name are told apart by the day they started.
  const labels = useMemo(() => withStartDate(projects), [projects]);
  const ordered = useMemo(() => sortProjects(projects, sort), [projects, sort]);

  if (feature === "off" || listing.kind === "off") return <GeoOffPage />;

  const create = () => {
    if (creating) return;
    setCreating(true);
    void createGeoProject({})
      .then((created) => openConversation({ geoId: created.id, projectId: created.projectId, sessionId: created.sessionId }))
      .catch((error: unknown) => {
        if (isGeoOff(error)) setListing({ kind: "off" });
        else toast.error(webErrorMessage(error, { fallback: "无法新建项目，请稍后重试。" }));
      })
      .finally(() => setCreating(false));
  };

  /** A paused project was set going again: its row and its preview say so without re-reading the list. */
  const resume = (project: GeoProjectSummary) => {
    setResuming(project.id);
    void patchGeoProject(project.id, { status: "active" })
      .then(() => {
        toast.success("已继续。");
        setListing((previous) => (previous.kind === "ready"
          ? { kind: "ready", projects: previous.projects.map((entry) => (entry.id === project.id ? { ...entry, status: "active" } : entry)) }
          : previous));
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "项目无法继续，请稍后重试。" })))
      .finally(() => setResuming(null));
  };

  const loading = feature === "loading" || listing.kind === "loading";
  const none = listing.kind === "ready" && listing.projects.length === 0;
  const newProject = (
    <Button onClick={create} loading={creating} disabled={listing.kind !== "ready"}>
      <Plus size={16} aria-hidden="true" />
      新建项目
    </Button>
  );
  const recipe = <EmptyState icon={Radar} title="还没有循证 GEO 项目" description={EMPTY_SENTENCE} action={newProject} className="min-h-0 flex-1" />;
  const retry = listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} /> : null;

  // The project the address names; one it does not know (deleted since) names none.
  const chosen = ordered.find((project) => project.id === asked) ?? null;
  const choose = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("project", id);
    return `?${next.toString()}`;
  };
  const closePreview = () => setParams((current) => {
    const next = new URLSearchParams(current);
    next.delete("project");
    return next;
  }, { replace: true });

  const list = ({ split }: MasterDetailState) => {
    const shown = chosen ?? (split ? ordered[0] ?? null : null);
    const rows = ordered.length > 0 && (
      <List label="循证 GEO 项目">
        {ordered.map((project) => <ProjectRow key={project.id} project={project} label={labels.get(project.id) ?? project.name} selected={project.id === shown?.id} to={choose(project.id)} />)}
      </List>
    );
    return (
      // Where the list is the page it keeps the page's column and gutter (`PageShell`'s); beside the preview it is a column of its own.
      <div className={cn("flex min-h-0 flex-1 flex-col", !split && "mx-auto w-full max-w-page px-4 md:px-6")}>
        <PageHeader title="循证 GEO" actions={none ? undefined : newProject} className={cn("shrink-0 pb-3 pt-5", split && "px-4")} />
        {/* The one row of controls, over the list: how it is ordered, and how many there are. With one project there is nothing to order. */}
        {ordered.length > 1 && (
          <div className={cn("shrink-0 pb-2", split && "px-4")}>
            <Toolbar
              label="项目排序"
              filters={[{
                kind: "chips", label: "排序", value: sort, neutral: "recent",
                options: [{ value: "recent", label: "最近活动" }, { value: "state", label: "需要处理的在前" }],
                onChange: (next) => setParams((current) => {
                  const updated = new URLSearchParams(current);
                  if (next === "recent") updated.delete("sort"); else updated.set("sort", next);
                  return updated;
                }, { replace: true }),
              }]}
              summary={`${ordered.length} 个项目`}
            />
          </div>
        )}
        <div className={cn("min-h-0 flex-1 overflow-y-auto pb-6", split && "px-2")}>
          {/* Beside the preview, what is not a list (a failed read, the first-run recipe) is said in the preview's pane. */}
          {loading ? <GeoListSkeleton /> : split ? rows : retry ?? (none ? recipe : rows)}
        </div>
      </div>
    );
  };

  const detail = ({ split }: MasterDetailState) => {
    if (!split) {
      // The drawer holds the chosen project and nothing else.
      return chosen && (
        <GeoProjectPreview
          project={chosen}
          label={labels.get(chosen.id) ?? chosen.name}
          heading={false}
          resuming={resuming === chosen.id}
          onResume={() => resume(chosen)}
          onConversation={() => void openConversation({ geoId: chosen.id, projectId: chosen.projectId })}
        />
      );
    }
    const shown = chosen ?? ordered[0] ?? null;
    if (loading) return <div className="px-6 py-6"><GeoPreviewSkeleton /></div>;
    if (retry) return <div className="px-6 py-6">{retry}</div>;
    if (none) return recipe;
    return shown && (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-6">
          <GeoProjectPreview
            project={shown}
            label={labels.get(shown.id) ?? shown.name}
            heading
            resuming={resuming === shown.id}
            onResume={() => resume(shown)}
            onConversation={() => void openConversation({ geoId: shown.id, projectId: shown.projectId })}
          />
        </div>
      </div>
    );
  };

  return (
    <MasterDetail
      list={list}
      detail={detail}
      selected={chosen !== null}
      listLabel="项目列表"
      detailLabel="项目预览"
      detailMin={PREVIEW_MIN}
      narrow="drawer"
      detailTitle={chosen ? labels.get(chosen.id) ?? chosen.name : "项目"}
      onCloseDetail={closePreview}
    />
  );
}

/**
 * One project in the list: its name, one quiet line under it and one number. The row chooses the project (the preview shows it); the
 * way into the project is the preview's.
 */
function ProjectRow({ project, label, selected, to }: { project: GeoProjectSummary; label: string; selected: boolean; to: string }) {
  const alert = project.status === "paused" ? null : alertText(project);
  const journey = geoJourney(project);
  return (
    <ListRow
      to={to}
      selected={selected}
      title={<span className="block truncate">{label}</span>}
      meta={(
        <span data-geo-subline="" className="block truncate">
          {project.status === "paused" ? "已暂停" : alert ? (
            <>
              {/* The badge carries the red; the sentence is body text (F-G10). */}
              {project.alert.severe > 0 && project.alert.severity && <SeverityBadge level={project.alert.severity} className="mr-1.5 align-middle" />}
              <span data-geo-alert="" className="text-text-2">{alert}</span>
            </>
          ) : progressLine(project)}
        </span>
      )}
      actions={<Link className="rounded text-ui text-link hover:underline" to={journey.next.step ? geoDestinationPath(project.id, GEO_STEP_HOME[journey.next.step]) : `/app/geo/${encodeURIComponent(project.id)}`}>继续工作</Link>}
      trailing={(
        <span className="flex items-baseline gap-1.5 text-ui">
          <span className="text-caption text-text-3">可见度</span>
          <GeoCellText cell={project.headline.gvi} unit="index" hideSample />
        </span>
      )}
    />
  );
}
