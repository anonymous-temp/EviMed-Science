import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import { deleteStructuredMemory, updateStructuredMemory, webErrorMessage, type WebStructuredMemory } from "@/lib/apiClient";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged, archiveMemoryRecord, undoMemoryRecord } from "@/lib/memoryClient";
import { isInference, memoryExcerpt } from "@/lib/memoryText";
import { chatPath } from "@/lib/runLocation";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { ListRow } from "@/components/ui/ListRow";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { EditingRow, InferredMark, RowDetail, RowOrigin } from "./rowParts";

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
 * The conversation a memory came out of: the session its first evidence names.
 *
 * An evidence `sourceRef` is `sessions/<id>/messages/<n>`, which is also the
 * address the conversation opens at — so 「来源对话」 is a link back to the
 * place the memory was said, and not a claim the page cannot honour.
 */
export function memorySource(record: WebStructuredMemory): { sessionId: string; at: string | null } | null {
  for (const item of record.evidence) {
    const sessionId = /^sessions\/([^/]+)\//.exec(item.sourceRef ?? "")?.[1];
    if (sessionId) return { sessionId, at: item.observedAt ?? record.createdAt };
  }
  return null;
}

/**
 * One memory as one row: where it belongs on the left, the sentence on the
 * right, and 「推断」 after it when EviMed inferred it — the one annotation a
 * row keeps (principle 18). Nothing else is said about it: not how often it
 * was seen or used, not since when it holds (2026-09-23 plan §5.6).
 *
 * 编辑 and 忘记 appear on hover. Opening the row shows what it rests on — the
 * words it was said in, the versions it has had, the conversation it came
 * from; its 「⋯」 holds the same history, the undo of its last change, and 「不对」
 * on an inference. 忘记 archives, as a revision the toast takes back and 已忘记
 * 的内容 restores; 不对 deletes and stops the extractor inferring it again, so
 * it is the one that asks first. A record held for a medicine-safety check
 * says so and asks to be confirmed, and a sensitive one says what confirming
 * does before it does it.
 */
export function MemoryRecordRow({
  record,
  origin,
  highlighted = false,
  onChanged,
}: {
  record: WebStructuredMemory;
  /** The left column: 关于你, 做法, or the project's name. */
  origin: string;
  /** Named by an inbox notice (`?record=`): scrolled to, opened and marked. */
  highlighted?: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(record.summary || record.value);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(highlighted);
  const [confirmingSensitive, setConfirmingSensitive] = useState<null | { value?: string; status?: "active" }>(null);
  const [rejecting, setRejecting] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!highlighted) return;
    setOpen(true);
    anchor.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
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
    toast.success(next.status && !text ? "已确认" : "已保存");
  });
  const confirmOrSave = (next: { value?: string; status?: "active" }) => {
    // The truth, not a promise the code does not keep: a sensitive record is
    // never recalled, whatever its status.
    if (record.status === "pending" && record.sensitive) setConfirmingSensitive(next);
    else void save(next);
  };
  const forget = () => run(async () => {
    const archived = await archiveMemoryRecord(record.id, record.version);
    toast.success("已忘记", {
      action: {
        label: "撤销",
        onClick: () => void undoMemoryRecord(record.id, archived.version)
          .then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(failed(error))),
      },
    });
  });
  const restore = () => run(async () => {
    await updateStructuredMemory(record, { status: "active" });
    toast.success("已恢复");
  });
  const undo = () => run(async () => {
    const result = await undoMemoryRecord(record.id, record.version);
    toast.success(result.undone === "removed" ? "已撤销这条记忆" : "已撤销上次改动");
  });
  const reject = () => run(async () => {
    setRejecting(false);
    await deleteStructuredMemory(record.id);
    toast.success("已删除");
  });

  const forgotten = record.status === "archived";
  const pending = record.status === "pending";
  const inferred = isInference(record);
  const source = memorySource(record);
  const hasHistory = record.evidence.length > 0 || record.revisions.length > 0 || source != null;
  const opens = hasHistory && !forgotten;

  const dialogs = (
    <>
      {confirmingSensitive && createPortal(
        <ConfirmDialog
          title="确认这条敏感记忆？"
          body={`确认后它保留为已生效；出于隐私保护，敏感记忆不会被自动调取到后续研究中：${memoryExcerpt(confirmingSensitive.value || record.summary || record.value, 120)}`}
          confirmLabel="确认保留"
          tone="primary"
          onConfirm={() => { const next = confirmingSensitive; setConfirmingSensitive(null); void save(next); }}
          onCancel={() => setConfirmingSensitive(null)}
        />,
        document.body,
      )}
      {rejecting && createPortal(
        <ConfirmDialog
          title="这条推断不对？"
          body="删除这条推断，之后也不再推断出来；只想暂时不用，请选「忘记」。"
          confirmLabel="删除"
          onConfirm={() => void reject()}
          onCancel={() => setRejecting(false)}
        />,
        document.body,
      )}
    </>
  );

  if (editing) {
    return (
      <>
        <EditingRow
          origin={origin}
          label="编辑这条记忆"
          value={value}
          busy={busy}
          onChange={setValue}
          onCancel={() => setEditing(false)}
          onSave={() => confirmOrSave({ value, status: "active" })}
        />
        {dialogs}
      </>
    );
  }

  const menu: MenuEntry[] = forgotten ? [] : [
    ...(hasHistory ? [{ label: "历史版本", onSelect: () => setOpen(true) }] : []),
    ...(record.revisions.length > 0 ? [{ label: "撤销上次改动", onSelect: () => void undo() }] : []),
    ...(inferred ? [{ label: "不对", destructive: true, onSelect: () => setRejecting(true) }] : []),
  ];

  return (
    <>
      <ListRow
        className={highlighted ? "bg-accent-soft" : undefined}
        leading={<RowOrigin label={origin} />}
        title={(
          <span ref={anchor} data-record-id={record.id}>
            {memoryExcerpt(record.summary || record.value)}
            {inferred && <InferredMark />}
          </span>
        )}
        onOpen={opens ? () => setOpen((current) => !current) : undefined}
        expanded={opens ? open : undefined}
        muted={forgotten}
        meta={opens && open ? (
          <RowDetail>
            {record.evidence.slice(-3).reverse().map((evidence) => (
              <div key={evidence.fingerprint || `${evidence.sourceRef}-${evidence.observedAt}`}>
                <p className="text-ui text-text-2">“{evidence.quote}”</p>
                {evidence.observedAt && <p>{when(evidence.observedAt)}</p>}
              </div>
            ))}
            {[...record.revisions].reverse().slice(0, 5).map((revision) => (
              <p key={revision.version}>
                {[when(revision.changedAt), revision.by ? REVISION_BY[revision.by] : ""].filter(Boolean).join(" · ")}
                {revision.changedAt || revision.by ? "：" : ""}{memoryExcerpt(revision.summary || revision.value, 120)}
              </p>
            ))}
            {source && <Link to={chatPath(source.sessionId)} className="inline-block text-accent hover:underline">来源对话</Link>}
          </RowDetail>
        ) : undefined}
        trailing={pending ? (
          <>
            <Tag tone="safety">待确认（用药安全）</Tag>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => confirmOrSave({ status: "active" })}>确认</Button>
          </>
        ) : undefined}
        actions={forgotten ? (
          <IconButton icon={RotateCcw} label="恢复" size="sm" disabled={busy} onClick={() => void restore()} />
        ) : (
          <>
            <IconButton icon={Pencil} label="编辑" size="sm" disabled={busy} onClick={() => setEditing(true)} />
            <IconButton icon={Trash2} label="忘记" size="sm" destructive disabled={busy} onClick={() => void forget()} />
          </>
        )}
        menu={menu.length > 0 ? <Menu label="更多" items={menu} /> : undefined}
      />
      {dialogs}
    </>
  );
}
