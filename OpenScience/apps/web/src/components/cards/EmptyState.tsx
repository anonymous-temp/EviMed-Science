import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The standard empty state: icon + title + description + an optional primary
 * action. Pages pass their own copy (and container chrome such as a dashed
 * border via `className`) so every "nothing here yet" / "service unavailable"
 * surface shares one shape instead of hand-rolled variants.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  /** Primary action slot — usually a single button or link. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {Icon && <Icon size={20} className="text-muted" aria-hidden />}
      <p className={cn("text-ui font-medium text-text", Icon && "mt-3")}>{title}</p>
      {description && <div className="mt-2 max-w-sm text-caption text-muted">{description}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
