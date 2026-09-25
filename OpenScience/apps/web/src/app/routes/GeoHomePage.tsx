import { useEffect, useState } from "react";
import { ChevronRight, Plus, Radar } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { createGeoProject, GEO_STEP_KEYS, isGeoOff, listGeoProjects, useGeoFeature, type GeoProjectSummary } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { GeoCellText } from "@/components/geo/GeoCellText";
import { GeoSparkline } from "@/components/geo/GeoSparkline";
import { GeoListSkeleton, GeoOffPage } from "@/components/geo/GeoStates";
import { coverageText, GEO_STEP_WORK, weekOf } from "@/components/geo/geoText";
import { useOpenGeoConversation } from "@/components/geo/useOpenGeoConversation";

type Listing =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "ready"; projects: GeoProjectSummary[] };

/**
 * 「循证 GEO」's home (plan §5.1, mockup g01): one row per product — its name,
 * a line under it (the coverage window, or the one red sentence when an AI
 * engine says something wrong about it), and on the right the 综合可见度指数
 * with its trend against the target and the 品牌提及率 over P2 + P3. A number
 * that does not exist yet is 「—」; a project that has only done one step is
 * in the list all the same.
 *
 * 「新建项目」 creates the project and lands in its conversation, where the
 * composer already carries the 「循证 GEO」 chip: no form.
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
        else toast.error(webErrorMessage(error, { fallback: "项目没有建成，请稍后重试。" }));
      })
      .finally(() => setCreating(false));
  };

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
          : listing.projects.length === 0 ? <EmptyState icon={Radar} title="还没有 GEO 项目" />
            : <ProjectList projects={listing.projects} />}
    </PageShell>
  );
}

function ProjectList({ projects }: { projects: GeoProjectSummary[] }) {
  return (
    <div>
      <div aria-hidden="true" className="flex items-center gap-3 border-b border-border px-2 pb-2 text-caption text-text-3">
        <span className="min-w-0 flex-1">项目</span>
        <span className="w-56 shrink-0">综合可见度指数</span>
        <span className="w-28 shrink-0">品牌提及率</span>
        <span className="w-4 shrink-0" />
      </div>
      <List divided label="GEO 项目">
        {projects.map((project) => <ProjectRow key={project.id} project={project} />)}
      </List>
    </div>
  );
}

function ProjectRow({ project }: { project: GeoProjectSummary }) {
  const { gvi, mention } = project.headline;
  const alert = alertText(project);
  const line = subline(project);
  return (
    <ListRow
      to={`/app/geo/${encodeURIComponent(project.id)}`}
      title={<span className="font-medium">{project.name}</span>}
      meta={(
        <span data-geo-subline="">
          {line}
          {alert && (
            <>
              {line && " · "}
              <span className="text-danger">{alert}</span>
            </>
          )}
        </span>
      )}
      trailing={(
        <>
          <span className="flex w-56 shrink-0 items-center gap-3 text-ui">
            <span className="w-8 shrink-0">
              <GeoCellText cell={gvi} unit="index" hideSample />
            </span>
            <GeoSparkline values={gvi.trend} target={gvi.target} width={132} height={28} />
          </span>
          <span className="w-28 shrink-0 text-ui">
            <GeoCellText cell={mention} unit="percent" layout="stack" />
          </span>
          <ChevronRight size={16} aria-hidden="true" className="w-4 shrink-0 text-text-3" />
        </>
      )}
    />
  );
}

/**
 * The red sentence: what an engine says wrong about our product, or an open
 * safety finding. The server's own sentence when it wrote one.
 */
function alertText(project: GeoProjectSummary): string | null {
  if (project.alert.text) return project.alert.text;
  const parts = [
    ...(project.alert.safety > 0 ? [`${project.alert.safety} 个安全问题待处理`] : []),
    ...(project.alert.wrongOurs > 0 ? [`${project.alert.wrongOurs} 条讲错我方待纠正`] : []),
  ];
  return parts.length ? parts.join(" · ") : null;
}

/** 「10月1日 – 12月31日 · 第 3 周」, or what a single-step project did. */
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
