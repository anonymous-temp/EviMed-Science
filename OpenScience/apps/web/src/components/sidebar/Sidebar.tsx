import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import {
  Bot,
  Brain,
  FlaskConical,
  FolderTree,
  Orbit,
  PanelLeft,
  Search,
  SquarePen,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { RUNS_CHANGED_EVENT, runMetaLine, runState, runTitle } from "@/lib/runPresentation";
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiStore } from "@/lib/store";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import { InboxBell } from "@/components/sidebar/InboxBell";
import { RunStatusDot } from "@/components/runs/RunStatusDot";
import { useConnectorAttention } from "@/lib/connectorAttention";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { EviMedMark } from "@/components/brand/EviMedMark";

/** Dragging the divider below this pointer x collapses the sidebar; dragging
 *  back past it re-expands. Sits below SIDEBAR_MIN so there is a clear "snap". */
const COLLAPSE_BELOW = 140;

/** How many recent tasks the sidebar lists before sending people to the ledger. */
const RECENT_RUNS = 12;

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

/**
 * Six destinations, plus the account in the footer.
 *
 * It was ten here and two in the footer, with no grouping and no hierarchy, and
 * three of the ten were the same body of material seen three ways while two
 * more differed by one word (2026-09-15 walk, C1/C3/C5/C8). Resource pages that
 * are views of one thing became tabs on that thing; the inbox became the bell
 * above, because one notification does not earn a permanent row.
 *
 * This is the only navigation in the product. The kernel's own left column,
 * which used to sit beside it inside the session frame, is occupied by nothing
 * in the hosted composition — two navigations for one workbench is what made
 * the session page read as three shells.
 */
const NAV: NavItem[] = [
  { to: "/app/chat", label: "新任务", icon: <SquarePen size={16} aria-hidden="true" /> },
  { to: "/app/runs", label: "运行记录", icon: <FlaskConical size={16} aria-hidden="true" /> },
  { to: "/app/files", label: "知识库", icon: <FolderTree size={16} aria-hidden="true" /> },
  { to: "/app/memory", label: "记忆", icon: <Brain size={16} aria-hidden="true" /> },
  { to: "/app/autopilot", label: "主动科研", icon: <Orbit size={16} aria-hidden="true" /> },
  { to: "/app/capabilities", label: "科研能力", icon: <Bot size={16} aria-hidden="true" /> },
];

export function Sidebar() {
  const location = useLocation();
  const { sidebarCollapsed, sidebarWidth, setSidebarCollapsed, setSidebarWidth, toggleSidebar } =
    useUiStore();
  // While dragging, the live width lives here; the store (and localStorage)
  // are only written on pointer-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = dragWidth !== null;
  const [query, setQuery] = useState("");
  const [runs, setRuns] = useState<WebAgentRun[] | null>(null);
  const connectorAttention = useConnectorAttention();

  // The recent-runs list, refreshed while the shell is open. This used to be a
  // list of the kernel's own sessions, mirrored into the browser; the kernel's
  // application owns that list now, and what the shell can say that the frame
  // cannot is how each run came out — whether it delivered, and whether the
  // gate had anything to say about it.
  useEffect(() => {
    let active = true;
    const load = () =>
      listWebAgentRuns()
        .then((value) => {
          if (active) setRuns(value);
        })
        .catch(() => {
          // isolated: a ledger that cannot be read leaves the list as it was.
          // A sidebar is not where someone should first learn the API is down.
          if (active) setRuns((current) => current ?? []);
        });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20_000);
    // And a catch-up when the tab comes back, so returning to it does not show
    // a list frozen at whatever it said when the reader left.
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    // A rename or a cancel on the runs page shows here at once, not on the
    // next tick of this list's own timer.
    const onChanged = () => { void load(); };
    window.addEventListener(RUNS_CHANGED_EVENT, onChanged);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(RUNS_CHANGED_EVENT, onChanged);
    };
  }, []);

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragWidth(sidebarWidth);
  };

  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    // The sidebar starts at the window's left edge, so clientX is the width.
    const x = e.clientX;
    if (x < COLLAPSE_BELOW) {
      if (!sidebarCollapsed) setSidebarCollapsed(true);
      return;
    }
    if (sidebarCollapsed) setSidebarCollapsed(false);
    setDragWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, x)));
  };

  const onDividerPointerUp = () => {
    if (!dragging) return;
    setSidebarWidth(dragWidth);
    setDragWidth(null);
  };

  const needle = query.trim().toLowerCase();
  // Local filtering over the recent runs' titles. Integration seam: the frame
  // stream's `useRuntimeSessionSearch()` (lib/runtimeUiBridge.ts, S3) returns
  // the kernel's own conversation matches for the same query; they merge in
  // here, beside — not instead of — these rows.
  const rows = (runs ?? [])
    .filter((run) => !needle || runTitle(run).toLowerCase().includes(needle))
    .slice(0, RECENT_RUNS);

  const width = dragWidth ?? sidebarWidth;

  return (
    <div
      className={cn(
        "relative h-full shrink-0 overflow-hidden",
        // Below `lg` there is no room for a persistent column — at 390 px this
        // kept its full width and left the content a sliver (2026-09-16 walk,
        // U1). There it becomes an overlay drawer above the content, capped at
        // most of the viewport so it never pushes the page sideways; from `lg`
        // up it is the resizable column it has always been.
        "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:max-w-[85vw] max-lg:shadow-pop",
        !dragging && "transition-[width] duration-base ease-standard",
      )}
      style={{ width: sidebarCollapsed ? 0 : width }}
    >
      <aside className="flex h-full max-w-full flex-col border-r border-border bg-surface" style={{ width }}>
        <div className="px-4 pb-3 pt-4">
          <div className="flex items-baseline gap-1.5">
            <EviMedMark className="h-5 w-5 shrink-0 self-center" />
            <div className="font-serif text-wordmark font-semibold text-text">
              EviMed
            </div>
            <InboxBell />
            {/* 32 px, like the bell beside it: the 22 px it was sat under the
              * 24 px floor WCAG 2.5.8 sets for a pointer target. */}
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="收起侧边栏"
              title="收起侧边栏 (Ctrl+B)"
              className="grid h-8 w-8 shrink-0 place-items-center self-center rounded-input text-muted hover:bg-surface-2 hover:text-text"
            >
              <PanelLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>

        <ProjectSwitcher running={(runs ?? []).some((run) => runState(run).key === "running")} />

        <nav className="flex flex-col px-3">
          {NAV.map((item) => (
            <NavRow
              key={item.to}
              to={item.to}
              icon={item.icon}
              label={item.label}
              active={location.pathname.startsWith(item.to)}
              freshState={item.to === "/app/chat" ? () => ({ runtimeUiIntent: newRuntimeUiIntent() }) : undefined}
            />
          ))}
        </nav>

        <div className="mt-4 flex-1 overflow-y-auto px-3 pb-2">
          <h2 className="px-2 py-1 text-caption font-semibold text-muted">最近任务</h2>
          {(runs?.length ?? 0) > 0 && (
            <label className="relative mb-1 block">
              <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
              <span className="sr-only">搜索运行记录</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索任务"
                className="h-7 w-full rounded-input border border-strong bg-bg pl-7 pr-2 text-caption text-text outline-none placeholder:text-muted focus:border-focus"
              />
            </label>
          )}
          {runs === null && <div className="px-2 py-2 text-caption text-muted">正在读取…</div>}
          {runs !== null && runs.length === 0 && (
            <div className="px-2 py-2 text-caption text-muted">还没有任务</div>
          )}
          {runs !== null && runs.length > 0 && rows.length === 0 && (
            <div className="px-2 py-2 text-caption text-muted">没有匹配的任务</div>
          )}
          {/* Back into the conversation, not into the ledger row about it.
            * This list is the only session list the product has now that the
            * kernel's own left column is occupied by nothing, so it has to open
            * the thing itself; a run with no addressable session still has its
            * ledger entry, which is where those go. */}
          {rows.map((run) => {
            const state = runState(run);
            return (
              <NavLink
                key={run.id}
                to={/^[A-Za-z0-9_-]{1,160}$/.test(run.sessionId)
                  ? `/app/chat/${encodeURIComponent(run.sessionId)}`
                  : `/app/runs?run=${encodeURIComponent(run.id)}`}
                className="group flex items-start gap-2 rounded-input py-1.5 pl-2 pr-2 hover:bg-surface-2 aria-[current=page]:bg-accent-soft"
              >
                {/* Two lines, not one longer one (appendix D §10.3). Twelve
                  * runs of one capability share a first line whenever their
                  * question was not recorded; the second — when, and how it
                  * came out — is what tells them apart, and it says the
                  * state in words beside the dot's shape. */}
                <RunStatusDot state={state.key} labelled className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-text">{runTitle(run)}</span>
                  <span className="block truncate text-caption text-muted">{runMetaLine(run)}</span>
                </span>
              </NavLink>
            );
          })}
        </div>

        <div className="flex flex-col border-t border-border px-3 py-3">
          {/* One footer row. 「设置」 was the second, and it was the deployment
            * console as much as the product's settings; it is a tab of this
            * page now, beside usage, credentials and the operator's board. */}
          {/* The data sources nothing serves for this account, as a quiet
            * count: a standing fact about the deployment, not unread work, so
            * it is neutral rather than the bell's red (review B §7c). */}
          <NavRow
            to={connectorAttention > 0 ? "/app/account?tab=connectors" : "/app/account"}
            icon={<UserRound size={15} aria-hidden="true" />}
            label="账户与设置"
            active={location.pathname.startsWith("/app/account")}
            badge={connectorAttention > 0 ? {
              text: String(connectorAttention),
              label: `${connectorAttention} 个数据源没有可用凭据`,
            } : undefined}
          />
        </div>
      </aside>

      {/* Drag divider: resize within [SIDEBAR_MIN, SIDEBAR_MAX]; dragging far
          left snaps the sidebar closed. Kept mounted while collapsed so an
          in-flight drag (pointer capture) can re-open it. */}
      <div
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onPointerCancel={onDividerPointerUp}
        className={cn(
          "group absolute inset-y-0 right-0 z-10 w-[5px] cursor-col-resize",
          sidebarCollapsed && !dragging && "pointer-events-none",
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 right-0 w-[2px] transition-colors",
            dragging ? "bg-focus" : "bg-transparent group-hover:bg-strong",
          )}
        />
      </div>
    </div>
  );
}

/**
 * One destination.
 *
 * A link, not a button: middle-click, open-in-new-tab and copy-address are what
 * people expect of navigation and a `<button>` has none of them, and assistive
 * technology gets `aria-current` for free (2026-09-16 review, U10). `active` is
 * still passed in rather than read from `NavLink`'s own matcher, because the
 * rows match by prefix — `/app/chat/:sessionId` is still 「新任务」.
 */
function NavRow({
  to,
  icon,
  label,
  active = false,
  freshState,
  badge,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  /** A count beside the label, with the sentence it stands for. */
  badge?: { text: string; label: string };
  /**
   * Router state minted at the moment of the click, not at render.
   *
   * 「新任务」 carries a `runtimeUiIntent` that must differ on every activation —
   * two clicks in a row are two requests for a new session, and a value read
   * once at render would make the second one a repeat of the first. Computed
   * here rather than passed as `state` for exactly that reason.
   */
  freshState?: () => unknown;
}) {
  const navigate = useNavigate();
  return (
    <Link
      to={to}
      onClick={(event) => {
        if (!freshState) return;
        // A modified click is the browser's to handle — that is the whole
        // point of this being a link.
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to, { state: freshState() });
      }}
      aria-current={active ? "page" : undefined}
      aria-label={badge ? `${label}，${badge.label}` : undefined}
      title={badge?.label}
      className={cn(
        "flex items-center gap-2 rounded-input px-2 py-1.5 text-ui hover:bg-surface-2",
        active ? "bg-surface-2 font-medium text-text" : "text-text",
      )}
    >
      <span className="text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge && (
        <span aria-hidden="true" className="grid h-4 min-w-4 place-items-center rounded-full border border-strong px-1 text-badge tabular-nums text-muted">
          {badge.text}
        </span>
      )}
    </Link>
  );
}
