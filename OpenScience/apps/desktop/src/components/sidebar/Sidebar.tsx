import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { Bot, Brain, FlaskConical, FolderTree, NotebookPen, PanelLeft, Pencil, Search, Settings, SquarePen, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/tauri";
import { isMacPlatform } from "@/lib/platform";
import { hasWebApi } from "@/lib/apiClient";
import { useRuntimeStore } from "@/lib/runtime";
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiStore } from "@/lib/store";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import evimedMark from "@/assets/evimed-mark.svg";
import { displaySessionTitle } from "@/lib/sessionTitle";

interface Row {
  id: string;
  title: string;
  to: string;
}

/** Dragging the divider below this pointer x collapses the sidebar; dragging
 *  back past it re-expands. Sits below SIDEBAR_MIN so there is a clear "snap". */
const COLLAPSE_BELOW = 140;

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    sessions,
    sessionTitles,
    runningSessions,
    threads,
    startDraft,
    deleteSession,
  } = useRuntimeStore();
  const { sidebarCollapsed, sidebarWidth, setSidebarCollapsed, setSidebarWidth, toggleSidebar } =
    useUiStore();
  // While dragging, the live width lives here; the store (and localStorage)
  // are only written on pointer-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = dragWidth !== null;
  const [query, setQuery] = useState("");

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

  const startNew = () => {
    startDraft();
    navigate("/live");
  };

  const rows: Row[] = [
    // Subagent child sessions are internals of their parent conversation —
    // their asks and progress surface there, so they get no row of their own.
    ...sessions
      .filter((s) => !s.parentId)
      .map((s) => ({
        id: s.id,
        title: displaySessionTitle(sessionTitles[s.id] ?? s.title),
        to: `/live/${s.id}`,
      })),
  ];
  const needle = query.trim().toLowerCase();
  const visibleRows = needle
    ? rows.filter((row) => row.title.toLowerCase().includes(needle))
    : rows;

  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);

  const confirmDelete = () => {
    const row = pendingDelete;
    setPendingDelete(null);
    if (!row) return;
    void deleteSession(row.id);
    if (location.pathname === row.to) navigate("/live");
  };

  // With the overlay titlebar (macOS), reserve a draggable strip at the top so
  // the traffic lights don't overlap the logo and the window stays movable.
  const isMac = isMacPlatform();
  const overlayTitlebar = isTauri && isMac;
  // Memory and workflow pages only work against the hosted backend — on the
  // desktop they are dead ends, so their entries leave the nav entirely.
  const hostedWeb = hasWebApi && !isTauri;

  const width = dragWidth ?? sidebarWidth;

  return (
    <div
      className={cn(
        "relative h-full shrink-0 overflow-hidden",
        !dragging && "transition-[width] duration-200 ease-out",
      )}
      style={{ width: sidebarCollapsed ? 0 : width }}
    >
      <aside
        className="flex h-full flex-col border-r border-border bg-surface"
        style={{ width }}
      >
      {/* The strip clears the traffic lights and hosts the collapse button just
          right of them — same spot the expand button lands when collapsed. */}
      {overlayTitlebar && (
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center pl-[78px]">
          <button
            onClick={toggleSidebar}
            aria-label="收起侧边栏"
            title="收起侧边栏 (⌘B)"
            className="rounded p-1 text-text hover:bg-surface-2"
          >
            <PanelLeft size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
      <div className={cn("px-4 pb-3", overlayTitlebar ? "pt-1" : "pt-4")}>
        <div className="flex items-baseline gap-1.5">
          <img src={evimedMark} alt="EviMed" className="h-[21px] w-[21px] self-center" />
          {/* eslint-disable-next-line no-restricted-syntax -- brand wordmark: 17px sits between the body (15px) and title (20px) rungs; moving it visibly changes the lockup */}
          <div className="font-serif text-[17px] font-semibold leading-none tracking-tight text-text">
            EviMed
          </div>
          {!overlayTitlebar && (
            <button
              onClick={toggleSidebar}
              aria-label="收起侧边栏"
              title={`收起侧边栏 (${isMac ? "⌘B" : "Ctrl+B"})`}
              className="ml-auto self-center rounded p-1 text-text hover:bg-surface-2"
            >
              <PanelLeft size={14} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>

      <nav className="flex flex-col px-3">
        <NavRow icon={<SquarePen size={16} />} label="新任务" active={location.pathname.startsWith("/live")} onClick={startNew} />
        <NavRow icon={<FolderTree size={16} />} label="知识库" active={location.pathname === "/files"} onClick={() => navigate("/files")} />
        <NavRow icon={<NotebookPen size={16} />} label="科研笔记本" active={location.pathname === "/notebooks"} onClick={() => navigate("/notebooks")} />
        {hostedWeb && <NavRow icon={<Brain size={16} />} label="科研记忆" active={location.pathname === "/memory"} onClick={() => navigate("/memory")} />}
        {hostedWeb && <NavRow icon={<Bot size={16} />} label="能力模板" active={location.pathname === "/agents"} onClick={() => navigate("/agents")} />}
        <NavRow icon={<FlaskConical size={16} />} label="运行记录" active={location.pathname === "/runs"} onClick={() => navigate("/runs")} />
      </nav>

      <div className="mt-4 flex-1 overflow-y-auto px-3 pb-2">
        <div className="px-2 py-1 text-xs font-medium tracking-wider text-muted">历史记录</div>
        {rows.length > 0 && (
          <label className="relative mb-1 block">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <span className="sr-only">搜索历史会话</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索会话"
              className="h-7 w-full rounded-input border border-border bg-bg pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted focus:border-accent"
            />
          </label>
        )}
        {rows.length === 0 && (
          <div className="px-2 py-2 text-xs text-muted">暂无对话</div>
        )}
        {rows.length > 0 && visibleRows.length === 0 && (
          <div className="px-2 py-2 text-xs text-muted">没有匹配的会话</div>
        )}
        {visibleRows.map((row) => {
          // The dot reports what the store actually knows: a running turn
          // pulses; a session whose loaded thread ends in a failure shows red;
          // anything else gets no dot (the placeholder keeps titles aligned).
          const running = !!runningSessions[row.id];
          const blocks = threads[row.id]?.blocks;
          const last = blocks?.[blocks.length - 1];
          const failed = !running && last?.kind === "status-line" && last.tone === "error";
          return (
            <SessionRow
              key={row.to}
              row={row}
              active={location.pathname === row.to}
              running={running}
              failed={failed}
              onDelete={() => setPendingDelete(row)}
            />
          );
        })}
      </div>

      <div className="border-t border-border px-3 py-3">
        <button
          className="flex items-center gap-2 rounded-input px-2 py-1 text-ui text-muted hover:bg-surface-2 hover:text-text"
          onClick={() => navigate("/settings")}
          aria-label="设置"
        >
          <Settings size={15} />
          <span>设置</span>
        </button>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="删除对话？"
          body={`“${pendingDelete.title}”及其消息将被永久删除。`}
          confirmLabel="删除"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
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

function NavRow({ icon, label, active = false, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }) {
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

/** One history row: status dot + title + hover/focus actions (rename, delete).
 *  Rename edits inline — Enter saves, Esc cancels, blur saves. */
function SessionRow({
  row,
  active,
  running,
  failed,
  onDelete,
}: {
  row: Row;
  active: boolean;
  running: boolean;
  failed: boolean;
  onDelete: () => void;
}) {
  const { renameSession } = useRuntimeStore();
  /** Non-null while editing: the draft title. */
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft !== null && draft.trim()) renameSession(row.id, draft);
    setDraft(null);
  };

  if (draft !== null) {
    return (
      <div className="py-0.5">
        <input
          autoFocus
          value={draft}
          aria-label={`重命名 ${row.title}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setDraft(null);
          }}
          onBlur={commit}
          className="h-7 w-full rounded-input border border-accent bg-bg px-2 text-ui text-text outline-none"
        />
      </div>
    );
  }

  return (
    <div className="group relative">
      <NavLink
        to={row.to}
        className={cn(
          "flex items-center gap-2 rounded-input py-1 pl-2 pr-12 text-ui hover:bg-surface-2",
          active ? "bg-surface-2 text-text" : "text-text/90",
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            running ? "animate-pulse bg-accent" : failed ? "bg-error" : "invisible",
          )}
          title={running ? "正在运行" : failed ? "上轮任务失败" : undefined}
        />
        <span className="flex-1 truncate">{row.title}</span>
      </NavLink>
      {/* Hidden until the row is hovered OR something inside it has focus, so
          the buttons stay reachable from the keyboard. */}
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          onClick={() => setDraft(row.title)}
          aria-label={`重命名 ${row.title}`}
          className="rounded p-1 text-muted hover:bg-border hover:text-text"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={onDelete}
          aria-label={`删除 ${row.title}`}
          className="rounded p-1 text-muted hover:bg-border hover:text-error"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
