import { Link, useSearchParams } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Radar } from "lucide-react";
import { fetchWebMe, invalidateWebMe, WebApiError, WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, WEB_SESSION_SYNC_STORAGE_KEY, webErrorMessage } from "@/lib/apiClient";
import { createGeoProject, isGeoOff, listGeoProjects, useGeoFeature, type GeoProjectSummary } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Toolbar } from "@/components/ui/Toolbar";
import { alertText, progressLine } from "@/components/geo/GeoHomePreview";
import { geoJourney } from "@/components/geo/geoJourney";
import { GeoListSkeleton, GeoOffPage } from "@/components/geo/GeoStates";
import { withStartDate } from "@/components/geo/geoText";
import { useOpenGeoConversation } from "@/components/geo/useOpenGeoConversation";

const EMPTY_SENTENCE = "药企和医生在这里研究并传播自己产品的循证依据，也能看到各家 AI 是怎么表达的。";
type Sort = "recent" | "state";
type Listing = { kind: "loading" } | { kind: "off" } | { kind: "error"; message: string } | { kind: "ready"; projects: GeoProjectSummary[] };
const NO_PROJECTS: GeoProjectSummary[] = [];
type Pending = { kind: "unknown" } | { kind: "created"; id: string };
const pendingKey = (tenant: string, user: string) => `evimed.geo.create.v1:${encodeURIComponent(tenant)}:${encodeURIComponent(user)}`;
function readPending(key: string): Pending | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Pending;
    return value.kind === "created" && typeof value.id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value.id) ? value : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}
// These are emitted before the control project is created, not after a partial write.
function knownRejection(error: unknown): boolean {
  return error instanceof WebApiError && ((error.status === 400 && error.code === "geo_payload_invalid") || (error.status === 409 && error.code === "project_limit_reached") || isGeoOff(error));
}

function stateRank(project: GeoProjectSummary): number {
  if (project.status === "paused") return 4;
  if (project.alert.severe > 0) return 0;
  if (project.alert.wrongOurs > 0) return 1;
  if (project.alert.safety > 0) return 2;
  return 3;
}

export function GeoHomePage() {
  const feature = useGeoFeature();
  const openConversation = useOpenGeoConversation();
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [creating, setCreating] = useState(false);
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const [identityFailed, setIdentityFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [accountRevision, setAccountRevision] = useState(0);
  const accountRef = useRef<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const createdId = pending?.kind === "created" ? pending.id : null;

  useEffect(() => {
    const reset = () => { generation.current += 1; inFlight.current = false; accountRef.current = null; setAccountKey(null); setPending(null); setCreating(false); setListing({ kind: "loading" }); setAccountRevision((n) => n + 1); };
    const sync = (event: StorageEvent) => {
      if (event.key !== WEB_SESSION_SYNC_STORAGE_KEY && event.key !== null) return;
      invalidateWebMe();
      reset();
    };
    window.addEventListener(WEB_SESSION_STARTED_EVENT, reset);
    window.addEventListener(WEB_SESSION_ENDED_EVENT, reset);
    window.addEventListener("storage", sync);
    return () => { generation.current += 1; accountRef.current = null; window.removeEventListener(WEB_SESSION_STARTED_EVENT, reset); window.removeEventListener(WEB_SESSION_ENDED_EVENT, reset); window.removeEventListener("storage", sync); };
  }, []);
  useEffect(() => {
    const epoch = generation.current;
    let live = true;
    setIdentityFailed(false);
    void fetchWebMe().then((me) => {
      if (!live || generation.current !== epoch) return;
      if (!me?.user?.id) { setIdentityFailed(true); return; }
      const key = pendingKey(me.tenant?.id ?? me.user.tenantId ?? me.user.id, me.user.id);
      try { const value = readPending(key); accountRef.current = key; setPending(value); setAccountKey(key); }
      catch { setIdentityFailed(true); }
    }).catch(() => { if (live && generation.current === epoch) setIdentityFailed(true); });
    return () => { live = false; };
  }, [accountRevision]);
  useEffect(() => {
    if (!accountKey) return undefined;
    const changed = (event: StorageEvent) => { if (event.key === accountKey && accountRef.current === accountKey) { try { setPending(readPending(accountKey)); } catch { setIdentityFailed(true); } } };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [accountKey]);
  const [query, setQuery] = useState("");
  const [params, setParams] = useSearchParams();
  const sort: Sort = params.get("sort") === "state" ? "state" : "recent";
  const asked = params.get("project");

  useEffect(() => {
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    const epoch = generation.current;
    setListing({ kind: "loading" });
    void listGeoProjects().then(
      (projects) => { if (live && generation.current === epoch) setListing({ kind: "ready", projects }); },
      (error: unknown) => {
        if (!live || generation.current !== epoch) return;
        setListing(isGeoOff(error) ? { kind: "off" } : { kind: "error", message: webErrorMessage(error, { fallback: "项目列表暂时无法读取。" }) });
      },
    );
    return () => { live = false; };
  }, [feature, reloads, accountRevision]);

  const projects = listing.kind === "ready" ? listing.projects : NO_PROJECTS;
  const labels = useMemo(() => withStartDate(projects), [projects]);
  const ordered = useMemo(() => [...projects]
    .filter((project) => `${project.name} ${project.product?.brandName ?? ""} ${project.product?.genericName ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => (sort === "state" ? stateRank(a) - stateRank(b) : 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [projects, query, sort]);

  if (feature === "off" || listing.kind === "off") return <GeoOffPage />;

  const create = async () => {
    const key = accountRef.current;
    if (!key || inFlight.current || pending) return;
    try {
      if (readPending(key)) { setPending(readPending(key)); return; }
      localStorage.setItem(key, JSON.stringify({ kind: "unknown" }));
    } catch { setIdentityFailed(true); return; }
    inFlight.current = true;
    const epoch = generation.current;
    const current = () => generation.current === epoch && accountRef.current === key;
    setPending({ kind: "unknown" });
    setCreating(true);
    try {
      const created = await createGeoProject({});
      const known: Pending = { kind: "created", id: created.id };
      try { localStorage.setItem(key, JSON.stringify(known)); } catch { /* The existing unknown marker remains. */ }
      if (!current()) return;
      setPending(known);
      try {
        const opened = await openConversation({ geoId: created.id, projectId: created.projectId, sessionId: created.sessionId });
        if (current() && !opened) setReloads((value) => value + 1);
        if (opened) { try { localStorage.removeItem(key); } catch { /* A retained marker is safer than a duplicate. */ } }
      } catch { if (current()) setReloads((value) => value + 1); }
    } catch (error: unknown) {
      if (knownRejection(error)) {
        try { localStorage.removeItem(key); } catch { /* Keep the conservative marker. */ }
        if (current()) { try { setPending(readPending(key)); } catch { setIdentityFailed(true); } if (isGeoOff(error)) setListing({ kind: "off" }); else toast.error(webErrorMessage(error, { fallback: "无法新建项目，请稍后重试。" })); }
      } else if (current()) { setQuery(""); setReloads((value) => value + 1); }
    } finally { if (current()) { inFlight.current = false; setCreating(false); } }
  };
  const clearPending = () => {
    if (!accountKey || listing.kind !== "ready" || creating) return;
    try { localStorage.removeItem(accountKey); setPending(null); } catch { setIdentityFailed(true); }
  };
  const acknowledgeCreated = () => {
    if (!accountKey || pending?.kind !== "created") return;
    try { localStorage.removeItem(accountKey); setPending(null); } catch { setIdentityFailed(true); }
  };

  const loading = feature === "loading" || listing.kind === "loading";
  const none = listing.kind === "ready" && projects.length === 0;
  const newProject = <Button actionKind="set" onClick={() => void create()} loading={creating} disabled={listing.kind !== "ready" || pending !== null || !accountKey || identityFailed}><Plus size={16} aria-hidden="true" />新建项目</Button>;
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col px-4 md:px-6">
      <PageHeader title="循证 GEO" actions={none && !pending ? undefined : newProject} className="shrink-0 pb-3 pt-5" />
      {identityFailed && <div role="alert" className="mb-4 text-ui">无法确认账号或保存创建状态，请重试后再新建。<Button variant="secondary" size="sm" onClick={() => setAccountRevision((n) => n + 1)}>重试账号读取</Button></div>}
      {pending?.kind === "unknown" && <div role="status" className="mb-4 rounded border border-border p-4 text-ui"><p>项目创建结果未知，项目可能仍在创建，稍后才出现在列表中；再次新建可能产生重复项目。</p>{listing.kind === "ready" && !creating && <Button variant="secondary" size="sm" onClick={clearPending}>已检查列表，仍要新建</Button>}</div>}
      {createdId && <div role="status" className="mb-4 rounded border border-border p-4 text-ui">项目已创建，但对话未能打开。<Link className="ml-2 text-link underline" to={`/app/geo/${encodeURIComponent(createdId)}`} onClick={acknowledgeCreated}>打开已创建的项目</Link></div>}
      {projects.length > 0 && <Toolbar label="项目排序" filters={[{
        kind: "chips", label: "排序", value: sort, neutral: "recent",
        options: [{ value: "recent", label: "最近活动" }, { value: "state", label: "需要处理的在前" }],
        onChange: (next) => setParams((current) => { const updated = new URLSearchParams(current); if (next === "recent") updated.delete("sort"); else updated.set("sort", next); return updated; }, { replace: true }),
      }]} search={{ label: "搜索项目", value: query, onChange: setQuery, onClear: () => setQuery("") }} summary={`${ordered.length} 个项目`} />}
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {loading ? <GeoListSkeleton /> : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} /> : none ? <EmptyState icon={Radar} title="还没有循证 GEO 项目" description={EMPTY_SENTENCE} action={pending ? undefined : newProject} className="min-h-0 flex-1" /> : ordered.length === 0 ? <p className="py-6 text-ui text-text-2">没有符合的项目。</p> : (
          <ul aria-label="循证 GEO 项目" className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-2 xl:grid-cols-3">
            {ordered.map((project) => {
              const label = labels.get(project.id) || project.name || "待命名项目";
              const product = [project.product?.brandName, project.product?.genericName].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ");
              const activity = Number.isNaN(Date.parse(project.updatedAt)) ? "最近活动时间未知" : `最近活动 ${new Date(project.updatedAt).toLocaleDateString("zh-CN")}`;
              const journey = geoJourney(project);
              const progress = journey.stage === "queued" || journey.stage === "blocked" ? journey.title : progressLine(project);
              return <li key={project.id}><Link aria-label={label} aria-current={asked === project.id ? "true" : undefined} to={`/app/geo/${encodeURIComponent(project.id)}`} className={`flex h-full min-h-40 flex-col gap-3 rounded-lg border p-5 transition-colors hover:bg-surface-2 ${asked === project.id ? "border-accent" : "border-border"}`}>
                <span className="font-semibold text-text">{label}</span>
                {product && product !== project.name && <span className="text-ui text-text-2">{product}</span>}
                <span data-geo-subline="" className="text-ui text-text-2">{project.status === "paused" ? "已暂停" : project.status === "archived" ? "已归档" : alertText(project) || progress || "暂无工作"}</span>
                <span className="mt-auto text-caption text-text-3">{activity}</span>
              </Link></li>;
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
