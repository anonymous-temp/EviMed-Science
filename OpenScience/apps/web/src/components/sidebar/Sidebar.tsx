import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import {
  Bot,
  Bell,
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
import { listInbox } from "@/lib/inboxClient";
import { runDotClass, runTitle } from "@/lib/runPresentation";
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiStore } from "@/lib/store";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import evimedMark from "@/assets/evimed-mark.svg";

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
  { to: "/app/chat", label: "新任务", icon: <SquarePen size={16} /> },
  { to: "/app/runs", label: "运行记录", icon: <FlaskConical size={16} /> },
  { to: "/app/files", label: "知识库", icon: <FolderTree size={16} /> },
  { to: "/app/memory", label: "记忆", icon: <Brain size={16} /> },
  { to: "/app/autopilot", label: "主动科研", icon: <Orbit size={16} /> },
  { to: "/app/capabilities", label: "科研能力", icon: <Bot size={16} /> },
];

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sidebarCollapsed, sidebarWidth, setSidebarCollapsed, setSidebarWidth, toggleSidebar } =
    useUiStore();
  // While dragging, the live width lives here; the store (and localStorage)
  // are only written on pointer-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = dragWidth !== null;
  const [query, setQuery] = useState("");
  const [runs, setRuns] = useState<WebAgentRun[] | null>(null);
  const [unread, setUnread] = useState(0);

  // The inbox's unread count, for the bell. Polled on the same cadence as the
  // run list and isolated the same way: a count that cannot be read is shown
  // as no badge, never as an error in a sidebar.
  useEffect(() => {
    let active = true;
    const load = () =>
      listInbox({ unread: true })
        .then((page) => { if (active) setUnread(page.items.length); })
        .catch(() => { /* isolated: no badge rather than a broken sidebar */ });
    void load();
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

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
    const timer = setInterval(load, 20_000);
    return () => {
      active = false;
      clearInterval(timer);
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
  const rows = (runs ?? [])
    .filter((run) => !needle || runTitle(run).toLowerCase().includes(needle))
    .slice(0, RECENT_RUNS);

  const width = dragWidth ?? sidebarWidth;

  return (
    <div
      className={cn(
        "relative h-full shrink-0 overflow-hidden",
        !dragging && "transition-[width] duration-200 ease-out",
      )}
      style={{ width: sidebarCollapsed ? 0 : width }}
    >
      <aside className="flex h-full flex-col border-r border-border bg-surface" style={{ width }}>
        <div className="px-4 pb-3 pt-4">
          <div className="flex items-baseline gap-1.5">
            <img src={evimedMark} alt="EviMed" className="h-[21px] w-[21px] self-center" />
            {/* eslint-disable-next-line no-restricted-syntax -- brand wordmark: 17px sits between the body (15px) and title (20px) rungs; moving it visibly changes the lockup */}
            <div className="font-serif text-[17px] font-semibold leading-none tracking-tight text-text">
              EviMed
            </div>
            <button
              onClick={() => navigate("/app/inbox")}
              aria-label={unread > 0 ? `收件箱，${unread} 条未读` : "收件箱"}
              title="收件箱"
              className="relative ml-auto self-center rounded p-1 text-text hover:bg-surface-2"
            >
              <Bell size={14} strokeWidth={1.5} />
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-1 text-caption font-medium text-accent-fg">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
            <button
              onClick={toggleSidebar}
              aria-label="收起侧边栏"
              title="收起侧边栏 (Ctrl+B)"
              className="self-center rounded p-1 text-text hover:bg-surface-2"
            >
              <PanelLeft size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <ProjectSwitcher />

        <nav className="flex flex-col px-3">
          {NAV.map((item) => (
            <NavRow
              key={item.to}
              icon={item.icon}
              label={item.label}
              active={location.pathname.startsWith(item.to)}
              onClick={() => navigate(item.to, item.to === "/app/chat" ? { state: { runtimeUiIntent: newRuntimeUiIntent() } } : undefined)}
            />
          ))}
        </nav>

        <div className="mt-4 flex-1 overflow-y-auto px-3 pb-2">
          <div className="px-2 py-1 text-xs font-medium tracking-wider text-muted">最近任务</div>
          {(runs?.length ?? 0) > 0 && (
            <label className="relative mb-1 block">
              <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <span className="sr-only">搜索运行记录</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索任务"
                className="h-7 w-full rounded-input border border-border bg-bg pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted focus:border-accent"
              />
            </label>
          )}
          {runs === null && <div className="px-2 py-2 text-xs text-muted">正在读取…</div>}
          {runs !== null && runs.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted">还没有任务</div>
          )}
          {runs !== null && runs.length > 0 && rows.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted">没有匹配的任务</div>
          )}
          {/* Back into the conversation, not into the ledger row about it.
            * This list is the only session list the product has now that the
            * kernel's own left column is occupied by nothing, so it has to open
            * the thing itself; a run with no addressable session still has its
            * ledger entry, which is where those go. */}
          {rows.map((run) => (
            <NavLink
              key={run.id}
              to={/^[A-Za-z0-9_-]{1,160}$/.test(run.sessionId)
                ? `/app/chat/${encodeURIComponent(run.sessionId)}`
                : `/app/runs?run=${encodeURIComponent(run.id)}`}
              className="flex items-center gap-2 rounded-input py-1 pl-2 pr-2 text-ui text-text/90 hover:bg-surface-2"
            >
              <span
                className={cn("h-1.5 w-1.5 shrink-0 rounded-full", runDotClass(run))}
                title={run.status === "running" ? "正在运行" : undefined}
              />
              <span className="flex-1 truncate">{runTitle(run)}</span>
            </NavLink>
          ))}
        </div>

        <div className="flex flex-col border-t border-border px-3 py-3">
          {/* One footer row. 「设置」 was the second, and it was the deployment
            * console as much as the product's settings; it is a tab of this
            * page now, beside usage, credentials and the operator's board. */}
          <NavRow
            icon={<UserRound size={15} />}
            label="账户与设置"
            active={location.pathname.startsWith("/app/account")}
            onClick={() => navigate("/app/account")}
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
            dragging ? "bg-accent/60" : "bg-transparent group-hover:bg-accent/40",
          )}
        />
      </div>
    </div>
  );
}

function NavRow({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-input px-2 py-1.5 text-ui hover:bg-surface-2",
        active ? "bg-surface-2 font-medium text-text" : "text-text",
      )}
    >
      <span className="text-muted">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
