import { useEffect, useRef, useState } from "react";
import { deleteStructuredMemory, updateStructuredMemory, webErrorMessage, type WebMemoryCaveat, type WebStructuredMemory } from "@/lib/apiClient";
import { formatDateTime, formatDay } from "@/lib/format";
import { kindTitle } from "@/lib/memoryGroups";
import {
  announceMemoryChanged, archiveMemoryRecord, retireCapsuleEntry, settleMemoryConflict, undoCapsuleEntry, undoMemoryRecord, type OwnCapsuleEntry,
} from "@/lib/memoryClient";
import { memoryExcerpt, memoryOrigin } from "@/lib/memoryText";
import { productErrorMessage, updateCapsuleEntry } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { Textarea } from "@/components/ui/Input";
import { ConversationLink } from "./ConversationLink";
import { DrawerSection } from "./DrawerSection";
import { heldFrom, type FactItem } from "./memoryItems";

/** Who made a change, in the researcher's words. */
const REVISION_BY: Record<string, string> = {
  extraction: "从对话中学到",
  user: "你改的",
  system: "系统整理",
};

/** Why a memory in force is uncertain, as a few small words. 「有冲突」 comes first, as it does in the control plane. */
const CAVEAT_BADGE: Record<WebMemoryCaveat, string> = {
  conflict: "有冲突",
  source_retracted: "来源已撤回",
  source_expired: "来源已过期",
  source_changed: "来源已更改",
  not_yet_valid: "尚未生效",
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
 * address the conversation opens at — so 「来源对话」 is a link back to the place
 * the memory was said, and not a claim the page cannot honour.
 */
export function memorySource(record: WebStructuredMemory): { sessionId: string; at: string | null } | null {
  for (const item of record.evidence) {
    const sessionId = /^sessions\/([^/]+)\//.exec(item.sourceRef ?? "")?.[1];
    if (sessionId) return { sessionId, at: item.observedAt ?? record.createdAt };
  }
  return null;
}

/**
 * One fact, opened from its row (2026-10-07 plan §3.2 item 4): the sentence,
 * where it came from, the versions it has had, and what the researcher can do
 * with it — 编辑 in place and 忘记.
 *
 * The origin is one phrase under the title, not a tag on the row (principle
 * 18): whose words it is, and since when. A project's fact names its project.
 * 「来源对话」 is a link in here and nowhere else, because opening a conversation
 * can start that project's runtime and a click on a row must never do that.
 *
 * Everything the old row did is here: a memory held for a medicine-safety check
 * says so and asks to be confirmed, and a sensitive one says what confirming
 * does before it does it; two memories that disagree each offer 「以这条为准」;
 * the undo of the last change and 「这不对」 on an inference are in the 「⋯」. 忘记 archives, as a revision the toast takes back and
 * 已忘记的内容 restores; 这不对 deletes and stops the extractor inferring it again,
 * so it is the one that asks first.
 */
export function FactDrawer({ item, projectName, onClose, onChanged }: {
  item: FactItem;
  /** The project a project's fact belongs to, when the shell knows its name. */
  projectName: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const record = item.kind === "record" ? item.record : null;
  const entry: OwnCapsuleEntry | null = item.kind === "entry" ? item.entry : null;
  const text = record ? record.summary || record.value : entry?.payload.content ?? "";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const [confirmingSensitive, setConfirmingSensitive] = useState<null | { value?: string; status?: "active" }>(null);
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => { if (!editing) setValue(text); }, [text, editing]);
  // 编辑 was a button a moment ago, so the field it opens takes the focus.
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) field.current?.focus(); }, [editing]);

  const run = async (operation: () => Promise<void>, error: (reason: unknown) => string = failed) => {
    setBusy(true);
    try {
      await operation();
      announceMemoryChanged();
      onChanged();
    } catch (reason) {
      toast.error(error(reason));
    } finally {
      setBusy(false);
    }
  };

  // ---- a memory record ----
  const saveRecord = (next: { value?: string; status?: "active" }) => run(async () => {
    if (!record) return;
    const edited = next.value?.trim();
    await updateStructuredMemory(record, {
      ...(edited ? { value: edited, summary: edited } : {}),
      ...(next.status ? { status: next.status } : {}),
    });
    setEditing(false);
    toast.success(next.status && !edited ? "已确认" : "已保存");
  });
  const confirmOrSave = (next: { value?: string; status?: "active" }) => {
    // The truth, not a promise the code does not keep: a sensitive record is never recalled, whatever its status.
    if (record?.status === "pending" && record.sensitive) setConfirmingSensitive(next);
    else void saveRecord(next);
  };
  const forgetRecord = () => run(async () => {
    if (!record) return;
    const archived = await archiveMemoryRecord(record.id, record.version);
    onClose();
    toast.success("已忘记", {
      action: {
        label: "撤销",
        onClick: () => void undoMemoryRecord(record.id, archived.version)
          .then(() => { announceMemoryChanged(); onChanged(); }, (reason) => toast.error(failed(reason))),
      },
    });
  });
  const undoRecord = () => run(async () => {
    if (!record) return;
    const result = await undoMemoryRecord(record.id, record.version);
    toast.success(result.undone === "removed" ? "已撤销这条记忆" : "已撤销上次改动");
    if (result.undone === "removed") onClose();
  });
  // 「以这条为准」: the researcher's own call between two statements that disagree. The loser is replaced and kept; the toast takes it back.
  const settle = (keepId: string, otherId: string) => run(async () => {
    const settled = await settleMemoryConflict(keepId, otherId);
    toast.success("已按这条为准", {
      action: {
        label: "撤销",
        onClick: () => void undoMemoryRecord(settled.superseded.id, settled.superseded.version)
          .then(() => { announceMemoryChanged(); onChanged(); }, (reason) => toast.error(failed(reason))),
      },
    });
  });
  const reject = () => run(async () => {
    if (!record) return;
    setRejecting(false);
    await deleteStructuredMemory(record.id);
    onClose();
    toast.success("已删除");
  });

  // ---- a note of the researcher's own capsule ----
  const capsuleId = entry?.payload.capsuleId ?? "";
  const saveEntry = () => run(async () => {
    if (!entry) return;
    await updateCapsuleEntry(capsuleId, entry.id, { content: value.trim(), expectedRevision: entry.revision });
    setEditing(false);
    toast.success("已保存");
  }, productErrorMessage);
  const forgetEntry = () => run(async () => {
    if (!entry) return;
    const retired = await retireCapsuleEntry(capsuleId, entry.id, entry.revision);
    onClose();
    toast.success("已忘记", {
      action: {
        label: "撤销",
        onClick: () => void undoCapsuleEntry(capsuleId, retired)
          .then(() => { announceMemoryChanged(); onChanged(); }, (reason) => toast.error(productErrorMessage(reason))),
      },
    });
  }, productErrorMessage);
  const undoEntry = () => run(async () => {
    if (!entry) return;
    const result = await undoCapsuleEntry(capsuleId, entry);
    toast.success(result.undone === "removed" ? "已撤销这一条" : "已撤销上次改动");
    if (result.undone === "removed") onClose();
  }, productErrorMessage);

  const origin = record ? memoryOrigin(record) : entry?.payload.origin === "explicit" ? "你说的" : "从对话中学到";
  const since = formatDay(record?.createdAt ?? entry?.createdAt ?? null);
  const former = record?.status === "superseded";
  const pending = record?.status === "pending";
  const source = record ? memorySource(record) : null;
  const conflicts = record?.relations?.conflicts ?? [];
  const badges = record ? [
    ...(former ? ["已被替代"] : []),
    ...(record.relations?.caveats ?? []).map((caveat) => CAVEAT_BADGE[caveat]).filter(Boolean),
  ] : [];
  const settleable = record?.status === "active";
  const formerly = item.kind === "record" ? item.formerly : [];
  const revisions = record ? [...record.revisions].reverse().slice(0, 5) : [];
  const undoable = record ? record.revisions.length > 0 : (entry?.revision ?? 1) > 1;

  const menu: MenuEntry[] = [
    ...(undoable ? [{ label: "撤销上次改动", disabled: busy, onSelect: () => void (record ? undoRecord() : undoEntry()) }] : []),
    // Only an inference can be wrong in this way: the researcher's own words are theirs to edit.
    ...(record && memoryOrigin(record) === "从对话中学到" ? [{ label: "这不对", destructive: true, disabled: busy, onSelect: () => setRejecting(true) }] : []),
  ];

  const sentence = record ? memoryExcerpt(record.summary || record.value, 4_000) : memoryExcerpt(text, 4_000);
  const save = () => (record ? confirmOrSave({ value, status: "active" }) : void saveEntry());

  return (
    <>
      <Drawer
        title={record ? kindTitle(record.kind) : kindTitle(entry?.payload.factKind ?? "")}
        description={[projectName, origin, since].filter(Boolean).join(" · ")}
        onClose={onClose}
        actions={menu.length > 0 ? <Menu label="更多" items={menu} /> : undefined}
      >
        <div className="flex min-h-full flex-col gap-6">
          {editing ? (
            <form
              className="space-y-2"
              onSubmit={(event) => { event.preventDefault(); if (value.trim()) save(); }}
            >
              <Textarea ref={field} value={value} onChange={(event) => setValue(event.target.value)} aria-label="编辑这条记忆" rows={4} maxLength={entry ? 20_000 : undefined} />
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={busy} disabled={!value.trim()}>保存</Button>
                <Button size="sm" variant="text" onClick={() => setEditing(false)}>取消</Button>
              </div>
            </form>
          ) : (
            <p className="whitespace-pre-wrap text-body text-text">{former ? `曾经如此：${sentence}${record ? heldFrom(record) : ""}` : sentence}</p>
          )}

          {(pending || badges.length > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              {pending && <Tag tone="safety">待确认（用药安全）</Tag>}
              {badges.map((badge) => <Tag key={badge}>{badge}</Tag>)}
              {pending && <Button size="sm" variant="secondary" loading={busy} onClick={() => confirmOrSave({ status: "active" })}>确认</Button>}
            </div>
          )}

          {record && conflicts.map((side) => {
            const sideText = side.sensitive ? "这是一条敏感记忆" : `“${memoryExcerpt(side.text, 120)}”`;
            // Both sides are offered, each with the same words: the researcher decides which statement holds, so neither is the default.
            const choosable = settleable && side.status === "active";
            return (
              <DrawerSection key={`conflict-${side.id}`} label="和另一条说法不一致">
                <div className="flex flex-wrap items-center justify-between gap-2 text-ui text-text-2">
                  <p>这条：“{memoryExcerpt(record.summary || record.value, 120)}”</p>
                  {choosable && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void settle(record.id, side.id)}
                      aria-label={`以这条为准：${memoryExcerpt(record.summary || record.value, 40)}`}>以这条为准</Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-ui text-text-2">
                  <p>另一条：{sideText}</p>
                  {choosable && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void settle(side.id, record.id)}
                      aria-label={`以这条为准：${side.sensitive ? "另一条" : memoryExcerpt(side.text, 40)}`}>以这条为准</Button>
                  )}
                </div>
              </DrawerSection>
            );
          })}

          {record && (record.evidence.length > 0 || source) && (
            <DrawerSection label="出处">
              {record.evidence.slice(-3).reverse().map((evidence) => (
                <div key={evidence.fingerprint || `${evidence.sourceRef}-${evidence.observedAt}`}>
                  <p className="text-ui text-text-2">“{evidence.quote}”</p>
                  {evidence.observedAt && <p className="text-caption text-text-3">{when(evidence.observedAt)}</p>}
                </div>
              ))}
              {source && (
                <ConversationLink projectId={record.scope === "project" ? record.scopeId : null} sessionId={source.sessionId}>来源对话</ConversationLink>
              )}
            </DrawerSection>
          )}

          {(formerly.length > 0 || revisions.length > 0) && (
            <DrawerSection label="以前的版本">
              <ul className="space-y-1 text-ui text-text-2">
                {formerly.map((earlier) => (
                  <li key={`formerly-${earlier.id}`}>曾经如此：{memoryExcerpt(earlier.summary || earlier.value, 120)}{heldFrom(earlier)}</li>
                ))}
                {revisions.map((revision) => (
                  <li key={revision.version}>
                    {[when(revision.changedAt), revision.by ? REVISION_BY[revision.by] : ""].filter(Boolean).join(" · ")}
                    {revision.changedAt || revision.by ? "：" : ""}{memoryExcerpt(revision.summary || revision.value, 120)}
                  </li>
                ))}
              </ul>
            </DrawerSection>
          )}

          {!editing && (
            <div className="mt-auto flex gap-2">
              {/* Saving an edit puts the memory in force, which a replaced fact is not. */}
              {!former && <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>编辑</Button>}
              <Button variant="text" destructive disabled={busy} onClick={() => void (record ? forgetRecord() : forgetEntry())}>忘记</Button>
            </div>
          )}
        </div>
      </Drawer>
      {confirmingSensitive && (
        <ConfirmDialog
          title="确认这条敏感记忆？"
          body={`确认后它保留为已生效；出于隐私保护，敏感记忆不会被自动调取到后续研究中：${memoryExcerpt(confirmingSensitive.value || text, 120)}`}
          confirmLabel="确认保留"
          tone="primary"
          onConfirm={() => { const next = confirmingSensitive; setConfirmingSensitive(null); void saveRecord(next); }}
          onCancel={() => setConfirmingSensitive(null)}
        />
      )}
      {rejecting && (
        <ConfirmDialog
          title="这条推断不对？"
          body="删除这条推断，之后也不再推断出来；只想暂时不用，请选“忘记”。"
          confirmLabel="删除"
          onConfirm={() => void reject()}
          onCancel={() => setRejecting(false)}
        />
      )}
    </>
  );
}
