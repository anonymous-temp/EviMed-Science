import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";
import { VCR_STEP_ACTION_LABELS_ZH, VCR_STEP_STATUS_LABELS_ZH } from "@evimed/domain";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import { vcrChatPath } from "@/lib/studyLocation";
import { VCR_STEP_KEYS, type VcrStep, type VcrStepKey, type VcrStudySummary } from "@/lib/vcrClient";
import { isComposingKey } from "@/lib/compositionKeys";
import { isTopFocusLayer } from "@/lib/focusTrap";
import { buttonClasses } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Note } from "@/components/ui/Note";
import { RAIL_STATE_WORDS, RailMark, type RailState } from "@/components/ui/ProgressRail";
import { Section } from "@/components/ui/Section";
import { stepLabel, tierLabel } from "./vcrText";
import { vcrTabPath } from "./vcrTabs";

/**
 * What the 虚拟临床研究 home shows of one study beside the list, from what `GET /api/vcr/studies` already carries — a peek, not the
 * study's page (`打开研究` goes there): its name and where it stands, what waits for the reader (each line with its way on), the
 * question and the latest finding the study itself wrote, and the seven steps with where each one is. Nothing is read a second time.
 */

/** How a study stands, for the one filter and the one sort the list has. */
export type StudyState = "need" | "running" | "done" | "other";

const FINISHED = new Set(["done", "minimal"]);
const IN_FLIGHT = new Set(["running", "queued"]);

/**
 * A study is complete when its requested work is complete; unrequested work never contributes to its status.
 */
export function studyStateOf(study: Pick<VcrStudySummary, "steps" | "attention">): StudyState {
  const records = Object.values(study.steps);
  if (study.attention.some((line) => line.tone === "attention")) return "need";
  if (records.some((record) => record?.status === "running" || record?.status === "queued")) return "running";
  const requested = records.filter(record => record?.requested === true);
  if (requested.length > 0 && requested.every(record => record?.status === "done" || record?.status === "minimal")) return "done";
  return "other";
}

/**
 * The one line under a study's name in the list: what asks for the reader, what is being done, or how far it has come. A study that
 * waits for somebody says what, in the study's own words.
 */
export function studyStatusLine(study: Pick<VcrStudySummary, "steps" | "attention">): string {
  const state = studyStateOf(study);
  if (state === "need") return `需要你 · ${study.attention.find((line) => line.tone === "attention")?.text ?? ""}`;
  const records = Object.entries(study.steps) as Array<[VcrStepKey, VcrStep | undefined]>;
  if (state === "running") {
    const working = records.filter(([, record]) => record && IN_FLIGHT.has(record.status));
    return working.length === 1 ? `进行中 · 正在${(VCR_STEP_ACTION_LABELS_ZH as Record<string, string>)[working[0][0]] ?? stepLabel(working[0][0])}` : "进行中";
  }
  if (state === "done") return "已完成";
  const requested = records.filter(([, record]) => record?.requested === true);
  const finished = requested.filter(([, record]) => record && FINISHED.has(record.status)).length;
  return finished > 0 ? `已完成 ${finished} / ${requested.length} 步` : "还没开始";
}

/**
 * A step as the study page draws its dots, from the list's own record of it. A step queued behind the allowance is the one 「等你」 the
 * list can tell; one that is out of date or did not finish needs a look.
 */
export function stepMark(step: VcrStep | undefined): { state: RailState; word: string } {
  const status = step?.status ?? "none";
  if (stepAllowanceWait(step)) return { state: "waiting", word: RAIL_STATE_WORDS.waiting };
  const word = (VCR_STEP_STATUS_LABELS_ZH as Record<string, string>)[status] ?? RAIL_STATE_WORDS.todo;
  switch (status) {
    case "done":
    case "minimal": return { state: "done", word };
    case "running":
    case "queued": return { state: "active", word };
    case "failed":
    case "stale": return { state: "attention", word };
    default: return { state: "todo", word: step?.requested === false ? "未请求" : word };
  }
}

export function VcrStudyPreview({ study, heading, onClose }: {
  study: VcrStudySummary;
  /** Beside the list the preview names the study; in the drawer the drawer's title does. */
  heading: boolean;
  /**
   * Beside the list the preview has no drawer to close it: with this it has a 关闭 of its own, and Escape does the same — which gives the
   * pane back to the four ways to start. (In the drawer the drawer closes, and passes nothing.)
   */
  onClose?: () => void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  const closable = Boolean(onClose);
  useEffect(() => {
    if (!closable) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isComposingKey(event) || !isTopFocusLayer(null)) return;
      // A field keeps its own Escape (the search box clears its words), and a layer over the page (a menu, a dialog) its own.
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return;
      event.preventDefault();
      close.current?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closable]);
  const needs = study.attention.filter((line) => line.tone === "attention");
  const marks = VCR_STEP_KEYS.map((key) => ({ key, ...stepMark(study.steps[key]) }));
  const done = marks.filter((mark) => mark.state === "done").length;
  const facts: Fact[] = [
    ...(study.question ? [{ label: "研究问题", value: study.question }] : []),
    ...(study.conclusion?.text ? [{ label: "最新结论", value: <span data-vcr-latest="">{study.conclusion.text}</span> }] : []),
    { label: "数据层级", value: tierLabel(study.tier) },
    ...(study.updatedAt ? [{ label: "最近更新", value: study.updatedAt }] : []),
  ];

  return (
    <div data-vcr-preview={study.id} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {heading && (
          <div className="min-w-0 flex-1 basis-48">
            <h2 className="line-clamp-2 text-section font-semibold text-text">{study.name}</h2>
            <p className="mt-1 text-caption text-text-3">{studyStatusLine(study)}</p>
          </div>
        )}
        {/* The preview's own way on is secondary: the page's one solid button is 开始研究对话, in the list's header. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link to={vcrTabPath(study.id, "overview")} className={buttonClasses({ variant: "secondary" })}>打开研究</Link>
          {study.originatingSessionId && (
            <Link to={vcrChatPath(study.id)} className={buttonClasses({ variant: "text" })}>{study.draftText ? "继续未发送的研究问题" : "原研究对话"}</Link>
          )}
          {onClose && <IconButton icon={X} label="关闭预览" onClick={onClose} />}
        </div>
      </div>

      {needs.map((line, index) => (
        <Note
          key={`${line.kind}-${index}`}
          tone="warn"
          action={(
            <Link to={vcrTabPath(study.id, line.tab ?? line.action?.tab ?? "overview")} className="shrink-0 rounded text-link hover:underline">
              {line.action?.label ?? "去处理"}
            </Link>
          )}
        >
          {`需要你 · ${line.text}`}
        </Note>
      ))}

      <FactList rows={facts} ruled={false} />

      <Section title="进度" count={`${done} / ${VCR_STEP_KEYS.length}`}>
        <ol aria-label="七步进度" className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {marks.map((mark) => (
            <li key={mark.key} data-vcr-step={mark.key} className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5"><RailMark state={mark.state} /></span>
              <span className="min-w-0 text-ui text-text">
                {stepLabel(mark.key)}
                <span className="block text-caption text-text-3">{mark.word}</span>
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
