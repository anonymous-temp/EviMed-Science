import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import { isGeoOff, runGeoStep, type GeoCell, type GeoProject, type GeoStepKey } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { GeoCellText } from "../GeoCellText";
import { GEO_STEP_EMPTY, type GeoUnit } from "../geoText";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { answerPath } from "./geoTabText";

/**
 * What every step tab shares: reading its route, the four states (loading,
 * error with retry, a step still being worked on, content), a section heading
 * and a number that opens the answers behind it.
 */

/* --------------------------------------------------------------------- load */

export type GeoLoad<T> =
  | { kind: "loading" }
  /** `off`: the module is not open to this account; `missing`: nothing at that address. */
  | { kind: "error"; message: string; off: boolean; missing: boolean }
  | { kind: "ready"; data: T };

/**
 * Reads a tab's route once per `key`, and again on `reload()`. While a reload
 * is in flight the last answer stays on screen, so an action's refresh does
 * not flash a skeleton; a first read that fails is an error with 重试.
 */
export function useGeoLoad<T>(key: string, load: () => Promise<T>): { state: GeoLoad<T>; reload: () => void } {
  const [state, setState] = useState<GeoLoad<T>>({ kind: "loading" });
  const [round, setRound] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const shownKey = useRef(key);

  useEffect(() => {
    let live = true;
    if (shownKey.current !== key) {
      shownKey.current = key;
      setState({ kind: "loading" });
    }
    Promise.resolve()
      .then(() => loader.current())
      .then(
        (data) => { if (live) setState({ kind: "ready", data }); },
        (error: unknown) => {
          if (!live) return;
          setState({
            kind: "error",
            message: webErrorMessage(error, { fallback: "暂时无法读取，请稍后重试。" }),
            off: isGeoOff(error),
            missing: error instanceof WebApiError && error.status === 404 && !isGeoOff(error),
          });
        },
      );
    return () => { live = false; };
  }, [key, round]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { state, reload };
}

function Bar({ className }: { className: string }) {
  return <div className={cn("rounded bg-surface-2", className)} />;
}

/** A tab's first paint: a filter row and rows shaped like the list to come. */
export function TabSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div data-geo-tab-loading="" className="animate-pulse" aria-hidden="true">
      <div className="flex h-8 items-center gap-2">
        <Bar className="h-8 w-16 rounded-full" />
        <Bar className="h-4 w-12" />
        <Bar className="h-4 w-12" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 border-b border-faint py-4">
          <Bar className={cn("h-3.5", index % 2 ? "w-2/3" : "w-3/4")} />
          <Bar className="h-3 w-1/4" />
        </div>
      ))}
    </div>
  );
}

/** A route that did not answer, with 重试. */
export function TabError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <LoadError message={message} onRetry={onRetry} />;
}

/* -------------------------------------------------------------------- steps */

/** Whether the step has been asked for and is still being worked on. */
export function stepInProgress(project: GeoProject, step: GeoStepKey): boolean {
  const state = project.steps[step];
  if (!state) return false;
  return state.status === "running" || state.status === "queued" || (state.status === "none" && state.requested);
}

/**
 * What a tab shows while it has nothing to show. A step being worked on says
 * so in one quiet line; any other step with nothing yet — finished without a
 * result, or stopped — says what the step produces and offers 「让 AI 做」,
 * which starts it in the project's conversation, as the shell does for a step
 * nobody has touched.
 */
export function StepPending({ geoId, project, step }: { geoId: string; project: GeoProject; step: GeoStepKey }) {
  const open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false);
  if (stepInProgress(project, step)) {
    return (
      <p data-geo-step-running={step} className="flex items-center justify-center gap-2 py-12 text-ui text-text-3">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-dot-running" />
        AI 正在做这一步，做完会显示在这里。
      </p>
    );
  }
  const run = () => {
    setBusy(true);
    void runGeoStep(geoId, step)
      .then((result) => open({ projectId: project.projectId, sessionId: result?.sessionId ?? project.sessionId }))
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "没有开始，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  return (
    <div data-geo-step-empty={step} className="flex flex-col items-center gap-4 py-12 text-center">
      <p className="text-ui text-text-2">{GEO_STEP_EMPTY[step]}</p>
      <Button onClick={run} loading={busy}>让 AI 做</Button>
    </div>
  );
}

/* ------------------------------------------------------------------ layout */

/** A section inside a tab: a 14/500 heading, then its content. */
export function TabSection({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  /** A grey count at the heading's end. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-10 first:mt-0", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-ui font-medium text-text">{title}</h2>
        {meta && <span className="text-caption tabular-nums text-text-3">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** The grey summary at the right end of a tab's filter row: 「38 条主张」. */
export function RowSummary({ children }: { children: ReactNode }) {
  return <span className="text-caption tabular-nums text-text-3">{children}</span>;
}

/**
 * A tab's filter row: the chips, and the grey summary at the right end. On a
 * narrow screen the summary drops under the chips rather than squeezing them
 * out of sight.
 */
export function FilterRow({ children, summary }: { children: ReactNode; summary?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      {children}
      {summary ? <RowSummary>{summary}</RowSummary> : null}
    </div>
  );
}

/** A table's column heading cell. */
export const TH = "px-2 pb-2 text-left text-caption font-normal text-text-3";
/** A table's body cell. */
export const TD = "px-2 py-3 align-top text-ui text-text";

/* ----------------------------------------------------------------- numbers */

/** The first answer a number rests on, if the server named it. */
export function firstSnapshot(cell: GeoCell | null | undefined, fallback?: string | null): string | null {
  return cell?.snapshotIds?.[0] ?? fallback ?? null;
}

/**
 * A number that opens the answers behind it (build spec §6: every number
 * clickable to the answers). Without an answer to open it is plain text.
 */
export function CellLink({
  geoId,
  cell,
  unit,
  layout = "stack",
  fallbackSnapshotId,
  label,
  className,
}: {
  geoId: string;
  cell: GeoCell | null | undefined;
  unit?: GeoUnit;
  layout?: "inline" | "stack";
  /** An answer to open when the cell names none (an error's answer, say). */
  fallbackSnapshotId?: string | null;
  /** The link's accessible name: 「DeepSeek 的品牌提及率」. */
  label?: string;
  className?: string;
}) {
  const snapshot = firstSnapshot(cell, fallbackSnapshotId);
  const text = <GeoCellText cell={cell} unit={unit} layout={layout} />;
  if (!snapshot) return <span className={className}>{text}</span>;
  return (
    <Link
      to={answerPath(geoId, snapshot)}
      data-geo-cell-link=""
      className={cn("rounded hover:underline hover:decoration-border-control hover:underline-offset-4", className)}
    >
      {text}
      {label && <span className="sr-only">{`${label}，看回答`}</span>}
    </Link>
  );
}
