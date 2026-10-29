import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { CalendarClock, Layers, RotateCw, SearchX } from "lucide-react";
import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import {
  deleteZone,
  fetchZone,
  fetchZoneCards,
  fetchZoneOverview,
  followZone,
  updateZone,
  type TopicCard,
  type ZoneDetail,
  type ZoneOverview as ZoneOverviewData,
} from "@/lib/evidenceTopicClient";
import { frontierAbsence, useFrontierFeature } from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { useWide } from "@/lib/useMediaQuery";
import { ZoneSubscription } from "@/components/capsule/ZoneSubscription";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell, type PageTabs } from "@/components/layout/PageShell";
import { PageTitle } from "@/components/layout/PageTitle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button, buttonClasses } from "@/components/ui/Button";
import type { MenuEntry } from "@/components/ui/Menu";
import { StateScreen } from "@/components/ui/StateScreen";
import { FrontierBack, evidenceFromState } from "@/components/frontier/FrontierBack";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { ZoneCardBlock } from "@/components/frontier/zone/ZoneCardBlock";
import { ZoneHeader } from "@/components/frontier/zone/ZoneHeader";
import { ZoneItemsList, useItemsToolbar, useZoneItems } from "@/components/frontier/zone/ZoneItemsTab";
import { ZoneModules } from "@/components/frontier/zone/ZoneModules";
import { ZoneRail, railHasContent } from "@/components/frontier/zone/ZoneRail";
import type { ZoneEditorProps } from "@/components/frontier/zone/zoneEditor";
import {
  EMPTY_ITEMS_VIEW,
  itemsParams,
  readItemsView,
  zonePath,
  zoneResearchDraft,
  zoneTabOf,
  type ZoneItemsView,
  type ZoneTab,
} from "@/components/frontier/zone/zoneText";
import { useZoneFrom } from "@/components/frontier/zone/useZoneFrom";

/** The directory this page is one step down from. */
const DIRECTORY = "/app/frontier?view=zones";

/**
 * The drawer that creates and edits 我的专区 (`ZoneEditorDrawer`, ez-web-dir). The page is written against its props
 * (`ZoneEditorProps`) and takes it as `editor`; until it is wired here the page offers neither 「编辑」 nor 「以此新建我的专区」.
 * Wire it with: `import { ZoneEditorDrawer } from "@/components/frontier/ZoneEditorDrawer"; const ZONE_EDITOR = ZoneEditorDrawer;`.
 */
const ZONE_EDITOR: ComponentType<ZoneEditorProps> | null = null;

/** One Chinese sentence for a refused zone request. */
function zoneErrorMessage(error: unknown): string {
  return webErrorMessage(error, {
    codes: {
      evidence_revision_conflict: "这个专区刚刚有更新，请刷新后再试。",
      evidence_owner_required: "只有创建者可以修改这个专区。",
      evidence_not_found: "这个专区已不存在。",
    },
    fallback: "暂时读不到这个专区，请稍后重试。",
  });
}

type ZoneState =
  | { kind: "loading" }
  | { kind: "ready"; zone: ZoneDetail }
  | { kind: "not-offered" }
  | { kind: "missing" }
  | { kind: "off" }
  | { kind: "error"; message: string };

type OverviewState =
  | { kind: "loading" }
  | { kind: "ready"; overview: ZoneOverviewData }
  | { kind: "error"; message: string };

/**
 * One topic zone's page (owner 2026-10-29, plan `docs/superpowers/plans/2026-10-29-evidence-zone-topics.md` 4.3): its name, its
 * keywords, its scope and one line of facts; and under the band three views — 概览 (the modules the server composes for the zone's type,
 * and a right column), 动态 (the zone's items, filtered) and, only when the team's interface holds any, 证据卡片. The address holds the
 * view (`?tab=`) and the 动态 tab's filters, and is reached by the zone's id or its readable name (`/s/:slug`).
 */
export function FrontierZonePage({ editor = ZONE_EDITOR }: { editor?: ComponentType<ZoneEditorProps> | null } = {}) {
  const feature = useFrontierFeature();
  const { zoneId = "", slug = "" } = useParams();
  if (feature === "off") return <FrontierOffPage />;
  // The server's detail route takes the id or the readable name in the same place.
  const ref = slug || zoneId;
  return <ZoneLoader key={ref} reference={ref} ready={feature !== "loading"} editor={editor} />;
}

function ZoneLoader({ reference, ready, editor }: { reference: string; ready: boolean; editor: ComponentType<ZoneEditorProps> | null }) {
  const [state, setState] = useState<ZoneState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return undefined;
    let active = true;
    fetchZone(reference).then(
      (zone) => { if (active) setState({ kind: "ready", zone }); },
      (error: unknown) => {
        if (!active) return;
        const absence = frontierAbsence(error);
        if (absence === "off") setState({ kind: "off" });
        else if (absence === "not-offered") setState({ kind: "not-offered" });
        else if (error instanceof WebApiError && error.status === 404) setState({ kind: "missing" });
        else setState({ kind: "error", message: zoneErrorMessage(error) });
      },
    );
    return () => { active = false; };
  }, [reference, ready, attempt]);

  const location = useLocation();
  const from = evidenceFromState(location.state);
  // Opened from the directory the way back is that page as the reader left it (its view, its search, its scroll); from anywhere else, the directory.
  const back = from ? <FrontierBack historyBack to={from.to} label={from.label} /> : <FrontierBack to={DIRECTORY} label="证据专区" />;

  if (state.kind === "off") return <FrontierOffPage />;
  if (state.kind === "not-offered") {
    return (
      <StateScreen icon={CalendarClock} title="证据专区还在准备" titleAs="h1" back={{ to: "/app/frontier", label: "回到前沿动态" }}>
        <PageTitle page="证据专区" />
      </StateScreen>
    );
  }
  if (state.kind === "missing") {
    return (
      <StateScreen icon={SearchX} title="这个专区已不存在" titleAs="h1"
        action={<Link to={DIRECTORY} className={buttonClasses({ variant: "secondary" })}>看全部专区</Link>}
        back={{ to: "/app/frontier", label: "回到前沿动态" }}>
        <PageTitle page="证据专区" />
      </StateScreen>
    );
  }
  if (state.kind !== "ready") {
    return (
      <PageShell title="证据专区" back={back}>
        {state.kind === "loading" && <FrontierSkeleton />}
        {state.kind === "error" && <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />}
      </PageShell>
    );
  }
  return <ZoneBody zone={state.zone} back={back} editor={editor} onZone={(zone) => setState({ kind: "ready", zone })} />;
}

/* ----------------------------------------------------------------------- body */

function ZoneBody({ zone, back, editor: Editor, onZone }: {
  zone: ZoneDetail;
  back: ReactNode;
  editor: ComponentType<ZoneEditorProps> | null;
  onZone: (zone: ZoneDetail) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const wide = useWide();
  const [params, setParams] = useSearchParams();
  const path = zonePath(zone);
  const from = useZoneFrom(zone.title);
  const [overviewState, setOverviewState] = useState<OverviewState>({ kind: "loading" });
  const [overviewAttempt, setOverviewAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ZoneEditorProps["mode"] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let active = true;
    fetchZoneOverview(zone.id).then(
      (overview) => { if (active) setOverviewState({ kind: "ready", overview }); },
      (error: unknown) => { if (active) setOverviewState({ kind: "error", message: zoneErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [zone.id, overviewAttempt]);
  const overview = overviewState.kind === "ready" ? overviewState.overview : null;

  // The team's cards: the zone's own count, else what the overview's module says.
  const cardsModule = overview?.modules.find((module) => module.key === "cards");
  const cardCount = Math.max(zone.cards, cardsModule?.key === "cards" ? cardsModule.total : 0);
  const tab = zoneTabOf(params.get("tab"), cardCount > 0);
  const view = useMemo(() => readItemsView(params), [params]);
  const setView = useCallback((patch: Partial<ZoneItemsView>) => {
    setParams((current) => itemsParams({ ...readItemsView(current), ...patch }), { replace: true, state: location.state });
  }, [setParams, location.state]);
  const switchTab = (next: ZoneTab) => setParams(next === "overview" ? new URLSearchParams() : next === "items" ? itemsParams(EMPTY_ITEMS_VIEW) : new URLSearchParams({ tab: next }), { replace: true, state: location.state });

  const items = useZoneItems(zone, view, tab === "items");
  const toolbar = useItemsToolbar({ view, set: setView, items, count: view.week ? items.rows.length : items.total });

  /* ---------------------------------------------------------------- actions */
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { toast.error(zoneErrorMessage(error)); } finally { setBusy(false); }
  };
  const toggleFollow = () => void run(async () => { onZone(await followZone(zone, !zone.following)); });
  const togglePublished = () => void run(async () => {
    const updated = await updateZone(zone, { published: !zone.published });
    onZone(updated);
    toast.success(updated.published ? "已公开到平台" : "已取消公开");
  });
  const remove = () => void run(async () => {
    await deleteZone(zone.id);
    toast.success("已删除专区");
    navigate(DIRECTORY, { replace: true });
  });
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      toast.success("已复制链接");
    } catch {
      toast.error("没有复制成功");
    }
  };
  const research = () => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(zoneResearchDraft(zone, overview)) } });

  const ownUserZone = zone.kind === "user" && zone.canEdit;
  const more: MenuEntry[] = [
    { label: "深入研究", onSelect: research },
    { label: "复制链接", onSelect: () => void copyLink() },
    ...(Editor ? [{ label: "以此新建我的专区", onSelect: () => setEditing("create") }] : []),
    ...(ownUserZone || zone.canDelete ? ["separator" as const] : []),
    ...(ownUserZone ? [{ label: zone.published ? "取消公开" : "公开到平台", disabled: busy, onSelect: togglePublished }] : []),
    ...(zone.canDelete ? [{ label: "删除", destructive: true, onSelect: () => setConfirmDelete(true) }] : []),
  ];
  const primary = zone.canEdit
    ? (Editor ? { id: "edit", label: "编辑", onSelect: () => setEditing("edit") } : undefined)
    : { id: "follow", label: zone.following ? "已关注" : "关注", loading: busy, onSelect: toggleFollow };

  const tabs: PageTabs<ZoneTab> = {
    label: "专区视图",
    items: [
      { value: "overview", label: "概览" },
      { value: "items", label: "动态" },
      ...(cardCount > 0 ? [{ value: "cards" as const, label: "证据卡片" }] : []),
    ],
    value: tab,
    onChange: switchTab,
    panelId: "zone-panel",
  };
  const rail = overview && railHasContent(overview.side) ? <ZoneRail side={overview.side} path={path} /> : null;

  return (
    <PageShell
      title={zone.title}
      documentTitle={`${zone.title} · 证据专区`}
      width="page"
      back={back}
      actionPlan={{ primary, overflow: more, overflowLabel: "更多操作" }}
      underTitle={<ZoneHeader zone={zone} path={path} cards={cardCount} />}
      tabs={tabs}
      toolbar={tab === "items" ? toolbar : undefined}
      aside={tab === "overview" && wide && rail ? rail : undefined}
      asideLabel="专区侧栏"
    >
      {tab === "overview" && (
        <>
          <OverviewTab state={overviewState} from={from} path={path} onReload={() => { setOverviewState({ kind: "loading" }); setOverviewAttempt((value) => value + 1); }} />
          {!wide && rail && <div className="mt-10">{rail}</div>}
        </>
      )}
      {tab === "items" && <ZoneItemsList zone={zone} view={view} items={items} onClear={() => { setView({ role: null, picked: false, window: null, q: "", week: null }); }} />}
      {tab === "cards" && <CardsTab zone={zone} from={from} />}
      {editing && Editor && (
        <Editor
          mode={editing}
          zone={editing === "edit" ? zone : undefined}
          seed={editing === "create" ? { baseZoneId: zone.id } : undefined}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            if (editing === "create") { navigate(zonePath(saved)); return; }
            onZone(saved);
            setOverviewState({ kind: "loading" });
            setOverviewAttempt((value) => value + 1);
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`删除专区“${zone.title}”？`}
          consequences="专区会被删掉，关注它的人也不会再看到它；专区里的动态不受影响。"
          recovery="删除后不能恢复。"
          confirmLabel="删除"
          busy={busy}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </PageShell>
  );
}

/* ------------------------------------------------------------------- overview */

function OverviewTab({ state, from, path, onReload }: { state: OverviewState; from: { to: string; label: string }; path: string; onReload: () => void }) {
  if (state.kind === "loading") return <FrontierSkeleton />;
  if (state.kind === "error") return <LoadError message={state.message} onRetry={onReload} />;
  if (state.overview.modules.length === 0) {
    return (
      <EmptyState icon={Layers} title="正在为这个专区搜集内容，通常几分钟内出现第一批"
        action={<Button variant="secondary" onClick={onReload}><RotateCw size={16} aria-hidden="true" />重新加载</Button>} />
    );
  }
  return <ZoneModules modules={state.overview.modules} path={path} from={from} />;
}

/* ---------------------------------------------------------------------- cards */

type CardsState = { kind: "loading" } | { kind: "ready"; cards: TopicCard[] } | { kind: "error"; message: string };

/** The 证据卡片 tab: the cards of the team's interface, the overview's card blocks in a list of their own. */
function CardsTab({ zone, from }: { zone: ZoneDetail; from: { to: string; label: string } }) {
  const [state, setState] = useState<CardsState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    fetchZoneCards(zone.id).then(
      (cards) => { if (active) setState({ kind: "ready", cards }); },
      (error: unknown) => { if (active) setState({ kind: "error", message: zoneErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [zone.id, attempt]);
  if (state.kind === "loading") return <FrontierSkeleton />;
  if (state.kind === "error") return <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />;
  if (state.cards.length === 0) {
    return <EmptyState icon={Layers} title="这个专区还没有证据卡片" action={<Link to={`${zonePath(zone)}?tab=items`} className={buttonClasses({ variant: "secondary" })}>看专区动态</Link>} />;
  }
  return (
    <div className="space-y-4">
      {(zone.kind === "official" || zone.published) && <ZoneSubscription zoneId={zone.id} />}
      <ul aria-label="证据卡片" className="space-y-3">
        {state.cards.map((card) => <ZoneCardBlock key={`${card.provider}:${card.id}`} card={card} from={from} />)}
      </ul>
    </div>
  );
}
