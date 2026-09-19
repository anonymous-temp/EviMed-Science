import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { fetchMemoryProfile, type WebStructuredMemory } from "@/lib/apiClient";
import { fetchMyCapsule, type OwnCapsuleEntry } from "@/lib/memoryClient";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { CapsuleEntryRow } from "./CapsuleEntryRow";
import { MemoryRecordRow } from "./MemoryRecordRow";
import { SectionList, SectionShell } from "./SectionShell";
import { useCapsuleData } from "./useCapsuleData";

/** The researcher's own words and confirmations, as opposed to what was observed. */
const STATED = new Set(["stated", "confirmed", "edited"]);

/** Topic files: what EviMed understands about the person, one kind each. */
const RECORD_TOPICS = [
  { kind: "profile", title: "你是谁", empty: "还不知道你的身份和研究方向。在对话里说一句「我是…，主要做…」就会记下。" },
  { kind: "preference", title: "你偏好的方式", empty: "还没有记下你的偏好。" },
  { kind: "behavior", title: "你的工作习惯", empty: "还没有观察到稳定的工作习惯。" },
  { kind: "correction", title: "你纠正过的", empty: "你还没有纠正过 EviMed。" },
] as const;

/** What the researcher's own capsule says about them, by entry kind. */
const ENTRY_TOPICS = [
  { kinds: ["preference"], title: "胶囊里的偏好" },
  { kinds: ["writing_style"], title: "写作风格" },
  { kinds: ["expertise"], title: "背景知识" },
] as const;

/** The kinds that belong to the project dossier rather than to the person. */
const PROJECT_KINDS = new Set(["project_fact", "analysis", "decision", "follow_up"]);

type Source = "all" | "stated" | "observed";

/**
 * 「对你的理解」: what EviMed understands about the researcher, as topic files
 * rather than a board of cards (proposal §4.4) — one sentence a line, the
 * evidence and every version one click away, and a filter by where it came
 * from. Their own notes close the page.
 */
export function UnderstandingSection({ notes }: { notes?: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const highlightId = params.get("record");
  const [source, setSource] = useState<Source>("all");
  const { data, failed, reload } = useCapsuleData(async () => {
    const [profile, mine] = await Promise.all([fetchMemoryProfile(), fetchMyCapsule().catch(() => null)]);
    return { profile, mine };
  });

  const records = useMemo(() => (data?.profile.records ?? [])
    .filter((record) => record.scope === "user" && ["active", "pending"].includes(record.status) && record.kind !== "run_summary"), [data]);
  const shown = (record: WebStructuredMemory) => source === "all"
    || (source === "stated") === STATED.has(record.provenance?.basis ?? "inferred");
  const entries = (data?.mine?.entries ?? []).filter((entry: OwnCapsuleEntry) => source === "all"
    || (source === "stated") === (entry.payload.origin === "explicit"));
  // An inbox notice can point at a project fact; say where it is instead of
  // landing on a page that does not show it.
  const elsewhere = highlightId
    ? data?.profile.records.find((record) => record.id === highlightId && (record.scope === "project" || PROJECT_KINDS.has(record.kind)))
    : undefined;

  return (
    <SectionShell
      intro="EviMed 对你的理解。你说过、确认过的和它在任务中观察到的分开标注；每条都能看到依据和改动，改一句或不再提都会立刻生效，并且可以撤销。"
      loading={data === null}
      failed={failed}
      onRetry={reload}
    >
      {elsewhere && (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-ui text-text">
          <span>你要找的这条在「项目档案」里。</span>
          <Button variant="ghost" size="sm" onClick={() => { const next = new URLSearchParams(params); next.set("tab", "project"); setParams(next, { replace: true }); }}>
            去项目档案
          </Button>
        </div>
      )}
      <SegmentedControl
        aria-label="按来源筛选"
        value={source}
        onChange={setSource}
        options={[{ value: "all", label: "全部" }, { value: "stated", label: "你说的" }, { value: "observed", label: "观察到的" }]}
      />
      {RECORD_TOPICS.map((topic) => {
        const rows = records.filter((record) => record.kind === topic.kind && shown(record));
        return (
          <SectionList key={topic.kind} title={topic.title} count={rows.length} empty={source === "all" ? topic.empty : "这一类里没有符合筛选的。"}>
            {rows.map((record) => (
              <MemoryRecordRow key={record.id} record={record} highlighted={record.id === highlightId} onChanged={reload} />
            ))}
          </SectionList>
        );
      })}
      {ENTRY_TOPICS.map((topic) => {
        const rows = entries.filter((entry) => (topic.kinds as readonly string[]).includes(entry.payload.factKind));
        if (rows.length === 0) return null;
        return (
          <SectionList key={topic.title} title={topic.title} count={rows.length} empty="">
            {rows.map((entry) => <CapsuleEntryRow key={entry.id} entry={entry} onChanged={reload} />)}
          </SectionList>
        );
      })}
      {notes && (
        <section aria-label="你写下的笔记">
          <h3 className="text-body font-semibold text-text">你写下的笔记</h3>
          {notes}
        </section>
      )}
    </SectionShell>
  );
}
