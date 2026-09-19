import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { fetchMemoryProfile, getWebProjectId, type WebStructuredMemory } from "@/lib/apiClient";
import { formatDateTime } from "@/lib/format";
import { fetchMyCapsule } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { Disclosure } from "@/components/ui/Disclosure";
import { CapsuleEntryRow } from "./CapsuleEntryRow";
import { MemoryRecordRow } from "./MemoryRecordRow";
import { SectionList, SectionShell } from "./SectionShell";
import { useCapsuleData } from "./useCapsuleData";

/** What the project's work produced, one kind each (proposal §4.1: the
 *  products of tasks are the project's record, not "understanding you"). */
const DOSSIER_TOPICS = [
  { kind: "project_fact", title: "项目事实", empty: "还没有记下这个项目的事实。任务中确认的数据口径、样本和条件会记在这里。" },
  { kind: "analysis", title: "分析口径", empty: "还没有记下分析口径。" },
  { kind: "decision", title: "已定的决策", empty: "还没有记下已定的决策。" },
  { kind: "follow_up", title: "待跟进", empty: "没有待跟进的事项。" },
] as const;

const PROJECT_KINDS = new Set<string>(DOSSIER_TOPICS.map((topic) => topic.kind));

function day(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatDateTime(date, { month: "short", day: "numeric" });
}

/**
 * 「项目档案」: this project's facts, analyses, decisions and follow-ups, each
 * with where it came from; what the project's runs wrote into the capsule; and
 * 「曾经如此」 — a fact that held until another replaced it, kept in view
 * instead of vanishing when it changed.
 */
export function ProjectDossierSection() {
  const [params] = useSearchParams();
  const highlightId = params.get("record");
  const projectId = getWebProjectId();
  const { data, failed, reload } = useCapsuleData(async () => {
    const [profile, mine] = await Promise.all([fetchMemoryProfile(), fetchMyCapsule().catch(() => null)]);
    return { profile, mine };
  });

  const records = useMemo(() => (data?.profile.records ?? [])
    .filter((record) => PROJECT_KINDS.has(record.kind) && (record.scope === "project" ? record.scopeId === projectId : true)), [data, projectId]);
  const current = records.filter((record) => ["active", "pending"].includes(record.status));
  const byId = new Map((data?.profile.records ?? []).map((record) => [record.id, record]));
  const wasTrue = records.filter((record) => record.status === "superseded");
  const notes = (data?.mine?.entries ?? [])
    .filter((entry) => ["project_fact", "correction"].includes(entry.payload.factKind) && (entry.projectId ?? null) === projectId);

  const replacement = (record: WebStructuredMemory) => {
    const next = record.supersededBy ? byId.get(record.supersededBy) : undefined;
    return next ? memoryExcerpt(next.summary || next.value, 120) : "";
  };

  return (
    <SectionShell
      intro="这个项目的档案：任务中得出的事实、分析口径、决策和待跟进事项，每条都带出处，只在本项目中被引用。被新结论取代的内容留在「曾经如此」里。"
      loading={data === null}
      failed={failed}
      onRetry={reload}
    >
      {DOSSIER_TOPICS.map((topic) => {
        const rows = current.filter((record) => record.kind === topic.kind);
        return (
          <SectionList key={topic.kind} title={topic.title} count={rows.length} empty={topic.empty}>
            {rows.map((record) => (
              <MemoryRecordRow key={record.id} record={record} highlighted={record.id === highlightId} onChanged={reload} />
            ))}
          </SectionList>
        );
      })}
      {notes.length > 0 && (
        <SectionList title="任务中记下的项目笔记" count={notes.length} empty="">
          {notes.map((entry) => <CapsuleEntryRow key={entry.id} entry={entry} onChanged={reload} />)}
        </SectionList>
      )}
      {wasTrue.length > 0 && (
        <Disclosure summary={`曾经如此（${wasTrue.length}）`} summaryClassName="text-body font-semibold text-text">
          <ul className="divide-y divide-border rounded-card border border-border bg-surface">
            {wasTrue.map((record) => (
              <li key={record.id} className="px-4 py-3" data-record-id={record.id}>
                <p className="text-ui text-muted line-through decoration-muted">{memoryExcerpt(record.summary || record.value, 200)}</p>
                <p className="mt-1 text-caption text-muted">
                  曾经如此{record.invalidSince ? ` · ${day(record.invalidSince)} 起不再成立` : ""}
                  {replacement(record) ? ` · 现在是「${replacement(record)}」` : ""}
                </p>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </SectionShell>
  );
}
