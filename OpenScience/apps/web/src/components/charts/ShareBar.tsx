import { cn } from "@/lib/cn";

/**
 * A composition of one whole, as a single 100 % horizontal bar (appendix E
 * §4.1: share is a stacked bar, never a pie — 「不用饼图拼贴」).
 *
 * It is drawn in the document rather than on a canvas, because a bar with no
 * axis is two rectangles and a legend, and a canvas would cost a chart
 * library, a resize observer and a blurred edge to say the same thing.
 *
 * The tones are the data palette's closed set: ours is the brand, rivals are
 * greys in rank order, and the severity steps are the only red. A segment
 * worth less than a readable sliver still shows, so 「1 次」 does not vanish.
 */

export type ShareTone = "own" | "rival-1" | "rival-2" | "rival-3" | "quiet" | "s3" | "s2" | "s1";

const TONE_CLASSES: Record<ShareTone, string> = {
  own: "bg-accent",
  "rival-1": "bg-text-2",
  "rival-2": "bg-text-graphic",
  "rival-3": "bg-border-control",
  quiet: "bg-surface-2",
  s3: "bg-severity-s3",
  s2: "bg-severity-s2",
  s1: "bg-severity-s1",
};

export interface ShareSegment {
  key: string;
  label: string;
  value: number;
  tone: ShareTone;
}

export function ShareBar({
  label,
  segments,
  legend = true,
  format = (value: number) => String(Math.round(value)),
  className,
}: {
  /** The whole this divides up, for assistive technology. */
  label: string;
  segments: readonly ShareSegment[];
  /** The named segments under the bar; off where the row already names them. */
  legend?: boolean;
  format?: (value: number) => string;
  className?: string;
}) {
  const drawn = segments.filter((segment) => Number.isFinite(segment.value) && segment.value > 0);
  const total = drawn.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  return (
    <div className={cn("min-w-0", className)}>
      <div
        role="img"
        data-share-bar=""
        aria-label={`${label}：${drawn.map((segment) => `${segment.label} ${format(segment.value)}`).join("，")}`}
        className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-surface-2"
      >
        {drawn.map((segment) => (
          <span
            key={segment.key}
            data-share-segment={segment.key}
            data-share-tone={segment.tone}
            className={cn("h-2 first:rounded-l-full last:rounded-r-full", TONE_CLASSES[segment.tone])}
            style={{ width: `${Math.max(1.5, (segment.value / total) * 100)}%` }}
          />
        ))}
      </div>
      {legend && (
        <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {drawn.map((segment) => (
            <li key={segment.key} className="inline-flex items-center gap-1.5 text-caption text-text-2">
              <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-tag", TONE_CLASSES[segment.tone])} />
              {segment.label}
              <span className="font-medium tabular-nums text-text">{format(segment.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
