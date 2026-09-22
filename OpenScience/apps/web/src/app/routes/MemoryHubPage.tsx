import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Search, Share2 } from "lucide-react";
import {
  fetchMemoryProfile,
  getWebProjectId,
  searchMemories,
  type WebMemoryUsage,
  type WebStructuredMemory,
} from "@/lib/apiClient";
import {
  announceMemoryChanged,
  ensureMyCapsule,
  fetchMemoryTimeline,
  fetchMyCapsule,
  type OwnCapsuleEntry,
  type TimelineEvent,
} from "@/lib/memoryClient";
import { listMethods, type WebMethod } from "@/lib/methodsClient";
import type { CapsuleRecord } from "@/lib/productClient";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTitle } from "@/components/layout/PageTitle";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { CapsuleEntryRow } from "@/components/capsule/CapsuleEntryRow";
import { MemoryRecordRow } from "@/components/capsule/MemoryRecordRow";
import { MethodRow } from "@/components/capsule/MethodRow";
import { ReceivedShelf } from "@/components/capsule/ReceivedShelf";
import { RecentChanges } from "@/components/capsule/RecentChanges";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { MemoryControls } from "@/components/memory/MemoryControls";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { CapsuleTransferPanel } from "./CapsuleTransferPanel";

/** The two nouns this product keeps apart, printed under the title (plan §3.1). */
const DEFINITION = "EviMed 自己记下的：关于你、你的项目、你的做法。自动生效，每条看得到来处，随时能改能忘。资料本身在「知识库」。";

/** The filters the list understands. One home each, so the counts add up. */
export type MemoryFilter = "all" | "self" | "methods" | "project" | "forgotten";

const FILTERS: readonly { value: MemoryFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "self", label: "关于我" },
  { value: "methods", label: "我的做法" },
  { value: "project", label: "当前项目" },
  { value: "forgotten", label: "已忘记" },
];

/** Which filter a memory belongs under. */
function filterOf(record: WebStructuredMemory, projectId: string): MemoryFilter {
  if (record.status === "archived") return "forgotten";
  if (["preference", "behavior"].includes(record.kind)) return "methods";
  if (record.scope === "project" || ["project_fact", "analysis", "decision", "follow_up", "run_summary"].includes(record.kind)) {
    return record.scope === "project" && record.scopeId !== projectId ? "all" : "project";
  }
  return "self";
}

/**
 * 「记忆胶囊」 — one page: the switches in the header, what changed lately,
 * and one searchable list.
 *
 * Hidden knowledge: it was six tabs, then one page with a card of switches
 * and a generated portrait (「EviMed 眼中的你」) above the list. The owner's
 * reading on 2026-09-22 was that the portrait repeated the list under it
 * (「evimed眼中的你有啥用呢，底下不都有吗」), that two switches and a reset
 * did not earn a section of their own, and that sharing had disappeared — it
 * was behind a disclosure at the foot of the page. ChatGPT and Claude keep
 * the same shape this now has: the controls on one line at the top, the
 * memories as one list under a search box, and export beside them.
 *
 * What went, and stays gone: both 「写一个方法」 forms, the 「你写下的笔记」
 * composer, 「放进胶囊」 per document, the 「逐个管理胶囊」 page, the count
 * tiles, the 「还缺」 chore list, the 资料 tab, and the portrait — every one of
 * them a way of asking the researcher to read or do what the platform had
 * already done.
 */
export function MemoryHubPage() {
  const [params, setParams] = useSearchParams();
  const projectId = getWebProjectId();
  const highlightId = params.get("record");
  const [filter, setFilter] = useState<MemoryFilter>("all");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ items: WebStructuredMemory[]; conversations: Record<string, string>; usage: Record<string, WebMemoryUsage> } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [ownCapsule, setOwnCapsule] = useState<CapsuleRecord | null>(null);
  const [sharing, setSharing] = useState(false);

  // 「刚记住了 … 撤销」 for what changed by itself since the last visit.
  useMemoryWritePrompt();

  const { data, failed, reload } = useCapsuleData(async () => {
    const [profile, mine, methods, timeline] = await Promise.all([
      fetchMemoryProfile(),
      fetchMyCapsule().catch(() => null),
      listMethods().catch(() => null),
      fetchMemoryTimeline({ limit: 40 }).catch(() => null),
    ]);
    return { profile, mine, methods, timeline };
  });

  useEffect(() => {
    let active = true;
    void ensureMyCapsule().then((own) => { if (active) setOwnCapsule(own); }, () => { /* export waits; import still works */ });
    return () => { active = false; };
  }, []);

  // Server-side, and debounced: the box used to be a `toLowerCase().includes`
  // over the rows already loaded, so it could only find what was on screen.
  useEffect(() => {
    const text = query.trim();
    if (!text) { setFound(null); setSearchFailed(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void searchMemories(text).then(
        (page) => { setFound({ items: page.items, conversations: page.conversations ?? {}, usage: page.usage ?? {} }); setSearchFailed(false); },
        () => setSearchFailed(true),
      ).finally(() => setSearching(false));
    }, 250);
    return () => { clearTimeout(timer); setSearching(false); };
  }, [query]);

  const records = useMemo(() => (found ? found.items : data?.profile.records ?? []), [found, data]);
  const conversations = found ? found.conversations : data?.profile.conversations ?? {};
  const usage = found ? found.usage : data?.profile.usage ?? {};
  const methods: WebMethod[] = useMemo(() => data?.methods?.items ?? [], [data]);
  const entries: OwnCapsuleEntry[] = data?.mine?.entries ?? [];
  const timeline: TimelineEvent[] = data?.timeline?.items ?? [];

  const shown = records.filter((record) => {
    if (record.sensitive && filter !== "self") return false;
    if (filter === "all") return record.status !== "archived";
    return filterOf(record, projectId) === filter;
  });
  // A method and a capsule entry are 我的做法 too — the same question a reader
  // is asking, answered from the three places the platform stores it.
  const shownMethods = ["all", "methods"].includes(filter) && !query ? methods.filter((method) => method.status !== "retired") : [];
  const shownEntries = !query
    ? entries.filter((entry) => {
      if (entry.payload.status === "retired") return filter === "forgotten";
      if (filter === "all") return true;
      if (filter === "methods") return ["method_preference", "writing_style"].includes(entry.payload.factKind);
      if (filter === "self") return ["preference", "expertise"].includes(entry.payload.factKind);
      if (filter === "project") return (entry.projectId ?? null) === projectId;
      return false;
    })
    : [];

  const loading = data === null;
  const empty = shown.length === 0 && shownMethods.length === 0 && shownEntries.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <PageTitle page="记忆胶囊" />
      <div className="mx-auto w-full max-w-content-wide space-y-6 px-6 py-6">
        <PageHeader
          title="记忆胶囊"
          description={DEFINITION}
          actions={(
            <>
              <MemoryControls onReset={reload} />
              {/* Sharing is a header action, where ChatGPT and Claude keep
                * export: it was a disclosure at the foot of the page, and the
                * owner asked where it had gone (2026-09-22). */}
              <Button variant="ghost" size="sm" onClick={() => setSharing(true)} title="把 EviMed 学到的做法加密导出给别人，或收下别人分享的胶囊">
                <Share2 size={13} aria-hidden="true" />
                分享与导入
              </Button>
            </>
          )}
        />

        {failed && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-ui text-text">
            <span>{loading ? "暂时读不到记忆。" : "刚才没有刷新成功，下面是上次读到的内容。"}</span>
            <Button variant="ghost" size="sm" onClick={reload}>重试</Button>
          </div>
        )}

        {loading ? <MemorySkeleton /> : (
          <>
            <RecentChanges items={timeline} onChanged={reload} />

            <section aria-labelledby="capsule-list" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="capsule-list" className="text-body font-semibold text-text">记下的内容</h2>
                <div className="relative">
                  <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <Input
                    aria-label="搜索记忆"
                    type="search"
                    value={query}
                    placeholder="搜句子、来源对话或项目"
                    className="pl-9"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              </div>
              <SegmentedControl
                aria-label="筛选记忆"
                value={filter}
                onChange={setFilter}
                options={[...FILTERS]}
              />
              {searchFailed && (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-ui text-text">
                  <span>搜索没有完成。</span>
                  <Button variant="ghost" size="sm" onClick={() => setQuery((text) => `${text} `.trim())}>重试</Button>
                </div>
              )}
              {searching && !found ? <MemorySkeleton /> : empty ? (
                <p className="rounded-card border border-dashed border-border px-4 py-6 text-ui text-muted">
                  {query
                    ? "没有找到。换个说法，或者搜那次对话的标题。"
                    : filter === "forgotten"
                      ? "没有忘记过任何一条。你在这里让它忘记的内容会留在这，随时可以恢复。"
                      : "这里还是空的。EviMed 会在你和它做研究的过程中自己记下，不需要你填写。"}
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-card border border-border bg-surface">
                  {shownMethods.map((method) => (
                    <MethodRow key={method.id} method={method} onChanged={reload} />
                  ))}
                  {shown.map((record) => (
                    <MemoryRecordRow
                      key={record.id}
                      record={record}
                      highlighted={record.id === highlightId}
                      conversationTitle={conversations[memorySession(record)] ?? ""}
                      usage={usage[record.id]}
                      onChanged={reload}
                    />
                  ))}
                  {shownEntries.map((entry) => (
                    <CapsuleEntryRow key={entry.id} entry={entry} onChanged={reload} />
                  ))}
                </ul>
              )}
              {found && found.items.length > 0 && (
                <p className="text-caption text-muted">搜索结果按相关度排序，包含已忘记的内容。清空搜索框回到全部。</p>
              )}
            </section>

            <ReceivedShelf />
          </>
        )}
      </div>
      {sharing && (
        <Drawer
          title="分享与导入"
          description="分享 EviMed 从你的研究里学到的做法和你说过的工作偏好；收下别人分享的胶囊。原始资料、账户标识和对话记录不会随包导出。"
          onClose={() => setSharing(false)}
        >
          <CapsuleTransferPanel capsule={ownCapsule} onImported={() => { announceMemoryChanged(); reload(); }} />
        </Drawer>
      )}
      {/* An inbox notice names a memory (`?record=`); the row scrolls itself
          into view, and the address is cleared so a reload does not re-scroll. */}
      {highlightId && !loading && <ClearHighlight onDone={() => {
        const next = new URLSearchParams(params);
        next.delete("record");
        setParams(next, { replace: true });
      }} />}
    </div>
  );
}

/** The session a memory came out of, for its conversation's title. */
function memorySession(record: WebStructuredMemory): string {
  for (const item of record.evidence) {
    const sessionId = /^sessions\/([^/]+)\//.exec(item.sourceRef ?? "")?.[1];
    if (sessionId) return sessionId;
  }
  return "";
}

function ClearHighlight({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2_000);
    return () => clearTimeout(timer);
  }, [onDone]);
  return null;
}
