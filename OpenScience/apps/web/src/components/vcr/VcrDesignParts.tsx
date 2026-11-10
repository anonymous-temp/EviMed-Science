import type { ReactNode } from "react";
import type { VcrValue } from "@/lib/vcrClient";
import { BlockHeading } from "@/components/ui/Section";
import { VcrNumber } from "./VcrNumber";
import { NO_VALUE } from "./vcrText";

/**
 * The pieces the cards of a design a conversation computed share (dose finding, Bayesian designs): a titled block, the lead numbers,
 * and a cell that is a number or a dash. A cell the engine did not compute is a dash, never a zero.
 */

const SUBHEADING = "text-ui font-semibold text-text";

export const NOT_APPLICABLE = <span className="text-text-3">{NO_VALUE}</span>;

/** One titled part of a card. */
export function CardBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <BlockHeading className={SUBHEADING}>{title}</BlockHeading>
      {children}
    </div>
  );
}

/** A number a reader can open, or a dash where there is none. */
export function CardNumber({ value, label }: { value: VcrValue | null | undefined; label: string }) {
  return value ? <VcrNumber value={value} label={label} /> : NOT_APPLICABLE;
}

/** The numbers a card leads with, each under its name; `caption` says whose they are when the card holds more than one design. */
export function CardHeadline({ lines, caption }: { lines: ReadonlyArray<{ key: string; label: string; value: VcrValue }>; caption?: string }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {caption && <p className="text-caption text-text-3">{caption}</p>}
      <dl data-vcr-card-headline="" className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {lines.map((line) => (
          <div key={line.key} data-vcr-card-measure={line.key} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-caption text-text-3">{line.label}</dt>
            <dd className="text-ui text-text"><VcrNumber value={line.value} label={line.label} /></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
