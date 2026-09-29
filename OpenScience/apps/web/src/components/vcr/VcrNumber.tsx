import { useState, type ReactNode } from "react";
import { Link, useInRouterContext, useParams } from "react-router";
import { cn } from "@/lib/cn";
import { Drawer } from "@/components/ui/Drawer";
import { StatTile } from "@/components/ui/StatTile";
import type { VcrValue, VcrValueDetail } from "@/lib/vcrClient";
import { ReviewChip, SourceTag } from "./VcrMarks";
import { intervalText, isPlaceholder, mcseText, sourceLabel, valueSentence, valueText } from "./vcrText";
import { vcrTabPath } from "./vcrTabs";

/**
 * A number on a 「虚拟临研」 page.
 *
 * Every number here can be drilled into (plan §9.5): a success probability
 * opens the run that produced it — its configuration, its seed and its
 * Monte-Carlo error; a comparator's median PFS opens the assumption card and
 * the sentence in the paper it was read out of. That is what `detail` is, and
 * a value that has none is plain text rather than a control that does
 * nothing.
 *
 * Hidden knowledge:
 *
 *  - **The drill-down is a drawer, not a tooltip.** What a reader needs here
 *    is a seed, a replicate count and a quotation — text they will want to
 *    select and copy, which a hover layer cannot give them.
 *  - The accessible name is the whole value as a sentence
 *    (`valueSentence`), so the source, the named interval and the review
 *    state reach a screen reader as well as the eye.
 *  - `±0.4` is set beside the number rather than under it: it is part of the
 *    measurement, and a simulated number without one would be a claim of
 *    precision nobody computed.
 */

/** The number, its unit and its Monte-Carlo error, inline. */
export function VcrValueText({ value, className }: { value: VcrValue | null | undefined; className?: string }) {
  const mcse = mcseText(value?.mcse);
  return (
    <span className={cn("tabular-nums", className)}>
      {valueText(value)}
      {value?.unit && <span className="ml-0.5 text-text-3">{value.unit}</span>}
      {mcse && <span className="ml-1 text-caption font-normal text-text-3">{mcse}</span>}
    </span>
  );
}

/**
 * A number a reader can open. With no `detail` it is the same text without a
 * control around it — a dotted underline that does nothing is worse than none.
 */
export function VcrNumber({ value, label, className, children }: {
  value: VcrValue | null | undefined;
  /** What the number is of, for the control's accessible name. */
  label: string;
  className?: string;
  /** Replaces the rendered number (a formatted cell of a table). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const body = children ?? <VcrValueText value={value} />;
  if (!value?.detail) return <span className={className}>{body}</span>;
  return (
    <>
      <button
        type="button"
        data-vcr-number=""
        onClick={() => setOpen(true)}
        aria-label={`${label}：${valueSentence(value)}，看来源`}
        className={cn(
          "rounded text-left underline decoration-dotted decoration-from-font underline-offset-4 outline-none hover:decoration-solid",
          className,
        )}
      >
        {body}
      </button>
      {open && <VcrValueDrawer label={label} value={value} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Where a number came from, opened beside the page it was read on. */
export function VcrValueDrawer({ label, value, onClose }: { label: string; value: VcrValue; onClose: () => void }) {
  const detail = value.detail;
  const routed = useInRouterContext();
  const interval = intervalText(value.interval, value.precision);
  return (
    <Drawer title={label} onClose={onClose} widthClassName="max-w-md">
      <div data-vcr-number-detail="" className="flex flex-col gap-4">
        <div>
          <p className={cn("flex flex-wrap items-baseline gap-x-2 font-semibold tabular-nums", isPlaceholder(value) ? "text-heading text-text-2" : "text-metric text-text")}>
            <VcrValueText value={value} />
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <SourceTag source={value.source} />
            <ReviewChip state={value.review} />
          </p>
          {interval && <p className="mt-2 text-ui text-text-2">{interval}</p>}
          {value.mcse != null && <p className="mt-1 text-caption text-text-3">{`${mcseText(value.mcse)} 为蒙特卡洛标准误`}</p>}
          {value.reason && <p className="mt-1 text-caption text-text-3">{value.reason}</p>}
        </div>

        {detail?.title && <p className="text-ui font-medium text-text">{detail.title}</p>}

        {detail?.fields && detail.fields.length > 0 && (
          <dl className="divide-y divide-border rounded-card border border-border">
            {detail.fields.map((field) => (
              <div key={field.label} className="flex items-baseline justify-between gap-4 px-3 py-2">
                <dt className="shrink-0 text-caption text-text-3">{field.label}</dt>
                <dd className="min-w-0 break-words text-right text-ui tabular-nums text-text">{field.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {detail?.quote && (
          <figure className="rounded-card border border-border bg-surface-1 p-3">
            <blockquote className="text-ui text-text">{`“${detail.quote}”`}</blockquote>
            {detail.quoteSource && <figcaption className="mt-2 text-caption text-text-3">{`— ${detail.quoteSource}`}</figcaption>}
          </figure>
        )}

        {routed && detail?.ref && <VcrRefLink refTarget={detail.ref} kind={detail.kind} onNavigate={onClose} />}
      </div>
    </Drawer>
  );
}

/**
 * 「到那张假设卡」 / 「到那次运行的页面」: where the whole thing is read. Only
 * inside a study's address, where there is a tab to go to.
 */
function VcrRefLink({ refTarget, kind, onNavigate }: { refTarget: NonNullable<VcrValueDetail["ref"]>; kind: VcrValueDetail["kind"]; onNavigate: () => void }) {
  const { studyId } = useParams();
  if (!studyId || !refTarget.tab) return null;
  const search = refTarget.kind === "assumption" ? `?card=${encodeURIComponent(refTarget.id)}` : "";
  return (
    <Link data-vcr-ref="" to={`${vcrTabPath(studyId, refTarget.tab)}${search}`} onClick={onNavigate} className="text-ui text-link hover:underline">
      {refTarget.kind === "assumption" ? "到那张假设卡" : kind === "run" ? "到这次运行的结果页" : "到它所在的页签"}
    </Link>
  );
}

/**
 * One tile of a number band: the metric's name, the source it came from, the
 * review state where there is one, the number, and one line under it.
 *
 * A word standing in for a number (「不可估计」) takes the placeholder type
 * size rather than the metric size — set in 32 px it shouts louder than every
 * measurement beside it.
 */
export function VcrStat({ label, value, note, lead = false, className }: {
  label: string;
  value: VcrValue;
  note?: ReactNode;
  lead?: boolean;
  className?: string;
}) {
  const placeholder = isPlaceholder(value);
  const mcse = mcseText(value.mcse);
  return (
    <StatTile
      label={label}
      lead={lead}
      placeholder={placeholder}
      className={cn(value.stale && "opacity-disabled", className)}
      hint={valueSentence(value)}
      value={<VcrNumber value={value} label={label}>{valueText(value)}</VcrNumber>}
      unit={(
        <span className="inline-flex items-center gap-1.5">
          {value.unit}
          {mcse && <span className="font-normal text-text-3">{mcse}</span>}
        </span>
      )}
      note={(
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <SourceTag source={value.source} />
          <ReviewChip state={value.review} />
          {note}
        </span>
      )}
    />
  );
}

/** The one-line summary a tile prints under its number: the named interval and its basis. */
export function VcrStatNote({ value, basis }: { value: VcrValue; basis?: string | null }) {
  const interval = intervalText(value.interval, value.precision);
  const parts = [interval, basis].filter(Boolean);
  if (parts.length === 0) return null;
  return <span className="text-text-3">{parts.join(" · ")}</span>;
}

/** A tile that is not a number at all: 「真实外部对照 · 不可估计」. */
export function VcrWordStat({ label, word, note, source, className }: {
  label: string;
  word: string;
  note?: ReactNode;
  source?: VcrValue["source"] | null;
  className?: string;
}) {
  return (
    <StatTile
      label={label}
      placeholder
      value={word}
      className={className}
      note={(
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {source && <SourceTag source={source} />}
          {note}
        </span>
      )}
      hint={source ? `${word}，${sourceLabel(source)}` : word}
    />
  );
}
