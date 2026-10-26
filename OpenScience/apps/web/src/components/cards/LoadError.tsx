import { InlineAlert } from "@/components/ui/InlineAlert";

/**
 * Anatomy: scoped persistent message and retry.
 * Variants: error through InlineAlert.
 * States: remains until its owning read recovers.
 * Hit area: standard retry button.
 * Keyboard: native activation preserves focus.
 * Long content: wrapping message.
 * Theme: shared error roles.
 * Responsive: retry wraps locally.
 * Verification: DataPrimitives read failure tests.
 */
export function LoadError({ message, onRetry, className }: { message: string; onRetry: () => void; className?: string }) {
  return <InlineAlert className={className} onRetry={onRetry}>{message}</InlineAlert>;
}
