import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cancelWebAgentRun, renameWebAgentRun, webErrorMessage, type WebAgentRun } from "@/lib/apiClient";
import { announceRunsChanged, runTitle } from "@/lib/runPresentation";
import { isRunning } from "@/components/sidebar/useProjectRuns";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { inputClasses } from "@/components/ui/Input";
import { toast } from "@/lib/toast";

/**
 * What the run ledger page did for one conversation, on the conversation's own
 * row.
 *
 * The ledger was deleted on 2026-09-20 and three of its controls had nowhere
 * else to be: stopping a conversation that is still working, renaming it, and
 * reading out the identifiers support asks for. Stopping is also the composer's
 * own control inside the frame — this is the way to it from outside the
 * conversation, which is where 「我不想等了」 usually happens.
 *
 * Deliberately three items: everything else the ledger row carried — files,
 * cost, progress, verification — belongs to the conversation itself and is
 * drawn there, not in a sidebar menu.
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
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);

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

  const stop = async () => {
    setConfirmingStop(false);
    setBusy(true);
    try {
      await cancelWebAgentRun(run.id);
      announceRunsChanged();
      toast.success("已停止这条对话的研究。");
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "没能停止，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  };

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
  // four rows a reader has to copy one at a time. They are never shown on the
  // row itself: a conversation is named by its question (§23.2 rule 11).
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
        <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`「${title}」的操作`}
          className="absolute right-0 z-30 mt-1 min-w-36 rounded-card border border-border bg-surface p-1 shadow-pop"
        >
          {isRunning(run) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); setConfirmingStop(true); }}
              className="flex w-full items-center rounded-input px-2 py-1.5 text-left text-ui text-text hover:bg-surface-2"
            >
              停止
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); setDraft(title); setRenaming(true); }}
            className="flex w-full items-center rounded-input px-2 py-1.5 text-left text-ui text-text hover:bg-surface-2"
          >
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyDiagnostics()}
            className="flex w-full items-center rounded-input px-2 py-1.5 text-left text-ui text-text hover:bg-surface-2"
          >
            复制诊断信息
          </button>
        </div>
      )}
      {confirmingStop && (
        <ConfirmDialog
          title="停止这条对话的研究？"
          body="已经做完的检索和写好的文件会留在工作区，但这次研究不会再继续。"
          confirmLabel="停止"
          onConfirm={() => void stop()}
          onCancel={() => setConfirmingStop(false)}
        />
      )}
    </div>
  );
}
