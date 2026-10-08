import { useEffect, useState } from "react";
import { Plus, Radar } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { createGeoProject, GEO_STEP_KEYS, isGeoOff, listGeoProjects, patchGeoProject, useGeoFeature, type GeoProjectSummary } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import { GeoCellText } from "@/components/geo/GeoCellText";
import { GeoSparkline } from "@/components/geo/GeoSparkline";
import { GeoListSkeleton, GeoOffPage } from "@/components/geo/GeoStates";
import { coverageText, GEO_STEP_WORK, weekOf, withStartDate } from "@/components/geo/geoText";
import { useOpenGeoConversation } from "@/components/geo/useOpenGeoConversation";

type Listing =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "ready"; projects: GeoProjectSummary[] };

/**
 * “循证 GEO”'s home (plan §5.1, mockup g01): one row per product — its name
 * (with its start date after it when another project has the same name), a
 * line under it (the coverage window, and what is open: how many errors an AI
 * engine still makes about it), and on the right the 综合可见度指数 with its
 * trend against the target and the 品牌提及率 over P2 + P3. A number that does
 * not exist yet is “—”; a project that has only done one step is in the list
 * all the same. A paused project's row carries 继续.
 *
 * “新建项目” creates the project and lands in its conversation, where the
 * composer already carries the “循证 GEO” chip: no form.
 */
export function GeoHomePage() {
  const feature = useGeoFeature();
  const openConversation = useOpenGeoConversation();
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [creating, setCreating] = useState(false);

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

  if (feature === "off" || listing.kind === "off") return <GeoOffPage />;

  const create = () => {
    if (creating) return;
    setCreating(true);
    void createGeoProject({})
      .then((created) => openConversation({ projectId: created.projectId, sessionId: created.sessionId }))
      .catch((error: unknown) => {
        if (isGeoOff(error)) setListing({ kind: "off" });
        else toast.error(webErrorMessage(error, { fallback: "无法新建项目，请稍后重试。" }));
      })
      .finally(() => setCreating(false));
  };

  /** A paused project was set going again: its row says so without re-reading the list. */
  const resumed = (id: string) => setListing((previous) => (previous.kind === "ready"
    ? { kind: "ready", projects: previous.projects.map((project) => (project.id === id ? { ...project, status: "active" } : project)) }
    : previous));

  return (
    <PageShell
      title="循证 GEO"
      actions={(
        <Button onClick={create} loading={creating} disabled={listing.kind !== "ready"}>
          <Plus size={16} aria-hidden="true" />
          新建项目
        </Button>
      )}
    >
      {feature === "loading" || listing.kind === "loading" ? <GeoListSkeleton />
        : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
          : listing.projects.length === 0 ? <EmptyState icon={Radar} title="还没有循证 GEO 项目" />
            : <ProjectList projects={listing.projects} onResumed={resumed} />}
    </PageShell>
  );
}

function ProjectList({ projects, onResumed }: { projects: GeoProjectSummary[]; onResumed: (id: string) => void }) {
  // Two projects of one name are told apart by the day they started.
  const labels = withStartDate(projects);
  return (
    <div>
      <div aria-hidden="true" className="flex items-center gap-3 border-b border-border px-2 pb-2 text-caption text-text-3">
        <span className="min-w-0 flex-1">项目</span>
        {/* The same columns as a row's trailing group (`ListRow`: gap 8). */}
        <span className="flex shrink-0 items-center gap-2">
          <span className="w-16 sm:w-56">
            <span className="sm:hidden">可见度</span>
            <span className="hidden sm:inline">综合可见度指数</span>
          </span>
          <span className="w-20 sm:w-28">品牌提及率</span>
          <span className="w-4" />
        </span>
      </div>
      <List divided label="循证 GEO 项目">
        {projects.map((project) => <ProjectRow key={project.id} project={project} label={labels.get(project.id) ?? project.name} onResumed={() => onResumed(project.id)} />)}
      </List>
    </div>
  );
}

function ProjectRow({ project, label, onResumed }: { project: GeoProjectSummary; label: string; onResumed: () => void }) {
  const { gvi, mention } = project.headline;
  const alert = alertText(project);
  const line = subline(project);
  const [resuming, setResuming] = useState(false);
  const resume = () => {
    setResuming(true);
    void patchGeoProject(project.id, { status: "active" })
      .then(() => {
        toast.success("已继续。");
        onResumed();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "项目无法继续，请稍后重试。" })))
      .finally(() => setResuming(false));
  };
  return (
    <ListRow
      to={`/app/geo/${encodeURIComponent(project.id)}`}
      title={label}
      actions={project.status === "paused"
        ? <Button variant="text" size="sm" loading={resuming} onClick={resume} aria-label={`继续“${label}”`}>继续</Button>
        : undefined}
      meta={(
        <span data-geo-subline="">
          {line}
          {alert && (
            <>
              {line && " · "}
              {/* The badge carries the red; the sentence is body text (F-G10). */}
              {project.alert.severe > 0 && project.alert.severity && <SeverityBadge level={project.alert.severity} className="mr-1.5 align-middle" />}
              <span data-geo-alert="" className="text-text-2">{alert}</span>
            </>
          )}
        </span>
      )}
      trailing={(
        <>
          {/* Below 640 px the trend gives way to the number: no row may push
              the page sideways at 390 px. */}
          <span className="flex w-16 shrink-0 items-center gap-3 text-ui sm:w-56">
            <span className="w-8 shrink-0">
              <GeoCellText cell={gvi} unit="index" hideSample />
            </span>
            <GeoSparkline values={gvi.trend} target={gvi.target} width={132} height={28} className="hidden sm:block" />
          </span>
          <span className="w-20 shrink-0 text-ui sm:w-28">
            <GeoCellText cell={mention} unit="percent" layout="stack" />
          </span>
        </>
      )}
    />
  );
}

/**
 * What is open on the project, in the row's own words: the severe errors first (their badge carries the red), else the errors an
 * engine still makes, else articles stopped on a safety finding. The engine's sentence is read inside the project.
 */
function alertText(project: GeoProjectSummary): string | null {
  const { severe, wrongOurs, safety } = project.alert;
  if (severe > 0) return `${severe} 条严重讲错待处理`;
  if (wrongOurs > 0) return `${wrongOurs} 条讲错待处理`;
  if (safety > 0) return `${safety} 篇稿件的安全问题待确认`;
  return null;
}

/** “10月1日 – 12月31日 · 第 3 周”, or what a single-step project did. */
function subline(project: GeoProjectSummary): string {
  const steps = GEO_STEP_KEYS.filter((key) => project.steps[key]?.requested);
  const touched = GEO_STEP_KEYS.filter((key) => project.steps[key] && project.steps[key]!.status !== "none");
  if (steps.length > 0 && steps.length < GEO_STEP_KEYS.length) {
    const names = steps.map((key) => GEO_STEP_WORK[key]).join("、");
    return steps.every((key) => project.steps[key]?.status === "done") ? `只做了${names}` : `正在做${names}`;
  }
  if (touched.length === 0) return "还没开始";
  const start = project.startedAt ?? project.createdAt ?? null;
  const week = weekOf(start);
  return [coverageText(project.coverageDays, start), ...(week ? [`第 ${week} 周`] : []), ...(project.status === "paused" ? ["已暂停"] : [])].join(" · ");
}
