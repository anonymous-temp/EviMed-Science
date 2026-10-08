import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  Bot,
  Brain,
  FolderTree,
  Newspaper,
  Orbit,
  PanelLeft,
  Plug,
  Radar,
  Settings,
  SquarePen,
  UsersRound,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchWebMe } from "@/lib/apiClient";
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiStore } from "@/lib/store";
import { InboxBell } from "@/components/sidebar/InboxBell";
import { ProjectBrowser } from "@/components/sidebar/ProjectBrowser";
import { useFrontierFeature } from "@/lib/frontierFeature";
import { useGeoFeature } from "@/lib/geoClient";
import { useVcrFeature } from "@/lib/vcrClient";
import { useVcrFinishedToasts } from "@/components/vcr/useVcrFinishedToasts";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { EviMedMark } from "@/components/brand/EviMedMark";
import { IconButton, iconButtonClasses } from "@/components/ui/IconButton";
import { Tooltip } from "@/components/ui/Tooltip";
import { navItemClasses } from "@/components/ui/NavItem";

/** Dragging the divider below this pointer x collapses the sidebar; dragging
 *  back past it re-expands. Sits below SIDEBAR_MIN so there is a clear "snap". */
const COLLAPSE_BELOW = 140;

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

/**
 * Workbench destinations, optional frontier/VCR/GEO modules, and the account footer.
 *
 * It was ten here and two in the footer, with no grouping and no hierarchy, and
 * three of the ten were the same body of material seen three ways while two
 * more differed by one word (2026-09-15 walk, C1/C3/C5/C8). Resource pages that
 * are views of one thing became tabs on that thing; the inbox became the bell
 * above, because one notification does not earn a permanent row. 「运行记录」
 * left on 2026-09-20: it was the ledger's view of the same conversations the
 * tree below already lists, under a third name for them.
 *
 * No 「快速跳转」 above them (removed 2026-09-22): a Ctrl K palette over five
 * rows that are always on screen was a second way to reach the same five
 * places, and neither ChatGPT, Claude nor Gemini opens one for navigation.
 *
 * This is the only navigation in the product. The kernel's own left column,
 * which used to sit beside it inside the conversation frame, is occupied by
 * nothing in the hosted composition — two navigations for one workbench is what
 * made the conversation page read as three shells.
 */
const NAV: NavItem[] = [
  { to: "/app/chat", label: "新对话", icon: <SquarePen size={16} aria-hidden="true" /> },
  { to: "/app/capabilities", label: "科研工具", icon: <Bot size={16} aria-hidden="true" /> },
  { to: "/app/files", label: "知识库", icon: <FolderTree size={16} aria-hidden="true" /> },
  { to: "/app/memory", label: "记忆胶囊", icon: <Brain size={16} aria-hidden="true" /> },
  { to: "/app/autopilot", label: "定时任务", icon: <Orbit size={16} aria-hidden="true" /> },
  { to: "/app/extensions/skills", label: "插件与技能", icon: <Plug size={16} aria-hidden="true" /> },
];

/**
 * 「前沿动态」, right after 「新对话」 — and only where `/api/me` offers the
 * module to this account (`features.frontier`; a server that says nothing
 * about it has not got it). A row that led to 「还没有开放」 would be a
 * destination that is not one.
 */
const FRONTIER_NAV: NavItem = { to: "/app/frontier", label: "前沿动态", icon: <Newspaper size={16} aria-hidden="true" /> };

/**
 * 「虚拟临床研究」 and 「循证 GEO」, in that order directly below 「科研工具」 — and,
 * like the frontier feed, only where `/api/me` offers the module to this
 * account (`features.vcr`, `features.geo`). A row that led to 「还没有开放」
 * would be a destination that is not one.
 */
const VCR_NAV: NavItem = { to: "/app/virtual-research", label: "虚拟临床研究", icon: <UsersRound size={16} aria-hidden="true" /> };
const GEO_NAV: NavItem = { to: "/app/geo", label: "循证 GEO", icon: <Radar size={16} aria-hidden="true" /> };

/**
 * The rows in order: the frontier feed after 「新对话」, then 「虚拟临床研究」 and
 * 「循证 GEO」 after 「科研工具」, in that order — the two boards sit together,
 * and the one this account may not have simply is not there.
 */
function navRows({ frontier, vcr, geo }: { frontier: boolean; vcr: boolean; geo: boolean }): NavItem[] {
  return NAV.flatMap((item) => [
    item,
    ...(frontier && item.to === "/app/chat" ? [FRONTIER_NAV] : []),
    ...(item.to === "/app/capabilities" ? [...(vcr ? [VCR_NAV] : []), ...(geo ? [GEO_NAV] : [])] : []),
  ]);
}

/**
 * Which destination is current. The rows match by prefix, and a conversation is `/app/chat/:sessionId` whatever project it is in — which
 * made 「新对话」 current in a study's conversation, and in a GEO project's. A conversation in a module's project belongs to the module:
 * its row is the current one there (`projectModule` is only ever set where the account is offered the module, so no row is marked that
 * is not on screen).
 */
export function isCurrent(to: string, pathname: string, projectModule: "geo" | "vcr" | null): boolean {
  if (to === "/app/extensions/skills") return pathname.startsWith("/app/extensions");
  const chatting = pathname.startsWith("/app/chat");
  if (to === "/app/chat") return chatting && projectModule === null;
  if (to === VCR_NAV.to) return pathname.startsWith(to) || (chatting && projectModule === "vcr");
  if (to === GEO_NAV.to) return pathname.startsWith(to) || (chatting && projectModule === "geo");
  return pathname.startsWith(to);
}

export function Sidebar() {
  const location = useLocation();
  const { sidebarCollapsed, sidebarWidth, setSidebarCollapsed, setSidebarWidth, toggleSidebar } = useUiStore();
  // While dragging, the live width lives here; the store (and localStorage)
  // are only written on pointer-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = dragWidth !== null;
  const frontier = useFrontierFeature() === "on";
  const vcr = useVcrFeature() === "on";
  // A computation the researcher asked for ends while they are elsewhere in the same study: a toast says so, with the way to the result.
  useVcrFinishedToasts(vcr);
  const geo = useGeoFeature() === "on";
  // The module the tab's project belongs to, told by the project list below (a study or a GEO project, a draft included).
  const [projectModule, setProjectModule] = useState<"geo" | "vcr" | null>(null);
  const [accountName, setAccountName] = useState("");
  useEffect(() => {
    let live = true;
    void fetchWebMe().then((me) => { if (live && me) setAccountName(me.user.name); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const rows = navRows({ frontier, vcr, geo });

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
    // The landmark is the whole box — the column, the divider and all — so nothing of the sidebar sits outside it (axe `region` on every
    // page of the audit: the divider was a child of a plain box beside the `<aside>`). Collapsed, it is `inert`: the column is 0 wide
    // and clipped, not gone, and its 46 links and buttons were still tab stops the reader could not see (2026-10-07 audit B-02). While a
    // drag is in flight it stays live, because the drag may re-open it.
    <aside
      aria-label="侧栏"
      data-sidebar=""
      inert={sidebarCollapsed && !dragging}
      className={cn(
        "relative h-full shrink-0 overflow-hidden",
        // Below `lg` there is no room for a persistent column — at 390 px this
        // kept its full width and left the content a sliver (2026-09-16 walk,
        // U1). There it becomes an overlay drawer above the content, capped at
        // most of the viewport so it never pushes the page sideways; from `lg`
        // up it is the resizable column it has always been.
        "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-drawer max-lg:max-w-[85vw] max-lg:shadow-e2",
        !dragging && "transition-[width] duration-base ease-standard",
      )}
      style={{ width: sidebarCollapsed ? 0 : width }}
    >
      {/* The grey ground is the whole edge: no rule down the right side
        * (2026-09-23 plan §5.2), the same grey as the kernel's own column. */}
      <div className="flex h-full max-w-full flex-col bg-surface-1" style={{ width }}>
        <div className="px-4 pb-3 pt-4">
          <div className="flex items-center gap-1.5">
            <EviMedMark className="h-5 w-5 shrink-0" />
            <div className="text-wordmark font-semibold text-text">EviMed</div>
            <InboxBell />
            <IconButton icon={PanelLeft} label="收起侧边栏" title="收起侧边栏 (Ctrl+B)" onClick={toggleSidebar} />
          </div>
        </div>

        <nav aria-label="工作台" className="flex flex-col px-3">
          {rows.map((item) => (
            <NavRow
              key={item.to}
              to={item.to}
              icon={item.icon}
              label={item.label}
              active={isCurrent(item.to, location.pathname, projectModule)}
              freshState={item.to === "/app/chat" ? () => ({ runtimeUiIntent: newRuntimeUiIntent() }) : undefined}
            />
          ))}
        </nav>

        {/* The projects and their conversations, in the kernel's own shape: every
          * project a group, its conversations inside, any of them one click
          * away and opened in place. It replaced a project dropdown here and a
          * list of the current project's recent work below the rows above. */}
        <ProjectBrowser geo={geo} vcr={vcr} onCurrentModule={setProjectModule} />

        {/* One footer row: who is signed in, and the gear to 设置 (2026-09-23
          * plan §5.2). The count of data sources without a credential used to
          * sit here — a standing fact about the deployment, not the reader's
          * work; 设置 → 数据源 lists what needs setting. */}
        <div className="flex items-center gap-2 px-4 py-3">
          <span
            aria-hidden="true"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-caption font-medium text-accent-fg"
          >
            {(accountName.trim()[0] ?? "").toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-ui text-text">{accountName}</span>
          <Tooltip content="设置" kind="label">
            <Link
              to="/app/account"
              aria-label="设置"
              aria-current={location.pathname.startsWith("/app/account") ? "page" : undefined}
              className={iconButtonClasses({ active: location.pathname.startsWith("/app/account") })}
            >
              <Settings size={16} aria-hidden="true" />
            </Link>
          </Tooltip>
        </div>
      </div>

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
          "group absolute inset-y-0 right-0 z-sticky w-[5px] cursor-col-resize outline-none",
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
    </aside>
  );
}

/**
 * One destination.
 *
 * A link, not a button: middle-click, open-in-new-tab and copy-address are what
 * people expect of navigation and a `<button>` has none of them, and assistive
 * technology gets `aria-current` for free (2026-09-16 review, U10). `active` is
 * still passed in rather than read from `NavLink`'s own matcher, because the
 * rows match by prefix — `/app/chat/:sessionId` is still 「新对话」.
 */
function NavRow({
  to,
  icon,
  label,
  active = false,
  freshState,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  /**
   * Router state minted at the moment of the click, not at render.
   *
   * 「新对话」 carries a `runtimeUiIntent` that must differ on every activation —
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
      className={navItemClasses({ current: active })}
    >
      <span className="text-text-3">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Link>
  );
}
