import { useCallback, useEffect, useMemo, useState } from "react";
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
import { createResearchMemory, deleteResearchMemory, deleteStructuredMemory, fetchMemoryProfile, fetchMemoryStatus, hasWebApi, listResearchMemories, updateResearchMemory, updateStructuredMemory, type WebMemoryProfile, type WebMemoryStatus, type WebResearchMemory, type WebStructuredMemory } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Textarea } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

type MemoryState = "normal" | "archived";

const statusMessages: Record<string, string> = {
  memory_url_missing: "尚未配置 Memos 服务地址",
  memory_token_missing: "尚未配置 Memos 访问令牌",
  memos_access_token_file_unavailable: "Memos 令牌文件不可用",
  memos_access_token_file_permissions: "Memos 令牌文件权限不安全",
  memory_auth_failed: "Memos 身份验证失败",
  memory_schema_unavailable: "Memos 结构化记忆版本尚未部署",
  memory_timeout: "Memos 响应超时",
  memory_unavailable: "Memos 服务暂时不可用",
};

function formatTime(value: string | null) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function actionError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

export function MemoryPage() {
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
        setStatus({ configured: false, connected: false, code: "memory_url_missing" });
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      item.content.toLowerCase().includes(needle) || item.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  }, [items, query]);

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
  const statusText = connected
    ? `记忆服务已连接${status.account ? ` · ${status.account}` : ""}`
    : statusMessages[status?.code ?? ""] ?? "科研记忆服务未连接";

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <main className="mx-auto w-full max-w-content-full px-6 py-8 lg:px-10 lg:py-10">
        <header className="flex flex-col gap-5 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium tracking-[0.12em] text-accent">
              <Brain size={15} /> 个人科研记忆
            </div>
            <h1 className="font-serif text-display font-semibold tracking-tight text-text">科研记忆</h1>
            <p className="mt-2 max-w-2xl text-body text-muted">
              保存长期有效的研究背景、偏好与判断线索。EviMed 会按当前问题检索相关记录，并与知识库文件和外部证据分开处理。
            </p>
          </div>
          <div className={cn(
            "inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-ui-sm",
            connected ? "border-ok/30 bg-ok/10 text-ok" : "border-border bg-surface text-muted",
          )}>
            <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-ok" : "bg-muted")} />
            {statusText}
          </div>
        </header>

        {status === null ? (
          <MemorySkeleton />
        ) : connected ? (
          <>
            {profile && (
              <MemoryProfileOverview
                profile={profile}
                busyId={structuredBusyId}
                onUpdate={(record, update) => void mutateStructured(record, update)}
                onDelete={setPendingStructuredDelete}
              />
            )}

            <section className="mt-7 overflow-hidden rounded-card border border-border bg-surface shadow-card">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="记录一条科研记忆… 例如：项目纳入标准、常用数据口径、某个药物证据争议或长期研究偏好。支持 Markdown 和 #标签。"
                aria-label="科研记忆内容"
                className="min-h-32 w-full resize-y bg-transparent px-5 pb-3 pt-5 text-body text-text outline-none placeholder:text-muted/80"
              />
              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <span className="text-ui-sm text-muted">仅保存为个人私有记忆；系统会根据问题相关性选择使用。</span>
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
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
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
                  <article key={item.id} className="group rounded-card border border-border bg-surface p-5 shadow-card transition-shadow hover:shadow-pop">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-caption text-muted">
                        {item.pinned && <span className="inline-flex items-center gap-1 font-medium text-accent"><Pin size={11} /> 置顶</span>}
                        <span>{formatTime(item.updatedAt ?? item.createdAt)}</span>
                      </div>
                      <div className="flex items-center opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        {state === "normal" && (
                          <MemoryAction
                            label={item.pinned ? "取消置顶" : "置顶"}
                            disabled={busyId === item.id}
                            onClick={() => void mutate(item, { pinned: !item.pinned })}
                            icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                          />
                        )}
                        <MemoryAction
                          label="编辑"
                          disabled={busyId === item.id}
                          onClick={() => {
                            setEditingId(item.id);
                            setEditingContent(item.content);
                          }}
                          icon={<Pencil size={14} />}
                        />
                        <MemoryAction
                          label={state === "normal" ? "归档" : "恢复"}
                          disabled={busyId === item.id}
                          onClick={() => void mutate(item, { state: state === "normal" ? "archived" : "normal" })}
                          icon={state === "normal" ? <Archive size={14} /> : <ArchiveRestore size={14} />}
                        />
                        <MemoryAction label="删除" disabled={busyId === item.id} onClick={() => setPendingDelete(item)} icon={<Trash2 size={14} />} danger />
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
                      <MarkdownViewer className="text-body">{item.content}</MarkdownViewer>
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
            className="mt-8 min-h-72 rounded-card border border-dashed border-border bg-surface/50"
          />
        )}
      </main>

      {pendingDelete && (
        <ConfirmDialog
          title="删除这条科研记忆？"
          body="删除后无法恢复，后续问答与科研任务也不会再检索到它。"
          confirmLabel="删除"
          onConfirm={() => void remove()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {pendingStructuredDelete && (
        <ConfirmDialog
          title="删除这条结构化记忆？"
          body="删除后，用户画像和后续科研问答都不会再使用这条信息。"
          confirmLabel="删除"
          onConfirm={() => void removeStructured()}
          onCancel={() => setPendingStructuredDelete(null)}
        />
      )}
    </div>
  );
}

function MemoryProfileOverview({
  profile,
  busyId,
  onUpdate,
  onDelete,
}: {
  profile: WebMemoryProfile;
  busyId: string | null;
  onUpdate: (
    record: WebStructuredMemory,
    update: Partial<Pick<WebStructuredMemory, "value" | "summary" | "status">>,
  ) => void;
  onDelete: (record: WebStructuredMemory) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const sections = [
    { title: "用户画像", records: [...profile.groups.profile, ...profile.groups.behavior] },
    { title: "偏好习惯", records: profile.groups.preference },
    { title: "项目事实", records: [...profile.groups.project_fact, ...profile.groups.decision] },
    { title: "分析要素", records: [...profile.groups.analysis, ...profile.groups.correction, ...profile.groups.follow_up] },
  ];

  return (
    <section className="mt-7" aria-label="结构化用户记忆">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-title font-semibold text-text">EviMed 对你的持续理解</h2>
          <p className="mt-1 text-ui-sm text-muted">{profile.activeCount} 条已生效 · {profile.pendingCount} 条待确认；每条都有来源证据与版本记录。</p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {sections.map((section) => {
          const records = section.records.filter((record) => ["active", "pending"].includes(record.status));
          return (
            <article key={section.title} className="rounded-card border border-border bg-surface p-4 shadow-card">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-body font-semibold text-text">{section.title}</h3>
                <span className="text-caption text-muted">{records.length}</span>
              </div>
              {records.length === 0 ? (
                <p className="text-ui-sm text-muted">尚无稳定记录</p>
              ) : (
                <div className="space-y-3">
                  {records.slice(0, 5).map((record) => (
                    <div key={record.id} className="rounded-input bg-surface-2 p-3">
                      {editingId === record.id ? (
                        <Textarea
                          value={editingValue}
                          onChange={(event) => setEditingValue(event.target.value)}
                          aria-label="修正结构化记忆"
                          className="min-h-24 bg-bg text-ui-sm"
                        />
                      ) : (
                        <p className="text-ui-sm text-text">{record.summary || record.value}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-caption text-muted">
                        <span>{record.evidenceCount} 条证据</span>
                        <span>置信度 {Math.round(record.confidence * 100)}%</span>
                        {record.sensitive && <span className="text-error">敏感</span>}
                        {record.status === "pending" && <span className="text-accent">待确认</span>}
                      </div>
                      {(record.evidence.length > 0 || record.revisions.length > 0) && (
                        <details className="mt-2 text-caption text-muted">
                          <summary className="cursor-pointer select-none hover:text-text">
                            查看依据与变更
                          </summary>
                          <div className="mt-2 space-y-2 border-l border-border pl-2">
                            {record.evidence.slice(-3).reverse().map((evidence) => (
                              <div key={evidence.fingerprint || `${evidence.sourceRef}-${evidence.observedAt}`}>
                                <p className="text-text/80">“{evidence.quote}”</p>
                                <p className="mt-0.5">{evidence.sourceType} · {formatTime(evidence.observedAt)}</p>
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
                                onUpdate(record, { value: editingValue.trim(), summary: editingValue.trim(), status: "active" });
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
                        {record.status === "pending" && !record.sensitive && (
                          <Button size="sm" variant="ghost" disabled={busyId === record.id} onClick={() => onUpdate(record, { status: "active" })}>
                            <Check size={13} aria-hidden="true" /> 确认
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" disabled={busyId === record.id} onClick={() => onDelete(record)}>
                          <Trash2 size={13} aria-hidden="true" /> 删除
                        </Button>
                      </div>
                    </div>
                  ))}
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
        danger && "hover:bg-error/10 hover:text-error",
      )}
    >
      {disabled ? <Loader2 size={14} className="animate-spin" /> : icon}
    </button>
  );
}
