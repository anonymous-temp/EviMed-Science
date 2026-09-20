import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Check, Pencil, Undo2, X } from "lucide-react";
import { deleteStructuredMemory, updateStructuredMemory, webErrorMessage, type WebMemoryUsage, type WebStructuredMemory } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged, archiveMemoryRecord, undoMemoryRecord } from "@/lib/memoryClient";
import { MEMORY_BASIS_LABELS, STATED_BASES, looksInjected, memoryExcerpt, memoryStrength, memoryUsage } from "@/lib/memoryText";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Textarea } from "@/components/ui/Input";

/** Who made a change, in the researcher's words. */
const REVISION_BY: Record<string, string> = {
  extraction: "从对话中学到",
  user: "你改的",
  system: "系统整理",
};

function when(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateTime(date, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function day(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateTime(date, { month: "long", day: "numeric" });
}

function failed(error: unknown) {
  return webErrorMessage(error, { fallback: "操作未完成，请重试。" });
}

/**
 * The conversation a memory came out of: the session its first evidence names.
 *
 * An evidence `sourceRef` is `sessions/<id>/messages/<n>`, which is also the
 * address the conversation opens at — so 「来自 9月12日《…》」 is a link back to
 * the place the memory was said, and not a claim the page cannot honour.
 */
export function memorySource(record: WebStructuredMemory): { sessionId: string; at: string | null } | null {
  for (const item of record.evidence) {
    const sessionId = /^sessions\/([^/]+)\//.exec(item.sourceRef ?? "")?.[1];
    if (sessionId) return { sessionId, at: item.observedAt ?? record.createdAt };
  }
  return null;
}

/**
 * One memory as a line of the list: the sentence in the researcher's own
 * language, where it came from, how established it is — counted, never a
 * percentage — how often it has actually been used, and the conversation it
 * was said in. Opened, the words it rests on and every version it has had.
 *
 * Three actions and no more (owner ruling 2026-09-20): 改 and 忘记 on every
 * row, and 不对 on one EviMed inferred. 忘记 archives, as a revision the toast
 * takes back; 不对 deletes, which is the one irreversible act here and the only
 * one that also stops the extractor inferring it again — so it is the only one
 * that asks first.
 */
export function MemoryRecordRow({
  record,
  highlighted = false,
  conversationTitle = "",
  usage,
  onChanged,
}: {
  record: WebStructuredMemory;
  highlighted?: boolean;
  /** What the conversation it came from was about, when the page knows. */
  conversationTitle?: string;
  usage?: WebMemoryUsage;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(record.summary || record.value);
  const [busy, setBusy] = useState(false);
  const [confirmingSensitive, setConfirmingSensitive] = useState<null | { value?: string }>(null);
  const [rejecting, setRejecting] = useState(false);
  const row = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (highlighted) row.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  useEffect(() => { if (!editing) setValue(record.summary || record.value); }, [record.summary, record.value, editing]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
      announceMemoryChanged();
      onChanged();
    } catch (error) {
      toast.error(failed(error));
    } finally {
      setBusy(false);
    }
  };

  const save = (next: { value?: string; status?: "active" }) => run(async () => {
    const text = next.value?.trim();
    await updateStructuredMemory(record, {
      ...(text ? { value: text, summary: text } : {}),
      ...(next.status ? { status: next.status } : {}),
    });
    setEditing(false);
    toast.success(next.status && !text ? "已确认这条记忆" : "已改好，之后的对话按新的来");
  });
  const confirmOrSave = (next: { value?: string; status?: "active" }) => {
    // The truth, not a promise the code does not keep: a sensitive record is
    // never recalled, whatever its status.
    if (record.status === "pending" && record.sensitive) setConfirmingSensitive(next);
    else void save(next);
  };
  const forget = () => run(async () => {
    const archived = await archiveMemoryRecord(record.id, record.version);
    toast.success("好的，之后不再提这条", {
      action: { label: "撤销", onClick: () => void undoMemoryRecord(record.id, archived.version).then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(failed(error))) },
    });
  });
  const restore = () => run(async () => {
    await updateStructuredMemory(record, { status: "active" });
    toast.success("已恢复这条记忆");
  });
  const undo = () => run(async () => {
    const result = await undoMemoryRecord(record.id, record.version);
    toast.success(result.undone === "removed" ? "已撤销这条记忆" : "已撤销上次改动");
  });
  const reject = () => run(async () => {
    setRejecting(false);
    await deleteStructuredMemory(record.id);
    toast.success("已记下这条是错的，之后不会再推断出来");
  });

  const text = memoryExcerpt(record.summary || record.value);
  const expires = record.expiresAt ? when(record.expiresAt) : "";
  const inferred = !STATED_BASES.has(record.provenance?.basis ?? "inferred");
  const source = memorySource(record);
  const forgotten = record.status === "archived";
  return (
    <li
      ref={row}
      className={cn("px-4 py-3", highlighted && "bg-accent-soft")}
      data-record-id={record.id}
    >
      {editing ? (
        <div>
          <Textarea value={value} onChange={(event) => setValue(event.target.value)} aria-label="改这条记忆" rows={3} className="bg-bg text-ui" />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X size={13} aria-hidden="true" />取消</Button>
            <Button size="sm" loading={busy} disabled={!value.trim()} onClick={() => confirmOrSave({ value, status: "active" })}>保存</Button>
          </div>
        </div>
      ) : (
        <p className={cn("text-ui", forgotten ? "text-muted line-through decoration-muted" : "text-text")}>{text}</p>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
        {record.provenance && (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-text">{MEMORY_BASIS_LABELS[record.provenance.basis]}</span>
        )}
        <span>{memoryStrength(record.provenance, record.evidenceCount)}</span>
        {source && (
          <Link to={`/app/chat/${encodeURIComponent(source.sessionId)}`} className="underline underline-offset-2 hover:text-text">
            来自 {day(source.at)}{conversationTitle ? `《${memoryExcerpt(conversationTitle, 24)}》` : "的对话"}
          </Link>
        )}
        <span>{memoryUsage(usage, day)}</span>
        {record.status === "pending" && <span className="text-warn-strong">涉及用药安全，等你看过</span>}
        {record.sensitive && <span>敏感 · 不会被自动调取</span>}
        {expires && record.status === "active" && <span>短期 · {expires} 前有效</span>}
        {looksInjected(record.summary || record.value) && <span className="text-warn-strong">疑似任务题面，非你的陈述</span>}
      </p>
      {(record.evidence.length > 0 || record.revisions.length > 0) && (
        <Disclosure summary="依据与改动" className="mt-2" summaryClassName="text-caption">
          <div className="space-y-2 border-l border-border pl-3 text-caption text-muted">
            {record.evidence.slice(-3).reverse().map((evidence) => (
              <div key={evidence.fingerprint || `${evidence.sourceRef}-${evidence.observedAt}`}>
                <p className="text-text">“{evidence.quote}”</p>
                <p className="mt-0.5">{evidence.observedAt ? when(evidence.observedAt) : ""}</p>
              </div>
            ))}
            {[...record.revisions].reverse().slice(0, 5).map((revision) => (
              <p key={revision.version}>
                第 {revision.version} 版：{memoryExcerpt(revision.summary || revision.value, 120)}
                {revision.by ? ` · ${REVISION_BY[revision.by] ?? ""}` : ""}{revision.changedAt ? ` · ${when(revision.changedAt)}` : ""}
              </p>
            ))}
          </div>
        </Disclosure>
      )}
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-2">
          {record.status === "pending" && (
            <Button size="sm" variant="ghost" loading={busy} disabled={busy} onClick={() => confirmOrSave({ status: "active" })}>
              <Check size={13} aria-hidden="true" />是这样
            </Button>
          )}
          {forgotten ? (
            <Button size="sm" variant="ghost" loading={busy} disabled={busy} onClick={() => void restore()}>
              <Undo2 size={13} aria-hidden="true" />恢复
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}><Pencil size={13} aria-hidden="true" />改</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void forget()}>忘记</Button>
              {inferred && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(true)}>不对</Button>
              )}
              {record.revisions.length > 0 && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}><Undo2 size={13} aria-hidden="true" />撤销上次改动</Button>
              )}
            </>
          )}
        </div>
      )}
      {confirmingSensitive && (
        <ConfirmDialog
          title="确认这条敏感记忆？"
          body={`确认后它保留为已生效，你可以随时查看、修改或删除；但出于隐私保护，敏感记忆不会被自动调取到后续研究中：${memoryExcerpt(confirmingSensitive.value || record.summary || record.value, 120)}`}
          confirmLabel="确认保留"
          tone="primary"
          onConfirm={() => { const next = confirmingSensitive; setConfirmingSensitive(null); void save(next); }}
          onCancel={() => setConfirmingSensitive(null)}
        />
      )}
      {rejecting && (
        <ConfirmDialog
          title="这条推断不对？"
          body="这条会被删除，它的依据和改动记录一并删除，之后的研究不会再用它。EviMed 也不会再凭推断把它记回来，只有你以后亲口再说时才会重新记下。产生它的对话和报告不受影响。想只是先不用，选「忘记」——那一步随时可以恢复。"
          confirmLabel="删除"
          onConfirm={() => void reject()}
          onCancel={() => setRejecting(false)}
        />
      )}
    </li>
  );
}
