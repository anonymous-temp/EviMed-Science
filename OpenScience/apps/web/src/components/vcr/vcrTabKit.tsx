import { Component, createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { isVcrMissing, isVcrOff } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import type { ChartGridCell } from "@/components/ui/ChartGrid";
import { StudyFrameContext } from "./studyFrameContext";

/**
 * What every study tab shares: reading its route once, the four states, and a
 * section heading that does not invent a type size of its own.
 *
 * A reload keeps the last answer on screen rather than flashing a skeleton —
 * a tab that re-reads after an action (a new assumption version, a confirmed
 * contact) should not look as if it had lost the page.
 *
 * **A study's own reads follow the study.** A key that begins with the study's id (`std_1:patients`) is read again, in place,
 * whenever the frame says the study moved (`StudyFrameApi.version`: a step's state, an engine job's state, the end of a run), so a
 * result that arrives while the reader is on the tab appears without a button — the page used to promise 「做完会显示在这里」 and
 * keep its word only on a reload. A key that is not the study's (the method library, the precedent register) is never re-read for it.
 */

/**
 * Where a read that failed after it had answered reports itself, so the page says so once and keeps what it showed. The study page
 * provides it around everything it draws; a read outside it (the libraries, a test) has nowhere to say it, and its failure replaces
 * its content as before.
 *
 * A re-read is not the same as a first read: the numbers on screen were true when they were read, and an error card in their place
 * lost them for a failure of the next request (module workspace audit, 2026-11-01). A first read, a read of another address and a
 * module that is off or a study that is gone still replace the content: there is nothing, or nothing true, to keep.
 */
export type VcrRefreshReporter = (id: string, failure: { message: string; retry: () => void } | null) => void;
export const VcrRefreshContext = createContext<VcrRefreshReporter | null>(null);

export const VCR_REFRESH_FAILED = "更新暂时失败，仍显示上次结果。";

/** The one sentence for a read that failed and left the last answer on screen, with 重试. */
export function VcrRefreshNote({ message, onRetry }: { message?: string | null; onRetry: () => void }) {
  return (
    <div data-vcr-refresh-failed="" className="mb-4">
      <Note tone="warn" action={<Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>}>{message ? `${VCR_REFRESH_FAILED}${message}` : VCR_REFRESH_FAILED}</Note>
    </div>
  );
}

export type VcrLoad<T> =
  | { kind: "loading" }
  /** `off`: the module is not open here; `missing`: nothing at that address. */
  | { kind: "error"; message: string; off: boolean; missing: boolean }
  | { kind: "ready"; data: T };

export interface VcrLoadResult<T> {
  /** Always the state of the key asked for now: a key that has not answered yet reads `loading`, never the previous key's answer. */
  state: VcrLoad<T>;
  reload: () => void;
  /**
   * The newest answer to **this** key, kept across a re-read of it (so a refresh does not blank the table) and gone the moment the key
   * changes or a read of it fails: a table drawn from it is the one the request asked for. Nothing else may be drawn as a result.
   */
  last: T | null;
  /** The same key is being read again while `last` stays on screen: the page says 「正在刷新」 (`VcrRefreshingNote`). */
  refreshing: boolean;
  /**
   * The newest answer to any key, a failed one included — for a control the reader is working in (a select, a half-filled panel)
   * that must not unmount when the key moves. Never rows, never a heading, never a number a result is read from; a page that
   * draws results from it shows another request's answer as this one's (review F07).
   * A hook belongs to one study (the study page is keyed by it), so this is never another study's answer.
   */
  carried: T | null;
}

export function useVcrLoad<T>(key: string, load: () => Promise<T>): VcrLoadResult<T> {
  // Every answer is kept with its key, and what the page is handed is derived against the key of this render: the render that
  // follows a key change (before any effect runs) already reads `loading`, not the previous key's rows.
  const [settled, setSettled] = useState<{ key: string; state: VcrLoad<T> }>({ key, state: { kind: "loading" } });
  const [carried, setCarried] = useState<T | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  // The key of the answer on screen, if any: a failure of a read of the same key keeps it (and says so), of another key does not.
  const answeredKey = useRef<string | null>(null);
  const report = useContext(VcrRefreshContext);
  const reporter = useRef(report);
  reporter.current = report;
  const reportId = useId();
  const retry = useRef<() => void>(() => undefined);
  const frame = useContext(StudyFrameContext);
  const following = frame && key.startsWith(`${frame.studyId}:`) ? frame.version : null;
  const seenVersion = useRef(following);

  useEffect(() => {
    let live = true;
    setReading(key);
    Promise.resolve()
      .then(() => loader.current())
      .then(
        (data) => { if (live) { answeredKey.current = key; setSettled({ key, state: { kind: "ready", data } }); setCarried(data); setReading(null); reporter.current?.(reportId, null); } },
        (error: unknown) => {
          if (!live) return;
          setReading(null);
          if (reporter.current && answeredKey.current === key && !isVcrOff(error) && !isVcrMissing(error)) {
            reporter.current(reportId, { message: webErrorMessage(error, { fallback: "" }), retry: () => retry.current() });
            return;
          }
          answeredKey.current = null;
          setSettled({ key, state: {
            kind: "error",
            message: webErrorMessage(error, { fallback: "暂时无法读取，请稍后重试。" }),
            off: isVcrOff(error),
            missing: isVcrMissing(error),
          } });
        },
      );
    return () => { live = false; };
  }, [key, round, reportId]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  retry.current = reload;
  // Leaving the page takes its failure with it.
  useEffect(() => {
    const current = reporter;
    return () => current.current?.(reportId, null);
  }, [reportId]);
  useEffect(() => {
    if (seenVersion.current === following) return;
    seenVersion.current = following;
    if (following !== null) setRound((value) => value + 1);
  }, [following]);
  const state: VcrLoad<T> = settled.key === key ? settled.state : { kind: "loading" };
  const last = state.kind === "ready" ? state.data : null;
  return { state, reload, last, refreshing: reading === key && state.kind === "ready", carried };
}

/** The one sentence for a re-read of what is on screen. */
export function VcrRefreshingNote() {
  return <p role="status" data-vcr-refreshing="" className="text-caption text-text-3">正在刷新</p>;
}

/** A route that did not answer, with 重试. */
export function VcrTabError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <LoadError message={message} onRetry={onRetry} />;
}

/**
 * A tab that receives a shape it cannot read shows an error card inside the
 * tab — the other six tabs, the header and the rail stay where they are —
 * never a route-level crash (contract 2026-09-29 §5). The readers make a
 * malformed payload unlikely; this is what makes it survivable when one
 * happens anyway.
 */
export class VcrTabBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    // Traceable, never swallowed (principle 19): the console keeps the cause.
    console.error("VcrTabBoundary", error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div data-vcr-tab-error="">
        <LoadError message="这一页的内容暂时读不出来，其余页签不受影响。" onRetry={() => this.setState({ failed: false })} />
      </div>
    );
  }
}

/**
 * A section inside a tab: a heading, and its content. The heading takes the
 * card titles' 18/600, so a section never adds a type size of its own (spec
 * §5.2: at most four size × weight pairs a page).
 */
export function VcrSection({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  /** A count or a control at the heading's end. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-8 first:mt-0", className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-section font-semibold text-text">{title}</h2>
        {meta && <span className="text-caption text-text-3">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** A key / value list inside a card: a definition, an estimand, an ADEMP line. */
export function VcrFacts({ rows, className }: { rows: ReadonlyArray<{ label: string; value: ReactNode }>; className?: string }) {
  return (
    <dl className={cn("divide-y divide-faint", className)}>
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[6rem_1fr] gap-3 py-2">
          <dt className="text-caption text-text-3">{row.label}</dt>
          <dd className="min-w-0 text-ui text-text">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Cells laid out two to a row, a last one alone taking the row: a `ChartGrid` row must be full, and a page that has three charts
 * today and four tomorrow should not need to be told where the hole would be. A cell that asks for the whole row (`span: 2`: a grid
 * with five columns does not fit in half a page) gets its own row and closes the one before it.
 */
export function pairRows(cells: readonly ChartGridCell[]): ChartGridCell[][] {
  const rows: ChartGridCell[][] = [];
  let waiting: ChartGridCell | null = null;
  const lone = (cell: ChartGridCell): ChartGridCell[] => [{ ...cell, span: 2 as const }];
  for (const cell of cells) {
    if (cell.span === 2) {
      if (waiting) { rows.push(lone(waiting)); waiting = null; }
      rows.push(lone(cell));
    } else if (waiting) {
      rows.push([{ ...waiting, span: 1 as const }, { ...cell, span: 1 as const }]);
      waiting = null;
    } else {
      waiting = cell;
    }
  }
  if (waiting) rows.push(lone(waiting));
  return rows;
}
