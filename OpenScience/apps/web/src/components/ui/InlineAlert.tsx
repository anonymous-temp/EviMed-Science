import { useEffect, useId, type ReactNode } from "react";
import { announce } from "@/lib/announce";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

/**
 * Component: InlineAlert; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: persistent scoped message with optional recovery action.
 * Variants: error, warning and information.
 * States: owner controls visibility; string children announce through event/entity identity, rich children do not.
 * Hit area: standard action button.
 * Keyboard: native recovery activation without focus changes.
 * Long content: message wraps without truncation.
 * Theme: semantic status roles.
 * Responsive: action wraps below text.
 * Verification: Composition.test.tsx and announce.test.tsx; rich-content announcements require caller evidence.
 */
export function InlineAlert({ children, tone = "error", onRetry, className, eventId, entityId }: {
  children: ReactNode; tone?: "error" | "warning" | "info"; onRetry?: () => void; className?: string; eventId?: string; entityId?: string;
}) {
  const id = useId();
  useEffect(() => { if (typeof children === "string") announce(children, { eventId: eventId ?? id, entityId: entityId ?? id }); }, [children, eventId, entityId, id]);
  return <div role="note" data-inline-alert={tone} className={cn("flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-ui", tone === "error" ? "border-danger bg-danger-soft text-danger-strong" : tone === "warning" ? "border-border bg-warn-soft text-warn-strong" : "border-border bg-surface-2 text-text", className)}>
    <span className="min-w-0 flex-1 break-words">{children}</span>
    {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>}
  </div>;
}
