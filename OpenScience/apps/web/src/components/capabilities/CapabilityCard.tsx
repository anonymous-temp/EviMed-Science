import { useRef, useState } from "react";
import { Link } from "react-router";
import { CircleAlert, CircleCheck, CircleDashed, Clock3, FolderUp, Loader2, Play } from "lucide-react";
import { webErrorMessage, type WebAgentRun, type WebResearchAgent } from "@/lib/apiClient";
import { capabilityTarget, dispatchResearch, minutesText } from "@/lib/dispatch";
import { evaluationLines, researchAgentUi, type CapabilityEvaluation } from "@/lib/researchAgentUi";
import { CapabilityStart } from "@/components/capabilities/CapabilityStart";
import { cn } from "@/lib/cn";

/**
 * A capability's model card (plan §8.4, appendix C: HAX G1–G2): what it does,
 * how well it has done — from `evals/`, never estimated — what it cannot do,
 * what the researcher receives, and a way to start.
 *
 * The starter questions start a run when clicked (owner decision 3: no plan
 * to approve first). For a capability that works on the researcher's own
 * material — a manuscript, a dataset, a funding call — a starter question is
 * put into the box instead: dispatched as-is it would begin by asking for a
 * file nobody has given it.
 */
export function CapabilityCard({
  agent,
  onDispatched,
}: {
  agent: WebResearchAgent;
  onDispatched: (run: WebAgentRun, question: string) => void;
}) {
  const ui = researchAgentUi(agent);
  const [question, setQuestion] = useState("");
  const [startingPrompt, setStartingPrompt] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const evaluation = evaluationLines(ui.evaluation);
  const minutes = minutesText({ min: ui.estimatedMinutes[0], max: ui.estimatedMinutes[1] });

  const startPrompt = async (prompt: string) => {
    if (ui.materials) {
      setQuestion(prompt);
      boxRef.current?.focus();
      return;
    }
    setStartingPrompt(prompt);
    setFailure(null);
    try {
      const run = await dispatchResearch(capabilityTarget(agent), prompt);
      onDispatched(run, prompt);
    } catch (error) {
      setFailure(webErrorMessage(error, { fallback: "没能开始，请稍后重试。" }));
    } finally {
      setStartingPrompt(null);
    }
  };

  return (
    <div className="space-y-6 text-ui text-text">
      <section aria-labelledby="capability-what" className="space-y-2">
        <h3 id="capability-what" className="sr-only">做什么</h3>
        <p className="text-body leading-relaxed text-text">{ui.description}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
          <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5">{ui.category}</span>
          {minutes && <span className="inline-flex items-center gap-1"><Clock3 size={12} aria-hidden="true" />{minutes}</span>}
        </p>
      </section>

      {evaluation.length > 0 && (
        <section aria-labelledby="capability-how-well" className="space-y-1.5">
          <h3 id="capability-how-well" className="text-ui font-semibold">实测表现</h3>
          <EvaluationSummary evaluation={ui.evaluation} lines={evaluation} />
        </section>
      )}

      {ui.knownLimits.length > 0 && (
        <section aria-labelledby="capability-limits" className="space-y-1.5">
          <h3 id="capability-limits" className="text-ui font-semibold">已知局限</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted marker:text-muted">
            {ui.knownLimits.map((limit) => <li key={limit}>{limit}</li>)}
          </ul>
        </section>
      )}

      {ui.deliverables.length > 0 && (
        <section aria-labelledby="capability-outputs" className="space-y-1.5">
          <h3 id="capability-outputs" className="text-ui font-semibold">你会拿到</h3>
          <ul className="list-disc space-y-1 pl-5 marker:text-muted">
            {ui.deliverables.map((output) => <li key={output}>{output}</li>)}
          </ul>
        </section>
      )}

      {ui.materials && (
        <p className="flex items-start gap-2 rounded-input border border-border bg-surface-2 px-3 py-2">
          <FolderUp size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1"><span className="font-medium">开始前：</span>{ui.materials}。</span>
          <Link to="/app/files?tab=sources" className="shrink-0 text-link hover:underline">去知识库</Link>
        </p>
      )}

      {ui.starterPrompts.length > 0 && (
        <section aria-labelledby="capability-starters" className="space-y-2">
          <h3 id="capability-starters" className="text-ui font-semibold">试试这些问题</h3>
          <p className="text-caption text-muted">
            {ui.materials ? "点一下放进下面的问题框，补上你的资料后再开始。" : "点一下直接开始，不需要再确认。"}
          </p>
          <ul className="space-y-1.5">
            {ui.starterPrompts.map((prompt) => (
              <li key={prompt}>
                <button
                  type="button"
                  disabled={startingPrompt != null}
                  aria-label={ui.materials ? `放进问题框：${prompt}` : `开始：${prompt}`}
                  onClick={() => void startPrompt(prompt)}
                  className="flex w-full items-start gap-2 rounded-input border border-strong bg-surface px-3 py-2 text-left hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {startingPrompt === prompt
                    ? <Loader2 size={14} className="mt-1 shrink-0 animate-spin text-muted" aria-hidden="true" />
                    : <Play size={14} className="mt-1 shrink-0 text-muted" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">{prompt}</span>
                </button>
              </li>
            ))}
          </ul>
          {failure && <p role="alert" className="text-caption text-error">{failure}</p>}
        </section>
      )}

      <section aria-label="用自己的问题开始" className="border-t border-border pt-5">
        <CapabilityStart
          ref={boxRef}
          agent={agent}
          question={question}
          onQuestionChange={setQuestion}
          onDispatched={onDispatched}
          disabled={startingPrompt != null}
        />
      </section>
    </div>
  );
}

/** The verdict first, as a mark with its word; the counts below it. */
function EvaluationSummary({ evaluation, lines }: { evaluation: CapabilityEvaluation | null; lines: string[] }) {
  const status = evaluation?.lastStatus;
  const Icon = status === "accepted" ? CircleCheck : status === "failed" ? CircleAlert : CircleDashed;
  return (
    <ul className="space-y-1">
      {lines.map((line, index) => (
        <li key={line} className={cn("flex items-start gap-2", index > 0 && "pl-6 text-muted")}>
          {index === 0 && (
            <Icon
              size={16}
              className={cn("mt-0.5 shrink-0", status === "accepted" ? "text-verify-ok" : status === "failed" ? "text-verify-pending" : "text-muted")}
              aria-hidden="true"
            />
          )}
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}
