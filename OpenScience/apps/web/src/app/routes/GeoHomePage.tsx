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
type Pending = { kind: "unknown"; requestKey?: string; retried?: boolean; legacyMarker?: string } | { kind: "created"; id: string; requestKey?: string } | { kind: "gone" | "conflict"; requestKey: string };
const pendingKey = (tenant: string, user: string, generation?: string) => `evimed.geo.create.v1:${encodeURIComponent(tenant)}:${encodeURIComponent(user)}${generation ? `:${encodeURIComponent(generation)}` : ""}`;
function readPending(key: string): Pending | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Pending;
    if ((value.kind === "gone" || value.kind === "conflict") && typeof value.requestKey === "string") return value;
    if (value.kind === "created" && typeof value.id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value.id)) return value;
    return value.kind === "unknown" && typeof value.requestKey === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.requestKey) ? value : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}
function readLegacyPending(key: string): Pending | null {
  const legacyMarker = localStorage.getItem(key);
  return legacyMarker === null ? null : { kind: "unknown", legacyMarker };
}
// Coordinate marker changes across tabs in browsers with the Web Locks API.
async function withPendingLock<T>(key: string, update: () => T): Promise<T> {
  return navigator.locks ? navigator.locks.request(key, update) : update();
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
  const [identityError, setIdentityError] = useState<"unavailable" | "missing-generation" | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [accountRevision, setAccountRevision] = useState(0);
  const accountRef = useRef<{ key: string; legacyKey: string; generation: string } | null>(null);
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
    setIdentityError(null);
    void fetchWebMe().then((me) => {
      if (!live || generation.current !== epoch) return;
      if (!me?.user?.id || !me.user.accountGeneration) {
        accountRef.current = null;
        setAccountKey(null);
        setPending(null);
        setIdentityError(me?.user?.id ? "missing-generation" : "unavailable");
        return;
      }
      const oldKey = pendingKey(me.tenant?.id ?? me.user.tenantId ?? me.user.id, me.user.id);
      const key = pendingKey(me.tenant?.id ?? me.user.tenantId ?? me.user.id, me.user.id, me.user.accountGeneration);
      try {
        const value = readPending(key) ?? readLegacyPending(oldKey);
        accountRef.current = { key, legacyKey: oldKey, generation: me.user.accountGeneration };
        setPending(value);
        setAccountKey(key);
      } catch { setIdentityError("unavailable"); }
    }).catch(() => { if (live && generation.current === epoch) setIdentityError("unavailable"); });
    return () => { live = false; };
  }, [accountRevision]);
  useEffect(() => {
    if (!accountKey) return undefined;
    const changed = (event: StorageEvent) => {
      const account = accountRef.current;
      if (account?.key !== accountKey || (event.key !== account.key && event.key !== account.legacyKey)) return;
      try { setPending(readPending(account.key) ?? readLegacyPending(account.legacyKey)); }
      catch { setIdentityError("unavailable"); }
    };
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

  const create = async (retry = false) => {
    const account = accountRef.current;
    if (!account || inFlight.current || identityError) return;
    const { key } = account;
    const epoch = generation.current;
    const current = () => generation.current === epoch && accountRef.current === account;
    inFlight.current = true;
    setCreating(true);
    try {
      const requestKey = await withPendingLock(key, () => {
        if (!current()) return null;
        const existing = readPending(key);
        if (retry) {
          if (existing?.kind !== "unknown" || !existing.requestKey || existing.requestKey !== pending?.requestKey) return null;
          const retrying: Pending = { ...existing, retried: true };
          localStorage.setItem(key, JSON.stringify(retrying));
          setPending(retrying);
          return existing.requestKey;
        }
        const unresolved = existing ?? readLegacyPending(account.legacyKey) ?? pending;
        if (unresolved) { setPending(unresolved); return null; }
        const next = crypto.randomUUID();
        localStorage.setItem(key, JSON.stringify({ kind: "unknown", requestKey: next }));
        setPending({ kind: "unknown", requestKey: next });
        return next;
      });
      if (!requestKey || !current()) return;
      const replace = (kind: "unknown" | "created" | "active", next: Pending | null, requireNoRetry = false) => withPendingLock(key, () => {
        const stored = readPending(key);
        if (!stored || stored.requestKey !== requestKey) return false;
        if (kind === "active" ? stored.kind !== "unknown" && stored.kind !== "created" : stored.kind !== kind) return false;
        if (requireNoRetry && stored.kind === "unknown" && stored.retried) return false;
        if (next) localStorage.setItem(key, JSON.stringify(next));
        else localStorage.removeItem(key);
        return true;
      });
      let created: Awaited<ReturnType<typeof createGeoProject>>;
      try {
        created = await createGeoProject({ requestKey, accountGeneration: account.generation });
      } catch (error: unknown) {
        if (error instanceof WebApiError && error.status === 410 && error.code === "geo_project_deleted") {
          const gone: Pending = { kind: "gone", requestKey };
          if (await replace("active", gone) && current()) setPending(gone);
        } else if (error instanceof WebApiError && error.status === 409 && error.code === "geo_request_key_conflict") {
          const conflict: Pending = { kind: "conflict", requestKey };
          if (await replace("unknown", conflict) && current()) setPending(conflict);
        } else if (error instanceof WebApiError && error.code === "geo_account_changed") {
          if (current()) {
            invalidateWebMe();
            setAccountRevision((value) => value + 1);
          }
        } else if (!retry && error instanceof WebApiError && error.code === "project_limit_reached" && await replace("unknown", null, true)) {
          if (current()) {
            setPending(null);
            toast.error(webErrorMessage(error, { fallback: "无法新建项目，请稍后重试。" }));
          }
        } else if (current()) {
          setQuery("");
          setReloads((value) => value + 1);
        }
        return;
      }
      const known: Pending = { kind: "created", id: created.id, requestKey };
      if (!(await replace("unknown", known)) || !current()) return;
      setPending(known);
      try {
        const opened = await openConversation({ geoId: created.id, projectId: created.projectId, sessionId: created.sessionId });
        if (opened && await replace("created", null) && current()) setPending(null);
        else if (current()) setReloads((value) => value + 1);
      } catch { if (current()) setReloads((value) => value + 1); }
    } catch { if (current()) setIdentityError("unavailable"); }
    finally { if (current()) { inFlight.current = false; setCreating(false); } }
  };
  const clearPending = () => {
    const account = accountRef.current;
    if (!account || !pending || creating) return;
    if (pending.kind === "unknown" && listing.kind !== "ready") return;
    const { key } = account;
    void withPendingLock(key, () => {
      if (accountRef.current !== account && pending.kind !== "created") return;
      const stored = readPending(key);
      const active = stored ?? readLegacyPending(account.legacyKey);
      if (active && JSON.stringify(active) !== JSON.stringify(pending)) {
        if (accountRef.current === account) setPending(active);
        return;
      }
      if (stored) localStorage.removeItem(key);
      else if (active) localStorage.removeItem(account.legacyKey);
      if (accountRef.current === account) setPending(readLegacyPending(account.legacyKey));
    }).catch(() => { if (accountRef.current === account) setIdentityError("unavailable"); });
  };

  const loading = feature === "loading" || listing.kind === "loading";
  const none = listing.kind === "ready" && projects.length === 0;
  const newProject = <Button actionKind="set" onClick={() => void create(false)} loading={creating} disabled={listing.kind !== "ready" || pending !== null || !accountKey || identityError !== null}><Plus size={16} aria-hidden="true" />新建项目</Button>;
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col px-4 md:px-6">
      <PageHeader title="循证 GEO" actions={none && !pending ? undefined : newProject} className="shrink-0 pb-3 pt-5" />
      {identityError && <div role="alert" className="mb-4 text-ui">{identityError === "missing-generation" ? "服务器未返回确认新建请求所需的账号信息，暂时无法新建项目。" : "无法确认账号或保存创建状态，请重试后再新建。"}<Button variant="secondary" size="sm" onClick={() => setAccountRevision((n) => n + 1)}>重试账号读取</Button></div>}
      {pending?.kind === "unknown" && <div role="status" className="mb-4 rounded border border-border p-4 text-ui"><p>项目创建结果未知，项目可能仍在创建，稍后才出现在列表中；再次新建可能产生重复项目。</p>{!creating && pending.requestKey && <Button variant="secondary" size="sm" onClick={() => void create(true)}>重试同一创建请求</Button>}{listing.kind === "ready" && !creating && <Button variant="secondary" size="sm" onClick={clearPending}>已检查列表，仍要新建</Button>}</div>}
      {(pending?.kind === "gone" || pending?.kind === "conflict") && <div role="status" className="mb-4 rounded border border-border p-4 text-ui">{pending.kind === "gone" ? "该创建请求对应的项目已删除。" : "此请求编号已用于另一项创建，无法重试。请检查项目列表后再开始新项目。"}<Button variant="secondary" size="sm" onClick={clearPending}>开始另一个项目</Button></div>}
      {createdId && <div role="status" className="mb-4 rounded border border-border p-4 text-ui">项目已创建，但对话未能打开。<Link className="ml-2 text-link underline" to={`/app/geo/${encodeURIComponent(createdId)}`} onClick={clearPending}>打开已创建的项目</Link></div>}
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
