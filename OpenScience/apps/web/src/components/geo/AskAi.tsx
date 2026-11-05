import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { PenLine } from "lucide-react";
import type { GeoCell } from "@/lib/geoClient";
import { runtimeUiIntentFromState } from "@/lib/runtimeUiNavigation";
import { buttonClasses } from "@/components/ui/Button";
import { geoCellPhrase } from "./GeoCellText";
import { geoMayConverse, useGeoFrame } from "./geoFrame";
import type { GeoUnit } from "./geoText";
import { useOpenGeoConversation, type GeoConversationTarget } from "./useOpenGeoConversation";

/**
 * The draft “让 AI 解读” puts in the composer for a number: what it is, its
 * value with the sample it rests on, and when it was measured — so the
 * conversation starts from the same fact the reader was looking at.
 *
 * “玛仕度肽注射液 · 豆包 · 品牌提及率：18%，310 次里 56 次（9月22日测量）。这个数说明了什么，接下来该做什么？”
 */
export function geoNumberDraft({
  product,
  scope,
  name,
  cell,
  unit = "percent",
  date,
}: {
  product?: string | null;
  /** Where the number is from, in the reader's words: “豆包”“通用名与品类类”. */
  scope?: string | null;
  /** The metric's name: “品牌提及率”. */
  name: string;
  cell: GeoCell | null | undefined;
  unit?: GeoUnit;
  /** When it was measured, already in the reader's words: “9月22日”. */
  date?: string | null;
}): string {
  const subject = [product, scope, name].filter((part): part is string => !!part).join(" · ");
  const when = date ? `（${date}测量）` : "";
  return `${subject}：${geoCellPhrase(cell, unit)}${when}。这个数说明了什么，接下来该做什么？`;
}

/**
 * “让 AI …” beside a number or an answer: opens the project's conversation with a draft that carries the fact — never sends it. It is a
 * draft, so it says 「让 AI」, carries the pencil and declares itself one (`actionKind="draft"`): nothing starts until the person sends.
 *
 * Pass `draft` for a finished sentence (an answer, an error), or the number's
 * parts (`name`, `cell`, `date` …) and the draft is written by
 * `geoNumberDraft`.
 */
export function AskAi({
  project,
  draft,
  product,
  scope,
  name,
  cell,
  unit,
  date,
  label = "让 AI 解读",
  className,
  onOpened,
}: {
  project: GeoConversationTarget;
  draft?: string;
  product?: string | null;
  scope?: string | null;
  name?: string;
  cell?: GeoCell | null;
  unit?: GeoUnit;
  date?: string | null;
  label?: string;
  className?: string;
  /** Runs when this draft has landed in the conversation route. */
  onOpened?: () => void;
}) {
  const open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  const intent = onOpened ? runtimeUiIntentFromState(location.state, project.projectId) : null;
  const pending = useRef<{ fromKey: string; previousRequestId?: string; geoId?: string; draft: string } | null>(null);
  useEffect(() => {
    const attempt = pending.current;
    if (!attempt || location.key === attempt.fromKey) return;
    pending.current = null;
    // The opener can finish before a navigation guard allows its destination to commit.
    if (intent?.kind === "open" && intent.requestId !== attempt.previousRequestId
      && intent.scope && (!attempt.geoId || intent.scope.geoProjectId === attempt.geoId)
      && intent.draft === attempt.draft) onOpened?.();
  }, [location.key, intent, onOpened]);
  // A role that may not open the conversation (it takes run and edit) is not offered a button that can only be refused.
  const frame = useGeoFrame();
  if (frame && !geoMayConverse(frame.project)) return null;
  // Asked about a number that is not there yet (未测, 样本不足 with no value):
  // there is nothing to explain, so there is no button.
  if (draft == null && cell !== undefined && (cell == null || cell.value == null)) return null;
  const text = draft ?? geoNumberDraft({ product, scope, name: name ?? "", cell, unit, date });
  return (
    <button
      type="button"
      data-geo-ask-ai=""
      data-action-kind="draft"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        setBusy(true);
        const geoId = project.geoId ?? frame?.geoId;
        const attempt = onOpened ? { fromKey: location.key, previousRequestId: intent?.requestId, geoId, draft: text } : null;
        pending.current = attempt;
        void open({ ...project, geoId, primarySessionId: project.primarySessionId ?? project.sessionId ?? frame?.project.sessionId ?? null }, text)
          .then((requested) => { if (!requested && pending.current === attempt) pending.current = null; })
          .finally(() => setBusy(false));
      }}
      className={buttonClasses({ variant: "text", size: "sm", className: `text-accent hover:text-accent ${className ?? ""}` })}
    >
      <PenLine size={16} aria-hidden="true" />
      {label}
    </button>
  );
}
