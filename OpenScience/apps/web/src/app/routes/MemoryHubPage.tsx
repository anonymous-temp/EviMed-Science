import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Archive, Brain } from "lucide-react";
import { fetchMemoryProfile, searchMemories, type WebStructuredMemory } from "@/lib/apiClient";
import { announceMemoryChanged, ensureMyCapsule, fetchMyCapsule, type OwnCapsuleEntry } from "@/lib/memoryClient";
import {
  MEMORY_GROUP_ORDER, entryGroup, groupLabel, recordGroup, recordProjectId, type MemoryGroup,
} from "@/lib/memoryGroups";
import { listMethods, type WebMethod } from "@/lib/methodsClient";
import type { CapsuleRecord } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { Drawer } from "@/components/ui/Drawer";
import { FilterChips } from "@/components/ui/FilterChips";
import { List } from "@/components/ui/ListRow";
import { SearchInput } from "@/components/ui/SearchInput";
import { CapsuleEntryRow } from "@/components/capsule/CapsuleEntryRow";
import { MemoryRecordRow } from "@/components/capsule/MemoryRecordRow";
import { MethodRow, methodLine } from "@/components/capsule/MethodRow";
import { ReceivedShelf } from "@/components/capsule/ReceivedShelf";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { MemoryControls } from "@/components/memory/MemoryControls";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { CapsuleTransferPanel } from "./CapsuleTransferPanel";

/** The filters, one per group a row can belong to, plus 全部. */
export type MemoryFilter = "all" | MemoryGroup;

const FILTERS: readonly { value: MemoryFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "self", label: "关于你" },
  { value: "methods", label: "做法" },
  { value: "project", label: "项目" },
];

/** One row of the list, whichever of the three stores it comes from. */
type Row =
  | { kind: "record"; group: MemoryGroup; projectId: string | null; record: WebStructuredMemory }
  | { kind: "method"; group: MemoryGroup; projectId: string | null; method: WebMethod }
  | { kind: "entry"; group: MemoryGroup; projectId: string | null; entry: OwnCapsuleEntry };

function rowKey(row: Row) {
  return row.kind === "record" ? `record:${row.record.id}` : row.kind === "method" ? `method:${row.method.id}` : `entry:${row.entry.id}`;
}

function matches(text: string, query: string) {
  return text.toLowerCase().includes(query.toLowerCase());
}

/**
 * 「记忆胶囊」: one list of what EviMed keeps about the researcher, their way of
 * working and their projects (2026-09-23 plan §5.6, mockup m08).
 *
 * The header is the title, the 「记忆」 switch and one 「⋯」; the filters are
 * 全部 / 关于你 / 做法 / 项目 with the search box beside them; and each memory
 * is one row — where it belongs on the left, one sentence on the right, and a
 * grey 「推断」 after an inference, the one annotation kept (principle 18).
 *
 * What went, and why: the sentence under the title explained the system; the
 * 「最近变化」 block was a back-office event stream that said the same thing
 * twice (「学到一条做法」 then 「一条做法开始生效」) and is each row's own
 * 「历史版本」 now; every row's 「新」「9月22日 起生效」「用过 0 次」「看看具体
 * 怎么做」 and its two or three bordered buttons are gone — 编辑 and 忘记
 * appear on hover, the rest is in the row's 「⋯」. Received capsules are inside
 * 分享与导入; forgotten ones inside 已忘记的内容, each with 恢复.
 */
export function MemoryHubPage() {
  const [params, setParams] = useSearchParams();
  const highlightId = params.get("record");
  const projects = useProjectStore((state) => state.projects);
  const [filter, setFilter] = useState<MemoryFilter>("all");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<WebStructuredMemory[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [ownCapsule, setOwnCapsule] = useState<CapsuleRecord | null>(null);
  const [drawer, setDrawer] = useState<"share" | "forgotten" | null>(null);

  // 「刚记住了 … 撤销」 for what changed by itself since the last visit.
  useMemoryWritePrompt();

  const { data, failed, reload } = useCapsuleData(async () => {
    const [profile, mine, methods] = await Promise.all([
      fetchMemoryProfile(),
      fetchMyCapsule().catch(() => null),
      listMethods().catch(() => null),
    ]);
    return { profile, mine, methods };
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
        (page) => { setFound(page.items); setSearchFailed(false); },
        () => setSearchFailed(true),
      ).finally(() => setSearching(false));
    }, 250);
    return () => { clearTimeout(timer); setSearching(false); };
  }, [query, searchAttempt]);

  const projectName = (id: string | null) => (id ? projects.find((project) => project.id === id)?.name ?? null : null);
  const label = (row: Row) => groupLabel(row.group, projectName(row.projectId));

  const methods: WebMethod[] = useMemo(() => data?.methods?.items ?? [], [data]);
  const entries: OwnCapsuleEntry[] = useMemo(() => data?.mine?.entries ?? [], [data]);
  const records: WebStructuredMemory[] = useMemo(() => data?.profile.records ?? [], [data]);

  const text = query.trim();
  const rows = useMemo(() => {
    // A search is the server's over records, and the page's own over the
    // methods and entries it already holds. Forgotten rows are not in the
    // list, searched or not: they are under 已忘记的内容.
    const recordSource = found ?? records.filter((record) => record.kind !== "run_summary");
    const all: Row[] = [
      ...recordSource
        .filter((record) => record.status !== "archived")
        .map((record): Row => ({ kind: "record", group: recordGroup(record), projectId: recordProjectId(record), record })),
      ...methods
        .filter((method) => method.status !== "retired" && (!text || matches(methodLine(method), text)))
        .map((method): Row => ({ kind: "method", group: "methods", projectId: method.projectId, method })),
      ...entries
        .filter((entry) => entry.payload.status !== "retired" && (!text || matches(entry.payload.content, text)))
        .map((entry): Row => ({ kind: "entry", group: entryGroup(entry), projectId: entry.projectId ?? null, entry })),
    ];
    return all
      // A sensitive memory is shown where the researcher looks for what is
      // about them, and nowhere else.
      .filter((row) => !(row.kind === "record" && row.record.sensitive && filter !== "self"))
      .filter((row) => filter === "all" || row.group === filter)
      .sort((left, right) => MEMORY_GROUP_ORDER.indexOf(left.group) - MEMORY_GROUP_ORDER.indexOf(right.group));
  }, [found, records, methods, entries, text, filter]);

  const forgottenRows: Row[] = [
    ...records.filter((record) => record.status === "archived")
      .map((record): Row => ({ kind: "record", group: recordGroup(record), projectId: recordProjectId(record), record })),
    ...methods.filter((method) => method.status === "retired")
      .map((method): Row => ({ kind: "method", group: "methods", projectId: method.projectId, method })),
    ...entries.filter((entry) => entry.payload.status === "retired")
      .map((entry): Row => ({ kind: "entry", group: entryGroup(entry), projectId: entry.projectId ?? null, entry })),
  ];

  const renderRow = (row: Row) => row.kind === "record"
    ? <MemoryRecordRow key={rowKey(row)} record={row.record} origin={label(row)} highlighted={row.record.id === highlightId} onChanged={reload} />
    : row.kind === "method"
      ? <MethodRow key={rowKey(row)} method={row.method} onChanged={reload} />
      : <CapsuleEntryRow key={rowKey(row)} entry={row.entry} origin={label(row)} onChanged={reload} />;

  const loading = data === null;

  return (
    <PageShell
      title="记忆胶囊"
      actions={<MemoryControls onReset={reload} onShare={() => setDrawer("share")} onForgotten={() => setDrawer("forgotten")} />}
    >
      <FilterChips
        label="筛选记忆"
        options={FILTERS}
        value={filter}
        onChange={setFilter}
        trailing={<SearchInput label="搜索记忆" value={query} onChange={(event) => setQuery(event.target.value)} className="w-60" />}
      />
      {failed && (
        <LoadError
          className="mt-4"
          message={loading ? "暂时读不到记忆。" : "刚才没有刷新成功，下面是上次读到的内容。"}
          onRetry={reload}
        />
      )}
      {searchFailed && <LoadError className="mt-4" message="搜索没有完成。" onRetry={() => setSearchAttempt((value) => value + 1)} />}
      <div className="mt-4">
        {loading || (searching && !found) ? (!failed && <RunsSkeleton filter={false} />)
          : rows.length === 0 ? (
            <EmptyState icon={Brain} title={text ? "没有找到" : records.length + methods.length + entries.length === 0 ? "还没有记忆" : "暂无"} />
          ) : <List label="记忆">{rows.map(renderRow)}</List>}
      </div>
      {drawer === "share" && (
        <Drawer title="分享与导入" onClose={() => setDrawer(null)}>
          <div className="space-y-8">
            <CapsuleTransferPanel capsule={ownCapsule} onImported={() => { announceMemoryChanged(); reload(); }} />
            <ReceivedShelf />
          </div>
        </Drawer>
      )}
      {drawer === "forgotten" && (
        <Drawer title="已忘记的内容" onClose={() => setDrawer(null)}>
          {forgottenRows.length === 0
            ? <EmptyState icon={Archive} title="没有已忘记的内容" />
            : <List label="已忘记的内容">{forgottenRows.map(renderRow)}</List>}
        </Drawer>
      )}
      {/* An inbox notice names a memory (`?record=`); the row scrolls itself
          into view, and the address is cleared so a reload does not re-scroll. */}
      {highlightId && !loading && <ClearHighlight onDone={() => {
        const next = new URLSearchParams(params);
        next.delete("record");
        setParams(next, { replace: true });
      }} />}
    </PageShell>
  );
}

function ClearHighlight({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2_000);
    return () => clearTimeout(timer);
  }, [onDone]);
  return null;
}
