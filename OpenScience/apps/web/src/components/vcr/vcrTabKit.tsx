import { Component, useCallback, useContext, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { isVcrMissing, isVcrOff } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { LoadError } from "@/components/cards/LoadError";
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

export type VcrLoad<T> =
  | { kind: "loading" }
  /** `off`: the module is not open here; `missing`: nothing at that address. */
  | { kind: "error"; message: string; off: boolean; missing: boolean }
  | { kind: "ready"; data: T };

export interface VcrLoadResult<T> {
  state: VcrLoad<T>;
  reload: () => void;
  /**
   * The newest answer this hook has received, whatever key it was for — what a control that must outlive a change of key (a
   * select the reader is working in, a panel half filled in) keeps drawing while the next page is read or when it cannot be.
   * A hook belongs to one study (the study page is keyed by it), so this is never another study's answer.
   */
  last: T | null;
}

export function useVcrLoad<T>(key: string, load: () => Promise<T>): VcrLoadResult<T> {
  const [state, setState] = useState<VcrLoad<T>>({ kind: "loading" });
  const [last, setLast] = useState<T | null>(null);
  const [round, setRound] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const shownKey = useRef(key);
  const frame = useContext(StudyFrameContext);
  const following = frame && key.startsWith(`${frame.studyId}:`) ? frame.version : null;
  const seenVersion = useRef(following);

  useEffect(() => {
    let live = true;
    if (shownKey.current !== key) {
      shownKey.current = key;
      setState({ kind: "loading" });
    }
    Promise.resolve()
      .then(() => loader.current())
      .then(
        (data) => { if (live) { setState({ kind: "ready", data }); setLast(data); } },
        (error: unknown) => {
          if (!live) return;
          setState({
            kind: "error",
            message: webErrorMessage(error, { fallback: "暂时无法读取，请稍后重试。" }),
            off: isVcrOff(error),
            missing: isVcrMissing(error),
          });
        },
      );
    return () => { live = false; };
  }, [key, round]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  useEffect(() => {
    if (seenVersion.current === following) return;
    seenVersion.current = following;
    if (following !== null) setRound((value) => value + 1);
  }, [following]);
  return { state, reload, last };
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

/**
 * The one sentence at the top of a tab: what the numbers below it add up to.
 *
 * It is the tab's finding, never a description of the tab — 「本页展示…」 is
 * banned, and a heading that explains the system has explained nothing (spec
 * v2.1, 原则四).
 */
export function VcrHeadline({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p data-vcr-headline="" className={cn("text-section leading-relaxed text-text", className)}>
      {children}
    </p>
  );
}

/** A tab's own filter row: controls at the left, a grey summary at the right end. */
export function VcrToolbar({ children, summary, className }: { children?: ReactNode; summary?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      {summary && <span className="text-caption tabular-nums text-text-3">{summary}</span>}
    </div>
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
 * today and four tomorrow should not need to be told where the hole would be.
 */
export function pairRows(cells: readonly ChartGridCell[]): ChartGridCell[][] {
  const rows: ChartGridCell[][] = [];
  for (let index = 0; index < cells.length; index += 2) {
    const pair = cells.slice(index, index + 2).map((cell) => ({ ...cell, span: 1 as const }));
    rows.push(pair.length === 1 ? [{ ...pair[0], span: 2 as const }] : pair);
  }
  return rows;
}
