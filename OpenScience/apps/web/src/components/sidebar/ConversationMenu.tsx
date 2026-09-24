import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { archiveWebAgentRun, cancelWebAgentRun, deleteWebAgentRun, renameWebAgentRun, webErrorMessage, type WebAgentRun } from "@/lib/apiClient";
import { announceRunsChanged, runTitle } from "@/lib/runPresentation";
import { chatPath } from "@/lib/runLocation";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { isRunning } from "@/components/sidebar/useProjectRuns";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { inputClasses } from "@/components/ui/Input";
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
 * The identifiers support asks for stay behind 「复制诊断信息」, never on the
 * row: a conversation is named by its question (§23.2 rule 11).
 *
 * Archiving and deleting are flags on the control plane's ledger: the
 * conversation leaves the lists, and what it spent, wrote and was told stays
 * readable. Deleting is the word people use, so it is not undone; archiving
 * is.
 */
export function ConversationMenu({ run, onRenamed, className }: {
  run: WebAgentRun;
  onRenamed?: (run: WebAgentRun) => void;
  className?: string;
}) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"stop" | "delete" | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node | null)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (renaming) { renameInput.current?.focus(); renameInput.current?.select(); }
  }, [renaming]);

  const title = runTitle(run);

  /** Leaving a conversation that is no longer listed: the surface goes blank rather than showing a row that is gone. */
  const leaveIfOpen = () => {
    if (location.pathname === chatPath(run.sessionId)) navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() }, replace: true });
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

  const stop = () => perform(() => cancelWebAgentRun(run.id), "已停止这条对话的研究。", "没能停止，请稍后重试。");
  const archive = () => perform(async () => { await archiveWebAgentRun(run.id, true); leaveIfOpen(); }, "已归档。", "没能归档，请稍后重试。");
  const remove = () => perform(async () => { await deleteWebAgentRun(run.id); leaveIfOpen(); }, "已删除这条对话。", "没能删除，请稍后重试。");

  const submitRename = async () => {
    const next = draft.trim();
    if (!next || next === title) { setRenaming(false); return; }
    setBusy(true);
    try {
      const renamed = await renameWebAgentRun(run.id, next);
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
      `run: ${run.id}`,
      `session: ${run.sessionId}`,
      run.effectiveAgentId ? `agent: ${run.effectiveAgentId}${run.effectiveAgentVersion ? `@${run.effectiveAgentVersion}` : ""}` : null,
      run.model ? `model: ${run.model}` : null,
      `status: ${run.status}`,
      run.createdAt ? `created: ${run.createdAt}` : null,
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(lines);
      toast.success("诊断信息已复制。");
    } catch {
      toast.error("这个浏览器不允许复制，请手动记录。");
    }
    setOpen(false);
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
          className={inputClasses({ className: "h-7 px-2 text-caption" })}
        />
      </form>
    );
  }

  const item = "flex w-full items-center rounded-input px-2 py-1.5 text-left text-ui text-text hover:bg-surface-2";
  const items: { label: string; onClick: () => void; danger?: boolean }[] = [
    ...(isRunning(run) ? [{ label: "停止", onClick: () => { setOpen(false); setConfirming("stop"); } }] : []),
    { label: "重命名", onClick: () => { setOpen(false); setDraft(title); setRenaming(true); } },
    { label: "归档", onClick: () => { setOpen(false); void archive(); } },
    { label: "删除", onClick: () => { setOpen(false); setConfirming("delete"); }, danger: true },
    { label: "复制诊断信息", onClick: () => void copyDiagnostics() },
  ];

  return (
    <div ref={root} className={className}>
      <button
        ref={trigger}
        type="button"
        aria-label={`「${title}」的操作`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }}
        className="grid h-6 w-6 place-items-center rounded-input text-muted hover:bg-surface hover:text-text"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`「${title}」的操作`}
          className="absolute right-0 z-30 mt-1 min-w-36 rounded-card border border-border bg-surface p-1 shadow-pop"
        >
          {items.map((entry) => (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              onClick={entry.onClick}
              className={entry.danger ? `${item} text-error` : item}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {confirming === "stop" && (
        <ConfirmDialog
          title="停止这条对话的研究？"
          body="已经做完的检索和写好的文件会留在工作区，但这次研究不会再继续。"
          confirmLabel="停止"
          onConfirm={() => void stop()}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === "delete" && (
        <ConfirmDialog
          title={`删除「${title}」？`}
          body={isRunning(run)
            ? "这条对话还在运行，会先停止，然后从列表里删除。它产出的文件留在项目工作区，不会一起删除。"
            : "会从列表里删除，不能恢复。它产出的文件留在项目工作区，不会一起删除。"}
          confirmLabel="删除"
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
