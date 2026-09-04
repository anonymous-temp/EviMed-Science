import { useState } from "react";
import { HelpCircle, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { RunInteraction } from "@/lib/runStream";

/**
 * The kernel asking the person a question.
 *
 * Whether asking is even possible is a deployment fact, not a UI one. A hosted
 * runtime is patched to `approval: never`, and `never` means auto-REFUSE, so a
 * hosted run never gets here; a local profile is patched to `ask`, and that is
 * the run this card is for.
 *
 * Both halves now exist: `dshEventPump` forwards the kernel's `waterfall`
 * frames, and `POST /api/runs/:id/interactions/:eventId` carries the reply
 * back. `onAnswer` stays optional all the same — a build that renders this
 * card without a channel says so plainly rather than offering a button that
 * silently fails, which is what the card did for the whole time the two halves
 * were missing.
 *
 * A withdrawn request keeps its card. The kernel takes one back when its
 * connection drops or the call is cancelled, and a card that vanished would
 * leave a reader who looked away unable to tell a retracted question from one
 * that was never asked.
 */
export function RunInteractionPrompt({
  interaction,
  onAnswer,
}: {
  interaction: RunInteraction;
  /** Sends the answer to the control plane. Absent when this deployment has no channel. */
  onAnswer?: (answer: { eventId: string; decision: "allow" | "deny" | "answer"; text?: string }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = interaction.kind === "approval" ? ShieldQuestion : HelpCircle;
  const inputId = `interaction-answer-${interaction.eventId}`;

  const send = async (decision: "allow" | "deny" | "answer", value?: string) => {
    if (!onAnswer || sending) return;
    setSending(true);
    setError(null);
    try {
      await onAnswer({ eventId: interaction.eventId, decision, ...(value ? { text: value } : {}) });
    } catch (cause) {
      // Named, not swallowed: a failed answer leaves the run blocked, and the
      // person has to know it is still waiting on them.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      className="rounded-card border border-warn/40 bg-surface p-4 shadow-card"
      aria-labelledby={`interaction-title-${interaction.eventId}`}
    >
      <h2 id={`interaction-title-${interaction.eventId}`} className="flex items-center gap-1.5 text-ui-sm font-medium text-text">
        <Icon size={13} className="text-warn" aria-hidden />
        {interaction.kind === "approval" ? "运行请求你的批准" : "运行向你提问"}
      </h2>
      <p className="mt-2 whitespace-pre-wrap break-words text-ui-sm leading-relaxed text-text">{interaction.prompt}</p>
      {interaction.tool && (
        <p className="mt-1 text-caption text-muted">
          请求执行：<span className="font-mono">{interaction.tool}</span>
        </p>
      )}
      {interaction.detail && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-input bg-surface-2 px-2.5 py-2 font-mono text-caption text-text">
          {interaction.detail}
        </pre>
      )}

      {interaction.withdrawn ? (
        <p className="mt-3 text-caption text-muted" role="status">
          运行已收回这个请求，无需回答（{interaction.withdrawn}）。
        </p>
      ) : interaction.answered ? (
        <p className="mt-3 text-caption text-muted">已回答，等待运行继续。</p>
      ) : !onAnswer ? (
        <p className="mt-3 text-caption text-warn" role="status">
          本部署没有回答通道，因此该请求会按 fail-closed 处理（被拒绝）。
          托管运行的审批策略本就是「一律拒绝」，这条提示主要出现在本地 profile。
        </p>
      ) : interaction.kind === "approval" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void send("allow")} loading={sending}>允许一次</Button>
          <Button size="sm" variant="ghost" onClick={() => void send("deny")} disabled={sending}>拒绝</Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {interaction.options.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {interaction.options.map((option) => (
                <Button key={option.id} size="sm" variant="ghost" onClick={() => void send("answer", option.id)} disabled={sending}>
                  {option.label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex gap-2">
              <label className="sr-only" htmlFor={inputId}>你的回答</label>
              <input
                id={inputId}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="输入你的回答"
                className="min-w-0 flex-1 rounded-input border border-border bg-surface px-2.5 py-1.5 text-ui-sm text-text outline-none placeholder:text-muted focus:border-accent"
              />
              <Button size="sm" onClick={() => void send("answer", text)} loading={sending} disabled={!text.trim()}>
                回答
              </Button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-caption text-error">
          回答未能送达（{error}）。运行仍在等待，请重试。
        </p>
      )}
    </section>
  );
}
