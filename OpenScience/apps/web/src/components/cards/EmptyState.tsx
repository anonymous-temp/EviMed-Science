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
    <div className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      {Icon && <Icon size={22} strokeWidth={1.5} className="text-muted" aria-hidden />}
      <p className={cn("text-sm font-medium text-text", Icon && "mt-2")}>{title}</p>
      {description && <div className="mt-1 max-w-sm text-xs leading-5 text-muted">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
