import { useEffect, useState } from "react";
import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import { announceMemoryChanged, retireCapsuleEntry, undoCapsuleEntry, type OwnCapsuleEntry } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { productErrorMessage, updateCapsuleEntry } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { IconButton } from "@/components/ui/IconButton";
import { ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { EditingRow, InferredMark, RowOrigin } from "./rowParts";

/**
 * One entry of the researcher's own capsule, as a memory row like any other:
 * 编辑 and 忘记 on hover, the undo of its last change in 「⋯」, and 「推断」
 * when the researcher did not write it themselves (principle 18: an entry
 * noted from a conversation or a document is the platform's wording). Its kind
 * and its version number are not said (2026-09-23 inventory §1.7).
 *
 * 忘记 retires it, as a revision the toast takes back; a retired entry is
 * under 已忘记的内容, with 恢复.
 */
export function CapsuleEntryRow({ entry, origin, onChanged }: {
  entry: OwnCapsuleEntry;
  /** The left column: 关于你, 做法, or the project's name. */
  origin: string;
  onChanged: () => void;
}) {
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
    toast.success("已保存");
  });
  const forget = () => run(async () => {
    const retired = await retireCapsuleEntry(capsuleId, entry.id, entry.revision);
    toast.success("已忘记", {
      action: {
        label: "撤销",
        onClick: () => void undoCapsuleEntry(capsuleId, retired)
          .then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(productErrorMessage(error))),
      },
    });
  });
  const undo = (done: string) => run(async () => {
    const result = await undoCapsuleEntry(capsuleId, entry);
    toast.success(result.undone === "removed" ? "已撤销这一条" : done);
  });

  const retired = entry.payload.status === "retired";

  if (editing) {
    return (
      <EditingRow
        origin={origin}
        label="编辑这一条"
        value={value}
        busy={busy}
        maxLength={20000}
        onChange={setValue}
        onCancel={() => setEditing(false)}
        onSave={() => void save()}
      />
    );
  }

  return (
    <ListRow
      leading={<RowOrigin label={origin} />}
      title={<>{memoryExcerpt(entry.payload.content)}{entry.payload.origin !== "explicit" && <InferredMark />}</>}
      muted={retired}
      actions={retired ? (
        <IconButton icon={RotateCcw} label="恢复" size="sm" disabled={busy} onClick={() => void undo("已恢复")} />
      ) : (
        <>
          <IconButton icon={Pencil} label="编辑" size="sm" disabled={busy} onClick={() => setEditing(true)} />
          <IconButton icon={Trash2} label="忘记" size="sm" destructive disabled={busy} onClick={() => void forget()} />
        </>
      )}
      menu={!retired && entry.revision > 1
        ? <Menu label="更多" items={[{ label: "撤销上次改动", disabled: busy, onSelect: () => void undo("已撤销上次改动") }]} />
        : undefined}
    />
  );
}
