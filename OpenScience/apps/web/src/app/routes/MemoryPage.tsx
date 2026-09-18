import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Brain,
  Check,
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
import { webErrorMessage, createResearchMemory, deleteResearchMemory, deleteStructuredMemory, fetchMemoryProfile, fetchMemoryStatus, hasWebApi, listResearchMemories, updateResearchMemory, updateStructuredMemory, type WebMemoryProfile, type WebMemoryStatus, type WebResearchMemory, type WebStructuredMemory } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { evidenceSourceLabel, looksInjected, memoryExcerpt } from "@/lib/memoryText";
import { toast } from "@/lib/toast";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Textarea } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { MemoryControls } from "@/components/memory/MemoryControls";
import { PAGE_TITLE_CLASS } from "@/components/layout/PageHeader";
import { useSearchParams } from "react-router";

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

const structuredKinds = [
  "profile",
  "preference",
  "behavior",
  "project_fact",
  "analysis",
  "decision",
  "correction",
  "follow_up",
  "run_summary",
] as const;

function profileFromRecords(records: WebStructuredMemory[]): WebMemoryProfile {
  const groups = Object.fromEntries(structuredKinds.map((kind) => [kind, records.filter((record) => record.kind === kind)])) as WebMemoryProfile["groups"];
  return {
    records,
    groups,
    activeCount: records.filter((record) => record.status === "active").length,
    pendingCount: records.filter((record) => record.status === "pending").length,
  };
}

/** @param embedded rendered as one view of 记忆; the hub owns the title. */
export function MemoryPage({ embedded = false }: { embedded?: boolean } = {}) {
  // `?record=` is how an inbox notice points at the memory it is about. The
  // notice used to name a rewritten memory and offer no way to reach it, so the
  // reader had to find it by hand among everything the account holds (M4①).
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get("record");
  const [status, setStatus] = useState<WebMemoryStatus | null>(null);
  const [items, setItems] = useState<WebResearchMemory[]>([]);
  const [profile, setProfile] = useState<WebMemoryProfile | null>(null);
  const [state, setState] = useState<MemoryState>("normal");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WebResearchMemory | null>(null);
  const [structuredBusyId, setStructuredBusyId] = useState<string | null>(null);
  const [pendingStructuredDelete, setPendingStructuredDelete] = useState<WebStructuredMemory | null>(null);

  const load = useCallback(async (targetState: MemoryState) => {
    setLoading(true);
    try {
      if (!hasWebApi) {
        setStatus({ configured: false, connected: false, code: "memory_unconfigured" });
        setItems([]);
        setProfile(null);
        return;
      }
      const nextStatus = await fetchMemoryStatus();
      setStatus(nextStatus);
      if (nextStatus.connected) {
        const [nextItems, nextProfile] = await Promise.all([
          listResearchMemories(targetState),
          fetchMemoryProfile(),
        ]);
        setItems(nextItems);
        setProfile(nextProfile);
      } else {
        setItems([]);
        setProfile(null);
      }
    } catch (error) {
      setItems([]);
      setProfile(null);
      setStatus({ configured: true, connected: false, code: "memory_unavailable" });
      toast.error(`科研记忆加载失败：${actionError(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(state);
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

  const mutateStructured = async (
    record: WebStructuredMemory,
    update: Partial<Pick<WebStructuredMemory, "value" | "summary" | "status" | "importance" | "sensitive">>,
  ) => {
    setStructuredBusyId(record.id);
    try {
      const updated = await updateStructuredMemory(record, update);
      setProfile((current) => current
        ? profileFromRecords(current.records.map((candidate) => candidate.id === updated.id ? updated : candidate))
        : current);
      toast.success(update.status === "active" ? "已确认这条记忆" : "结构化记忆已更新");
    } catch (error) {
      toast.error(`更新失败：${actionError(error)}`);
    } finally {
      setStructuredBusyId(null);
    }
  };

  const removeStructured = async () => {
    const record = pendingStructuredDelete;
    setPendingStructuredDelete(null);
    if (!record) return;
    setStructuredBusyId(record.id);
    try {
      await deleteStructuredMemory(record.id);
      setProfile((current) => current
        ? profileFromRecords(current.records.filter((candidate) => candidate.id !== record.id))
        : current);
      toast.success("结构化记忆已删除");
    } catch (error) {
      toast.error(`删除失败：${actionError(error)}`);
    } finally {
      setStructuredBusyId(null);
    }
  };

  const connected = status?.connected === true;
  // The pill is the positive mirror of the sentence an unnamed failure gets, so
  // the two halves of one state read as one pair; 库 stays inside the store's
  // own four sentences above, where it names the thing that failed.
  const statusText = connected
    ? "科研记忆服务已连接"
    : statusMessages[status?.code ?? ""] ?? "科研记忆服务未连接";

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-content-full px-6 py-8 lg:px-10 lg:py-10">
        <header className="flex flex-col gap-5 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            {!embedded && <h1 className={PAGE_TITLE_CLASS}>科研记忆</h1>}
            <p className={embedded ? "max-w-2xl text-body text-muted" : "mt-2 max-w-2xl text-body text-muted"}>
              保存长期有效的研究背景、偏好与判断线索。EviMed 会按当前问题检索相关记录，并与知识库文件和外部证据分开处理。
            </p>
          </div>
          <div className={cn(
            "inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-ui",
            connected ? "border-ok bg-ok-soft text-ok" : "border-border bg-surface text-muted",
          )}>
            <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-ok" : "bg-muted")} />
            {statusText}
          </div>
        </header>

        {status === null ? (
          <MemorySkeleton />
        ) : connected ? (
          <>
            <MemoryControls onReset={() => void load(state)} />
            {profile && (
              <MemoryProfileOverview
                profile={profile}
                busyId={structuredBusyId}
                highlightId={highlightId}
                onUpdate={(record, update) => void mutateStructured(record, update)}
                onDelete={setPendingStructuredDelete}
              />
            )}

            <section className="mt-7 overflow-hidden rounded-card border border-border bg-surface">
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

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
            className="mt-8 min-h-72 rounded-card border border-dashed border-border bg-surface"
          />
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="删除这条科研记忆？"
          body="删除后无法恢复，后续问答与科研任务也不会再检索到它。不会删除写下它时的对话与运行记录。"
          confirmLabel="删除"
          onConfirm={() => void remove()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {pendingStructuredDelete && (
        <ConfirmDialog
          title="删除这条结构化记忆？"
          body="删除这条记忆及其依据与修订记录，用户画像和后续科研问答都不会再使用它，检索索引中的副本随后移除。不会删除产生它的对话与运行记录；同样的内容以后若再次出现，可能会被重新学到。"
          confirmLabel="删除"
          onConfirm={() => void removeStructured()}
          onCancel={() => setPendingStructuredDelete(null)}
        />
      )}
    </div>
  );
}

/** A note's rendered Markdown, re-parsed only when its text changes. */
const NoteMarkdown = memo(function NoteMarkdown({ content }: { content: string }) {
  return <MarkdownViewer className="text-body">{content}</MarkdownViewer>;
});

/** How many records a section shows before it offers the rest. */
const SECTION_PREVIEW = 5;

function MemoryProfileOverview({
  profile,
  busyId,
  highlightId,
  onUpdate,
  onDelete,
}: {
  profile: WebMemoryProfile;
  busyId: string | null;
  /** The record an inbox notice pointed at, via `?record=`. */
  highlightId: string | null;
  onUpdate: (
    record: WebStructuredMemory,
    update: Partial<Pick<WebStructuredMemory, "value" | "summary" | "status">>,
  ) => void;
  onDelete: (record: WebStructuredMemory) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const highlighted = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightId) highlighted.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlightId]);
  const [confirming, setConfirming] = useState<{
    record: WebStructuredMemory;
    update: Partial<Pick<WebStructuredMemory, "value" | "summary" | "status">>;
  } | null>(null);
  const sections = [
    { title: "用户画像", records: [...profile.groups.profile, ...profile.groups.behavior] },
    { title: "偏好习惯", records: profile.groups.preference },
    { title: "项目事实", records: [...profile.groups.project_fact, ...profile.groups.decision] },
    { title: "分析要素", records: [...profile.groups.analysis, ...profile.groups.correction, ...profile.groups.follow_up] },
  ];

  return (
    <section className="mt-7" aria-label="结构化用户记忆">
      {confirming && (
        <ConfirmDialog
          title="确认这条敏感记忆？"
          body={`生效后，它会在后续研究中被读取并影响回答：${memoryExcerpt(confirming.update.summary || confirming.record.summary || confirming.record.value, 120)}`}
          confirmLabel="确认生效"
          onConfirm={() => { onUpdate(confirming.record, confirming.update); setConfirming(null); }}
          onCancel={() => setConfirming(null)}
        />
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-title font-semibold text-text">EviMed 对你的持续理解</h2>
          <p className="mt-1 text-ui text-muted">{profile.activeCount} 条已生效 · {profile.pendingCount} 条待确认；每条都有来源证据与版本记录。</p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {sections.map((section) => {
          const records = section.records.filter((record) => ["active", "pending"].includes(record.status));
          // A notice that names a record must not land on a section that shows
          // the first five of twelve and hides the one it meant.
          const holdsHighlight = highlightId !== null && records.some((record) => record.id === highlightId);
          const shown = expanded.has(section.title) || holdsHighlight ? records : records.slice(0, SECTION_PREVIEW);
          return (
            <article key={section.title} className="rounded-card border border-border bg-surface p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-body font-semibold text-text">{section.title}</h3>
                <span className="text-caption text-muted">{records.length}</span>
              </div>
              {records.length === 0 ? (
                <p className="text-ui text-muted">尚无稳定记录</p>
              ) : (
                <div className="space-y-3">
                  {shown.map((record) => (
                    <div
                      key={record.id}
                      ref={record.id === highlightId ? highlighted : undefined}
                      className={cn(
                        "rounded-input bg-surface-2 p-3",
                        record.id === highlightId && "ring-2 ring-accent",
                      )}
                    >
                      {editingId === record.id ? (
                        <Textarea
                          value={editingValue}
                          onChange={(event) => setEditingValue(event.target.value)}
                          aria-label="修正结构化记忆"
                          className="min-h-24 bg-bg text-ui"
                        />
                      ) : (
                        <p className="text-ui text-text">{memoryExcerpt(record.summary || record.value)}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-caption text-muted">
                        <span>{record.evidenceCount} 条证据</span>
                        <span>置信度 {Math.round(record.confidence * 100)}%</span>
                        {record.sensitive && <span className="text-error">敏感</span>}
                        {record.status === "pending" && <span className="text-accent">待确认</span>}
                        {/* A record whose text carries a machine marker was not
                            something this person said. The extractor no longer
                            creates these, and the eleven that existed are
                            archived; a row that arrives from an import still
                            gets told apart from a preference. */}
                        {looksInjected(record.summary || record.value) && (
                          <span className="text-warn">疑似任务题面，非你的陈述</span>
                        )}
                      </div>
                      {(record.evidence.length > 0 || record.revisions.length > 0) && (
                        <details className="mt-2 text-caption text-muted">
                          <summary className="cursor-pointer select-none hover:text-text">
                            查看依据与变更
                          </summary>
                          <div className="mt-2 space-y-2 border-l border-border pl-2">
                            {record.evidence.slice(-3).reverse().map((evidence) => (
                              <div key={evidence.fingerprint || `${evidence.sourceRef}-${evidence.observedAt}`}>
                                <p className="text-text">“{evidence.quote}”</p>
                                <p className="mt-0.5">{evidenceSourceLabel(evidence.sourceType)} · {formatTime(evidence.observedAt)}</p>
                              </div>
                            ))}
                            {record.revisions.length > 0 && (
                              <p>已有 {record.revisions.length} 次历史修订，当前为第 {record.version} 版。</p>
                            )}
                          </div>
                        </details>
                      )}
                      <div className="mt-2 flex justify-end gap-1">
                        {editingId === record.id ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>取消</Button>
                            <Button
                              size="sm"
                              disabled={!editingValue.trim() || busyId === record.id}
                              onClick={() => {
                                const update = { value: editingValue.trim(), summary: editingValue.trim(), status: "active" as const };
                                if (record.status === "pending" && record.sensitive) setConfirming({ record, update });
                                else onUpdate(record, update);
                                setEditingId(null);
                              }}
                            >
                              保存修正
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyId === record.id}
                            onClick={() => {
                              setEditingId(record.id);
                              setEditingValue(record.summary || record.value);
                            }}
                          >
                            <Pencil size={13} aria-hidden="true" /> 修正
                          </Button>
                        )}
                        {/* Sensitive pending records used to have no 「确认」
                            button — and 「修正」 wrote `status: "active"`
                            anyway, so the only way to accept one was through
                            the path that did not ask (2026-09-16 review, M4②).
                            Both paths now go through the same dialog. */}
                        {record.status === "pending" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyId === record.id}
                            onClick={() => {
                              if (record.sensitive) setConfirming({ record, update: { status: "active" } });
                              else onUpdate(record, { status: "active" });
                            }}
                          >
                            <Check size={13} aria-hidden="true" /> 确认
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" disabled={busyId === record.id} onClick={() => onDelete(record)}>
                          <Trash2 size={13} aria-hidden="true" /> 删除
                        </Button>
                      </div>
                    </div>
                  ))}
                  {/* The count in the header was the section's total and the
                      list showed five, with nothing saying so (2026-09-16
                      review, M6). */}
                  {records.length > SECTION_PREVIEW && !holdsHighlight && (
                    <button
                      type="button"
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(section.title)) next.delete(section.title);
                        else next.add(section.title);
                        return next;
                      })}
                      className="min-h-6 w-full rounded-input px-2 py-1 text-ui text-muted hover:bg-surface-2 hover:text-text"
                    >
                      {expanded.has(section.title) ? "收起" : `还有 ${records.length - SECTION_PREVIEW} 条`}
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

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
