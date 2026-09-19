import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Brain,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  ServerCrash,
  Trash2,
  X,
} from "lucide-react";
import { webErrorMessage, createResearchMemory, deleteResearchMemory, fetchMemoryStatus, hasWebApi, listResearchMemories, updateResearchMemory, type WebMemoryStatus, type WebResearchMemory } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { MEMORY_CHANGED_EVENT } from "@/lib/memoryClient";
import { toast } from "@/lib/toast";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Textarea } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PAGE_TITLE_CLASS } from "@/components/layout/PageHeader";

type MemoryState = "normal" | "archived";

// The memory store is a schema of the control plane's own database, so there is
// no address, token or session to get wrong: these four are every code it can
// report. An unknown code keeps the generic sentence below.
const statusMessages: Record<string, string> = {
  memory_unconfigured: "科研记忆库未配置",
  memory_schema_unavailable: "科研记忆库结构未就绪",
  memory_unavailable: "科研记忆库暂时不可用",
  memory_timeout: "科研记忆库响应超时",
};

function formatTime(value: string | null) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return formatDateTime(date, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** One Chinese sentence for a refusal on this page, from the shared dictionary.
 *  It used to hand back `Error.message`, which is how 「抽取报错: This operation
 *  was aborted」 reached a researcher (2026-09-16 walk, U4). */
function actionError(error: unknown) {
  return webErrorMessage(error, { fallback: "操作未完成，请重试。" });
}

/**
 * The researcher's own notes: written by hand, pinned, archived, searched.
 *
 * Until 2026-09-20 this page was the whole of memory — a connection pill, the
 * switches, a four-column board of structured records and the notes. The
 * capsule page (「记忆胶囊」) now carries each of those in its own section, and
 * this is what is left of it: the notes, shown under 「对你的理解」.
 *
 * @param embedded rendered inside a section of the capsule page, which owns
 *   the title and the scrolling.
 */
export function MemoryPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [status, setStatus] = useState<WebMemoryStatus | null>(null);
  const [items, setItems] = useState<WebResearchMemory[]>([]);
  const [state, setState] = useState<MemoryState>("normal");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WebResearchMemory | null>(null);

  const load = useCallback(async (targetState: MemoryState) => {
    setLoading(true);
    try {
      if (!hasWebApi) {
        setStatus({ configured: false, connected: false, code: "memory_unconfigured" });
        setItems([]);
        return;
      }
      const nextStatus = await fetchMemoryStatus();
      setStatus(nextStatus);
      setItems(nextStatus.connected ? await listResearchMemories(targetState) : []);
    } catch (error) {
      setItems([]);
      setStatus({ configured: true, connected: false, code: "memory_unavailable" });
      toast.error(`科研记忆加载失败：${actionError(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(state);
  }, [load, state]);
  // An undo from the write prompt changes what this page shows.
  useEffect(() => {
    const reload = () => void load(state);
    window.addEventListener(MEMORY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MEMORY_CHANGED_EVENT, reload);
  }, [load, state]);

  // Deferred, and each card's Markdown memoized below: every keystroke in the
  // search box or the draft used to re-parse every card's Markdown on the page
  // (2026-09-16 review, U11).
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      item.content.toLowerCase().includes(needle) || item.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  }, [items, deferredQuery]);

  const create = async () => {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      const created = await createResearchMemory(content);
      setItems((current) => [created, ...current]);
      setDraft("");
      toast.success("科研记忆已保存，并会在相关问答和科研任务中参与检索。");
    } catch (error) {
      toast.error(`保存失败：${actionError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const mutate = async (
    item: WebResearchMemory,
    update: Partial<Pick<WebResearchMemory, "content" | "pinned" | "state">>,
  ) => {
    setBusyId(item.id);
    try {
      const updated = await updateResearchMemory(item.id, update);
      if (updated.state !== state) {
        setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      } else {
        // Undoing an archive brings the item back: it matches the current view
        // but is no longer in the list, so replace-in-place alone would drop it.
        setItems((current) =>
          current.some((candidate) => candidate.id === updated.id)
            ? current.map((candidate) => (candidate.id === updated.id ? updated : candidate))
            : [updated, ...current],
        );
      }
      setEditingId(null);
      toast.success(
        update.state ? (update.state === "archived" ? "已归档" : "已恢复") : "科研记忆已更新",
        update.state === "archived"
          ? { action: { label: "撤销", onClick: () => void mutate(updated, { state: "normal" }) } }
          : undefined,
      );
    } catch (error) {
      toast.error(`更新失败：${actionError(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    const item = pendingDelete;
    setPendingDelete(null);
    if (!item) return;
    setBusyId(item.id);
    try {
      await deleteResearchMemory(item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      toast.success("科研记忆已删除");
    } catch (error) {
      toast.error(`删除失败：${actionError(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  const connected = status?.connected === true;
  // Said only when something is wrong (proposal §4.4): a pill announcing that
  // the service is connected was the engine talking about itself.
  const statusText = statusMessages[status?.code ?? ""] ?? "科研记忆服务未连接";

  const content = status === null ? (
    <MemorySkeleton />
  ) : connected ? (
    <>
      <section className="mt-4 overflow-hidden rounded-card border border-border bg-surface">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="记录一条科研记忆… 例如：项目纳入标准、常用数据口径、某个药物证据争议或长期研究偏好。支持 Markdown 和 #标签。"
          aria-label="科研记忆内容"
          className="min-h-32 w-full resize-y bg-transparent px-5 pb-3 pt-5 text-body text-text outline-none placeholder:text-muted"
        />
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-ui text-muted">仅保存为个人私有记忆；系统会根据问题相关性选择使用。</span>
          <Button onClick={() => void create()} disabled={!draft.trim()} loading={saving}>
            {!saving && <Plus size={14} aria-hidden="true" />}
            保存记忆
          </Button>
        </div>
      </section>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          aria-label="筛选记忆状态"
          value={state}
          onChange={setState}
          options={[
            { value: "normal", label: "当前记忆" },
            { value: "archived", label: "已归档" },
          ]}
        />
        <div className="relative sm:w-72">
          <label htmlFor="memory-search" className="sr-only">搜索科研记忆</label>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input
            id="memory-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索内容或标签"
            type="search"
            className="pl-9"
          />
        </div>
      </div>

      {loading ? (
        <MemorySkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Brain}
          title={query ? "没有匹配的科研记忆" : state === "normal" ? "还没有科研记忆" : "暂无归档记录"}
          description={query ? "换一个关键词试试。" : "从研究中反复出现、以后仍可能有用的信息开始记录，不必把临时对话全部保存。"}
          className="mt-6 rounded-card border border-dashed border-border"
        />
      ) : (
        <section className="mt-6 grid items-start gap-4 md:grid-cols-2" aria-label="科研记忆列表">
          {filtered.map((item) => (
            <article key={item.id} className="group rounded-card border border-border bg-surface p-5 transition-colors hover:border-strong">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-caption text-muted">
                  {item.pinned && <span className="inline-flex items-center gap-1 font-medium text-accent"><Pin size={11} aria-hidden="true" /> 置顶</span>}
                  <span>{formatTime(item.updatedAt ?? item.createdAt)}</span>
                </div>
                <div className="flex items-center opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  {state === "normal" && (
                    <MemoryAction
                      label={item.pinned ? "取消置顶" : "置顶"}
                      disabled={busyId === item.id}
                      onClick={() => void mutate(item, { pinned: !item.pinned })}
                      icon={item.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
                    />
                  )}
                  <MemoryAction
                    label="编辑"
                    disabled={busyId === item.id}
                    onClick={() => {
                      setEditingId(item.id);
                      setEditingContent(item.content);
                    }}
                    icon={<Pencil size={14} aria-hidden="true" />}
                  />
                  <MemoryAction
                    label={state === "normal" ? "归档" : "恢复"}
                    disabled={busyId === item.id}
                    onClick={() => void mutate(item, { state: state === "normal" ? "archived" : "normal" })}
                    icon={state === "normal" ? <Archive size={14} aria-hidden="true" /> : <ArchiveRestore size={14} aria-hidden="true" />}
                  />
                  <MemoryAction label="删除" disabled={busyId === item.id} onClick={() => setPendingDelete(item)} icon={<Trash2 size={14} aria-hidden="true" />} danger />
                </div>
              </div>

              {editingId === item.id ? (
                <div>
                  <Textarea
                    value={editingContent}
                    onChange={(event) => setEditingContent(event.target.value)}
                    aria-label="编辑科研记忆"
                    className="min-h-40 bg-bg text-body"
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                      <X size={13} aria-hidden="true" /> 取消
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void mutate(item, { content: editingContent.trim() })}
                      disabled={!editingContent.trim()}
                      loading={busyId === item.id}
                    >
                      保存修改
                    </Button>
                  </div>
                </div>
              ) : (
                <NoteMarkdown content={item.content} />
              )}

              {item.tags.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border pt-3">
                  {item.tags.map((tag) => <span key={tag} className="rounded-full bg-surface-2 px-2 py-0.5 text-caption text-muted">#{tag}</span>)}
                </div>
              )}
            </article>
          ))}
        </section>
      )}
    </>
  ) : (
    <EmptyState
      icon={ServerCrash}
      title={loading ? "正在连接科研记忆" : "科研记忆尚未就绪"}
      description={
        loading
          ? undefined
          : hasWebApi
            ? `${statusText}。知识库文件仍可正常使用；连接完成前，EviMed 不会声称读取过个人科研记忆。`
            : "科研记忆仅在 EviMed 在线工作空间中可用，请在 EviMed 在线工作空间中使用此功能。"
      }
      action={
        !loading && hasWebApi ? (
          <Button variant="ghost" onClick={() => void load(state)}>
            重新连接
          </Button>
        ) : undefined
      }
      className="mt-6 min-h-72 rounded-card border border-dashed border-border bg-surface"
    />
  );

  const dialogs = pendingDelete && (
    <ConfirmDialog
      title="删除这条科研记忆？"
      body="删除后无法恢复，后续问答与科研任务也不会再检索到它。不会删除写下它时的对话与运行记录。"
      confirmLabel="删除"
      onConfirm={() => void remove()}
      onCancel={() => setPendingDelete(null)}
    />
  );

  if (embedded) return <div>{content}{dialogs}</div>;
  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-content-full px-6 py-8 lg:px-10 lg:py-10">
        <header className="border-b border-border pb-7">
          <h1 className={PAGE_TITLE_CLASS}>科研笔记</h1>
          <p className="mt-2 max-w-2xl text-body text-muted">
            保存长期有效的研究背景、偏好与判断线索。EviMed 会按当前问题检索相关记录，并与知识库文件和外部证据分开处理。
          </p>
        </header>
        {content}
      </div>
      {dialogs}
    </div>
  );
}

/** A note's rendered Markdown, re-parsed only when its text changes. */
const NoteMarkdown = memo(function NoteMarkdown({ content }: { content: string }) {
  return <MarkdownViewer className="text-body">{content}</MarkdownViewer>;
});

function MemoryAction({
  label,
  icon,
  disabled,
  danger = false,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30",
        danger && "hover:bg-danger-soft hover:text-error",
      )}
    >
      {disabled ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : icon}
    </button>
  );
}
