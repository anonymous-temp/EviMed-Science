import { Inbox, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The standard empty state: a mark + title + description + a way on. Pages pass
 * their own copy (and container chrome such as a dashed border via
 * `className`) so every "nothing here yet" / "service unavailable" surface
 * shares one shape instead of hand-rolled variants.
 *
 * The mark is never left out: a page that names none gets the empty tray
 * (DESIGN.md rule 8, and the walk's `empty-state` rule reads it). The way on
 * is an `action` (one verb + object) or a `reason` for there being none.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  titleAs: Title = "p",
  description,
  action,
  reason,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  titleAs?: "p" | "h1" | "h2" | "h3";
  description?: React.ReactNode;
  /** Primary action slot — usually a single button or link. */
  action?: React.ReactNode;
  /** Instead of an action: why there is nothing to press. Shown as the description when there is none, and under it when there is. */
  reason?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-empty="" data-reason={reason ? "" : undefined} className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <Icon size={20} className="text-muted" aria-hidden />
      <Title className="mt-3 text-ui font-medium text-text">{title}</Title>
      {(description || reason) && (
        <div className="mt-2 max-w-sm text-caption text-muted">
          {description}
          {/* The reason is why there is no button; with a recipe above it, it stands under it and is not swallowed by it. Alone it is the description, as it always was. */}
          {reason && (description ? <p className="mt-2">{reason}</p> : reason)}
        </div>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
