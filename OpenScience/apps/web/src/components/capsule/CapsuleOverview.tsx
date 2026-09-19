import { useState } from "react";
import { useSearchParams } from "react-router";
import { fetchMemoryProfile, updateStructuredMemory, webErrorMessage, type WebStructuredMemory } from "@/lib/apiClient";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged, archiveMemoryRecord, fetchMyCapsule, undoMemoryRecord } from "@/lib/memoryClient";
import { MEMORY_BASIS_LABELS, memoryExcerpt, memoryStrength } from "@/lib/memoryText";
import { fetchLibrary } from "@/lib/libraryClient";
import { listMethods } from "@/lib/methodsClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { MemoryControls } from "@/components/memory/MemoryControls";
import { SectionShell } from "./SectionShell";
import { useCapsuleData } from "./useCapsuleData";

/** The order a reader meets the person in: who, how they work, what they want, what they corrected. */
const PROSE_ORDER = ["profile", "behavior", "preference", "correction"] as const;
/** At most this many sentences: the page is a portrait, not a dump. */
const PROSE_LIMIT = 12;
const STATED = new Set(["stated", "confirmed", "edited"]);
const PROJECT_KINDS = new Set(["project_fact", "analysis", "decision", "follow_up"]);

/** A sentence ends with its own stop, whatever the record's text ended with. */
function sentence(record: WebStructuredMemory) {
  const text = memoryExcerpt(record.summary || record.value, 160).replace(/[。.;；,，\s]+$/u, "");
  return `${text}。`;
}

export interface OverviewCounts {
  library?: number | null;
}

/**
 * 「总览」: one page of prose in place of fifty-two cards (proposal §4.3) — the
 * portrait EviMed works from, each sentence with where it came from and the way
 * to change it or drop it; how much the capsule holds; what it still lacks, as
 * a list rather than a percentage; and the researcher's switches.
 *
 * The prose is assembled from the stored sentences as they are. No model
 * rewrites them for this page: a portrait that paraphrased would be a second
 * version of the person nobody can trace.
 */
export function CapsuleOverview({ library: given }: OverviewCounts) {
  const [, setParams] = useSearchParams();
  const { data, failed, reload } = useCapsuleData(async () => {
    const [profile, mine, methods, library] = await Promise.all([
      fetchMemoryProfile(),
      fetchMyCapsule().catch(() => null),
      listMethods().catch(() => null),
      // A deployment without the library answers null; a failure is unknown.
      given === undefined ? fetchLibrary().catch(() => null) : Promise.resolve(null),
    ]);
    return { profile, mine, methods, library };
  });
  const library = given !== undefined ? given : data?.library ? data.library.length : null;
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const records = (data?.profile.records ?? []).filter((record) => record.status === "active" && !record.sensitive && record.kind !== "run_summary");
  const portrait = PROSE_ORDER.flatMap((kind) => records.filter((record) => record.scope === "user" && record.kind === kind)).slice(0, PROSE_LIMIT);
  const understanding = records.filter((record) => record.scope === "user" && !PROJECT_KINDS.has(record.kind));
  const stated = understanding.filter((record) => STATED.has(record.provenance?.basis ?? "inferred")).length;
  const dossier = records.filter((record) => PROJECT_KINDS.has(record.kind)).length;
  const methods = data?.methods?.items ?? [];
  const inForce = methods.filter((method) => method.status === "approved").length;
  const onTrial = methods.filter((method) => method.status === "candidate").length;
  const written = (data?.mine?.entries ?? []).filter((entry) => entry.payload.factKind === "method_preference").length;
  const lastLearned = methods.map((method) => method.updatedAt).filter(Boolean).sort().at(-1) ?? null;
  const writingStyle = (data?.mine?.entries ?? []).some((entry) => entry.payload.factKind === "writing_style");

  const missing: { text: string; tab?: string }[] = [];
  if (!understanding.some((record) => record.kind === "profile")) missing.push({ text: "还不知道你的身份和研究方向：在对话里说一句「我是…，主要做…」。" });
  if (!understanding.some((record) => record.kind === "preference")) missing.push({ text: "还不知道你偏好的回答方式：对回答不满意时直接说，EviMed 会记下。" });
  if (written + methods.length === 0) missing.push({ text: "还没有方法：写一条你常用的做法，或者完成几次同类任务后让 EviMed 自己学。", tab: "methods" });
  if (!writingStyle) missing.push({ text: "还没有你的写作风格：在「方法」里写下你的写作要求，或上传几篇代表作到资料。", tab: "methods" });
  if (library === 0) missing.push({ text: "资料库还是空的：上传你的代表作、方案或 SOP。", tab: "library" });

  const act = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    try {
      await operation();
      announceMemoryChanged();
      reload();
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "操作未完成，请重试。" }));
    } finally {
      setBusy(null);
    }
  };
  const save = (record: WebStructuredMemory) => act(record.id, async () => {
    const text = value.trim();
    await updateStructuredMemory(record, { value: text, summary: text });
    setEditing(null);
    toast.success("已改好，之后的对话按新的来");
  });
  const drop = (record: WebStructuredMemory) => act(record.id, async () => {
    const archived = await archiveMemoryRecord(record.id, record.version);
    toast.success("好的，之后不再提这条", {
      action: { label: "撤销", onClick: () => void undoMemoryRecord(record.id, archived.version).then(() => { announceMemoryChanged(); reload(); }) },
    });
  });
  const open = (tab: string) => setParams((current) => { const next = new URLSearchParams(current); next.set("tab", tab); return next; }, { replace: true });

  return (
    <SectionShell
      intro="EviMed 照着这一页来理解你、为你做研究。它随每次任务自动更新，不需要你确认；哪句不对，改一句或让它不再提，立刻生效，也都能撤销。"
      loading={data === null}
      failed={failed}
      onRetry={reload}
    >
      <section aria-labelledby="capsule-portrait" className="rounded-card border border-border bg-surface p-5">
        <h2 id="capsule-portrait" className="font-serif text-title font-semibold text-text">EviMed 眼中的你</h2>
        {portrait.length === 0 ? (
          <p className="mt-3 text-body text-muted">EviMed 还不了解你。和它多聊几次、在对话里说说你的身份和习惯，这里就会写出来。</p>
        ) : (
          <>
            <p className="mt-3 max-w-content text-body text-text">
              {portrait.map((record, index) => (
                <span key={record.id}>{sentence(record)}<sup className="text-caption text-muted">{index + 1}</sup></span>
              ))}
            </p>
            <ol className="mt-4 space-y-2 border-t border-border pt-3">
              {portrait.map((record, index) => (
                <li key={record.id} className="text-caption text-muted">
                  {editing === record.id ? (
                    <div className="space-y-2">
                      <Textarea value={value} onChange={(event) => setValue(event.target.value)} aria-label="改一句" rows={2} className="bg-bg text-ui" />
                      <div className="flex gap-2">
                        <Button size="sm" loading={busy === record.id} disabled={!value.trim()} onClick={() => void save(record)}>保存</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        {index + 1}. <span className="text-text">{record.provenance ? MEMORY_BASIS_LABELS[record.provenance.basis] : ""}</span>
                        {record.provenance ? ` · ${memoryStrength(record.provenance, record.evidenceCount)}` : ""}
                      </span>
                      <button type="button" className="rounded px-1 text-muted hover:text-text" disabled={busy !== null}
                        onClick={() => { setEditing(record.id); setValue(record.summary || record.value); }}>改一句</button>
                      <button type="button" className="rounded px-1 text-muted hover:text-text" disabled={busy !== null}
                        onClick={() => void drop(record)}>不要再提这条</button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-card border border-border bg-surface p-4">
          <dt className="text-caption text-muted">对你的理解</dt>
          <dd className="mt-1 text-ui text-text"><span className="tabular-nums">{understanding.length}</span> 条</dd>
          <dd className="mt-0.5 text-caption text-muted">你说的 {stated} · 观察到 {understanding.length - stated}</dd>
        </div>
        <div className="rounded-card border border-border bg-surface p-4">
          <dt className="text-caption text-muted">项目档案</dt>
          <dd className="mt-1 text-ui text-text"><span className="tabular-nums">{dossier}</span> 条</dd>
        </div>
        <div className="rounded-card border border-border bg-surface p-4">
          <dt className="text-caption text-muted">方法</dt>
          <dd className="mt-1 text-ui text-text"><span className="tabular-nums">{written + inForce + onTrial}</span> 条</dd>
          <dd className="mt-0.5 text-caption text-muted">你写的 {written} · 在用 {inForce} · 评测中 {onTrial}</dd>
          {lastLearned && <dd className="mt-0.5 text-caption text-muted">最近一次学习 {formatDateTime(lastLearned, { month: "short", day: "numeric" })}</dd>}
        </div>
        <div className="rounded-card border border-border bg-surface p-4">
          <dt className="text-caption text-muted">资料</dt>
          <dd className="mt-1 text-ui text-text">{library == null ? "—" : <><span className="tabular-nums">{library}</span> 份</>}</dd>
        </div>
      </dl>

      {missing.length > 0 && (
        <section aria-labelledby="capsule-missing">
          <h3 id="capsule-missing" className="text-body font-semibold text-text">还缺</h3>
          <ul className="mt-2 space-y-2">
            {missing.map((item) => (
              <li key={item.text} className="flex flex-wrap items-center gap-2 text-ui text-text">
                <span>{item.text}</span>
                {item.tab && <Button size="sm" variant="ghost" onClick={() => open(item.tab!)}>去看看</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <MemoryControls onReset={reload} />
    </SectionShell>
  );
}
