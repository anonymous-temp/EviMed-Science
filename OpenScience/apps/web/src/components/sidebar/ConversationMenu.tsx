import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { archiveWebAgentRun, cancelWebAgentRun, deleteWebAgentRun, fetchWebMe, renameWebAgentRun, webErrorMessage, type WebAgentRun } from "@/lib/apiClient";
import type { Conversation } from "@/lib/conversations";
import { announceRunsChanged, runTitle } from "@/lib/runPresentation";
import { chatPath } from "@/lib/runLocation";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { isRunning } from "@/components/sidebar/useProjectRuns";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { inputClasses } from "@/components/ui/Input";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { toast } from "@/lib/toast";

/**
 * What a conversation's row offers, as the conversation lists people already
 * use offer it: rename, archive, delete — and, while it is still working,
 * stop.
 *
 * The kernel's own session list has rename, fork and archive and nothing that
 * deletes; ChatGPT and Claude have rename, archive and delete. This row has
 * the three a researcher asks for (2026-09-22: 「项目会话，删除 归档啥的咋都
 * 没有」) plus stop, which is the composer's own control inside the frame and
 * the way to it from outside, which is where 「我不想等了」 usually happens.
 *
 * A row is a whole conversation (`groupConversations`): archiving or deleting
 * it acts on every turn the ledger recorded for it, stopping stops the turn
 * that is working, and renaming renames the title the row shows. The
 * identifiers support asks for are behind 「复制诊断信息」, for operators only
 * (2026-09-23 inventory §1.1): a conversation is named by its question.
 *
 * Archiving and deleting are flags on the control plane's ledger: the
 * conversation leaves the lists, and what it spent, wrote and was told stays
 * readable. Deleting is the word people use, so it is not undone; archiving
 * is.
 */
export function ConversationMenu({ conversation, onRenamed, className }: {
  conversation: Conversation;
  onRenamed?: (run: WebAgentRun) => void;
  className?: string;
}) {
  const menuId = useId();
  const renameInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"stop" | "delete" | null>(null);
  const [operator, setOperator] = useState(false);
  const { runs, titleRun, lead } = conversation;
  const working = runs.filter(isRunning);

  useEffect(() => {
    let live = true;
    void fetchWebMe().then((me) => { if (live) setOperator(Boolean(me?.operator)); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (renaming) { renameInput.current?.focus(); renameInput.current?.select(); }
  }, [renaming]);

  const title = runTitle(titleRun);

  /** Leaving a conversation that is no longer listed: the surface goes blank rather than showing a row that is gone. */
  const leaveIfOpen = () => {
    if (location.pathname === chatPath(conversation.sessionId)) navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() }, replace: true });
  };

  const perform = async (action: () => Promise<unknown>, done: string, failed: string) => {
    setConfirming(null);
    setBusy(true);
    try {
      await action();
      announceRunsChanged();
      toast.success(done);
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: failed }));
    } finally {
      setBusy(false);
    }
  };

  const each = (act: (id: string) => Promise<unknown>, list: readonly WebAgentRun[]) => async () => {
    for (const run of list) await act(run.id);
  };
  const stop = () => perform(each((id) => cancelWebAgentRun(id), working), "已停止。", "没能停止，请稍后重试。");
  const archive = () => perform(async () => { await each((id) => archiveWebAgentRun(id, true), runs)(); leaveIfOpen(); }, "已归档。", "没能归档，请稍后重试。");
  const remove = () => perform(async () => { await each((id) => deleteWebAgentRun(id), runs)(); leaveIfOpen(); }, "已删除。", "没能删除，请稍后重试。");

  const submitRename = async () => {
    const next = draft.trim();
    if (!next || next === title) { setRenaming(false); return; }
    setBusy(true);
    try {
      const renamed = await renameWebAgentRun(titleRun.id, next);
      onRenamed?.(renamed);
      announceRunsChanged();
      setRenaming(false);
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "名称没有改成功，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  };

  // Identifiers, as one block to paste into a support message rather than as
  // four rows a reader has to copy one at a time.
  const copyDiagnostics = async () => {
    const lines = [
      `session: ${conversation.sessionId}`,
      ...runs.map((run) => `run: ${run.id} · ${run.status}${run.effectiveAgentId ? ` · ${run.effectiveAgentId}${run.effectiveAgentVersion ? `@${run.effectiveAgentVersion}` : ""}` : ""}`),
      lead.model ? `model: ${lead.model}` : null,
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(lines);
      toast.success("已复制。");
    } catch {
      toast.error("这个浏览器不允许复制，请手动记录。");
    }
  };

  if (renaming) {
    return (
      <form
        className={className}
        onSubmit={(event) => { event.preventDefault(); void submitRename(); }}
      >
        <label className="sr-only" htmlFor={`${menuId}-rename`}>对话的新名称</label>
        <input
          id={`${menuId}-rename`}
          ref={renameInput}
          value={draft}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void submitRename()}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setRenaming(false);
          }}
          className={inputClasses({ className: "h-6 px-2" })}
        />
      </form>
    );
  }

  const items: MenuEntry[] = [
    ...(working.length ? [{ label: "停止", onSelect: () => setConfirming("stop") }] : []),
    { label: "重命名", onSelect: () => { setDraft(title); setRenaming(true); } },
    { label: "归档", onSelect: () => void archive() },
    { label: "删除", destructive: true, onSelect: () => setConfirming("delete") },
    ...(operator ? ["separator" as const, { label: "复制诊断信息", onSelect: () => void copyDiagnostics() }] : []),
  ];

  return (
    <div className={className}>
      <Menu label={`「${title}」的操作`} items={items} />
      {confirming === "stop" && (
        <ConfirmDialog
          title="停止这条对话？"
          body="已完成的文件会保留。"
          confirmLabel="停止"
          onConfirm={() => void stop()}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === "delete" && (
        <ConfirmDialog
          title={`删除「${title}」？`}
          body={working.length ? "会先停止；删除后不可恢复，产出文件仍在项目工作区。" : "删除后不可恢复；产出文件仍在项目工作区。"}
          confirmLabel="删除"
          tone="danger"
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
