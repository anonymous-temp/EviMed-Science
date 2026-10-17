import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";

/**
 * The only way a sentence stands on a page by itself (R19, plan §2 rules 4 and 7).
 *
 * A grey line under a heading — how something was made, what it may be used for, what the engine did, how to read a number —
 * is the model's context and an operator's view, not the reader's page; 111 of them sat on 60 files because a `<p>` with a
 * grey class costs nothing to write. A `Note` has to earn its place in its props, and the types say how:
 *
 *  - an **action** — the sentence and the one thing the reader can do about it (a link or a button): 「再加 4 份资料会开始整理」
 *    with 「添加资料」;
 *  - or a **result** — a conclusion that holds a number, written as parts so the number can open what it counts
 *    (`{ n: 4, onOpen }`): 「EviMed 记住了你的 48 件事，其中 4 件需要看一眼。」
 *
 * A bare string is neither, and does not compile. `layoutRules.test.ts` counts the grey sentences that are still written by
 * hand and lets the count only fall; `data-note` is what the walk reads, so a sentence in a `Note` is not asked to prove itself
 * a second time.
 *
 * ```tsx
 * <Note action={<Button size="sm" onClick={add}>添加资料</Button>}>资料还不够，再加 4 份会开始整理。</Note>
 * <Note result={["记住了你的 ", { n: 48, onOpen: all }, " 件事，其中 ", { n: 4, onOpen: look, label: "4 件，只看这些" }, " 件需要看一眼。"]} />
 * ```
 */

/** A figure in a sentence, which can open what it counts (rule 7: every number opens what it counts). */
export interface NoteNumber {
  /** The figure as it is read: 48, “1,210”, “12 / 18”. */
  n: number | string;
  /** Opens what it counts on a page of its own… */
  to?: string;
  /** …or in place: a drawer, a narrowed list. */
  onOpen?: () => void;
  /** The link's accessible name when the figure alone is not one (“4 件，只看这些”); it should repeat the figure. */
  label?: string;
}

export type NotePart = string | NoteNumber;

/** A result holds at least one number, and it is the first or the second part: a sentence cannot bury its figure. */
export type NoteResult = readonly [NoteNumber, ...NotePart[]] | readonly [string, NoteNumber, ...NotePart[]];

/** The parts of a sentence, its figures as links where they open something. */
export function NoteParts({ parts }: { parts: readonly NotePart[] }) {
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>{typeof part === "string" ? part : <NumberPart {...part} />}</Fragment>
      ))}
    </>
  );
}

function NumberPart({ n, to, onOpen, label }: NoteNumber) {
  // No weight of its own: a figure that opens what it counts is the link colour at the sentence's weight, so it is the same control as any
  // other link of the page — in a 14 px note, an 18 px headline or a heading — and not a 14 / 500 beside the page's 14 / 400.
  const look = "rounded tabular-nums text-link hover:underline hover:underline-offset-4";
  if (to) return <Link to={to} aria-label={label} className={look}>{n}</Link>;
  if (onOpen) return <button type="button" aria-label={label} onClick={onOpen} className={cn(look, "align-baseline")}>{n}</button>;
  return <span className="tabular-nums">{n}</span>;
}

export type NoteProps = (
  | { action: ReactNode; children: ReactNode; result?: never }
  | { result: NoteResult; action?: ReactNode; children?: never }
) & {
  /** `warn` is a pale amber band: something is held up and the action releases it. */
  tone?: "default" | "warn";
  className?: string;
};

export function Note({ action, result, children, tone = "default", className }: NoteProps) {
  const Root = action ? "div" : "p";
  return (
    <Root
      data-note=""
      className={cn(
        "flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ui",
        result ? "text-text" : "text-text-2",
        // A held-up note is told by its amber ground, not by amber text: the sentence stays the text colour, so a note spends no text colour
        // of its own (a page is held to seven, and the status tags beside it already wear the amber).
        tone === "warn" && "items-center rounded bg-warn-soft px-3 py-2 text-text",
        className,
      )}
    >
      <span className="min-w-0 max-w-measure-body">{result ? <NoteParts parts={result} /> : children}</span>
      {action}
    </Root>
  );
}
