import { useEffect, useState } from "react";
import { Pencil, Undo2, X } from "lucide-react";
import { capsuleEntryLabel } from "@/lib/capsuleText";
import { announceMemoryChanged, retireCapsuleEntry, undoCapsuleEntry, type OwnCapsuleEntry } from "@/lib/memoryClient";
import { productErrorMessage, updateCapsuleEntry } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";

/** Where a capsule entry came from, in the researcher's words (principle 18:
 *  the assistant's wording is never 「你写的」). */
export function capsuleEntryOrigin(entry: OwnCapsuleEntry): string {
  if (entry.payload.origin === "explicit") return "你写的";
  if (entry.payload.provenance.some((item) => item.type === "source")) return "来自资料";
  return "对话中记下";
}

/**
 * One entry of the researcher's own capsule: revise it, stop it, or take the
 * last change back — each a revision, none asking first.
 */
export function CapsuleEntryRow({ entry, onChanged }: { entry: OwnCapsuleEntry; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.payload.content);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setValue(entry.payload.content); }, [entry.payload.content, editing]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
      announceMemoryChanged();
      onChanged();
    } catch (error) {
      toast.error(productErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const capsuleId = entry.payload.capsuleId;
  const save = () => run(async () => {
    await updateCapsuleEntry(capsuleId, entry.id, { content: value.trim(), expectedRevision: entry.revision });
    setEditing(false);
    toast.success("已改好，之后的对话按新的来");
  });
  const retire = () => run(async () => {
    const retired = await retireCapsuleEntry(capsuleId, entry.id, entry.revision);
    toast.success("已停用这一条", {
      action: { label: "撤销", onClick: () => void undoCapsuleEntry(capsuleId, retired).then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(productErrorMessage(error))) },
    });
  });
  const undo = () => run(async () => {
    const result = await undoCapsuleEntry(capsuleId, entry);
    toast.success(result.undone === "removed" ? "已撤销这一条" : "已撤销上次改动");
  });

  return (
    <li className="px-4 py-3">
      {editing ? (
        <div>
          <Textarea value={value} onChange={(event) => setValue(event.target.value)} aria-label="修订这一条" rows={3} className="bg-bg text-ui" maxLength={20000} />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X size={16} aria-hidden="true" />取消</Button>
            <Button size="sm" loading={busy} disabled={!value.trim()} onClick={() => void save()}>保存修订</Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-ui text-text">{entry.payload.content}</p>
      )}
      <p className="mt-1 flex flex-wrap gap-x-2 text-caption text-muted">
        <span className="text-text">{capsuleEntryOrigin(entry)}</span>
        <span>{capsuleEntryLabel(entry.payload.factKind)}</span>
        {entry.revision > 1 && <span>第 {entry.revision} 版</span>}
      </p>
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}><Pencil size={16} aria-hidden="true" />修订</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retire()}>停用</Button>
          {entry.revision > 1 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}><Undo2 size={16} aria-hidden="true" />撤销上次改动</Button>
          )}
        </div>
      )}
    </li>
  );
}
