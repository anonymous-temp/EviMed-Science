import { useId, useState } from "react";
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
 * Starting a capability from the catalogue.
 *
 * 开始 dispatches: the session is bound to this capability and the run starts
 * at once — no plan to approve first (owner decision 3: DSH's own design has
 * no such pause, and none is added). The route line appears the moment the
 * control plane answers, with the change of line offered there.
 *
 * 在对话里写 is the other way in, kept because it is the path a researcher
 * already knows: the brief goes into the conversation's composer, naming the
 * capability in words, and nothing is bound until they send it themselves.
 */
export function CapabilityStart({
  agent,
  onDispatched,
  initialQuestion,
}: {
  agent: WebResearchAgent;
  onDispatched: (run: WebAgentRun, question: string) => void;
  initialQuestion?: string;
}) {
  const navigate = useNavigate();
  const ui = researchAgentUi(agent);
  const [question, setQuestion] = useState(initialQuestion ?? ui.starterPrompts[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fieldId = useId();

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
    navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(capabilityBrief(ui.title, question.trim())) } });
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
        id={fieldId}
        value={question}
        onChange={(event) => { setQuestion(event.target.value); setFailure(null); }}
        onKeyDown={(event) => {
          // ⌘/Ctrl+Enter starts, like every composer; a plain Enter is a newline.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void start();
          }
        }}
        rows={3}
        disabled={busy}
        className={textareaClasses({ className: "min-h-24" })}
      />
      {failure && <p role="alert" className="text-caption text-error">{failure}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={busy}>
          {!busy && <Play size={14} aria-hidden="true" />}开始
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={writeInConversation}>
          <PenLine size={14} aria-hidden="true" />在对话里写
        </Button>
        <span className="text-caption text-muted">开始后直接运行，不需要再确认；运行中可以随时停止或改线。</span>
      </div>
    </form>
  );
}
