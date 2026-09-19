import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  Bot,
  Brain,
  Command,
  FlaskConical,
  FolderTree,
  Orbit,
  PanelLeft,
  SquarePen,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiStore } from "@/lib/store";
import { InboxBell } from "@/components/sidebar/InboxBell";
import { ProjectBrowser } from "@/components/sidebar/ProjectBrowser";
import { useConnectorAttention } from "@/lib/connectorAttention";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { EviMedMark } from "@/components/brand/EviMedMark";
import { isMacPlatform } from "@/lib/platform";

/** Dragging the divider below this pointer x collapses the sidebar; dragging
 *  back past it re-expands. Sits below SIDEBAR_MIN so there is a clear "snap". */
const COLLAPSE_BELOW = 140;

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
  { to: "/app/memory", label: "记忆胶囊", icon: <Brain size={16} aria-hidden="true" /> },
  { to: "/app/autopilot", label: "主动科研", icon: <Orbit size={16} aria-hidden="true" /> },
  { to: "/app/capabilities", label: "科研能力", icon: <Bot size={16} aria-hidden="true" /> },
];

export function Sidebar() {
  const location = useLocation();
  const { sidebarCollapsed, sidebarWidth, setSidebarCollapsed, setSidebarWidth, toggleSidebar, setPaletteOpen } =
    useUiStore();
  // While dragging, the live width lives here; the store (and localStorage)
  // are only written on pointer-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = dragWidth !== null;
  const connectorAttention = useConnectorAttention();

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

        {/* ⌘K made visible (appendix D §4): the palette reaches every view by
          * name, and a shortcut nobody can see is a shortcut nobody uses. */}
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-keyshortcuts="Meta+K Control+K"
            className="flex h-8 w-full items-center gap-2 rounded-input px-2.5 text-ui text-muted transition-colors duration-fast hover:bg-surface-2 hover:text-text"
          >
            <Command size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="flex-1 text-left">快速跳转</span>
            <kbd className="rounded border border-border px-1 font-sans text-caption text-muted">{isMacPlatform() ? "⌘K" : "Ctrl K"}</kbd>
          </button>
        </div>

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

        {/* The projects and their tasks, in the kernel's own shape: every
          * project a group, its tasks inside, any of them one click away and
          * opened in place. It replaced a project dropdown here and a
          * 「最近任务」 list of the current project below the rows above. */}
        <ProjectBrowser />

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
          in-flight drag (pointer capture) can re-open it. A focusable
          separator (WAI-ARIA window splitter): ←/→ by 16 px, Home/End to the
          limits, Enter collapses — a width a mouse can set, a keyboard can. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- a focusable separator is the WAI-ARIA window-splitter widget, which these rules do not model. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={Math.round(width)}
        tabIndex={sidebarCollapsed ? -1 : 0}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 16;
          const next = event.key === "ArrowLeft" ? sidebarWidth - step
            : event.key === "ArrowRight" ? sidebarWidth + step
              : event.key === "Home" ? SIDEBAR_MIN
                : event.key === "End" ? SIDEBAR_MAX
                  : null;
          if (event.key === "Enter") {
            event.preventDefault();
            toggleSidebar();
            return;
          }
          if (next == null) return;
          event.preventDefault();
          setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next)));
        }}
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onPointerCancel={onDividerPointerUp}
        className={cn(
          "group absolute inset-y-0 right-0 z-10 w-[5px] cursor-col-resize outline-none",
          sidebarCollapsed && !dragging && "pointer-events-none",
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 right-0 w-[2px] transition-colors",
            dragging ? "bg-focus" : "bg-transparent group-hover:bg-strong group-focus-visible:bg-focus",
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
