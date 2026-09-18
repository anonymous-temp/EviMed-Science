import { forwardRef, useId, useState } from "react";
import { useNavigate } from "react-router";
import { PenLine, Play } from "lucide-react";
import { capabilityBrief } from "@evimed/domain";
import { webErrorMessage, type WebAgentRun, type WebResearchAgent } from "@/lib/apiClient";
import { capabilityTarget, dispatchResearch } from "@/lib/dispatch";
import { researchAgentUi } from "@/lib/researchAgentUi";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { Button } from "@/components/ui/Button";
import { textareaClasses } from "@/components/ui/Input";

/**
 * Starting a capability from the catalogue with the researcher's own question.
 *
 * 开始 dispatches: the session is bound to this capability and the run starts
 * at once — no plan to approve first (owner decision 3: DSH's own design has
 * no such pause, and none is added). The route line appears the moment the
 * control plane answers, with the change of line offered there.
 *
 * 在对话里写 is the other way in, kept because it is the path a researcher
 * already knows: the brief goes into the conversation's composer, naming the
 * capability in words, and nothing is bound until they send it themselves.
 *
 * Controlled: the card around it can put a starter question into the box.
 */
export const CapabilityStart = forwardRef<HTMLTextAreaElement, {
  agent: WebResearchAgent;
  question: string;
  onQuestionChange: (question: string) => void;
  onDispatched: (run: WebAgentRun, question: string) => void;
  /** Another start from the same card is in flight. */
  disabled?: boolean;
}>(function CapabilityStart({ agent, question, onQuestionChange, onDispatched, disabled = false }, ref) {
  const navigate = useNavigate();
  const ui = researchAgentUi(agent);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fieldId = useId();
  const hintId = useId();

  const start = async () => {
    const text = question.trim();
    if (!text) {
      setFailure("先写下要研究的问题。");
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const run = await dispatchResearch(capabilityTarget(agent), text);
      onDispatched(run, text);
    } catch (error) {
      setFailure(webErrorMessage(error, { fallback: "没能开始，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  };

  const writeInConversation = () => {
    navigate("/app/chat", {
      state: { runtimeUiIntent: newRuntimeUiIntent(capabilityBrief(ui.title, question.trim() || (ui.starterPrompts[0] ?? ""))) },
    });
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <label htmlFor={fieldId} className="block text-ui font-medium text-text">
        你的问题
      </label>
      <textarea
        ref={ref}
        id={fieldId}
        value={question}
        aria-describedby={hintId}
        onChange={(event) => { onQuestionChange(event.target.value); setFailure(null); }}
        onKeyDown={(event) => {
          // ⌘/Ctrl+Enter starts, like every composer; a plain Enter is a newline.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void start();
          }
        }}
        rows={3}
        disabled={busy || disabled}
        placeholder={ui.starterPrompts[0] ? `用自己的话写下问题，例如：${ui.starterPrompts[0]}` : "用自己的话写下问题"}
        className={textareaClasses({ className: "min-h-24" })}
      />
      {failure && <p role="alert" className="text-caption text-error">{failure}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={disabled}>
          {!busy && <Play size={14} aria-hidden="true" />}开始
        </Button>
        <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={writeInConversation}>
          <PenLine size={14} aria-hidden="true" />在对话里写
        </Button>
      </div>
      <p id={hintId} className="text-caption text-muted">开始后直接运行，不需要再确认；运行中可以随时停止或改线。⌘/Ctrl + Enter 也可以开始。</p>
    </form>
  );
});
