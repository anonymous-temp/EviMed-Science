import { InlineAlert } from "./InlineAlert";
import { formatDateTime } from "@/lib/format";

/**
 * Component: Freshness; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: last successful observation followed by refresh recovery.
 * Variants: known success time; optional refresh error.
 * States: the line is drawn only when the time is known (a sentence that says nothing is not shown); the caller retains and supplies the last successful time/value.
 * Hit area: optional standard retry button.
 * Keyboard: native retry.
 * Long content: messages wrap.
 * Theme: shared neutral and error roles.
 * Responsive: flows in its local summary.
 * Verification: Composition.test.tsx and resource refresh regression; actual AT remains manual.
 */
export function Freshness({ at, error, onRetry }: { at: string | null; error?: string | null; onRetry?: () => void }) {
  return <div className="space-y-2">{at && <p className="text-caption text-text-3">上次成功读取 <time dateTime={at}>{formatDateTime(at)}</time></p>}{error && <InlineAlert onRetry={onRetry}>{error}</InlineAlert>}</div>;
}
