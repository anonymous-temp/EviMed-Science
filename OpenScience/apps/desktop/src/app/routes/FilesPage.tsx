import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  Dna,
  FileText,
  Film,
  FlaskConical,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Highlighter,
  Loader2,
  NotebookPen,
  ServerCrash,
  Sheet,
  Upload,
  X,
} from "lucide-react";
import { extOf, extToKind, previewKindForName, type PreviewKind } from "@/lib/artifacts";
import { listDir, type DirEntry } from "@/lib/artifactFile";
import { addFilesToWorkspace, isTauri, uploadFilesToWorkspace } from "@/lib/tauri";
import { hasCommandBackend, hasWebApi } from "@/lib/apiClient";
import { useFileDrop } from "@/lib/useFileDrop";
import { useRuntimeStore } from "@/lib/runtime";
import { baseName } from "@/components/thread/WorkspaceChip";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { PaneTitlebarInset } from "@/components/inspector/RightPane";
import { EmptyState } from "@/components/cards/EmptyState";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { humanSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

const EXT_LANG: Record<string, string> = {
  py: "python", r: "r", jl: "julia", sh: "bash", tex: "latex", md: "markdown",
};
const KNOWLEDGE_ROOT = "knowledge-base";

function iconFor(entry: DirEntry) {
  if (entry.isDir) return <Folder size={15} className="text-accent" />;
  const kind = previewKindForName(entry.name);
  const cls = "text-muted";
  if (entry.name.endsWith(".ipynb")) return <NotebookPen size={15} className={cls} />;
  if (kind === "image" || kind === "fits" || kind === "anomaly" || kind === "phase") return <ImageIcon size={15} className={cls} />;
  if (kind === "video") return <Film size={15} className={cls} />;
  if (kind === "table") return <Sheet size={15} className={cls} />;
  if (kind === "molecule" || kind === "dos" || kind === "bands") return <FlaskConical size={15} className={cls} />;
  if (kind === "genome") return <Dna size={15} className={cls} />;
  if (kind === "qcode") return <Highlighter size={15} className={cls} />;
  return <FileText size={15} className={cls} />;
}

/**
 * GLOBAL file explorer: browses from the base folder (Settings → Workspace),
 * which holds every session's dated folder — not the active session only.
 * Directories are navigable via a breadcrumb; files open in the same viewers
 * used elsewhere (figures, tables, PDF, molecule, genome tracks, notebooks),
 * so all past work is reachable in one place.
 */
export function FilesPage() {
  const [dir, setDir] = useState(KNOWLEDGE_ROOT);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [uploading, setUploading] = useState(false);
  const hostedWeb = hasWebApi && !isTauri;
  const load = useCallback(async (rel: string) => {
    setEntries(null);
    setError(null);
    try {
      setEntries(await listDir(rel, "base"));
    } catch (e) {
      if (rel === KNOWLEDGE_ROOT) {
        setEntries([]);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load(dir);
  }, [dir, load]);

  const open = (entry: DirEntry) => {
    if (entry.isDir) {
      setSelected(null);
      setDir(entry.path);
    } else {
      setSelected(entry);
    }
  };

  const crumbs = dir === KNOWLEDGE_ROOT ? [] : dir.slice(KNOWLEDGE_ROOT.length + 1).split("/");
  const uploadFiles = async (dropped?: File[]) => {
    setUploading(true);
    try {
      const names = dropped
        ? await uploadFilesToWorkspace(dropped, dir, "base")
        : await addFilesToWorkspace(dir, "base");
      if (names.length > 0) {
        await load(dir);
        toast.success(`已上传 ${names.length} 个文件。`);
      }
    } catch (e) {
      toast.error(`文件上传失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  };

  // Drop anywhere over the browser/preview uploads into the current folder —
  // same availability as the upload button (hosted web backend only).
  const { dragging, dropProps } = useFileDrop({
    disabled: !hostedWeb,
    onDrop: (files) => void uploadFiles(files),
  });

  return (
    <div {...dropProps} className="relative flex h-full min-h-0">
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-card border-2 border-dashed border-accent bg-surface px-6 py-4 text-sm font-medium text-accent">
            <Upload size={15} />
            松开以上传到个人知识库
          </div>
        </div>
      )}
      <div
        className={cn(
          "w-full shrink-0 flex-col border-r border-border md:w-72",
          selected ? "hidden md:flex" : "flex",
        )}
      >
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-3 py-2.5 text-ui">
          <button
            className={cn(
              "rounded px-1 hover:bg-surface-2",
              dir === KNOWLEDGE_ROOT ? "font-medium text-text" : "text-link",
            )}
            onClick={() => setDir(KNOWLEDGE_ROOT)}
          >
            个人知识库
          </button>
          {crumbs.map((part, i) => {
            const to = `${KNOWLEDGE_ROOT}/${crumbs.slice(0, i + 1).join("/")}`;
            const isLast = i === crumbs.length - 1;
            return (
              <span key={to} className="flex items-center gap-0.5">
                <ChevronRight size={13} className="text-muted" />
                <button
                  className={cn("rounded px-1 hover:bg-surface-2", isLast ? "font-medium text-text" : "text-link")}
                  onClick={() => setDir(to)}
                >
                  {part}
                </button>
              </span>
            );
          })}
          {hostedWeb && (
            <>
              <span className="min-w-2 flex-1" />
              <button
                className="flex h-7 w-7 items-center justify-center rounded-input text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
                aria-label="上传资料"
                title="上传资料到个人知识库"
                onClick={() => void uploadFiles()}
                disabled={uploading}
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              </button>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {entries === null && <FilesSkeleton />}
          {error && <div className="p-2 text-sm text-error">{error}</div>}
          {entries && entries.length === 0 && !error && (
            hasCommandBackend ? (
              <EmptyState
                icon={FolderOpen}
                title="这里还没有资料"
                description="上传文献、报告或数据后，问答与科研执行会自动参考相关内容。"
                className="px-2 py-8"
              />
            ) : (
              <EmptyState
                icon={ServerCrash}
                title="知识库服务暂时不可用"
                className="px-2 py-8"
              />
            )
          )}
          {entries?.map((entry) => (
            <button
              key={entry.path}
              onClick={() => open(entry)}
              className={cn(
                "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-ui hover:bg-surface-2",
                selected?.path === entry.path ? "bg-surface-2 text-text" : "text-text/90",
              )}
            >
              {iconFor(entry)}
              <span className="flex-1 truncate">{entry.name}</span>
              {!entry.isDir && <span className="shrink-0 text-caption text-muted">{humanSize(entry.size)}</span>}
              {entry.isDir && <ChevronRight size={14} className="shrink-0 text-muted" />}
            </button>
          ))}
        </div>
      </div>

      <div className={cn("min-h-0 min-w-0 flex-1", !selected && "hidden md:block")}>
        {selected ? (
          <FilePreview key={selected.path} entry={selected} root="base" onClose={() => setSelected(null)} />
        ) : (
          <EmptyState
            icon={FolderOpen}
            title="个人知识库"
            description="集中保存你的文献、报告与数据。EviMed 在问答和科研执行时会自动读取相关资料。"
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}

function FilePreview({
  entry,
  root,
  onClose,
  controls,
}: {
  entry: DirEntry;
  root: "workspace" | "base";
  onClose: () => void;
  controls?: React.ReactNode;
}) {
  const ext = extOf(entry.name);
  if (ext === "ipynb")
    return <NotebookEditor path={entry.path} root={root} onClose={onClose} controls={controls} />;
  const kind: PreviewKind = previewKindForName(entry.name);
  return (
    <FilePreviewInspector
      data={{
        variant: "file",
        path: entry.path,
        filename: entry.name,
        artifact: extToKind(ext),
        language: EXT_LANG[ext] ?? (kind === "text" ? ext : undefined),
        root,
      }}
      onClose={onClose}
      controls={controls}
    />
  );
}

/**
 * Compact browser for the CURRENT session's folder, shown in the right
 * inspector pane beside the conversation (the session-scoped quick entry —
 * the Files page itself is global). Clicking a file swaps the pane to its
 * preview; closing the preview returns to the list.
 */
export function SessionFilesPane({
  onClose,
  controls,
}: {
  onClose: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
}) {
  const workspace = useRuntimeStore((s) => s.workspace);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [uploading, setUploading] = useState(false);

  // A session switch moves the active folder — restart at its root.
  useEffect(() => {
    setSelected(null);
    setDir("");
  }, [workspace]);

  const loadEntries = useCallback(async (rel: string, cancelled: () => boolean = () => false) => {
    setEntries(null);
    setError(null);
    await listDir(rel, "workspace")
      .then((e) => {
        if (!cancelled()) setEntries(e);
      })
      .catch((e) => {
        if (!cancelled()) {
          setError(e instanceof Error ? e.message : String(e));
          setEntries([]);
        }
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadEntries(dir, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [dir, workspace, loadEntries]);

  const uploadFiles = async () => {
    setUploading(true);
    try {
      const names = await addFilesToWorkspace(dir);
      if (names.length > 0) {
        await loadEntries(dir);
        toast.success(`已上传 ${names.length} 个文件。`);
      }
    } catch (e) {
      toast.error(`文件上传失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  };

  if (selected) {
    return (
      <FilePreview
        entry={selected}
        root="workspace"
        onClose={() => setSelected(null)}
        controls={controls}
      />
    );
  }

  const crumbs = dir ? dir.split("/") : [];
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <Folder size={14} strokeWidth={1.5} className="shrink-0 text-text" />
        <span className="truncate text-sm font-medium text-text" title={workspace ?? undefined}>
          {baseName(workspace)}
        </span>
        <span className="text-xs text-muted">本次任务文件</span>
        <div className="flex-1" />
        {controls}
        {hasCommandBackend && (
          <button
            className="flex h-7 w-7 items-center justify-center rounded-input text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
            aria-label="上传文件"
            title="上传文件到本次任务"
            onClick={() => void uploadFiles()}
            disabled={uploading}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          </button>
        )}
        <button className="text-text hover:opacity-60" aria-label="关闭任务文件" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      {crumbs.length > 0 && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-3 py-2 text-ui-sm">
          <button className="rounded px-1 text-link hover:bg-surface-2" onClick={() => setDir("")}>
            {baseName(workspace)}
          </button>
          {crumbs.map((part, i) => {
            const to = crumbs.slice(0, i + 1).join("/");
            const isLast = i === crumbs.length - 1;
            return (
              <span key={to} className="flex items-center gap-0.5">
                <ChevronRight size={12} className="text-muted" />
                <button
                  className={cn("rounded px-1 hover:bg-surface-2", isLast ? "font-medium text-text" : "text-link")}
                  onClick={() => setDir(to)}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {entries === null && <FilesSkeleton />}
        {error && <div className="p-2 text-sm text-error">{error}</div>}
        {entries && entries.length === 0 && !error && (
          <EmptyState icon={FolderOpen} title="本次任务还没有文件" className="px-2 py-8" />
        )}
        {entries?.map((entry) => (
          <button
            key={entry.path}
            onClick={() => (entry.isDir ? setDir(entry.path) : setSelected(entry))}
            className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-ui text-text/90 hover:bg-surface-2"
          >
            {iconFor(entry)}
            <span className="flex-1 truncate">{entry.name}</span>
            {!entry.isDir && <span className="shrink-0 text-caption text-muted">{humanSize(entry.size)}</span>}
            {entry.isDir && <ChevronRight size={14} className="shrink-0 text-muted" />}
          </button>
        ))}
      </div>
    </div>
  );
}
