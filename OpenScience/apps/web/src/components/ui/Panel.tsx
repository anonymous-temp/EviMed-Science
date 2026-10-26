import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A settings group: the group's name outside, one rounded box, one item per
 * row — label on the left, its control on the right — hairlines between rows
 * (2026-09-23 plan §4, §5.9; Linear's settings, Apple's grouped lists).
 *
 * One level of box, and nothing nests in it: the account tab used to hold a
 * card holding a bordered row holding a bordered confirmation, and two card
 * recipes with 4 px of padding between them (inventory §2.3). No hint under
 * the group's name either — a row may carry one short line under its label
 * when the label alone would be ambiguous (「任务完成的通知推送到飞书」).
 */
/**
 * Component: Panel; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Section with optional h2/action above one divided settings surface.
 * Variants: Optional group title/action.
 * States: Children own setting state.
 * Hit area: No built-in action target; supplied child controls own their geometry.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Header and child text are retained; child rows own overflow.
 * Theme: Surface, border and main-text roles.
 * Responsive: Fluid box; no internal viewport breakpoint.
 * Verification: Primitives.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function Panel({
  title,
  action,
  className,
  children,
}: {
  /** The group's name, outside the box. */
  title?: string;
  /** A text button or a count beside the name. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      {(title || action) && (
        <div className="mb-2 flex items-center justify-between gap-3">
          {title && <h2 className="text-ui font-semibold text-text">{title}</h2>}
          {action}
        </div>
      )}
      <div className="divide-y divide-border rounded-card border border-border bg-surface">{children}</div>
    </section>
  );
}

/**
 * Component: PanelRow; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Label/description beside control, optional expanded body below.
 * Variants: Value/control and optional child content.
 * States: Caller owns control and expansion state.
 * Hit area: Only supplied controls are interactive.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Label/description retained; control cannot shrink.
 * Theme: Main label and secondary description/value.
 * Responsive: Flex row stays side-by-side; caller must bound long controls.
 * Verification: Primitives.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function PanelRow({
  label,
  description,
  control,
  className,
  children,
}: {
  label: ReactNode;
  /** One short line under the label, only when the label is ambiguous alone. */
  description?: ReactNode;
  /** The row's control or value, right-aligned. */
  control?: ReactNode;
  className?: string;
  /** Content that unfolds under the row (an inline form). */
  children?: ReactNode;
}) {
  return (
    <div className={cn("px-4 py-3", className)}>
      <div className="flex min-h-8 items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui text-text">{label}</div>
          {description && <div className="mt-0.5 text-caption text-text-3">{description}</div>}
        </div>
        {control !== undefined && <div className="flex shrink-0 items-center gap-2 text-ui text-text-3">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
