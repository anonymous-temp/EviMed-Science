import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import {
  Bot,
  Brain,
  FlaskConical,
  FolderTree,
  NotebookPen,
  PanelLeft,
  Search,
  Settings,
  SquarePen,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { listWebAgentRuns, type WebAgentRun } from "@/lib/apiClient";
import { runDotClass, runTitle } from "@/lib/runPresentation";
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiStore } from "@/lib/store";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import evimedMark from "@/assets/evimed-mark.svg";

/** Dragging the divider below this pointer x collapses the sidebar; dragging
 *  back past it re-expands. Sits below SIDEBAR_MIN so there is a clear "snap". */
const COLLAPSE_BELOW = 140;

/** How many recent runs the sidebar lists before sending people to the ledger. */
const RECENT_RUNS = 12;

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

const NAV: NavItem[] = [
  { to: "/app/chat", label: "新任务", icon: <SquarePen size={16} /> },
  { to: "/app/runs", label: "运行记录", icon: <FlaskConical size={16} /> },
  { to: "/app/files", label: "知识库", icon: <FolderTree size={16} /> },
  { to: "/app/notebooks", label: "科研笔记本", icon: <NotebookPen size={16} /> },
  { to: "/app/memory", label: "科研记忆", icon: <Brain size={16} /> },
  { to: "/app/capabilities", label: "能力模板", icon: <Bot size={16} /> },
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
              onClick={toggleSidebar}
              aria-label="收起侧边栏"
              title="收起侧边栏 (Ctrl+B)"
              className="ml-auto self-center rounded p-1 text-text hover:bg-surface-2"
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
              onClick={() => navigate(item.to)}
            />
          ))}
        </nav>

        <div className="mt-4 flex-1 overflow-y-auto px-3 pb-2">
          <div className="px-2 py-1 text-xs font-medium tracking-wider text-muted">最近运行</div>
          {(runs?.length ?? 0) > 0 && (
            <label className="relative mb-1 block">
              <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <span className="sr-only">搜索运行记录</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索运行"
                className="h-7 w-full rounded-input border border-border bg-bg pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted focus:border-accent"
              />
            </label>
          )}
          {runs === null && <div className="px-2 py-2 text-xs text-muted">正在读取运行记录…</div>}
          {runs !== null && runs.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted">还没有运行记录</div>
          )}
          {runs !== null && runs.length > 0 && rows.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted">没有匹配的运行</div>
          )}
          {rows.map((run) => (
            <NavLink
              key={run.id}
              to={`/app/runs?run=${encodeURIComponent(run.id)}`}
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
          <NavRow
            icon={<UserRound size={15} />}
            label="账户与额度"
            active={location.pathname.startsWith("/app/account")}
            onClick={() => navigate("/app/account")}
          />
          <NavRow
            icon={<Settings size={15} />}
            label="设置"
            active={location.pathname.startsWith("/app/settings")}
            onClick={() => navigate("/app/settings")}
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
