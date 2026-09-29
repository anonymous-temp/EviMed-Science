import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { isVcrMissing, isVcrOff } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { LoadError } from "@/components/cards/LoadError";

/**
 * What every study tab shares: reading its route once, the four states, and a
 * section heading that does not invent a type size of its own.
 *
 * A reload keeps the last answer on screen rather than flashing a skeleton —
 * a tab that re-reads after an action (a new assumption version, a confirmed
 * contact) should not look as if it had lost the page.
 */

export type VcrLoad<T> =
  | { kind: "loading" }
  /** `off`: the module is not open here; `missing`: nothing at that address. */
  | { kind: "error"; message: string; off: boolean; missing: boolean }
  | { kind: "ready"; data: T };

export interface VcrLoadResult<T> {
  state: VcrLoad<T>;
  reload: () => void;
}

export function useVcrLoad<T>(key: string, load: () => Promise<T>): VcrLoadResult<T> {
  const [state, setState] = useState<VcrLoad<T>>({ kind: "loading" });
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
            off: isVcrOff(error),
            missing: isVcrMissing(error),
          });
        },
      );
    return () => { live = false; };
  }, [key, round]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { state, reload };
}

/** A route that did not answer, with 重试. */
export function VcrTabError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <LoadError message={message} onRetry={onRetry} />;
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
