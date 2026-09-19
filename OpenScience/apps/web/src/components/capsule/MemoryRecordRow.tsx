import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Trash2, Undo2, X } from "lucide-react";
import { deleteStructuredMemory, updateStructuredMemory, webErrorMessage, type WebStructuredMemory } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged, archiveMemoryRecord, undoMemoryRecord } from "@/lib/memoryClient";
import { MEMORY_BASIS_LABELS, evidenceSourceLabel, looksInjected, memoryExcerpt, memoryStrength } from "@/lib/memoryText";
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

function failed(error: unknown) {
  return webErrorMessage(error, { fallback: "操作未完成，请重试。" });
}

/**
 * One memory as a line of its topic: the sentence, where it came from and how
 * established it is — counted, never a percentage — and, opened, the words it
 * rests on and every version it has had.
 *
 * Nothing here asks before acting except what cannot be undone (删除) and the
 * one checkpoint the owner kept: a memory naming a clinical-safety rule waits
 * as 「等你看过」 (plan §3.3 #1). 「不要再提」 archives, as a revision the toast
 * can take back.
 */
export function MemoryRecordRow({
  record,
  highlighted = false,
  onChanged,
}: {
  record: WebStructuredMemory;
  highlighted?: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(record.summary || record.value);
  const [busy, setBusy] = useState(false);
  const [confirmingSensitive, setConfirmingSensitive] = useState<null | { value?: string }>(null);
  const [deleting, setDeleting] = useState(false);
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
  const archive = () => run(async () => {
    const archived = await archiveMemoryRecord(record.id, record.version);
    toast.success("好的，之后不再提这条", {
      action: { label: "撤销", onClick: () => void undoMemoryRecord(record.id, archived.version).then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(failed(error))) },
    });
  });
  const undo = () => run(async () => {
    const result = await undoMemoryRecord(record.id, record.version);
    toast.success(result.undone === "removed" ? "已撤销这条记忆" : "已撤销上次改动");
  });
  const remove = () => run(async () => {
    setDeleting(false);
    await deleteStructuredMemory(record.id);
    toast.success("已删除这条记忆");
  });

  const text = memoryExcerpt(record.summary || record.value);
  const expires = record.expiresAt ? when(record.expiresAt) : "";
  return (
    <li
      ref={row}
      className={cn("px-4 py-3", highlighted && "bg-accent-soft")}
      data-record-id={record.id}
    >
      {editing ? (
        <div>
          <Textarea value={value} onChange={(event) => setValue(event.target.value)} aria-label="修正这条记忆" rows={3} className="bg-bg text-ui" />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X size={13} aria-hidden="true" />取消</Button>
            <Button size="sm" loading={busy} disabled={!value.trim()} onClick={() => confirmOrSave({ value, status: "active" })}>保存修正</Button>
          </div>
        </div>
      ) : (
        <p className="text-ui text-text">{text}</p>
      )}
      <p className="mt-1 flex flex-wrap gap-x-2 text-caption text-muted">
        {record.provenance && <span className="text-text">{MEMORY_BASIS_LABELS[record.provenance.basis]}</span>}
        <span>{memoryStrength(record.provenance, record.evidenceCount)}</span>
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
                <p className="mt-0.5">{evidenceSourceLabel(evidence.sourceType)}{evidence.observedAt ? ` · ${when(evidence.observedAt)}` : ""}</p>
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
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}><Pencil size={13} aria-hidden="true" />修正</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void archive()}>{record.status === "pending" ? "不是这样" : "不要再提"}</Button>
          {record.revisions.length > 0 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}><Undo2 size={13} aria-hidden="true" />撤销上次改动</Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={13} aria-hidden="true" />删除</Button>
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
      {deleting && (
        <ConfirmDialog
          title="删除这条记忆？"
          body="删除这条记忆及其依据与修订记录，之后的对话不会再用它，检索索引中的副本随后移除。不会删除产生它的对话与运行记录；EviMed 不会再凭推断把它记回来，只有你以后亲口再说时才会重新记下。"
          confirmLabel="删除"
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(false)}
        />
      )}
    </li>
  );
}
