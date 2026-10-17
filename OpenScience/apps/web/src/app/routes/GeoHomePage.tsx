import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
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

/** What the module is for, said to a pharma company or a doctor who has not started: the work, and what they get to see. */
const EMPTY_SENTENCE = "药企和医生在这里研究并传播自己产品的循证依据，也能看到各家 AI 是怎么表达的。";

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

/**
 * “循证 GEO”'s home (plan §5.1, mockup g01): one row per product — its name
 * (with its start date after it when another project has the same name), a
 * line under it (the coverage window, and what is open: how many errors an AI
 * engine still makes about it), and on the right the 综合可见度指数 with its
 * trend against the target and the 品牌提及率 over P2 + P3. A number that does
 * not exist yet is “—”; a project that has only done one step is in the list
 * all the same. A paused project's row says 已暂停 under its name and carries 继续
 * right after it — a row's action, not a cell among the values (R19, audit D C4: it
 * stood where the numbers do and read 「继续 | 未测 | 未测」). Two or more projects
 * are ordered by the latest activity, or by what needs the reader first (`?sort=state`).
 *
 * “新建项目” creates the project and lands in its conversation, where the
 * composer already carries the “循证 GEO” chip: no form. With no project yet the
 * page says in one sentence what the module is for and offers that one button in
 * the empty state; the header has none then, so the page has one solid button.
 */
export function GeoHomePage() {
  const feature = useGeoFeature();
  const openConversation = useOpenGeoConversation();
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const sort: Sort = params.get("sort") === "state" ? "state" : "recent";

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

  const none = feature !== "loading" && listing.kind === "ready" && listing.projects.length === 0;
  const newProject = (
    <Button onClick={create} loading={creating} disabled={listing.kind !== "ready"}>
      <Plus size={16} aria-hidden="true" />
      新建项目
    </Button>
  );

  const projects = listing.kind === "ready" ? listing.projects : [];
  return (
    <PageShell
      title="循证 GEO"
      actions={none ? undefined : newProject}
      // The one row of controls, over the list: how it is ordered, and how many there are. With one project there is nothing to order.
      toolbar={projects.length > 1 ? {
        label: "项目排序",
        filters: [{
          kind: "chips", label: "排序", value: sort, neutral: "recent",
          options: [{ value: "recent", label: "最近活动" }, { value: "state", label: "需要处理的在前" }],
          onChange: (next) => setParams((current) => {
            const updated = new URLSearchParams(current);
            if (next === "recent") updated.delete("sort"); else updated.set("sort", next);
            return updated;
          }, { replace: true }),
        }],
        summary: `${projects.length} 个项目`,
      } : undefined}
    >
      {feature === "loading" || listing.kind === "loading" ? <GeoListSkeleton />
        : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
          : listing.projects.length === 0
            ? <EmptyState icon={Radar} title="还没有循证 GEO 项目" description={EMPTY_SENTENCE} action={newProject} />
            : <ProjectList projects={listing.projects} sort={sort} onResumed={resumed} />}
    </PageShell>
  );
}

function ProjectList({ projects, sort, onResumed }: { projects: GeoProjectSummary[]; sort: Sort; onResumed: (id: string) => void }) {
  // Two projects of one name are told apart by the day they started.
  const labels = withStartDate(projects);
  const ordered = useMemo(() => sortProjects(projects, sort), [projects, sort]);
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
        {ordered.map((project) => <ProjectRow key={project.id} project={project} label={labels.get(project.id) ?? project.name} onResumed={() => onResumed(project.id)} />)}
      </List>
    </div>
  );
}

function ProjectRow({ project, label, onResumed }: { project: GeoProjectSummary; label: string; onResumed: () => void }) {
  const { gvi, mention } = project.headline;
  const alert = alertText(project);
  const line = subline(project);
  const [resuming, setResuming] = useState(false);
  const paused = project.status === "paused";
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
          {/* The status and the one thing to do about it, together and under the name — above the row's stretched link, so it is pressed on its own. */}
          {paused && (
            <>
              {(line || alert) && " · "}
              <span>已暂停</span>
              <Button variant="text" size="sm" loading={resuming} onClick={resume} aria-label={`继续“${label}”`} className="relative z-sticky -my-1 ml-1">继续</Button>
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
  return [coverageText(project.coverageDays, start), ...(week ? [`第 ${week} 周`] : [])].join(" · ");
}
